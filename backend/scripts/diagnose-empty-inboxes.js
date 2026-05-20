// Read-only diagnostics for the "empty inbox in DD / inconsistency with MC"
// problem. Run against the live missiveclone database to figure out which of
// the suspected root causes is actually firing, and at what magnitude.
//
//   DATABASE_URL=postgres://... node backend/scripts/diagnose-empty-inboxes.js
//   DATABASE_URL=postgres://... npm run -w backend diagnose
//
// Nothing here writes. Every query is a SELECT.
//
// Each section maps to a hypothesis from the code review:
//   1. Inventory             — denominators so the rest of the numbers mean something.
//   2. Cross-account dedupe  — workspace-scoped dedupe at imap.js:91 dropping
//                              messages for the second account in a workspace.
//   3. Sent folder coverage  — non-English Outlook sent-folder detection gap
//                              at imap.js:202.
//   4. Watcher / sync health — last_synced_at staleness, last_sync_error rows.
//   5. Folder names in use   — catches localized INBOX values we never expected.
//   6. UID watermark drift   — folder_sync_state.last_sync_uid vs max ingested
//                              imap_uid; large gaps = silently-dropped messages.
//
// The script is dependency-free apart from pg (already in package.json).

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');

const DB_SCHEMA = process.env.DB_SCHEMA || 'missive';

function shouldUseSsl() {
  const flag = (process.env.DATABASE_SSL || '').toLowerCase();
  if (flag === 'true')  return true;
  if (flag === 'false') return false;
  return process.env.NODE_ENV === 'production';
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL not set. Export it (or put it in backend/.env) and rerun.');
  process.exit(2);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: shouldUseSsl() ? { rejectUnauthorized: false } : false,
  max: 2,
  options: `-c search_path=${DB_SCHEMA},public`
});

function hr(label) {
  const bar = '─'.repeat(72);
  console.log(`\n${bar}\n${label}\n${bar}`);
}

async function run(label, sql, params = []) {
  hr(label);
  try {
    const r = await pool.query(sql, params);
    if (!r.rows.length) {
      console.log('(no rows)');
      return;
    }
    // Light formatting: print each row as key=value lines, with a blank
    // line between rows. Easier to eyeball than table layout when columns
    // are long (email addresses, UUIDs).
    for (let i = 0; i < r.rows.length; i++) {
      if (i > 0) console.log('');
      for (const [k, v] of Object.entries(r.rows[i])) {
        console.log(`  ${k}: ${formatVal(v)}`);
      }
    }
    console.log(`\n  (${r.rows.length} row${r.rows.length === 1 ? '' : 's'})`);
  } catch (e) {
    console.error(`  ERROR: ${e.message}`);
  }
}

function formatVal(v) {
  if (v === null || v === undefined) return 'NULL';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string' && v.length > 200) return v.slice(0, 197) + '...';
  return String(v);
}

(async () => {
  try {
    // ────────────────────────────────────────────────────────────────────
    // 1. INVENTORY
    // ────────────────────────────────────────────────────────────────────
    await run(
      '1a. Totals',
      `SELECT
         (SELECT COUNT(*) FROM workspaces)     AS workspaces,
         (SELECT COUNT(*) FROM email_accounts) AS accounts,
         (SELECT COUNT(*) FROM threads)        AS threads,
         (SELECT COUNT(*) FROM messages)       AS messages,
         (SELECT COUNT(*) FROM messages WHERE direction = 'inbound')  AS inbound_messages,
         (SELECT COUNT(*) FROM messages WHERE direction = 'outbound') AS outbound_messages`
    );

    await run(
      '1b. Workspaces with >1 connected account (those are the only ones where the dedupe bug can fire)',
      `SELECT workspace_id,
              COUNT(*) AS account_count,
              ARRAY_AGG(email ORDER BY email) AS emails
       FROM email_accounts
       GROUP BY workspace_id
       HAVING COUNT(*) > 1
       ORDER BY account_count DESC`
    );

    // ────────────────────────────────────────────────────────────────────
    // 2. CROSS-ACCOUNT DEDUPE (the big one)
    //
    // For each connected account, count threads where the account's email
    // is on at least one message header (to/cc/from) — i.e. the account
    // *should* see this thread in its mailbox — but no message in the
    // thread is attributed to that account_id.
    //
    // Non-zero rows = the dedupe at imap.js:91 is silently dropping mail
    // and DD's per-mailbox view will look empty/incomplete for that
    // account.
    //
    // ILIKE substring match has minor false-positive risk (foo@x matches
    // foofoo@x) but is fine for getting magnitude.
    // ────────────────────────────────────────────────────────────────────
    await run(
      '2a. Per-account: threads where account email is on a header but NO message belongs to this account_id (dedupe-drop suspects)',
      `SELECT
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
       LIMIT 50`
    );

    await run(
      '2b. Sample of 10 dedupe-suspect threads (subject + which-account-is-missing) — sanity check 2a',
      `SELECT
         ea.email AS missing_for_account,
         t.id AS thread_id,
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
       LIMIT 10`
    );

    // ────────────────────────────────────────────────────────────────────
    // 3. SENT FOLDER COVERAGE
    //
    // Accounts where detectFolders() failed to pick a sent_folder.
    // Outbound mail for these accounts can only land via in-app /reply
    // (which inserts a row manually); /compose and external sends are
    // invisible until IMAP picks them up — which here it can't, because
    // there's no sent folder to sync.
    // ────────────────────────────────────────────────────────────────────
    await run(
      '3a. Accounts with no detected sent_folder',
      `SELECT workspace_id, email, provider, imap_host, sent_folder, last_synced_at
       FROM email_accounts
       WHERE sent_folder IS NULL
       ORDER BY provider, email`
    );

    await run(
      '3b. Per-account inbound vs outbound message counts (zero outbound on a non-new account is suspicious)',
      `SELECT
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
       LIMIT 50`
    );

    // ────────────────────────────────────────────────────────────────────
    // 4. WATCHER / SYNC HEALTH
    //
    // IDLE watcher death (imap.js:415) doesn't reconnect. Cron is meant
    // to keep accounts polled, but a wider-than-cron last_synced_at gap
    // means the cron isn't running either, or syncAccount is throwing.
    // ────────────────────────────────────────────────────────────────────
    await run(
      '4a. Sync health: last_synced_at gap + last_sync_error',
      `SELECT
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
       ORDER BY last_synced_at NULLS FIRST, last_sync_error_at NULLS LAST`
    );

    await run(
      '4b. Accounts not synced in >10 minutes (cron is supposed to fire every ~2 min)',
      `SELECT email, provider,
              EXTRACT(EPOCH FROM (now() - to_timestamp(last_synced_at/1000.0)))::int AS seconds_since_sync,
              last_sync_error
       FROM email_accounts
       WHERE last_synced_at IS NOT NULL
         AND last_synced_at < (EXTRACT(EPOCH FROM now()) * 1000)::bigint - (10 * 60 * 1000)
       ORDER BY last_synced_at ASC`
    );

    // ────────────────────────────────────────────────────────────────────
    // 5. FOLDER NAMES ACTUALLY IN USE
    //
    // detectFolders only ingests INBOX + (whatever it thinks Sent is).
    // If anything else shows up here it means the user has connected via
    // a path where folder was assigned differently, or another piece of
    // code is writing messages with a non-INBOX folder. Either way
    // worth seeing.
    // ────────────────────────────────────────────────────────────────────
    await run(
      '5. Distinct folder values in messages table',
      `SELECT folder, COUNT(*) AS message_count
       FROM messages
       WHERE folder IS NOT NULL
       GROUP BY folder
       ORDER BY message_count DESC`
    );

    // ────────────────────────────────────────────────────────────────────
    // 6. UID WATERMARK DRIFT
    //
    // If folder_sync_state.last_sync_uid is much larger than the highest
    // imap_uid we actually ingested for that account+folder, it means
    // FETCH returned rows we silently dropped — almost certainly the
    // dedupe path. The size of the gap is roughly the number of
    // dedupe-dropped messages for that account.
    // ────────────────────────────────────────────────────────────────────
    await run(
      '6. UID watermark vs max ingested UID per (account, folder)',
      `SELECT
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
       LIMIT 50`
    );

    // ────────────────────────────────────────────────────────────────────
    // SUMMARY HINTS
    // ────────────────────────────────────────────────────────────────────
    hr('Reading guide');
    console.log(`
  - If 2a returns rows: the workspace-scoped dedupe (imap.js:91-97) is
    actively dropping mail for some accounts. The "suspect_threads"
    column is approximately the size of the empty-inbox effect in DD
    for that account. Cross-check with 2b for a human sanity-check.

  - If 3a returns rows: those accounts will have no SENT view in DD,
    regardless of whether they actually sent mail. 3b confirms — any
    account with high inbound and zero outbound is the smoking gun.

  - If 4b returns rows: the watcher-death + no-reconnect path (imap.js:
    415-418) is bleeding accounts. Restart-only recovery. The
    last_sync_error column tells you whether the last syncAccount() call
    also threw vs whether the loop is silently not running.

  - If 5 shows folders besides 'INBOX' / 'Sent Items' / 'Sent Mail':
    detectFolders is finding non-English folder names — interesting
    but probably benign; means SPECIAL-USE flags worked.

  - If 6 shows a positive gap: confirms 2a from a different angle.
    Watermark advanced past UIDs whose messages never landed in the
    table. The dedupe drop is the most common reason.
`);
  } finally {
    await pool.end();
  }
})().catch((e) => {
  console.error('diagnostic run failed:', e.message);
  process.exit(1);
});
