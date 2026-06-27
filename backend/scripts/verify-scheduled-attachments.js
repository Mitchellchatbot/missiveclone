// Verification for the scheduled-send attachment fix. Proves the broken link
// in the chain — serialize → store → retrieve — actually round-trips a file's
// bytes through scheduled_attachments, which is what the dispatcher (index.js)
// replays at send time. Also confirms the ON DELETE CASCADE that the
// user-cancel path (routes/scheduled.js) relies on.
//
//   DATABASE_URL=postgres://... node backend/scripts/verify-scheduled-attachments.js
//   cd backend && npm run verify:scheduled-attachments
//
// Writes ONLY a throwaway scheduled_messages row (+ one attachment) and deletes
// it again — leaves the DB exactly as it found it. Never sends a real email.
//
// Exit codes: 0 = PASS, 1 = round-trip FAILED, 2 = could not run (no DB / no
// workspace+user+account rows to satisfy foreign keys).

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { v4: uuid } = require('uuid');
const { one, query, tx, pool } = require('../src/db');

function bail(msg) {
  console.error(msg);
  process.exit(2);
}

function check(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`  ✓ ${msg}`);
}

if (!process.env.DATABASE_URL) {
  bail('DATABASE_URL not set. Export it (or put it in backend/.env) and rerun.');
}

(async () => {
  // Pick real rows so the scheduled_messages foreign keys (workspace_id,
  // user_id, account_id) are satisfied. Anchor on an account — it carries the
  // workspace_id — then find a user in that workspace.
  const acc = await one('SELECT id, workspace_id FROM email_accounts ORDER BY email LIMIT 1');
  if (!acc) bail('No email_accounts row exists. Connect a mailbox first, then rerun.');
  const usr = await one('SELECT id FROM users WHERE workspace_id = $1 LIMIT 1', [acc.workspace_id])
           || await one('SELECT id FROM users LIMIT 1');
  if (!usr) bail('No users row exists. Create a user first, then rerun.');

  const id = uuid();
  const known = Buffer.from('verify-scheduled-attachments payload ' + id, 'utf8');
  const filename = 'verify.txt';
  const contentType = 'text/plain';
  // Far in the future so the live dispatcher never actually picks this up if a
  // server happens to be running against the same DB while we test.
  const sendAt = Date.now() + 365 * 24 * 60 * 60 * 1000;
  const now = Date.now();

  let inserted = false;
  let failed = false;
  try {
    console.log(`\nVerifying scheduled-attachment round-trip (scheduled_message ${id})`);
    console.log(`  using account=${acc.id} workspace=${acc.workspace_id} user=${usr.id}\n`);

    // 1. Store: exactly the shape routes/compose.js writes on schedule.
    await tx(async (client) => {
      await client.query(
        `INSERT INTO scheduled_messages
          (id, workspace_id, user_id, account_id, thread_id, to_addrs, cc_addrs,
           subject, body_text, body_html, in_reply_to, send_at, status, created_at)
         VALUES ($1, $2, $3, $4, NULL, $5, '', $6, $7, '', NULL, $8, 'pending', $9)`,
        [id, acc.workspace_id, usr.id, acc.id,
         'verify@example.com', 'verify subject', 'verify body', sendAt, now]
      );
      await client.query(
        `INSERT INTO scheduled_attachments
          (id, scheduled_message_id, workspace_id, filename, content_type, size_bytes, content_id, data, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8)`,
        [uuid(), id, acc.workspace_id, filename, contentType, known.length, known, now]
      );
    });
    inserted = true;

    // 2. Retrieve: exactly the query the dispatcher (index.js) runs.
    const atts = await query(
      `SELECT filename, content_type, content_id, data
         FROM scheduled_attachments WHERE scheduled_message_id = $1`,
      [id]
    );
    check(atts.rows.length === 1, `one attachment row read back (got ${atts.rows.length})`);
    const row = atts.rows[0];
    check(row.filename === filename, `filename preserved (${row.filename})`);
    check(row.content_type === contentType, `content_type preserved (${row.content_type})`);
    check(Buffer.isBuffer(row.data), 'data comes back as a Buffer (sendEmail-ready)');
    check(row.data.equals(known), `attachment bytes are byte-for-byte identical (${row.data.length} bytes)`);

    // 3. Cascade: deleting the parent removes the attachment (the user-cancel path).
    await query('DELETE FROM scheduled_messages WHERE id = $1', [id]);
    inserted = false;
    const after = await query(
      'SELECT 1 FROM scheduled_attachments WHERE scheduled_message_id = $1', [id]
    );
    check(after.rows.length === 0, 'ON DELETE CASCADE removed the attachment with its parent');

    console.log('\nPASS — scheduled attachments survive store → retrieve and cascade-delete.\n');
  } catch (e) {
    failed = true;
    console.error(`\nFAIL — ${e.message}\n`);
  } finally {
    // Best-effort cleanup if we bailed before the cascade-delete step.
    if (inserted) {
      try { await query('DELETE FROM scheduled_messages WHERE id = $1', [id]); }
      catch (e) { console.error('cleanup warning:', e.message); }
    }
    await pool.end();
  }
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('verification run failed:', e.message);
  process.exit(2);
});
