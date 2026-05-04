const express = require('express');
const { one, many, query } = require('../db');
const { requireAuth } = require('../auth');
const wrap = require('../util/wrap');

const router = express.Router();
router.use(requireAuth);

router.get('/', wrap(async (req, res) => {
  const rows = await many(
    `SELECT s.id, s.account_id, s.thread_id, s.to_addrs, s.cc_addrs, s.subject,
            s.send_at, s.status, s.error, s.created_at,
            a.email AS from_email
     FROM scheduled_messages s
     LEFT JOIN email_accounts a ON a.id = s.account_id
     WHERE s.workspace_id = $1 AND s.user_id = $2
     ORDER BY s.send_at ASC LIMIT 200`,
    [req.user.workspace_id, req.user.id]
  );
  res.json({ scheduled: rows });
}));

router.delete('/:id', wrap(async (req, res) => {
  const s = await one(
    `SELECT id FROM scheduled_messages WHERE id = $1 AND workspace_id = $2 AND user_id = $3 AND status = 'pending'`,
    [req.params.id, req.user.workspace_id, req.user.id]
  );
  if (!s) return res.status(404).json({ error: 'not found or already sent' });
  await query('DELETE FROM scheduled_messages WHERE id = $1', [s.id]);
  res.json({ ok: true });
}));

module.exports = router;
