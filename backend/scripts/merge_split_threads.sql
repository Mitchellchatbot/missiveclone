-- Merge conversations that were split into two or more threads.
--
-- WHY: findOrCreateThread's subject fallback used to require an existing
-- message *from the same sender* in the same mailbox. Our own outbound copy of
-- a reply — arriving with no usable In-Reply-To — therefore never matched the
-- customer's thread and started a second one holding only sent mail. That
-- second thread has no message with folder='INBOX', so DelegationDoer's Inbox
-- view can't show it at all: users had to go to Sent to find half of their own
-- conversation. The ingest fix stops NEW splits; this repairs existing ones.
--
--
-- ============================ READ THIS FIRST ============================
--
-- This script has NEVER BEEN EXECUTED. It was written without access to a
-- Postgres instance, so every claim below is reasoned, not observed. Run
-- section 1 and read its output before you even consider section 3.
--
-- Run order, and none of it is optional:
--   1. SETUP      — creates two read-only views. Writes nothing.
--   2. DRY RUN    — reports what would merge and what would be destroyed.
--   3. APPLY      — one transaction, logs the full mapping before it moves
--                   anything, and re-parents everything that would otherwise
--                   be cascade-deleted.
--   4. ROLLBACK   — undoes section 3. Read its caveats; it is not perfect.
--
-- THE PAIRING RULE. Two threads merge when they are in the same workspace, have
-- the same cleaned subject, share a mailbox, AND share a correspondent who is
-- not one of our own mailboxes. That last clause is the whole safety story:
-- without it the rule collapses to "merge every thread in this mailbox with the
-- same subject", because every message in a mailbox mentions that mailbox's own
-- address — that is what puts it there. Threads that merely share a subject
-- (the "Email Account Activity" notifications that once collapsed into a
-- 160-message mega-thread) must NOT match, and they don't, because they have no
-- correspondent in common once our own addresses are excluded.
--
-- A merge is also refused when the two threads' newest messages are more than
-- 180 days apart, so a 2023 "Invoice" thread can't swallow a 2026 one.


-- =============================================================================
-- 1. SETUP — read-only views. Writes nothing.
-- =============================================================================
DROP VIEW IF EXISTS v_thread_merge_plan CASCADE;
DROP VIEW IF EXISTS v_thread_identity CASCADE;

CREATE VIEW v_thread_identity AS
SELECT
  t.id                AS thread_id,
  t.workspace_id,
  t.last_message_at,
  t.status,
  -- Same normalization findOrCreateThread applies before matching.
  btrim(regexp_replace(coalesce(t.subject, ''), '^(re|fwd|fw)\s*:\s*', '', 'i')) AS clean_subject,
  array_agg(DISTINCT m.account_id) FILTER (WHERE m.account_id IS NOT NULL) AS account_ids,
  -- Correspondents: every address on the thread's messages EXCEPT the addresses
  -- of mailboxes we have connected. See the pairing-rule note above — without
  -- this exclusion the overlap test below is trivially true for any two threads
  -- in the same mailbox and the whole guard evaporates.
  array_agg(DISTINCT addr.hit[1]) FILTER (
    WHERE addr.hit IS NOT NULL
      AND addr.hit[1] NOT IN (SELECT lower(email) FROM email_accounts WHERE email IS NOT NULL)
  ) AS correspondents,
  count(DISTINCT m.id)                                   AS message_count,
  count(DISTINCT m.id) FILTER (WHERE m.folder = 'INBOX') AS inbox_count
FROM threads t
JOIN messages m ON m.thread_id = t.id
-- LEFT, so a message with no parseable address still counts toward the totals.
-- `regexp_matches(...) AS addr(m)` in FROM, NOT `SELECT unnest(regexp_matches(...))`:
-- nesting two set-returning functions in a select list is a hard error on
-- Postgres 10+ ("set-returning functions must appear at top level of FROM"),
-- and it would fail at CREATE VIEW time — taking the dry run with it.
LEFT JOIN LATERAL regexp_matches(
  lower(coalesce(m.from_addr, '') || ' ' || coalesce(m.to_addrs, '') || ' ' || coalesce(m.cc_addrs, '')),
  '[[:alnum:]._%+-]+@[[:alnum:].-]+\.[[:alpha:]]{2,}',
  'g'
) AS addr(hit) ON TRUE
GROUP BY t.id, t.workspace_id, t.last_message_at, t.status, t.subject;

CREATE VIEW v_thread_merge_plan AS
SELECT
  loser.thread_id  AS from_thread_id,
  winner.thread_id AS to_thread_id,
  winner.clean_subject,
  loser.message_count  AS from_messages,
  winner.message_count AS to_messages,
  loser.inbox_count    AS from_inbox_messages
FROM v_thread_identity loser
JOIN LATERAL (
  SELECT w.*
  FROM v_thread_identity w
  WHERE w.workspace_id  = loser.workspace_id
    AND w.clean_subject = loser.clean_subject
    AND w.clean_subject <> ''
    AND w.thread_id    <> loser.thread_id
    AND w.account_ids     && loser.account_ids     -- same mailbox
    AND w.correspondents  && loser.correspondents  -- and a shared OUTSIDE party
    -- Don't let an ancient thread swallow a current one: refuse to merge when
    -- the two threads' newest messages are more than 180 days apart.
    -- last_message_at is epoch MILLISECONDS (bigint), hence the * 1000.
    AND abs(w.last_message_at - loser.last_message_at) <= 180 * 86400 * 1000
  ORDER BY w.last_message_at ASC, w.thread_id ASC
  LIMIT 1
) AS winner ON TRUE
-- Only ever move the newer thread into the older one, never both directions.
-- This is what makes cycles impossible.
WHERE loser.last_message_at > winner.last_message_at
   OR (loser.last_message_at = winner.last_message_at AND loser.thread_id > winner.thread_id);


-- =============================================================================
-- 2. DRY RUN — run these and read the output. Nothing here writes.
-- =============================================================================

-- How much would move?
--   SELECT count(*) AS pairs, sum(from_messages) AS messages_moving
--     FROM v_thread_merge_plan;

-- The biggest merges, to eyeball for anything that looks wrong:
--   SELECT clean_subject, from_thread_id, to_thread_id,
--          from_messages, to_messages, from_inbox_messages
--     FROM v_thread_merge_plan
--    ORDER BY from_messages DESC
--    LIMIT 100;

-- ⚠️ SANITY CHECK — the mega-thread detector. If any subject shows a high
-- pair count, the pairing rule is over-merging and you must NOT proceed:
--   SELECT clean_subject, count(*) AS pairs
--     FROM v_thread_merge_plan
--    GROUP BY clean_subject
--   HAVING count(*) > 5
--    ORDER BY pairs DESC;

-- ⚠️ WHAT WOULD BE DESTROYED. threads has ON DELETE CASCADE from drafts and
-- scheduled_messages, so deleting a merged-away thread silently takes an unsent
-- draft — or a QUEUED CUSTOMER EMAIL — with it. Section 3 re-parents these
-- instead, but check the blast radius first:
--   SELECT 'scheduled' AS kind, count(*) FROM scheduled_messages s
--     WHERE s.thread_id IN (SELECT from_thread_id FROM v_thread_merge_plan)
--   UNION ALL
--   SELECT 'drafts', count(*) FROM drafts d
--     WHERE d.thread_id IN (SELECT from_thread_id FROM v_thread_merge_plan)
--   UNION ALL
--   SELECT 'tasks', count(*) FROM tasks k
--     WHERE k.thread_id IN (SELECT from_thread_id FROM v_thread_merge_plan);

-- The originally-reported conversation:
--   SELECT * FROM v_thread_merge_plan WHERE clean_subject ILIKE '%program pages%';


-- =============================================================================
-- 3. APPLY — uncomment and run as ONE transaction.
-- =============================================================================
-- BEGIN;
--
-- CREATE TABLE IF NOT EXISTS thread_merge_log (
--   run_at          BIGINT NOT NULL,
--   from_thread_id  TEXT   NOT NULL,
--   to_thread_id    TEXT   NOT NULL,
--   kind            TEXT   NOT NULL,   -- 'message' | 'draft' | 'scheduled' | 'task' | 'comment' | 'label'
--   row_id          TEXT   NOT NULL,
--   PRIMARY KEY (run_at, kind, row_id)
-- );
--
-- -- Freeze the plan. The views read live data and the statements below mutate
-- -- exactly that data, so every step must act on the same snapshot.
-- CREATE TEMP TABLE plan ON COMMIT DROP AS SELECT * FROM v_thread_merge_plan;
--
-- -- Record EVERYTHING we are about to move, before moving any of it.
-- INSERT INTO thread_merge_log (run_at, from_thread_id, to_thread_id, kind, row_id)
--   SELECT extract(epoch from now())::bigint*1000, p.from_thread_id, p.to_thread_id, 'message', m.id
--     FROM plan p JOIN messages m ON m.thread_id = p.from_thread_id
--   UNION ALL
--   SELECT extract(epoch from now())::bigint*1000, p.from_thread_id, p.to_thread_id, 'draft', d.id
--     FROM plan p JOIN drafts d ON d.thread_id = p.from_thread_id
--   UNION ALL
--   SELECT extract(epoch from now())::bigint*1000, p.from_thread_id, p.to_thread_id, 'scheduled', s.id
--     FROM plan p JOIN scheduled_messages s ON s.thread_id = p.from_thread_id
--   UNION ALL
--   SELECT extract(epoch from now())::bigint*1000, p.from_thread_id, p.to_thread_id, 'task', k.id
--     FROM plan p JOIN tasks k ON k.thread_id = p.from_thread_id
--   UNION ALL
--   SELECT extract(epoch from now())::bigint*1000, p.from_thread_id, p.to_thread_id, 'comment', c.id
--     FROM plan p JOIN comments c ON c.thread_id = p.from_thread_id;
--
-- -- Fold the loser's identity into the winner FIRST, while the loser still has
-- -- its rows. Pre-aggregated by winner: a winner routinely has SEVERAL losers,
-- -- and `UPDATE ... FROM` with multiple matching source rows per target applies
-- -- only ONE of them, unpredictably — so folding them one-per-row would silently
-- -- drop all but one loser's participants.
-- WITH folded AS (
--   SELECT p.to_thread_id,
--          max(l.last_message_at)             AS last_message_at,
--          string_agg(DISTINCT l.participants, '; ') AS participants,
--          string_agg(DISTINCT l.search_text,  ' ')  AS search_text
--     FROM plan p JOIN threads l ON l.id = p.from_thread_id
--    GROUP BY p.to_thread_id
-- )
-- UPDATE threads w
--    SET last_message_at = GREATEST(w.last_message_at, f.last_message_at),
--        participants = CASE
--          WHEN coalesce(f.participants, '') = '' THEN w.participants
--          WHEN coalesce(w.participants, '') = '' THEN f.participants
--          WHEN w.participants LIKE '%' || f.participants || '%' THEN w.participants
--          ELSE w.participants || '; ' || f.participants
--        END,
--        -- 100000 matches SEARCH_TEXT_CAP in imap.js. The GIN to_tsvector index
--        -- has a hard 1 MB per-value ceiling, and unlike the app (which catches
--        -- the overflow and retries) a failure here aborts the whole merge.
--        search_text = left(coalesce(w.search_text, '') || ' ' || coalesce(f.search_text, ''), 100000)
--   FROM folded f
--  WHERE w.id = f.to_thread_id;
--
-- -- Move the messages.
-- UPDATE messages m SET thread_id = p.to_thread_id
--   FROM plan p WHERE m.thread_id = p.from_thread_id;
--
-- -- Re-parent everything else that points at a thread. Without these three the
-- -- DELETE at the end cascades them away: drafts and scheduled_messages are
-- -- ON DELETE CASCADE, so a queued customer email would simply never be sent,
-- -- with no error anywhere. tasks is ON DELETE SET NULL — it would just lose
-- -- its link, but there's no reason to accept that either.
-- UPDATE drafts d SET thread_id = p.to_thread_id
--   FROM plan p WHERE d.thread_id = p.from_thread_id;
-- UPDATE scheduled_messages s SET thread_id = p.to_thread_id
--   FROM plan p WHERE s.thread_id = p.from_thread_id;
-- UPDATE tasks k SET thread_id = p.to_thread_id
--   FROM plan p WHERE k.thread_id = p.from_thread_id;
-- UPDATE comments c SET thread_id = p.to_thread_id
--   FROM plan p WHERE c.thread_id = p.from_thread_id;
--
-- -- Labels are keyed (thread_id, label_id), so skip any the winner already has.
-- INSERT INTO thread_labels (thread_id, label_id)
-- SELECT DISTINCT p.to_thread_id, tl.label_id
--   FROM plan p JOIN thread_labels tl ON tl.thread_id = p.from_thread_id
--  WHERE NOT EXISTS (SELECT 1 FROM thread_labels x
--                     WHERE x.thread_id = p.to_thread_id AND x.label_id = tl.label_id);
-- DELETE FROM thread_labels tl USING plan p WHERE tl.thread_id = p.from_thread_id;
--
-- -- Drop the now-empty threads. Every guard below must hold: NOT EXISTS on each
-- -- child table means a thread that still owns anything is left alone, so a bug
-- -- above degrades to "merge didn't finish", never to data loss.
-- DELETE FROM threads t
--  WHERE t.id IN (SELECT from_thread_id FROM plan)
--    AND NOT EXISTS (SELECT 1 FROM messages           x WHERE x.thread_id = t.id)
--    AND NOT EXISTS (SELECT 1 FROM drafts             x WHERE x.thread_id = t.id)
--    AND NOT EXISTS (SELECT 1 FROM scheduled_messages x WHERE x.thread_id = t.id)
--    AND NOT EXISTS (SELECT 1 FROM comments           x WHERE x.thread_id = t.id)
--    AND NOT EXISTS (SELECT 1 FROM thread_labels      x WHERE x.thread_id = t.id);
--
-- COMMIT;
--
-- NOTE ON CHAINS. The overlap test is not transitive: A↔B and B↔C can both
-- match while A↔C does not, producing a plan of B→A and C→B. Cycles are
-- impossible (the tiebreak only ever points newer→older), and the NOT EXISTS
-- guards mean B survives because it now holds C's messages — so nothing is
-- lost, but that conversation is left in two pieces rather than one. Re-run
-- sections 1–3 until `SELECT count(*) FROM v_thread_merge_plan` reaches 0; each
-- pass collapses one more link.


-- =============================================================================
-- 4. ROLLBACK — undo the most recent apply.
-- =============================================================================
-- ⚠️ THIS IS A PARTIAL RESTORE, NOT A TIME MACHINE. It returns every row to the
-- thread it came from, which is the part that matters. It does NOT undo:
--   * the identity fold — the winner keeps the merged participants/search_text
--   * thread_labels moved onto the winner
--   * recreated thread rows lose assignee_id / starred / snoozed_until /
--     team_space_id / message_id_root, which are not recoverable from messages
-- If you need a true restore, take a database snapshot before section 3.
--
-- BEGIN;
-- WITH last_run AS (SELECT max(run_at) AS at FROM thread_merge_log),
--      moved AS (SELECT l.* FROM thread_merge_log l, last_run WHERE l.run_at = last_run.at)
-- INSERT INTO threads (id, workspace_id, team_space_id, subject, participants,
--                      last_message_at, status, created_at)
-- SELECT DISTINCT ON (moved.from_thread_id)
--        moved.from_thread_id, m.workspace_id, NULL, m.subject, m.from_addr,
--        m.sent_at, 'open', extract(epoch from now())::bigint * 1000
--   FROM moved JOIN messages m ON m.id = moved.row_id AND moved.kind = 'message'
--  WHERE NOT EXISTS (SELECT 1 FROM threads t WHERE t.id = moved.from_thread_id)
--  ORDER BY moved.from_thread_id, m.sent_at ASC;
--
-- WITH last_run AS (SELECT max(run_at) AS at FROM thread_merge_log),
--      moved AS (SELECT l.* FROM thread_merge_log l, last_run WHERE l.run_at = last_run.at)
-- UPDATE messages m SET thread_id = moved.from_thread_id
--   FROM moved WHERE moved.kind = 'message' AND m.id = moved.row_id;
--
-- WITH last_run AS (SELECT max(run_at) AS at FROM thread_merge_log),
--      moved AS (SELECT l.* FROM thread_merge_log l, last_run WHERE l.run_at = last_run.at)
-- UPDATE drafts d SET thread_id = moved.from_thread_id
--   FROM moved WHERE moved.kind = 'draft' AND d.id = moved.row_id;
--
-- WITH last_run AS (SELECT max(run_at) AS at FROM thread_merge_log),
--      moved AS (SELECT l.* FROM thread_merge_log l, last_run WHERE l.run_at = last_run.at)
-- UPDATE scheduled_messages s SET thread_id = moved.from_thread_id
--   FROM moved WHERE moved.kind = 'scheduled' AND s.id = moved.row_id;
--
-- WITH last_run AS (SELECT max(run_at) AS at FROM thread_merge_log),
--      moved AS (SELECT l.* FROM thread_merge_log l, last_run WHERE l.run_at = last_run.at)
-- UPDATE tasks k SET thread_id = moved.from_thread_id
--   FROM moved WHERE moved.kind = 'task' AND k.id = moved.row_id;
--
-- WITH last_run AS (SELECT max(run_at) AS at FROM thread_merge_log),
--      moved AS (SELECT l.* FROM thread_merge_log l, last_run WHERE l.run_at = last_run.at)
-- UPDATE comments c SET thread_id = moved.from_thread_id
--   FROM moved WHERE moved.kind = 'comment' AND c.id = moved.row_id;
--
-- COMMIT;
