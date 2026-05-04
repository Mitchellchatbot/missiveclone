const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { v4: uuid } = require('uuid');
const { one, many, query, tx } = require('../db');
const { requireAuth, sign } = require('../auth');
const wrap = require('../util/wrap');

const router = express.Router();

const INVITE_TTL_DAYS = 14;

// ----- Authenticated: create + list invites -----
router.get('/', requireAuth, wrap(async (req, res) => {
  const rows = await many(
    `SELECT id, email, token, accepted_at, created_at, expires_at
     FROM invites WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 100`,
    [req.user.workspace_id]
  );
  res.json({ invites: rows });
}));

router.post('/', requireAuth, wrap(async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'email required' });
  const lowered = email.toLowerCase();

  const existingUser = await one('SELECT id FROM users WHERE email = $1', [lowered]);
  if (existingUser) return res.status(409).json({ error: 'user already has an account' });

  const id = uuid();
  const token = crypto.randomBytes(24).toString('hex');
  const now = Date.now();
  const expires = now + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000;

  await query(
    `INSERT INTO invites (id, workspace_id, invited_by, email, token, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, req.user.workspace_id, req.user.id, lowered, token, now, expires]
  );

  res.json({ id, token, email: lowered, expires_at: expires });
}));

router.delete('/:id', requireAuth, wrap(async (req, res) => {
  const inv = await one(
    'SELECT id FROM invites WHERE id = $1 AND workspace_id = $2',
    [req.params.id, req.user.workspace_id]
  );
  if (!inv) return res.status(404).json({ error: 'not found' });
  await query('DELETE FROM invites WHERE id = $1', [inv.id]);
  res.json({ ok: true });
}));

// ----- Public: read invite by token (so the accept page can show context) -----
router.get('/by-token/:token', wrap(async (req, res) => {
  const inv = await one(
    `SELECT i.id, i.email, i.workspace_id, i.expires_at, i.accepted_at, w.name AS workspace_name
     FROM invites i JOIN workspaces w ON w.id = i.workspace_id
     WHERE i.token = $1`,
    [req.params.token]
  );
  if (!inv) return res.status(404).json({ error: 'invite not found' });
  if (inv.accepted_at) return res.status(410).json({ error: 'already accepted' });
  if (Number(inv.expires_at) < Date.now()) return res.status(410).json({ error: 'invite expired' });
  res.json({
    email: inv.email,
    workspace_name: inv.workspace_name,
    expires_at: inv.expires_at
  });
}));

// ----- Public: accept invite (creates user account in workspace) -----
router.post('/accept', wrap(async (req, res) => {
  const { token, name, password } = req.body || {};
  if (!token || !name || !password) return res.status(400).json({ error: 'token, name, password required' });

  const inv = await one('SELECT * FROM invites WHERE token = $1', [token]);
  if (!inv) return res.status(404).json({ error: 'invite not found' });
  if (inv.accepted_at) return res.status(410).json({ error: 'already accepted' });
  if (Number(inv.expires_at) < Date.now()) return res.status(410).json({ error: 'invite expired' });

  const existing = await one('SELECT id FROM users WHERE email = $1', [inv.email]);
  if (existing) return res.status(409).json({ error: 'email already registered' });

  const userId = uuid();
  const now = Date.now();
  const hash = bcrypt.hashSync(password, 10);

  await tx(async (c) => {
    await c.query(
      'INSERT INTO users (id, workspace_id, email, password_hash, name, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [userId, inv.workspace_id, inv.email, hash, name, now]
    );
    await c.query('UPDATE invites SET accepted_at = $1 WHERE id = $2', [now, inv.id]);
  });

  const user = await one('SELECT id, workspace_id, email, name FROM users WHERE id = $1', [userId]);
  res.json({ token: sign(user), user });
}));

module.exports = router;
