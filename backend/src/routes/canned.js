const express = require('express');
const { v4: uuid } = require('uuid');
const { one, many, query } = require('../db');
const { requireAuth } = require('../auth');
const wrap = require('../util/wrap');

const router = express.Router();
router.use(requireAuth);

router.get('/', wrap(async (req, res) => {
  const rows = await many(
    `SELECT id, title, body_text, body_html, user_id, created_at
     FROM canned_responses WHERE workspace_id = $1
     ORDER BY title ASC`,
    [req.user.workspace_id]
  );
  res.json({ canned: rows });
}));

router.post('/', wrap(async (req, res) => {
  const { title, body_text, body_html } = req.body || {};
  if (!title || !body_text) return res.status(400).json({ error: 'title and body_text required' });
  const id = uuid();
  await query(
    `INSERT INTO canned_responses (id, workspace_id, user_id, title, body_text, body_html, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, req.user.workspace_id, req.user.id, title, body_text, body_html || null, Date.now()]
  );
  res.json({ id });
}));

router.delete('/:id', wrap(async (req, res) => {
  const r = await one(
    'SELECT id FROM canned_responses WHERE id = $1 AND workspace_id = $2',
    [req.params.id, req.user.workspace_id]
  );
  if (!r) return res.status(404).json({ error: 'not found' });
  await query('DELETE FROM canned_responses WHERE id = $1', [r.id]);
  res.json({ ok: true });
}));

module.exports = router;
