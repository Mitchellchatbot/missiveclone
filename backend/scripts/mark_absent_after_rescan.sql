-- Mark one Microsoft account's rows that a FRESH rescan proved are no longer in
-- any folder this clone syncs.
--
-- WHY: a delta walk reports removals only for changes after its cursor, and the
-- clone skipped @removed entirely before graph ids existed. So every message
-- archived or deleted out of a synced folder before that still sits in
-- `messages` as live mail (folder 'INBOX', removed_at NULL) — and with no
-- graph_id, no later @removed can ever match it. A fresh rescan
-- (POST /api/accounts/:id/rescan {"fresh": true}) re-delivers everything still
-- present and stamps it with a graph_id; it cannot report what is gone. What it
-- leaves behind is exactly the set this script marks: rows of this account, in a
-- synced folder's label, stored before the rescan began, still without a
-- graph_id.
--
-- The mark is removed_at = <now>, removed_reason = 'absent_after_rescan' — the
-- same columns @removed sets, meaning "left the folders this clone syncs".
-- Nothing is deleted. A later re-delivery of a wrongly marked message clears its
-- mark automatically, and §4 below reverts the whole run.
--
-- ORDER (see the CL1 notes in the PR):
--   1. #54's dedupe_messages.sql (+ create_unique_message_index.sql) FIRST. With
--      legacy duplicates present the rescan stamps only one copy of each, and
--      the dedupe may later keep a different one.
--      If that script's §4 (snapshot) ever ran BEFORE this deploy, its whole-row
--      backup tables lack the columns this deploy added: the next §4 then fails
--      with "INSERT has more expressions than target columns", and §5 refuses
--      every batch with "loser missing from dedup_bak_messages_20260922 — re-run
--      §4", which can never succeed. Run this once first (psql; harmless when
--      the tables don't exist, safe to re-run). The columns go in the order the
--      app adds them, so §4's positional m.* / t.* lines up again — the final
--      SELECT must answer t | t (NULL: that backup table doesn't exist):
--
--        ALTER TABLE IF EXISTS missive.dedup_bak_messages_20260922
--          ADD COLUMN IF NOT EXISTS graph_id TEXT,
--          ADD COLUMN IF NOT EXISTS web_link TEXT,
--          ADD COLUMN IF NOT EXISTS is_read BOOLEAN,
--          ADD COLUMN IF NOT EXISTS importance TEXT,
--          ADD COLUMN IF NOT EXISTS flag_status TEXT,
--          ADD COLUMN IF NOT EXISTS categories TEXT[],
--          ADD COLUMN IF NOT EXISTS parent_folder_id TEXT,
--          ADD COLUMN IF NOT EXISTS inference_classification TEXT,
--          ADD COLUMN IF NOT EXISTS change_key TEXT,
--          ADD COLUMN IF NOT EXISTS removed_at BIGINT,
--          ADD COLUMN IF NOT EXISTS removed_reason TEXT,
--          ADD COLUMN IF NOT EXISTS signals_updated_at BIGINT;
--        ALTER TABLE IF EXISTS missive.dedup_bak_threads_20260922
--          ADD COLUMN IF NOT EXISTS last_inbound_at BIGINT;
--        SELECT (SELECT array_agg(column_name::text ORDER BY ordinal_position) FROM information_schema.columns
--                 WHERE table_schema = 'missive' AND table_name = 'messages')
--             = (SELECT array_agg(column_name::text ORDER BY ordinal_position) FROM information_schema.columns
--                 WHERE table_schema = 'missive' AND table_name = 'dedup_bak_messages_20260922') AS messages_line_up,
--               (SELECT array_agg(column_name::text ORDER BY ordinal_position) FROM information_schema.columns
--                 WHERE table_schema = 'missive' AND table_name = 'threads')
--             = (SELECT array_agg(column_name::text ORDER BY ordinal_position) FROM information_schema.columns
--                 WHERE table_schema = 'missive' AND table_name = 'dedup_bak_threads_20260922') AS threads_line_up;
--
--   2. §0 below — sizing, before the rescan.
--   3. POST /api/accounts/<id>/rescan {"fresh": true}, then find this line in the
--      Railway logs:
--        [sync] cleared the cursors of account <id> for a fresh walk (rescan_started_ms=<ms>)
--      That <ms> is rescan_started_ms below — not the time of the POST. A rescan
--      requested while a walk of the account is running starts only when that
--      walk ends, and until then the account's cursors are still the finished
--      ones of the walk before, which pass the §1 gate. Run nothing below §0
--      before the line is there.
--      It ANNOUNCES mail. The walk stores again every message dedup can't match
--      — mail without a Message-ID (§0b sizes it) and mail purge-by-sender
--      deleted that is still in the mailbox (no query can size that) — and
--      announces each as new mail however old: a socket message:new, plus a DD
--      webhook when it is inbound and not junk (DD intake and notifications).
--      Only extra-folder walks keep old mail quiet. If §0b's dd_webhooks is big,
--      or a large purge-by-sender is known, warn the DD team first (a 340-webhook
--      catch-up once pushed DD into Supabase Auth 429s).
--   4. Wait until EVERY folder of the account finished its fresh walk: the §1
--      gate checks the cursors. Then search the Railway logs for this mailbox,
--      from the moment the rescan began, for these lines:
--        "[graph] ingest failed"               the walk skipped a message
--        "ABORTING walk"                       the walk stopped (it retries)
--        "[ingest] re-delivery update failed"  a present message left unstamped
--        "already stored as a conflicting row" a present message left unstamped
--      Each can mean a message still in the mailbox whose row kept graph_id NULL
--      — which §3 would mark absent. The last two reach no last_sync_error, so
--      the gate can't see them. If any of them appears, run the fresh rescan
--      again (step 3, which gives a new rescan_started_ms) and wait for a run
--      without them before §1.
--   5. §1 + §2 (gate, preview), then — after reading the preview — §3.
--   6. Only now configure extra folders (PATCH /api/accounts/<id>/sync-folders).
--      An extra folder's walk takes over a row only when no built-in folder holds
--      it, or when the row carries the very Graph item it finds (a move keeps
--      its immutable id). Mail filed into that folder before graph ids existed
--      has neither: its row still looks like live INBOX mail (graph_id NULL)
--      until this script marks it. Configured before §3, those rows stay stale
--      INBOX rows — and §3 then marks them absent although the folder holds them.
--      So the §1 gate refuses an account that has extra folders configured. If
--      this one already has some, either
--        a. remove them (PATCH sync-folders {"folders": []}), start again from
--           step 3, and configure them again after §3; or
--        b. set allow_extra_folders to 1 below, run §1-§3, then run the fresh
--           rescan once more (POST .../rescan {"fresh": true}): the extra
--           folder's walk takes over every row §3 marked whose mail it holds (a
--           row marked removed is any walk's to take), puts it under the
--           folder's label and clears the mark.
--
-- CONNECTION. psql over a SESSION-mode connection (Supabase direct 5432 or the
-- session pooler on 5432) — NOT the transaction pooler on 6543 and NOT the SQL
-- editor: §3 commits inside a DO block, and the gate reports through RAISE.

\set ON_ERROR_STOP on

-- ========================= SET THESE, THEN RUN =========================
-- The account's id (email_accounts.id), and rescan_started_ms: the <ms> the
-- fresh rescan logged when it cleared the cursors (ORDER 3), epoch
-- milliseconds. Rows ingested after that are never touched.
-- allow_extra_folders: leave it 0 unless you have read ORDER 6.
\set account_id 'REPLACE-WITH-ACCOUNT-ID'
\set rescan_started_ms 0
\set allow_extra_folders 0
-- =======================================================================

-- The app pushes search_path per pooled connection; a psql session does not.
SET search_path TO missive, public;
SET statement_timeout = '10min';


-- =============================================================================
-- 0. SIZING — read-only. Run BEFORE the rescan (only account_id needed).
-- =============================================================================
-- What the fresh walk will re-deliver, and what it will duplicate: rows without
-- a Message-ID have no dedup identity, so every re-walk stores them again.

-- 0a. Rows per folder, and how many already carry a graph id.
SELECT folder, direction, count(*) AS rows,
       count(*) FILTER (WHERE graph_id IS NOT NULL)  AS with_graph_id,
       count(*) FILTER (WHERE removed_at IS NOT NULL) AS marked_removed
  FROM messages
 WHERE account_id = :'account_id'
 GROUP BY folder, direction
 ORDER BY rows DESC;

-- 0b. Rows the rescan will store a second time (no Message-ID), and what that
-- announces (see ORDER 3): every one the built-in walks find again gets a socket
-- message:new (socket_announcements), and the inbound INBOX ones a DD webhook as
-- well (dd_webhooks). Upper bounds — only mail still in the mailbox comes back;
-- extra folders store old mail quietly. Purged mail still in the mailbox comes
-- on top and can't be counted here.
SELECT count(*) AS rows_without_message_id,
       count(*) FILTER (WHERE folder IN ('INBOX', 'Sent Items', 'Junk Email')) AS socket_announcements,
       count(*) FILTER (WHERE folder = 'INBOX' AND direction = 'inbound') AS dd_webhooks
  FROM messages
 WHERE account_id = :'account_id' AND NULLIF(message_id, '') IS NULL;

-- 0c. Legacy duplicate groups in this account. Expect 0 — otherwise run #54's
-- dedupe first (see ORDER above).
SELECT count(*) AS duplicate_groups
  FROM (SELECT 1 FROM messages
         WHERE account_id = :'account_id' AND NULLIF(message_id, '') IS NOT NULL
         GROUP BY direction, message_id HAVING count(*) > 1) g;


-- =============================================================================
-- 1. PARAMETERS + GATE — after the rescan finished. Read-only.
-- =============================================================================
-- The gate sees the cursors, last_sync_error and the extra-folder config only.
-- A message the walk found but couldn't stamp ("[ingest] re-delivery update
-- failed", "already stored as a conflicting row") leaves none of them behind: do
-- ORDER 4's log check first. Nor can it tell whose walk wrote the cursors: take
-- rescan_started_ms from the log line ORDER 3 names, never from the POST.
--
-- The labels a walk of this account writes: the built-ins, 'Sent' (DD's own
-- sends — their Sent Items copy stamps them during the rescan), and the
-- account's configured extra folders. Rows under any other label (a removed
-- extra folder, IMAP-era paths) are left alone; §2 shows them.
DROP TABLE IF EXISTS pg_temp.absent_params;
CREATE TEMP TABLE absent_params AS
  SELECT a.id AS account_id,
         :'rescan_started_ms'::bigint AS started_ms,
         :'allow_extra_folders'::boolean AS allow_extra_folders,
         jsonb_array_length(a.extra_sync_folders) AS extra_folders,
         ARRAY['INBOX', 'Sent Items', 'Junk Email', 'Sent']::text[]
           || COALESCE((SELECT array_agg(e->>'label')
                          FROM jsonb_array_elements(a.extra_sync_folders) e), '{}'::text[]) AS labels
    FROM email_accounts a
   WHERE a.id = :'account_id';

DO $$
DECLARE
  p record;
  acc record;
  v_key text;
BEGIN
  SELECT * INTO p FROM absent_params;
  IF NOT FOUND THEN RAISE EXCEPTION 'gate: account not found - set account_id'; END IF;
  IF p.started_ms <= 0 THEN RAISE EXCEPTION 'gate: set rescan_started_ms'; END IF;
  IF p.started_ms > (extract(epoch from now()) * 1000)::bigint THEN
    RAISE EXCEPTION 'gate: rescan_started_ms is in the future';
  END IF;
  SELECT email, provider, last_sync_error INTO acc FROM email_accounts WHERE id = p.account_id;
  IF acc.provider IS DISTINCT FROM 'microsoft' THEN
    RAISE EXCEPTION 'gate: % is not a Microsoft account', acc.email;
  END IF;
  IF acc.last_sync_error IS NOT NULL THEN
    RAISE EXCEPTION 'gate: % has a sync error recorded (%) - wait for a clean pass', acc.email, left(acc.last_sync_error, 200);
  END IF;
  -- ORDER 6: with extra folders configured, mail filed into one of them before
  -- graph ids existed is still an unstamped INBOX row here, and would be marked.
  IF p.extra_folders > 0 AND NOT p.allow_extra_folders THEN
    RAISE EXCEPTION 'gate: % has % extra folder(s) configured - see ORDER 6 in the header (remove them first, or set allow_extra_folders 1 and run the fresh rescan again after section 3)', acc.email, p.extra_folders;
  END IF;
  -- Each built-in folder must hold a finished cursor from a walk that asked for
  -- immutable ids: a real deltaLink (not a resume checkpoint, not cleared).
  -- clearCursors resets id_type, so 'immutable' here means a fresh walk wrote it.
  IF (SELECT count(*) FROM folder_sync_state f
       WHERE f.account_id = p.account_id
         AND f.folder IN ('inbox', 'sentitems', 'junkemail')
         AND f.id_type = 'immutable'
         AND f.delta_link ~* '[?&][$]?deltatoken=') <> 3 THEN
    RAISE EXCEPTION 'gate: inbox / sentitems / junkemail have not all finished a fresh walk yet - wait and re-run';
  END IF;
  -- Same for every CONFIGURED extra folder (key 'x:<id>|<label>', see
  -- util/extra_folders.js): a finished deltaLink, not a checkpoint, not cleared,
  -- not missing. Cursor rows of folders no longer configured don't count: a walk
  -- in flight when its folder was removed or relabelled re-saves the old key
  -- afterwards, nothing ever walks it again, and a checkpoint there would hold
  -- this gate shut forever. (Re-sending the account's current sync-folders
  -- config deletes such rows.)
  SELECT k.key INTO v_key
    FROM (SELECT 'x:' || (e->>'id') || '|' || (e->>'label') AS key
            FROM email_accounts a, jsonb_array_elements(a.extra_sync_folders) e
           WHERE a.id = p.account_id) k
    LEFT JOIN folder_sync_state f ON f.account_id = p.account_id AND f.folder = k.key
   WHERE f.delta_link IS NULL OR f.delta_link !~* '[?&][$]?deltatoken='
   LIMIT 1;
  IF v_key IS NOT NULL THEN
    RAISE EXCEPTION 'gate: extra folder % has not finished its walk yet - wait and re-run', v_key;
  END IF;
  RAISE NOTICE 'gate: % passed', acc.email;
END $$;

\set ON_ERROR_STOP off


-- =============================================================================
-- 2. PREVIEW — read-only. What §3 would mark, by folder.
-- =============================================================================
-- A row is skipped when another row with its Message-ID (same account and
-- direction) carries a graph id: the message is present, the rescan just stamped
-- a duplicate copy.
SELECT m.folder,
       m.folder = ANY(p.labels) AS will_mark,
       count(*) AS rows
  FROM messages m
  JOIN absent_params p ON p.account_id = m.account_id
 WHERE m.graph_id IS NULL
   AND m.removed_at IS NULL
   AND m.created_at < p.started_ms
   AND (NULLIF(m.message_id, '') IS NULL
        OR NOT EXISTS (SELECT 1 FROM messages s
                        WHERE s.account_id = m.account_id AND s.direction = m.direction
                          AND s.message_id = m.message_id AND s.graph_id IS NOT NULL))
 GROUP BY 1, 2
 ORDER BY 2 DESC, 3 DESC;


-- =============================================================================
-- 3. APPLY — batched, COMMIT per batch. Uncomment after reading §2.
-- =============================================================================
-- SET statement_timeout = 0;
-- SET lock_timeout = '5s';
--
-- DO $$
-- DECLARE
--   p         record;
--   v_now     bigint;
--   v_n       bigint;
--   v_total   bigint := 0;
--   v_batches int := 0;
-- BEGIN
--   SELECT * INTO p FROM absent_params;
--   LOOP
--     v_now := (extract(epoch from clock_timestamp()) * 1000)::bigint;
--     WITH c AS (
--       SELECT m.id
--         FROM messages m
--        WHERE m.account_id = p.account_id
--          AND m.graph_id IS NULL
--          AND m.removed_at IS NULL
--          AND m.created_at < p.started_ms
--          AND m.folder = ANY(p.labels)
--          AND (NULLIF(m.message_id, '') IS NULL
--               OR NOT EXISTS (SELECT 1 FROM messages s
--                               WHERE s.account_id = m.account_id AND s.direction = m.direction
--                                 AND s.message_id = m.message_id AND s.graph_id IS NOT NULL))
--        LIMIT 1000
--     )
--     UPDATE messages m
--        SET removed_at = v_now, removed_reason = 'absent_after_rescan', signals_updated_at = v_now
--       FROM c
--      WHERE m.id = c.id AND m.graph_id IS NULL AND m.removed_at IS NULL;
--     GET DIAGNOSTICS v_n = ROW_COUNT;
--     EXIT WHEN v_n = 0;
--     v_total := v_total + v_n;
--     v_batches := v_batches + 1;
--     RAISE NOTICE 'batch %: % row(s) marked', v_batches, v_n;
--     COMMIT;
--     PERFORM pg_sleep(0.2);
--   END LOOP;
--   RAISE NOTICE 'done: % row(s) marked in % batch(es)', v_total, v_batches;
-- END $$;
--
-- SET statement_timeout = '10min';
-- SET lock_timeout = 0;
--
-- Check (a result grid):
--   SELECT folder, count(*) FROM messages
--    WHERE account_id = (SELECT account_id FROM absent_params)
--      AND removed_reason = 'absent_after_rescan'
--    GROUP BY 1 ORDER BY 2 DESC;


-- =============================================================================
-- 4. REVERT — the whole run. Only rows this script marked carry its reason.
-- =============================================================================
-- UPDATE messages
--    SET removed_at = NULL, removed_reason = NULL,
--        signals_updated_at = (extract(epoch from clock_timestamp()) * 1000)::bigint
--  WHERE account_id = :'account_id' AND removed_reason = 'absent_after_rescan';
