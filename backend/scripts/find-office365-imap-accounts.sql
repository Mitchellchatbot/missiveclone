-- Read-only diagnostic: email_accounts still syncing O365 mailboxes over IMAP
-- (provider not 'microsoft') against outlook.office365.com. These hit per-IP
-- IMAP throttling on Railway and cause the repeating "watcher error ... Socket
-- timeout" / [uncaughtException] noise (e.g. sophia@scaledai.org).
--
-- Fix: re-OAuth each account through the Microsoft connect flow
-- (backend/src/routes/oauth_microsoft.js), which sets provider='microsoft' and
-- routes it to Graph delta sync instead of IMAP. After that, syncAccount() and
-- startWatching() in backend/src/email/imap.js skip the IMAP path entirely.
--
-- Run in Supabase's SQL editor. Read-only — no writes.

SET search_path TO missive, public;

SELECT id, email, provider, imap_host, imap_port,
       last_synced_at, last_sync_error, last_sync_error_at
  FROM email_accounts
 WHERE (provider IS NULL OR provider <> 'microsoft')
   AND lower(imap_host) LIKE '%office365%'
 ORDER BY email;

-- If sophia (or others) don't appear above, they may be on a non-office365
-- host. Broaden to list every non-microsoft account and inspect imap_host:
--
-- SELECT id, email, provider, imap_host, imap_port,
--        last_synced_at, last_sync_error, last_sync_error_at
--   FROM email_accounts
--  WHERE (provider IS NULL OR provider <> 'microsoft')
--  ORDER BY imap_host, email;
