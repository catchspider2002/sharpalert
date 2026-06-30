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
  const pick = cands.find((o) => /stable/i.test(o.Bookmaker || '') || /stable/i.test(o.SuperOddsType || '')) || cands[0];
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

export interface MatchState { phase: string; started: boolean; finished: boolean; goals: number; reds: number; winner: 'home_win' | 'draw' | 'away_win' | null; }
const FINISHED = new Set(['F', 'FET', 'FPE']);
export async function getMatchState(env: TxEnv, fixtureId: string | number): Promise<MatchState> {
  const empty: MatchState = { phase: 'NS', started: false, finished: false, goals: 0, reds: 0, winner: null };
  const res = await authedGet(env, `/api/scores/snapshot/${fixtureId}`);
  if (!res.ok) return empty;
  const arr = await res.json() as any[];
  if (!Array.isArray(arr) || arr.length === 0) return empty;
  const latest = arr.reduce((a, b) => ((b?.seq ?? b?.ts ?? 0) > (a?.seq ?? a?.ts ?? 0) ? b : a));
  const phase = phaseOf(latest);
  const st = latest?.stats || {}; const sc = latest?.scoreSoccer;
  const n = (k: string, fb?: number) => (st[k] != null ? num(st[k]) : (fb ?? 0));
  const g1 = n('1', num(sc?.Participant1?.Total?.Goals)), g2 = n('2', num(sc?.Participant2?.Total?.Goals));
  const reds = n('5', num(sc?.Participant1?.Total?.RedCards)) + n('6', num(sc?.Participant2?.Total?.RedCards));
  const p1Home = latest?.participant1IsHome !== false;
  const finished = FINISHED.has(phase);
  let winner: MatchState['winner'] = null;
  if (finished) winner = g1 > g2 ? (p1Home ? 'home_win' : 'away_win') : g2 > g1 ? (p1Home ? 'away_win' : 'home_win') : 'draw';
  return { phase, started: phase !== 'NS', finished, goals: g1 + g2, reds, winner };
}

function phaseOf(u: any): string {
  if (typeof u?.gameState === 'string' && u.gameState) return u.gameState;
  const s = u?.statusSoccerId;
  if (typeof s === 'string') return s; if (s && typeof s === 'object') return Object.keys(s)[0] || 'NS';
  return 'NS';
}
const num = (x: any) => (Number.isFinite(Number(x)) ? Number(x) : 0);
const r2 = (x: number) => Math.round(x * 100) / 100;
