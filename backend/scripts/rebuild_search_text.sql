-- Rebuild threads.search_text from IDENTITY FIELDS ONLY: subject + sender/recipients
-- (from/to/cc) aggregated across the thread's messages.
--
-- Why: inbox free-text search matches `to_tsvector('simple', search_text)`. The column
-- historically accumulated message BODY text (first 4000 chars per ingest, full body on
-- reply, 2000 on compose/scheduled), so a name buried in a signature, quoted reply, or
-- footer made the whole thread match — surfacing conversations the search term doesn't
-- visibly belong to. The ingest/compose/reply/scheduled-send paths no longer write body
-- into search_text; this one-off rebuild purges body text already baked into existing rows.
--
-- Safe to re-run (idempotent) and read-only on `messages`. left(..., 100000) matches the
-- runtime SEARCH_TEXT_CAP in src/email/imap.js so a rebuilt value never exceeds what the
-- append path would produce.
--
-- Run:  psql "$DATABASE_URL" -f backend/scripts/rebuild_search_text.sql

UPDATE threads t
SET search_text = left(trim(
  coalesce(t.subject, '') || ' ' || coalesce((
    SELECT string_agg(
      coalesce(m.subject, '') || ' ' || coalesce(m.from_addr, '') || ' ' ||
      coalesce(m.to_addrs, '') || ' ' || coalesce(m.cc_addrs, ''),
      ' ' ORDER BY m.sent_at)
    FROM messages m WHERE m.thread_id = t.id
  ), '')
), 100000);
