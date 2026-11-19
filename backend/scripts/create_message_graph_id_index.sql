-- Index behind the Graph @removed markers (email/graph.js markRemovedBatch).
--
-- Each delta page's @removed entries are marked with ONE statement:
--   UPDATE messages ... WHERE account_id = $1 AND graph_id = ANY(...) AND folder = $5
-- Without this index that statement scans the account's rows (bodies inline)
-- once per page that carries removals. Mass removals are routine in Microsoft
-- 365 (retention policies, Sweep, bulk deletes), so on a big mailbox the scan can
-- hit the 15s statement_timeout. That is logged and skipped — the removal markers
-- for that page are lost, the walk carries on — so the index is about not losing
-- markers, never about mail.
--
-- Run this ONCE, by hand, against the production database, after the deploy
-- that adds messages.graph_id. Not in db.js's boot path for the same reason as
-- create_conversation_index.sql (15s statement_timeout on every pooled
-- connection; a build over `messages` won't finish inside it). db.js
-- warnIfIndexMissing() reports its state on boot.
--
-- Partial on purpose: graph_id is NULL for every row stored before graph ids
-- existed and for every IMAP row, and the lookup never matches NULL. The index
-- grows only as walks store ids.

-- Run as `psql -f`: stop at the first error until the build.
\set ON_ERROR_STOP on

-- The app pushes search_path per pooled connection; a psql session does not.
SET search_path TO missive, public;

-- ⚠️ SESSION-mode connection only (Supabase direct 5432, or the session pooler
-- on 5432) — not the transaction pooler on 6543 and not the SQL editor. CREATE
-- INDEX CONCURRENTLY cannot run inside a transaction block. psql autocommits by
-- default; don't wrap this in BEGIN/COMMIT.
--
-- No timeouts: CREATE INDEX CONCURRENTLY waits for every older transaction at
-- each phase, and a finite lock_timeout turns that wait into a 55P03 after the
-- full scan, leaving an INVALID index. Clear long transactions first instead.
SET statement_timeout = 0;
SET lock_timeout = 0;

-- Pre-check: sessions the build will wait on. End an 'idle in transaction' one
-- (pg_terminate_backend) or let it finish.
SELECT pid, state, now() - xact_start AS xact_age, left(query, 80) AS query
  FROM pg_stat_activity
 WHERE xact_start < now() - interval '30 seconds'
   AND pid <> pg_backend_pid()
 ORDER BY xact_start;

\set ON_ERROR_STOP off


-- -----------------------------------------------------------------------------
-- 1. BUILD
-- -----------------------------------------------------------------------------
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_graph_id
  ON messages (account_id, graph_id)
  WHERE graph_id IS NOT NULL;


-- -----------------------------------------------------------------------------
-- 2. VERIFY — always. Do not trust the absence of an error.
-- -----------------------------------------------------------------------------
-- A failed CONCURRENTLY build leaves an INVALID index that the planner ignores
-- and IF NOT EXISTS matches forever. Expect one row, indisvalid = true.
SELECT c.relname, i.indisvalid, i.indisready
  FROM pg_class c
  JOIN pg_index i ON i.indexrelid = c.oid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'missive' AND c.relname = 'idx_messages_graph_id';

-- indisvalid = false (or no row) → drop it and run this script again:
--   DROP INDEX CONCURRENTLY IF EXISTS missive.idx_messages_graph_id;
