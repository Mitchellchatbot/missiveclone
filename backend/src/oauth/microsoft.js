const { one, query } = require('../db');
const { encrypt, decrypt } = require('../crypto');

const TENANT = process.env.MICROSOFT_TENANT || 'common';
const CLIENT_ID = process.env.MICROSOFT_CLIENT_ID;
const CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET;
const REDIRECT_URI = process.env.MICROSOFT_REDIRECT_URI;

const SCOPES = [
  'https://outlook.office.com/IMAP.AccessAsUser.All',
  'https://outlook.office.com/SMTP.Send',
  'offline_access',
  'openid', 'profile', 'email',
  'User.Read'
].join(' ');

function isConfigured() {
  return !!(CLIENT_ID && CLIENT_SECRET && REDIRECT_URI);
}

function authorizeUrl(state) {
  const url = new URL(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`);
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('response_mode', 'query');
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('state', state);
  url.searchParams.set('prompt', 'select_account');
  return url.toString();
}

async function exchangeCodeForTokens(code) {
  const res = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      scope: SCOPES
    })
  });
  const body = await res.json();
  if (!res.ok) {
    const err = new Error(body.error_description || body.error || 'token exchange failed');
    err.body = body;
    throw err;
  }
  return body;
}

async function refreshTokens(refreshToken) {
  const res = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: SCOPES
    })
  });
  const body = await res.json();
  if (!res.ok) {
    const err = new Error(body.error_description || body.error || 'token refresh failed');
    err.body = body;
    throw err;
  }
  return body;
}

async function fetchProfile(accessToken) {
  const r = await fetch('https://graph.microsoft.com/v1.0/me', {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  return r.ok ? await r.json() : null;
}

// Returns a fresh access token for an account, refreshing if needed.
async function ensureFreshAccessToken(account) {
  if (!account.oauth_refresh_token) throw new Error('no refresh token on account');

  const expiresAt = Number(account.oauth_expires_at) || 0;
  if (account.oauth_access_token && Date.now() < expiresAt - 30 * 1000) {
    return decrypt(account.oauth_access_token);
  }

  const tokens = await refreshTokens(decrypt(account.oauth_refresh_token));
  const newAccess = tokens.access_token;
  const newRefresh = tokens.refresh_token || decrypt(account.oauth_refresh_token);
  const newExp = Date.now() + (tokens.expires_in - 60) * 1000;

  await query(
    `UPDATE email_accounts
       SET oauth_access_token = $1, oauth_refresh_token = $2, oauth_expires_at = $3
       WHERE id = $4`,
    [encrypt(newAccess), encrypt(newRefresh), newExp, account.id]
  );

  return newAccess;
}

module.exports = {
  isConfigured, authorizeUrl, exchangeCodeForTokens, refreshTokens,
  fetchProfile, ensureFreshAccessToken, SCOPES
};
