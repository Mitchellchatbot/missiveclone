const express = require('express');
const multer = require('multer');
const { v4: uuid } = require('uuid');
const { one, query } = require('../db');
const { requireAuth } = require('../auth');
const { sendEmail } = require('../email/smtp');
const { fireWebhook } = require('../email/imap');
const { emitToWorkspace } = require('../sockets');
const wrap = require('../util/wrap');

const router = express.Router();
router.use(requireAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, fieldSize: 10 * 1024 * 1024 }
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

  const { account_id, to, cc, bcc, subject, body_text, body_html, send_at } = data;
  if (!account_id || !to || !subject) return res.status(400).json({ error: 'account_id, to, subject required' });

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

  // Scheduled send branch — store and return.
  if (send_at && Number(send_at) > Date.now() + 30000) {
    if (files.length) return res.status(400).json({ error: 'attachments with scheduled send not supported in MVP' });
    const id = uuid();
    await query(
      `INSERT INTO scheduled_messages
        (id, workspace_id, user_id, account_id, thread_id, to_addrs, cc_addrs,
         subject, body_text, body_html, in_reply_to, send_at, status, created_at)
       VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, $8, $9, NULL, $10, 'pending', $11)`,
      [
        id, req.user.workspace_id, req.user.id, acc.id,
        to, cc || '', subject, body_text || '', body_html || '',
        Number(send_at), Date.now()
      ]
    );
    return res.json({ ok: true, scheduled_id: id, scheduled_for: Number(send_at) });
  }

  // Immediate send.
  const sent = await sendEmail(acc.id, {
    to, cc, bcc, subject,
    text: body_text || '',
    html: body_html || '',
    attachments: files
  });

  // Create a new thread + outbound message in our DB.
  const threadId = uuid();
  const messageId = sent.messageId;
  const now = Date.now();
  const cleanSubj = subject.replace(/^(re|fwd|fw)\s*:\s*/i, '').trim();
  const participants = [acc.email, to, cc].filter(Boolean).join('; ');

  await query(
    `INSERT INTO threads (id, workspace_id, team_space_id, subject, participants,
                          last_message_at, status, message_id_root, search_text, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'open', $7, $8, $9)`,
    [threadId, req.user.workspace_id, acc.team_space_id || null,
     cleanSubj || subject, participants, now, messageId || null,
     (cleanSubj || subject) + ' ' + participants + ' ' + (body_text || '').slice(0, 2000),
     now]
  );

  const msgId = uuid();
  // folder='Sent' is written here so that when IMAP later polls the
  // sender's Sent folder (or appendToSentFolder mirrors the message
  // there) the dedup key (message_id, account_id, folder) matches and
  // we don't end up with two outbound rows for one email. Without
  // this, the dedup would miss because the existing row had
  // folder=NULL while the IMAP fetch carried folder='Sent'.
  await query(
    `INSERT INTO messages
      (id, thread_id, account_id, workspace_id, direction, folder, message_id,
       subject, from_addr, to_addrs, cc_addrs, body_text, body_html, sent_at,
       has_attachments, created_at)
      VALUES ($1, $2, $3, $4, 'outbound', 'Sent', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [msgId, threadId, acc.id, req.user.workspace_id, messageId,
     subject, '', to, cc || '', body_text || '', body_html || '',
     now, files.length ? 1 : 0, now]
  );
  for (const f of files) {
    const aid = uuid();
    await query(
      `INSERT INTO attachments (id, message_id, workspace_id, filename, content_type, size_bytes, data, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [aid, msgId, req.user.workspace_id, f.filename, f.content_type, f.size, f.content, now]
    );
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
    message_id: msgId
  });

  res.json({ ok: true, thread_id: threadId, message_id: msgId });
}));

module.exports = router;
