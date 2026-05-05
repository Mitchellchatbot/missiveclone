const { one, query } = require('../db');
const { encrypt, decrypt } = require('../crypto');

const TENANT = process.env.MICROSOFT_TENANT || 'common';
const CLIENT_ID = process.env.MICROSOFT_CLIENT_ID;
const CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET;
const REDIRECT_URI = process.env.MICROSOFT_REDIRECT_URI;

// IMPORTANT: only request scopes from a single resource here. Mixing Graph
// (User.Read) and Outlook (IMAP/SMTP) makes Microsoft issue a token valid
// for only one of them, which silently breaks Graph calls. We use the
// id_token (openid claims) to read the user's profile instead — no extra
// API call needed.
const SCOPES = [
  'https://outlook.office.com/IMAP.AccessAsUser.All',
  'https://outlook.office.com/SMTP.Send',
  'offline_access',
  'openid', 'profile', 'email'
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

// Decode the JWT id_token (without verifying signature — Microsoft already
// authenticated the token via the channel it came in on). Returns the
// claims object: { email, name, preferred_username, oid, ... }.
function decodeIdToken(idToken) {
  if (!idToken || typeof idToken !== 'string') return null;
  const parts = idToken.split('.');
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(
      parts[1].replace(/-/g, '+').replace(/_/g, '/'),
      'base64'
    ).toString('utf8');
    return JSON.parse(json);
  } catch { return null; }
}

// Fallback: Outlook REST API works with our Outlook-resource access token.
async function fetchOutlookProfile(accessToken) {
  try {
    const r = await fetch('https://outlook.office.com/api/v2.0/me', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!r.ok) return null;
    const j = await r.json();
    return {
      mail: j.EmailAddress,
      userPrincipalName: j.EmailAddress,
      displayName: j.DisplayName
    };
  } catch { return null; }
}

// Combined: prefer id_token claims, fall back to Outlook REST.
async function fetchProfile(tokens) {
  const claims = decodeIdToken(tokens.id_token);
  if (claims) {
    const email = claims.email || claims.preferred_username || claims.upn;
    if (email) {
      return {
        mail: email,
        userPrincipalName: email,
        displayName: claims.name || email
      };
    }
  }
  if (tokens.access_token) {
    const p = await fetchOutlookProfile(tokens.access_token);
    if (p) return p;
  }
  return null;
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
