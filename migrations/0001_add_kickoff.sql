-- Run once on an existing database:
--   wrangler d1 execute sharpalert --remote --file ./migrations/0001_add_kickoff.sql
-- (omit --remote to apply to your local dev database)
-- Adds the fixture start time (ms) to match_state so the UI can show match date/time.
ALTER TABLE match_state ADD COLUMN kickoff INTEGER;
