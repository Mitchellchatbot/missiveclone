// What an account-scoped API token may call, and the path helpers every check
// that consults it shares: the gate in front of every router (auth.js
// scopeGate), requireAuth's and cl2Auth's re-check of the gate's verdict, and
// index.js's body parsing for the CL2 paths. One table and one matcher, so no
// two of those can disagree on what a path matches.
//
// A request whose method and path match no row is refused (403) for a scoped
// token. Tokens without a scope claim never consult this table.

// Every row: the route key (also what the denial log and the idempotency rows
// record), the method compared exactly, a pattern over normalizePath(routerPath),
// the scope it needs, and whether its handler is the CL2 router
// (routes/outlook_drafts.js) rather than a legacy one.
function row(key, method, re, scope, cl2 = false) {
  return Object.freeze({ key, method, re, scope, cl2 });
}

const ALLOW_LIST = Object.freeze([
  // read: the mail the token's accounts can see. The handlers filter to those
  // accounts (a thread or message of another account answers 404).
  row('GET /api/accounts', 'GET', /^\/api\/accounts$/, 'read'),
  row('GET /api/threads', 'GET', /^\/api\/threads$/, 'read'),
  row('GET /api/threads/:id', 'GET', /^\/api\/threads\/[^/]+$/, 'read'),
  row('GET /api/messages', 'GET', /^\/api\/messages$/, 'read'),
  row('GET /api/messages/:id/body', 'GET', /^\/api\/messages\/[^/]+\/body$/, 'read'),
  row('GET /api/attachments/:id', 'GET', /^\/api\/attachments\/[^/]+$/, 'read'),
  row('GET /api/auth/me', 'GET', /^\/api\/auth\/me$/, 'read'),
  // draft: create, read back, recreate and discard Outlook drafts.
  row('POST /api/threads/:id/outlook-draft', 'POST', /^\/api\/threads\/[^/]+\/outlook-draft$/, 'draft', true),
  row('POST /api/compose/outlook-draft', 'POST', /^\/api\/compose\/outlook-draft$/, 'draft', true),
  row('GET /api/outlook-drafts/:graphId', 'GET', /^\/api\/outlook-drafts\/[^/]+$/, 'draft', true),
  row('PATCH /api/outlook-drafts/:graphId', 'PATCH', /^\/api\/outlook-drafts\/[^/]+$/, 'draft', true),
  row('DELETE /api/outlook-drafts/:graphId', 'DELETE', /^\/api\/outlook-drafts\/[^/]+$/, 'draft', true),
  // send: send a saved draft by its id, and nothing else.
  row('POST /api/outlook-drafts/:graphId/send', 'POST', /^\/api\/outlook-drafts\/[^/]+\/send$/, 'send', true),
]);

const CL2_ROWS = ALLOW_LIST.filter((r) => r.cl2);
// The keys of the six CL2 routes, in table order.
const CL2_ROUTE_KEYS = Object.freeze(CL2_ROWS.map((r) => r.key));
const CL2_KEY_SET = new Set(CL2_ROUTE_KEYS);

// The pathname Express itself routes on (parseurl's pathname), whatever the
// middleware is mounted at: req.baseUrl holds the mount path as matched, req.path
// the rest. Matching on this instead of req.originalUrl means a match names the
// handler Express will run, even for a request target that Express and a plain
// string split read differently (url.parse drops a '#' fragment, for one).
function routerPath(req) {
  return String(req.baseUrl || '') + String(req.path || '');
}

// Express routing is case-insensitive and non-strict, so /API/Accounts/ runs the
// same handler as /api/accounts: compare the way it does. Only the table's
// patterns see the lower-cased path; handlers read req.params, which keep the
// original case (Graph ids are case-sensitive).
function normalizePath(p) {
  let s = String(p || '');
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s.toLowerCase();
}

// { key, scope } of the row this method + router path match, or null. HEAD and
// OPTIONS match no row: Express would run a GET handler for a HEAD, and CORS
// preflight is answered by cors() before any of this runs.
function matchAllowList(method, routerPathValue) {
  const p = normalizePath(routerPathValue);
  for (const r of ALLOW_LIST) {
    if (r.method === method && r.re.test(p)) return { key: r.key, scope: r.scope };
  }
  return null;
}

// True only when the request target as sent (req.originalUrl up to the first
// '?') is a plain path that equals the path Express routes on. Anything that
// could read differently to a parser is refused for scoped tokens rather than
// interpreted: a '#' fragment, a backslash, percent-encoding, whitespace, a
// control or non-ASCII byte, an empty segment ('//'), or absolute-URI form
// ('http://host/...'). Legacy tokens never go through this check.
function targetIsPlain(req) {
  const raw = String(req.originalUrl || '').split('?')[0];
  if (/[#\\%]|\s|[^\x20-\x7e]|\/\//.test(raw)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return false;
  return raw === routerPath(req);
}

// True when `value` names one of the six CL2 routes: either its route key
// ('POST /api/outlook-drafts/:graphId/send') or a router path that one of their
// patterns matches, whatever the method. index.js uses the path form to keep the
// app-wide JSON parser off these paths: the CL2 router parses its own bodies, so
// a malformed or oversized one is answered by CL2 code and never reaches the app
// error handler. No legacy route's path matches a CL2 pattern.
function isCl2RouteKey(value) {
  const s = String(value || '');
  if (CL2_KEY_SET.has(s)) return true;
  if (!s.startsWith('/')) return false;
  const p = normalizePath(s);
  return CL2_ROWS.some((r) => r.re.test(p));
}

module.exports = {
  ALLOW_LIST, CL2_ROUTE_KEYS,
  routerPath, normalizePath, matchAllowList, targetIsPlain, isCl2RouteKey
};
