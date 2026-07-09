-- SharpAlert D1 schema
-- Apply: wrangler d1 execute sharpalert --remote --file ./schema.sql

-- Small key/value (TxLINE guest-JWT cache, etc.)
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);

-- Per-match tracking state (baseline odds, streaks, last event, teams).
CREATE TABLE IF NOT EXISTS match_state (
  match_id      TEXT PRIMARY KEY,
  home_team     TEXT, away_team TEXT,
  kickoff       INTEGER,  -- fixture start time (ms), for display
  last_implied  TEXT,   -- {home,draw,away}
  last_decimal  TEXT,   -- {home,draw,away}
  streak        TEXT,   -- { market: { dir, count } }
  goals         INTEGER DEFAULT 0,
  reds          INTEGER DEFAULT 0,
  last_event_at INTEGER DEFAULT 0,  -- ms wall clock of last goal/red
  phase         TEXT,
  finished      INTEGER DEFAULT 0,
  winner        TEXT,
  updated_at    TEXT
);

-- Rolling odds snapshots (for the per-match chart).
CREATE TABLE IF NOT EXISTS odds_snapshots (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id   TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  phase      TEXT,
  minute     INTEGER,                     -- match minute at capture (null pre-kickoff / unknown)
  home       REAL, draw REAL, away REAL   -- implied probabilities
);
CREATE INDEX IF NOT EXISTS idx_snap_match ON odds_snapshots (match_id, ts);

-- Detected signals.
CREATE TABLE IF NOT EXISTS signals (
  id            TEXT PRIMARY KEY,
  match_id      TEXT NOT NULL,
  home_team     TEXT, away_team TEXT,
  detected_at   INTEGER NOT NULL,
  phase         TEXT,
  market        TEXT,                 -- home | draw | away
  direction     TEXT,                 -- shortening | drifting
  implied_delta REAL,                 -- pp (1dp)
  decimal_before REAL, decimal_after REAL,
  type          TEXT,                 -- sharp | reactive
  velocity      TEXT,                 -- single | sustained
  confidence    TEXT,                 -- low | medium | high
  explanation   TEXT,
  outcome       TEXT,                 -- home_win | draw | away_win | null
  signal_correct INTEGER              -- 1 | 0 | null
);
CREATE INDEX IF NOT EXISTS idx_sig_match ON signals (match_id);
CREATE INDEX IF NOT EXISTS idx_sig_time ON signals (detected_at);
