# SharpAlert - Sharp Movement Detector

An autonomous agent that polls TxLINE odds every minute across live World Cup matches, detects significant line movements, classifies them **sharp vs reactive**, explains each with Claude, and tracks whether the signal predicted the result. Submitted to the Superteam × TxODDS World Cup Hackathon - Trading Tools & Agents track.

**Stack:** Cloudflare Workers + **Cron Triggers** + D1 + Claude. No Container.

- **Live:** https://sharpalert.catchspider2002.workers.dev
- **GitHub:** https://github.com/catchspider2002/sharpalert
- **Demo video:** _add link_
- **TxLINE endpoints used:** `POST /auth/guest/start`, `GET /api/fixtures/snapshot`, `GET /api/odds/snapshot/{fixtureId}`, `GET /api/scores/snapshot/{fixtureId}`

## How it works

- **Poll** (`src/worker.ts` cron, every minute): finds in-play World Cup fixtures, reads odds + scores.
- **Detect** (`src/detector.ts` - the judging centerpiece): a ≥5pp implied-probability shift on any market is a signal; per-market direction streaks give velocity.
- **Classify**: a move within 3 min of a goal/red is **reactive** (market repricing a known event); otherwise **sharp**. Confidence: high = sustained (3+ polls) with no event, medium = single large move, low = reactive.
- **Explain** (`src/explainer.ts`): Claude (`claude-sonnet-4-6`) writes a 3-sentence signal card. Falls back to a deterministic card if no key.
- **Score**: on full time, each sharp signal is marked correct/incorrect; the dashboard breaks accuracy down by confidence tier (calibration, not luck).

## Setup & deploy

```bash
npm install
wrangler login
wrangler d1 create sharpalert          # paste the id into wrangler.toml
npm run db:init:remote                  # create tables (production)
wrangler secret put TXLINE_API_KEY
wrangler secret put ANTHROPIC_API_KEY   # optional but recommended (Claude explanations)
npm run deploy
```

## Demo

- `POST /api/run-now` triggers a poll immediately (don't wait for the cron). The dashboard's **Run poll now** button does this.
- During an in-play match, sharp moves appear in the **Live signals** feed; pick a match to see its **odds movement chart**; the **accuracy** table fills in after matches finish.
- `detector.js` is intentionally small and commented - open it on camera.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/signals?limit=` | recent signals |
| GET | `/api/matches` | tracked matches |
| GET | `/api/odds-history/:matchId` | implied-prob snapshots (chart) |
| GET | `/api/accuracy` | accuracy by confidence tier |
| POST | `/api/run-now` | trigger a poll now (demo; gate before submitting) |

## Notes / limitations (hackathon scope)

- Implied probabilities come from the TxODDS demargined `Pct`; decimals are derived as `1/implied`.
- `reactive` detection uses goal/red count changes as the event proxy; precise minute isn't in the snapshot.
- Tune `SHARP_THRESHOLD` after watching real in-play tick frequency.
- `/api/run-now` is open for the demo - gate or remove it before final submission.
- A wallet connect can be added to the dashboard for the Solana sign-up requirement.
