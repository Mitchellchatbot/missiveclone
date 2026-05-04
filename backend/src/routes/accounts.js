const express = require('express');
const { v4: uuid } = require('uuid');
const { one, many, query } = require('../db');
// (one is used below for team_space lookup)
const { requireAuth } = require('../auth');
const { encrypt } = require('../crypto');
const { syncAccount, startWatching, stopWatching } = require('../email/imap');
const wrap = require('../util/wrap');

const router = express.Router();
router.use(requireAuth);

router.get('/', wrap(async (req, res) => {
  const rows = await many(
    `SELECT id, email, display_name, imap_host, smtp_host, last_synced_at, team_space_id
     FROM email_accounts WHERE workspace_id = $1`,
    [req.user.workspace_id]
  );
  res.json({ accounts: rows });
}));

router.post('/', wrap(async (req, res) => {
  const {
    email, display_name, team_space_id,
    imap_host, imap_port, imap_secure, imap_user, imap_pass,
    smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass
  } = req.body || {};

  if (!email || !imap_host || !imap_port || !imap_user || !imap_pass ||
      !smtp_host || !smtp_port || !smtp_user || !smtp_pass) {
    return res.status(400).json({ error: 'missing fields' });
  }

  // If a team_space_id is provided, verify it belongs to this workspace.
  // Otherwise default to the workspace's first team_space (the General one).
  let tsId = team_space_id || null;
  if (tsId) {
    const ts = await one('SELECT id FROM team_spaces WHERE id = $1 AND workspace_id = $2', [tsId, req.user.workspace_id]);
    if (!ts) return res.status(400).json({ error: 'team_space_id invalid' });
  } else {
    const ts = await one(
      'SELECT id FROM team_spaces WHERE workspace_id = $1 ORDER BY created_at ASC LIMIT 1',
      [req.user.workspace_id]
    );
    tsId = ts ? ts.id : null;
  }

  const id = uuid();
  await query(
    `INSERT INTO email_accounts
      (id, workspace_id, user_id, email, display_name, team_space_id,
       imap_host, imap_port, imap_secure, imap_user, imap_pass,
       smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass,
       created_at)
      VALUES ($1, $2, $3, $4, $5, $6,  $7, $8, $9, $10, $11,  $12, $13, $14, $15, $16, $17)`,
    [
      id, req.user.workspace_id, req.user.id, email, display_name || null, tsId,
      imap_host, Number(imap_port), imap_secure ? 1 : 0, imap_user, encrypt(imap_pass),
      smtp_host, Number(smtp_port), smtp_secure ? 1 : 0, smtp_user, encrypt(smtp_pass),
      Date.now()
    ]
  );

  syncAccount(id).then(() => startWatching(id)).catch(err => console.error('initial sync error', err));
  res.json({ id });
}));

router.delete('/:id', wrap(async (req, res) => {
  const acc = await one(
    'SELECT id FROM email_accounts WHERE id = $1 AND workspace_id = $2',
    [req.params.id, req.user.workspace_id]
  );
  if (!acc) return res.status(404).json({ error: 'not found' });
  stopWatching(acc.id);
  await query('DELETE FROM email_accounts WHERE id = $1', [acc.id]);
  res.json({ ok: true });
}));

router.post('/:id/sync', wrap(async (req, res) => {
  const acc = await one(
    'SELECT id FROM email_accounts WHERE id = $1 AND workspace_id = $2',
    [req.params.id, req.user.workspace_id]
  );
  if (!acc) return res.status(404).json({ error: 'not found' });
  const n = await syncAccount(acc.id);
  res.json({ ok: true, new_messages: n });
}));

module.exports = router;
