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
    `SELECT id, email, display_name, imap_host, smtp_host, last_synced_at,
            last_sync_error, last_sync_error_at,
            team_space_id, user_id, provider
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

  // Re-link any orphaned messages from a previous connection of this email.
  await query(
    `UPDATE messages SET account_id = $1
     WHERE workspace_id = $2 AND account_id IS NULL
       AND (to_addrs ILIKE $3 OR from_addr ILIKE $3 OR cc_addrs ILIKE $3)`,
    [id, req.user.workspace_id, `%${email}%`]
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

// Diagnostic: confirm a Microsoft account's refresh token can mint a Graph
// Mail.ReadWrite token AND that the resulting token can actually read mail.
// Used to verify a migration from IMAP-sync to Graph-sync wouldn't force
// every user to re-OAuth. If this returns ok:true, the existing tokens are
// already good enough for inbound sync via Graph.
router.post('/:id/test-graph', wrap(async (req, res) => {
  const acc = await one(
    `SELECT id, email, provider, oauth_refresh_token
     FROM email_accounts WHERE id = $1 AND workspace_id = $2`,
    [req.params.id, req.user.workspace_id]
  );
  if (!acc) return res.status(404).json({ error: 'not found' });
  if (acc.provider !== 'microsoft') return res.status(400).json({ error: 'not a microsoft account' });
  if (!acc.oauth_refresh_token) return res.status(400).json({ error: 'no refresh token stored' });

  const ms = require('../oauth/microsoft');
  const READ_SCOPE = 'https://graph.microsoft.com/Mail.ReadWrite offline_access';
  try {
    const token = await ms.getAccessTokenForResource(acc, READ_SCOPE);
    const r = await fetch('https://graph.microsoft.com/v1.0/me/messages?$top=1&$select=id,subject,receivedDateTime', {
      headers: { Authorization: `Bearer ${token}` }
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.json({
        ok: false,
        token_minted: true,
        graph_read_status: r.status,
        graph_error: body.error || body
      });
    }
    return res.json({
      ok: true,
      token_minted: true,
      graph_read_status: r.status,
      sample_count: Array.isArray(body.value) ? body.value.length : 0,
      sample_subject: body.value && body.value[0] && body.value[0].subject
    });
  } catch (err) {
    return res.json({
      ok: false,
      token_minted: false,
      stage: 'token_mint',
      error: err.message,
      oauth: err.body || null
    });
  }
}));

// Workspace-wide rescan. Clears every Microsoft account's Graph delta
// cursor (folder_sync_state.delta_link) so the next sync re-walks the
// full mailbox from Outlook. ingestMessage dedupes on
// (message_id, account_id, direction), so re-fetching previously-seen
// messages is bandwidth cost only — no duplicate rows. Returns
// immediately and runs sync in the background; check /api/accounts
// for last_synced_at to know when each account is done.
router.post('/rescan-all', wrap(async (req, res) => {
  const accs = await many(
    `SELECT id, email FROM email_accounts
     WHERE workspace_id = $1 AND provider = 'microsoft'`,
    [req.user.workspace_id]
  );
  if (!accs.length) return res.json({ ok: true, accounts: 0 });

  await query(
    `UPDATE folder_sync_state SET delta_link = NULL
     WHERE account_id = ANY($1::text[])`,
    [accs.map(a => a.id)]
  );

  // Fire each sync without awaiting — let them run in parallel and let
  // the response come back fast. Per-user Graph rate limits apply per
  // account, so concurrent fan-out is safe.
  for (const a of accs) {
    syncAccount(a.id).catch((err) => {
      console.warn(`[rescan] sync failed for ${a.email}: ${err && err.message}`);
    });
  }

  res.json({ ok: true, accounts: accs.length, account_ids: accs.map(a => a.id) });
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

// One-shot: re-link any messages whose account_id is NULL (from a previous
// disconnect-then-reconnect) to this account if their headers mention this
// email. Safe to call multiple times.
router.post('/:id/relink-orphans', wrap(async (req, res) => {
  const acc = await one(
    'SELECT id, email FROM email_accounts WHERE id = $1 AND workspace_id = $2',
    [req.params.id, req.user.workspace_id]
  );
  if (!acc) return res.status(404).json({ error: 'not found' });
  const r = await query(
    `UPDATE messages SET account_id = $1
     WHERE workspace_id = $2 AND account_id IS NULL
       AND (to_addrs ILIKE $3 OR from_addr ILIKE $3 OR cc_addrs ILIKE $3)`,
    [acc.id, req.user.workspace_id, `%${acc.email}%`]
  );
  res.json({ ok: true, relinked: r.rowCount || 0 });
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
