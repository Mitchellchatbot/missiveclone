-- Backfill: recompute threads.last_message_at from each thread's newest message.
--
-- Why: the inbox lists threads ordered by last_message_at DESC. Historically the
-- IMAP ingest set last_message_at unconditionally to whatever message was just
-- ingested, so an older message ingested out of chronological order (separate
-- INBOX/Sent passes, UID-reset backfills, delayed/forwarded mail that threads by
-- subject) could clobber a newer timestamp and strand active threads low in the
-- list. The ingest now uses GREATEST(last_message_at, sent_at) so it only ever
-- advances; this script repairs threads that were already mis-stamped.
--
-- Safe to re-run (idempotent) and read-only on `messages`. Only rows that are
-- currently wrong are touched. sent_at and last_message_at are both BIGINT
-- epoch-millis, so the units match.
--
-- Run:  psql "$DATABASE_URL" -f backend/scripts/backfill_last_message_at.sql

UPDATE threads t
SET last_message_at = m.max_sent
FROM (
  SELECT thread_id, MAX(sent_at) AS max_sent
  FROM messages
  GROUP BY thread_id
) m
WHERE m.thread_id = t.id
  AND t.last_message_at <> m.max_sent;
