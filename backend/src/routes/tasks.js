const express = require('express');
const { v4: uuid } = require('uuid');
const { one, many, query } = require('../db');
const { requireAuth } = require('../auth');
const { emitToWorkspace } = require('../sockets');
const wrap = require('../util/wrap');

const router = express.Router();
router.use(requireAuth);

router.get('/', wrap(async (req, res) => {
  const { status, assignee, team_space_id } = req.query;
  const params = [req.user.workspace_id];
  let sql = `SELECT t.*, u.name AS assignee_name, c.name AS created_by_name
             FROM tasks t
             LEFT JOIN users u ON u.id = t.assignee_id
             LEFT JOIN users c ON c.id = t.created_by
             WHERE t.workspace_id = $1`;
  if (status) { params.push(status); sql += ` AND t.status = $${params.length}`; }
  if (assignee === 'me') { params.push(req.user.id); sql += ` AND t.assignee_id = $${params.length}`; }
  else if (assignee) { params.push(assignee); sql += ` AND t.assignee_id = $${params.length}`; }
  if (team_space_id) { params.push(team_space_id); sql += ` AND t.team_space_id = $${params.length}`; }
  sql += ` ORDER BY
    CASE t.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END,
    t.due_at NULLS LAST,
    t.created_at DESC
    LIMIT 300`;
  const rows = await many(sql, params);
  res.json({ tasks: rows });
}));

router.post('/', wrap(async (req, res) => {
  const { title, description, assignee_id, due_at, team_space_id, thread_id } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: 'title required' });
  const id = uuid();
  const now = Date.now();
  await query(
    `INSERT INTO tasks
       (id, workspace_id, team_space_id, thread_id, title, description, assignee_id,
        status, due_at, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'open', $8, $9, $10, $10)`,
    [id, req.user.workspace_id, team_space_id || null, thread_id || null,
     title.trim(), description || null, assignee_id || null,
     due_at ? Number(due_at) : null, req.user.id, now]
  );
  emitToWorkspace(req.user.workspace_id, 'task:updated', { id });
  res.json({ id });
}));

router.patch('/:id', wrap(async (req, res) => {
  const t = await one(
    'SELECT id FROM tasks WHERE id = $1 AND workspace_id = $2',
    [req.params.id, req.user.workspace_id]
  );
  if (!t) return res.status(404).json({ error: 'not found' });
  const allowed = ['title', 'description', 'assignee_id', 'status', 'due_at', 'team_space_id'];
  const sets = [];
  const params = [];
  for (const k of allowed) {
    if (k in (req.body || {})) {
      params.push(k === 'due_at' && req.body[k] ? Number(req.body[k]) : (req.body[k] || null));
      sets.push(`${k} = $${params.length}`);
    }
  }
  if (!sets.length) return res.json({ ok: true });
  params.push(Date.now());
  sets.push(`updated_at = $${params.length}`);
  params.push(t.id);
  await query(`UPDATE tasks SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
  emitToWorkspace(req.user.workspace_id, 'task:updated', { id: t.id });
  res.json({ ok: true });
}));

router.delete('/:id', wrap(async (req, res) => {
  const t = await one(
    'SELECT id FROM tasks WHERE id = $1 AND workspace_id = $2',
    [req.params.id, req.user.workspace_id]
  );
  if (!t) return res.status(404).json({ error: 'not found' });
  await query('DELETE FROM tasks WHERE id = $1', [t.id]);
  emitToWorkspace(req.user.workspace_id, 'task:updated', { id: t.id, deleted: true });
  res.json({ ok: true });
}));

module.exports = router;
