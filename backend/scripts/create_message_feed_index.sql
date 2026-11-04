-- Indexes behind GET /api/messages, the per-account messages feed (routes/messages.js).
--
-- Run this ONCE, by hand, against the production database — after the deploy
-- that adds the read-signal columns (boot adds messages.signals_updated_at; the
-- second index needs it). It is deliberately not in db.js's boot path, for the
-- same reason as create_conversation_index.sql: every pooled connection carries
-- `SET statement_timeout = '15s'`, a build over `messages` (bodies inline) will
-- not finish inside that, and a cancelled build would be retried on every
-- deploy while the index never existed. db.js warnIfIndexMissing() reports the
-- state of both indexes on boot instead.
--
-- The feed works without them, just slowly: each page then scans the account's
-- rows through idx_messages_account, bodies and all, and on a big mailbox that
-- can cross the 15s statement_timeout (a 500 for that page, never wrong data).
--
--   idx_messages_feed          (account_id, created_at, id)
--       order=created (the default): new rows in ingest order.
--   idx_messages_feed_changed  (account_id, COALESCE(signals_updated_at, created_at), id)
--       order=changed: new rows AND rows whose read signals / folder / removal
--       changed. The expression must stay byte-identical to the one in
--       routes/messages.js, or the planner won't use the index.
--
-- Prerequisite (boot adds it; check if in doubt):
--   SELECT column_name FROM information_schema.columns
--    WHERE table_schema = 'missive' AND table_name = 'messages' AND column_name = 'signals_updated_at';

-- Run as `psql -f`: stop at the first error until the builds, so a wrong
-- connection never gets as far as a half-built index.
\set ON_ERROR_STOP on

-- The app pushes search_path per pooled connection; a psql session does not.
SET search_path TO missive, public;

-- ⚠️ This must be a SESSION-mode connection (Supabase direct 5432, or the
-- session pooler on 5432) — not the transaction pooler on 6543 and not the SQL
-- editor. CREATE INDEX CONCURRENTLY cannot run inside a transaction block, and a
-- transaction pooler can hand the SETs and the CREATE to different backends.
-- psql runs statements in autocommit by default, so just don't wrap this in
-- BEGIN/COMMIT.
--
-- No timeouts for this session. lock_timeout in particular must be 0: CREATE
-- INDEX CONCURRENTLY waits for every transaction older than each of its phases,
-- and those waits count against lock_timeout — a finite value turns one long
-- ingest transaction into a 55P03 AFTER the full scan, leaving an INVALID index.
-- Clear long transactions first instead (the pre-check below).
SET statement_timeout = 0;
SET lock_timeout = 0;

-- Pre-check: sessions the builds will wait on. With no lock_timeout they simply
-- wait — but an 'idle in transaction' session can hold them indefinitely. If one
-- shows up here, end it (pg_terminate_backend) or let it finish.
SELECT pid, state, now() - xact_start AS xact_age, left(query, 80) AS query
  FROM pg_stat_activity
 WHERE xact_start < now() - interval '30 seconds'
   AND pid <> pg_backend_pid()
 ORDER BY xact_start;

-- Past the pre-checks. Let a failed build fall through to the verify below.
\set ON_ERROR_STOP off


-- -----------------------------------------------------------------------------
-- 1. BUILD
-- -----------------------------------------------------------------------------
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_feed
  ON messages (account_id, created_at, id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_feed_changed
  ON messages (account_id, (COALESCE(signals_updated_at, created_at)), id);


-- -----------------------------------------------------------------------------
-- 2. VERIFY — always. Do not trust the absence of an error.
-- -----------------------------------------------------------------------------
-- A cancelled or failed CONCURRENTLY build leaves an INVALID index behind. The
-- planner ignores it, yet it still costs every write — and `IF NOT EXISTS`
-- matches its name forever after, so a retry silently does nothing. Expect two
-- rows, both indisvalid = true.
SELECT c.relname, i.indisvalid, i.indisready
  FROM pg_class c
  JOIN pg_index i ON i.indexrelid = c.oid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'missive' AND c.relname IN ('idx_messages_feed', 'idx_messages_feed_changed')
 ORDER BY c.relname;

-- indisvalid = false (or a row missing) → drop it (also CONCURRENTLY, and also
-- outside a transaction) and run this script again:
--   DROP INDEX CONCURRENTLY IF EXISTS missive.idx_messages_feed;
--   DROP INDEX CONCURRENTLY IF EXISTS missive.idx_messages_feed_changed;
--
-- Both valid → done. On the next deploy the "[db] idx_messages_feed... is
-- MISSING / INVALID" boot warnings are gone.
