const express = require('express');
const { one, query } = require('../db');
const { requireAuth } = require('../auth');
const wrap = require('../util/wrap');

const router = express.Router();
router.use(requireAuth);

// List all drafts for the current user, with thread context.
router.get('/', wrap(async (req, res) => {
  const { many } = require('../db');
  const rows = await many(
    `SELECT d.thread_id, d.body_text, d.body_html, d.subject, d.updated_at,
            t.subject AS thread_subject, t.participants AS thread_participants,
            t.team_space_id
     FROM drafts d
     JOIN threads t ON t.id = d.thread_id
     WHERE d.user_id = $1 AND d.workspace_id = $2
     ORDER BY d.updated_at DESC LIMIT 200`,
    [req.user.id, req.user.workspace_id]
  );
  res.json({ drafts: rows });
}));

router.get('/:threadId', wrap(async (req, res) => {
  const t = await one(
    'SELECT id FROM threads WHERE id = $1 AND workspace_id = $2',
    [req.params.threadId, req.user.workspace_id]
  );
  if (!t) return res.status(404).json({ error: 'thread not found' });
  const draft = await one(
    `SELECT account_id, body_text, body_html, to_addrs, cc_addrs, subject, updated_at
     FROM drafts WHERE user_id = $1 AND thread_id = $2`,
    [req.user.id, t.id]
  );
  res.json({ draft });
}));

router.put('/:threadId', wrap(async (req, res) => {
  const { account_id, body_text, body_html, to_addrs, cc_addrs, subject } = req.body || {};
  const t = await one(
    'SELECT id FROM threads WHERE id = $1 AND workspace_id = $2',
    [req.params.threadId, req.user.workspace_id]
  );
  if (!t) return res.status(404).json({ error: 'thread not found' });

  const empty = !(body_text && body_text.trim()) && !(body_html && body_html.trim().replace(/<br\/?>/g, '').trim());
  if (empty) {
    await query(
      'DELETE FROM drafts WHERE user_id = $1 AND thread_id = $2',
      [req.user.id, t.id]
    );
    return res.json({ saved: false });
  }

  const now = Date.now();
  await query(
    `INSERT INTO drafts
       (user_id, thread_id, workspace_id, account_id, body_text, body_html,
        to_addrs, cc_addrs, subject, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (user_id, thread_id)
     DO UPDATE SET account_id = EXCLUDED.account_id,
                   body_text = EXCLUDED.body_text,
                   body_html = EXCLUDED.body_html,
                   to_addrs = EXCLUDED.to_addrs,
                   cc_addrs = EXCLUDED.cc_addrs,
                   subject = EXCLUDED.subject,
                   updated_at = EXCLUDED.updated_at`,
    [
      req.user.id, t.id, req.user.workspace_id, account_id || null,
      body_text || '', body_html || '',
      to_addrs || null, cc_addrs || null, subject || null, now
    ]
  );
  res.json({ saved: true, updated_at: now });
}));

router.delete('/:threadId', wrap(async (req, res) => {
  await query(
    'DELETE FROM drafts WHERE user_id = $1 AND thread_id = $2',
    [req.user.id, req.params.threadId]
  );
  res.json({ ok: true });
}));

module.exports = router;
