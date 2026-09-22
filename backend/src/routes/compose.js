const express = require('express');
const multer = require('multer');
const { v4: uuid } = require('uuid');
const { one, tx, txLockedAfterSend } = require('../db');
const { requireAuth } = require('../auth');
const { sendEmail } = require('../email/smtp');
const { fireWebhook, ingestLockKey } = require('../email/imap');
const { emitToWorkspace } = require('../sockets');
const wrap = require('../util/wrap');

const router = express.Router();
router.use(requireAuth);

// fileSize caps a single attachment; 150 MB matches Graph's upload-session
// ceiling — files over the ~3 MB inline limit get chunked (see graph.js
// uploadAttachmentViaSession). memoryStorage holds the whole file in RAM,
// so this cap is also the guard against unbounded uploads.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 150 * 1024 * 1024, fieldSize: 10 * 1024 * 1024 }
});

// POST /api/compose
// multipart/form-data with:
//   payload: JSON string { account_id, to, cc, bcc, subject, body_text, body_html, send_at? }
//   files[]: optional attachments
// If send_at is in the future, schedules instead of sending immediately.
router.post('/', upload.array('files', 10), wrap(async (req, res) => {
  let data;
  try { data = JSON.parse(req.body.payload || '{}'); }
  catch { return res.status(400).json({ error: 'payload must be JSON' }); }

  const { account_id, to, cc, bcc, subject, body_text, body_html, send_at, automated, weekly_update } = data;
  if (!account_id || !to || !subject) return res.status(400).json({ error: 'account_id, to, subject required' });
  // Bulk-email tool marks blasts so DD can keep them out of touchpoint health.
  const isAutomated = automated === true ? 1 : 0;
  // Inbox composer marks weekly SEO updates so DD clears the recipient client
  // from its "Who needs an email" card. Carried to DD in the webhook below.
  const isWeeklyUpdate = weekly_update === true ? 1 : 0;

  const acc = await one(
    'SELECT * FROM email_accounts WHERE id = $1 AND workspace_id = $2',
    [account_id, req.user.workspace_id]
  );
  if (!acc) return res.status(400).json({ error: 'account_id invalid' });

  const files = (req.files || []).map(f => ({
    filename: f.originalname,
    content: f.buffer,
    content_type: f.mimetype,
    size: f.size
  }));

  // Scheduled send branch — store and return. Attachments are stashed in
  // scheduled_attachments and replayed by the dispatcher (index.js) when the
  // message comes due. The message row + its attachments go in one tx so the
  // HTTP success only returns once the whole queued send is durable.
  if (send_at && Number(send_at) > Date.now() + 30000) {
    const id = uuid();
    const now = Date.now();
    await tx(async (client) => {
      await client.query(
        `INSERT INTO scheduled_messages
          (id, workspace_id, user_id, account_id, thread_id, to_addrs, cc_addrs,
           subject, body_text, body_html, in_reply_to, send_at, status, is_automated, is_weekly_update, created_at)
         VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, $8, $9, NULL, $10, 'pending', $11, $12, $13)`,
        [
          id, req.user.workspace_id, req.user.id, acc.id,
          to, cc || '', subject, body_text || '', body_html || '',
          Number(send_at), isAutomated, isWeeklyUpdate, now
        ]
      );
      for (const f of files) {
        await client.query(
          `INSERT INTO scheduled_attachments
            (id, scheduled_message_id, workspace_id, filename, content_type, size_bytes, content_id, data, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [uuid(), id, req.user.workspace_id, f.filename, f.content_type, f.size, f.content_id || null, f.content, now]
        );
      }
    });
    console.log(`[scheduled] queued ${id} with ${files.length} attachment(s) for ${new Date(Number(send_at)).toISOString()}`);
    return res.json({ ok: true, scheduled_id: id, scheduled_for: Number(send_at), attachments: files.length });
  }

  // Immediate send.
  const sent = await sendEmail(acc.id, {
    to, cc, bcc, subject,
    text: body_text || '',
    html: body_html || '',
    attachments: files
  });

  // Create a new thread + outbound message in our DB.
  // `|| null`, never '': an empty Message-ID (smtp.js can return one) is not a
  // dedup identity, and storing '' would make unrelated sends look like copies
  // of each other to the dedup key and the unique index.
  const messageId = sent.messageId || null;
  const now = Date.now();
  const cleanSubj = subject.replace(/^(re|fwd|fw)\s*:\s*/i, '').trim();
  const participants = [acc.email, to, cc].filter(Boolean).join('; ');

  // The email is already out, so from here on a DB clash must resolve to "use
  // the row that's there", never a 500. Thread + message go in one transaction
  // under the same per-message lock ingest takes: a Sent Items walk that
  // already stored this email is found by the re-check (no second row, no empty
  // thread), and one arriving later waits for us and then dedupes against us.
  // txLockedAfterSend waits out a busy ingest holder, and if the lock still
  // can't be had it stores without it rather than failing a sent email.
  const findExisting = async (client) => (await client.query(
    `SELECT m.id, m.thread_id
       FROM messages m
      WHERE m.account_id = $1 AND m.direction = 'outbound' AND m.message_id = $2
      ORDER BY m.sent_at, m.id
      LIMIT 1`,
    [acc.id, messageId]
  )).rows[0] || null;
  // Reusing a synced copy: it was ingested without our flags, and DD reads
  // them (is_automated keeps bulk sends out of touchpoint health).
  const reuse = async (client, row) => {
    if (isAutomated || isWeeklyUpdate) {
      await client.query(
        `UPDATE messages SET is_automated = GREATEST(is_automated, $2),
                             is_weekly_update = GREATEST(is_weekly_update, $3)
          WHERE id = $1`,
        [row.id, isAutomated, isWeeklyUpdate]
      );
    }
    return { threadId: row.thread_id, msgId: row.id, reused: true };
  };
  // Built the same way as ingest's insert (imap.js ingestMessage): one
  // statement re-checks and inserts, so the common path is three round trips
  // on the pinned connection (lock, this, COMMIT) — this runs after the user
  // already waited on the SMTP/Graph send, over a slow link.
  //   d — the email is already stored (a Sent Items walk got there first). Its
  //       snapshot is taken after the lock was granted, so it sees a copy
  //       committed while we waited. Never matches when messageId is null.
  //   t / m — the new thread and message, only if d is empty. Bare ON CONFLICT
  //       DO NOTHING (never a targeted one, which fails 42P10 while the index is
  //       absent) absorbs uq_messages_acct_dir_msgid if an unlocked writer won.
  // folder='Sent' so the dedup key matches the copy a later Sent-folder poll
  // (or appendToSentFolder's mirror) brings in — a NULL folder used to make
  // the old (message_id, account_id, folder) dedup miss it.
  // Every parameter is cast: INSERT ... SELECT has no target column to infer
  // types from.
  const store = async (client) => {
    const threadId = uuid();
    const msgId = uuid();
    const r = await client.query(
      `WITH d AS (
         SELECT m.id, m.thread_id
           FROM messages m
          WHERE m.account_id = $3::text AND m.direction = 'outbound' AND m.message_id = $5::text
          ORDER BY m.sent_at, m.id
          LIMIT 1
       ), t AS (
         INSERT INTO threads (id, workspace_id, team_space_id, subject, participants,
                              last_message_at, status, message_id_root, search_text, created_at)
         SELECT $2::text, $4::text, $17::text, $18::text, $19::text, $12::bigint, 'open', $5::text, $20::text, $16::bigint
          WHERE NOT EXISTS (SELECT 1 FROM d)
         RETURNING id
       ), m AS (
         INSERT INTO messages
           (id, thread_id, account_id, workspace_id, direction, folder, message_id,
            subject, from_addr, to_addrs, cc_addrs, body_text, body_html, sent_at,
            has_attachments, is_automated, is_weekly_update, created_at)
         SELECT $1::text, $2::text, $3::text, $4::text, 'outbound', 'Sent', $5::text,
                $6::text, $7::text, $8::text, $9::text, $10::text, $11::text, $12::bigint,
                $13::int, $14::int, $15::int, $16::bigint
          WHERE NOT EXISTS (SELECT 1 FROM d)
         ON CONFLICT DO NOTHING
         RETURNING id
       )
       SELECT (SELECT id FROM d) AS dup_id, (SELECT thread_id FROM d) AS dup_thread_id,
              (SELECT id FROM m) AS new_id`,
      [msgId, threadId, acc.id, req.user.workspace_id, messageId,
       subject, '', to, cc || '', body_text || '', body_html || '',
       now, files.length ? 1 : 0, isAutomated, isWeeklyUpdate, now,
       acc.team_space_id || null, cleanSubj || subject, participants,
       (cleanSubj || subject) + ' ' + participants]
    );
    const row = r.rows[0] || {};
    if (row.new_id) return { threadId, msgId, reused: false };
    if (row.dup_id) {
      return reuse(client, { id: row.dup_id, thread_id: row.dup_thread_id });
    }
    // Lost to a conflicting row: drop the thread we just made (it can only be
    // empty) and use the existing message instead.
    await client.query('DELETE FROM threads WHERE id = $1', [threadId]);
    const existing = await findExisting(client);
    if (!existing) throw new Error(`message insert conflicted but no row found for ${messageId}`);
    return reuse(client, existing);
  };
  const stored = messageId
    ? await txLockedAfterSend(ingestLockKey(acc.id, 'outbound', messageId), store, '[compose]')
    : await tx(store);
  const { threadId, msgId } = stored;
  if (stored.reused) {
    console.log(`[compose] ${messageId} (${acc.email}) already stored as ${msgId} — reusing it`);
  }

  // Attachments go in a second, short transaction after the message commits (a
  // failed upload must not lose the row of an email that was already sent), but
  // under the same per-message lock, and only if the row still has none. A
  // Sent Items walk can reach this message between our COMMIT and here: its
  // attachment backfill takes this lock and also inserts only when there are
  // none, so whichever of the two runs second adds nothing — no second copy of
  // each file. The same check keeps a reused row's own attachments as they are.
  // While a big upload holds the lock, an ingest of this one message times out
  // on it (55P03) and its walk retries on the next poll.
  if (files.length) {
    const storeAtt = async (client) => {
      const has = await client.query('SELECT 1 FROM attachments WHERE message_id = $1 LIMIT 1', [msgId]);
      if (has.rows.length) return;
      if (stored.reused) await client.query('UPDATE messages SET has_attachments = 1 WHERE id = $1', [msgId]);
      for (const f of files) {
        await client.query(
          `INSERT INTO attachments (id, message_id, workspace_id, filename, content_type, size_bytes, data, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [uuid(), msgId, req.user.workspace_id, f.filename, f.content_type, f.size, f.content, now]
        );
      }
    };
    if (messageId) await txLockedAfterSend(ingestLockKey(acc.id, 'outbound', messageId), storeAtt, '[compose]');
    else await tx(storeAtt);
  }

  // account_id on the wire is what lets DelegationDoer's per-user SSE
  // filter scope events to the accounts a worker can see; without it
  // only leaders would see compose-sent emails appear live.
  emitToWorkspace(req.user.workspace_id, 'thread:updated', { thread_id: threadId, account_id: acc.id });
  emitToWorkspace(req.user.workspace_id, 'message:new', { thread_id: threadId, message_id: msgId, account_id: acc.id });
  // Also push to DD via the HMAC webhook so the redundant push path
  // covers compose-sent mail too. Same as what ingestMessage does for
  // inbound IMAP deliveries.
  fireWebhook('message:new', {
    workspace_id: req.user.workspace_id,
    account_id: acc.id,
    thread_id: threadId,
    message_id: msgId,
    // Recipients let DD attribute the send to a client (auto-label + the
    // weekly-update card clear). weekly_update gates the card clear itself.
    from_addr: acc.email,
    to_addrs: to,
    cc_addrs: cc || '',
    weekly_update: weekly_update === true
  });

  res.json({ ok: true, thread_id: threadId, message_id: msgId });
}));

module.exports = router;
