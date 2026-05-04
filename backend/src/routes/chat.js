const express = require('express');
const { v4: uuid } = require('uuid');
const { one, many, query } = require('../db');
const { requireAuth } = require('../auth');
const { emitToWorkspace } = require('../sockets');
const wrap = require('../util/wrap');

const router = express.Router();
router.use(requireAuth);

router.get('/', wrap(async (req, res) => {
  const before = req.query.before ? Number(req.query.before) : null;
  const params = [req.user.workspace_id];
  let sql = `SELECT m.id, m.user_id, m.body, m.mentions, m.created_at,
                    u.name AS user_name, u.email AS user_email
             FROM chat_messages m
             JOIN users u ON u.id = m.user_id
             WHERE m.workspace_id = $1`;
  if (before) {
    params.push(before);
    sql += ` AND m.created_at < $${params.length}`;
  }
  sql += ' ORDER BY m.created_at DESC LIMIT 100';
  const rows = await many(sql, params);
  res.json({ messages: rows.reverse() });
}));

router.post('/', wrap(async (req, res) => {
  const { body, mentions } = req.body || {};
  if (!body || !body.trim()) return res.status(400).json({ error: 'body required' });
  const id = uuid();
  const now = Date.now();
  await query(
    `INSERT INTO chat_messages (id, workspace_id, user_id, body, mentions, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, req.user.workspace_id, req.user.id, body, JSON.stringify(mentions || []), now]
  );
  const msg = await one(
    `SELECT m.id, m.user_id, m.body, m.mentions, m.created_at,
            u.name AS user_name, u.email AS user_email
     FROM chat_messages m JOIN users u ON u.id = m.user_id
     WHERE m.id = $1`,
    [id]
  );
  emitToWorkspace(req.user.workspace_id, 'chat:new', msg);
  res.json({ message: msg });
}));

module.exports = router;
