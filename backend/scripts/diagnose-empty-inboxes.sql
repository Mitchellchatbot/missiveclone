-- Read-only diagnostics for the "empty inbox in DD / inconsistency with MC"
-- problem. Same queries as scripts/diagnose-empty-inboxes.js, formatted for
-- a SQL editor (Supabase, pgAdmin, psql).
--
-- Run section-by-section. In Supabase's SQL editor: highlight one section
-- (including its `-- N. …` header line is fine — comments are ignored) and
-- press Cmd/Ctrl+Enter, or paste the whole file and run.
--
-- IMPORTANT: missiveclone lives in the `missive` schema (DB_SCHEMA env var,
-- defaults to "missive"). The SET below points the session at it for the
-- rest of the queries. If your install uses a different schema, change the
-- name on the next line.

SET search_path TO missive, public;


-- ─────────────────────────────────────────────────────────────────────────
-- 1a. INVENTORY — totals
-- ─────────────────────────────────────────────────────────────────────────
SELECT
  (SELECT COUNT(*) FROM workspaces)     AS workspaces,
  (SELECT COUNT(*) FROM email_accounts) AS accounts,
  (SELECT COUNT(*) FROM threads)        AS threads,
  (SELECT COUNT(*) FROM messages)       AS messages,
  (SELECT COUNT(*) FROM messages WHERE direction = 'inbound')  AS inbound_messages,
  (SELECT COUNT(*) FROM messages WHERE direction = 'outbound') AS outbound_messages;


-- ─────────────────────────────────────────────────────────────────────────
-- 1b. Workspaces with >1 connected account
-- (only those can hit the cross-account dedupe bug)
-- ─────────────────────────────────────────────────────────────────────────
SELECT
  workspace_id,
  COUNT(*) AS account_count,
  ARRAY_AGG(email ORDER BY email) AS emails
FROM email_accounts
GROUP BY workspace_id
HAVING COUNT(*) > 1
ORDER BY account_count DESC;


-- ─────────────────────────────────────────────────────────────────────────
-- 2a. CROSS-ACCOUNT DEDUPE — the big one
--
-- For each connected account, count threads where the account's email
-- appears on at least one message header (to / cc / from) but no message
-- in that thread is attributed to this account_id. These are threads the
-- account *should* see in its inbox but doesn't, because the dedupe at
-- backend/src/email/imap.js:91-97 dropped its copy on ingest.
--
-- A nonzero "suspect_threads" number = the size of the empty-inbox effect
-- in DD for that account.
-- ─────────────────────────────────────────────────────────────────────────
SELECT
  ea.workspace_id,
  ea.email,
  ea.id AS account_id,
  COUNT(DISTINCT m.thread_id) AS suspect_threads
FROM email_accounts ea
JOIN messages m ON m.workspace_id = ea.workspace_id
WHERE (
  m.to_addrs  ILIKE '%' || ea.email || '%'
  OR m.cc_addrs   ILIKE '%' || ea.email || '%'
  OR m.from_addr  ILIKE '%' || ea.email || '%'
)
AND NOT EXISTS (
  SELECT 1 FROM messages m2
  WHERE m2.thread_id = m.thread_id AND m2.account_id = ea.id
)
GROUP BY ea.workspace_id, ea.email, ea.id
HAVING COUNT(DISTINCT m.thread_id) > 0
ORDER BY suspect_threads DESC
LIMIT 50;


-- ─────────────────────────────────────────────────────────────────────────
-- 2b. Sample of 10 dedupe-suspect threads — eyeball sanity check on 2a
-- ─────────────────────────────────────────────────────────────────────────
SELECT
  ea.email AS missing_for_account,
  t.id     AS thread_id,
  t.subject,
  t.last_message_at,
  (SELECT COUNT(*) FROM messages mm WHERE mm.thread_id = t.id) AS total_messages,
  (SELECT ARRAY_AGG(DISTINCT m2.account_id)
     FROM messages m2 WHERE m2.thread_id = t.id) AS attributed_accounts
FROM email_accounts ea
JOIN messages m ON m.workspace_id = ea.workspace_id
JOIN threads  t ON t.id = m.thread_id
WHERE (
  m.to_addrs  ILIKE '%' || ea.email || '%'
  OR m.cc_addrs   ILIKE '%' || ea.email || '%'
  OR m.from_addr  ILIKE '%' || ea.email || '%'
)
AND NOT EXISTS (
  SELECT 1 FROM messages m2
  WHERE m2.thread_id = m.thread_id AND m2.account_id = ea.id
)
ORDER BY t.last_message_at DESC
LIMIT 10;


-- ─────────────────────────────────────────────────────────────────────────
-- 3a. SENT FOLDER COVERAGE — accounts where detectFolders failed
--
-- These accounts have nothing being synced as outbound via IMAP. /reply
-- inserts a row manually so replies show up, but /compose-style sends
-- (or sends made from another client) never land. DD's Sent view will
-- be empty for these.
-- ─────────────────────────────────────────────────────────────────────────
SELECT workspace_id, email, provider, imap_host, sent_folder, last_synced_at
FROM email_accounts
WHERE sent_folder IS NULL
ORDER BY provider, email;


-- ─────────────────────────────────────────────────────────────────────────
-- 3b. Per-account inbound vs outbound counts
-- (high inbound + zero outbound on a non-new account = smoking gun for 3a)
-- ─────────────────────────────────────────────────────────────────────────
SELECT
  ea.email,
  ea.provider,
  ea.sent_folder,
  COUNT(*) FILTER (WHERE m.direction = 'inbound')  AS inbound,
  COUNT(*) FILTER (WHERE m.direction = 'outbound') AS outbound,
  ea.last_synced_at
FROM email_accounts ea
LEFT JOIN messages m ON m.account_id = ea.id
GROUP BY ea.id, ea.email, ea.provider, ea.sent_folder, ea.last_synced_at
ORDER BY outbound ASC, inbound DESC
LIMIT 50;


-- ─────────────────────────────────────────────────────────────────────────
-- 4a. WATCHER / SYNC HEALTH — last sync time + last error per account
-- ─────────────────────────────────────────────────────────────────────────
SELECT
  email,
  provider,
  CASE WHEN last_synced_at IS NULL THEN 'NEVER'
       ELSE to_char(to_timestamp(last_synced_at/1000.0) AT TIME ZONE 'UTC',
                    'YYYY-MM-DD HH24:MI:SS') || ' UTC'
  END AS last_synced_human,
  CASE WHEN last_synced_at IS NULL THEN NULL
       ELSE EXTRACT(EPOCH FROM (now() - to_timestamp(last_synced_at/1000.0)))::int
  END AS seconds_since_sync,
  last_sync_error,
  CASE WHEN last_sync_error_at IS NULL THEN NULL
       ELSE to_char(to_timestamp(last_sync_error_at/1000.0) AT TIME ZONE 'UTC',
                    'YYYY-MM-DD HH24:MI:SS') || ' UTC'
  END AS last_sync_error_human
FROM email_accounts
ORDER BY last_synced_at NULLS FIRST, last_sync_error_at NULLS LAST;


-- ─────────────────────────────────────────────────────────────────────────
-- 4b. Accounts not synced in >10 minutes
-- (cron is supposed to fire every ~2 min; >10 min = watcher dead AND cron
-- not picking up the slack)
-- ─────────────────────────────────────────────────────────────────────────
SELECT
  email,
  provider,
  EXTRACT(EPOCH FROM (now() - to_timestamp(last_synced_at/1000.0)))::int AS seconds_since_sync,
  last_sync_error
FROM email_accounts
WHERE last_synced_at IS NOT NULL
  AND last_synced_at < (EXTRACT(EPOCH FROM now()) * 1000)::bigint - (10 * 60 * 1000)
ORDER BY last_synced_at ASC;


-- ─────────────────────────────────────────────────────────────────────────
-- 5. FOLDER NAMES ACTUALLY IN USE
-- (anything besides INBOX / Sent Items / Sent Mail = worth a second look)
-- ─────────────────────────────────────────────────────────────────────────
SELECT folder, COUNT(*) AS message_count
FROM messages
WHERE folder IS NOT NULL
GROUP BY folder
ORDER BY message_count DESC;


-- ─────────────────────────────────────────────────────────────────────────
-- 6. UID WATERMARK DRIFT
--
-- last_sync_uid > max(imap_uid we actually inserted) → the FETCH returned
-- rows we silently dropped. Most likely cause: the dedupe path from 2a,
-- viewed from a different angle. Magnitude of "gap" ≈ number of
-- dedupe-dropped messages for that (account, folder).
-- ─────────────────────────────────────────────────────────────────────────
SELECT
  ea.email,
  fss.folder,
  fss.last_sync_uid::bigint                              AS watermark,
  COALESCE(MAX(m.imap_uid), 0)::bigint                   AS max_ingested_uid,
  (fss.last_sync_uid::bigint - COALESCE(MAX(m.imap_uid), 0)::bigint) AS gap,
  fss.uid_validity
FROM folder_sync_state fss
JOIN email_accounts ea ON ea.id = fss.account_id
LEFT JOIN messages m ON m.account_id = ea.id AND m.folder = fss.folder
GROUP BY ea.email, fss.folder, fss.last_sync_uid, fss.uid_validity
ORDER BY gap DESC NULLS LAST
LIMIT 50;
