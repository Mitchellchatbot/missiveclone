-- Remove duplicate message rows (and doubled attachment rows) left by racing ingests.
--
-- WHY: until the ingest lock shipped, nothing stopped the same email from being
-- inserted more than once for the same mailbox. The 30s poll started a sync walk
-- per account with no in-flight guard, Graph/IMAP cursors are only saved when a
-- walk ends, so slow walks overlapped and replayed the same mail — and ingest was
-- SELECT-then-INSERT with no transaction, lock or unique constraint. A Railway
-- deploy overlap added a second instance on top. The attachment backfill had the
-- same check-then-insert shape, which is how one message ended up storing the
-- same logo twice.
--
-- It is not cosmetic. DelegationDoer keys on the clone ROW id, so every copy
-- fired its own webhook: a duplicate client-email Slack post, a duplicate
-- email_notifications row, and an extra satisfaction score that skews the
-- client-health median. Section 9 cleans up the DD side.
--
-- The ingest fix (in-flight walk guard + advisory-locked ingest) stops NEW
-- duplicates; this repairs existing ones; create_unique_message_index.sql then
-- makes the database refuse any that slip through.
--
--
-- ############################################################################
-- ##  DO NOT RUN SECTIONS 4-9 UNTIL YOU HAVE READ THE OUTPUT OF 1-3.        ##
-- ##  None of the destructive blocks has EVER been executed anywhere, and   ##
-- ##  they are commented out on purpose. Run 1-3 (reads + one scratch       ##
-- ##  table), compare the numbers with the baseline below, confirm a PITR   ##
-- ##  point exists, and only then uncomment one section at a time.          ##
-- ##  Run no earlier than 1 HOUR after the ingest-lock deploy (see §2).     ##
-- ############################################################################
--
-- =============================== BASELINE ====================================
-- NOT a database count. A read-only sample through the clone API on 2026-09-22:
--   120 threads / 1,594 messages sampled
--   35 duplicate groups, 57 extra rows  → ~3.6% of messages are extra copies
--   created-day clusters: 05-19..22 (initial onboarding syncs) and 09-21
--   (catch-up after the outage).
-- Record the real §1 / §3 numbers here, with the date, before running §4.
-- =============================================================================
--
-- RUN ORDER:
--   1. COUNTS    — read-only. What is duplicated, when, and how.
--   2. PLAN      — one scratch table (dedup_plan_20260922). Writes no email data.
--   3. GATES     — read-only checks on the plan, clone- and DD-side.
--   4. SNAPSHOT  — backup tables + log table. Confirm PITR.
--   5. APPLY     — batched, COMMIT per batch. Batch 0 alone first.
--   6. THREADS   — re-point + delete loser threads that §5 left EMPTY. Report the rest.
--   7. ATT DUPES — doubled attachment rows within one message.
--   8. ROLLBACK  — restores rows from the snapshot. Read its caveats.
--   9. DD        — satisfaction scores, notifications, thread-keyed rows.
--   Then: create_unique_message_index.sql.
--
--
-- THE DUPLICATE KEY, and why it is shaped this way.
--
--   (account_id, direction, message_id)  with  NULLIF(message_id,'') IS NOT NULL
--                                        and   account_id IS NOT NULL
--
-- * account_id — the same email legitimately exists once PER MAILBOX (the sender's
--   Sent copy and each recipient's inbox copy are different rows). A NULL
--   account_id is an orphan from a disconnected mailbox; we can't say which
--   mailbox it belongs to, so it is never a candidate.
-- * direction — a message you send to yourself has an inbound copy and an
--   outbound copy with the same Message-ID in the same mailbox. Those are two
--   real rows, not a race; keeping direction in the key means they never merge.
-- * message_id — the RFC Message-ID header. EMPTY STRING IS NOT A KEY: compose,
--   reply and the scheduled dispatcher used to store '' when the transport
--   returned no id, so '' would collapse unrelated sent mail together. Every
--   query below uses NULLIF(message_id, ''), and the unique index uses the same
--   predicate.
--
-- Folder is deliberately NOT in the key: a race duplicates the row inside one
-- folder, but the Junk-vs-Inbox case (1i) shows why the keep rule has to look at
-- folder anyway.
--
--
-- CONNECTION. Use psql over a SESSION-mode connection: Supabase direct (5432)
-- or the session pooler on 5432 — NOT the transaction pooler on 6543, and NOT
-- the Supabase SQL editor. §5 commits inside a DO block, which the editor's
-- transaction wrapper cannot do, and a transaction-mode pooler can hand the SET
-- statements and the work to different backends so the timeouts silently don't
-- apply. The SQL editor also swallows RAISE NOTICE, which §5 reports through.

-- The app pushes search_path per pooled connection; a psql session does not.
SET search_path TO missive, public;

-- The app's pool caps statements at 15s; that belongs to the app, not to you.
-- §1 hashes message bodies for the content gate, so give the reads room. §5
-- sets its own (unbounded) timeout.
SET statement_timeout = '10min';


-- =============================================================================
-- 1. COUNTS — read-only. Run all of these and record the numbers above.
-- =============================================================================

-- 1a. THE GATE. Duplicate groups and extra rows. create_unique_message_index.sql
-- re-runs exactly this and refuses to build unless it sees 0 — groups §2
-- excluded count too, so those need resolving by hand first.
SELECT count(*) AS dup_groups, coalesce(sum(n - 1), 0) AS extra_rows
  FROM (SELECT account_id, direction, message_id, count(*) AS n
          FROM messages
         WHERE NULLIF(message_id, '') IS NOT NULL AND account_id IS NOT NULL
         GROUP BY account_id, direction, message_id
        HAVING count(*) > 1) g;

-- 1b. When the extra copies were written. Expect the 05-19..22 onboarding
-- cluster and 09-21. A row counts as "extra" if it is not the first-inserted
-- member of its group. Any day AFTER the ingest-lock deploy is a regression.
WITH r AS (
  SELECT created_at,
         row_number() OVER (PARTITION BY account_id, direction, message_id
                            ORDER BY created_at, id) AS nth,
         count(*)     OVER (PARTITION BY account_id, direction, message_id) AS n
    FROM messages
   WHERE NULLIF(message_id, '') IS NOT NULL AND account_id IS NOT NULL
)
SELECT (to_timestamp(created_at / 1000.0) AT TIME ZONE 'UTC')::date AS created_day_utc,
       count(*) AS extra_rows
  FROM r
 WHERE n > 1 AND nth > 1
 GROUP BY 1 ORDER BY 1;

-- 1c. Groups whose copies landed in MORE THAN ONE thread. findOrCreateThread was
-- SELECT-then-INSERT too, so two walks could each create a thread for the first
-- message of a conversation. These are the groups whose losers may leave an
-- empty thread behind (§6), and whose DD thread-keyed rows (intake tasks,
-- routing decisions) were duplicated.
SELECT count(*) AS groups_multi_thread, coalesce(sum(threads - 1), 0) AS extra_threads
  FROM (SELECT count(DISTINCT thread_id) AS threads
          FROM messages
         WHERE NULLIF(message_id, '') IS NOT NULL AND account_id IS NOT NULL
         GROUP BY account_id, direction, message_id
        HAVING count(*) > 1 AND count(DISTINCT thread_id) > 1) g;

-- 1d. Groups containing a row that DD/the clone wrote itself on send: compose,
-- reply and the scheduled dispatcher insert folder='Sent' with from_addr=''
-- (routes/compose.js, routes/threads.js, index.js). Its twin is usually the
-- 'Sent Items' copy the next sync brought in. DD's email_drafts.missive_message_id
-- points at the compose row, and only the compose row carries is_automated /
-- is_weekly_update reliably — so §2 EXCLUDES these by default. Review them
-- separately before opting in.
SELECT count(*) AS compose_row_groups, coalesce(sum(n - 1), 0) AS extra_rows
  FROM (SELECT count(*) AS n
          FROM messages
         WHERE NULLIF(message_id, '') IS NOT NULL AND account_id IS NOT NULL
         GROUP BY account_id, direction, message_id
        HAVING count(*) > 1 AND bool_or(folder = 'Sent' AND from_addr = '')) g;

-- 1e. Relink-origin groups: a member is OLDER than the mailbox it now belongs
-- to, so it arrived with account_id NULL (from an earlier connection of that
-- address) and was relinked onto this account — next to the fresh copy the new
-- connection synced. Not a race, but the same shape, and the unique index will
-- refuse it all the same.
SELECT count(*) AS relink_origin_groups, coalesce(sum(n - 1), 0) AS extra_rows
  FROM (SELECT count(*) AS n
          FROM messages m
          JOIN email_accounts a ON a.id = m.account_id
         WHERE NULLIF(m.message_id, '') IS NOT NULL
         GROUP BY m.account_id, m.direction, m.message_id
        HAVING count(*) > 1 AND bool_or(m.created_at < a.created_at)) g;

-- 1f. Report only — NOT cleaned by this script and NOT covered by the index.
-- Rows with no usable Message-ID. '' is what send paths wrote before they
-- normalised to NULL; the repeats are same mailbox + direction + subject +
-- sent_at + sender, which is a strong hint but not proof.
SELECT count(*) FILTER (WHERE message_id = '')  AS empty_string_ids,
       count(*) FILTER (WHERE message_id IS NULL) AS null_ids
  FROM messages;

SELECT count(*) AS no_id_repeat_groups, coalesce(sum(n - 1), 0) AS extra_rows
  FROM (SELECT count(*) AS n
          FROM messages
         WHERE NULLIF(message_id, '') IS NULL AND account_id IS NOT NULL
         GROUP BY account_id, direction, subject, sent_at, from_addr
        HAVING count(*) > 1) g;

-- 1g. Doubled attachment rows WITHIN one message (§7). Metadata only — no
-- TOAST reads. insertAttachmentRows stamps every row of one INSERT with the same
-- created_at, so a genuinely repeated file shares its twin's created_at; a race
-- or backfill double came from a separate INSERT and does not. Hence
-- count(DISTINCT created_at) > 1.
SELECT count(*) AS doubled_sets, coalesce(sum(n - 1), 0) AS extra_rows,
       count(DISTINCT message_id) AS messages_affected
  FROM (SELECT message_id, count(*) AS n
          FROM attachments
         GROUP BY message_id, filename, size_bytes, coalesce(content_id, '')
        HAVING count(*) > 1 AND count(DISTINCT created_at) > 1) g;

-- 1h. CONTENT-MISMATCH GATE. Some mailers reuse a Message-ID for different
-- emails. A group whose members differ in subject, sent_at or body is not a set
-- of copies, and §2 excludes it — list them and look before deciding anything.
-- The duplicate groups are found first on the key columns alone, so only their
-- members' bodies are detoasted and hashed — an md5 inside a whole-table HAVING
-- would read every body in the table on the MICRO instance.
WITH dup AS (
  SELECT account_id, direction, message_id
    FROM messages
   WHERE NULLIF(message_id, '') IS NOT NULL AND account_id IS NOT NULL
   GROUP BY account_id, direction, message_id
  HAVING count(*) > 1
)
SELECT count(*) AS content_mismatch_groups
  FROM (SELECT 1
          FROM messages m
          JOIN dup d ON d.account_id = m.account_id
                    AND d.direction  = m.direction
                    AND d.message_id = m.message_id
         GROUP BY m.account_id, m.direction, m.message_id
        HAVING count(DISTINCT (coalesce(m.subject, ''), m.sent_at,
                               md5(coalesce(m.body_text, '') || coalesce(m.body_html, '')))) > 1) g;
--   To eyeball them:
--   WITH dup AS (
--     SELECT account_id, direction, message_id FROM messages
--      WHERE NULLIF(message_id,'') IS NOT NULL AND account_id IS NOT NULL
--      GROUP BY 1, 2, 3 HAVING count(*) > 1
--   ),
--   mm AS (
--     SELECT m.account_id, m.direction, m.message_id FROM messages m
--       JOIN dup d USING (account_id, direction, message_id)
--      GROUP BY 1, 2, 3
--     HAVING count(DISTINCT (coalesce(m.subject,''), m.sent_at,
--                            md5(coalesce(m.body_text,'') || coalesce(m.body_html,'')))) > 1
--   )
--   SELECT m.account_id, m.direction, m.message_id, m.id, m.thread_id, m.folder,
--          left(m.subject, 60) AS subject, m.sent_at,
--          md5(coalesce(m.body_text,'') || coalesce(m.body_html,'')) AS body_md5
--     FROM messages m JOIN mm USING (account_id, direction, message_id)
--    ORDER BY m.account_id, m.direction, m.message_id, m.sent_at, m.id;

-- 1i. Junk-vs-inbox groups: one copy in Junk/Spam, another not. The keep rule
-- ranks the non-junk copy first — if the Junk copy survived, the mail would
-- vanish from the inbox view.
SELECT count(*) AS junk_vs_inbox_groups
  FROM (SELECT 1
          FROM messages
         WHERE NULLIF(message_id, '') IS NOT NULL AND account_id IS NOT NULL
         GROUP BY account_id, direction, message_id
        HAVING count(*) > 1
           AND bool_or(coalesce(folder, '') ~* '(junk|spam)')
           AND bool_or(coalesce(folder, '') !~* '(junk|spam)')) g;

-- 1j. How big the §4 message snapshot will be (every extra row, bodies
-- included). pg_column_size of the whole row is the on-disk (compressed) size,
-- so this is an estimate. Attachment BYTES are not snapshotted — see §4.
-- The window sorts key columns + id only; whole rows are read back for the
-- extra copies alone, not materialised for the entire table.
WITH r AS (
  SELECT id,
         row_number() OVER (PARTITION BY account_id, direction, message_id
                            ORDER BY sent_at, id) AS nth
    FROM messages
   WHERE NULLIF(message_id, '') IS NOT NULL AND account_id IS NOT NULL
)
SELECT pg_size_pretty(coalesce(sum(pg_column_size(m.*)), 0)) AS snapshot_estimate,
       count(*) AS rows
  FROM r JOIN messages m ON m.id = r.id
 WHERE r.nth > 1;


-- =============================================================================
-- 2. PLAN — one scratch table. Writes no email data. Re-run it right before §4
--    so the plan is fresh.
-- =============================================================================
--
-- A SECOND PASS (groups §2 held back as 'recent', or new ones the index gate
-- found) is §6 first, then §2, §4, §5, §6 again. §6 finds the threads a pass
-- emptied through the plan, and a deleted loser never shows up in a rebuilt
-- plan — so once §5 has deleted anything, the old plan must outlive the rebuild.
-- The guard below refuses to rebuild while an earlier pass still has emptied
-- threads waiting for §6, and otherwise renames the old plan aside
-- (dedup_plan_20260922_pass_<epoch>) instead of dropping it. Before §5 has
-- deleted anything, the old plan is disposable and is simply replaced.
--
-- One row per MEMBER of every duplicate group (keepers included, so §3 can show
-- whole groups). rn = 1 is the keeper; rn > 1 are losers.
--
-- KEEP RULE, first row in this order within the group:
--   1. not a Junk/Spam folder        — else the mail disappears from the inbox view
--   2. its thread holds OTHER mail    — else we gut the real conversation and keep
--                                       the copy sitting alone in a split-off thread
--   3. from_addr <> ''                — a synced copy over a send-path row
--   4. sent_at, id                    — deterministic; also the copy DD renders,
--                                       because the clone orders sent_at, id and
--                                       DD's dedupeByMessageId keeps the first
-- Attachment count is deliberately NOT a criterion: §5 moves any attachment the
-- keeper lacks onto it, and ranking by count tends to pick the copy that has the
-- DOUBLED attachments.
--
-- EXCLUDED GROUPS (kept in the table with a reason, never touched by §5):
--   'recent'           — a member created within the last hour. DD's client-email
--                        Slack safety-net poll looks back 1h and pre-checks by
--                        row id: deleting a claimed copy of fresh mail can make it
--                        re-post the unclaimed keeper.
--   'content-mismatch' — 1h: not copies of one email. Never merge these.
--   'compose-row'      — 1d, by default. Flip exclude_compose_groups in `opts`
--                        to include them once you have looked.
-- Nested IFs, not one AND: plpgsql plans each condition as a single query, and
-- the log may not exist yet on a first run. The DROP of the old plan is inside
-- the block on purpose: psql -f carries on after an error unless ON_ERROR_STOP
-- is set, so a top-level DROP would still run after the guard fired — losing
-- the plan §6 needs. With it here, a fired guard leaves the plan in place and
-- the CREATE TABLE below fails with "already exists".
DO $$
BEGIN
  IF to_regclass('dedup_log_20260922') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM dedup_log_20260922 WHERE action = 'msg-deleted') THEN
      IF EXISTS (SELECT 1 FROM dedup_log_20260922 l JOIN threads t ON t.id = l.from_id
                  WHERE l.action = 'msg-deleted'
                    AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id)) THEN
        RAISE EXCEPTION 'an earlier pass left emptied loser threads - run §6 (or resolve what its guards left) before rebuilding the plan';
      END IF;
      IF to_regclass('dedup_plan_20260922') IS NOT NULL THEN
        EXECUTE format('ALTER TABLE dedup_plan_20260922 RENAME TO %I',
                       'dedup_plan_20260922_pass_' || (extract(epoch from clock_timestamp()))::bigint);
      END IF;
    END IF;
  END IF;
  EXECUTE 'DROP TABLE IF EXISTS dedup_plan_20260922';
END $$;

CREATE TABLE dedup_plan_20260922 AS
WITH opts AS (
  SELECT true AS exclude_compose_groups,
         (extract(epoch from now()) * 1000)::bigint - 3600000 AS recent_floor_ms
),
dup AS (
  SELECT account_id, direction, message_id
    FROM messages
   WHERE NULLIF(message_id, '') IS NOT NULL AND account_id IS NOT NULL
   GROUP BY account_id, direction, message_id
  HAVING count(*) > 1
),
mem AS (
  SELECT m.id, m.account_id, m.direction, m.message_id, m.thread_id, m.folder,
         m.from_addr, m.subject, m.sent_at, m.created_at,
         coalesce(m.folder, '') ~* '(junk|spam)' AS is_junk,
         md5(coalesce(m.body_text, '') || coalesce(m.body_html, '')) AS body_md5
    FROM messages m
    JOIN dup d ON d.account_id = m.account_id
              AND d.direction  = m.direction
              AND d.message_id = m.message_id
),
-- Messages per thread, and how many of those are members of the SAME group —
-- the difference is "other mail" for keep-rule step 2.
thr AS (
  SELECT thread_id, count(*) AS n
    FROM messages
   WHERE thread_id IN (SELECT thread_id FROM mem)
   GROUP BY thread_id
),
in_grp AS (
  SELECT account_id, direction, message_id, thread_id, count(*) AS n
    FROM mem GROUP BY account_id, direction, message_id, thread_id
),
grp AS (
  SELECT account_id, direction, message_id,
         count(DISTINCT (coalesce(subject, ''), sent_at, body_md5)) AS variants,
         bool_or(folder = 'Sent' AND from_addr = '')                 AS has_compose_row,
         bool_or(created_at > (SELECT recent_floor_ms FROM opts))    AS has_recent
    FROM mem GROUP BY account_id, direction, message_id
),
ranked AS (
  SELECT x.id, x.account_id, x.direction, x.message_id, x.thread_id, x.folder,
         x.from_addr, x.sent_at, x.created_at, x.is_junk,
         thr.n - ig.n AS thread_other_mail,
         row_number() OVER (
           PARTITION BY x.account_id, x.direction, x.message_id
           ORDER BY (NOT x.is_junk) DESC,
                    (thr.n - ig.n > 0) DESC,
                    (coalesce(x.from_addr, '') <> '') DESC,
                    x.sent_at, x.id
         ) AS rn
    FROM mem x
    JOIN thr ON thr.thread_id = x.thread_id
    JOIN in_grp ig ON ig.account_id = x.account_id AND ig.direction = x.direction
                  AND ig.message_id = x.message_id AND ig.thread_id = x.thread_id
),
planned AS (
  SELECT r.*, k.id AS keeper_id, k.thread_id AS keeper_thread,
         CASE WHEN g.has_recent  THEN 'recent'
              WHEN g.variants > 1 THEN 'content-mismatch'
              WHEN g.has_compose_row AND o.exclude_compose_groups THEN 'compose-row'
         END AS excluded
    FROM ranked r
    JOIN ranked k ON k.account_id = r.account_id AND k.direction = r.direction
                 AND k.message_id = r.message_id AND k.rn = 1
    JOIN grp g    ON g.account_id = r.account_id AND g.direction = r.direction
                 AND g.message_id = r.message_id
    CROSS JOIN opts o
)
-- 200 GROUPS per batch (not 200 rows), numbered over the included groups only,
-- so a whole group always lands in one batch and one COMMIT.
SELECT p.*,
       CASE WHEN p.excluded IS NULL THEN
         (dense_rank() OVER (PARTITION BY p.excluded IS NULL
                             ORDER BY p.account_id, p.direction, p.message_id) - 1) / 200
       END AS batch
  FROM planned p;

CREATE INDEX ON dedup_plan_20260922 (id);
CREATE INDEX ON dedup_plan_20260922 (batch, rn);
CREATE INDEX ON dedup_plan_20260922 (keeper_id);
CREATE INDEX ON dedup_plan_20260922 (thread_id);


-- =============================================================================
-- 3. GATES — read-only checks on the plan. Nothing here writes.
-- =============================================================================

-- 3a. Size. ⚠️ STOP if loser_pct_of_all_mail is far from the ~3.6% baseline —
-- in either direction. Far above means the key or the gates have regressed;
-- far below means the sample was unrepresentative, which is fine but worth
-- understanding before deleting anything.
SELECT count(DISTINCT (account_id, direction, message_id)) FILTER (WHERE excluded IS NULL) AS groups_to_fix,
       count(*) FILTER (WHERE excluded IS NULL AND rn > 1)                                 AS losers,
       max(batch) + 1                                                                      AS batches,
       round(100.0 * count(*) FILTER (WHERE excluded IS NULL AND rn > 1)
             / nullif((SELECT count(*) FROM messages), 0), 2)                              AS loser_pct_of_all_mail
  FROM dedup_plan_20260922;

-- 3b. What the gates held back.
SELECT coalesce(excluded, '(included)') AS status,
       count(DISTINCT (account_id, direction, message_id)) AS groups,
       count(*) FILTER (WHERE rn > 1) AS non_keeper_rows
  FROM dedup_plan_20260922
 GROUP BY 1 ORDER BY 1;

-- 3c. Keeper sanity. Should all be 0: a Junk keeper when the group has an inbox
-- copy, and a keeper alone in its thread when another member sits in a thread
-- with other mail — both mean the keep rule is not doing its job.
SELECT count(*) FILTER (WHERE k.is_junk AND EXISTS (
         SELECT 1 FROM dedup_plan_20260922 o WHERE o.keeper_id = k.id AND NOT o.is_junk)) AS junk_keepers,
       count(*) FILTER (WHERE k.thread_other_mail = 0 AND EXISTS (
         SELECT 1 FROM dedup_plan_20260922 o WHERE o.keeper_id = k.id AND o.thread_other_mail > 0
                                              AND NOT o.is_junk)) AS keepers_in_orphan_thread
  FROM dedup_plan_20260922 k
 WHERE k.rn = 1 AND k.excluded IS NULL;

-- 3d. DD references to the rows §5 would delete (same Supabase project, public
-- schema). All four store the clone ROW id, not the RFC Message-ID.
--   slack_client_email_posts  — claim/lock + debug list only. LEFT in place (§9).
--   email_notifications       — orphans stay visible; optional delete (§9).
--   email_satisfaction_scores — orphans keep voting in the median. Deleted (§9).
--   email_drafts.missive_message_id — display only, never looked up. Left.
WITH l AS (SELECT id FROM dedup_plan_20260922 WHERE excluded IS NULL AND rn > 1)
SELECT 'slack_client_email_posts' AS dd_table, count(*) AS rows, NULL::bigint AS clients
  FROM public.slack_client_email_posts x JOIN l ON l.id = x.message_id
UNION ALL
SELECT 'email_notifications', count(*), NULL
  FROM public.email_notifications x JOIN l ON l.id = x.message_id
UNION ALL
SELECT 'email_satisfaction_scores', count(*), count(DISTINCT x.client_id)
  FROM public.email_satisfaction_scores x JOIN l ON l.id = x.message_id
UNION ALL
SELECT 'email_drafts.missive_message_id', count(*), NULL
  FROM public.email_drafts x JOIN l ON l.id = x.missive_message_id;

-- 3e. Loser threads — threads holding a loser but not its keeper. Those that
-- become EMPTY are re-pointed and deleted by §6; those still holding other
-- mail are only reported (a real split conversation, for a later hand merge).
WITH lt AS (
  SELECT DISTINCT thread_id
    FROM dedup_plan_20260922
   WHERE excluded IS NULL AND rn > 1 AND thread_id <> keeper_thread
)
SELECT (SELECT count(*) FROM messages m WHERE m.thread_id = lt.thread_id)
         = (SELECT count(*) FROM dedup_plan_20260922 p
             WHERE p.thread_id = lt.thread_id AND p.excluded IS NULL AND p.rn > 1)
         AS becomes_empty,
       count(*) AS threads
  FROM lt
 GROUP BY 1;

-- 3f. Everything that points at those loser threads, clone- and DD-side, split
-- by whether the thread becomes empty. Clone drafts / scheduled_messages /
-- comments / thread_labels are ON DELETE CASCADE and tasks is SET NULL, so §6
-- MUST re-point them before it deletes a thread — a pending scheduled_messages
-- row here is a customer email that would otherwise silently never send. DD
-- stores thread ids as free text with no FK. §6 re-points DD's scheduled_emails
-- itself, in the same transaction as the delete (the DD runner would otherwise
-- send into the deleted thread, fail, and never retry); §9e re-points the rest.
-- DD intake tasks carry the thread id inside tasks.missive_thread_url
-- ('<MISSIVE_API_URL>/?thread=<id>'); clone thread ids are uuids, so the
-- encodeURIComponent DD applies leaves them unchanged.
WITH lt AS (
  SELECT DISTINCT thread_id
    FROM dedup_plan_20260922
   WHERE excluded IS NULL AND rn > 1 AND thread_id <> keeper_thread
),
s AS (
  SELECT lt.thread_id,
         (SELECT count(*) FROM messages m WHERE m.thread_id = lt.thread_id)
           = (SELECT count(*) FROM dedup_plan_20260922 p
               WHERE p.thread_id = lt.thread_id AND p.excluded IS NULL AND p.rn > 1)
           AS becomes_empty
    FROM lt
),
refs AS (
            SELECT 'clone drafts' AS ref, thread_id FROM drafts
  UNION ALL SELECT 'clone scheduled_messages (' || status || ')', thread_id FROM scheduled_messages
  UNION ALL SELECT 'clone tasks',                    thread_id FROM tasks
  UNION ALL SELECT 'clone comments',                 thread_id FROM comments
  UNION ALL SELECT 'clone thread_labels',            thread_id FROM thread_labels
  UNION ALL SELECT 'dd email_intake_log',            thread_id FROM public.email_intake_log
  UNION ALL SELECT 'dd routing_decisions',           thread_id FROM public.routing_decisions
  UNION ALL SELECT 'dd email_drafts.source_thread_id',  source_thread_id  FROM public.email_drafts
  UNION ALL SELECT 'dd email_drafts.missive_thread_id', missive_thread_id FROM public.email_drafts
  UNION ALL SELECT 'dd inbox_drafts',                thread_id FROM public.inbox_drafts
  UNION ALL SELECT 'dd thread_read_state',           thread_id FROM public.thread_read_state
  UNION ALL SELECT 'dd scheduled_emails',            thread_id FROM public.scheduled_emails
  UNION ALL SELECT 'dd inbox_dismissals',            thread_id FROM public.inbox_dismissals
  UNION ALL SELECT 'dd bulk_email_threads',          thread_id FROM public.bulk_email_threads
  UNION ALL SELECT 'dd email_notifications',         thread_id FROM public.email_notifications
  UNION ALL SELECT 'dd email_satisfaction_scores',   thread_id FROM public.email_satisfaction_scores
  UNION ALL SELECT 'dd slack_client_email_posts',    thread_id FROM public.slack_client_email_posts
  UNION ALL SELECT 'dd tasks.missive_thread_url',
                   substring(missive_thread_url from '[?&]thread=([^&#]+)')
              FROM public.tasks WHERE missive_thread_url LIKE '%thread=%'
)
SELECT s.becomes_empty, r.ref, count(*) AS rows
  FROM s JOIN refs r ON r.thread_id = s.thread_id
 GROUP BY 1, 2 ORDER BY 1 DESC, 2;

-- 3g. Emptied loser threads carrying their OWN state — an assignee, a status
-- other than open, a star, a snooze. §6 deletes these threads, and that state
-- goes with them (it survives only in dedup_bak_threads_20260922). Nothing here
-- carries it over automatically: for each row, decide by hand and apply it to
-- the target (keeper) thread BEFORE §6, e.g.
--   UPDATE threads SET assignee_id = '<user>' WHERE id = '<keeper_thread>' AND assignee_id IS NULL;
WITH lt AS (
  SELECT DISTINCT thread_id, keeper_thread
    FROM dedup_plan_20260922
   WHERE excluded IS NULL AND rn > 1 AND thread_id <> keeper_thread
)
SELECT lt.thread_id AS loser_thread, lt.keeper_thread,
       l.assignee_id, l.status, l.starred, l.snoozed_until, l.team_space_id,
       k.assignee_id AS keeper_assignee, k.status AS keeper_status,
       k.starred AS keeper_starred, k.snoozed_until AS keeper_snoozed_until
  FROM lt
  JOIN threads l ON l.id = lt.thread_id
  JOIN threads k ON k.id = lt.keeper_thread
 WHERE (SELECT count(*) FROM messages m WHERE m.thread_id = lt.thread_id)
         = (SELECT count(*) FROM dedup_plan_20260922 p
             WHERE p.thread_id = lt.thread_id AND p.excluded IS NULL AND p.rn > 1)
   AND (   l.assignee_id IS DISTINCT FROM k.assignee_id
        OR l.status        IS DISTINCT FROM k.status
        OR l.starred       IS DISTINCT FROM k.starred
        OR l.snoozed_until IS DISTINCT FROM k.snoozed_until
        OR l.team_space_id IS DISTINCT FROM k.team_space_id);

-- 3h. Ten whole groups to eyeball: folders, created_at, attachment counts and
-- which thread each copy sits in. Every group should read as "the same email,
-- more than once" — if one doesn't, STOP.
--   SELECT p.account_id, left(p.message_id, 40) AS msgid, p.rn, p.id, p.thread_id,
--          p.folder, p.from_addr, p.sent_at,
--          to_timestamp(p.created_at / 1000.0) AS created,
--          (SELECT count(*) FROM attachments a WHERE a.message_id = p.id) AS atts,
--          p.thread_other_mail, p.keeper_id
--     FROM dedup_plan_20260922 p
--    WHERE (p.account_id, p.direction, p.message_id) IN (
--            SELECT account_id, direction, message_id FROM dedup_plan_20260922
--             WHERE excluded IS NULL GROUP BY 1, 2, 3 ORDER BY random() LIMIT 10)
--    ORDER BY p.account_id, p.message_id, p.rn;


-- #############################################################################
-- ##  DO NOT RUN BELOW THIS LINE UNTIL: §1-3 reviewed and recorded above,     ##
-- ##  loser count is near the baseline, 3c is all zeros, a PITR point / fresh ##
-- ##  backup exists, and it is at least 1 hour after the ingest-lock deploy.  ##
-- #############################################################################


-- =============================================================================
-- 4. SNAPSHOT — backup tables + the log. Uncomment and run once.
-- =============================================================================
-- Confirm first, in the Supabase dashboard (Database → Backups): PITR is on, or
-- a backup was taken in the last few minutes. Note the timestamp here. These
-- tables are the fine-grained undo; PITR is the real safety net.
--
-- Attachment BYTES are deliberately not copied — only metadata plus md5(data).
-- After §5a every loser attachment either moved to the keeper (same id, bytes
-- intact) or has an md5-identical twin on the keeper, which is where §8 copies
-- the bytes back from. Copying them would double the TOAST footprint of the
-- noisiest rows on an instance that is short on space.
--
-- APPEND-ONLY. Every table is created empty if missing and then only gains rows
-- it does not have yet, so a second pass (see §2) adds to the first pass's
-- backups instead of failing on "already exists". NEVER drop one of these to
-- get past an error: the rows a previous pass deleted cannot be snapshotted
-- again, and §8/§9 restore from exactly these tables.
--
-- CREATE TABLE IF NOT EXISTS dedup_bak_messages_20260922 AS
--   SELECT * FROM messages WITH NO DATA;
-- CREATE INDEX IF NOT EXISTS dedup_bak_messages_20260922_id_idx ON dedup_bak_messages_20260922 (id);
-- INSERT INTO dedup_bak_messages_20260922
--   SELECT m.* FROM messages m
--     JOIN dedup_plan_20260922 p ON p.id = m.id
--    WHERE p.excluded IS NULL AND p.rn > 1
--      AND NOT EXISTS (SELECT 1 FROM dedup_bak_messages_20260922 b WHERE b.id = m.id);
--
-- CREATE TABLE IF NOT EXISTS dedup_bak_att_meta_20260922 AS
--   SELECT a.id, a.message_id, a.workspace_id, a.filename, a.content_type,
--          a.size_bytes, a.content_id, md5(a.data) AS data_md5, a.created_at,
--          NULL::text AS keeper_id
--     FROM attachments a WITH NO DATA;
-- CREATE INDEX IF NOT EXISTS dedup_bak_att_meta_20260922_id_idx ON dedup_bak_att_meta_20260922 (id);
-- INSERT INTO dedup_bak_att_meta_20260922
--   SELECT a.id, a.message_id, a.workspace_id, a.filename, a.content_type,
--          a.size_bytes, a.content_id, md5(a.data), a.created_at, p.keeper_id
--     FROM attachments a
--     JOIN dedup_plan_20260922 p ON p.id = a.message_id
--    WHERE p.excluded IS NULL AND p.rn > 1
--      AND NOT EXISTS (SELECT 1 FROM dedup_bak_att_meta_20260922 b WHERE b.id = a.id);
--
-- -- §5b folds loser flags onto the keeper; this is what it overwrites. A keeper
-- -- already backed up by an earlier pass keeps its OLDER row — that is the
-- -- state from before any fold.
-- CREATE TABLE IF NOT EXISTS dedup_bak_keepers_20260922 AS
--   SELECT m.id, m.has_attachments, m.provider_conversation_id,
--          m.is_automated, m.is_weekly_update
--     FROM messages m WITH NO DATA;
-- CREATE INDEX IF NOT EXISTS dedup_bak_keepers_20260922_id_idx ON dedup_bak_keepers_20260922 (id);
-- INSERT INTO dedup_bak_keepers_20260922
--   SELECT m.id, m.has_attachments, m.provider_conversation_id,
--          m.is_automated, m.is_weekly_update
--     FROM messages m
--    WHERE m.id IN (SELECT keeper_id FROM dedup_plan_20260922 WHERE excluded IS NULL)
--      AND NOT EXISTS (SELECT 1 FROM dedup_bak_keepers_20260922 b WHERE b.id = m.id);
--
-- -- Whole rows, so §8 restores a deleted thread with its assignee, status,
-- -- star, snooze and team space — not the reconstruction merge_split_threads
-- -- had to settle for.
-- CREATE TABLE IF NOT EXISTS dedup_bak_threads_20260922 AS
--   SELECT * FROM threads WITH NO DATA;
-- CREATE INDEX IF NOT EXISTS dedup_bak_threads_20260922_id_idx ON dedup_bak_threads_20260922 (id);
-- INSERT INTO dedup_bak_threads_20260922
--   SELECT t.* FROM threads t
--    WHERE t.id IN (SELECT thread_id FROM dedup_plan_20260922
--                    WHERE excluded IS NULL AND rn > 1 AND thread_id <> keeper_thread)
--      AND NOT EXISTS (SELECT 1 FROM dedup_bak_threads_20260922 b WHERE b.id = t.id);
--
-- CREATE TABLE IF NOT EXISTS dedup_log_20260922 (
--   run_at      BIGINT NOT NULL,
--   action      TEXT   NOT NULL,  -- att-moved | msg-deleted | thread-repoint |
--                                 -- draft-dropped | thread-deleted | att-double-deleted
--   table_name  TEXT   NOT NULL,
--   row_id      TEXT   NOT NULL,  -- drafts have no id: 'user_id:thread_id';
--                                 -- thread_labels: the label_id
--   from_id     TEXT,             -- previous parent (message or thread)
--   to_id       TEXT              -- new parent / keeper
-- );
-- CREATE INDEX IF NOT EXISTS dedup_log_20260922_action_row_idx ON dedup_log_20260922 (action, row_id);
--
-- -- Verify: every planned loser is backed up (expect 0). The table totals
-- -- include earlier passes, so compare coverage, not counts.
-- SELECT (SELECT count(*) FROM dedup_plan_20260922 p
--          WHERE p.excluded IS NULL AND p.rn > 1
--            AND NOT EXISTS (SELECT 1 FROM dedup_bak_messages_20260922 b WHERE b.id = p.id)) AS losers_not_backed_up,
--        (SELECT count(*) FROM dedup_plan_20260922 WHERE excluded IS NULL AND rn > 1) AS plan_losers,
--        (SELECT count(*) FROM dedup_bak_messages_20260922) AS bak_messages_all_passes,
--        (SELECT count(*) FROM dedup_bak_att_meta_20260922) AS bak_attachments_all_passes,
--        (SELECT count(*) FROM dedup_bak_threads_20260922)  AS bak_threads_all_passes;


-- =============================================================================
-- 5. APPLY — batched. Session-mode psql connection only (see header).
-- =============================================================================
-- Run BATCH 0 ALONE first (b_from = 0, b_to = 0). Check it: re-run 1a (extra
-- rows down by batch 0's losers), open a couple of the affected threads in DD,
-- and look at the log. Then set b_from = 0, b_to = NULL (= the last batch) and
-- run everything. Starting again at 0 costs nothing, because every step is
-- guarded. It is also safe if the plan was rebuilt in between and the batches
-- were renumbered. Starting at 1 would silently skip whatever the new batch 0
-- holds.
--
-- statement_timeout = 0 is REQUIRED, not a convenience: a DO block is ONE
-- top-level statement, so any finite timeout covers every batch plus every
-- pg_sleep and kills the run partway. lock_timeout = 5s keeps a batch from
-- queueing behind live ingest; if it fires, the block stops with the finished
-- batches committed — just re-run from the failed batch.
--
-- RE-RUNNABLE. Every step is guarded by "still true?": a loser already deleted
-- is skipped, an attachment the keeper already has is not moved again, and a
-- loser whose keeper has vanished, or whose row no longer carries the planned
-- key (relinked meanwhile), is left alone.
--
-- SET statement_timeout = 0;
-- SET lock_timeout = '5s';
--
-- DO $$
-- DECLARE
--   b_from INT := 0;   -- first run: 0 / 0. Second run: 0 / NULL.
--   b_to   INT := 0;
--   v_batch INT;
--   v_run_at BIGINT := (extract(epoch from clock_timestamp()) * 1000)::bigint;
--   n_att  INT;
--   n_del  INT;
-- BEGIN
--   -- -1 when no group is included (a clean database, or a pass where every
--   -- remaining group is excluded): the loop then runs zero times.
--   IF b_to IS NULL THEN
--     SELECT coalesce(max(batch), -1) INTO b_to FROM dedup_plan_20260922;
--   END IF;
--
--   FOR v_batch IN b_from .. b_to LOOP
--     -- No snapshot, no delete. Catches a plan rebuilt after §4 ran.
--     IF EXISTS (SELECT 1 FROM dedup_plan_20260922 p
--                 WHERE p.batch = v_batch AND p.rn > 1
--                   AND NOT EXISTS (SELECT 1 FROM dedup_bak_messages_20260922 k WHERE k.id = p.id)) THEN
--       RAISE EXCEPTION 'batch %: loser missing from dedup_bak_messages_20260922 — re-run §4', v_batch;
--     END IF;
--
--     -- 5a. Move to the keeper one copy of every attachment it lacks (same
--     -- filename, size, content_id AND bytes). The rest of the losers'
--     -- attachments go with the cascade in 5c; each has a twin on the keeper.
--     -- Accepted: a file a loser legitimately carries twice (one insert batch)
--     -- that the keeper lacks arrives on the keeper once, not twice.
--     WITH l AS (
--       SELECT p.id, p.keeper_id
--         FROM dedup_plan_20260922 p
--         JOIN messages m ON m.id = p.id
--                        AND m.account_id = p.account_id
--                        AND m.direction  = p.direction
--                        AND m.message_id = p.message_id
--        WHERE p.batch = v_batch AND p.rn > 1
--          AND EXISTS (SELECT 1 FROM messages k WHERE k.id = p.keeper_id)
--     ),
--     cand AS (
--       SELECT DISTINCT ON (l.keeper_id, a.filename, a.size_bytes,
--                           coalesce(a.content_id, ''), md5(a.data))
--              a.id, a.message_id AS from_msg, l.keeper_id
--         FROM l JOIN attachments a ON a.message_id = l.id
--        WHERE NOT EXISTS (
--                SELECT 1 FROM attachments k
--                 WHERE k.message_id = l.keeper_id
--                   AND k.filename   = a.filename
--                   AND k.size_bytes = a.size_bytes
--                   AND coalesce(k.content_id, '') = coalesce(a.content_id, '')
--                   AND md5(k.data)  = md5(a.data))
--        ORDER BY l.keeper_id, a.filename, a.size_bytes,
--                 coalesce(a.content_id, ''), md5(a.data), a.created_at, a.id
--     ),
--     mv AS (
--       UPDATE attachments a SET message_id = c.keeper_id
--         FROM cand c WHERE a.id = c.id
--       RETURNING a.id, c.from_msg, c.keeper_id
--     )
--     INSERT INTO dedup_log_20260922 (run_at, action, table_name, row_id, from_id, to_id)
--     SELECT v_run_at, 'att-moved', 'attachments', id, from_msg, keeper_id FROM mv;
--     GET DIAGNOSTICS n_att = ROW_COUNT;
--
--     -- 5b. Fold the losers' flags into the keeper. provider_conversation_id is
--     -- what findOrCreateThread reunites conversations by; is_automated keeps a
--     -- bulk blast out of DD's touchpoint health even if only one copy had it.
--     -- has_attachments only ever goes UP here.
--     UPDATE messages k
--        SET has_attachments = GREATEST(k.has_attachments,
--              CASE WHEN EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = k.id)
--                   THEN 1 ELSE 0 END),
--            provider_conversation_id = coalesce(k.provider_conversation_id, f.pcid),
--            is_automated     = GREATEST(k.is_automated,     f.automated),
--            is_weekly_update = GREATEST(k.is_weekly_update, f.weekly)
--       FROM (SELECT p.keeper_id,
--                    max(m.provider_conversation_id) AS pcid,
--                    max(m.is_automated)             AS automated,
--                    max(m.is_weekly_update)         AS weekly
--               FROM dedup_plan_20260922 p JOIN messages m ON m.id = p.id
--              WHERE p.batch = v_batch AND p.rn > 1
--              GROUP BY p.keeper_id) f
--      WHERE k.id = f.keeper_id;
--
--     -- 5c. Delete the losers, same guards as 5a. Their remaining attachments
--     -- go with the ON DELETE CASCADE.
--     WITH d AS (
--       DELETE FROM messages m
--        USING dedup_plan_20260922 p
--        WHERE p.batch = v_batch AND p.rn > 1
--          AND m.id = p.id
--          AND m.account_id = p.account_id
--          AND m.direction  = p.direction
--          AND m.message_id = p.message_id
--          AND EXISTS (SELECT 1 FROM messages k WHERE k.id = p.keeper_id)
--       RETURNING m.id, m.thread_id, p.keeper_id
--     )
--     INSERT INTO dedup_log_20260922 (run_at, action, table_name, row_id, from_id, to_id)
--     SELECT v_run_at, 'msg-deleted', 'messages', id, thread_id, keeper_id FROM d;
--     GET DIAGNOSTICS n_del = ROW_COUNT;
--
--     RAISE NOTICE 'batch % of %: % attachment(s) moved, % message(s) deleted',
--                  v_batch, b_to, n_att, n_del;
--     COMMIT;
--     PERFORM pg_sleep(1);  -- let ingest and DD reads breathe on the MICRO instance
--   END LOOP;
-- END $$;
--
-- -- Back to the header's 10min and to no lock timeout, explicitly. RESET would
-- -- fall to the role or connection default, which nobody here chose.
-- SET statement_timeout = '10min';
-- SET lock_timeout = 0;
--
-- Check after each run:
--   SELECT action, count(*) FROM dedup_log_20260922 GROUP BY 1;
--   -- losers still present (expect 0 once every batch ran; anything left was
--   -- skipped by a guard — look at why):
--   SELECT count(*) FROM dedup_plan_20260922 p JOIN messages m ON m.id = p.id
--    WHERE p.excluded IS NULL AND p.rn > 1;


-- =============================================================================
-- 6. THREADS — only loser threads that §5 left EMPTY. One transaction.
-- =============================================================================
-- Same re-point pattern as merge_split_threads.sql §3, for every table with a
-- thread_id FK to threads (db.js: messages, comments, drafts, tasks,
-- thread_labels, scheduled_messages). No identity fold is needed: the thread
-- held only copies of mail its target thread already has.
--
-- ACYCLIC, BY CONSTRUCTION. A target is a keeper's thread, and a keeper is never
-- deleted, so no target can itself be an emptied loser thread.
--
-- The thread's own assignee / status / star / snooze are NOT carried over.
-- Re-run §3g first and apply anything worth keeping to the target by hand.
--
-- BEGIN;
--
-- CREATE TEMP TABLE run ON COMMIT DROP AS
--   SELECT (extract(epoch from clock_timestamp()) * 1000)::bigint AS at;
--
-- -- One target per emptied thread: the keeper thread that received most of
-- -- its losers (almost always the only one), then lowest id — deterministic.
-- CREATE TEMP TABLE tplan ON COMMIT DROP AS
-- SELECT DISTINCT ON (from_thread_id) from_thread_id, to_thread_id
--   FROM (SELECT p.thread_id AS from_thread_id, p.keeper_thread AS to_thread_id,
--                count(*) AS n
--           FROM dedup_plan_20260922 p
--          WHERE p.excluded IS NULL AND p.rn > 1 AND p.thread_id <> p.keeper_thread
--            AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = p.id)
--            AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = p.thread_id)
--            AND EXISTS (SELECT 1 FROM threads t WHERE t.id = p.keeper_thread)
--          GROUP BY 1, 2) s
--  ORDER BY from_thread_id, n DESC, to_thread_id;
--
-- -- DRAFTS. PRIMARY KEY (user_id, thread_id), so a move can collide two ways:
-- -- the user already has a draft on the target, or the user has drafts on two
-- -- loser threads that map to the same target. Drop every draft that cannot
-- -- move — all of the first kind; for the second, all but the most recently
-- -- edited one — and move the rest. Decided up front so the log below only
-- -- records a 'thread-repoint' for drafts that really move; §8 moves those back
-- -- by (user, target) and would otherwise grab the user's own target draft.
-- CREATE TEMP TABLE draft_drop ON COMMIT DROP AS
-- SELECT x.user_id, x.thread_id AS from_thread_id, x.to_thread_id
--   FROM (SELECT d.user_id, d.thread_id, p.to_thread_id,
--                row_number() OVER (PARTITION BY d.user_id, p.to_thread_id
--                                   ORDER BY d.updated_at DESC, d.thread_id) AS rn
--           FROM tplan p JOIN drafts d ON d.thread_id = p.from_thread_id) x
--  WHERE x.rn > 1
--     OR EXISTS (SELECT 1 FROM drafts w WHERE w.thread_id = x.to_thread_id AND w.user_id = x.user_id);
--
-- -- Whole rows of what is dropped, so §8 can put a typed reply back instead of
-- -- leaving it to PITR. Append-only, like §4.
-- CREATE TABLE IF NOT EXISTS dedup_bak_drafts_20260922 AS
--   SELECT * FROM drafts WITH NO DATA;
-- INSERT INTO dedup_bak_drafts_20260922
--   SELECT d.* FROM drafts d
--     JOIN draft_drop x ON x.user_id = d.user_id AND x.from_thread_id = d.thread_id
--    WHERE NOT EXISTS (SELECT 1 FROM dedup_bak_drafts_20260922 b
--                       WHERE b.user_id = d.user_id AND b.thread_id = d.thread_id);
--
-- -- Record everything we are about to touch, before touching any of it.
-- INSERT INTO dedup_log_20260922 (run_at, action, table_name, row_id, from_id, to_id)
--   SELECT r.at, 'draft-dropped', 'drafts', x.user_id || ':' || x.from_thread_id, x.from_thread_id, x.to_thread_id
--     FROM draft_drop x CROSS JOIN run r
--   UNION ALL
--   SELECT r.at, 'thread-repoint', 'drafts', d.user_id || ':' || d.thread_id, p.from_thread_id, p.to_thread_id
--     FROM tplan p JOIN drafts d ON d.thread_id = p.from_thread_id CROSS JOIN run r
--    WHERE NOT EXISTS (SELECT 1 FROM draft_drop x
--                       WHERE x.user_id = d.user_id AND x.from_thread_id = d.thread_id)
--   UNION ALL
--   SELECT r.at, 'thread-repoint', 'dd scheduled_emails', s.id, p.from_thread_id, p.to_thread_id
--     FROM tplan p JOIN public.scheduled_emails s ON s.thread_id = p.from_thread_id CROSS JOIN run r
--   UNION ALL
--   SELECT r.at, 'thread-repoint', 'scheduled_messages', s.id, p.from_thread_id, p.to_thread_id
--     FROM tplan p JOIN scheduled_messages s ON s.thread_id = p.from_thread_id CROSS JOIN run r
--   UNION ALL
--   SELECT r.at, 'thread-repoint', 'tasks', k.id, p.from_thread_id, p.to_thread_id
--     FROM tplan p JOIN tasks k ON k.thread_id = p.from_thread_id CROSS JOIN run r
--   UNION ALL
--   SELECT r.at, 'thread-repoint', 'comments', c.id, p.from_thread_id, p.to_thread_id
--     FROM tplan p JOIN comments c ON c.thread_id = p.from_thread_id CROSS JOIN run r
--   UNION ALL
--   SELECT r.at, 'thread-repoint', 'thread_labels', tl.label_id, p.from_thread_id, p.to_thread_id
--     FROM tplan p JOIN thread_labels tl ON tl.thread_id = p.from_thread_id CROSS JOIN run r;
--
-- DELETE FROM drafts d USING draft_drop x
--  WHERE d.user_id = x.user_id AND d.thread_id = x.from_thread_id;
-- UPDATE drafts d SET thread_id = p.to_thread_id
--   FROM tplan p WHERE d.thread_id = p.from_thread_id;
--
-- -- Without these the DELETE below cascades them away (drafts,
-- -- scheduled_messages, comments, thread_labels) or nulls them (tasks) — a
-- -- queued customer email would simply never be sent, with no error anywhere.
-- -- DD's scheduled_emails has no FK, but its runner sends a pending reply INTO
-- -- the thread: left for §9e, a reply due in between would go to a deleted
-- -- thread, be marked 'failed' and never retried. Same database, so it moves
-- -- here, in this transaction.
-- UPDATE public.scheduled_emails s SET thread_id = p.to_thread_id
--   FROM tplan p WHERE s.thread_id = p.from_thread_id;
-- UPDATE scheduled_messages s SET thread_id = p.to_thread_id
--   FROM tplan p WHERE s.thread_id = p.from_thread_id;
-- UPDATE tasks k SET thread_id = p.to_thread_id
--   FROM tplan p WHERE k.thread_id = p.from_thread_id;
-- UPDATE comments c SET thread_id = p.to_thread_id
--   FROM tplan p WHERE c.thread_id = p.from_thread_id;
--
-- INSERT INTO thread_labels (thread_id, label_id)
-- SELECT DISTINCT p.to_thread_id, tl.label_id
--   FROM tplan p JOIN thread_labels tl ON tl.thread_id = p.from_thread_id
--  WHERE NOT EXISTS (SELECT 1 FROM thread_labels x
--                     WHERE x.thread_id = p.to_thread_id AND x.label_id = tl.label_id);
-- DELETE FROM thread_labels tl USING tplan p WHERE tl.thread_id = p.from_thread_id;
--
-- -- Drop the now-empty threads. Every guard must hold, so a bug above degrades
-- -- to "cleanup didn't finish" rather than to data loss.
-- WITH gone AS (
--   DELETE FROM threads t
--    USING tplan p
--    WHERE t.id = p.from_thread_id
--      AND NOT EXISTS (SELECT 1 FROM messages           x WHERE x.thread_id = t.id)
--      AND NOT EXISTS (SELECT 1 FROM drafts             x WHERE x.thread_id = t.id)
--      AND NOT EXISTS (SELECT 1 FROM scheduled_messages x WHERE x.thread_id = t.id)
--      AND NOT EXISTS (SELECT 1 FROM comments           x WHERE x.thread_id = t.id)
--      AND NOT EXISTS (SELECT 1 FROM thread_labels      x WHERE x.thread_id = t.id)
--      AND NOT EXISTS (SELECT 1 FROM tasks              x WHERE x.thread_id = t.id)
--   RETURNING t.id, p.to_thread_id
-- )
-- INSERT INTO dedup_log_20260922 (run_at, action, table_name, row_id, from_id, to_id)
-- SELECT r.at, 'thread-deleted', 'threads', g.id, g.id, g.to_thread_id FROM gone g, run r;
--
-- COMMIT;
--
-- Loser threads that still hold other mail — REPORT ONLY. These are genuinely
-- split conversations (both halves have their own mail); merge them later by
-- hand with the merge_split_threads.sql approach. Do not invent a rule here: the
-- merge rule that "sounded right" last time matched half the database.
-- Their last_message_at may now be a little high (it counted the deleted copy);
-- the next message in the thread corrects it.
--   SELECT DISTINCT p.thread_id AS loser_thread, p.keeper_thread,
--          (SELECT count(*) FROM messages m WHERE m.thread_id = p.thread_id) AS msgs_left
--     FROM dedup_plan_20260922 p
--    WHERE p.excluded IS NULL AND p.rn > 1 AND p.thread_id <> p.keeper_thread
--      AND EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = p.thread_id)
--    ORDER BY msgs_left DESC;


-- =============================================================================
-- 7. ATT DUPES — doubled attachment rows within one message. One transaction.
-- =============================================================================
-- Run after §5, so attachments it moved are judged on their new message.
-- Partition = same message, filename, size, content_id AND bytes. Within it,
-- keep every row from the FIRST insert batch (same created_at as the earliest
-- row) and delete only rows from a later insert. A message that genuinely
-- carries the same file twice had both rows written by one INSERT with one
-- timestamp, so it survives. md5(data) reads TOAST only for the 1g candidates.
--
-- BEGIN;
--
-- CREATE TEMP TABLE run ON COMMIT DROP AS
--   SELECT (extract(epoch from clock_timestamp()) * 1000)::bigint AS at;
--
-- CREATE TEMP TABLE att_dbl ON COMMIT DROP AS
-- WITH cand AS (   -- the 1g prefilter: heap metadata only
--   SELECT DISTINCT message_id
--     FROM attachments
--    GROUP BY message_id, filename, size_bytes, coalesce(content_id, '')
--   HAVING count(*) > 1 AND count(DISTINCT created_at) > 1
-- ),
-- c AS (
--   SELECT a.id, a.message_id, a.workspace_id, a.filename, a.content_type,
--          a.size_bytes, a.content_id, md5(a.data) AS data_md5, a.created_at,
--          min(a.created_at)  OVER w                              AS first_batch,
--          first_value(a.id)  OVER (w ORDER BY a.created_at, a.id) AS kept_twin_id,
--          row_number()       OVER (w ORDER BY a.created_at, a.id) AS rn
--     FROM attachments a
--    WHERE a.message_id IN (SELECT message_id FROM cand)
--   WINDOW w AS (PARTITION BY a.message_id, a.filename, a.size_bytes,
--                             coalesce(a.content_id, ''), md5(a.data))
-- )
-- SELECT id, message_id, workspace_id, filename, content_type, size_bytes,
--        content_id, data_md5, created_at, kept_twin_id
--   FROM c
--  WHERE rn > 1 AND created_at <> first_batch;
--
-- -- Metadata backup. The bytes live on in kept_twin_id (same md5 by construction).
-- CREATE TABLE IF NOT EXISTS dedup_bak_att_doubles_20260922 AS
--   SELECT * FROM att_dbl WITH NO DATA;
-- INSERT INTO dedup_bak_att_doubles_20260922 SELECT * FROM att_dbl;
--
-- WITH d AS (
--   DELETE FROM attachments a USING att_dbl x WHERE a.id = x.id
--   RETURNING a.id, a.message_id, x.kept_twin_id
-- )
-- INSERT INTO dedup_log_20260922 (run_at, action, table_name, row_id, from_id, to_id)
-- SELECT r.at, 'att-double-deleted', 'attachments', d.id, d.message_id, d.kept_twin_id
--   FROM d, run r;
--
-- COMMIT;
--
-- has_attachments needs no change: every affected message keeps its twin.


-- =============================================================================
-- 8. ROLLBACK — restore from the snapshot. One transaction.
-- =============================================================================
-- ⚠️ ROWS, NOT SIDE EFFECTS. This puts the clone rows back. It does not undo
-- what DD already did with them (Slack posts, notifications, scores — §9 keeps
-- its own backup of the scores it deletes), it does not remove labels §6 added
-- to a target thread, and it does not undo §9e's DD re-points. For a true
-- restore, use PITR. Everything restores by id, so the app keeps its links.
--
-- ORDER MATTERS: threads before messages (FK), and step 4 (re-create the
-- cascaded loser attachments, bytes copied from the keeper) BEFORE step 5 (move
-- the 5a attachments back) — once a moved attachment leaves the keeper, its
-- bytes are no longer there to copy from.
--
-- PRECONDITION — the unique index. Once create_unique_message_index.sql has
-- built uq_messages_acct_dir_msgid, step 3 cannot work: every restored loser is
-- a duplicate of its keeper by definition, so it raises 23505 on that index and
-- aborts the whole transaction (ON CONFLICT (id) arbitrates the primary key
-- only — and a bare ON CONFLICT DO NOTHING would silently skip the restore
-- instead, which is worse). Drop the index first, outside any transaction:
--   DROP INDEX CONCURRENTLY IF EXISTS missive.uq_messages_acct_dir_msgid;
-- It can be rebuilt only after the restored duplicates are cleaned again. The
-- check below refuses to start while the index exists.
--
-- DO $$
-- BEGIN
--   IF to_regclass('missive.uq_messages_acct_dir_msgid') IS NOT NULL THEN
--     RAISE EXCEPTION 'drop missive.uq_messages_acct_dir_msgid first - see the §8 precondition';
--   END IF;
-- END $$;
--
-- BEGIN;
--
-- -- 1. Threads §6 deleted, whole rows from the snapshot.
-- INSERT INTO threads
-- SELECT b.* FROM dedup_bak_threads_20260922 b
--  WHERE b.id IN (SELECT row_id FROM dedup_log_20260922 WHERE action = 'thread-deleted')
-- ON CONFLICT (id) DO NOTHING;
--
-- -- 2. Their children, back to the original thread.
-- UPDATE scheduled_messages s SET thread_id = l.from_id
--   FROM dedup_log_20260922 l
--  WHERE l.action = 'thread-repoint' AND l.table_name = 'scheduled_messages' AND s.id = l.row_id;
-- UPDATE tasks k SET thread_id = l.from_id
--   FROM dedup_log_20260922 l
--  WHERE l.action = 'thread-repoint' AND l.table_name = 'tasks' AND k.id = l.row_id;
-- UPDATE comments c SET thread_id = l.from_id
--   FROM dedup_log_20260922 l
--  WHERE l.action = 'thread-repoint' AND l.table_name = 'comments' AND c.id = l.row_id;
-- UPDATE public.scheduled_emails s SET thread_id = l.from_id
--   FROM dedup_log_20260922 l
--  WHERE l.action = 'thread-repoint' AND l.table_name = 'dd scheduled_emails'
--    AND s.id = l.row_id AND s.thread_id = l.to_id;
-- -- Drafts have no id, so a moved one is found by (user, target thread). That
-- -- row is only ours if §6 moved it: for a dropped draft it is the user's own
-- -- draft on the target. §6 logs 'thread-repoint' for moved drafts only; the
-- -- NOT EXISTS makes sure of it here too.
-- UPDATE drafts d SET thread_id = l.from_id
--   FROM dedup_log_20260922 l
--  WHERE l.action = 'thread-repoint' AND l.table_name = 'drafts'
--    AND d.user_id = split_part(l.row_id, ':', 1) AND d.thread_id = l.to_id
--    AND NOT EXISTS (SELECT 1 FROM dedup_log_20260922 x
--                     WHERE x.action = 'draft-dropped' AND x.row_id = l.row_id);
-- -- Then the drafts §6 dropped, whole rows from its backup, back on their
-- -- original (now restored) thread. (§6 creates the backup table; if §6
-- -- never ran, skip this statement.)
-- INSERT INTO drafts
-- SELECT b.* FROM dedup_bak_drafts_20260922 b
--  WHERE EXISTS (SELECT 1 FROM threads t WHERE t.id = b.thread_id)
-- ON CONFLICT DO NOTHING;
-- INSERT INTO thread_labels (thread_id, label_id)
-- SELECT l.from_id, l.row_id FROM dedup_log_20260922 l
--  WHERE l.action = 'thread-repoint' AND l.table_name = 'thread_labels'
--    AND EXISTS (SELECT 1 FROM labels x WHERE x.id = l.row_id)
-- ON CONFLICT DO NOTHING;
--
-- -- 3. The deleted messages. SELECT * works because the snapshot was taken as
-- -- messages.*; if a column has been added to messages since, list the columns.
-- INSERT INTO messages
-- SELECT b.* FROM dedup_bak_messages_20260922 b
--  WHERE EXISTS (SELECT 1 FROM threads t WHERE t.id = b.thread_id)
-- ON CONFLICT (id) DO NOTHING;
--
-- -- 4. Loser attachments the cascade removed (every one NOT moved by 5a),
-- -- bytes copied from the md5-identical row on the keeper.
-- INSERT INTO attachments (id, message_id, workspace_id, filename, content_type,
--                          size_bytes, content_id, data, created_at)
-- SELECT b.id, b.message_id, b.workspace_id, b.filename, b.content_type,
--        b.size_bytes, b.content_id, src.data, b.created_at
--   FROM dedup_bak_att_meta_20260922 b
--   JOIN LATERAL (SELECT x.data FROM attachments x
--                  WHERE x.message_id = b.keeper_id
--                    AND x.size_bytes = b.size_bytes
--                    AND md5(x.data)  = b.data_md5
--                  LIMIT 1) src ON TRUE
--  WHERE NOT EXISTS (SELECT 1 FROM attachments a WHERE a.id = b.id)
--    AND EXISTS (SELECT 1 FROM messages m WHERE m.id = b.message_id);
--
-- -- 5. Attachments 5a moved, back to their loser.
-- UPDATE attachments a SET message_id = l.from_id
--   FROM dedup_log_20260922 l
--  WHERE l.action = 'att-moved' AND a.id = l.row_id
--    AND EXISTS (SELECT 1 FROM messages m WHERE m.id = l.from_id);
--
-- -- 6. Keeper flags as they were before 5b.
-- UPDATE messages m
--    SET has_attachments = k.has_attachments,
--        provider_conversation_id = k.provider_conversation_id,
--        is_automated = k.is_automated,
--        is_weekly_update = k.is_weekly_update
--   FROM dedup_bak_keepers_20260922 k WHERE m.id = k.id;
--
-- -- 7. §7's doubled attachments, bytes from the twin that was kept.
-- INSERT INTO attachments (id, message_id, workspace_id, filename, content_type,
--                          size_bytes, content_id, data, created_at)
-- SELECT b.id, b.message_id, b.workspace_id, b.filename, b.content_type,
--        b.size_bytes, b.content_id, t.data, b.created_at
--   FROM dedup_bak_att_doubles_20260922 b
--   JOIN attachments t ON t.id = b.kept_twin_id
--  WHERE NOT EXISTS (SELECT 1 FROM attachments a WHERE a.id = b.id);
--
-- -- Verify BEFORE committing. Expect 0 / 0: anything else is a row whose bytes
-- -- source was gone (keeper deleted since) — decide whether PITR is needed.
-- SELECT (SELECT count(*) FROM dedup_bak_messages_20260922 b
--          WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = b.id)) AS messages_not_restored,
--        (SELECT count(*) FROM dedup_bak_att_meta_20260922 b
--          WHERE NOT EXISTS (SELECT 1 FROM attachments a WHERE a.id = b.id)) AS attachments_not_restored;
--
-- COMMIT;
--
-- Then rename the log (e.g. to dedup_log_20260922_rolled_back) so a later run
-- starts clean, and restore §9's scores:
--   INSERT INTO public.email_satisfaction_scores
--   SELECT * FROM missive.dedup_bak_scores_20260922 ON CONFLICT DO NOTHING;


-- =============================================================================
-- 9. DD — DelegationDoer follow-up (same Supabase project, public schema).
-- =============================================================================
-- DD stores clone row ids and thread ids as free text with NO foreign key, so
-- nothing above touched them — except scheduled_emails.thread_id, which §6
-- re-points itself (see there).
--
-- 9a. email_satisfaction_scores — the one that actually hurts. Every copy was
-- scored, and recomputeClientHealth takes the median over EVERY row for the
-- client, orphans included; the cron only recomputes clients it newly scored,
-- so this never heals on its own. Count first:
--   SELECT count(*) AS scores, count(DISTINCT client_id) AS clients
--     FROM public.email_satisfaction_scores s
--    WHERE s.message_id IN (SELECT id FROM missive.dedup_bak_messages_20260922)
--      AND NOT EXISTS (SELECT 1 FROM missive.messages m WHERE m.id = s.message_id);
--
-- Then back up and delete (the NOT EXISTS keeps this safe after a rollback):
--   BEGIN;
--   CREATE TABLE missive.dedup_bak_scores_20260922 AS
--     SELECT s.* FROM public.email_satisfaction_scores s
--      WHERE s.message_id IN (SELECT id FROM missive.dedup_bak_messages_20260922)
--        AND NOT EXISTS (SELECT 1 FROM missive.messages m WHERE m.id = s.message_id);
--   DELETE FROM public.email_satisfaction_scores s
--    USING missive.dedup_bak_scores_20260922 b
--    WHERE s.message_id = b.message_id AND s.client_id = b.client_id;
--   COMMIT;
--
-- Then RECOMPUTE the affected clients' health — deleting rows alone leaves the
-- stored median stale:
--   SELECT DISTINCT client_id FROM missive.dedup_bak_scores_20260922;
-- and POST those ids to DD's /api/admin/score-client  { "clientIds": [...] }
-- (leader session, or Authorization: Bearer <CRON_SECRET>). It re-scores the
-- client's recent mail — which also scores the keeper if only a deleted copy
-- had been scored — and recomputes the median.
--
-- 9b. email_notifications — OPTIONAL. Orphans stay readable (subject, preview
-- and the thread link all work, the link goes by thread_id) and never
-- re-notify: the poller floor is max(received_at). Deleting them only fixes the
-- inflated unseen count on the home card.
--   SELECT count(*) FROM public.email_notifications n
--    WHERE n.message_id IN (SELECT id FROM missive.dedup_bak_messages_20260922)
--      AND NOT EXISTS (SELECT 1 FROM missive.messages m WHERE m.id = n.message_id);
--   DELETE FROM public.email_notifications n
--    WHERE n.message_id IN (SELECT id FROM missive.dedup_bak_messages_20260922)
--      AND NOT EXISTS (SELECT 1 FROM missive.messages m WHERE m.id = n.message_id);
--
-- 9c. slack_client_email_posts — LEAVE THEM. A claim row is a lock plus a line
-- in the debug list; deleting it gains nothing and could let the safety-net poll
-- treat the mail as unposted. (The §2 1-hour exclusion is what keeps the poll
-- from re-posting a now-unclaimed keeper.)
--
-- 9d. email_drafts.missive_message_id — leave. Display only, never looked up.
--
-- 9e. DD thread-keyed rows on threads §6 DELETED. Re-point to the target thread;
-- where the target already has a row under the same primary/unique key, leave
-- the old one and list it (it points at a thread that no longer exists, which
-- DD tolerates — it just renders nothing).
--   CREATE TEMP TABLE tmap AS
--     SELECT row_id AS from_thread_id, to_id AS to_thread_id
--       FROM missive.dedup_log_20260922 WHERE action = 'thread-deleted';
--
--   BEGIN;
--   -- No uniqueness on thread_id — plain re-point.
--   -- (scheduled_emails is not here: §6 already moved it, before the delete.)
--   UPDATE public.routing_decisions x SET thread_id = m.to_thread_id FROM tmap m WHERE x.thread_id = m.from_thread_id;
--   UPDATE public.email_notifications x SET thread_id = m.to_thread_id FROM tmap m WHERE x.thread_id = m.from_thread_id;
--   UPDATE public.email_satisfaction_scores x SET thread_id = m.to_thread_id FROM tmap m WHERE x.thread_id = m.from_thread_id;
--   UPDATE public.email_drafts x SET source_thread_id  = m.to_thread_id FROM tmap m WHERE x.source_thread_id  = m.from_thread_id;
--   UPDATE public.email_drafts x SET missive_thread_id = m.to_thread_id FROM tmap m WHERE x.missive_thread_id = m.from_thread_id;
--   -- Intake tasks link to their thread through the URL ('…/?thread=<id>').
--   -- Matched on the extracted id, not a LIKE, so one id can't prefix-match
--   -- another.
--   UPDATE public.tasks x
--      SET missive_thread_url = replace(x.missive_thread_url, 'thread=' || m.from_thread_id,
--                                                             'thread=' || m.to_thread_id)
--     FROM tmap m
--    WHERE x.missive_thread_url LIKE '%thread=%'
--      AND substring(x.missive_thread_url from '[?&]thread=([^&#]+)') = m.from_thread_id;
--   -- PRIMARY KEY (thread_id): only when the target has no row of its own.
--   UPDATE public.email_intake_log   x SET thread_id = m.to_thread_id FROM tmap m
--    WHERE x.thread_id = m.from_thread_id AND NOT EXISTS (SELECT 1 FROM public.email_intake_log   y WHERE y.thread_id = m.to_thread_id);
--   UPDATE public.inbox_dismissals   x SET thread_id = m.to_thread_id FROM tmap m
--    WHERE x.thread_id = m.from_thread_id AND NOT EXISTS (SELECT 1 FROM public.inbox_dismissals   y WHERE y.thread_id = m.to_thread_id);
--   UPDATE public.bulk_email_threads x SET thread_id = m.to_thread_id FROM tmap m
--    WHERE x.thread_id = m.from_thread_id AND NOT EXISTS (SELECT 1 FROM public.bulk_email_threads y WHERE y.thread_id = m.to_thread_id);
--   -- (user_id, thread_id) unique: per user.
--   UPDATE public.thread_read_state x SET thread_id = m.to_thread_id FROM tmap m
--    WHERE x.thread_id = m.from_thread_id
--      AND NOT EXISTS (SELECT 1 FROM public.thread_read_state y WHERE y.thread_id = m.to_thread_id AND y.user_id = x.user_id);
--   UPDATE public.inbox_drafts x SET thread_id = m.to_thread_id FROM tmap m
--    WHERE x.thread_id = m.from_thread_id
--      AND NOT EXISTS (SELECT 1 FROM public.inbox_drafts y WHERE y.thread_id = m.to_thread_id AND y.user_id = x.user_id);
--   COMMIT;
-- A 23505 here means two deleted threads mapped onto one target under the same
-- key in one statement; the transaction rolls back whole — re-run that table's
-- UPDATE per from_thread_id.
--
--   -- Collisions left behind (review by hand; an inbox_drafts row here is a
--   -- user's typed reply on the deleted thread):
--   SELECT 'email_intake_log' AS t, thread_id FROM public.email_intake_log   WHERE thread_id IN (SELECT from_thread_id FROM tmap)
--   UNION ALL SELECT 'inbox_dismissals',   thread_id FROM public.inbox_dismissals   WHERE thread_id IN (SELECT from_thread_id FROM tmap)
--   UNION ALL SELECT 'bulk_email_threads', thread_id FROM public.bulk_email_threads WHERE thread_id IN (SELECT from_thread_id FROM tmap)
--   UNION ALL SELECT 'thread_read_state',  thread_id FROM public.thread_read_state  WHERE thread_id IN (SELECT from_thread_id FROM tmap)
--   UNION ALL SELECT 'inbox_drafts',       thread_id FROM public.inbox_drafts       WHERE thread_id IN (SELECT from_thread_id FROM tmap);
--
--   -- An email_intake_log collision means BOTH threads went through intake —
--   -- i.e. the same email produced two intake tasks. Both now link to the
--   -- target thread (the URL rewrite above). A person decides which to keep:
--   SELECT l.thread_id AS deleted_thread, l.task_id AS duplicate_task,
--          k.thread_id AS target_thread, k.task_id AS kept_task,
--          t.title, t.assignee_id, t.completed_at
--     FROM public.email_intake_log l
--     JOIN tmap m ON m.from_thread_id = l.thread_id
--     JOIN public.email_intake_log k ON k.thread_id = m.to_thread_id
--     LEFT JOIN public.tasks t ON t.id = l.task_id;
--
--   -- DD scheduled replies that failed on these threads anyway (e.g. one fell
--   -- due between §5 emptying the thread and §6 deleting it). The customer email
--   -- was never sent and the runner does not retry 'failed': read the error,
--   -- and requeue the ones that failed on the thread with
--   --   UPDATE public.scheduled_emails SET status = 'pending', error = NULL WHERE id = '<id>';
--   SELECT s.id, s.thread_id, s.scheduled_for, s.error
--     FROM public.scheduled_emails s
--    WHERE s.status = 'failed'
--      AND (s.thread_id IN (SELECT from_thread_id FROM tmap)
--           OR s.thread_id IN (SELECT to_thread_id FROM tmap));
--
-- slack_client_email_posts.thread_id is left alone with its claims (9c).
--
-- DONE WHEN: 1a and 1g return 0 apart from the §2-excluded groups (1g may also
-- keep sets whose bytes differ — metadata-only, it can't tell; §7 rightly keeps
-- those); loser ids
-- appear in no DD table except slack_client_email_posts (and the display-only
-- email_drafts.missive_message_id); satisfaction medians recomputed. Then run
-- create_unique_message_index.sql.
