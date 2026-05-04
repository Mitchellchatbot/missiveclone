const express = require('express');
const { v4: uuid } = require('uuid');
const { one, many, query } = require('../db');
const { requireAuth } = require('../auth');
const { emitToWorkspace } = require('../sockets');
const wrap = require('../util/wrap');

const router = express.Router();
router.use(requireAuth);

router.get('/', wrap(async (req, res) => {
  const rows = await many(
    'SELECT id, name, color, created_at FROM labels WHERE workspace_id = $1 ORDER BY name',
    [req.user.workspace_id]
  );
  res.json({ labels: rows });
}));

router.post('/', wrap(async (req, res) => {
  const { name, color } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });
  const id = uuid();
  await query(
    'INSERT INTO labels (id, workspace_id, name, color, created_at) VALUES ($1, $2, $3, $4, $5)',
    [id, req.user.workspace_id, name.trim(), color || '#2f6feb', Date.now()]
  );
  res.json({ id });
}));

router.patch('/:id', wrap(async (req, res) => {
  const { name, color } = req.body || {};
  const l = await one(
    'SELECT id FROM labels WHERE id = $1 AND workspace_id = $2',
    [req.params.id, req.user.workspace_id]
  );
  if (!l) return res.status(404).json({ error: 'not found' });
  const sets = [];
  const params = [];
  if (name) { params.push(name.trim()); sets.push(`name = $${params.length}`); }
  if (color) { params.push(color); sets.push(`color = $${params.length}`); }
  if (sets.length) {
    params.push(l.id);
    await query(`UPDATE labels SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
  }
  res.json({ ok: true });
}));

router.delete('/:id', wrap(async (req, res) => {
  const l = await one(
    'SELECT id FROM labels WHERE id = $1 AND workspace_id = $2',
    [req.params.id, req.user.workspace_id]
  );
  if (!l) return res.status(404).json({ error: 'not found' });
  await query('DELETE FROM labels WHERE id = $1', [l.id]);
  res.json({ ok: true });
}));

// Apply / remove on a thread.
router.post('/apply', wrap(async (req, res) => {
  const { thread_id, label_id } = req.body || {};
  const t = await one('SELECT id FROM threads WHERE id = $1 AND workspace_id = $2', [thread_id, req.user.workspace_id]);
  const l = await one('SELECT id FROM labels WHERE id = $1 AND workspace_id = $2', [label_id, req.user.workspace_id]);
  if (!t || !l) return res.status(404).json({ error: 'not found' });
  await query(
    'INSERT INTO thread_labels (thread_id, label_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [t.id, l.id]
  );
  emitToWorkspace(req.user.workspace_id, 'thread:updated', { thread_id: t.id });
  res.json({ ok: true });
}));

router.post('/remove', wrap(async (req, res) => {
  const { thread_id, label_id } = req.body || {};
  const t = await one('SELECT id FROM threads WHERE id = $1 AND workspace_id = $2', [thread_id, req.user.workspace_id]);
  if (!t) return res.status(404).json({ error: 'not found' });
  await query('DELETE FROM thread_labels WHERE thread_id = $1 AND label_id = $2', [t.id, label_id]);
  emitToWorkspace(req.user.workspace_id, 'thread:updated', { thread_id: t.id });
  res.json({ ok: true });
}));

module.exports = router;
