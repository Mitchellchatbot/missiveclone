const express = require('express');
const { one } = require('../db');
const { requireAuth } = require('../auth');
const wrap = require('../util/wrap');

const router = express.Router();
router.use(requireAuth);

// GET /api/messages/:id/body — the HTML/text body of a single message.
//
// Split out from GET /api/threads/:id so the thread-detail response can defer
// non-latest bodies (?defer_bodies=1) and clients fetch each one on demand when
// the user expands that message. Workspace-scoped exactly like the attachment
// route: the service token is workspace-wide, so the id is filtered by
// req.user.workspace_id. The DD proxy layers the per-user thread-visibility
// check on top before ever calling this.
router.get('/:id/body', wrap(async (req, res) => {
  const m = await one(
    'SELECT id, body_html, body_text FROM messages WHERE id = $1 AND workspace_id = $2',
    [req.params.id, req.user.workspace_id]
  );
  if (!m) return res.status(404).json({ error: 'not found' });
  res.json({ id: m.id, body_html: m.body_html, body_text: m.body_text });
}));

module.exports = router;
