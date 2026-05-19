const { Pool } = require('pg');

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
      max: 10,
      // Don't keep retrying forever on a busted DATABASE_URL.
      connectionTimeoutMillis: 10000,
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
  pool.on('connect', (client) => {
    client.query(`SET search_path TO ${DB_SCHEMA}, public`).catch(() => {
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
`;

const MIGRATIONS = [
  // Backfill columns added after the original schema, idempotent.
  `ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS sent_folder TEXT`,
  `ALTER TABLE messages ADD COLUMN IF NOT EXISTS folder TEXT`,
  `ALTER TABLE messages ADD COLUMN IF NOT EXISTS has_attachments INTEGER NOT NULL DEFAULT 0`,
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
  // imap_pass and smtp_pass were originally NOT NULL; OAuth accounts won't
  // have them, so relax the constraint.
  `ALTER TABLE email_accounts ALTER COLUMN imap_pass DROP NOT NULL`,
  `ALTER TABLE email_accounts ALTER COLUMN smtp_pass DROP NOT NULL`,
  // Reconnect-recovery: any messages whose account_id went NULL after a
  // disconnect get re-linked to whichever current mailbox in the same
  // workspace mentions that address in headers. Idempotent — only touches
  // NULL rows, so re-runs are no-ops.
  `UPDATE messages SET account_id = ea.id
   FROM email_accounts ea
   WHERE messages.workspace_id = ea.workspace_id
     AND messages.account_id IS NULL
     AND (
       messages.to_addrs ILIKE '%' || ea.email || '%'
       OR messages.from_addr ILIKE '%' || ea.email || '%'
       OR messages.cc_addrs ILIKE '%' || ea.email || '%'
     )`
];

function ensurePool() {
  if (!pool) throw new Error('DATABASE_URL is not set; database is unavailable');
}

async function init() {
  ensurePool();
  await pool.query(SCHEMA);
  for (const m of MIGRATIONS) {
    try { await pool.query(m); }
    catch (e) { console.warn('migration warning:', m, '-', e.message); }
  }
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

module.exports = { pool, init, ping, query, one, many, tx, HAS_DB };
