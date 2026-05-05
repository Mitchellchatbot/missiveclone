const express = require('express');
const multer = require('multer');
const { v4: uuid } = require('uuid');
const { one, many, query } = require('../db');
const { requireAuth } = require('../auth');
const { sendEmail } = require('../email/smtp');
const { emitToWorkspace } = require('../sockets');
const wrap = require('../util/wrap');

const router = express.Router();
router.use(requireAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, fieldSize: 10 * 1024 * 1024 }
});

router.get('/', wrap(async (req, res) => {
  const { status, assignee, q, folder, team_space_id, snoozed, label_id } = req.query;
  const params = [req.user.workspace_id];
  let sql = `SELECT t.*, u.name AS assignee_name,
                    coalesce(
                      (SELECT json_agg(json_build_object('id', l.id, 'name', l.name, 'color', l.color))
                       FROM thread_labels tl JOIN labels l ON l.id = tl.label_id
                       WHERE tl.thread_id = t.id), '[]'::json
                    ) AS labels,
                    coalesce(
                      (SELECT array_to_json(array_agg(DISTINCT ea.email))
                       FROM messages m JOIN email_accounts ea ON ea.id = m.account_id
                       WHERE m.thread_id = t.id), '[]'::json
                    ) AS account_emails
             FROM threads t
             LEFT JOIN users u ON u.id = t.assignee_id
             WHERE t.workspace_id = $1`;
  if (team_space_id) { params.push(team_space_id); sql += ` AND t.team_space_id = $${params.length}`; }
  if (status) { params.push(status); sql += ` AND t.status = $${params.length}`; }
  if (assignee === 'me') { params.push(req.user.id); sql += ` AND t.assignee_id = $${params.length}`; }
  else if (assignee) { params.push(assignee); sql += ` AND t.assignee_id = $${params.length}`; }
  if (snoozed === 'true') {
    params.push(Date.now());
    sql += ` AND t.snoozed_until IS NOT NULL AND t.snoozed_until > $${params.length}`;
  } else {
    // Default: hide currently-snoozed threads from regular views.
    params.push(Date.now());
    sql += ` AND (t.snoozed_until IS NULL OR t.snoozed_until <= $${params.length})`;
  }
  if (label_id) {
    params.push(label_id);
    sql += ` AND EXISTS (SELECT 1 FROM thread_labels tl WHERE tl.thread_id = t.id AND tl.label_id = $${params.length})`;
  }
  if (folder === 'SENT') {
    sql += ` AND EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id AND m.direction = 'outbound')`;
  } else if (folder) {
    params.push(folder);
    sql += ` AND EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id AND m.folder = $${params.length})`;
  }
  if (q && q.trim()) {
    params.push(q.trim());
    const i = params.length;
    sql += ` AND to_tsvector('simple', coalesce(t.search_text, '')) @@ plainto_tsquery('simple', $${i})`;
  }
  sql += ' ORDER BY t.last_message_at DESC LIMIT 200';
  const rows = await many(sql, params);
  res.json({ threads: rows });
}));

router.get('/:id', wrap(async (req, res) => {
  const t = await one(
    `SELECT t.*, u.name AS assignee_name,
            coalesce(
              (SELECT json_agg(json_build_object('id', l.id, 'name', l.name, 'color', l.color))
               FROM thread_labels tl JOIN labels l ON l.id = tl.label_id
               WHERE tl.thread_id = t.id), '[]'::json
            ) AS labels,
            coalesce(
              (SELECT array_to_json(array_agg(DISTINCT ea.email))
               FROM messages m JOIN email_accounts ea ON ea.id = m.account_id
               WHERE m.thread_id = t.id), '[]'::json
            ) AS account_emails
     FROM threads t LEFT JOIN users u ON u.id = t.assignee_id
     WHERE t.id = $1 AND t.workspace_id = $2`,
    [req.params.id, req.user.workspace_id]
  );
  if (!t) return res.status(404).json({ error: 'not found' });
  const messages = await many(
    `SELECT m.*, ea.email AS account_email
     FROM messages m
     LEFT JOIN email_accounts ea ON ea.id = m.account_id
     WHERE m.thread_id = $1 ORDER BY m.sent_at ASC`,
    [t.id]
  );
  const messageIds = messages.map(m => m.id);
  let attRows = [];
  if (messageIds.length) {
    attRows = await many(
      `SELECT id, message_id, filename, content_type, size_bytes, content_id
       FROM attachments WHERE message_id = ANY($1::text[])`,
      [messageIds]
    );
  }
  const attsByMsg = {};
  for (const a of attRows) {
    (attsByMsg[a.message_id] = attsByMsg[a.message_id] || []).push(a);
  }
  for (const m of messages) m.attachments = attsByMsg[m.id] || [];
  const comments = await many(
    `SELECT c.*, u.name AS user_name FROM comments c
     JOIN users u ON u.id = c.user_id
     WHERE c.thread_id = $1 ORDER BY c.created_at ASC`,
    [t.id]
  );
  res.json({ thread: t, messages, comments });
}));

router.patch('/:id', wrap(async (req, res) => {
  const { status, assignee_id, snoozed_until } = req.body || {};
  const t = await one(
    'SELECT id FROM threads WHERE id = $1 AND workspace_id = $2',
    [req.params.id, req.user.workspace_id]
  );
  if (!t) return res.status(404).json({ error: 'not found' });
  if (status && !['open', 'closed', 'pending'].includes(status))
    return res.status(400).json({ error: 'bad status' });

  const sets = [];
  const params = [];
  if (status) { params.push(status); sets.push(`status = $${params.length}`); }
  if (assignee_id !== undefined) {
    params.push(assignee_id || null);
    sets.push(`assignee_id = $${params.length}`);
  }
  if (snoozed_until !== undefined) {
    params.push(snoozed_until ? Number(snoozed_until) : null);
    sets.push(`snoozed_until = $${params.length}`);
  }
  if (!sets.length) return res.json({ ok: true });
  params.push(t.id);
  await query(`UPDATE threads SET ${sets.join(', ')} WHERE id = $${params.length}`, params);

  emitToWorkspace(req.user.workspace_id, 'thread:updated', { thread_id: t.id });
  res.json({ ok: true });
}));

// Reply with optional attachments. Multipart form-data:
//   payload = JSON string: { account_id, body_text, body_html, to, cc, subject }
//   files[] = uploaded binaries
router.post('/:id/reply', upload.array('files', 10), wrap(async (req, res) => {
  let data;
  try { data = JSON.parse(req.body.payload || '{}'); }
  catch { return res.status(400).json({ error: 'payload must be JSON' }); }
  const { account_id, body_text, body_html, to, cc, subject } = data;

  const t = await one(
    'SELECT * FROM threads WHERE id = $1 AND workspace_id = $2',
    [req.params.id, req.user.workspace_id]
  );
  if (!t) return res.status(404).json({ error: 'thread not found' });

  const acc = await one(
    'SELECT id FROM email_accounts WHERE id = $1 AND workspace_id = $2',
    [account_id, req.user.workspace_id]
  );
  if (!acc) return res.status(400).json({ error: 'account_id invalid' });

  const last = await one(
    `SELECT message_id, subject, from_addr, to_addrs, cc_addrs FROM messages
     WHERE thread_id = $1 ORDER BY sent_at DESC LIMIT 1`,
    [t.id]
  );
  const refsRows = await many(
    `SELECT message_id FROM messages WHERE thread_id = $1 AND message_id IS NOT NULL ORDER BY sent_at ASC`,
    [t.id]
  );
  const references = refsRows.map(r => r.message_id);

  const replySubject = subject ||
    (last && last.subject ? (last.subject.match(/^re:/i) ? last.subject : `Re: ${last.subject}`) : t.subject || '');
  const replyTo = to || (last ? last.from_addr : '');

  const files = (req.files || []).map(f => ({
    filename: f.originalname,
    content: f.buffer,
    content_type: f.mimetype,
    size: f.size
  }));

  const sent = await sendEmail(acc.id, {
    to: replyTo, cc, subject: replySubject,
    text: body_text || '', html: body_html || '',
    inReplyTo: last ? last.message_id : null,
    references,
    attachments: files
  });

  const id = uuid();
  const now = Date.now();
  await query(
    `INSERT INTO messages
      (id, thread_id, account_id, workspace_id, direction, message_id, in_reply_to,
       subject, from_addr, to_addrs, cc_addrs, body_text, body_html, sent_at, has_attachments, created_at)
      VALUES ($1, $2, $3, $4, 'outbound', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [
      id, t.id, acc.id, req.user.workspace_id, sent.messageId,
      last ? last.message_id : null, replySubject,
      '', replyTo, cc || '', body_text || '', body_html || '', now,
      files.length ? 1 : 0, now
    ]
  );
  for (const f of files) {
    const aid = uuid();
    await query(
      `INSERT INTO attachments (id, message_id, workspace_id, filename, content_type, size_bytes, data, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [aid, id, req.user.workspace_id, f.filename, f.content_type, f.size, f.content, now]
    );
  }

  await query(
    `UPDATE threads SET last_message_at = $1,
       search_text = coalesce(search_text, '') || ' ' || $2
     WHERE id = $3`,
    [now, [replySubject, replyTo, body_text || ''].join(' '), t.id]
  );

  // Successful send: clear this user's draft for the thread.
  await query('DELETE FROM drafts WHERE user_id = $1 AND thread_id = $2', [req.user.id, t.id]);

  emitToWorkspace(req.user.workspace_id, 'message:new', { thread_id: t.id, message_id: id });
  emitToWorkspace(req.user.workspace_id, 'thread:updated', { thread_id: t.id });
  res.json({ ok: true, message_id: id });
}));

router.post('/:id/comments', wrap(async (req, res) => {
  const { body, mentions } = req.body || {};
  if (!body) return res.status(400).json({ error: 'body required' });
  const t = await one(
    'SELECT id FROM threads WHERE id = $1 AND workspace_id = $2',
    [req.params.id, req.user.workspace_id]
  );
  if (!t) return res.status(404).json({ error: 'not found' });
  const id = uuid();
  const now = Date.now();
  await query(
    `INSERT INTO comments (id, thread_id, workspace_id, user_id, body, mentions, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, t.id, req.user.workspace_id, req.user.id, body, JSON.stringify(mentions || []), now]
  );
  emitToWorkspace(req.user.workspace_id, 'comment:new', { thread_id: t.id, id });
  res.json({ ok: true, id });
}));

module.exports = router;
