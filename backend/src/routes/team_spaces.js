const express = require('express');
const { v4: uuid } = require('uuid');
const { one, many, query, tx } = require('../db');
const { requireAuth } = require('../auth');
const { emitToWorkspace } = require('../sockets');
const wrap = require('../util/wrap');

const router = express.Router();
router.use(requireAuth);

router.get('/', wrap(async (req, res) => {
  const rows = await many(
    `SELECT ts.id, ts.name, ts.created_at,
            (SELECT count(*)::int FROM team_space_members m WHERE m.team_space_id = ts.id) AS member_count,
            (SELECT count(*)::int FROM email_accounts a WHERE a.team_space_id = ts.id) AS account_count
     FROM team_spaces ts
     WHERE ts.workspace_id = $1
     ORDER BY ts.created_at ASC`,
    [req.user.workspace_id]
  );
  res.json({ team_spaces: rows });
}));

router.get('/:id/members', wrap(async (req, res) => {
  const ts = await one(
    'SELECT id FROM team_spaces WHERE id = $1 AND workspace_id = $2',
    [req.params.id, req.user.workspace_id]
  );
  if (!ts) return res.status(404).json({ error: 'not found' });
  const members = await many(
    `SELECT u.id, u.email, u.name FROM team_space_members m
     JOIN users u ON u.id = m.user_id
     WHERE m.team_space_id = $1 ORDER BY u.name`,
    [ts.id]
  );
  res.json({ members });
}));

router.post('/', wrap(async (req, res) => {
  const { name, member_ids } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });
  const id = uuid();
  const now = Date.now();
  await tx(async (c) => {
    await c.query(
      'INSERT INTO team_spaces (id, workspace_id, name, created_at) VALUES ($1, $2, $3, $4)',
      [id, req.user.workspace_id, name.trim(), now]
    );
    // Always add the creator
    await c.query(
      'INSERT INTO team_space_members (team_space_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [id, req.user.id]
    );
    if (Array.isArray(member_ids)) {
      for (const uid of member_ids) {
        const u = await c.query('SELECT id FROM users WHERE id = $1 AND workspace_id = $2', [uid, req.user.workspace_id]);
        if (u.rows[0]) {
          await c.query(
            'INSERT INTO team_space_members (team_space_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [id, uid]
          );
        }
      }
    }
  });
  emitToWorkspace(req.user.workspace_id, 'team_space:updated', { id });
  res.json({ id });
}));

router.patch('/:id', wrap(async (req, res) => {
  const { name } = req.body || {};
  const ts = await one(
    'SELECT id FROM team_spaces WHERE id = $1 AND workspace_id = $2',
    [req.params.id, req.user.workspace_id]
  );
  if (!ts) return res.status(404).json({ error: 'not found' });
  if (name && name.trim()) {
    await query('UPDATE team_spaces SET name = $1 WHERE id = $2', [name.trim(), ts.id]);
  }
  emitToWorkspace(req.user.workspace_id, 'team_space:updated', { id: ts.id });
  res.json({ ok: true });
}));

router.post('/:id/members', wrap(async (req, res) => {
  const { user_id } = req.body || {};
  const ts = await one(
    'SELECT id FROM team_spaces WHERE id = $1 AND workspace_id = $2',
    [req.params.id, req.user.workspace_id]
  );
  if (!ts) return res.status(404).json({ error: 'not found' });
  const u = await one('SELECT id FROM users WHERE id = $1 AND workspace_id = $2', [user_id, req.user.workspace_id]);
  if (!u) return res.status(400).json({ error: 'user not in workspace' });
  await query(
    'INSERT INTO team_space_members (team_space_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [ts.id, u.id]
  );
  res.json({ ok: true });
}));

router.delete('/:id/members/:userId', wrap(async (req, res) => {
  const ts = await one(
    'SELECT id FROM team_spaces WHERE id = $1 AND workspace_id = $2',
    [req.params.id, req.user.workspace_id]
  );
  if (!ts) return res.status(404).json({ error: 'not found' });
  await query(
    'DELETE FROM team_space_members WHERE team_space_id = $1 AND user_id = $2',
    [ts.id, req.params.userId]
  );
  res.json({ ok: true });
}));

router.delete('/:id', wrap(async (req, res) => {
  const ts = await one(
    'SELECT id FROM team_spaces WHERE id = $1 AND workspace_id = $2',
    [req.params.id, req.user.workspace_id]
  );
  if (!ts) return res.status(404).json({ error: 'not found' });
  // Refuse to delete the last team space — UI relies on at least one.
  const count = await one('SELECT count(*)::int AS n FROM team_spaces WHERE workspace_id = $1', [req.user.workspace_id]);
  if (count && count.n <= 1) return res.status(400).json({ error: 'cannot delete the last team space' });
  await query('DELETE FROM team_spaces WHERE id = $1', [ts.id]);
  emitToWorkspace(req.user.workspace_id, 'team_space:updated', { id: ts.id, deleted: true });
  res.json({ ok: true });
}));

module.exports = router;
