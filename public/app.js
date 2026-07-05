// SharpAlert dashboard.
const qs = (s) => document.querySelector(s);
const api = (p, o) => fetch(p, o).then(async (r) => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status)); return d; });
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MK = { home: 'Home win', draw: 'Draw', away: 'Away win' };
let chart = null;

init();
function init() {
  setupRun('Polling…', 'Run poll now');
  qs('#match').addEventListener('change', () => loadChart(qs('#match').value));
  refresh(); loadMatches();
  setInterval(refresh, 15000);
  setInterval(loadMatches, 30000);
}

// "Run now" is an admin/demo affordance: hidden for normal visitors, revealed with ?admin=KEY
// (stored locally). The key is sent as X-Admin-Key; the gated /api/run-now rejects anything else.
function setupRun(busy, idle) {
  const btn = qs('#run'); if (!btn) return;
  const u = new URL(location.href);
  let key = u.searchParams.get('admin');
  if (key) { try { localStorage.setItem('admin_key', key); } catch {} history.replaceState(null, '', u.pathname); }
  if (!key) { try { key = localStorage.getItem('admin_key'); } catch {} }
  if (!key) { btn.style.display = 'none'; return; }
  btn.addEventListener('click', async () => {
    btn.textContent = busy;
    try { await api('/api/run-now', { method: 'POST', headers: { 'X-Admin-Key': key } }); }
    catch (e) { alert('Run failed: ' + (e.message || e)); }
    btn.textContent = idle; refresh();
  });
}

async function refresh() { await Promise.all([loadAccuracy(), loadSignals()]); }

async function loadAccuracy() {
  try {
    const a = await api('/api/accuracy');
    for (const tier of ['high', 'medium', 'low', 'all']) {
      const t = a[tier] || { signals: 0, correct: 0, accuracy: null };
      qs(`#ac-${tier}-n`).textContent = t.signals;
      qs(`#ac-${tier}-c`).textContent = t.correct;
      qs(`#ac-${tier}-a`).textContent = t.accuracy == null ? '-' : t.accuracy + '%';
    }
  } catch {}
}

async function loadSignals() {
  try {
    const { signals } = await api('/api/signals?limit=50');
    const host = qs('#signals');
    if (!signals.length) return;
    host.innerHTML = signals.map((s) => {
      const outcome = s.signal_correct == null ? (s.type === 'reactive' ? '' : '<span class="badge b-pending">- pending</span>')
        : (s.signal_correct ? '<span class="badge b-correct">✓ correct</span>' : '<span class="badge b-incorrect">✗ incorrect</span>');
      const delta = (s.implied_delta > 0 ? '+' : '') + s.implied_delta + 'pp';
      // Neutral-venue tournament: name the team the market is about, not "Home"/"Away".
      const mkName = s.market === 'home' ? s.home_team : s.market === 'away' ? s.away_team : 'Draw';
      return `<div class="signal"><div class="top">` +
        `<span class="match">${esc(s.home_team)} vs ${esc(s.away_team)}</span>` +
        `<span class="badge b-${s.type}">${s.type}</span>` +
        `<span class="badge b-${s.confidence}">${s.confidence}</span>${outcome}</div>` +
        `<div class="move">${esc(mkName)} ${s.direction} - ${delta} (${s.decimal_before}→${s.decimal_after}) · ${esc(s.phase)}</div>` +
        `<div class="exp">${esc(s.explanation)}</div></div>`;
    }).join('');
  } catch {}
}

async function loadMatches() {
  try {
    const { matches } = await api('/api/matches');
    const sel = qs('#match'); const cur = sel.value;
    sel.innerHTML = '<option value="">Pick a tracked match…</option>' +
      matches.map((m) => `<option value="${m.match_id}">${esc(m.home_team)} vs ${esc(m.away_team)}${m.finished ? ' (FT)' : ''}</option>`).join('');
    if (cur) sel.value = cur;
  } catch {}
}

async function loadChart(matchId) {
  if (!matchId) return;
  const { snapshots } = await api(`/api/odds-history/${matchId}`);
  const ctx = qs('#chart').getContext('2d');
  if (chart) chart.destroy();
  const ds = (label, key, color) => ({ label, data: snapshots.map((s) => (s[key] * 100)), borderColor: color, backgroundColor: color, tension: 0.3, pointRadius: 0, borderWidth: 2 });
  // Legend with real team names, parsed from the selected option ("Home vs Away (FT)").
  const optText = (qs('#match').selectedOptions[0]?.text || '').replace(/ \(FT\)$/, '');
  const [homeName, awayName] = optText.includes(' vs ') ? optText.split(' vs ') : ['Home', 'Away'];
  const fmtTs = (t) => { const ms = t < 1e12 ? t * 1000 : t; const d = new Date(ms); return isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };
  // Label by MATCH minute (45+X / 90+X in stoppage, HT at the break); wall-clock only as a
  // fallback for rows captured before the minute column existed.
  const fmtLabel = (s) => {
    if ((s.phase || 'NS') === 'NS') return 'pre';   // pre-kickoff capture
    if (s.minute == null) return '';                 // legacy row without a minute - blank, don't mix in wall-clock
    const m = s.minute, ph = s.phase || '';
    if (ph === 'HT') return 'HT';
    if (ph === 'H1' && m > 45) return `45+${m - 45}'`;
    if (m > 120) return `120+${m - 120}'`;
    if ((ph === 'H2' || ph === 'F') && m > 90) return `90+${m - 90}'`;
    return `${m}'`;
  };
  chart = new Chart(ctx, {
    type: 'line',
    data: { labels: snapshots.map(fmtLabel), datasets: [ds(homeName, 'home', '#16A34A'), ds('Draw', 'draw', '#8888A4'), ds(awayName, 'away', '#DC2626')] },
    options: {
      animation: false,
      scales: {
        y: { title: { display: true, text: 'implied %' }, ticks: { color: '#8888A4' }, grid: { color: 'rgba(0,0,0,0.06)' } },
        x: { display: true, title: { display: true, text: 'Match minute (kickoff → full time)' }, ticks: { color: '#8888A4', maxTicksLimit: 8, maxRotation: 0, autoSkip: true }, grid: { display: false } },
      },
      plugins: { legend: { labels: { color: '#1A1A2E', font: { family: 'Inter' } } } },
    },
  });
}
