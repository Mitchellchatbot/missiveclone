-- Merge conversations that were split into an inbound half and an outbound half.
--
-- WHY: findOrCreateThread's subject fallback used to require an existing message
-- *from the same sender* in the same mailbox. Our own outbound copy of a reply —
-- arriving with no usable In-Reply-To — therefore never matched the customer's
-- thread and started a second one holding only sent mail. That second thread has
-- no message with folder='INBOX', so DelegationDoer's Inbox view cannot show it
-- at all: users had to go to Sent to find half of their own conversation.
-- The ingest fix stops NEW splits; this repairs existing ones.
--
--
-- ============================ MEASURED, NOT GUESSED ==========================
-- Everything below was run read-only against production on 2026-08-13
-- (PostgreSQL 17.6, 36,798 threads / 100,144 messages / 31 mailboxes):
--
--   pairs that would merge ......... 479   (1,313 messages, 1.3% of all mail)
--   winners absorbing 1 loser ...... 243
--   winners absorbing 2-3 .......... 67
--   worst case ..................... 8 losers into one winner
--   threads that are BOTH loser
--     and winner (cycle risk) ...... 0     ← proven, see "ACYCLIC" below
--   biggest resulting thread ....... 213 messages — and 29 threads are already
--                                    over 200 today (largest 622), so the merge
--                                    is not what creates large threads.
--
-- The originally-reported conversation resolves correctly:
--   c20e0853… (2 msgs, 0 inbound, 0 in INBOX folder)
--     → 17af46af… (4 msgs, all inbound)  = one 6-message thread, inbox-visible.
--
-- The APPLY block itself has still NEVER BEEN EXECUTED. Sections 1-2 have.
-- Take a snapshot before section 3.
-- =============================================================================
--
-- RUN ORDER:
--   1. SETUP     — scratch table + view. Reads only.
--   2. DRY RUN   — what would merge, and the safety gates. Reads only.
--   3. APPLY     — one transaction, fully logged, reversible by section 4.
--   4. ROLLBACK  — partial restore. Read its caveats.
--   5. AFTER     — DelegationDoer-side cleanup. Numbers measured below.
--
--
-- THE PAIRING RULE, and why it is shaped this way.
--
-- An earlier version of this script matched purely on "same mailbox + same
-- cleaned subject + a shared correspondent who is not one of our own mailboxes".
-- Run against production that produced 18,549 pairs — HALF the database — and
-- the safety gate lit up with automated senders:
--     "✅ Site migration completed" ........ 44 pairs
--     "🚀 Site migration started" .......... 42
--     "Weekly Citation Update & …" ......... 18
--     "Missive updates: …" (newsletter) .... 16
-- because a shared automated sender IS a shared correspondent. Excluding our own
-- mailboxes was not nearly enough.
--
-- So the rule now matches the BUG SIGNATURE instead of merely matching topics:
--   * the LOSER must be an orphaned Sent copy — inbox_count = 0 and at least one
--     outbound message. A notification thread has inbound mail, so it can never
--     be a loser.
--   * the WINNER must hold received mail — inbox_count > 0.
-- That took 18,549 pairs down to 479, and left the reported conversation caught.
--
-- ACYCLIC, BY CONSTRUCTION. Losers have inbox_count = 0; winners have
-- inbox_count > 0. The two sets are disjoint, so no thread can be both — which
-- makes cycles and A→B→C chains impossible without any timestamp tiebreak.
-- Verified on production: zero overlap. (The previous version needed a
-- "newer into older" rule for this, and that rule was actively wrong: it forced
-- the outbound half to win whenever it was the older thread, which is exactly
-- the case in the reported conversation — so the real bug went unrepaired.)
-- The winner is therefore picked for correctness: most inbound content first.

-- The app pushes search_path per pooled connection; a psql session does not.
SET search_path TO missive, public;


-- =============================================================================
-- 1. SETUP — a scratch table and a view. Writes no email data.
-- =============================================================================
DROP VIEW IF EXISTS v_thread_merge_plan;
DROP TABLE IF EXISTS thread_merge_identity;

-- Materialized, not a view: the plan self-joins this, and as a view that
-- re-runs the whole aggregate (plus a regexp over every message) per candidate
-- row. Measured: the un-materialized form does not finish in 120s on this
-- dataset, so a dry run against a view looks indistinguishable from a hang.
CREATE TABLE thread_merge_identity AS
SELECT
  t.id                AS thread_id,
  t.workspace_id,
  t.last_message_at,
  btrim(regexp_replace(coalesce(t.subject, ''), '^(re|fwd|fw)\s*:\s*', '', 'i')) AS clean_subject,
  array_agg(DISTINCT m.account_id) FILTER (WHERE m.account_id IS NOT NULL) AS account_ids,
  -- Correspondents: addresses on this thread EXCEPT our own connected mailboxes.
  -- From/To only, never Cc — matching findOrCreateThread, because a routinely
  -- copied internal address would otherwise be a universal merge key.
  array_agg(DISTINCT addr.hit[1]) FILTER (
    WHERE addr.hit IS NOT NULL
      AND addr.hit[1] NOT IN (SELECT lower(email) FROM email_accounts WHERE email IS NOT NULL)
  ) AS correspondents,
  count(DISTINCT m.id)                                        AS message_count,
  count(DISTINCT m.id) FILTER (WHERE m.folder = 'INBOX')      AS inbox_count,
  count(DISTINCT m.id) FILTER (WHERE m.direction = 'outbound') AS out_count
FROM threads t
JOIN messages m ON m.thread_id = t.id
-- `regexp_matches(...) AS addr(hit)` in FROM, NOT `SELECT unnest(regexp_matches(...))`:
-- nesting two set-returning functions in a select list is a hard error on PG 10+.
-- LEFT, so a message with no parseable address still counts toward the totals.
LEFT JOIN LATERAL regexp_matches(
  lower(coalesce(m.from_addr, '') || ' ' || coalesce(m.to_addrs, '')),
  '[[:alnum:]._%+-]+@[[:alnum:].-]+\.[[:alpha:]]{2,}',
  'g'
) AS addr(hit) ON TRUE
GROUP BY t.id, t.workspace_id, t.last_message_at, t.subject;

CREATE INDEX ON thread_merge_identity (workspace_id, clean_subject);

CREATE VIEW v_thread_merge_plan AS
SELECT DISTINCT ON (l.thread_id)
  l.thread_id      AS from_thread_id,
  w.thread_id      AS to_thread_id,
  w.clean_subject,
  l.message_count  AS from_messages,
  w.message_count  AS to_messages,
  w.inbox_count    AS to_inbox_messages
FROM thread_merge_identity l
JOIN thread_merge_identity w
  ON  w.workspace_id  = l.workspace_id
  AND w.clean_subject = l.clean_subject
  AND w.clean_subject <> ''
  AND lower(w.clean_subject) <> '(no subject)'
  AND w.thread_id    <> l.thread_id
  AND w.account_ids     && l.account_ids     -- same mailbox
  AND w.correspondents  && l.correspondents  -- and a shared outside party
  -- Don't let an ancient thread swallow a current one. The ::bigint is
  -- load-bearing: 180 * 86400 * 1000 is 15,552,000,000, which overflows int4 —
  -- verified, it raises "integer out of range" and takes the dry run with it.
  AND abs(w.last_message_at - l.last_message_at) <= 180::bigint * 86400 * 1000
WHERE l.inbox_count = 0 AND l.out_count > 0   -- loser: orphaned Sent copy
  AND w.inbox_count > 0                       -- winner: holds the received mail
-- Most inbound content wins, then oldest, then id — deterministic.
ORDER BY l.thread_id, w.inbox_count DESC, w.last_message_at ASC, w.thread_id ASC;


-- =============================================================================
-- 2. DRY RUN — run all of these and read the output. Nothing here writes.
-- =============================================================================

-- Size. Expect roughly 479 / 1,313 unless the data has moved a lot.
--   SELECT count(*) AS pairs, sum(from_messages) AS messages_moving
--     FROM v_thread_merge_plan;

-- ⚠️ SAFETY GATE — over-merging shows up as MANY LOSERS INTO ONE WINNER.
-- Do not group by subject alone: the same subject legitimately goes to many
-- different clients, so that reads as over-merging when it is not.
--   SELECT losers_per_winner, count(*) AS winners FROM (
--     SELECT to_thread_id, count(*) AS losers_per_winner
--       FROM v_thread_merge_plan GROUP BY to_thread_id) s
--    GROUP BY losers_per_winner ORDER BY losers_per_winner DESC;
-- Measured: max 8, and 243 of 479 winners absorb exactly one. If you see a
-- winner absorbing dozens, STOP — the pairing rule has regressed.

-- ⚠️ Nothing should be both a loser and a winner. Measured 0; if this is ever
-- non-zero the disjoint-set reasoning above is broken and chains are possible.
--   SELECT count(*) FROM v_thread_merge_plan a
--     JOIN v_thread_merge_plan b ON a.from_thread_id = b.to_thread_id;

-- Biggest merges, to eyeball:
--   SELECT left(clean_subject,50) AS subject, to_thread_id,
--          count(*) AS losers, sum(from_messages) AS msgs_in
--     FROM v_thread_merge_plan GROUP BY clean_subject, to_thread_id
--    ORDER BY losers DESC LIMIT 20;

-- Blast radius on rows keyed to a losing thread (measured: drafts 0, and the
-- whole drafts table is empty today; scheduled_messages 0):
--   SELECT 'drafts' k, count(*) FROM drafts WHERE thread_id IN (SELECT from_thread_id FROM v_thread_merge_plan)
--   UNION ALL SELECT 'scheduled', count(*) FROM scheduled_messages WHERE thread_id IN (SELECT from_thread_id FROM v_thread_merge_plan)
--   UNION ALL SELECT 'tasks',     count(*) FROM tasks             WHERE thread_id IN (SELECT from_thread_id FROM v_thread_merge_plan)
--   UNION ALL SELECT 'comments',  count(*) FROM comments          WHERE thread_id IN (SELECT from_thread_id FROM v_thread_merge_plan);

-- Users with a draft on BOTH halves — section 3 drops the loser-side one:
--   SELECT count(*) FROM v_thread_merge_plan p
--     JOIN drafts d ON d.thread_id = p.from_thread_id
--     JOIN drafts w ON w.thread_id = p.to_thread_id AND w.user_id = d.user_id;

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
--   kind            TEXT   NOT NULL,  -- message|draft|draft-dropped|scheduled|task|comment
--   row_id          TEXT   NOT NULL,  -- drafts have no id: 'user_id:thread_id'
--   PRIMARY KEY (run_at, kind, row_id)
-- );
--
-- -- Freeze the plan; the statements below mutate the data the view reads.
-- CREATE TEMP TABLE plan ON COMMIT DROP AS SELECT * FROM v_thread_merge_plan;
-- CREATE TEMP TABLE run ON COMMIT DROP AS
--   SELECT (extract(epoch from clock_timestamp()) * 1000)::bigint AS at;
--
-- -- Record EVERYTHING we are about to touch, before touching any of it.
-- INSERT INTO thread_merge_log (run_at, from_thread_id, to_thread_id, kind, row_id)
--   SELECT r.at, p.from_thread_id, p.to_thread_id, 'message', m.id
--     FROM plan p, run r JOIN messages m ON m.thread_id = p.from_thread_id
--   UNION ALL
--   -- drafts has NO id column (PRIMARY KEY (user_id, thread_id)) — verified
--   -- against production. Key it as user_id:thread_id so section 4 can find it.
--   SELECT r.at, p.from_thread_id, p.to_thread_id, 'draft', d.user_id || ':' || d.thread_id
--     FROM plan p, run r JOIN drafts d ON d.thread_id = p.from_thread_id
--   UNION ALL
--   SELECT r.at, p.from_thread_id, p.to_thread_id, 'scheduled', s.id
--     FROM plan p, run r JOIN scheduled_messages s ON s.thread_id = p.from_thread_id
--   UNION ALL
--   SELECT r.at, p.from_thread_id, p.to_thread_id, 'task', k.id
--     FROM plan p, run r JOIN tasks k ON k.thread_id = p.from_thread_id
--   UNION ALL
--   SELECT r.at, p.from_thread_id, p.to_thread_id, 'comment', c.id
--     FROM plan p, run r JOIN comments c ON c.thread_id = p.from_thread_id;
--
-- -- Fold the loser's identity into the winner FIRST, while the loser still has
-- -- its rows. Pre-aggregated by winner: a winner routinely has SEVERAL losers
-- -- (measured: up to 8), and UPDATE ... FROM with multiple matching source rows
-- -- applies only ONE of them, unpredictably.
-- WITH folded AS (
--   SELECT p.to_thread_id,
--          max(l.last_message_at)                    AS last_message_at,
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
--        -- 100000 matches SEARCH_TEXT_CAP in imap.js; the GIN to_tsvector index
--        -- has a hard 1 MB ceiling and an overflow here aborts the whole merge.
--        search_text = left(coalesce(w.search_text, '') || ' ' || coalesce(f.search_text, ''), 100000)
--   FROM folded f
--  WHERE w.id = f.to_thread_id;
--
-- UPDATE messages m SET thread_id = p.to_thread_id
--   FROM plan p WHERE m.thread_id = p.from_thread_id;
--
-- -- DRAFTS. Re-parenting blindly violates PRIMARY KEY (user_id, thread_id) when
-- -- a user has a draft on BOTH halves. Log the loser-side one as dropped, delete
-- -- it, then move the rest. (Measured: 0 affected today, but keep the guard.)
-- INSERT INTO thread_merge_log (run_at, from_thread_id, to_thread_id, kind, row_id)
--   SELECT r.at, p.from_thread_id, p.to_thread_id, 'draft-dropped', d.user_id || ':' || d.thread_id
--     FROM plan p, run r
--     JOIN drafts d ON d.thread_id = p.from_thread_id
--     JOIN drafts w ON w.thread_id = p.to_thread_id AND w.user_id = d.user_id;
-- DELETE FROM drafts d USING plan p, drafts w
--  WHERE d.thread_id = p.from_thread_id
--    AND w.thread_id = p.to_thread_id AND w.user_id = d.user_id;
-- UPDATE drafts d SET thread_id = p.to_thread_id
--   FROM plan p WHERE d.thread_id = p.from_thread_id;
--
-- -- Without these the DELETE below cascades them away: drafts and
-- -- scheduled_messages are ON DELETE CASCADE, so a queued customer email would
-- -- simply never be sent, with no error anywhere.
-- UPDATE scheduled_messages s SET thread_id = p.to_thread_id
--   FROM plan p WHERE s.thread_id = p.from_thread_id;
-- UPDATE tasks k SET thread_id = p.to_thread_id
--   FROM plan p WHERE k.thread_id = p.from_thread_id;
-- UPDATE comments c SET thread_id = p.to_thread_id
--   FROM plan p WHERE c.thread_id = p.from_thread_id;
--
-- INSERT INTO thread_labels (thread_id, label_id)
-- SELECT DISTINCT p.to_thread_id, tl.label_id
--   FROM plan p JOIN thread_labels tl ON tl.thread_id = p.from_thread_id
--  WHERE NOT EXISTS (SELECT 1 FROM thread_labels x
--                     WHERE x.thread_id = p.to_thread_id AND x.label_id = tl.label_id);
-- DELETE FROM thread_labels tl USING plan p WHERE tl.thread_id = p.from_thread_id;
--
-- -- Drop the now-empty threads. Every guard must hold, so a bug above degrades
-- -- to "merge didn't finish" rather than to data loss.
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
-- No chain handling is needed: losers and winners are disjoint sets (see
-- ACYCLIC above), so one pass merges everything the plan found.


-- =============================================================================
-- 4. ROLLBACK — undo the most recent apply.
-- =============================================================================
-- ⚠️ PARTIAL RESTORE, NOT A TIME MACHINE. It returns rows to their original
-- thread. It does NOT undo: the identity fold (the winner keeps the merged
-- participants/search_text), labels moved to the winner, drafts deleted as
-- 'draft-dropped', or the columns lost on recreated threads (assignee_id,
-- starred, snoozed_until, team_space_id, message_id_root). Recreated threads
-- come back with status 'open'. For a true restore, use the snapshot.
--
-- BEGIN;
-- CREATE TEMP TABLE moved ON COMMIT DROP AS
--   SELECT l.* FROM thread_merge_log l
--    WHERE l.run_at = (SELECT max(run_at) FROM thread_merge_log);
--
-- INSERT INTO threads (id, workspace_id, team_space_id, subject, participants,
--                      last_message_at, status, created_at)
-- SELECT DISTINCT ON (mv.from_thread_id)
--        mv.from_thread_id, m.workspace_id, NULL, m.subject, m.from_addr,
--        m.sent_at, 'open', (extract(epoch from now()) * 1000)::bigint
--   FROM moved mv JOIN messages m ON m.id = mv.row_id AND mv.kind = 'message'
--  WHERE NOT EXISTS (SELECT 1 FROM threads t WHERE t.id = mv.from_thread_id)
--  -- DESC: restore the thread's NEWEST message time, so it doesn't sink to the
--  -- bottom of an inbox ordered by last_message_at.
--  ORDER BY mv.from_thread_id, m.sent_at DESC;
--
-- UPDATE messages m SET thread_id = mv.from_thread_id
--   FROM moved mv WHERE mv.kind = 'message' AND m.id = mv.row_id;
-- UPDATE scheduled_messages s SET thread_id = mv.from_thread_id
--   FROM moved mv WHERE mv.kind = 'scheduled' AND s.id = mv.row_id;
-- UPDATE tasks k SET thread_id = mv.from_thread_id
--   FROM moved mv WHERE mv.kind = 'task' AND k.id = mv.row_id;
-- UPDATE comments c SET thread_id = mv.from_thread_id
--   FROM moved mv WHERE mv.kind = 'comment' AND c.id = mv.row_id;
-- UPDATE drafts d SET thread_id = mv.from_thread_id
--   FROM moved mv
--  WHERE mv.kind = 'draft'
--    AND d.user_id   = split_part(mv.row_id, ':', 1)
--    AND d.thread_id = mv.to_thread_id;
-- COMMIT;


-- =============================================================================
-- 5. AFTER — DelegationDoer cleanup.
-- =============================================================================
-- DD stores these thread ids as free text with NO foreign key, so nothing above
-- touched them. Measured against production for the current 479-thread plan:
--
--   thread_read_state ............ 87 rows   ← users' read markers; those
--                                              threads reappear as unread
--   email_satisfaction_scores .... 246 rows  ← scores orphaned
--   inbox_drafts ................. 0 rows    ← no typed replies at risk today
--   bulk_email_threads ........... 0 rows    ← SEO-blast touchpoint backstop safe
--   email_intake_log ............. 0 rows
--   scheduled_emails ............. 0 rows
--   email_drafts ................. n/a — no thread_id column
--   routing_review ............... n/a — table does not exist
--
-- So today the damage is 333 rows of read-state and scores: annoying, not
-- destructive. RE-MEASURE BEFORE RUNNING — inbox_drafts being 0 is luck, not a
-- guarantee, and it is the one that would lose a user's typed reply.
--
-- Export the mapping:
--   \copy (SELECT DISTINCT from_thread_id, to_thread_id FROM thread_merge_log \
--          WHERE run_at = (SELECT max(run_at) FROM thread_merge_log)) \
--     TO 'thread_merge_map.csv' CSV HEADER
--
-- Then in DD's Supabase, re-point the two tables that actually have rows.
-- thread_read_state may have its own uniqueness on (user_id, thread_id) —
-- resolve collisions the way section 3 does for drafts, keeping the winner side.
