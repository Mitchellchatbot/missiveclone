const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');
const { one, many, tx } = require('../db');
const { sign, requireAuth } = require('../auth');
const wrap = require('../util/wrap');

const router = express.Router();

router.post('/signup', wrap(async (req, res) => {
  const { email, password, name, workspace_name } = req.body || {};
  if (!email || !password || !name) return res.status(400).json({ error: 'email, password, name required' });

  const existing = await one('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
  if (existing) return res.status(409).json({ error: 'email already registered' });

  const now = Date.now();
  const wsId = uuid();
  const userId = uuid();
  const wsName = (workspace_name && workspace_name.trim()) || `${name}'s Workspace`;
  const hash = bcrypt.hashSync(password, 10);

  const tsId = uuid();
  await tx(async (c) => {
    await c.query('INSERT INTO workspaces (id, name, created_at) VALUES ($1, $2, $3)', [wsId, wsName, now]);
    await c.query(
      'INSERT INTO users (id, workspace_id, email, password_hash, name, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [userId, wsId, email.toLowerCase(), hash, name, now]
    );
    await c.query(
      'INSERT INTO team_spaces (id, workspace_id, name, created_at) VALUES ($1, $2, $3, $4)',
      [tsId, wsId, 'General', now]
    );
    await c.query(
      'INSERT INTO team_space_members (team_space_id, user_id) VALUES ($1, $2)',
      [tsId, userId]
    );
  });

  const user = await one('SELECT id, workspace_id, email, name FROM users WHERE id = $1', [userId]);
  res.json({ token: sign(user), user });
}));

router.post('/login', wrap(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  const row = await one('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
  if (!row) return res.status(401).json({ error: 'invalid credentials' });
  if (!bcrypt.compareSync(password, row.password_hash)) return res.status(401).json({ error: 'invalid credentials' });
  const user = { id: row.id, workspace_id: row.workspace_id, email: row.email, name: row.name };
  res.json({ token: sign(user), user });
}));

router.get('/me', requireAuth, wrap(async (req, res) => {
  const u = await one('SELECT id, workspace_id, email, name FROM users WHERE id = $1', [req.user.id]);
  if (!u) return res.status(404).json({ error: 'not found' });
  const ws = await one('SELECT id, name FROM workspaces WHERE id = $1', [u.workspace_id]);
  res.json({ user: u, workspace: ws });
}));

router.get('/team', requireAuth, wrap(async (req, res) => {
  const rows = await many(
    'SELECT id, email, name FROM users WHERE workspace_id = $1 ORDER BY name',
    [req.user.workspace_id]
  );
  res.json({ members: rows });
}));

router.patch('/workspace', requireAuth, wrap(async (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });
  const { query } = require('../db');
  await query('UPDATE workspaces SET name = $1 WHERE id = $2', [name.trim(), req.user.workspace_id]);
  res.json({ ok: true });
}));

router.delete('/team/:userId', requireAuth, wrap(async (req, res) => {
  if (req.params.userId === req.user.id) {
    return res.status(400).json({ error: 'You cannot remove yourself' });
  }
  const { one, query, tx } = require('../db');
  const u = await one('SELECT id FROM users WHERE id = $1 AND workspace_id = $2', [req.params.userId, req.user.workspace_id]);
  if (!u) return res.status(404).json({ error: 'not found' });

  // Before deleting the user, transfer ownership of workspace-shared
  // resources (mailboxes, tasks, canned responses) to the requesting user.
  // Personal things (drafts, comments, chat messages) cascade out with
  // the user — those represent that specific person's voice.
  await tx(async (c) => {
    await c.query('UPDATE email_accounts SET user_id = $1 WHERE user_id = $2', [req.user.id, u.id]);
    await c.query('UPDATE tasks SET created_by = $1 WHERE created_by = $2', [req.user.id, u.id]);
    await c.query('UPDATE canned_responses SET user_id = $1 WHERE user_id = $2', [req.user.id, u.id]);
    await c.query('DELETE FROM users WHERE id = $1', [u.id]);
  });
  res.json({ ok: true });
}));

module.exports = router;
