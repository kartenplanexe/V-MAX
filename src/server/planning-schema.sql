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
-- Additive migration 002. Own user conditions have their own 30-day TTL. This
-- table never contains provider locality/category IDs, geocoder facts or results.
-- There is deliberately no FK to the short-lived planning_owners checkpoint.
CREATE TABLE IF NOT EXISTS saved_user_conditions (
  owner text NOT NULL CHECK (length(owner) <= 200),
  draft_id text NOT NULL CHECK (length(draft_id) BETWEEN 1 AND 128),
  revision integer NOT NULL CHECK (revision >= 0),
  conditions jsonb NOT NULL CHECK (jsonb_typeof(conditions) = 'object'),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(owner, draft_id)
);
CREATE INDEX IF NOT EXISTS saved_user_conditions_expiry ON saved_user_conditions(expires_at);
-- Additive migration 003. Sharing owns conditions; provider preview has a separate
-- original expiry. Retain tables on app rollback; never recreate provider facts.
CREATE TABLE IF NOT EXISTS planning_share_links (
  id text PRIMARY KEY,
  token text NOT NULL UNIQUE,
  owner text NOT NULL,
  draft_id text NOT NULL,
  source_revision integer NOT NULL CHECK(source_revision >= 0),
  create_event_id text NOT NULL,
  fingerprint text NOT NULL,
  conditions jsonb NOT NULL,
  omissions jsonb NOT NULL,
  plan jsonb,
  plan_expires_at timestamptz,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoke_event_id text,
  UNIQUE(owner, create_event_id),
  FOREIGN KEY(owner, draft_id) REFERENCES saved_user_conditions(owner, draft_id) ON DELETE CASCADE,
  CHECK ((plan IS NULL AND plan_expires_at IS NULL) OR (plan IS NOT NULL AND plan_expires_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS planning_share_links_expiry ON planning_share_links(expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS planning_share_revoke_event ON planning_share_links(owner,revoke_event_id) WHERE revoke_event_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS planning_share_imports (
  owner text NOT NULL,
  event_id text NOT NULL,
  share_id text NOT NULL REFERENCES planning_share_links(id) ON DELETE CASCADE,
  fingerprint text NOT NULL,
  status text NOT NULL CHECK(status IN ('pending','done','failed')),
  draft_id text,
  error text,
  error_status integer,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(owner, event_id)
);
CREATE INDEX IF NOT EXISTS planning_share_imports_expiry ON planning_share_imports(expires_at);
-- Additive migration 004. Event search facts expire independently of replay
-- receipts. Only explicit user event identities enter saved_user_conditions.
CREATE TABLE IF NOT EXISTS planning_event_previews (
  id uuid PRIMARY KEY,
  owner text NOT NULL,
  draft_id text NOT NULL,
  event_id text NOT NULL,
  operation text NOT NULL CHECK(operation IN ('search','availability','select','recheck')),
  fingerprint text NOT NULL,
  base_revision integer NOT NULL CHECK(base_revision >= 0),
  day_id text NOT NULL,
  parent_id uuid REFERENCES planning_event_previews(id) ON DELETE CASCADE,
  status text NOT NULL CHECK(status IN ('pending','done','failed')),
  data jsonb,
  data_expires_at timestamptz,
  error text,
  error_status integer,
  expires_at timestamptz NOT NULL,
  UNIQUE(owner,event_id),
  FOREIGN KEY(owner,draft_id) REFERENCES saved_user_conditions(owner,draft_id) ON DELETE CASCADE,
  CHECK((data IS NULL AND data_expires_at IS NULL) OR (data IS NOT NULL AND data_expires_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS planning_event_previews_expiry ON planning_event_previews(expires_at);
CREATE INDEX IF NOT EXISTS planning_event_previews_parent ON planning_event_previews(owner,draft_id,parent_id);
-- Physical subscription accounting, additive and independent of user data retention.
CREATE TABLE IF NOT EXISTS routing_quota_counters (
  scope text NOT NULL, kind text NOT NULL CHECK(kind IN ('day','month')),
  period date NOT NULL, objects integer NOT NULL CHECK(objects >= 0),
  PRIMARY KEY(scope,kind,period)
);
CREATE TABLE IF NOT EXISTS routing_quota_attempts (
  scope text NOT NULL, sent_at timestamptz NOT NULL, objects integer NOT NULL CHECK(objects > 0)
);
CREATE INDEX IF NOT EXISTS routing_quota_attempts_scope_time ON routing_quota_attempts(scope,sent_at);
