-- Backfill threads.last_inbound_at from each thread's messages.
--
-- WHAT IT IS: the sent_at (BIGINT epoch-ms, like every timestamp here) of the
-- newest INBOUND message in the thread that is not in a junk/spam folder and not
-- From the mailbox's own address. It is a high-water mark: ingest only ever
-- raises it (email/imap.js), and it is not lowered when mail is later junked or
-- removed. DD's assistant compares it with the newest outbound mail to tell
-- "answered" from "waiting on us" — so the owner's own copies that reach his
-- Inbox (CC-self or BCC-self on his reply, a list he is on, a delegate sending
-- as him) must not count: each arrives just after his own outbound copy.
--
-- WHY A SCRIPT: boot adds the column (db.js CL1_COLUMN_GROUPS) but never fills
-- it — a backfill over ~37k threads and ~100k messages would blow the 15s
-- statement_timeout every pooled connection carries, and boot-time backfills
-- re-run on every deploy. New mail keeps it current from the deploy on; this
-- fills in the history. Until it runs, the column is NULL on older threads.
--
-- The junk test is ingest's (and the webhook suppression's) own:
--   JS:  /spam|junk/i.test(folder || '')      SQL: COALESCE(folder, '') ~* '(spam|junk)'
-- so a NULL folder counts as not junk, in both. So is the own-mail test: ingest
-- compares the parsed From address with the account's email, case-insensitive;
-- here that address is the first <...> in from_addr (ingest stores
-- "Name <address>"), or the whole from_addr when it has none. A message whose
-- account is gone (account_id NULL) counts as not own mail.
--
-- RUN IT AFTER THE DEPLOY HAS FULLY FINISHED. During a rolling deploy the old
-- instance keeps ingesting without maintaining this column; a thread it touched
-- after this ran would stay behind until its next inbound message.
--
-- SAFE TO RE-RUN, and safe alongside live ingest: it only ever RAISES the value
-- (rows already at or above their newest inbound message are skipped), so it
-- can't undo a bump ingest made after this script's snapshot. Read-only on
-- `messages`.
--
-- CONNECTION. psql over a SESSION-mode connection (Supabase direct 5432 or the
-- session pooler on 5432) — NOT the transaction pooler on 6543 and NOT the SQL
-- editor: §2 commits inside a DO block, which the editor's transaction wrapper
-- can't do, and the editor swallows the RAISE NOTICE progress lines.
--
-- Run:  psql "<session-mode url>" -f backend/scripts/backfill_last_inbound_at.sql

-- The app pushes search_path per pooled connection; a psql session does not.
SET search_path TO missive, public;

-- The app's pool caps statements at 15s; that belongs to the app, not to you.
-- §1 aggregates every inbound message once.
SET statement_timeout = '10min';


-- =============================================================================
-- 1. PREVIEW — read-only. Record the numbers before §2.
-- =============================================================================

-- 1a. Threads, and how many have no value yet.
SELECT count(*)                                   AS threads,
       count(*) FILTER (WHERE last_inbound_at IS NULL) AS threads_without_value
  FROM threads;

-- 1b. Threads §2 would change (no value yet, or below their newest inbound
-- non-junk message from someone else). Threads with no such message are never
-- touched and stay NULL — outbound-only, junk-only and own-mail-only threads.
SELECT count(*) AS threads_to_raise
  FROM threads t
  JOIN (SELECT m.thread_id, max(m.sent_at) AS mx
          FROM messages m
          LEFT JOIN email_accounts a ON a.id = m.account_id
         WHERE m.direction = 'inbound' AND COALESCE(m.folder, '') !~* '(spam|junk)'
           AND lower(btrim(COALESCE(substring(m.from_addr from '<([^<>]+)>'), m.from_addr, '')))
               IS DISTINCT FROM lower(a.email)
         GROUP BY m.thread_id) s ON s.thread_id = t.id
 WHERE t.last_inbound_at IS NULL OR t.last_inbound_at < s.mx;


-- =============================================================================
-- 2. APPLY — batched by thread id (keyset), COMMIT per batch.
-- =============================================================================
-- 1,000 threads a batch, a short pause between batches so ingest and DD reads
-- keep their share of the instance. The whole DO block is ONE statement to
-- Postgres, so statement_timeout is lifted for it; lock_timeout is not: a batch
-- stuck behind a lock fails after 5s (that batch rolls back, earlier ones stay
-- committed) instead of queueing writers behind it. Just run the script again —
-- every batch re-checks, so finished threads are skipped.
SET statement_timeout = 0;
SET lock_timeout = '5s';

DO $$
DECLARE
  v_after   text := '';
  v_ids     text[];
  v_n       bigint;
  v_total   bigint := 0;
  v_batches int := 0;
BEGIN
  LOOP
    SELECT array_agg(id ORDER BY id) INTO v_ids
      FROM (SELECT id FROM threads WHERE id > v_after ORDER BY id LIMIT 1000) b;
    EXIT WHEN v_ids IS NULL;

    UPDATE threads t
       SET last_inbound_at = s.mx
      FROM (SELECT m.thread_id, max(m.sent_at) AS mx
              FROM messages m
              LEFT JOIN email_accounts a ON a.id = m.account_id
             WHERE m.thread_id = ANY(v_ids)
               AND m.direction = 'inbound'
               AND COALESCE(m.folder, '') !~* '(spam|junk)'
               AND lower(btrim(COALESCE(substring(m.from_addr from '<([^<>]+)>'), m.from_addr, '')))
                   IS DISTINCT FROM lower(a.email)
             GROUP BY m.thread_id) s
     WHERE t.id = s.thread_id
       AND (t.last_inbound_at IS NULL OR t.last_inbound_at < s.mx);
    GET DIAGNOSTICS v_n = ROW_COUNT;

    v_total := v_total + v_n;
    v_batches := v_batches + 1;
    v_after := v_ids[array_length(v_ids, 1)];
    RAISE NOTICE 'batch %: % thread(s) raised (through id %)', v_batches, v_n, v_after;
    COMMIT;
    PERFORM pg_sleep(0.2);
  END LOOP;
  RAISE NOTICE 'done: % thread(s) raised in % batch(es)', v_total, v_batches;
END $$;

-- Back to the header's values, explicitly. RESET would fall to the role or
-- connection default, which nobody here chose.
SET statement_timeout = '10min';
SET lock_timeout = 0;


-- =============================================================================
-- 3. VERIFY — as a result grid, not a NOTICE.
-- =============================================================================
-- Expect threads_still_below = 0. Anything else is a thread a batch skipped
-- (lock timeout) or one that took new mail mid-run — run §2 again.
SELECT count(*) AS threads_still_below
  FROM threads t
  JOIN (SELECT m.thread_id, max(m.sent_at) AS mx
          FROM messages m
          LEFT JOIN email_accounts a ON a.id = m.account_id
         WHERE m.direction = 'inbound' AND COALESCE(m.folder, '') !~* '(spam|junk)'
           AND lower(btrim(COALESCE(substring(m.from_addr from '<([^<>]+)>'), m.from_addr, '')))
               IS DISTINCT FROM lower(a.email)
         GROUP BY m.thread_id) s ON s.thread_id = t.id
 WHERE t.last_inbound_at IS NULL OR t.last_inbound_at < s.mx;
