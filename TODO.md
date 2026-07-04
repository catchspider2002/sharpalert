# SharpAlert - Submission Checklist

Track: **Trading Tools & Agents** (Superteam × TxODDS World Cup Hackathon)
Live: https://sharpalert.wc26hackathon.com · Repo: https://github.com/catchspider2002/sharpalert

## ✅ Done

- [x] Detector (centerpiece): movement detection, sharp/reactive classification, velocity/confidence, scoring - `detector.ts`
- [x] TxLINE client: auth + fixtures + odds (demargined Pct → implied/decimal) + scores
- [x] DeepInfra explainer with deterministic fallback
- [x] Cron poller (1-min) over in-play matches; per-match baseline + streaks in D1
- [x] Post-match scoring + accuracy-by-confidence tracker
- [x] Dashboard: signals feed, odds chart (Chart.js), accuracy table, Run-poll-now
- [x] D1 schema (match_state, odds_snapshots, signals, kv); cron + assets config
- [x] Deployed to Cloudflare; `TXLINE_API_KEY` set
- [x] Verified live: `/api/accuracy` responds (Worker + D1 up)

## ⏳ Before submitting

- [ ] **Add `DEEPINFRA_API_KEY`**: `wrangler secret put DEEPINFRA_API_KEY` (LLM-written signal cards; deterministic fallback works without it)
- [ ] **Record demo video** (≤5 min): Run-poll-now during an in-play match, walk `detector.ts`, show a signal card + odds chart + the accuracy table
- [ ] **Add demo video link** to README + submission form
- [ ] **Push final code to GitHub** - confirm latest commit; verify `.dev.vars` is NOT committed
- [x] **Gated `/api/run-now`** behind `ADMIN_KEY` (403 without it); dashboard button hidden unless opened with `?admin=KEY`
- [ ] **Set `ADMIN_KEY`**: `wrangler secret put ADMIN_KEY` (required to use the "Run poll now" button)
- [ ] **Fill submission form**: live URL, GitHub URL, video URL, TxLINE endpoints used, API feedback
- [ ] Attach custom domain `sharpalert.<domain>` (optional)

## 💡 Optional polish / known limitations

- [ ] Telegram channel for high-confidence alerts (token already supported in env example)
- [ ] Solflare/Phantom/Backpack connect on the dashboard (Solana sign-up requirement)
- [ ] Tune `SHARP_THRESHOLD` / `NOISE_THRESHOLD` against real in-play tick frequency
- [ ] Use the scores action feed for precise event minutes (reactive window currently uses count changes)
- [ ] Verify odds `PriceNames`/`Pct` shape against a live match (parser has a safe fallback)
