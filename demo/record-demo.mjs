// SharpAlert hackathon demo (~2.5 min):
//   Act 1 - the problem (slides: sharp vs reactive moves, impossible to track by hand)
//   Act 2 - live app walkthrough (accuracy table → odds-movement chart → live signals feed)
//   Act 3 - how TxLINE powers the backend (architecture slide + REAL live TxLINE JSON)
// Fully automated; captions/slides carry the narrative so no voiceover is needed.
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const BASE = 'https://sharpalert.wc26hackathon.com';
const OUT = './video';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- pull REAL TxLINE data to show in Act 3 ----
const KEY = readFileSync('/Users/naveencs/Downloads/app store projects/solana-world-cup/bracketboss/.dev.vars', 'utf8')
  .match(/^TXLINE_API_KEY=(.*)$/m)[1].trim().replace(/^"|"$/g, '');
const jwt = (await (await fetch('https://txline.txodds.com/auth/guest/start', { method: 'POST' })).json()).token;
const tx = (p) => fetch('https://txline.txodds.com' + p, { headers: { Authorization: `Bearer ${jwt}`, 'X-Api-Token': KEY } }).then((r) => r.json());

// Next upcoming senior WC fixture that already has a 1X2 market priced.
const upcoming = (await tx('/api/fixtures/snapshot?competitionId=72'))
  .filter((f) => f.StartTime > Date.now()).sort((a, b) => a.StartTime - b.StartTime).slice(0, 8);
const rank = (o) => (/1X2/i.test(o.SuperOddsType || '') ? 4 : 0) + (o.MarketPeriod ? 0 : 2);
let next, pick;
for (const f of upcoming) {
  const oddsArr = await tx(`/api/odds/snapshot/${f.FixtureId}`);
  const cand = (Array.isArray(oddsArr) ? oddsArr : [])
    .filter((o) => Array.isArray(o.PriceNames) && o.PriceNames.length === 3 && Array.isArray(o.Pct))
    .sort((a, b) => rank(b) - rank(a))[0];
  if (cand) { next = f; pick = cand; break; }
}
if (!pick) throw new Error('no upcoming fixture with a priced 1X2 market');
const oddsSample = {
  FixtureId: next.FixtureId,
  Fixture: `${next.Participant1} vs ${next.Participant2}`,
  StartTime: new Date(next.StartTime).toISOString(),
  SuperOddsType: pick.SuperOddsType, Bookmaker: pick.Bookmaker,
  PriceNames: pick.PriceNames, Prices: pick.Prices, Pct: pick.Pct,
};

// ---- live app data for captions ----
const acc = await (await fetch(`${BASE}/api/accuracy`)).json();
const { signals } = await (await fetch(`${BASE}/api/signals?limit=50`)).json();
// Feature the biggest graded-correct sharp move; chart the match it came from.
const graded = signals.filter((s) => s.signal_correct === 1)
  .sort((a, b) => Math.abs(b.implied_delta) - Math.abs(a.implied_delta));
const star = graded[0] || signals[0];
const wrong = signals.find((s) => s.signal_correct === 0);
const mkName = (s) => (s.market === 'home' ? s.home_team : s.market === 'away' ? s.away_team : 'The draw');

// ---- slide deck ----
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const jsonHtml = (o) => `<pre class="code">${esc(JSON.stringify(o, null, 2))}</pre>`;
const slides = `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;font-family:-apple-system,system-ui,sans-serif;background:#0b1120;color:#f1f5f9}
  .slide{display:none;width:100vw;height:100vh;box-sizing:border-box;padding:64px 90px;flex-direction:column;justify-content:center}
  .slide.on{display:flex}
  .brand{color:#fb7185;font-weight:800}
  h1{font-size:54px;margin:0 0 18px} h2{font-size:40px;margin:0 0 26px}
  p,li{font-size:26px;line-height:1.55;color:#cbd5e1} li{margin-bottom:14px}
  .tag{font-size:20px;letter-spacing:2px;text-transform:uppercase;color:#64748b;margin-bottom:14px}
  .code{background:#020617;border:1px solid #1e293b;border-radius:12px;padding:20px 26px;font:16px/1.55 ui-monospace,Menlo,monospace;color:#7dd3fc;overflow:hidden;max-height:52vh}
  .flow{display:flex;align-items:center;gap:14px;margin-top:30px;flex-wrap:wrap}
  .box{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:16px 20px;font-size:20px;font-weight:600}
  .box small{display:block;font-weight:400;color:#94a3b8;font-size:15px;margin-top:4px}
  .arrow{color:#fb7185;font-size:26px;font-weight:700}
  .accent{color:#fb7185}
</style></head><body>

<div class="slide" id="s1" style="text-align:center;align-items:center">
  <h1 style="font-size:72px">⚡ <span class="brand">SharpAlert</span></h1>
  <p style="font-size:30px">In-play sharp movement detector for World Cup 2026<br>Trading Tools &amp; Agents · powered by the <b class="accent">TxLINE</b> live odds feed</p>
</div>

<div class="slide" id="s2">
  <div class="tag">The problem</div>
  <h2>In-play lines move for two very different reasons - and you can't tell them apart by watching</h2>
  <ul>
    <li><b>Reactive</b> moves reprice a known event - a goal, a red card. Old news by the time you see them</li>
    <li><b>Sharp</b> moves happen with <b>no visible event</b> - informed money hitting the market before the rest catches up. That's the signal worth following</li>
    <li>Separating them means watching every market of every live match, minute by minute, and cross-checking the event feed - across simultaneous World Cup games</li>
  </ul>
</div>

<div class="slide" id="s3">
  <div class="tag">The fix</div>
  <h2><span class="brand">SharpAlert</span>: an agent that watches every line, every minute</h2>
  <ul>
    <li>A Worker cron polls <b class="accent">TxLINE</b> odds + scores for every live match, every minute</li>
    <li>A ≥5pp implied-probability shift on any market becomes a signal - classified <b>sharp</b> (no event within 3 min) or <b>reactive</b>, with a confidence tier</li>
    <li>After full time, every signal is <b>graded against the real result</b> - accuracy broken down by confidence, so you can see calibration, not luck</li>
  </ul>
  <p style="margin-top:26px">So far: <b class="accent">${acc.all.signals} signals</b>, ${acc.all.correct} correct (${acc.all.accuracy}%). Let's look. →</p>
</div>

<div class="slide" id="s4">
  <div class="tag">Under the hood</div>
  <h2>How <span class="accent">TxLINE</span> powers the backend</h2>
  <div class="flow">
    <div class="box">TxLINE API<small>odds + scores snapshots, every minute</small></div>
    <div class="arrow">→</div>
    <div class="box">Detector<small>≥5pp shift → signal + velocity</small></div>
    <div class="arrow">→</div>
    <div class="box">Classifier + LLM<small>sharp vs reactive · signal card</small></div>
    <div class="arrow">→</div>
    <div class="box">D1 + grading<small>scored on game_finalised</small></div>
  </div>
  <ul style="margin-top:34px">
    <li><b>detect</b> - implied probabilities from <span class="accent">/api/odds/snapshot</span> are diffed poll-to-poll; the match minute comes from the feed's running clock</li>
    <li><b>classify</b> - the scores feed says whether a goal/red landed within 3 minutes: reactive if yes, <b>sharp</b> if not</li>
    <li><b>grade</b> - on <span class="accent">game_finalised</span>, each sharp signal is marked correct or incorrect against the result</li>
  </ul>
</div>

<div class="slide" id="s5">
  <div class="tag">Live TxLINE data · odds snapshot (full-time 1X2)</div>
  <h2>${esc(next.Participant1)} vs ${esc(next.Participant2)} - the feed the detector diffs, straight from TxLINE</h2>
  ${jsonHtml(oddsSample)}
  <p style="margin-top:22px">The Worker normalises <b>Pct</b> into implied probabilities - two polls of this, 5 points apart, is a signal.</p>
</div>

<div class="slide" id="s6" style="text-align:center;align-items:center">
  <h1><span class="brand">SharpAlert</span></h1>
  <p style="font-size:28px">sharpalert.wc26hackathon.com<br><br>The market whispers before it shouts. <span class="accent">Hear it first.</span> ⚡</p>
</div>

<script>window.show=(id)=>{document.querySelectorAll('.slide').forEach(s=>s.classList.remove('on'));document.getElementById(id).classList.add('on')}</script>
</body></html>`;
const slidesPath = resolve('./slides.html');
writeFileSync(slidesPath, slides);

// ---- recording ----
const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  recordVideo: { dir: OUT, size: { width: 1280, height: 720 } },
});
const page = await ctx.newPage();

let currentCaption = '';
async function caption(text) {
  await page.evaluate((t) => {
    let el = document.getElementById('demo-cap');
    if (!el) {
      el = document.createElement('div');
      el.id = 'demo-cap';
      el.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);' +
        'background:rgba(10,14,26,.92);color:#fff;padding:12px 22px;border-radius:12px;' +
        'font:600 19px/1.3 -apple-system,system-ui,sans-serif;z-index:99999;max-width:900px;' +
        'text-align:center;box-shadow:0 6px 24px rgba(0,0,0,.45);border:1px solid rgba(255,255,255,.15)';
      document.body.appendChild(el);
    }
    el.textContent = t;
  }, text);
}
async function cap(text, holdMs = 2600) { currentCaption = text; await caption(text); await sleep(holdMs); }
page.on('load', () => { if (currentCaption) caption(currentCaption).catch(() => { }); });
async function clearCap() {
  currentCaption = '';
  await page.evaluate(() => document.getElementById('demo-cap')?.remove()).catch(() => { });
}
async function slide(id, holdMs) {
  if (!page.url().startsWith('file:')) await page.goto('file://' + slidesPath);
  await page.evaluate((i) => window.show(i), id);
  await sleep(holdMs);
}

// ============ ACT 1 - the problem (slides) ============
await page.goto('file://' + slidesPath);
await slide('s1', 6000);
await slide('s2', 12000);
await slide('s3', 12000);

// ============ ACT 2 - live walkthrough ============
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('#signals .signal');
await cap('This is the live dashboard - every signal here was detected automatically during a real match', 4600);
await cap(`Calibration first: ${acc.all.signals} graded signals, ${acc.all.accuracy}% correct - broken down by confidence tier, so high-confidence must earn its name`, 5000);

// Odds movement chart for the featured match.
await page.selectOption('#match', String(star.match_id));
await sleep(1500);
await page.evaluate(() => document.getElementById('chart').scrollIntoView({ behavior: 'smooth', block: 'center' }));
await sleep(1200);
await cap(`${star.home_team} vs ${star.away_team}: every TxLINE poll plotted by MATCH minute - kickoff to full time, all three markets`, 5000);
await cap('Big swings with no goal nearby are exactly what the detector hunts', 3800);

// Signals feed.
await page.evaluate(() => {
  const sig = [...document.querySelectorAll('#signals .signal')][0];
  sig?.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
await sleep(1400);
await cap('The live signal feed: what moved, how fast, sharp or reactive, and the confidence tier', 4600);
const starIdx = await page.evaluate((id) => {
  const cards = [...document.querySelectorAll('#signals .signal')];
  return cards.findIndex((c) => c.querySelector('.exp')?.textContent && c.textContent.includes('✓'));
}, null);
if (starIdx >= 0) {
  await page.evaluate((i) => [...document.querySelectorAll('#signals .signal')][i].scrollIntoView({ behavior: 'smooth', block: 'center' }), starIdx);
  await sleep(1400);
}
await cap(`${mkName(star)} moved ${star.implied_delta > 0 ? '+' : ''}${star.implied_delta}pp in ${star.home_team} vs ${star.away_team} - graded ✓ correct after full time`, 5000);
if (wrong) {
  const wrongIdx = await page.evaluate(() => [...document.querySelectorAll('#signals .signal')].findIndex((c) => c.textContent.includes('✗')));
  if (wrongIdx >= 0) {
    await page.evaluate((i) => [...document.querySelectorAll('#signals .signal')][i].scrollIntoView({ behavior: 'smooth', block: 'center' }), wrongIdx);
    await sleep(1400);
  }
  await cap('Misses are shown too - ✗ incorrect. Grading every signal is the whole point: calibration, not cherry-picking', 4800);
}
await clearCap();

// ============ ACT 3 - TxLINE backend ============
await page.goto('file://' + slidesPath);
await slide('s4', 14000);
await slide('s5', 11000);
await slide('s6', 5000);

await ctx.close();
await browser.close();
console.log('DONE - raw webm in ' + OUT);
