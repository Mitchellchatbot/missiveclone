-- One-time data fix: repair Microsoft-tagged accounts that were originally
-- created as Gmail rows and later OAuth'd into Microsoft. The OAuth callback
-- at backend/src/routes/oauth_microsoft.js (pre-fix) updated provider +
-- tokens but never touched imap_host / smtp_host, leaving the Gmail server
-- config in place. ImapFlow then handed the Microsoft access token to
-- imap.gmail.com, which rejected it (AUTHENTICATIONFAILED).
--
-- This script:
--   1. Shows the rows that will be changed (run before the UPDATE).
--   2. Updates host, port, and security flags to the Microsoft values.
--   3. Confirms the change with a RETURNING clause.
--
-- Doesn't clear imap_pass / smtp_pass. They're encrypted Gmail credentials
-- that the Microsoft code paths bypass anyway — harmless dead data. If you
-- want them cleared later, that's a separate UPDATE.
--
-- Run section by section in Supabase's SQL editor.

SET search_path TO missive, public;


-- 1. PREVIEW — which rows will the UPDATE touch?
SELECT id, email, provider,
       imap_host, imap_port, imap_secure,
       smtp_host, smtp_port, smtp_secure,
       (oauth_refresh_token IS NOT NULL) AS has_refresh_token,
       last_sync_error
FROM email_accounts
WHERE provider = 'microsoft'
  AND imap_host = 'imap.gmail.com';


-- 2. APPLY — fix host config for any Microsoft account currently pointed
--    at Gmail. Targets imap_host as the smoking gun; the other columns
--    are set defensively so the row matches the values the OAuth callback
--    uses for fresh INSERTs (oauth_microsoft.js:128-133).
--
--    Expected to affect exactly the rows shown by query 1.
UPDATE email_accounts
SET imap_host   = 'outlook.office365.com',
    imap_port   = 993,
    imap_secure = 1,
    smtp_host   = 'smtp.office365.com',
    smtp_port   = 587,
    smtp_secure = 0
WHERE provider = 'microsoft'
  AND imap_host = 'imap.gmail.com'
RETURNING id, email, imap_host, smtp_host, smtp_port, smtp_secure;


-- 3. VERIFY — these rows should no longer appear in the misconfig set,
--    and the next syncAccount() / 2-min cron cycle should clear
--    last_sync_error on success.
SELECT email, imap_host, smtp_host, last_synced_at, last_sync_error
FROM email_accounts
WHERE workspace_id = (
  SELECT workspace_id FROM email_accounts
  WHERE email IN ('Bella@scaledai.org', 'daniel@scaledai.org',
                  'emily@scaledai.org',  'steve@scaledai.org')
  LIMIT 1
)
  AND email IN ('Bella@scaledai.org', 'daniel@scaledai.org',
                'emily@scaledai.org',  'steve@scaledai.org')
ORDER BY email;
