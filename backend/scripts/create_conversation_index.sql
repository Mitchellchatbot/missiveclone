-- Index backing findOrCreateThread's provider-conversation-id lookup.
--
-- Run this ONCE, by hand, against the production database — it is deliberately
-- not in db.js's MIGRATIONS array. Every connection from the app's pool gets
-- `SET statement_timeout = '15s'`, and a btree build over `messages` (which
-- stores body_text/body_html inline) will not finish in 15 seconds. Left in the
-- boot path it would be cancelled every deploy, swallowed by init()'s catch as
-- a single "migration warning:" line, and never actually exist — the worst kind
-- of failure, because everything appears to work while every lookup does a
-- sequential scan.
--
-- Prerequisite: the column, which IS created on boot.
--     ALTER TABLE messages ADD COLUMN IF NOT EXISTS provider_conversation_id TEXT;

-- Partial on purpose. The column is NULL for every message ingested before this
-- shipped and for everything on the IMAP path (only Microsoft Graph supplies a
-- conversation id), and the lookup always filters
-- `provider_conversation_id = $3`, which never matches NULL. A partial index is
-- therefore a fraction of the size and skips the dead rows entirely.
--
-- CONCURRENTLY so the build doesn't take a lock that blocks ingest. It cannot
-- run inside a transaction block — psql runs statements in autocommit by
-- default, so just don't wrap this in BEGIN/COMMIT.
--
-- Raise the timeout for this session only; the 15s default belongs to the app's
-- pool, not to you.
SET statement_timeout = '30min';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_conversation
  ON messages (workspace_id, account_id, provider_conversation_id)
  WHERE provider_conversation_id IS NOT NULL;

-- VERIFY. A cancelled or failed CONCURRENTLY build leaves an INVALID index
-- behind, which the planner ignores while `IF NOT EXISTS` happily matches its
-- name forever after — so a retry silently does nothing. Always check:
--
--   SELECT c.relname, i.indisvalid, i.indisready
--     FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
--    WHERE c.relname = 'idx_messages_conversation';
--
-- If indisvalid is false, drop it and rebuild:
--   DROP INDEX CONCURRENTLY idx_messages_conversation;
