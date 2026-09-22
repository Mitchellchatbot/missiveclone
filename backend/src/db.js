const { Pool } = require('pg');
const crypto = require('crypto');

const HAS_DB = !!process.env.DATABASE_URL;
if (!HAS_DB) {
  console.error('=========================================================');
  console.error('  WARNING: DATABASE_URL is not set.');
  console.error('  The HTTP server will start but every DB query will fail.');
  console.error('  Attach the Postgres plugin in Railway and re-deploy.');
  console.error('=========================================================');
}

function shouldUseSsl() {
  const flag = (process.env.DATABASE_SSL || '').toLowerCase();
  if (flag === 'true') return true;
  if (flag === 'false') return false;
  return process.env.NODE_ENV === 'production';
}

// All missiveclone tables live under this Postgres schema. Defaulting to
// "missive" keeps every table (users, threads, drafts, …) namespaced so
// we can share a Supabase project with another app without colliding
// on names like `users`. The schema is auto-created on init().
const DB_SCHEMA = process.env.DB_SCHEMA || 'missive';
// The literal we splice into the SCHEMA template — quoted so a future
// admin who picks a schema with a hyphen or uppercase letter doesn't
// silently get downcased / split.
const QUOTED_SCHEMA = `"${DB_SCHEMA.replace(/"/g, '""')}"`;

const pool = HAS_DB
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: shouldUseSsl() ? { rejectUnauthorized: false } : false,
      // Bumped from 10 → 30. The old ceiling was getting exhausted under
      // sidebar polls × N users + cron + IDLE callbacks, surfacing in DD
      // as "timeout exceeded when trying to connect" 500s. 30 keeps
      // plenty of headroom for our scale without thrashing Supabase.
      max: 30,
      // 5s connection timeout (was 10s) — fail fast when the pool is
      // saturated so callers can degrade instead of stacking up.
      connectionTimeoutMillis: 5000,
      // 60s idle timeout (was the 30s default) so steady-state load
      // doesn't churn through TCP+TLS handshakes on every other query.
      idleTimeoutMillis: 60000,
      // Push search_path via libpq startup options so unqualified
      // table references (in SCHEMA below and across the route files)
      // resolve to our namespaced schema.
      options: `-c search_path=${DB_SCHEMA},public`
    })
  : null;

if (pool) {
  pool.on('error', (err) => console.error('pg pool error', err));
  // Belt-and-suspenders: when running through a transaction-mode
  // pooler (Supabase's pgbouncer), the startup `options` are usually
  // honored, but the SET on connect guarantees search_path is correct
  // on every new physical backend that joins the pg pool.
  // Also caps any single statement at 15s so a runaway query can't
  // hold a pool slot indefinitely — protects against the "one slow
  // query starves everyone else" failure mode we keep hitting.
  pool.on('connect', (client) => {
    Promise.all([
      client.query(`SET search_path TO ${DB_SCHEMA}, public`),
      client.query(`SET statement_timeout = '15s'`)
    ]).catch(() => {
      // Schema may not exist yet on first-ever boot — init() creates
      // it. Silenced because the next query in init() (CREATE SCHEMA)
      // is what fixes the world.
    });
  });
}

const SCHEMA = `
CREATE SCHEMA IF NOT EXISTS ${QUOTED_SCHEMA};
SET search_path TO ${QUOTED_SCHEMA}, public;

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_workspace ON users(workspace_id);

CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  invited_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  accepted_at BIGINT,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invites_workspace ON invites(workspace_id);

CREATE TABLE IF NOT EXISTS email_accounts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  display_name TEXT,
  imap_host TEXT NOT NULL,
  imap_port INTEGER NOT NULL,
  imap_secure INTEGER NOT NULL DEFAULT 1,
  imap_user TEXT NOT NULL,
  imap_pass TEXT NOT NULL,
  smtp_host TEXT NOT NULL,
  smtp_port INTEGER NOT NULL,
  smtp_secure INTEGER NOT NULL DEFAULT 1,
  smtp_user TEXT NOT NULL,
  smtp_pass TEXT NOT NULL,
  sent_folder TEXT,
  last_synced_at BIGINT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_accounts_workspace ON email_accounts(workspace_id);

CREATE TABLE IF NOT EXISTS folder_sync_state (
  account_id TEXT NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  folder TEXT NOT NULL,
  last_sync_uid BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, folder)
);

CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subject TEXT,
  participants TEXT,
  last_message_at BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  assignee_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  message_id_root TEXT,
  search_text TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_threads_workspace_status ON threads(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_threads_assignee ON threads(assignee_id);
CREATE INDEX IF NOT EXISTS idx_threads_msgid ON threads(message_id_root);
CREATE INDEX IF NOT EXISTS idx_threads_search ON threads USING GIN (to_tsvector('simple', coalesce(search_text, '')));

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  account_id TEXT REFERENCES email_accounts(id) ON DELETE SET NULL,
  workspace_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  folder TEXT,
  message_id TEXT,
  in_reply_to TEXT,
  subject TEXT,
  from_addr TEXT,
  to_addrs TEXT,
  cc_addrs TEXT,
  body_text TEXT,
  body_html TEXT,
  sent_at BIGINT NOT NULL,
  imap_uid BIGINT,
  has_attachments INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_messages_msgid ON messages(message_id);
CREATE INDEX IF NOT EXISTS idx_messages_folder ON messages(workspace_id, folder);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT,
  size_bytes INTEGER NOT NULL,
  content_id TEXT,
  data BYTEA NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attachments_msg ON attachments(message_id);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  mentions TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_thread ON comments(thread_id, created_at);

CREATE TABLE IF NOT EXISTS canned_responses (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body_text TEXT NOT NULL,
  body_html TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_canned_workspace ON canned_responses(workspace_id);

CREATE TABLE IF NOT EXISTS drafts (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  account_id TEXT REFERENCES email_accounts(id) ON DELETE SET NULL,
  body_text TEXT,
  body_html TEXT,
  to_addrs TEXT,
  cc_addrs TEXT,
  subject TEXT,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, thread_id)
);
CREATE INDEX IF NOT EXISTS idx_drafts_user ON drafts(user_id);

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  team_space_id TEXT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  mentions TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_workspace ON chat_messages(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS team_spaces (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_team_spaces_workspace ON team_spaces(workspace_id);

CREATE TABLE IF NOT EXISTS team_space_members (
  team_space_id TEXT NOT NULL REFERENCES team_spaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (team_space_id, user_id)
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  team_space_id TEXT REFERENCES team_spaces(id) ON DELETE SET NULL,
  thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT,
  assignee_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'open',
  due_at BIGINT,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id);
CREATE INDEX IF NOT EXISTS idx_tasks_team_space ON tasks(team_space_id);

CREATE TABLE IF NOT EXISTS labels (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#2f6feb',
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_labels_workspace ON labels(workspace_id);

CREATE TABLE IF NOT EXISTS thread_labels (
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (thread_id, label_id)
);
CREATE INDEX IF NOT EXISTS idx_thread_labels_label ON thread_labels(label_id);

CREATE TABLE IF NOT EXISTS scheduled_messages (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE,
  to_addrs TEXT,
  cc_addrs TEXT,
  subject TEXT,
  body_text TEXT,
  body_html TEXT,
  in_reply_to TEXT,
  send_at BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scheduled_pending ON scheduled_messages(status, send_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_workspace ON scheduled_messages(workspace_id, status);

-- Attachments for not-yet-sent scheduled messages. Mirrors the attachments
-- table but hangs off scheduled_messages (which has no messages row yet). When
-- the dispatcher sends a due message it reads these, attaches them, then copies
-- them into the attachments table against the materialized message and deletes
-- them here. ON DELETE CASCADE means cancelling a scheduled send (or its expiry)
-- cleans these up automatically.
CREATE TABLE IF NOT EXISTS scheduled_attachments (
  id TEXT PRIMARY KEY,
  scheduled_message_id TEXT NOT NULL REFERENCES scheduled_messages(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT,
  size_bytes INTEGER NOT NULL,
  content_id TEXT,
  data BYTEA NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sched_attachments_msg ON scheduled_attachments(scheduled_message_id);
`;

const MIGRATIONS = [
  // Backfill columns added after the original schema, idempotent.
  `ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS sent_folder TEXT`,
  `ALTER TABLE messages ADD COLUMN IF NOT EXISTS folder TEXT`,
  `ALTER TABLE messages ADD COLUMN IF NOT EXISTS has_attachments INTEGER NOT NULL DEFAULT 0`,
  // Bulk/automated outbound marker. DelegationDoer's bulk-email tool sets
  // payload.automated=true on /api/compose; the thread list exposes the
  // newest outbound message's value as `automated` so DD's touchpoint-sync
  // can exclude mass sends from client health.
  `ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_automated INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS is_automated INTEGER NOT NULL DEFAULT 0`,
  // Weekly-SEO-update marker. The inbox composer sets payload.weekly_update=true
  // on /api/compose; DD's webhook handler reads it and clears the recipient
  // client's pending EOD work from the "Who needs an email" card. Distinct from
  // is_automated (which excludes bulk blasts from touchpoint health) — a weekly
  // update is a real personal touchpoint that just also clears the EOD queue.
  `ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_weekly_update INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS is_weekly_update INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE threads ADD COLUMN IF NOT EXISTS search_text TEXT`,
  `ALTER TABLE email_accounts DROP COLUMN IF EXISTS last_sync_uid`,
  // Team-space columns:
  `ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS team_space_id TEXT REFERENCES team_spaces(id) ON DELETE SET NULL`,
  `ALTER TABLE threads ADD COLUMN IF NOT EXISTS team_space_id TEXT REFERENCES team_spaces(id) ON DELETE SET NULL`,
  `ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS team_space_id TEXT REFERENCES team_spaces(id) ON DELETE SET NULL`,
  // Auto-create a "Default" team_space for any workspace that lacks one,
  // and attach existing accounts/threads to it.
  `INSERT INTO team_spaces (id, workspace_id, name, created_at)
   SELECT 'ts_' || w.id, w.id, 'Default', extract(epoch from now())::bigint * 1000
   FROM workspaces w
   WHERE NOT EXISTS (SELECT 1 FROM team_spaces ts WHERE ts.workspace_id = w.id)`,
  `INSERT INTO team_space_members (team_space_id, user_id)
   SELECT 'ts_' || u.workspace_id, u.id FROM users u
   WHERE EXISTS (SELECT 1 FROM team_spaces ts WHERE ts.id = 'ts_' || u.workspace_id)
     AND NOT EXISTS (SELECT 1 FROM team_space_members m
                     WHERE m.team_space_id = 'ts_' || u.workspace_id AND m.user_id = u.id)`,
  `UPDATE email_accounts SET team_space_id = 'ts_' || workspace_id
   WHERE team_space_id IS NULL
     AND EXISTS (SELECT 1 FROM team_spaces ts WHERE ts.id = 'ts_' || email_accounts.workspace_id)`,
  `UPDATE threads SET team_space_id = 'ts_' || workspace_id
   WHERE team_space_id IS NULL
     AND EXISTS (SELECT 1 FROM team_spaces ts WHERE ts.id = 'ts_' || threads.workspace_id)`,
  // Star + snooze + signatures (added later):
  `ALTER TABLE threads ADD COLUMN IF NOT EXISTS starred INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE threads ADD COLUMN IF NOT EXISTS snoozed_until BIGINT`,
  `ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS signature_html TEXT`,
  `ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS signature_text TEXT`,
  // OAuth (Microsoft / Google) columns:
  `ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS provider TEXT`,
  `ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS oauth_access_token TEXT`,
  `ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS oauth_refresh_token TEXT`,
  `ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS oauth_expires_at BIGINT`,
  // Ops-only diagnostic: captures why a syncAccount() run threw (IMAP
  // disabled by tenant, stale refresh token, decrypt failure, etc.) so we
  // can SELECT this column to investigate accounts stuck on "Never synced".
  // Not exposed via the API; query the DB directly.
  `ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS last_sync_error TEXT`,
  `ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS last_sync_error_at BIGINT`,
  // IMAP servers bump UIDVALIDITY when a mailbox is recreated (migration,
  // archive/restore). When that happens our stored last_sync_uid points at
  // messages that no longer exist and Outlook returns "The specified
  // message set is invalid" for `<old_uid>:*` ranges, stranding the
  // account. Stored as TEXT to dodge BIGINT range/overflow surprises.
  `ALTER TABLE folder_sync_state ADD COLUMN IF NOT EXISTS uid_validity TEXT`,
  // Graph delta sync stores the @odata.deltaLink (a full URL containing
  // the opaque resume token Microsoft returns at the end of each delta
  // page) here. IMAP uses last_sync_uid + uid_validity; Graph uses this.
  // The two pathways never share state, so it's safe to leave the IMAP
  // columns untouched when a Microsoft account is synced via Graph.
  `ALTER TABLE folder_sync_state ADD COLUMN IF NOT EXISTS delta_link TEXT`,
  // The first Graph sync release wrote Microsoft's well-known folder
  // names ('inbox', 'sentitems', lowercase) into messages.folder. The
  // IMAP path always wrote IMAP-style uppercase names ('INBOX'), and
  // DelegationDoer's threads filter compares `m.folder = 'INBOX'`
  // verbatim. Mixed casing meant Graph-synced messages disappeared
  // from DD's inbox view. Backfill in place; future writes already use
  // the matching label.
  `UPDATE messages SET folder = 'INBOX' WHERE folder = 'inbox'`,
  `UPDATE messages SET folder = 'Sent Items' WHERE folder = 'sentitems'`,
  // imap_pass and smtp_pass were originally NOT NULL; OAuth accounts won't
  // have them, so relax the constraint.
  `ALTER TABLE email_accounts ALTER COLUMN imap_pass DROP NOT NULL`,
  `ALTER TABLE email_accounts ALTER COLUMN smtp_pass DROP NOT NULL`,
  // Index account_id on messages — used by mailbox_id thread filters
  // (EXISTS messages WHERE thread_id=t.id AND account_id=$X), account
  // deletes, and the reconnect relink UPDATEs. Without it,
  // those scans walk the entire messages table.
  `CREATE INDEX IF NOT EXISTS idx_messages_account ON messages(account_id)`,
  // Microsoft's own conversation grouping. Graph hands us a conversationId on
  // every message and it is STABLE across the inbox copy and the sender's Sent
  // copy of the same exchange — which is exactly the link RFC threading loses
  // when a client omits In-Reply-To, or when the Sent copy is ingested before
  // the message it replies to. We used to compute it and throw it away; storing
  // it lets findOrCreateThread reunite the two halves of a conversation instead
  // of filing the outbound half as its own thread (which then never appears in
  // the Inbox view, since that filter needs a message with folder='INBOX').
  // Adding a nullable column with no default is a catalog-only change, so this
  // is instant regardless of table size and is safe to run on boot.
  //
  // The matching INDEX deliberately is NOT here — see
  // backend/scripts/create_conversation_index.sql. Every connection in this pool
  // gets `SET statement_timeout = '15s'` (see ensurePool below), and a btree
  // build over `messages` — which stores body_text/body_html inline — will not
  // finish inside that. It would be cancelled, swallowed by init()'s catch as a
  // one-line warning, and silently retried on every single deploy while never
  // actually existing. Build it out of band instead.
  `ALTER TABLE messages ADD COLUMN IF NOT EXISTS provider_conversation_id TEXT`,
  // (A boot-time "reconnect-recovery" UPDATE used to live here, re-linking every
  // NULL-account message to whichever mailbox in the workspace its headers
  // mentioned. It was removed on purpose: it was an unbounded UPDATE ... FROM
  // over the whole table on every deploy, it picked the account
  // nondeterministically when several matched, and it relinked every copy of a
  // message onto the same account — which recreates exactly the duplicate
  // (account_id, direction, message_id) rows uq_messages_acct_dir_msgid forbids.
  // The reconnect paths (POST /accounts, /accounts/:id/relink-orphans and the
  // Microsoft OAuth callback) already relink, one row per key, via
  // util/relink_orphans.js.)
];

function ensurePool() {
  if (!pool) throw new Error('DATABASE_URL is not set; database is unavailable');
}

// Columns that ingest writes UNCONDITIONALLY. If one of these is missing the app
// still boots perfectly happily — and then every single INSERT in ingestMessage
// throws "column ... does not exist", which the Graph walk catches per message
// and moves past while still advancing the delta cursor. That combination loses
// mail permanently and reports nothing but warn lines.
//
// Swallowing migration failures is right for the backfills and the best-effort
// UPDATEs in MIGRATIONS. It is NOT right for a column ingest depends on: ADD
// COLUMN needs an ACCESS EXCLUSIVE lock, every pooled connection carries
// statement_timeout = 15s, and during a rolling deploy the old instance is still
// ingesting — so the ALTER can genuinely be cancelled by lock contention on a
// perfectly healthy database. Better to fail the boot and let the deploy roll
// back than to serve traffic that silently drops email.
const REQUIRED_COLUMNS = [
  ['messages', 'provider_conversation_id'],
];

async function assertRequiredColumns() {
  const missing = [];
  for (const [table, column] of REQUIRED_COLUMNS) {
    const row = await one(
      `SELECT 1 AS ok FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
      [DB_SCHEMA, table, column]
    );
    if (!row) missing.push(`${table}.${column}`);
  }
  if (missing.length) {
    throw new Error(
      `schema incomplete after migrations: missing ${missing.join(', ')}. ` +
      `Ingest writes these columns on every message, so booting without them ` +
      `would drop mail silently. Re-run the migration (most likely the ALTER ` +
      `was cancelled by lock contention or statement_timeout) and restart.`
    );
  }
}

// Advisory only: the conversation-id lookup runs once per ingested message, and
// without its index it degrades to a scan of the whole mailbox — which on a big
// account crosses statement_timeout and throws into the same message-dropping
// path as a missing column. It is created out of band (see
// scripts/create_conversation_index.sql), so nothing else would ever notice it
// was skipped. Warn loudly rather than fail: a fresh/small database is fine
// without it, and refusing to boot over an index would be worse than the risk.
async function warnIfConversationIndexMissing() {
  try {
    const row = await one(
      `SELECT i.indisvalid FROM pg_class c
         JOIN pg_index i ON i.indexrelid = c.oid
        WHERE c.relname = 'idx_messages_conversation'`
    );
    if (!row) {
      console.warn(
        '[db] idx_messages_conversation is MISSING. The per-message ' +
        'conversation-id lookup will scan; on a large mailbox it can hit ' +
        'statement_timeout and drop messages. Run backend/scripts/create_conversation_index.sql'
      );
    } else if (row.indisvalid === false) {
      console.warn(
        '[db] idx_messages_conversation exists but is INVALID (a cancelled ' +
        'CREATE INDEX CONCURRENTLY). The planner ignores it and IF NOT EXISTS ' +
        'will match it forever. DROP INDEX CONCURRENTLY it and rebuild.'
      );
    }
  } catch (e) {
    console.warn('[db] could not check idx_messages_conversation:', e.message);
  }
}

// Advisory only, same reasoning as above. The unique index is the database-side
// backstop against duplicate message rows (the in-process guards are the ingest
// advisory lock and one-walk-per-account). It can only be built after the
// existing duplicates are cleaned up, so it is created out of band
// (scripts/dedupe_messages.sql, then scripts/create_unique_message_index.sql).
// Every writer uses a bare ON CONFLICT DO NOTHING, so the code behaves the same
// whether the index is present, missing or INVALID — this just makes the state
// visible in the boot log.
async function warnIfUniqueMsgIndexMissing() {
  try {
    const row = await one(
      `SELECT i.indisvalid FROM pg_class c
         JOIN pg_index i ON i.indexrelid = c.oid
        WHERE c.relname = 'uq_messages_acct_dir_msgid'`
    );
    if (!row) {
      console.warn(
        '[db] uq_messages_acct_dir_msgid is MISSING. Duplicate message rows are ' +
        'prevented only by the ingest lock, not by the database. Clean up with ' +
        'backend/scripts/dedupe_messages.sql, then run create_unique_message_index.sql'
      );
    } else if (row.indisvalid === false) {
      console.warn(
        '[db] uq_messages_acct_dir_msgid exists but is INVALID (a failed ' +
        'CREATE UNIQUE INDEX CONCURRENTLY, usually a duplicate slipped in). It ' +
        'still costs every write and only partly enforces. DROP INDEX CONCURRENTLY ' +
        'it, re-clean and rebuild.'
      );
    }
  } catch (e) {
    console.warn('[db] could not check uq_messages_acct_dir_msgid:', e.message);
  }
}

async function init() {
  ensurePool();
  await pool.query(SCHEMA);
  for (const m of MIGRATIONS) {
    try { await pool.query(m); }
    catch (e) { console.warn('migration warning:', m, '-', e.message); }
  }
  // Throws — deliberately fatal. See REQUIRED_COLUMNS.
  await assertRequiredColumns();
  await warnIfConversationIndexMissing();
  await warnIfUniqueMsgIndexMissing();
}

async function ping() {
  if (!pool) return { ok: false, error: 'DATABASE_URL not set' };
  try {
    await pool.query('SELECT 1');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function query(text, params) { ensurePool(); return pool.query(text, params); }
async function one(text, params)   { ensurePool(); const r = await pool.query(text, params); return r.rows[0] || null; }
async function many(text, params)  { ensurePool(); const r = await pool.query(text, params); return r.rows; }
async function tx(fn) {
  ensurePool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// tx() under a transaction-scoped advisory lock on `key` (any string; callers
// use the message's dedup key). Two writers holding the same key serialize, so
// "check for the row, then insert it" can no longer interleave between two
// sync walks, two instances during a deploy overlap, or ingest vs. compose.
//
// Why each piece is here:
//   - pg_advisory_XACT_lock, not the session variant: it is released by COMMIT
//     or ROLLBACK, so it is safe through the transaction-mode pooler (the
//     server connection stays pinned from BEGIN to COMMIT) and can never leak.
//   - The key is a signed 64-bit integer derived from SHA-1 in JS and spliced
//     in as a quoted literal. It is built only from hex digest bytes, so there
//     is no injection surface, and it does not depend on hashtext() staying
//     stable across Postgres versions. Quoted + ::bigint so the one value with
//     no positive counterpart (-2^63) still parses.
//   - SET LOCAL timeouts: the 15s statement_timeout set in pool.on('connect')
//     is session state, which a transaction-mode pooler does not guarantee we
//     still have. lock_timeout bounds the wait behind another holder; a
//     timeout surfaces as 55P03, which graph.js treats as structural (abort
//     the walk, keep the cursor) rather than skipping the message.
//     idle_in_transaction_session_timeout covers the gaps between statements:
//     a transaction abandoned while holding the lock (a JS path that never
//     resolves, a stalled event loop) would otherwise keep the key forever,
//     failing every later ingest of that message with 55P03. The server ends
//     such a session after 60s idle and the key is freed.
//   - READ COMMITTED is spelled out, not left to the server/role default: the
//     re-check below only works if each statement takes a fresh snapshot.
//   - All of it goes as ONE simple query (no parameters), so taking the lock
//     costs a single round trip. Callers must run their re-check as a SEPARATE
//     statement from fn: under READ COMMITTED a statement's snapshot is taken
//     when it starts, so only a statement issued after the lock is granted can
//     see a row another holder committed while we waited.
//   - A client whose ROLLBACK fails is broken (dead socket, pooler reset);
//     release(err) destroys it instead of handing it to the next caller.
function advisoryKey(key) {
  return crypto.createHash('sha1').update(String(key)).digest().readBigInt64BE(0).toString();
}

// Timeouts are spliced into the SQL too, so only plain "<n>ms" / "<n>s"
// values are accepted — they come from code, never from a request.
const PG_INTERVAL = /^\d+(ms|s)$/;

async function txLocked(key, fn, { lockTimeout = '5s', statementTimeout = '15s' } = {}) {
  if (!PG_INTERVAL.test(lockTimeout) || !PG_INTERVAL.test(statementTimeout)) {
    throw new Error(`txLocked: bad timeout ${lockTimeout} / ${statementTimeout}`);
  }
  ensurePool();
  const client = await pool.connect();
  let broken;
  try {
    try {
      await client.query(
        `BEGIN ISOLATION LEVEL READ COMMITTED; SET LOCAL lock_timeout = '${lockTimeout}'; ` +
        `SET LOCAL statement_timeout = '${statementTimeout}'; SET LOCAL idle_in_transaction_session_timeout = '60s'; ` +
        `SELECT pg_advisory_xact_lock('${advisoryKey(key)}'::bigint)`
      );
    } catch (e) {
      // Tag failures to TAKE the lock (as opposed to failures inside fn), so
      // txLockedAfterSend knows nothing of the caller's ran yet.
      if (e && typeof e === 'object') e.lockPhase = true;
      throw e;
    }
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try { await client.query('ROLLBACK'); }
    catch (rbErr) { broken = rbErr; }
    throw e;
  } finally {
    client.release(broken);
  }
}

// txLocked for bookkeeping that runs AFTER an email has already gone out
// (compose, reply, scheduled send). There, failing on lock contention is the
// wrong trade: the send can't be undone, so a 500 just invites the user to
// send it again. Two differences from plain txLocked:
//   - It waits longer. An ingest holder can keep the key for its whole locked
//     statement (up to the 15s statement_timeout, e.g. a big attachment insert
//     over the slow link), so the 5s default would time out on it. 20s outlasts
//     that, and the statement_timeout is raised above it so the lock wait ends
//     as 55P03 rather than being cut short by 57014.
//   - If the lock still can't be had, it falls back to a plain tx(fn). fn must
//     therefore be safe to run twice (the locked attempt rolled back) and must
//     do its own existing-row check + bare ON CONFLICT DO NOTHING, which still
//     dedupes against anything committed — only the "both insert at the same
//     instant" window is left open, and the unique index closes that once built.
async function txLockedAfterSend(key, fn, tag = '[db]') {
  try {
    return await txLocked(key, fn, { lockTimeout: '20s', statementTimeout: '30s' });
  } catch (e) {
    const code = e && e.code;
    if (!(e && e.lockPhase) && code !== '55P03' && code !== '40P01') throw e;
    console.warn(`${tag} ingest lock unavailable (${code || e.message}) — storing without it`);
    return tx(fn);
  }
}

module.exports = { pool, init, ping, query, one, many, tx, txLocked, txLockedAfterSend, HAS_DB };
