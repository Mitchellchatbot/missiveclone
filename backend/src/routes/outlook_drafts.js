const express = require('express');
const { cl2Auth } = require('../auth');
const { isCl2Ready } = require('../db');
const { sendApiError, cl2BodyErrors } = require('../util/api_errors');
const { CL2_ROUTE_KEYS } = require('../util/allow_list');
const { sendFlagSummary } = require('../util/scope');
const { withIdempotency } = require('../util/idempotency');
const drafts = require('../email/outlook_drafts');

// The six CL2 routes: Outlook drafts (create a reply or a new message, read one
// back, recreate it, discard it) and send-by-id. Mounted at /api by index.js,
// before the legacy routers, so these paths are matched here and never reach the
// threads or compose router.
//
// Every route runs, in this order:
//   1. cl2Auth(scope): only an account-scoped token admitted for this route with
//      this scope gets past it (401 invalid_token / 403 forbidden_scope);
//   2. its own JSON parser (index.js keeps the app-wide one off these paths), so
//      a body is read only once the caller is admitted;
//   3. validation that does not depend on the draft's kind (400 bad_request,
//      `detail` naming the field);
//   4. readiness of the CL2 schema (503 not_ready);
//   5. the send route only: sending switched off for every account (403);
//   6. the Idempotency-Key claim, on the mutating routes;
//   7. the handler in email/outlook_drafts.js.
// Errors follow one shape ({ error, detail?, draftStatus?, graphStatus?,
// graphCode? }, util/api_errors.js) and every failure is answered here: nothing
// is passed on to the app error handler, which would log the error object and
// answer with its message.
const router = express.Router();

// The route keys from util/allow_list.js: what the gate admitted (req.auth
// .routeKey) and the `route` of the idempotency records.
const KEYS = {
  createReply: 'POST /api/threads/:id/outlook-draft',
  createNew: 'POST /api/compose/outlook-draft',
  get: 'GET /api/outlook-drafts/:graphId',
  recreate: 'PATCH /api/outlook-drafts/:graphId',
  remove: 'DELETE /api/outlook-drafts/:graphId',
  send: 'POST /api/outlook-drafts/:graphId/send'
};
for (const k of Object.values(KEYS)) {
  if (!CL2_ROUTE_KEYS.includes(k)) throw new Error(`routes/outlook_drafts: ${k} is not a CL2 route in util/allow_list.js`);
}

// Same limit as the app-wide parser. bodyHtml has its own, lower limit (checked
// below), so an oversized body is the only thing this one refuses.
const jsonBody = express.json({ limit: '5mb' });

// ---------------------------------------------------------------- validation
const THREAD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
// Graph ids, compared exactly as given: they are case-sensitive.
const GRAPH_ID_RE = /^[A-Za-z0-9_=-]{1,512}$/;
const IDEM_KEY_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const ROW_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
// bodyHtml is spliced into Outlook's own reply body (or wrapped for a new
// draft), so it must be a fragment, not a document.
const DOCUMENT_TAG_RE = /<\s*\/?\s*(html|head|body)\b/i;
const MAX_BODY_HTML = 1000000;
const MAX_SUBJECT = 998;
const MAX_RECIPIENTS = 50;

// Recipients are structured ({ address, name? }), never one joined string: a
// display name may contain the very commas and semicolons a joined list is
// split on.
function checkRecipient(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return ': must be an object { address, name? }';
  for (const k of Object.keys(r)) if (k !== 'address' && k !== 'name') return `.${k}: unknown field`;
  const a = r.address;
  if (typeof a !== 'string' || a.length < 1 || a.length > 254) return '.address: must be a string of 1 to 254 characters';
  if (/\s/.test(a) || /\p{Cc}/u.test(a)) return '.address: must not contain whitespace or control characters';
  if (/[<>,;"]/.test(a)) return '.address: must not contain < > , ; or "';
  const at = a.indexOf('@');
  if (at < 1 || at !== a.lastIndexOf('@')) return '.address: must contain exactly one @ after a local part';
  const domain = a.slice(at + 1);
  if (domain.indexOf('.') < 1 || domain.endsWith('.')) return '.address: must have a domain with a dot after the @';
  if (r.name !== undefined) {
    if (typeof r.name !== 'string' || r.name.length > 256) return '.name: must be a string of at most 256 characters';
    if (/\p{Cc}/u.test(r.name)) return '.name: must not contain control characters';
  }
  return null;
}

function recipients(min) {
  return (v, field) => {
    if (!Array.isArray(v)) return `${field}: must be an array of { address, name? }`;
    if (v.length < min || v.length > MAX_RECIPIENTS) return `${field}: must hold ${min} to ${MAX_RECIPIENTS} recipients`;
    for (let i = 0; i < v.length; i++) {
      const bad = checkRecipient(v[i]);
      if (bad) return `${field}[${i}]${bad}`;
    }
    return null;
  };
}

const matches = (re, rule) => (v, field) => (typeof v === 'string' && re.test(v) ? null : `${field}: must match ${rule}`);

// One validator per body field. Each returns null or "<field>: <rule broken>".
const FIELDS = {
  parentMessageId: matches(ROW_ID_RE, '^[A-Za-z0-9_-]{1,64}$'),
  accountId: matches(ROW_ID_RE, '^[A-Za-z0-9_-]{1,64}$'),
  to: recipients(1),
  cc: recipients(0),
  bcc: recipients(0),
  subject: (v, field) => (typeof v === 'string' && v.length >= 1 && v.length <= MAX_SUBJECT && !/[\r\n]/.test(v)
    ? null : `${field}: must be a string of 1 to ${MAX_SUBJECT} characters without line breaks`),
  bodyHtml: (v, field) => {
    if (typeof v !== 'string' || v.length < 1 || v.length > MAX_BODY_HTML) return `${field}: must be a string of 1 to 1,000,000 characters`;
    if (DOCUMENT_TAG_RE.test(v)) return `${field}: must be an HTML fragment, without <html>, <head> or <body> tags`;
    return null;
  },
  // Any IANA name is accepted; one the timezone table doesn't know means UTC.
  timezone: (v, field) => (typeof v === 'string' && v.length <= 64 ? null : `${field}: must be a string of at most 64 characters`),
  ifContentHash: matches(HASH_RE, '^[0-9a-f]{64}$'),
  confirmHash: matches(HASH_RE, '^[0-9a-f]{64}$'),
  idempotencyKey: matches(IDEM_KEY_RE, '^[A-Za-z0-9_.:-]{1,128}$')
};

// The body each route accepts. Any other key is refused, snake_case spellings
// included, so a misspelt field can't be silently ignored. Rules that depend on
// the draft's kind (a PATCH of a reply draft can't change its subject or bcc)
// are the handler's, after the idempotency claim.
const BODIES = {
  createReply: { required: ['parentMessageId', 'to', 'bodyHtml'], optional: ['cc', 'timezone'] },
  createNew: { required: ['accountId', 'to', 'subject', 'bodyHtml'], optional: ['cc', 'bcc', 'timezone'] },
  recreate: { required: ['to', 'bodyHtml'], optional: ['cc', 'bcc', 'subject', 'timezone', 'ifContentHash'] },
  remove: { required: [], optional: ['ifContentHash'], bodyOptional: true },
  send: { required: ['confirmHash', 'idempotencyKey'], optional: [] }
};

function checkBody(req, spec) {
  // req.is() is null for a request without a body, false for a body of another type.
  const isJson = req.is('application/json');
  if (!isJson) {
    if (spec.bodyOptional && isJson === null) return null;
    return 'body: must be a JSON object (Content-Type: application/json)';
  }
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'body: must be a JSON object';
  const allowed = new Set([...spec.required, ...spec.optional]);
  for (const k of Object.keys(body)) if (!allowed.has(k)) return `${k}: unknown field`;
  for (const k of spec.required) if (body[k] === undefined) return `${k}: required`;
  for (const k of [...spec.required, ...spec.optional]) {
    if (body[k] === undefined) continue;
    const bad = FIELDS[k](body[k], k);
    if (bad) return bad;
  }
  return null;
}

function checkIdempotencyHeader(req) {
  const key = req.get('Idempotency-Key');
  if (key === undefined) return 'Idempotency-Key: header required';
  return IDEM_KEY_RE.test(key) ? null : 'Idempotency-Key: must match ^[A-Za-z0-9_.:-]{1,128}$';
}

// ------------------------------------------------------------------ handling
// For the logs: an error's code or class name, never its message.
function errLabel(e) {
  const s = String((e && (e.code || e.name)) || 'error');
  return /^[A-Za-z0-9_.:-]{1,60}$/.test(s) ? s : 'error';
}

function respond(res, out, op) {
  if (!out || !Number.isInteger(out.status)) {
    console.error(`[outlook-drafts] unexpected ${op} bad_result`);
    return sendApiError(res, 500, 'server_error');
  }
  if (out.retryAfterSec != null) res.set('Retry-After', String(out.retryAfterSec));
  if (out.headers) for (const [k, v] of Object.entries(out.headers)) res.set(k, String(v));
  return res.status(out.status).json(out.body === undefined ? null : out.body);
}

// Steps 3 to 7 above for one route. `param` names the path parameter and its
// pattern; `body` is a BODIES entry (null: the route reads no body).
function cl2Route({ key, op, param, body = null, mutating = false, isSend = false }) {
  return async function cl2Handler(req, res) {
    try {
      const bad = (param && !param.re.test(req.params[param.name]) ? `${param.name}: must match ${param.rule}` : null)
        || (mutating ? checkIdempotencyHeader(req) : null)
        || (body ? checkBody(req, body) : null)
        || (isSend && req.body.idempotencyKey !== req.get('Idempotency-Key')
          ? 'idempotencyKey: must equal the Idempotency-Key header' : null);
      if (bad) return sendApiError(res, 400, 'bad_request', { detail: bad });
      if (!isCl2Ready()) return sendApiError(res, 503, 'not_ready');
      // Off for every account: refused before anything is claimed or read. A
      // list that leaves out this draft's account is the handler's check, once
      // it has read the draft.
      if (isSend && sendFlagSummary() === 'off') return sendApiError(res, 403, 'forbidden_scope', { detail: 'send_disabled' });
      const input = { req, params: req.params, body: body && req.body && typeof req.body === 'object' ? req.body : {} };
      const run = () => drafts[op](input);
      // A graphId route's answer to a key still in progress names the draft's
      // registry status, like every other error those routes give.
      const describe = param === GRAPH_ID ? () => drafts.draftStatusOf(input) : undefined;
      const out = mutating ? await withIdempotency(req, res, { route: key, isSend, describe }, run) : await run();
      return respond(res, out, op);
    } catch (e) {
      console.error(`[outlook-drafts] unexpected ${op} ${errLabel(e)}`);
      if (!res.headersSent) return sendApiError(res, 500, 'server_error');
      return undefined;
    }
  };
}

const THREAD_ID = { name: 'id', re: THREAD_ID_RE, rule: '^[A-Za-z0-9_-]{1,64}$' };
const GRAPH_ID = { name: 'graphId', re: GRAPH_ID_RE, rule: '^[A-Za-z0-9_=-]{1,512}$' };

router.post('/threads/:id/outlook-draft', cl2Auth('draft'), jsonBody,
  cl2Route({ key: KEYS.createReply, op: 'createReplyDraft', param: THREAD_ID, body: BODIES.createReply, mutating: true }));

router.post('/compose/outlook-draft', cl2Auth('draft'), jsonBody,
  cl2Route({ key: KEYS.createNew, op: 'createNewDraft', body: BODIES.createNew, mutating: true }));

router.get('/outlook-drafts/:graphId', cl2Auth('draft'),
  cl2Route({ key: KEYS.get, op: 'getDraft', param: GRAPH_ID }));

router.patch('/outlook-drafts/:graphId', cl2Auth('draft'), jsonBody,
  cl2Route({ key: KEYS.recreate, op: 'recreateDraft', param: GRAPH_ID, body: BODIES.recreate, mutating: true }));

router.delete('/outlook-drafts/:graphId', cl2Auth('draft'), jsonBody,
  cl2Route({ key: KEYS.remove, op: 'deleteDraft', param: GRAPH_ID, body: BODIES.remove, mutating: true }));

router.post('/outlook-drafts/:graphId/send', cl2Auth('send'), jsonBody,
  cl2Route({ key: KEYS.send, op: 'sendDraft', param: GRAPH_ID, body: BODIES.send, mutating: true, isSend: true }));

// A body the parser above could not read (malformed JSON, over 5 MB, a charset
// it can't decode) is a 400 with a fixed detail, logged by its error type only
// (cl2BodyErrors). Anything else that gets here is a 500 without its message.
router.use((err, req, res, _next) => cl2BodyErrors(err, req, res, (other) => {
  console.error(`[outlook-drafts] unexpected route ${errLabel(other)}`);
  if (!res.headersSent) sendApiError(res, 500, 'server_error');
}));

module.exports = router;
