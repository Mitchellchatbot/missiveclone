-- Merge conversations that were split into two or more threads.
--
-- ############################################################################
-- ##  DO NOT RUN SECTION 3 UNTIL SECTIONS 1-2 HAVE BEEN EXECUTED AND READ.  ##
-- ##  This script has never been run anywhere. Every claim in it is         ##
-- ##  reasoned, not observed. Take a snapshot before section 3.             ##
-- ############################################################################
--
-- WHY: findOrCreateThread's subject fallback used to require an existing
-- message *from the same sender* in the same mailbox. Our own outbound copy of
-- a reply — arriving with no usable In-Reply-To — therefore never matched the
-- customer's thread and started a second one holding only sent mail. That
-- second thread has no message with folder='INBOX', so DelegationDoer's Inbox
-- view can't show it at all: users had to go to Sent to find half of their own
-- conversation. The ingest fix stops NEW splits; this repairs existing ones.
--
-- RUN ORDER, all of it required:
--   1. SETUP     — builds a scratch table + a view. Reads only.
--   2. DRY RUN   — what would merge, and what would break. Reads only.
--   3. APPLY     — one transaction, fully logged, reversible by section 4.
--   4. ROLLBACK  — partial restore. Read its caveats.
--   5. AFTER     — DelegationDoer-side cleanup. NOT optional (see below).
--
-- ⚠️ CROSS-REPO. DelegationDoer stores this database's thread ids as free text
-- with NO foreign key, in at least ten tables. Deleting a thread here orphans
-- them silently. The two that actually hurt:
--   * inbox_drafts       — a user's unsent inline reply is loaded by thread_id.
--                          Orphan it and their typed reply is unreachable.
--   * bulk_email_threads — the clone-independent backstop that keeps the
--                          "Monthly SEO update" blast out of client touchpoint
--                          health. Orphan it and every blasted client lights up
--                          green again.
-- Section 5 exists to fix this. Skipping it loses customer replies.
--
-- THE PAIRING RULE. Two threads merge when they are in the same workspace, have
-- the same cleaned subject, share a mailbox, AND share a correspondent who is
-- not one of our own mailboxes. That last clause is the whole safety story:
-- without it the rule collapses to "merge every thread in this mailbox with the
-- same subject", because every message in a mailbox mentions that mailbox's own
-- address — that is what puts it there.
--
-- Correspondents are taken from From and To ONLY, never Cc — matching
-- findOrCreateThread exactly. Including Cc would make any routinely-copied
-- internal address (accounting@, ops@) a universal merge key and join two
-- different vendors' "Invoice" threads.

-- The app pushes search_path per pooled connection; a psql session does not.
-- Without this every unqualified table below resolves to nothing.
SET search_path TO missive, public;


-- =============================================================================
-- 1. SETUP — a scratch table and a view. Writes no real data.
-- =============================================================================
DROP VIEW IF EXISTS v_thread_merge_plan;
DROP TABLE IF EXISTS thread_merge_identity;

-- Materialized rather than a view: the plan below joins this against itself with
-- a LATERAL, and as a view that re-runs the whole aggregate (plus a regexp per
-- row) for every candidate — quadratic, and slow enough on a production-sized
-- threads table that the dry run looks like it hung.
CREATE TABLE thread_merge_identity AS
SELECT
  t.id                AS thread_id,
  t.workspace_id,
  t.last_message_at,
  t.status,
  -- Same normalization findOrCreateThread applies before matching.
  btrim(regexp_replace(coalesce(t.subject, ''), '^(re|fwd|fw)\s*:\s*', '', 'i')) AS clean_subject,
  array_agg(DISTINCT m.account_id) FILTER (WHERE m.account_id IS NOT NULL) AS account_ids,
  -- Correspondents: addresses on this thread's messages that are NOT one of our
  -- own connected mailboxes. From/To only — see the header note about Cc.
  array_agg(DISTINCT addr.hit[1]) FILTER (
    WHERE addr.hit IS NOT NULL
      AND addr.hit[1] NOT IN (SELECT lower(email) FROM email_accounts WHERE email IS NOT NULL)
  ) AS correspondents,
  count(DISTINCT m.id)                                   AS message_count,
  count(DISTINCT m.id) FILTER (WHERE m.folder = 'INBOX') AS inbox_count
FROM threads t
JOIN messages m ON m.thread_id = t.id
-- `regexp_matches(...) AS addr(hit)` in FROM, NOT `SELECT unnest(regexp_matches(...))`:
-- nesting two set-returning functions in a select list is a hard error on
-- Postgres 10+, and it fails at CREATE time — taking the dry run with it.
-- LEFT, so a message with no parseable address still counts toward the totals.
LEFT JOIN LATERAL regexp_matches(
  lower(coalesce(m.from_addr, '') || ' ' || coalesce(m.to_addrs, '')),
  '[[:alnum:]._%+-]+@[[:alnum:].-]+\.[[:alpha:]]{2,}',
  'g'
) AS addr(hit) ON TRUE
GROUP BY t.id, t.workspace_id, t.last_message_at, t.status, t.subject;

CREATE INDEX ON thread_merge_identity (workspace_id, clean_subject);

CREATE VIEW v_thread_merge_plan AS
SELECT
  loser.thread_id  AS from_thread_id,
  winner.thread_id AS to_thread_id,
  winner.clean_subject,
  loser.message_count  AS from_messages,
  winner.message_count AS to_messages,
  loser.inbox_count    AS from_inbox_messages
FROM thread_merge_identity loser
JOIN LATERAL (
  SELECT w.*
  FROM thread_merge_identity w
  WHERE w.workspace_id  = loser.workspace_id
    AND w.clean_subject = loser.clean_subject
    AND w.clean_subject <> ''
    AND w.thread_id    <> loser.thread_id
    AND w.account_ids     && loser.account_ids     -- same mailbox
    AND w.correspondents  && loser.correspondents  -- and a shared OUTSIDE party
    -- Don't let an ancient thread swallow a current one: refuse when the two
    -- threads' newest messages are more than 180 days apart. The ::bigint is
    -- load-bearing — 180 * 86400 * 1000 is 15,552,000,000, which overflows int4
    -- and makes every SELECT on this view raise "integer out of range".
    AND abs(w.last_message_at - loser.last_message_at) <= 180::bigint * 86400 * 1000
  ORDER BY w.last_message_at ASC, w.thread_id ASC
  LIMIT 1
) AS winner ON TRUE
-- Only ever move the newer thread into the older one. This is what makes cycles
-- impossible.
WHERE loser.last_message_at > winner.last_message_at
   OR (loser.last_message_at = winner.last_message_at AND loser.thread_id > winner.thread_id);


-- =============================================================================
-- 2. DRY RUN — run all of these and read the output. Nothing here writes.
-- =============================================================================

-- How much would move?
--   SELECT count(*) AS pairs, sum(from_messages) AS messages_moving
--     FROM v_thread_merge_plan;

-- The biggest merges, to eyeball for anything that looks wrong:
--   SELECT clean_subject, from_thread_id, to_thread_id,
--          from_messages, to_messages, from_inbox_messages
--     FROM v_thread_merge_plan ORDER BY from_messages DESC LIMIT 100;

-- ⚠️ MEGA-THREAD DETECTOR. A subject with many pairs means the pairing rule is
-- over-merging — usually a shared automated sender that is a "correspondent" for
-- every one of its notification threads. If anything shows up here, STOP.
--   SELECT clean_subject, count(*) AS pairs
--     FROM v_thread_merge_plan GROUP BY clean_subject
--   HAVING count(*) > 5 ORDER BY pairs DESC;

-- ⚠️ DRAFT COLLISIONS. A user with a draft on BOTH halves cannot have both
-- re-parented — drafts is keyed (user_id, thread_id). Section 3 drops the
-- loser-side draft; this is how many people that affects:
--   SELECT count(*) FROM v_thread_merge_plan p
--     JOIN drafts d ON d.thread_id = p.from_thread_id
--     JOIN drafts w ON w.thread_id = p.to_thread_id AND w.user_id = d.user_id;

-- ⚠️ BLAST RADIUS on everything else keyed to a thread:
--   SELECT 'scheduled' k, count(*) FROM scheduled_messages WHERE thread_id IN (SELECT from_thread_id FROM v_thread_merge_plan)
--   UNION ALL SELECT 'drafts',  count(*) FROM drafts        WHERE thread_id IN (SELECT from_thread_id FROM v_thread_merge_plan)
--   UNION ALL SELECT 'tasks',   count(*) FROM tasks         WHERE thread_id IN (SELECT from_thread_id FROM v_thread_merge_plan)
--   UNION ALL SELECT 'comments',count(*) FROM comments      WHERE thread_id IN (SELECT from_thread_id FROM v_thread_merge_plan);

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
-- -- clock_timestamp() (not now()) so two runs in the same transaction-time
-- -- cannot collide on the log's primary key.
-- CREATE TEMP TABLE run ON COMMIT DROP AS
--   SELECT (extract(epoch from clock_timestamp()) * 1000)::bigint AS at;
--
-- -- Record EVERYTHING we are about to touch, before touching any of it.
-- INSERT INTO thread_merge_log (run_at, from_thread_id, to_thread_id, kind, row_id)
--   SELECT r.at, p.from_thread_id, p.to_thread_id, 'message', m.id
--     FROM plan p, run r JOIN messages m ON m.thread_id = p.from_thread_id
--   UNION ALL
--   -- drafts has NO id column (PRIMARY KEY (user_id, thread_id)) — key it as
--   -- user_id:thread_id so section 4 can find the row again.
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
-- -- its rows. Pre-aggregated by winner: a winner routinely has SEVERAL losers,
-- -- and UPDATE ... FROM with multiple matching source rows applies only ONE of
-- -- them, unpredictably — silently dropping the rest.
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
--        -- 100000 matches SEARCH_TEXT_CAP in imap.js. The GIN to_tsvector index
--        -- has a hard 1 MB ceiling and, unlike the app, an overflow here aborts
--        -- the whole merge.
--        search_text = left(coalesce(w.search_text, '') || ' ' || coalesce(f.search_text, ''), 100000)
--   FROM folded f
--  WHERE w.id = f.to_thread_id;
--
-- UPDATE messages m SET thread_id = p.to_thread_id
--   FROM plan p WHERE m.thread_id = p.from_thread_id;
--
-- -- DRAFTS. Re-parenting blindly violates PRIMARY KEY (user_id, thread_id)
-- -- whenever a user has a draft on BOTH halves — which is exactly the state this
-- -- bug creates. Log the loser-side draft as dropped, delete it, then move the
-- -- rest. Losing the older half of a duplicated draft beats aborting the merge.
-- INSERT INTO thread_merge_log (run_at, from_thread_id, to_thread_id, kind, row_id)
--   SELECT r.at, p.from_thread_id, p.to_thread_id, 'draft-dropped', d.user_id || ':' || d.thread_id
--     FROM plan p, run r
--     JOIN drafts d ON d.thread_id = p.from_thread_id
--     JOIN drafts w ON w.thread_id = p.to_thread_id AND w.user_id = d.user_id;
-- DELETE FROM drafts d
--  USING plan p, drafts w
--  WHERE d.thread_id = p.from_thread_id
--    AND w.thread_id = p.to_thread_id AND w.user_id = d.user_id;
-- UPDATE drafts d SET thread_id = p.to_thread_id
--   FROM plan p WHERE d.thread_id = p.from_thread_id;
--
-- -- The rest re-parent cleanly. Without these the DELETE below cascades them
-- -- away: drafts and scheduled_messages are ON DELETE CASCADE, so a queued
-- -- customer email would simply never be sent, with no error anywhere.
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
-- CHAINS. The overlap test is not transitive: A↔B and B↔C can both match while
-- A↔C does not, giving a plan of B→A and C→B. Nothing is lost (the NOT EXISTS
-- guards keep B alive because it now holds C's messages), but the conversation
-- is left in two pieces. Re-run sections 1-3 until
-- `SELECT count(*) FROM v_thread_merge_plan` reaches 0.


-- =============================================================================
-- 4. ROLLBACK — undo the most recent apply.
-- =============================================================================
-- ⚠️ PARTIAL RESTORE, NOT A TIME MACHINE. It returns rows to their original
-- thread. It does NOT undo: the identity fold (the winner keeps the merged
-- participants/search_text), labels moved to the winner, drafts deleted as
-- 'draft-dropped', or the lost columns on recreated threads (assignee_id,
-- starred, snoozed_until, team_space_id, message_id_root). Recreated threads
-- come back with status 'open' and the timestamp of their newest message.
-- For a true restore, use the snapshot you took before section 3.
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
-- -- drafts moved by user_id, since they have no id.
-- UPDATE drafts d SET thread_id = mv.from_thread_id
--   FROM moved mv
--  WHERE mv.kind = 'draft'
--    AND d.user_id  = split_part(mv.row_id, ':', 1)
--    AND d.thread_id = mv.to_thread_id;
-- COMMIT;


-- =============================================================================
-- 5. AFTER — DelegationDoer cleanup. NOT OPTIONAL.
-- =============================================================================
-- DD references these thread ids with no foreign key, so nothing above touched
-- them. Export the mapping:
--
--   \copy (SELECT DISTINCT from_thread_id, to_thread_id FROM thread_merge_log \
--          WHERE run_at = (SELECT max(run_at) FROM thread_merge_log)) \
--     TO 'thread_merge_map.csv' CSV HEADER
--
-- Then, in DelegationDoer's Supabase, re-point every table that stores a clone
-- thread id. Check the counts BEFORE updating so you know what you are moving:
--
--   select 'inbox_drafts' t, count(*) from inbox_drafts where thread_id = any($losers)
--   union all select 'bulk_email_threads', count(*) from bulk_email_threads where thread_id = any($losers)
--   union all select 'thread_read_state', count(*) from thread_read_state where thread_id = any($losers)
--   union all select 'email_satisfaction_scores', count(*) from email_satisfaction_scores where thread_id = any($losers)
--   union all select 'routing_review', count(*) from routing_review where thread_id = any($losers)
--   union all select 'email_intake_log', count(*) from email_intake_log where thread_id = any($losers)
--   union all select 'scheduled_emails', count(*) from scheduled_emails where thread_id = any($losers)
--   union all select 'email_drafts', count(*) from email_drafts where thread_id = any($losers);
--
-- inbox_drafts and thread_read_state may have their own uniqueness on
-- (user_id, thread_id) — resolve collisions the same way section 3 does for
-- drafts, keeping the winner-side row.
--
-- bulk_email_threads is the one to get right: it is a thread-id allowlist that
-- keeps blast emails out of client touchpoint health. If a blast thread was
-- merged away and this is not updated, every client in that blast starts
-- reporting as freshly contacted.
