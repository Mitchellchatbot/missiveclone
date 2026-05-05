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

router.patch('/:id', wrap(async (req, res) => {
  const { display_name, team_space_id, move_threads } = req.body || {};
  const acc = await one(
    'SELECT id, team_space_id FROM email_accounts WHERE id = $1 AND workspace_id = $2',
    [req.params.id, req.user.workspace_id]
  );
  if (!acc) return res.status(404).json({ error: 'not found' });

  // Validate team_space_id if provided.
  if (team_space_id) {
    const ts = await one(
      'SELECT id FROM team_spaces WHERE id = $1 AND workspace_id = $2',
      [team_space_id, req.user.workspace_id]
    );
    if (!ts) return res.status(400).json({ error: 'team_space_id invalid' });
  }

  const sets = [];
  const params = [];
  if (display_name !== undefined) { params.push(display_name || null); sets.push(`display_name = $${params.length}`); }
  if (team_space_id !== undefined) { params.push(team_space_id || null); sets.push(`team_space_id = $${params.length}`); }
  if (sets.length) {
    params.push(acc.id);
    await query(`UPDATE email_accounts SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
  }

  // Optional: move all existing threads from this account to the new space too.
  if (team_space_id !== undefined && (move_threads === undefined || move_threads === true)) {
    await query(
      `UPDATE threads SET team_space_id = $1
       WHERE workspace_id = $2
         AND id IN (SELECT DISTINCT m.thread_id FROM messages m WHERE m.account_id = $3)`,
      [team_space_id || null, req.user.workspace_id, acc.id]
    );
  }

  res.json({ ok: true });
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

router.get('/:id/signature', wrap(async (req, res) => {
  const acc = await one(
    'SELECT id, signature_text, signature_html FROM email_accounts WHERE id = $1 AND workspace_id = $2',
    [req.params.id, req.user.workspace_id]
  );
  if (!acc) return res.status(404).json({ error: 'not found' });
  res.json({
    signature_text: acc.signature_text || '',
    signature_html: acc.signature_html || ''
  });
}));

router.put('/:id/signature', wrap(async (req, res) => {
  const { signature_text, signature_html } = req.body || {};
  const acc = await one(
    'SELECT id FROM email_accounts WHERE id = $1 AND workspace_id = $2',
    [req.params.id, req.user.workspace_id]
  );
  if (!acc) return res.status(404).json({ error: 'not found' });
  await query(
    'UPDATE email_accounts SET signature_text = $1, signature_html = $2 WHERE id = $3',
    [signature_text || null, signature_html || null, acc.id]
  );
  res.json({ ok: true });
}));

module.exports = router;
