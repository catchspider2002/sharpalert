# SharpAlert - Cloudflare Deployment (as built)

**Track:** Trading Tools & Agents · **Subdomain:** `sharpalert.<domain>`
**Live:** https://sharpalert.catchspider2002.workers.dev · Spec: `SPEC.md` · Notes: `README.md`

## Shape (as built)

Pure **Workers + Cron + D1 + Claude** - no Container, no KV (the JWT cache lives in a D1 `kv` table). A 1-minute cron polls TxLINE odds + scores for in-play World Cup matches, detects/classifies movements, asks Claude for a signal card, stores signals, and scores them on full time. The dashboard is served from `./public` via Workers assets.

## Component mapping

| Spec component | Cloudflare (shipped) |
|---|---|
| `poller.js` (60s) | Worker `scheduled` cron `* * * * *` → `runPoll()` |
| `detector.js` (detect + classify) | `src/detector.ts` - `detectMovements`, `classify`, `scoreSignal`; named constants. **Centerpiece.** |
| `explainer.js` (Claude) | `src/explainer.ts` - `claude-sonnet-4-6`, 3-sentence card, deterministic fallback |
| odds + scores | `src/txline.ts` - auth + `getOdds` (demargined `Pct` → implied + decimal) + `getMatchState` |
| `db/signals.json`, `odds-snapshots.json` | **D1** tables `signals`, `odds_snapshots`, plus `match_state` (baseline + streaks + last event) and `kv` |
| `scorer.js` (post-match) | `scoreMatch()` runs when the poll first sees the match finished |
| dashboard | `./public` via `[assets]` - signals feed, odds chart (Chart.js), accuracy-by-confidence table |
| `/run-now` | `POST /api/run-now` — gated behind `ADMIN_KEY` (`X-Admin-Key` header; 403 otherwise) |

## Bindings (`wrangler.toml`, as shipped)

```toml
name = "sharpalert"
main = "src/worker.ts"
compatibility_date = "2026-01-01"

[assets]
directory = "./public"
binding = "ASSETS"

[triggers]
crons = ["* * * * *"]

[[d1_databases]]
binding = "DB"
database_name = "sharpalert"
database_id = "REPLACE_WITH_D1_ID"
```

Secrets: `TXLINE_API_KEY` (required), `ANTHROPIC_API_KEY` (recommended - Claude explanations).

## Deploy

```bash
npm install && wrangler login
wrangler d1 create sharpalert          # paste id into wrangler.toml
npm run db:init:remote
wrangler secret put TXLINE_API_KEY
wrangler secret put ANTHROPIC_API_KEY
npm run deploy
```

## Notes

- The cron only acts on fixtures whose start time is within the last ~3.5h (in-play); a first sighting stores a baseline before detecting.
- Movements need a previous snapshot, so the very first poll of a match emits no signals by design.
- Reactive signals are not scored; accuracy is reported for sharp signals by confidence tier.
