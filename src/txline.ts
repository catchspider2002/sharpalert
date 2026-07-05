// SharpAlert - TxLINE client: auth + fixtures + odds (implied + decimal) + match state.
const BASE = 'https://txline.txodds.com';

export interface TxEnv { DB: D1Database; TXLINE_API_KEY?: string }

async function metaGet(env: TxEnv, k: string): Promise<string | null> {
  const r = await env.DB.prepare('SELECT value FROM kv WHERE key=?').bind(k).first<{ value: string }>();
  return r?.value ?? null;
}
async function metaSet(env: TxEnv, k: string, v: string): Promise<void> {
  await env.DB.prepare('INSERT OR REPLACE INTO kv (key,value) VALUES (?,?)').bind(k, v).run();
}
async function getJwt(env: TxEnv, force = false): Promise<string> {
  if (!force) {
    const v = await metaGet(env, 'jwt'); const at = await metaGet(env, 'jwt_at');
    if (v && at && Date.now() - Number(at) < 25 * 864e5) return v;
  }
  const r = await fetch(`${BASE}/auth/guest/start`, { method: 'POST' });
  if (!r.ok) throw new Error('guest start ' + r.status);
  const token = (await r.json() as { token: string }).token;
  await metaSet(env, 'jwt', token); await metaSet(env, 'jwt_at', String(Date.now()));
  return token;
}
async function authedGet(env: TxEnv, path: string): Promise<Response> {
  if (!env.TXLINE_API_KEY) throw new Error('TXLINE_API_KEY not set');
  let jwt = await getJwt(env);
  const h = () => ({ Authorization: `Bearer ${jwt}`, 'X-Api-Token': env.TXLINE_API_KEY! });
  let res = await fetch(BASE + path, { headers: h() });
  if (res.status === 401) { jwt = await getJwt(env, true); res = await fetch(BASE + path, { headers: h() }); }
  return res;
}

export interface TxFixture { fixtureId: number; competition: string; startTime: number; home: string; away: string; }

// Keep ONLY the senior men's FIFA World Cup 2026 - excludes qualifiers, youth (U-17/U-20),
// women's, Club World Cup, beach/futsal/esports, and any other edition/year.
function isMainWorldCup(name: string): boolean {
  const s = (name || '').toLowerCase();
  if (!/world cup/.test(s)) return false;
  if (/qualif|wom(e|a)n|u-?\d{1,2}|under[\s-]?\d{1,2}|youth|club|beach|futsal|esoccer|e-?sports|e[\s-]?world/.test(s)) return false;
  const year = s.match(/\b(19|20)\d{2}\b/);
  if (year && year[0] !== '2026') return false;
  return true;
}

export async function listFixtures(env: TxEnv): Promise<TxFixture[]> {
  const res = await authedGet(env, '/api/fixtures/snapshot');
  if (!res.ok) throw new Error('fixtures ' + res.status);
  const arr = await res.json() as any[];
  return arr.map((f) => {
    const p1Home = !!f.Participant1IsHome;
    return { fixtureId: f.FixtureId, competition: f.Competition, startTime: f.StartTime,
      home: p1Home ? f.Participant1 : f.Participant2, away: p1Home ? f.Participant2 : f.Participant1 };
  }).filter((f) => isMainWorldCup(f.competition || ''));
}

export interface Odds { implied: { home: number; draw: number; away: number }; decimal: { home: number; draw: number; away: number }; }
export async function getOdds(env: TxEnv, fixtureId: string | number): Promise<Odds | null> {
  const res = await authedGet(env, `/api/odds/snapshot/${fixtureId}`);
  if (!res.ok) return null;
  const arr = await res.json() as any[];
  if (!Array.isArray(arr)) return null;
  const cands = arr.filter((o) => Array.isArray(o.PriceNames) && o.PriceNames.length === 3 && Array.isArray(o.Pct));
  // Prefer the FULL-TIME 1X2 market: in-play snapshots also carry same-shaped period markets
  // (first-half result etc.), and picking one of those reads as nonsense (a "95% draw" logged in
  // first-half stoppage was really the H1-result market, not the match odds).
  const rank = (o: any) => (/1X2/i.test(o.SuperOddsType || '') ? 4 : 0) + (o.MarketPeriod ? 0 : 2) + (/stable/i.test(o.Bookmaker || '') || /stable/i.test(o.SuperOddsType || '') ? 1 : 0);
  const pick = cands.slice().sort((a, b) => rank(b) - rank(a))[0];
  if (!pick) return null;
  const pct = (pick.Pct as string[]).map((x) => (x === 'NA' ? NaN : Number(x)));
  if (pct.some((x) => !Number.isFinite(x))) return null;
  const names = (pick.PriceNames as string[]).map((s) => String(s).toLowerCase());
  const hi = idxOf(names, ['1', 'home'], 0), di = idxOf(names, ['x', 'draw'], 1), ai = idxOf(names, ['2', 'away'], 2);
  const sum = pct[hi] + pct[di] + pct[ai];
  const implied = { home: pct[hi] / sum, draw: pct[di] / sum, away: pct[ai] / sum };
  const decimal = { home: r2(1 / implied.home), draw: r2(1 / implied.draw), away: r2(1 / implied.away) };
  return { implied, decimal };
}
function idxOf(names: string[], keys: string[], fb: number): number {
  const i = names.findIndex((n) => keys.some((k) => n === k || n.includes(k))); return i >= 0 ? i : fb;
}

export interface MatchState { phase: string; started: boolean; finished: boolean; goals: number; reds: number; winner: 'home_win' | 'draw' | 'away_win' | null; minute: number | null; }
const FINISHED = new Set(['F', 'FET', 'FPE']);
export async function getMatchState(env: TxEnv, fixtureId: string | number): Promise<MatchState> {
  const empty: MatchState = { phase: 'NS', started: false, finished: false, goals: 0, reds: 0, winner: null, minute: null };
  const res = await authedGet(env, `/api/scores/snapshot/${fixtureId}`);
  if (!res.ok) return empty;
  const arr = await res.json() as any[];
  if (!Array.isArray(arr) || arr.length === 0) return empty;
  const phase = phaseFromActions(arr);
  const rec = latestStatRec(arr);
  const sm = statMap(rec); const sc = rec?.ScoreSoccer ?? rec?.scoreSoccer;
  const g1 = sm.get(1) ?? num(sc?.Participant1?.Total?.Goals), g2 = sm.get(2) ?? num(sc?.Participant2?.Total?.Goals);
  const reds = (sm.get(5) ?? num(sc?.Participant1?.Total?.RedCards)) + (sm.get(6) ?? num(sc?.Participant2?.Total?.RedCards));
  const p1Home = (rec?.Participant1IsHome ?? rec?.participant1IsHome) !== false;
  const finished = FINISHED.has(phase);
  let winner: MatchState['winner'] = null;
  if (finished) winner = g1 > g2 ? (p1Home ? 'home_win' : 'away_win') : g2 > g1 ? (p1Home ? 'away_win' : 'home_win') : 'draw';
  return { phase, started: phase !== 'NS', finished, goals: g1 + g2, reds, winner, minute: matchMinute(arr, phase) };
}

// Match minute from the latest record carrying a running Clock (the feed's clock counts total
// elapsed seconds, so H2 readings are already 45+). HT pins to 45. Early in a half few records
// carry a Clock, so fall back to estimating from the kickoff record's wall timestamp.
function matchMinute(arr: any[], phase: string): number | null {
  if (phase === 'NS') return null;
  if (phase === 'HT') return 45;
  let best: { seq: number; sec: number } | null = null;
  for (const r of arr) {
    const s = r?.Clock?.Seconds;
    if (s != null && (!best || seqOf(r) > best.seq)) best = { seq: seqOf(r), sec: num(s) };
  }
  if (best) return Math.min(Math.floor(best.sec / 60) + 1, 130);
  // No clock yet - estimate from kickoff timestamps.
  let now = 0; for (const r of arr) { const t = tsOf(r); if (t > now) now = t; }
  if (!now) return null;
  let h1 = 0, h1Seq = Infinity, htSeq = -1;
  for (const r of arr) {
    const a = String(r?.Action || ''); const s = seqOf(r);
    if ((a === 'kickoff' || a === 'kickoff_team') && s < h1Seq) { h1Seq = s; h1 = tsOf(r); }
    if (a === 'halftime_finalised' && s > htSeq) htSeq = s;
  }
  if (phase === 'H2') {
    let h2 = 0, h2Seq = Infinity;
    for (const r of arr) if (String(r?.Action || '') === 'kickoff' && seqOf(r) > htSeq && seqOf(r) < h2Seq) { h2Seq = seqOf(r); h2 = tsOf(r); }
    return h2 ? Math.max(46, Math.min(45 + Math.round((now - h2) / 60000), 120)) : 46;
  }
  return h1 ? Math.max(1, Math.min(1 + Math.round((now - h1) / 60000), 60)) : null;
}
function tsOf(u: any): number { return num(u?.Ts ?? u?.ts ?? u?.Timestamp ?? u?.timestamp); }

// TxLINE soccer game-phase encoding (numeric id → code). Docs: scores/soccer-feed.
function phaseFromActions(arr: any[]): string {
  let hasKick = false, htSeq = -1, finalised = false;
  for (const r of arr) {
    const a = String(r?.Action || '');
    const s = seqOf(r);
    if (a === 'kickoff' || a === 'kickoff_team') hasKick = true;
    if (a === 'halftime_finalised' && s > htSeq) htSeq = s;
    if (a === 'game_finalised') finalised = true;
  }
  if (finalised) return 'F';
  if (htSeq >= 0) {
    for (const r of arr) if (String(r?.Action || '') === 'kickoff' && seqOf(r) > htSeq) return 'H2';
    return 'HT';
  }
  return hasKick ? 'H1' : 'NS';
}
function seqOf(u: any): number { return num(u?.Seq ?? u?.seq ?? u?.Timestamp ?? u?.timestamp ?? u?.Ts ?? u?.ts); }
function hasStats(u: any): boolean { const s = u?.Stats ?? u?.stats; return !!s && typeof s === 'object' && (s['1'] != null || s['2'] != null); }
function latestStatRec(arr: any[]): any {
  let best: any = null;
  for (const r of arr) if (hasStats(r) && (!best || seqOf(r) > seqOf(best))) best = r;
  return best ?? (arr.length ? arr.reduce((a, b) => (seqOf(b) > seqOf(a) ? b : a)) : {});
}
function statMap(u: any): Map<number, number> {
  const m = new Map<number, number>();
  const s = u?.Stats ?? u?.stats;
  if (Array.isArray(s)) { for (const it of s) { const k = Number(it?.Key ?? it?.key ?? it?.[0]); if (Number.isFinite(k)) m.set(k, num(it?.Value ?? it?.value ?? it?.[1])); } }
  else if (s && typeof s === 'object') { for (const k of Object.keys(s)) { const kn = Number(k); if (Number.isFinite(kn)) m.set(kn, num((s as any)[k])); } }
  return m;
}
const num = (x: any) => (Number.isFinite(Number(x)) ? Number(x) : 0);
const r2 = (x: number) => Math.round(x * 100) / 100;
