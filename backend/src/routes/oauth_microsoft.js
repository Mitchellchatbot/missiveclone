const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { v4: uuid } = require('uuid');
const { one, query } = require('../db');
const { requireAuth } = require('../auth');
const { encrypt } = require('../crypto');
const ms = require('../oauth/microsoft');
const { syncAccount, startWatching } = require('../email/imap');
const wrap = require('../util/wrap');

const router = express.Router();

// GET /api/oauth/microsoft/start
// Authenticated. Returns the URL the browser should redirect to.
router.get('/start', requireAuth, wrap(async (req, res) => {
  if (!ms.isConfigured()) {
    return res.status(503).json({
      error: 'Microsoft OAuth not configured. Server admin must set MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, MICROSOFT_REDIRECT_URI.'
    });
  }
  const { team_space_id } = req.query;
  const state = jwt.sign(
    {
      kind: 'oauth_microsoft',
      workspace_id: req.user.workspace_id,
      user_id: req.user.id,
      team_space_id: team_space_id || null,
      nonce: crypto.randomBytes(8).toString('hex')
    },
    process.env.JWT_SECRET,
    { expiresIn: '10m' }
  );
  res.json({ url: ms.authorizeUrl(state) });
}));

// GET /api/oauth/microsoft/callback
// Public — authorization code grant return.
router.get('/callback', wrap(async (req, res) => {
  const { code, state, error, error_description } = req.query;

  function fail(msg, detail) {
    return res
      .status(400)
      .send(htmlPage(`<h1>Microsoft OAuth failed</h1><p>${escapeHtml(msg)}</p>${detail ? `<pre>${escapeHtml(detail)}</pre>` : ''}<p><a href="/">Return to app</a></p>`));
  }

  if (error) return fail(error, error_description);
  if (!code || !state) return fail('Missing code or state');

  let stateData;
  try { stateData = jwt.verify(state, process.env.JWT_SECRET); }
  catch { return fail('Invalid or expired state'); }
  if (stateData.kind !== 'oauth_microsoft') return fail('Wrong state kind');

  let tokens;
  try { tokens = await ms.exchangeCodeForTokens(code); }
  catch (e) { return fail('Token exchange failed', e.message); }

  const profile = await ms.fetchProfile(tokens.access_token);
  if (!profile) return fail('Failed to read Microsoft profile');
  const email = (profile.mail || profile.userPrincipalName || '').toLowerCase();
  if (!email) return fail('Microsoft profile has no email');

  const expiresAt = Date.now() + (Number(tokens.expires_in) - 60) * 1000;
  const accessEnc = encrypt(tokens.access_token);
  const refreshEnc = encrypt(tokens.refresh_token || '');

  // Default to first team space if none chosen.
  let tsId = stateData.team_space_id;
  if (!tsId) {
    const ts = await one(
      'SELECT id FROM team_spaces WHERE workspace_id = $1 ORDER BY created_at LIMIT 1',
      [stateData.workspace_id]
    );
    tsId = ts ? ts.id : null;
  }

  const existing = await one(
    'SELECT id FROM email_accounts WHERE workspace_id = $1 AND lower(email) = $2',
    [stateData.workspace_id, email]
  );

  let accountId;
  if (existing) {
    accountId = existing.id;
    await query(
      `UPDATE email_accounts
         SET provider = 'microsoft',
             oauth_access_token = $1,
             oauth_refresh_token = $2,
             oauth_expires_at = $3,
             team_space_id = COALESCE(team_space_id, $4),
             display_name = COALESCE(display_name, $5)
         WHERE id = $6`,
      [accessEnc, refreshEnc, expiresAt, tsId, profile.displayName || null, existing.id]
    );
  } else {
    accountId = uuid();
    await query(
      `INSERT INTO email_accounts
        (id, workspace_id, user_id, email, display_name, team_space_id,
         provider, oauth_access_token, oauth_refresh_token, oauth_expires_at,
         imap_host, imap_port, imap_secure, imap_user,
         smtp_host, smtp_port, smtp_secure, smtp_user,
         created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'microsoft', $7, $8, $9,
               $10, $11, $12, $13,
               $14, $15, $16, $17,
               $18)`,
      [
        accountId, stateData.workspace_id, stateData.user_id,
        email, profile.displayName || email, tsId,
        accessEnc, refreshEnc, expiresAt,
        'outlook.office365.com', 993, 1, email,
        'smtp.office365.com', 587, 0, email,
        Date.now()
      ]
    );
  }

  // Kick off initial sync (non-blocking).
  syncAccount(accountId)
    .then(() => startWatching(accountId))
    .catch(err => console.error('initial sync after oauth', err.message));

  // Send the user back to the app.
  res.redirect('/?oauth=microsoft_ok');
}));

function htmlPage(body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Missive Clone — OAuth</title>
  <style>body{font-family:system-ui;-webkit-font-smoothing:antialiased;max-width:560px;margin:48px auto;padding:0 20px;color:#101828}
  h1{color:#c01048}pre{background:#f5f5f5;padding:12px;border-radius:6px;overflow:auto;font-size:12px}</style>
  </head><body>${body}</body></html>`;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

module.exports = router;
