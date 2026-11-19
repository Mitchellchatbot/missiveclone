const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { sendApiError } = require('./util/api_errors');
const { matchAllowList, routerPath, targetIsPlain, normalizePath } = require('./util/allow_list');

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
// `kind` or `scope` claim. Other JWTs signed with JWT_SECRET (such as the
// OAuth state) are not sessions and must never authenticate a request. A
// `scope` claim marks a narrower service token, which only code that enforces
// that scope may accept; this check refuses it so such a token can never act
// as a full session. Both claims are rejected when present at all, so
// kind: null or scope: '' can't slip past a truthiness test.
// Returns null for a session payload, otherwise the rule it breaks.
function notSessionReason(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return 'not-object';
  if (Object.prototype.hasOwnProperty.call(payload, 'kind')) return 'kind';
  if (Object.prototype.hasOwnProperty.call(payload, 'scope')) return 'scope';
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
  return sessionPayload(verify(token));
}

// The session-shape check of verifySession, on a payload verify() already
// accepted, so requireAuth can check the token's class before its shape
// without verifying it twice. A payload with a `scope` claim is an
// account-scoped token: its error also says so (scoped) and carries the jti,
// which is how sockets.js logs the refusal as a scoped denial.
function sessionPayload(payload) {
  const reason = notSessionReason(payload);
  if (reason) {
    const e = new jwt.JsonWebTokenError('not a session token');
    e.code = 'NOT_SESSION_TOKEN';
    e.reason = reason;
    if (reason === 'kind' && typeof payload.kind === 'string') e.kind = payload.kind.slice(0, 40);
    if (isScopedPayload(payload)) {
      e.scoped = true;
      e.jti = typeof payload.jti === 'string' ? payload.jti.slice(0, 64) : undefined;
    }
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

// Order: verify the token (a bad signature or an expired token is the usual
// 401, not logged); then a token with a `scope` claim is admitted only where the
// gate admitted it (admitGatedScoped, below), never through the session check;
// every other token gets the session check, exactly as before. Synchronous, no
// database work.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'missing token' });
  let payload;
  try {
    payload = verify(token);
  } catch {
    return res.status(401).json({ error: 'invalid token' });
  }
  if (isScopedPayload(payload)) return admitGatedScoped(req, res, next, token, payload);
  try {
    req.user = sessionPayload(payload);
  } catch (e) {
    // The path as requested, without the query string, which stays out of the log.
    logNonSessionToken(e, token, { via: 'http', method: req.method, route: String(req.originalUrl).split('?')[0], ip: req.ip });
    return res.status(401).json({ error: 'invalid token' });
  }
  req.auth = { kind: 'legacy' };
  return next();
}

// ---------------------------------------------------------------------------
// Account-scoped API tokens (CL2).
//
// A token whose payload has a `scope` key is a scoped token. It may call only
// the routes util/allow_list.js lists for its scopes, it sees only its
// accounts' mail, and it is checked on every request against its row in
// scoped_tokens (so it can be revoked). Claims:
//   { id, workspace_id, email, scope: [...], accounts: [...], jti, iat, exp }
// The session check above never accepts one (its `scope` rule), so a scoped
// token is admitted only by the checks below, which enforce that scope:
//   scopeGate   in front of every router and body parser: decides, and records
//               what it admitted in req.auth;
//   requireAuth (the legacy routes) and cl2Auth (the CL2 routes): admit a scoped
//               token only where the gate admitted it and only when they work
//               out the same route from the same path, so a gate and a router
//               that ever read a path differently refuse rather than admit.
// Tokens without a scope claim never reach any of this.
// ---------------------------------------------------------------------------

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// Scoped means the payload HAS a `scope` key: presence, never truthiness, so
// scope: null, '' or [] is a malformed scoped token and never a session.
const isScopedPayload = (p) => isPlainObject(p) && hasOwn(p, 'scope');
const SCOPES = ['read', 'draft', 'send'];
const SCOPE_SET = new Set(SCOPES);
const ACCOUNT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const JTI_RE = /^[A-Za-z0-9_-]{16,64}$/;
const MAX_ACCOUNTS = 50;

function bearerOf(req) {
  const header = (req.headers && req.headers.authorization) || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

// The first 12 hex characters of sha256(token): how a log line names a token
// without carrying any of it (the same fingerprint CL0's line uses).
function tokenFingerprint(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 12);
}

// An error's code or class name, safe for a log line; never its message, which
// can carry the database's own text.
function errLabel(e) {
  const s = String((e && (e.code || e.name)) || 'error');
  return /^[A-Za-z0-9_.:-]{1,60}$/.test(s) ? s : 'error';
}

// The database module, loaded on first use rather than with this one: the mint
// script loads auth.js for its self-check, and loading db.js builds a pool.
let dbModule = null;
function db() {
  if (!dbModule) dbModule = require('./db');
  return dbModule;
}

// Thrown for a scoped token that is refused. `reason` names what failed: a rule
// of scopedReason (malformed: true), or unknown_jti, revoked, expired,
// registry_mismatch. code BAD_SCOPED_TOKEN answers 401 invalid_token;
// REGISTRY_UNAVAILABLE (the registry can't be read, or the CL2 schema isn't in
// place yet) answers 503 not_ready.
class ScopedTokenError extends Error {
  constructor(reason, code = 'BAD_SCOPED_TOKEN', { malformed = false } = {}) {
    super('scoped token refused');
    this.name = 'ScopedTokenError';
    this.code = code;
    this.reason = reason;
    this.malformed = malformed;
  }

  // The reason its denial line records: malformed_<rule> for a token that is
  // not shaped like one the mint script signs.
  get logReason() {
    return this.malformed ? `malformed_${this.reason}` : this.reason;
  }
}

// An array of `min`..`max` distinct strings, each accepted by `ok`.
function distinctStrings(v, min, max, ok) {
  return Array.isArray(v) && v.length >= min && v.length <= max
    && v.every((x) => typeof x === 'string' && ok(x))
    && new Set(v).size === v.length;
}

// The rule a scoped payload breaks, or null when it is well formed. Checked in
// this order, so a payload breaking several rules always reports the same one:
//   not-object, kind, id, workspace_id (non-empty strings),
//   scope     1..3 distinct values of read, draft, send,
//   accounts  1..50 distinct account ids,
//   jti       16..64 characters of [A-Za-z0-9_-],
//   exp       a number (an expiry is required).
function scopedReason(payload) {
  if (!isPlainObject(payload)) return 'not-object';
  if (hasOwn(payload, 'kind')) return 'kind';
  if (typeof payload.id !== 'string' || payload.id === '') return 'id';
  if (typeof payload.workspace_id !== 'string' || payload.workspace_id === '') return 'workspace_id';
  if (!distinctStrings(payload.scope, 1, SCOPES.length, (s) => SCOPE_SET.has(s))) return 'scope';
  if (!distinctStrings(payload.accounts, 1, MAX_ACCOUNTS, (a) => ACCOUNT_ID_RE.test(a))) return 'accounts';
  if (typeof payload.jti !== 'string' || !JTI_RE.test(payload.jti)) return 'jti';
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) return 'exp';
  return null;
}

// ------------------------------------------------------------------ registry
// jti -> { row (or null for no row), at }. Positive and negative lookups are
// both kept, for at most a minute and 1,000 tokens (the oldest goes first), so
// a revocation takes effect within a minute on every instance while a burst of
// requests costs one lookup. A failed lookup is never kept. clear() bumps the
// generation, so a lookup that was already in flight is not kept either.
const SCOPED_TOKEN_CACHE_MS = 60 * 1000;
const SCOPED_TOKEN_CACHE_MAX = 1000;
const scopedTokenCache = new Map();
let scopedTokenCacheGen = 0;

// The registry being unreadable is logged at most once a minute (the code only:
// a SQLSTATE or an error class).
const REGISTRY_LOG_EVERY_MS = 60 * 1000;
let registryLoggedAt = null;
function noteRegistryUnreadable(e) {
  const now = Date.now();
  if (registryLoggedAt !== null && now - registryLoggedAt >= 0 && now - registryLoggedAt < REGISTRY_LOG_EVERY_MS) return;
  registryLoggedAt = now;
  console.warn(`[authz] scoped-token registry unreadable (${errLabel(e)}); scoped requests answer 503`);
}

async function scopedTokenRow(jti) {
  const now = Date.now();
  const hit = scopedTokenCache.get(jti);
  if (hit) {
    const age = now - hit.at;
    if (age >= 0 && age < SCOPED_TOKEN_CACHE_MS) return hit.row;
    scopedTokenCache.delete(jti);
  }
  const gen = scopedTokenCacheGen;
  let row;
  try {
    row = await db().one(
      `SELECT jti, user_id, workspace_id, scopes, accounts, expires_at, revoked_at
         FROM scoped_tokens WHERE jti = $1`,
      [jti]
    );
  } catch (e) {
    // Includes 42P01 (no such table) on a database CL2's schema hasn't reached.
    noteRegistryUnreadable(e);
    throw new ScopedTokenError('registry_unavailable', 'REGISTRY_UNAVAILABLE');
  }
  if (gen === scopedTokenCacheGen) {
    if (scopedTokenCache.size >= SCOPED_TOKEN_CACHE_MAX) scopedTokenCache.delete(scopedTokenCache.keys().next().value);
    scopedTokenCache.set(jti, { row, at: now });
  }
  return row;
}

function clearScopedTokenCache() {
  scopedTokenCacheGen += 1;
  scopedTokenCache.clear();
}

// Same members, in any order. Registry rows store their arrays sorted, but a
// row written by hand might not be.
function sameMembers(rowList, sortedClaim) {
  if (!Array.isArray(rowList) || rowList.length !== sortedClaim.length) return false;
  const sorted = [...rowList].map(String).sort();
  return sorted.every((x, i) => x === sortedClaim[i]);
}

// The checks for a verified payload that has a `scope` key: its shape, then its
// registry row. Resolves the request's auth; throws ScopedTokenError.
async function scopedAuth(payload) {
  const rule = scopedReason(payload);
  if (rule) throw new ScopedTokenError(rule, 'BAD_SCOPED_TOKEN', { malformed: true });
  // Until the CL2 schema is in place a scoped token is answered 503, never
  // admitted on a half-made registry (C18).
  if (!db().isCl2Ready()) throw new ScopedTokenError('not_ready', 'REGISTRY_UNAVAILABLE');
  const row = await scopedTokenRow(payload.jti);
  if (!row) throw new ScopedTokenError('unknown_jti');
  if (row.revoked_at !== null && row.revoked_at !== undefined) throw new ScopedTokenError('revoked');
  const rowExpiresAt = Number(row.expires_at);
  if (!(rowExpiresAt > Date.now())) throw new ScopedTokenError('expired');
  const scopes = [...payload.scope].sort();
  const accounts = [...payload.accounts].sort();
  // The claims must say exactly what the registry recorded at mint time; any
  // difference refuses the token rather than trusting either side.
  if (row.user_id !== payload.id || row.workspace_id !== payload.workspace_id
      || !sameMembers(row.scopes, scopes) || !sameMembers(row.accounts, accounts)) {
    throw new ScopedTokenError('registry_mismatch');
  }
  return {
    kind: 'scoped',
    jti: payload.jti,
    scopes,
    accounts,
    userId: payload.id,
    workspaceId: payload.workspace_id,
    exp: payload.exp,
    // When the token stops working: the earlier of its own expiry and its
    // registry row's (epoch ms).
    expiresAt: Math.min(payload.exp * 1000, rowExpiresAt)
  };
}

// verify() plus the check for the token's class. Resolves { payload, auth }:
//   no `scope` key -> the session check (throws NOT_SESSION_TOKEN like
//                     verifySession); auth = { kind: 'legacy' }
//   a `scope` key  -> scopedReason, then the registry (throws ScopedTokenError);
//                     auth = { kind: 'scoped', jti, scopes, accounts, userId,
//                     workspaceId, exp, expiresAt }, scopes and accounts sorted
// A bad signature or an expired token throws verify()'s own error.
async function verifyRequestToken(token) {
  const payload = verify(token);
  if (!isScopedPayload(payload)) return { payload: sessionPayload(payload), auth: { kind: 'legacy' } };
  return { payload, auth: await scopedAuth(payload) };
}

// ------------------------------------------------------------------- logging
// One line per refused request of a scoped token (and per session token on a
// CL2 route), at most once a minute per (jti or fingerprint, reason, route):
//   [authz] denied {"status":403,"reason":"...","route":"...","jti":"...","fp":"...","via":"http","ip":"..."}
// `route` is the allow-list key when one matched, otherwise METHOD /api/<first
// segment>/...: never the full path, which can hold an invite token or ids, and
// never the query. Never the token or any claim value but jti; fp is a sha256
// prefix of the token. Printable ASCII only, values at most 200 characters.
// Reasons: malformed_<rule>, unknown_jti, revoked, expired, registry_mismatch,
// route_not_allowed, scope_missing, legacy_token, not_gated, socket_scoped.
const AUTHZ_LOG_EVERY_MS = 60 * 1000;
const AUTHZ_LOG_MAX_KEYS = 1000;
const authzLoggedAt = new Map(); // `${jti || fp}|${reason}|${route}` -> when it was last logged

// METHOD /api/<first segment>[/...] from a router path. The first segment is a
// router's name (threads, invites, ...); anything else in its place is shown as ?.
function denialRoute(method, path) {
  const m = /^[A-Z]{1,12}$/.test(String(method || '')) ? method : '?';
  const segs = normalizePath(path).split('/').filter(Boolean);
  if (segs[0] !== 'api') return `${m} ?`;
  if (segs.length === 1) return `${m} /api`;
  const first = /^[a-z0-9_.-]{1,40}$/.test(segs[1]) ? segs[1] : '?';
  return `${m} /api/${first}${segs.length > 2 ? '/...' : ''}`;
}

function logAuthzDenial({ status, reason, routeKey, method, path, jti, fp, via, ip } = {}) {
  try {
    let route;
    if (routeKey) route = String(routeKey);
    else if (method !== undefined || path !== undefined) route = denialRoute(method, path);
    const id = typeof jti === 'string' && jti ? jti.slice(0, 64) : undefined;
    const key = `${id || fp || '-'}|${reason}|${route || ''}`;
    const now = Date.now();
    const last = authzLoggedAt.get(key);
    if (last !== undefined && now - last >= 0 && now - last < AUTHZ_LOG_EVERY_MS) return;
    if (authzLoggedAt.size >= AUTHZ_LOG_MAX_KEYS) {
      for (const [k, at] of authzLoggedAt) if (now - at >= AUTHZ_LOG_EVERY_MS) authzLoggedAt.delete(k);
      if (authzLoggedAt.size >= AUTHZ_LOG_MAX_KEYS) authzLoggedAt.clear();
    }
    authzLoggedAt.set(key, now);
    const fields = { status, reason, route, jti: id, fp, via, ip };
    console.warn('[authz] denied', JSON.stringify(fields,
      (_k, v) => (typeof v === 'string' ? v.slice(0, 200).replace(/[^\x20-\x7e]/g, '?') : v)));
  } catch { /* logging must never change the response */ }
}

// --------------------------------------------------------------------- gate
// The one check for account-scoped tokens, mounted at /api by index.js ahead of
// every router and body parser, /api/health and /api/status included. A request
// with no bearer, a bearer that does not verify, or a token without a `scope`
// claim passes through untouched: the route's own check decides, exactly as
// before (and logs as before). For a scoped token the gate decides, in order:
//   1. the request target must be a plain path equal to the path Express routes
//      on (targetIsPlain), else 403: a target a parser could read two ways is
//      refused, never interpreted;
//   2. the token must be well formed and match its registry row, else 401
//      invalid_token (503 not_ready while the registry can't be read);
//   3. its method and router path must be on the allow-list, else 403;
//   4. it must carry the scope that row needs, else 403.
// Admitted: req.auth = { kind: 'scoped', jti, scopes, accounts, userId,
// workspaceId, exp, expiresAt, routeKey } and on to the routers, where
// requireAuth or cl2Auth checks the verdict again. A refused request is answered
// here, before its body is read. Never throws.
async function scopeGate(req, res, next) {
  const token = bearerOf(req);
  if (!token) return next();
  let payload;
  try {
    payload = verify(token);
  } catch {
    return next();
  }
  if (!isScopedPayload(payload)) return next();
  try {
    return await gateScoped(req, res, next, token, payload);
  } catch (e) {
    // A fault in this code, not a verdict: refuse rather than pass the token on.
    console.error(`[authz] unexpected gate error ${errLabel(e)}`);
    if (!res.headersSent) return sendApiError(res, 500, 'server_error');
    return undefined;
  }
}

async function gateScoped(req, res, next, token, payload) {
  const path = routerPath(req);
  const claimJti = typeof payload.jti === 'string' ? payload.jti : undefined;
  const deny = (status, reason, routeKey, jti) => logAuthzDenial({
    status, reason, routeKey, method: req.method, path, jti, fp: tokenFingerprint(token), via: 'http', ip: req.ip
  });

  if (!targetIsPlain(req)) {
    deny(403, 'route_not_allowed', null, claimJti);
    return sendApiError(res, 403, 'forbidden_scope', { detail: 'route_not_allowed' });
  }
  const r = matchAllowList(req.method, path);
  let auth;
  try {
    auth = await scopedAuth(payload);
  } catch (e) {
    if (!(e instanceof ScopedTokenError)) throw e;
    if (e.code === 'REGISTRY_UNAVAILABLE') return sendApiError(res, 503, 'not_ready');
    deny(401, e.logReason, r && r.key, claimJti);
    return sendApiError(res, 401, 'invalid_token');
  }
  if (!r) {
    deny(403, 'route_not_allowed', null, auth.jti);
    return sendApiError(res, 403, 'forbidden_scope', { detail: 'route_not_allowed' });
  }
  if (!auth.scopes.includes(r.scope)) {
    deny(403, 'scope_missing', r.key, auth.jti);
    return sendApiError(res, 403, 'forbidden_scope', { detail: 'scope_missing' });
  }
  req.auth = { ...auth, routeKey: r.key };
  return next();
}

// requireAuth's branch for a token with a `scope` claim. Admitted only when the
// gate admitted this same token (req.auth, same jti) AND this route, worked out
// again here from the path Express routed on, is the one the gate admitted it
// to. Anything else (a router mounted where the gate doesn't run, a gate and a
// router reading a path differently) is refused: 403, never the session check.
function admitGatedScoped(req, res, next, token, payload) {
  const gated = req.auth && req.auth.kind === 'scoped' ? req.auth : null;
  const path = routerPath(req);
  const r = matchAllowList(req.method, path);
  if (gated && gated.jti === payload.jti && r && r.key === gated.routeKey) {
    req.user = payload;
    return next();
  }
  logAuthzDenial({ status: 403, reason: 'not_gated', routeKey: r && r.key, method: req.method, path,
    jti: payload.jti, fp: tokenFingerprint(token), via: 'http', ip: req.ip });
  return sendApiError(res, 403, 'forbidden_scope');
}

// Per-route auth of the CL2 router (per route, never router.use: the router is
// mounted at /api, so a router-wide check would run for every API request).
//   no bearer, or a token that does not verify  -> 401 invalid_token
//   no `scope` key and not session-shaped       -> 401 invalid_token, logged as everywhere
//   no `scope` key, a session token             -> 403 forbidden_scope: these routes are for scoped tokens only
//   scoped, but not admitted by the gate to this
//   route (worked out again from the path)      -> 403 forbidden_scope
//   scoped, without the route's scope           -> 403 forbidden_scope
//   otherwise                                   -> req.user = the payload; next()
function cl2Auth(scope) {
  if (!SCOPES.includes(scope)) throw new Error(`cl2Auth: unknown scope ${scope}`);
  return function cl2AuthCheck(req, res, next) {
    const token = bearerOf(req);
    if (!token) return sendApiError(res, 401, 'invalid_token');
    let payload;
    try {
      payload = verify(token);
    } catch {
      return sendApiError(res, 401, 'invalid_token');
    }
    const path = routerPath(req);
    const r = matchAllowList(req.method, path);
    const where = { routeKey: r && r.key, method: req.method, path, fp: tokenFingerprint(token), via: 'http', ip: req.ip };
    if (!isScopedPayload(payload)) {
      try {
        sessionPayload(payload);
      } catch (e) {
        logNonSessionToken(e, token, { via: 'http', method: req.method, route: String(req.originalUrl).split('?')[0], ip: req.ip });
        return sendApiError(res, 401, 'invalid_token');
      }
      logAuthzDenial({ status: 403, reason: 'legacy_token', ...where });
      return sendApiError(res, 403, 'forbidden_scope');
    }
    const gated = req.auth && req.auth.kind === 'scoped' && req.auth.jti === payload.jti ? req.auth : null;
    if (!gated || !r || r.key !== gated.routeKey) {
      logAuthzDenial({ status: 403, reason: 'not_gated', jti: payload.jti, ...where });
      return sendApiError(res, 403, 'forbidden_scope');
    }
    if (!Array.isArray(gated.scopes) || !gated.scopes.includes(scope)) {
      logAuthzDenial({ status: 403, reason: 'scope_missing', jti: payload.jti, ...where });
      return sendApiError(res, 403, 'forbidden_scope');
    }
    req.user = payload;
    return next();
  };
}

module.exports = {
  sign, verify, verifySession, logNonSessionToken, requireAuth,
  verifyRequestToken, scopedReason, scopeGate, cl2Auth, logAuthzDenial, ScopedTokenError,
  tokenFingerprint,
  // Test hook, like db.js's exports for verification: drop every cached
  // registry lookup so the next request reads the registry again.
  __test: { clearScopedTokenCache }
};
