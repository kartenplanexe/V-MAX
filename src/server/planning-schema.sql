-- Additive migration 001; rerunnable. Rollback the application, retain these tables.
-- Dropping them destroys drafts and quota/idempotency receipts and is not an automatic rollback.
CREATE TABLE IF NOT EXISTS planning_owners (
  owner text PRIMARY KEY CHECK (length(owner) <= 200),
  state jsonb NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS planning_owners_expiry ON planning_owners(expires_at);
CREATE TABLE IF NOT EXISTS planning_daily_usage (
  day date NOT NULL,
  kind text NOT NULL,
  calls integer NOT NULL CHECK (calls > 0),
  PRIMARY KEY(day, kind)
);
-- User-authored route index and bot navigation. No 2GIS place payloads or route results.
-- The short-lived planning_owners checkpoint remains on its separate 30-minute TTL.
CREATE TABLE IF NOT EXISTS bot_navigation (
  owner text PRIMARY KEY CHECK (length(owner) <= 200),
  state jsonb NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS bot_navigation_expiry ON bot_navigation(expires_at);
