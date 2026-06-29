// SharpAlert — Cloudflare Worker. Cron poller + dashboard API + static assets.
import { listFixtures, getOdds, getMatchState, TxEnv } from './txline';
import { detectMovements, classify, scoreSignal, NOISE_THRESHOLD, MARKETS, Market } from './detector';
import { explain } from './explainer';

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  TXLINE_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', ...CORS } });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url); const path = url.pathname;
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (!path.startsWith('/api/')) return env.ASSETS.fetch(req);
    try {
      if (path === '/api/signals' && req.method === 'GET') {
        const lim = Number(url.searchParams.get('limit') || 50);
        const r = await env.DB.prepare('SELECT * FROM signals ORDER BY detected_at DESC LIMIT ?').bind(lim).all();
        return json({ signals: r.results });
      }
      if (path === '/api/matches' && req.method === 'GET') {
        const r = await env.DB.prepare('SELECT match_id, home_team, away_team, phase, finished, last_implied, updated_at FROM match_state ORDER BY updated_at DESC').all();
        return json({ matches: r.results });
      }
      let m = path.match(/^\/api\/odds-history\/(\w+)$/);
      if (m && req.method === 'GET') {
        const r = await env.DB.prepare('SELECT ts, phase, home, draw, away FROM odds_snapshots WHERE match_id=? ORDER BY ts ASC LIMIT 500').bind(m[1]).all();
        return json({ snapshots: r.results });
      }
      if (path === '/api/accuracy' && req.method === 'GET') return json(await accuracy(env));
      if (path === '/api/run-now' && req.method === 'POST') { const n = await runPoll(env); return json({ ok: true, processed: n }); }
      return json({ error: 'not found' }, 404);
    } catch (e) { return json({ error: String((e as Error).message || e) }, 500); }
  },

  async scheduled(_e: ScheduledEvent, env: Env): Promise<void> { await runPoll(env); },
};

async function runPoll(env: Env): Promise<number> {
  if (!env.TXLINE_API_KEY) return 0;
  const txenv: TxEnv = { DB: env.DB, TXLINE_API_KEY: env.TXLINE_API_KEY };
  const now = Date.now();
  let fixtures = [] as Awaited<ReturnType<typeof listFixtures>>;
  try { fixtures = await listFixtures(txenv); } catch { return 0; }
  const live = fixtures.filter((f) => f.startTime >= now - 3.5 * 3600e3 && f.startTime <= now + 10 * 60e3).slice(0, 10);
  await Promise.allSettled(live.map((f) => processMatch(env, txenv, f, now)));
  return live.length;
}

async function processMatch(env: Env, txenv: TxEnv, fx: { fixtureId: number; home: string; away: string }, now: number): Promise<void> {
  const matchId = String(fx.fixtureId);
  const ms = await getMatchState(txenv, matchId);
  const prev = await env.DB.prepare('SELECT * FROM match_state WHERE match_id=?').bind(matchId).first<any>();

  // Finished → score signals once.
  if (ms.finished) {
    if (prev && prev.finished) return;
    await scoreMatch(env, matchId, ms.winner || 'draw');
    await env.DB.prepare(
      'INSERT INTO match_state (match_id,home_team,away_team,phase,finished,winner,updated_at) VALUES (?,?,?,?,1,?,?) ' +
      'ON CONFLICT(match_id) DO UPDATE SET finished=1, winner=excluded.winner, phase=excluded.phase, updated_at=excluded.updated_at')
      .bind(matchId, fx.home, fx.away, ms.phase, ms.winner, new Date().toISOString()).run();
    return;
  }
  if (!ms.started) return;

  const odds = await getOdds(txenv, matchId);
  if (!odds) return;

  const lastEventAt = (ms.goals > (prev?.goals ?? 0) || ms.reds > (prev?.reds ?? 0)) ? now : Number(prev?.last_event_at || 0);

  // First sighting → store baseline, no detection yet.
  if (!prev) {
    await env.DB.prepare('INSERT INTO match_state (match_id,home_team,away_team,last_implied,last_decimal,streak,goals,reds,last_event_at,phase,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .bind(matchId, fx.home, fx.away, JSON.stringify(odds.implied), JSON.stringify(odds.decimal), '{}', ms.goals, ms.reds, lastEventAt, ms.phase, new Date().toISOString()).run();
    await snapshot(env, matchId, now, ms.phase, odds.implied);
    return;
  }

  const prevImplied = safe(prev.last_implied); const prevDecimal = safe(prev.last_decimal);
  const streak = safe(prev.streak) || {};

  // Update per-market direction streaks (consecutive same-direction polls; reset on noise).
  for (const mk of MARKETS) {
    const delta = odds.implied[mk] - (prevImplied[mk] ?? odds.implied[mk]);
    if (Math.abs(delta) < NOISE_THRESHOLD) { streak[mk] = { dir: null, count: 0 }; continue; }
    const dir = delta > 0 ? 'shortening' : 'drifting';
    streak[mk] = streak[mk]?.dir === dir ? { dir, count: streak[mk].count + 1 } : { dir, count: 1 };
  }

  const movements = detectMovements(odds, { implied: prevImplied, decimal: prevDecimal });
  const msSinceEvent = lastEventAt ? now - lastEventAt : Number.MAX_SAFE_INTEGER;

  for (const mv of movements) {
    const cls = classify(streak[mv.market]?.count ?? 1, msSinceEvent);
    const explanation = await explain(env.ANTHROPIC_API_KEY, { home: fx.home, away: fx.away, phase: ms.phase, movement: mv, classification: cls });
    await env.DB.prepare(
      'INSERT INTO signals (id,match_id,home_team,away_team,detected_at,phase,market,direction,implied_delta,decimal_before,decimal_after,type,velocity,confidence,explanation) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(crypto.randomUUID(), matchId, fx.home, fx.away, now, ms.phase, mv.market, mv.direction, mv.impliedDelta, mv.decimalBefore, mv.decimalAfter, cls.type, cls.velocity, cls.confidence, explanation).run();
  }

  await env.DB.prepare('UPDATE match_state SET last_implied=?, last_decimal=?, streak=?, goals=?, reds=?, last_event_at=?, phase=?, updated_at=? WHERE match_id=?')
    .bind(JSON.stringify(odds.implied), JSON.stringify(odds.decimal), JSON.stringify(streak), ms.goals, ms.reds, lastEventAt, ms.phase, new Date().toISOString(), matchId).run();
  await snapshot(env, matchId, now, ms.phase, odds.implied);
}

async function snapshot(env: Env, matchId: string, ts: number, phase: string, implied: Record<Market, number>): Promise<void> {
  await env.DB.prepare('INSERT INTO odds_snapshots (match_id,ts,phase,home,draw,away) VALUES (?,?,?,?,?,?)')
    .bind(matchId, ts, phase, implied.home, implied.draw, implied.away).run();
}

async function scoreMatch(env: Env, matchId: string, outcome: string): Promise<void> {
  const rows = await env.DB.prepare("SELECT id, market, direction, type FROM signals WHERE match_id=? AND signal_correct IS NULL").bind(matchId).all<any>();
  for (const s of rows.results || []) {
    const correct = scoreSignal(s.type, s.market as Market, s.direction, outcome);
    await env.DB.prepare('UPDATE signals SET outcome=?, signal_correct=? WHERE id=?')
      .bind(outcome, correct === null ? null : (correct ? 1 : 0), s.id).run();
  }
}

async function accuracy(env: Env): Promise<object> {
  const rows = await env.DB.prepare("SELECT confidence, signal_correct FROM signals WHERE type='sharp' AND signal_correct IS NOT NULL").all<any>();
  const tiers: Record<string, { signals: number; correct: number }> = { high: z(), medium: z(), low: z(), all: z() };
  for (const r of rows.results || []) {
    const t = tiers[r.confidence] || (tiers[r.confidence] = z());
    t.signals++; tiers.all.signals++;
    if (r.signal_correct) { t.correct++; tiers.all.correct++; }
  }
  const out: Record<string, { signals: number; correct: number; accuracy: number | null }> = {};
  for (const k of Object.keys(tiers)) out[k] = { ...tiers[k], accuracy: tiers[k].signals ? Math.round((tiers[k].correct / tiers[k].signals) * 100) : null };
  return out;
}
function z() { return { signals: 0, correct: 0 }; }
function safe(s: any): any { try { return typeof s === 'string' ? JSON.parse(s) : (s || {}); } catch { return {}; } }
