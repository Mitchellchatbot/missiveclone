-- Unique index that makes the database refuse duplicate message rows.
--
-- Run this ONCE, by hand, against the production database — AFTER
-- dedupe_messages.sql has cleaned up the existing duplicates. It is deliberately
-- not in db.js's MIGRATIONS array, for the same reason as
-- create_conversation_index.sql: every pooled connection carries
-- `SET statement_timeout = '15s'`, a build over `messages` (bodies inline) will
-- not finish inside that, and init() would swallow the cancellation as a
-- one-line warning on every deploy while the index never existed.
-- warnIfUniqueMsgIndexMissing() in db.js reports its state on boot instead.
--
-- The app does not depend on this index to behave correctly: ingest serializes
-- on an advisory lock and every writer uses a bare ON CONFLICT DO NOTHING, which
-- works the same with the index present, missing or INVALID. The index is the
-- backstop for whatever the lock doesn't cover (an old instance during a deploy
-- overlap, a future writer that forgets the lock).
--
-- No unique index on attachments: a real message can carry the same file twice,
-- and any (message_id, filename, size, content_id) key would refuse it.
--
-- ROLLING BACK THE DEDUPE later (dedupe_messages.sql §8) needs this index
-- DROPPED first: every restored loser is a duplicate of its keeper, so the
-- restore hits 23505 here and aborts. It can be rebuilt only after re-cleaning.

-- Run as `psql -f`: stop at the first error, so a failed gate (below) never
-- reaches the CREATE. Switched off again after the gate so §3's verify still
-- runs when the build itself fails.
\set ON_ERROR_STOP on

-- The app pushes search_path per pooled connection; a psql session does not.
SET search_path TO missive, public;

-- No timeouts for this session. lock_timeout in particular must be 0: CREATE
-- INDEX CONCURRENTLY does not only take a brief lock at the start and end, it
-- also WAITS for every transaction older than each of its phases (after the
-- catalog entry, after the scan, before marking valid), and those waits count
-- against lock_timeout. A
-- finite value turns one long ingest transaction, report or pg_dump into a
-- 55P03 AFTER the full scan, leaving an INVALID index to drop and rebuild.
-- Clear the long transactions first instead (the pre-check below).
--
-- ⚠️ This must be a SESSION-mode connection (Supabase direct 5432, or the
-- session pooler on 5432) — not the transaction pooler on 6543 and not the SQL
-- editor. CREATE INDEX CONCURRENTLY cannot run inside a transaction block, and a
-- transaction pooler can hand the SETs and the CREATE to different backends.
-- psql runs statements in autocommit by default, so just don't wrap this in
-- BEGIN/COMMIT.
SET statement_timeout = 0;
SET lock_timeout = 0;

-- Pre-check: sessions the build will wait on. With no lock_timeout it simply
-- waits for them — but an 'idle in transaction' session can hold it
-- indefinitely. If one shows up here, end it (pg_terminate_backend) or let it
-- finish; the build proceeds on its own once it is gone.
SELECT pid, state, now() - xact_start AS xact_age, left(query, 80) AS query
  FROM pg_stat_activity
 WHERE xact_start < now() - interval '30 seconds'
   AND pid <> pg_backend_pid()
 ORDER BY xact_start;


-- -----------------------------------------------------------------------------
-- 1. GATE — re-run dedupe_messages.sql §1a IMMEDIATELY before building.
-- -----------------------------------------------------------------------------
-- It must return 0 groups. A duplicate can reappear between cleanup and now (an
-- old instance during a deploy overlap, a mailbox reconnect relinking orphans),
-- and a single one makes the concurrent build fail at the very end and leave an
-- INVALID index behind. The DO block RAISEs on a non-zero count, and with
-- ON_ERROR_STOP that ends the script before the CREATE — a comment saying
-- "stop" cannot stop a script run as a file.
--
-- Non-zero? Those are either groups dedupe_messages.sql §2 excluded
-- ('recent', 'content-mismatch', 'compose-row') or new ones. Every one of them
-- has to be resolved — excluded or not, the index will refuse to build over it.
-- For a second dedupe pass: run dedupe_messages.sql §6 first (the previous
-- pass's emptied threads), then re-run §2 (plan), §4 (append-only — never drop
-- a backup table), §5 and §6 (a 'recent' group clears after an hour), and
-- decide the others by hand.
DO $$
DECLARE
  n_groups BIGINT;
  n_extra  BIGINT;
BEGIN
  SELECT count(*), coalesce(sum(n - 1), 0) INTO n_groups, n_extra
    FROM (SELECT account_id, direction, message_id, count(*) AS n
            FROM messages
           WHERE NULLIF(message_id, '') IS NOT NULL AND account_id IS NOT NULL
           GROUP BY account_id, direction, message_id
          HAVING count(*) > 1) g;
  IF n_groups > 0 THEN
    RAISE EXCEPTION 'gate: % duplicate group(s), % extra row(s) remain - not building', n_groups, n_extra;
  END IF;
  RAISE NOTICE 'gate: 0 duplicate groups - building';
END $$;

-- Past the gate. Let a failed build fall through to the verify below.
\set ON_ERROR_STOP off


-- -----------------------------------------------------------------------------
-- 2. BUILD
-- -----------------------------------------------------------------------------
-- The predicate matches the dedupe key exactly. `message_id <> ''` is load-
-- bearing: send paths used to store '' when the transport returned no id, and
-- without it every such row in a mailbox would collide with the next — and a
-- writer's bare ON CONFLICT DO NOTHING would then silently drop a real sent row.
-- A NULL account_id (orphan from a disconnected mailbox) never conflicts, since
-- NULLs are distinct in a unique index.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_messages_acct_dir_msgid
  ON messages (account_id, direction, message_id)
  WHERE message_id IS NOT NULL AND message_id <> '';


-- -----------------------------------------------------------------------------
-- 3. VERIFY — always. Do not trust the absence of an error.
-- -----------------------------------------------------------------------------
-- A cancelled or failed CONCURRENTLY build leaves an INVALID index behind. The
-- planner ignores it, yet it still costs every write and enforces uniqueness only
-- partially — and `IF NOT EXISTS` matches its name forever after, so a retry
-- silently does nothing.
SELECT c.relname, i.indisvalid, i.indisready
  FROM pg_class c
  JOIN pg_index i ON i.indexrelid = c.oid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'missive' AND c.relname = 'uq_messages_acct_dir_msgid';

-- indisvalid = false → never leave it in place. Drop it (also CONCURRENTLY, and
-- also outside a transaction):
--   DROP INDEX CONCURRENTLY IF EXISTS missive.uq_messages_acct_dir_msgid;
-- then find what got in (§1 above, and dedupe_messages.sql §1b for the day it
-- was created), clean it with dedupe_messages.sql, re-run the gate, and build
-- again.
--
-- indisvalid = true → done. On the next deploy the
-- "[db] uq_messages_acct_dir_msgid is MISSING / INVALID" boot warning is gone.
-- From here on, watch the logs for 23505 on messages: with the index in place
-- the writers' bare ON CONFLICT should absorb every conflict, so a 23505 means a
-- writer that doesn't use it.
