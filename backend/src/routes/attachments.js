const express = require('express');
const { one } = require('../db');
const { requireAuth } = require('../auth');
const wrap = require('../util/wrap');

const router = express.Router();
router.use(requireAuth);

router.get('/:id', wrap(async (req, res) => {
  const a = await one(
    'SELECT * FROM attachments WHERE id = $1 AND workspace_id = $2',
    [req.params.id, req.user.workspace_id]
  );
  if (!a) return res.status(404).json({ error: 'not found' });
  res.setHeader('Content-Type', a.content_type || 'application/octet-stream');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${(a.filename || 'file').replace(/"/g, '')}"`
  );
  res.send(a.data);
}));

module.exports = router;
