# SharpAlert - Sharp Movement Detector
## Build Spec for Claude Code

---

## What we're building

An autonomous agent that polls TxLINE odds every 60 seconds across all live World Cup matches, detects significant line movements (sharp money indicators), logs each signal with context, and tracks whether the movement predicted the final outcome. Results are published to a live dashboard and optionally pushed as Telegram alerts. Clean, well-documented logic is the core judging criterion - this is a B2B tool a trading desk would actually use.

Submitted to the **Superteam × TxODDS World Cup Hackathon** under the **Trading Agents** track.

**Hackathon deadline:** July 19, 2026 (23:59 UTC)  
**Required:** running agent (live or devnet), demo video, public GitHub repo, working dashboard link

---

## Architecture overview

```
Cron: every 60 seconds (per live match)
       │
       ▼
Agent Pipeline
  ├── Step 1: Poll TxLINE odds for all live matches
  ├── Step 2: Compare to previous snapshot → detect movements ≥ threshold
  ├── Step 3: Classify movement (sharp vs noise)
  ├── Step 4: Call Claude API → generate plain-English signal explanation
  ├── Step 5: Log signal to DB
  ├── Step 6: Push alert to dashboard + Telegram (optional)
       │
       ▼
Post-match scorer (runs after full_time)
  └── Marks each signal as correct / incorrect / inconclusive
       │
       ▼
Dashboard
  ├── Live signals feed (most recent first)
  ├── Per-match odds movement chart
  └── Overall signal accuracy tracker
```

---

## Project structure

```
sharpalert/
├── agent/
│   ├── index.js              # Entry point - starts poller + SSE listener
│   ├── poller.js             # 60-second odds poller
│   ├── detector.js           # Movement detection + classification logic
│   ├── explainer.js          # Claude API → plain-English signal card
│   ├── scorer.js             # Post-match outcome scoring
│   └── publisher.js          # Write to DB + push Telegram alert
├── backend/
│   ├── server.js             # Express API for dashboard
│   └── routes/
│       ├── signals.js        # GET /signals
│       ├── matches.js        # GET /matches
│       └── odds-history.js   # GET /odds-history/:matchId
├── frontend/
│   ├── index.html            # Dashboard
│   ├── app.js
│   └── styles.css
├── db/
│   ├── signals.json          # All detected movements + outcomes
│   └── odds-snapshots.json   # Rolling odds history per match
├── .env.example
├── package.json
└── README.md
```

---

## Detection logic - the core of the agent (`detector.js`)

This is the most important file. Keep it clean, deterministic, and well-commented - judges will read this code.

### Data structure per poll

```js
// Odds snapshot per match, per poll
{
  matchId: string,
  polledAt: ISO timestamp,
  minute: number,           // current match minute from TxLINE
  status: string,           // 'prematch' | 'live' | 'halftime' | 'finished'
  odds: {
    homeWin:  { decimal: 1.82, implied: 0.549 },
    draw:     { decimal: 3.50, implied: 0.286 },
    awayWin:  { decimal: 4.20, implied: 0.238 }
  }
}
```

Store the last 30 snapshots per match in memory (rolling window).

### Movement detection algorithm

On each poll, compare current odds to the previous snapshot:

```js
function detectMovement(current, previous) {
  const movements = []

  for (const market of ['homeWin', 'draw', 'awayWin']) {
    const impliedDelta = current.odds[market].implied - previous.odds[market].implied
    const decimalDelta = current.odds[market].decimal - previous.odds[market].decimal
    const pctChange = Math.abs(impliedDelta) / previous.odds[market].implied

    if (Math.abs(impliedDelta) >= SHARP_THRESHOLD) {
      movements.push({
        market,
        direction: impliedDelta > 0 ? 'shortening' : 'drifting',
        impliedDelta: Math.round(impliedDelta * 1000) / 10,  // to 1dp %
        decimalBefore: previous.odds[market].decimal,
        decimalAfter: current.odds[market].decimal,
        pctChange: Math.round(pctChange * 1000) / 10
      })
    }
  }

  return movements
}
```

### Threshold constants (tune based on TxLINE data during dev)

```js
const SHARP_THRESHOLD = 0.05        // 5pp implied probability shift = signal
const NOISE_THRESHOLD = 0.02        // < 2pp = ignore completely
const VELOCITY_THRESHOLD = 3        // if same direction 3 polls in a row = high confidence
```

### Movement classification

After detecting a movement, classify it:

```js
function classifyMovement(movement, recentSnapshots, matchContext) {
  // Check velocity: has this market been moving the same direction for 3+ consecutive polls?
  const velocity = getVelocity(recentSnapshots, movement.market)

  // Check if a match event (goal, red card) just happened - if so, flag as REACTIVE not SHARP
  const recentEvent = matchContext.lastEventMinute
  const isReactive = recentEvent && (matchContext.currentMinute - recentEvent) <= 3

  return {
    type: isReactive ? 'reactive' : 'sharp',
    velocity,                           // 'single' | 'sustained'
    confidence: deriveConfidence(movement, velocity, isReactive)
  }
}

// confidence: 'low' | 'medium' | 'high'
// high = sustained movement (3+ polls) + no recent match event
// medium = single large movement + no recent event
// low = movement coincides with a match event (likely just the market repricing a known event)
```

Flag reactive movements separately on the dashboard - they're still interesting but not "sharp" signals.

---

## Claude API explainer (`explainer.js`)

Called once per detected signal. Generates the human-readable signal card.

System prompt:
```
You are a sports trading analyst specialising in identifying sharp money movements in football betting markets.

Given a detected odds movement during a World Cup match, write a concise signal card with exactly three parts:

1. WHAT MOVED: One sentence describing the movement in plain English (e.g. "Brazil's win odds shortened from 1.82 to 1.61 - a 9 percentage point implied probability shift in 60 seconds")
2. WHAT IT SUGGESTS: One sentence interpreting what this movement typically indicates (sharp money, market correction, or reaction to match events)
3. WATCH FOR: One sentence on what outcome would confirm or invalidate this signal by full time

Rules:
- Maximum 20 words per sentence
- Use concrete numbers from the data - no vague language
- Do not make predictions - describe what the market is doing, not what will happen
- Output only the three sentences separated by newlines, no labels or headers
```

User message (JSON):
```json
{
  "match": {
    "homeTeam": "Brazil",
    "awayTeam": "France",
    "score": "1-1",
    "minute": 67,
    "stage": "Round of 16"
  },
  "movement": {
    "market": "homeWin",
    "direction": "shortening",
    "decimalBefore": 2.10,
    "decimalAfter": 1.82,
    "impliedDelta": "+9.2pp",
    "polledAt": "2026-07-04T19:07:00Z"
  },
  "classification": {
    "type": "sharp",
    "velocity": "sustained",
    "confidence": "high"
  },
  "recentMatchEvents": ["Goal - Rodrygo 61'", "Yellow card - Hernandez 65'"]
}
```

Use `claude-sonnet-4-6`, `max_tokens: 120`.

---

## Signal data structure (`db/signals.json`)

```json
[
  {
    "id": "uuid",
    "matchId": "txline_match_id",
    "homeTeam": "Brazil",
    "awayTeam": "France",
    "detectedAt": "2026-07-04T19:07:00Z",
    "matchMinute": 67,
    "movement": { ... },
    "classification": { ... },
    "explanation": "Brazil's win probability jumped 9pp in 60 seconds...\n...\n...",
    "oddsAtSignal": { ... },
    "outcome": null,          // filled post-match: 'home_win' | 'draw' | 'away_win'
    "signalCorrect": null,    // true | false | null (inconclusive)
    "finalScore": null
  }
]
```

---

## Post-match scorer (`scorer.js`)

Runs when TxLINE emits a `full_time` event (listen via SSE, not cron).

For each unscored signal for that match:
- `signalCorrect: true` if:
  - Signal was `homeWin shortening` and home team won
  - Signal was `awayWin shortening` and away team won
  - Signal was `homeWin drifting` and home team did NOT win
- `signalCorrect: false` otherwise
- `signalCorrect: null` if `classification.type === 'reactive'` (don't score reactive movements)

Track per-confidence-tier accuracy separately:
- High confidence signals accuracy
- Medium confidence signals accuracy
- Low confidence signals accuracy

This breakdown is a key dashboard feature - it shows the model is calibrated, not just lucky.

---

## Odds history store (`db/odds-snapshots.json`)

Keep a rolling history of every odds snapshot per match. Used to:
- Power the odds movement chart on the dashboard
- Calculate velocity in the detector
- Provide context to the explainer

Limit to last 500 snapshots per match to control file size. Prune on each write.

---

## Dashboard (`frontend/index.html`)

Three sections:

### 1. Live signals feed
Most recent signals at the top. Each signal card shows:
- Match name + current score + minute
- Market that moved (e.g. "Home win")
- Direction + magnitude (e.g. "Shortening - 9.2pp in 60s")
- Classification badge: `[Sharp]` or `[Reactive]`
- Confidence badge: High / Medium / Low
- Claude explanation (3 sentences)
- Outcome badge (post-match): `✓ Correct` / `✗ Incorrect` / `- Inconclusive`

### 2. Odds movement chart (per match)
- X axis: match minute (0-90+)
- Y axis: implied probability (0-100%)
- Three lines: home win / draw / away win
- Signal markers: vertical dotted lines at each detection point
- Use Chart.js (available on cdnjs)
- Match selector dropdown to switch between active/recent matches

### 3. Accuracy tracker
Summary stats grid:

| | High confidence | Medium | Low | All |
|---|---|---|---|---|
| Signals | N | N | N | N |
| Correct | N | N | N | N |
| Accuracy | X% | X% | X% | X% |

---

## Telegram alerts (optional)

Post to a public channel on each high-confidence signal:

```
Sharp movement detected - Brazil vs France (67')

Home win: 2.10 → 1.82 (+9.2pp implied)
Type: Sustained (3 consecutive polls)
Confidence: High

Brazil's win probability jumped 9pp in 60 seconds with no match event to explain it.
This pattern typically indicates sharp money entering the market.
Watch for Brazil to score or create dominant chances before full time.

@SharpAlertWC | Powered by TxLINE
```

Only send for `confidence: 'high'` signals - don't spam the channel with noise.

---

## Deployment

- **Agent + backend:** Railway or Fly.io - persistent process required for the 60s polling loop and SSE listener
- **Frontend:** Vercel or Netlify
- Do not use Render free tier (spins down after 15 minutes of inactivity, breaking the poller)

---

## Environment variables (`.env`)

```
TXLINE_API_KEY=your_txline_key
TXLINE_SSE_URL=https://txline.txodds.com/stream
TXLINE_BASE_URL=https://txline.txodds.com
ANTHROPIC_API_KEY=your_anthropic_key
TELEGRAM_BOT_TOKEN=your_token        # optional
TELEGRAM_CHANNEL_ID=@SharpAlertWC   # optional
PORT=3001
```

---

## Demo video plan (max 5 minutes)

1. **0:00-0:30** - Open dashboard. Show live signals feed with a few signals already logged. Point out the confidence tiers and accuracy tracker.
2. **0:30-1:30** - Trigger the agent with a `/run-now` endpoint (add for demo). Watch in terminal: TxLINE poll → comparison against previous snapshot → movement detected → Claude explanation generated → signal appears on dashboard in real time.
3. **1:30-2:30** - Open `detector.js` in editor. Walk through the algorithm briefly - threshold constants, velocity check, reactive vs sharp classification. Judges will read this code; make it look clean.
4. **2:30-3:30** - Show the odds movement chart for a completed match. Point to a signal marker on the chart. Show the signal card below it - was it correct?
5. **3:30-4:00** - Show the accuracy breakdown table. High-confidence signals should outperform low-confidence ones - even with a small sample this tells a story.
6. **4:00-4:30** - (If Telegram enabled) Show a high-confidence alert in the channel.
7. **4:30-5:00** - Wrap: "60-second polling. Automatic sharp/reactive classification. Outcome tracking across 104 games. Zero human input."

---

## Submission checklist

- [ ] Agent polling every 60 seconds on all live matches
- [ ] Sharp vs reactive classification working
- [ ] Claude explanations generating correctly
- [ ] Post-match scoring populating signalCorrect
- [ ] Dashboard live with signals feed + odds chart + accuracy table
- [ ] (Optional) Telegram channel posting high-confidence signals
- [ ] GitHub repo public - detector.js especially must be clean and well-commented
- [ ] Demo video uploaded
- [ ] TxLINE endpoints listed in submission form
- [ ] API feedback prepared

---

## TxLINE resources

- Quickstart: https://txline.txodds.com/documentation/quickstart
- World Cup docs: https://txline.txodds.com/documentation/worldcup
- Support: Discord and Telegram
- Data fees waived until July 19, 2026

---

## Key decisions / notes for Claude Code

- **`detector.js` is the judging centrepiece** - keep it under 150 lines, heavily commented, with named constants for all thresholds. Judges will open this file. Clean logic beats clever tricks.
- **Add a `/run-now` endpoint** for the demo - lets you fire a poll cycle on demand without waiting 60 seconds.
- **Build a mock odds stream** (`mockPoller.js`) that generates synthetic odds movements for development - you need a live match to test against real data, and group stage games aren't on 24/7.
- **The reactive vs sharp distinction is the intellectual core** - a movement right after a goal is just the market repricing a known event. A movement with no match context is the interesting signal. Make sure this distinction is clearly explained in the README and visible on the dashboard.
- **Tune the threshold after seeing real TxLINE data** - 5pp is a starting point. TxLINE may tick odds more or less frequently than expected. Check the first few real matches and adjust `SHARP_THRESHOLD` if signals are too frequent or too rare.
- **Velocity detection needs at least 3 polls** - don't classify as sustained until you have confirmed 3 consecutive same-direction movements. A single large move could be a data correction; sustained movement over 3 minutes is the real signal.
- **File locking on JSON writes** - use `proper-lockfile` to prevent corruption if two match events write simultaneously.
- **Chart.js** is available on cdnjs and handles time-series line charts well. Use `type: 'line'` with `tension: 0.3` for smooth odds curves.
