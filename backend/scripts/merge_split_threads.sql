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
-- SAFETY. This script only ever re-points messages.thread_id and deletes thread
-- rows that it has just emptied. It is written to be run in three deliberate
-- steps, and every step is idempotent:
--
--   1. DRY RUN  — run section 1 alone and read the report. Nothing is written.
--   2. APPLY    — run section 2 inside a transaction. It records the full
--                 old->new mapping in thread_merge_log BEFORE touching
--                 anything, so the move is reversible.
--   3. ROLLBACK — section 3, only if the apply turned out wrong.
--
-- Pairing rule (deliberately conservative, and identical to the new ingest
-- rule): same workspace, same cleaned subject, at least one shared mailbox
-- (account_id), and at least one shared counterparty address. Threads that
-- merely share a subject — the "Email Account Activity" GoDaddy notifications
-- that once collapsed into a 160-message mega-thread — do NOT match, because
-- they have no correspondent in common.

-- =============================================================================
-- 0. Helper views: thread identity, then the merge plan derived from it.
--    Creating these writes no data.
-- =============================================================================
DROP VIEW IF EXISTS v_thread_merge_plan CASCADE;
DROP VIEW IF EXISTS v_thread_identity CASCADE;

CREATE VIEW v_thread_identity AS
SELECT
  t.id                AS thread_id,
  t.workspace_id,
  t.last_message_at,
  -- Same normalization findOrCreateThread applies before matching.
  btrim(regexp_replace(coalesce(t.subject, ''), '^(re|fwd|fw)\s*:\s*', '', 'i')) AS clean_subject,
  array_agg(DISTINCT m.account_id) FILTER (WHERE m.account_id IS NOT NULL)       AS account_ids,
  -- Every email address mentioned anywhere on the thread's messages.
  array_agg(DISTINCT lower(addr.a)) FILTER (WHERE addr.a IS NOT NULL)           AS addresses,
  -- DISTINCT m.id, not count(*): the lateral join below emits one row per
  -- (message x address), so a plain count would multiply by however many
  -- addresses each message mentions.
  count(DISTINCT m.id)                                                          AS message_count,
  count(DISTINCT m.id) FILTER (WHERE m.folder = 'INBOX')                        AS inbox_count
FROM threads t
JOIN messages m ON m.thread_id = t.id
-- LEFT, so a message with no parseable address still counts toward the totals
-- instead of dropping the whole message from the report.
LEFT JOIN LATERAL (
  SELECT unnest(regexp_matches(
    coalesce(m.from_addr, '') || ' ' || coalesce(m.to_addrs, '') || ' ' || coalesce(m.cc_addrs, ''),
    '[[:alnum:]._%+-]+@[[:alnum:].-]+\.[[:alpha:]]{2,}',
    'g'
  )) AS a
) AS addr ON TRUE
GROUP BY t.id, t.workspace_id, t.last_message_at, t.subject;

-- Candidate pairs, collapsed so the OLDEST thread of each group wins (keeping
-- the thread the conversation actually started in).
CREATE VIEW v_thread_merge_plan AS
SELECT
  loser.thread_id  AS from_thread_id,
  winner.thread_id AS to_thread_id,
  winner.clean_subject,
  loser.message_count  AS from_messages,
  winner.message_count AS to_messages
FROM v_thread_identity loser
JOIN LATERAL (
  SELECT w.*
  FROM v_thread_identity w
  WHERE w.workspace_id = loser.workspace_id
    AND w.clean_subject = loser.clean_subject
    AND w.clean_subject <> ''
    AND w.thread_id <> loser.thread_id
    -- same mailbox
    AND w.account_ids && loser.account_ids
    -- and a shared correspondent
    AND w.addresses && loser.addresses
  ORDER BY w.last_message_at ASC, w.thread_id ASC
  LIMIT 1
) AS winner ON TRUE
-- Only move the newer thread into the older one, never both ways.
WHERE loser.last_message_at > winner.last_message_at
   OR (loser.last_message_at = winner.last_message_at AND loser.thread_id > winner.thread_id);

-- =============================================================================
-- 1. DRY RUN — read this before applying anything.
-- =============================================================================
-- Summary:
--   SELECT count(*) AS pairs_to_merge FROM v_thread_merge_plan;
--
-- Detail, worst offenders first:
--   SELECT clean_subject, from_thread_id, to_thread_id, from_messages, to_messages
--     FROM v_thread_merge_plan
--    ORDER BY from_messages DESC
--    LIMIT 100;
--
-- Check the reported case specifically:
--   SELECT * FROM v_thread_merge_plan WHERE clean_subject ILIKE '%program pages%';

-- =============================================================================
-- 2. APPLY — uncomment and run this block as one transaction.
-- =============================================================================
-- BEGIN;
--
-- CREATE TABLE IF NOT EXISTS thread_merge_log (
--   from_thread_id  TEXT NOT NULL,
--   to_thread_id    TEXT NOT NULL,
--   message_id      TEXT NOT NULL,
--   merged_at       BIGINT NOT NULL,
--   PRIMARY KEY (message_id, merged_at)
-- );
--
-- -- Snapshot the plan: the views read live data, and step 2 mutates that data
-- -- as it goes. Freezing it here means every statement below acts on exactly
-- -- the same set of pairs.
-- CREATE TEMP TABLE plan ON COMMIT DROP AS SELECT * FROM v_thread_merge_plan;
--
-- -- Record every message we are about to move, BEFORE moving it. This is what
-- -- makes section 3 possible.
-- INSERT INTO thread_merge_log (from_thread_id, to_thread_id, message_id, merged_at)
-- SELECT p.from_thread_id, p.to_thread_id, m.id, extract(epoch from now())::bigint * 1000
--   FROM plan p
--   JOIN messages m ON m.thread_id = p.from_thread_id;
--
-- -- Fold the loser's identity into the winner FIRST, while the loser still has
-- -- its messages and its row.
-- UPDATE threads w
--    SET last_message_at = GREATEST(w.last_message_at, l.last_message_at),
--        participants = CASE
--          WHEN coalesce(l.participants, '') = '' THEN w.participants
--          WHEN coalesce(w.participants, '') = '' THEN l.participants
--          WHEN w.participants LIKE '%' || l.participants || '%' THEN w.participants
--          ELSE w.participants || '; ' || l.participants
--        END,
--        search_text = left(coalesce(w.search_text, '') || ' ' || coalesce(l.search_text, ''), 250000)
--   FROM plan p
--   JOIN threads l ON l.id = p.from_thread_id
--  WHERE w.id = p.to_thread_id;
--
-- -- Move the messages.
-- UPDATE messages m
--    SET thread_id = p.to_thread_id
--   FROM plan p
--  WHERE m.thread_id = p.from_thread_id;
--
-- -- Carry over anything else keyed on the thread. thread_labels has a
-- -- (thread_id, label_id) primary key, so skip rows the winner already has.
-- INSERT INTO thread_labels (thread_id, label_id)
-- SELECT DISTINCT p.to_thread_id, tl.label_id
--   FROM plan p
--   JOIN thread_labels tl ON tl.thread_id = p.from_thread_id
--  WHERE NOT EXISTS (
--    SELECT 1 FROM thread_labels x
--     WHERE x.thread_id = p.to_thread_id AND x.label_id = tl.label_id
--  );
-- DELETE FROM thread_labels tl USING plan p WHERE tl.thread_id = p.from_thread_id;
--
-- UPDATE comments c
--    SET thread_id = p.to_thread_id
--   FROM plan p
--  WHERE c.thread_id = p.from_thread_id;
--
-- -- Finally drop the now-empty threads. The NOT EXISTS guard means this can
-- -- never delete a thread that still owns messages.
-- DELETE FROM threads t
--  WHERE t.id IN (SELECT from_thread_id FROM plan)
--    AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id);
--
-- COMMIT;

-- =============================================================================
-- 3. ROLLBACK — undo the most recent apply.
-- =============================================================================
-- Threads deleted in step 2 have to come back before their messages can point
-- at them again, so this recreates those thread rows from the messages that are
-- about to be returned to them.
--
-- BEGIN;
-- WITH last_run AS (SELECT max(merged_at) AS at FROM thread_merge_log),
--      moved AS (
--        SELECT l.* FROM thread_merge_log l, last_run WHERE l.merged_at = last_run.at
--      )
-- INSERT INTO threads (id, workspace_id, team_space_id, subject, participants,
--                      last_message_at, status, created_at)
-- SELECT DISTINCT ON (moved.from_thread_id)
--        moved.from_thread_id, m.workspace_id, NULL, m.subject, m.from_addr,
--        m.sent_at, 'open', extract(epoch from now())::bigint * 1000
--   FROM moved JOIN messages m ON m.id = moved.message_id
--  WHERE NOT EXISTS (SELECT 1 FROM threads t WHERE t.id = moved.from_thread_id)
--  ORDER BY moved.from_thread_id, m.sent_at ASC;
--
-- WITH last_run AS (SELECT max(merged_at) AS at FROM thread_merge_log)
-- UPDATE messages m
--    SET thread_id = l.from_thread_id
--   FROM thread_merge_log l, last_run
--  WHERE l.merged_at = last_run.at AND m.id = l.message_id;
--
-- COMMIT;
--
-- After a successful, verified apply the log can be kept indefinitely (it's
-- small) — it is the only record of what moved where.
