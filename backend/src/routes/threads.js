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

// Parse Gmail-style search operators out of a query string.
// Supported: from:, to:, subject:, has:attachment, is:(starred|open|closed|
//            pending|snoozed), label:NAME, before:YYYY-MM-DD, after:YYYY-MM-DD.
// Anything else becomes free-text matched against the existing tsvector.
function parseSearch(q) {
  const filters = {};
  const tokens = [];
  if (!q) return { filters, freeText: '' };
  // Match: key:"quoted value" | key:value | "quoted free text" | bare-word
  const re = /(\w+):"([^"]*)"|(\w+):(\S+)|"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(q)) !== null) {
    if (m[1] !== undefined && m[2] !== undefined) {
      filters[m[1].toLowerCase()] = m[2];
    } else if (m[3] !== undefined && m[4] !== undefined) {
      filters[m[3].toLowerCase()] = m[4];
    } else if (m[5] !== undefined) {
      tokens.push(m[5]);
    } else if (m[6] !== undefined) {
      tokens.push(m[6]);
    }
  }
  return { filters, freeText: tokens.join(' ').trim() };
}

// Smart-filter SQL fragments. Each takes no parameters; they're plain
// pattern matches. Heuristic, not perfect — good enough to cut through noise.
const CATEGORY_CLAUSES = {
  codes: `(t.subject ILIKE '%verif%' OR t.subject ILIKE '%verify%'
       OR t.subject ILIKE '%code%' OR t.subject ILIKE '%OTP%'
       OR t.subject ILIKE '%one-time%' OR t.subject ILIKE '%one time%'
       OR t.subject ILIKE '%password%' OR t.subject ILIKE '%authent%'
       OR t.subject ILIKE '%sign-in%' OR t.subject ILIKE '%sign in%'
       OR t.subject ILIKE '%login%' OR t.subject ILIKE '%log in%'
       OR t.subject ILIKE '%2FA%' OR t.subject ILIKE '%two-factor%'
       OR t.subject ILIKE '%security alert%' OR t.subject ILIKE '%confirm%email%')`,

  newsletters: `EXISTS (SELECT 1 FROM messages mm WHERE mm.thread_id = t.id AND (
       mm.from_addr ILIKE '%noreply%' OR mm.from_addr ILIKE '%no-reply%'
       OR mm.from_addr ILIKE '%no_reply%' OR mm.from_addr ILIKE '%donotreply%'
       OR mm.from_addr ILIKE '%do-not-reply%' OR mm.from_addr ILIKE '%newsletter%'
       OR mm.from_addr ILIKE '%mailer@%' OR mm.from_addr ILIKE '%notifications@%'
       OR mm.from_addr ILIKE '%alerts@%' OR mm.from_addr ILIKE '%marketing@%'
       OR mm.from_addr ILIKE '%updates@%' OR mm.from_addr ILIKE '%digest@%'
     ))`,

  receipts: `(t.subject ILIKE '%receipt%' OR t.subject ILIKE '%invoice%'
       OR t.subject ILIKE '%your order%' OR t.subject ILIKE '%order #%'
       OR t.subject ILIKE '%payment%' OR t.subject ILIKE '%purchase%'
       OR t.subject ILIKE '%paid%' OR t.subject ILIKE '%charge%'
       OR t.subject ILIKE '%subscription%' OR t.subject ILIKE '%refund%'
       OR t.subject ILIKE '%transaction%' OR t.subject ILIKE '%billing%')`,

  calendar: `(t.subject ILIKE 'invitation:%' OR t.subject ILIKE '%accepted: %'
       OR t.subject ILIKE '%declined: %' OR t.subject ILIKE '%canceled: %'
       OR t.subject ILIKE '%cancelled: %' OR t.subject ILIKE '%meeting%'
       OR t.subject ILIKE '%calendar%' OR t.subject ILIKE '%appointment%'
       OR t.subject ILIKE '%reschedul%' OR t.subject ILIKE 'event: %'
       OR t.subject ILIKE '%zoom meeting%' OR t.subject ILIKE '%google meet%'
       OR t.subject ILIKE '%teams meeting%')`,

  people: `NOT EXISTS (SELECT 1 FROM messages mm WHERE mm.thread_id = t.id AND (
       mm.from_addr ILIKE '%noreply%' OR mm.from_addr ILIKE '%no-reply%'
       OR mm.from_addr ILIKE '%donotreply%' OR mm.from_addr ILIKE '%do-not-reply%'
       OR mm.from_addr ILIKE '%newsletter%' OR mm.from_addr ILIKE '%mailer-daemon%'
       OR mm.from_addr ILIKE '%notifications@%' OR mm.from_addr ILIKE '%alerts@%'
     ))`,

  bounces: `(t.subject ILIKE '%delivery%failed%' OR t.subject ILIKE '%undeliverable%'
       OR t.subject ILIKE '%mail delivery%' OR t.subject ILIKE '%delayed mail%'
       OR t.subject ILIKE 'mailer-daemon%' OR t.subject ILIKE '%bounced%')`
};

router.get('/', wrap(async (req, res) => {
  const { status, assignee, q, folder, team_space_id, snoozed, label_id,
          mine, mailbox_id, category, starred } = req.query;
  const params = [req.user.workspace_id];
  let sql = `SELECT t.*, u.name AS assignee_name,
                    coalesce(
                      (SELECT json_agg(json_build_object('id', l.id, 'name', l.name, 'color', l.color))
                       FROM thread_labels tl JOIN labels l ON l.id = tl.label_id
                       WHERE tl.thread_id = t.id), '[]'::json
                    ) AS labels,
                    coalesce(
                      (SELECT json_agg(DISTINCT jsonb_build_object('email', ea.email, 'name', ea.display_name))
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

  // mine = 'true': filter to threads in mailboxes owned by the requesting user.
  if (mine === 'true') {
    params.push(req.user.id);
    sql += ` AND EXISTS (SELECT 1 FROM messages mm
                         JOIN email_accounts ea ON ea.id = mm.account_id
                         WHERE mm.thread_id = t.id AND ea.user_id = $${params.length})`;
  }

  // mailbox_id: filter to threads touching one specific connected account.
  if (mailbox_id) {
    params.push(mailbox_id);
    sql += ` AND EXISTS (SELECT 1 FROM messages mm WHERE mm.thread_id = t.id AND mm.account_id = $${params.length})`;
  }

  // category: smart filter (codes / newsletters / receipts / etc.)
  if (category && CATEGORY_CLAUSES[category]) {
    sql += ` AND ${CATEGORY_CLAUSES[category]}`;
  }

  if (starred === 'true') {
    sql += ` AND t.starred = 1`;
  }
  if (folder === 'SENT') {
    sql += ` AND EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id AND m.direction = 'outbound')`;
  } else if (folder) {
    params.push(folder);
    sql += ` AND EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id AND m.folder = $${params.length})`;
  }
  // Parse any operators out of the query. Each operator becomes its own
  // SQL clause; whatever's left is free-text run against tsvector.
  if (q && q.trim()) {
    const { filters: ops, freeText } = parseSearch(q.trim());

    if (ops.from) {
      params.push(`%${ops.from}%`);
      sql += ` AND EXISTS (SELECT 1 FROM messages mm WHERE mm.thread_id = t.id AND mm.from_addr ILIKE $${params.length})`;
    }
    if (ops.to) {
      params.push(`%${ops.to}%`);
      sql += ` AND EXISTS (SELECT 1 FROM messages mm WHERE mm.thread_id = t.id AND mm.to_addrs ILIKE $${params.length})`;
    }
    if (ops.subject) {
      params.push(`%${ops.subject}%`);
      sql += ` AND t.subject ILIKE $${params.length}`;
    }
    if ((ops.has || '').toLowerCase().startsWith('attach')) {
      sql += ` AND EXISTS (SELECT 1 FROM messages mm WHERE mm.thread_id = t.id AND mm.has_attachments = 1)`;
    }
    const isVal = (ops.is || '').toLowerCase();
    if (isVal === 'starred')  sql += ` AND t.starred = 1`;
    if (isVal === 'open')     sql += ` AND t.status = 'open'`;
    if (isVal === 'closed')   sql += ` AND t.status = 'closed'`;
    if (isVal === 'pending')  sql += ` AND t.status = 'pending'`;
    if (isVal === 'snoozed')  {
      params.push(Date.now());
      sql += ` AND t.snoozed_until IS NOT NULL AND t.snoozed_until > $${params.length}`;
    }
    if (ops.label) {
      params.push(ops.label);
      sql += ` AND EXISTS (SELECT 1 FROM thread_labels tl JOIN labels l ON l.id = tl.label_id
                           WHERE tl.thread_id = t.id AND l.name ILIKE $${params.length})`;
    }
    if (ops.before) {
      const ts = Date.parse(ops.before);
      if (!isNaN(ts)) {
        params.push(ts);
        sql += ` AND t.last_message_at < $${params.length}`;
      }
    }
    if (ops.after) {
      const ts = Date.parse(ops.after);
      if (!isNaN(ts)) {
        params.push(ts);
        sql += ` AND t.last_message_at > $${params.length}`;
      }
    }

    if (freeText) {
      params.push(freeText);
      sql += ` AND to_tsvector('simple', coalesce(t.search_text, '')) @@ plainto_tsquery('simple', $${params.length})`;
    }
  }
  // Pagination: caller passes `limit` (1..200, default 50) + `offset`
  // (>=0, default 0) so the UI can infinite-scroll instead of dumping
  // a flat 200/1000 list every page load. Bounded so a runaway client
  // can't ask for half a million rows.
  const limit  = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  params.push(limit);
  const limitIdx = params.length;
  params.push(offset);
  const offsetIdx = params.length;
  sql += ` ORDER BY t.last_message_at DESC LIMIT $${limitIdx} OFFSET $${offsetIdx}`;
  const rows = await many(sql, params);
  res.json({ threads: rows, limit, offset, hasMore: rows.length === limit });
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
              (SELECT json_agg(DISTINCT jsonb_build_object('email', ea.email, 'name', ea.display_name))
               FROM messages m JOIN email_accounts ea ON ea.id = m.account_id
               WHERE m.thread_id = t.id), '[]'::json
            ) AS account_emails
     FROM threads t LEFT JOIN users u ON u.id = t.assignee_id
     WHERE t.id = $1 AND t.workspace_id = $2`,
    [req.params.id, req.user.workspace_id]
  );
  if (!t) return res.status(404).json({ error: 'not found' });
  const messages = await many(
    `SELECT m.*, ea.email AS account_email, ea.display_name AS account_name
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
  const { status, assignee_id, snoozed_until, starred } = req.body || {};
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
  if (starred !== undefined) {
    params.push(starred ? 1 : 0);
    sets.push(`starred = $${params.length}`);
  }
  if (!sets.length) return res.json({ ok: true });
  params.push(t.id);
  await query(`UPDATE threads SET ${sets.join(', ')} WHERE id = $${params.length}`, params);

  emitToWorkspace(req.user.workspace_id, 'thread:updated', { thread_id: t.id });
  res.json({ ok: true });
}));

// Bulk actions on multiple threads at once.
router.post('/bulk', wrap(async (req, res) => {
  const { action, thread_ids, value } = req.body || {};
  if (!Array.isArray(thread_ids) || thread_ids.length === 0) {
    return res.status(400).json({ error: 'thread_ids required' });
  }
  // Filter to threads actually in this workspace.
  const rows = await many(
    'SELECT id FROM threads WHERE workspace_id = $1 AND id = ANY($2::text[])',
    [req.user.workspace_id, thread_ids]
  );
  const ids = rows.map(r => r.id);
  if (!ids.length) return res.json({ ok: true, affected: 0 });

  switch (action) {
    case 'close':
      await query(`UPDATE threads SET status = 'closed' WHERE id = ANY($1::text[])`, [ids]);
      break;
    case 'open':
      await query(`UPDATE threads SET status = 'open' WHERE id = ANY($1::text[])`, [ids]);
      break;
    case 'pending':
      await query(`UPDATE threads SET status = 'pending' WHERE id = ANY($1::text[])`, [ids]);
      break;
    case 'star':
      await query(`UPDATE threads SET starred = 1 WHERE id = ANY($1::text[])`, [ids]);
      break;
    case 'unstar':
      await query(`UPDATE threads SET starred = 0 WHERE id = ANY($1::text[])`, [ids]);
      break;
    case 'snooze': {
      const ms = Number(value) || (60 * 60 * 1000);
      await query(`UPDATE threads SET snoozed_until = $1 WHERE id = ANY($2::text[])`, [Date.now() + ms, ids]);
      break;
    }
    case 'assign':
      await query(`UPDATE threads SET assignee_id = $1 WHERE id = ANY($2::text[])`, [value || null, ids]);
      break;
    case 'label_add':
      if (!value) return res.status(400).json({ error: 'value=label_id required' });
      for (const tid of ids) {
        await query(`INSERT INTO thread_labels (thread_id, label_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [tid, value]);
      }
      break;
    default:
      return res.status(400).json({ error: 'unknown action' });
  }

  for (const id of ids) emitToWorkspace(req.user.workspace_id, 'thread:updated', { thread_id: id });
  res.json({ ok: true, affected: ids.length });
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
       search_text = LEFT(coalesce(search_text, '') || ' ' || $2, 900000)
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
