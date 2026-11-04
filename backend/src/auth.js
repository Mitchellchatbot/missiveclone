const crypto = require('crypto');
const jwt = require('jsonwebtoken');

function sign(user) {
  return jwt.sign(
    { id: user.id, workspace_id: user.workspace_id, email: user.email },
    process.env.JWT_SECRET,
    // 10y instead of a typical session lifetime because this token is
    // used as a service-to-service credential (DelegationDoer holds it
    // in MISSIVE_API_TOKEN and replays it to call us). Rotating that
    // every 30 days meant operators had to log back in, copy the
    // token, and update Railway env — a chore that doesn't buy any
    // real security since the token already lives only in trusted
    // infra. JWT_SECRET rotation remains the actual kill switch.
    { expiresIn: '10y' }
  );
}

function verify(token) {
  return jwt.verify(token, process.env.JWT_SECRET);
}

// A session token is exactly what sign() mints: a JSON object (not an array,
// string or number) with a non-empty string `id` and `workspace_id`, and no
// `kind` claim. Other JWTs signed with JWT_SECRET (such as the OAuth state)
// are not sessions and must never authenticate a request. `kind` is rejected
// when present at all, so kind: null or kind: '' can't slip past a
// truthiness test.
// Returns null for a session payload, otherwise the rule it breaks.
function notSessionReason(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return 'not-object';
  if (Object.prototype.hasOwnProperty.call(payload, 'kind')) return 'kind';
  if (typeof payload.id !== 'string' || payload.id === '') return 'id';
  if (typeof payload.workspace_id !== 'string' || payload.workspace_id === '') return 'workspace_id';
  return null;
}

// verify() plus the session-shape check: the one gate for HTTP (requireAuth)
// and Socket.IO (sockets.js). It throws on any failure, so a token of the wrong
// shape gets the same 401 / refused handshake as a bad signature. That error
// carries code NOT_SESSION_TOKEN, the rule broken and (for a kind token such
// as the OAuth state) its kind, so the caller can log it: logNonSessionToken.
function verifySession(token) {
  const payload = verify(token);
  const reason = notSessionReason(payload);
  if (reason) {
    const e = new jwt.JsonWebTokenError('not a session token');
    e.code = 'NOT_SESSION_TOKEN';
    e.reason = reason;
    if (reason === 'kind' && typeof payload.kind === 'string') e.kind = payload.kind.slice(0, 40);
    throw e;
  }
  return payload;
}

// The 401 for a wrong-shape token is the same as for an expired token or one
// signed with another JWT_SECRET, so without this line a caller the session
// check breaks (a script holding a hand-signed token, say) would look exactly
// like those. Only a token that verified against JWT_SECRET gets this far, so
// nobody without the secret can make us log. Logged: the rule broken, the
// kind, where the token came from and a sha256 prefix of it, never the token
// or any other claim. At most once a minute per token, with the per-token
// memory capped. One JSON line, printable ASCII only.
const NON_SESSION_LOG_EVERY_MS = 60 * 1000;
const NON_SESSION_LOG_MAX_TOKENS = 1000;
const nonSessionLoggedAt = new Map(); // token fingerprint -> when it was last logged

function logNonSessionToken(err, token, where) {
  if (!err || err.code !== 'NOT_SESSION_TOKEN') return;
  try {
    const fp = crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 12);
    const now = Date.now();
    const last = nonSessionLoggedAt.get(fp);
    if (last !== undefined && now - last < NON_SESSION_LOG_EVERY_MS) return;
    if (nonSessionLoggedAt.size >= NON_SESSION_LOG_MAX_TOKENS) {
      for (const [k, at] of nonSessionLoggedAt) if (now - at >= NON_SESSION_LOG_EVERY_MS) nonSessionLoggedAt.delete(k);
      if (nonSessionLoggedAt.size >= NON_SESSION_LOG_MAX_TOKENS) nonSessionLoggedAt.clear();
    }
    nonSessionLoggedAt.set(fp, now);
    const fields = { ...where, reason: err.reason, kind: err.kind, fp };
    console.warn('[auth] rejected non-session token', JSON.stringify(fields,
      (_k, v) => (typeof v === 'string' ? v.slice(0, 200).replace(/[^\x20-\x7e]/g, '?') : v)));
  } catch { /* logging must never change the response */ }
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'missing token' });
  try {
    req.user = verifySession(token);
    next();
  } catch (e) {
    // The path as requested, without the query string, which stays out of the log.
    logNonSessionToken(e, token, { via: 'http', method: req.method, route: String(req.originalUrl).split('?')[0], ip: req.ip });
    res.status(401).json({ error: 'invalid token' });
  }
}

module.exports = { sign, verify, verifySession, logNonSessionToken, requireAuth };
