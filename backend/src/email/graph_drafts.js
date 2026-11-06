// Microsoft Graph client for Outlook drafts and send-by-id: create (reply and
// new), patch, read back, delete and send a draft, and the content hashes a send
// is checked against. Graph I/O only: no database access. The registry and the
// state machine that use it live in email/outlook_drafts.js, and the legacy send
// stack in graph.js is not touched (it is shared by the clone UI, invites, the
// scheduled dispatcher and every API caller, and keeps its own behaviour).
//
// Rules every request here follows:
//   - exactly one Prefer header, always carrying IdType="ImmutableId", so every
//     id we store or return keeps resolving after Outlook moves the item (a sent
//     draft moves to Sent Items under the same immutable id);
//   - path ids are encodeURIComponent'ed and compared case-sensitively;
//   - a 30 s timeout per call; a short Retry-After on a throttled call gets one
//     retry, never on /send, and never a 503 on a create (the draft may exist);
//   - errors keep Graph's HTTP status, error code and Retry-After, and never
//     Graph's message text (it can echo request content), so nothing here can
//     put mail content into a response or a log line.

const crypto = require('crypto');
const ms = require('../oauth/microsoft');
const db = require('../db');

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const GRAPH_ORIGIN = 'https://graph.microsoft.com';
// Every request carries exactly one Prefer header. Ids are always immutable ids,
// so a draft keeps its id when it moves to Sent Items.
const PREFER_IMM = 'IdType="ImmutableId"';
// Read-backs: immutable ids and the body as HTML, so a plain-text parent's draft
// reads back the same way it is hashed.
const PREFER_RB = 'IdType="ImmutableId", outlook.body-content-type="html"';
const READBACK_SELECT = 'id,changeKey,isDraft,webLink,internetMessageId,conversationId,subject,' +
  'from,sender,replyTo,toRecipients,ccRecipients,bccRecipients,body,parentFolderId,' +
  'lastModifiedDateTime,sentDateTime';
// Never contentId: it lives on the derived fileAttachment type only, and Graph
// refuses the whole listing when it is in a $select over the base type.
const ATTACHMENT_SELECT = 'id,name,size,isInline,contentType';
const ATTACHMENT_PAGE = 50;
const MAX_ATTACHMENT_PAGES = 5;

// The same scope strings the legacy client uses (graph.js). Asking for less does
// not give a narrower token (Graph returns every consented scope), so the split
// is intent only; what keeps a draft token from sending is that no code path
// here sends except sendDraft, which only the send route calls.
const SCOPE_SEND = 'https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Mail.ReadWrite offline_access';
const SCOPE_DRAFT = 'https://graph.microsoft.com/Mail.ReadWrite offline_access';

// The draft tag: a string extended property holding the registry row id, set on
// every draft at create time. A create whose response was lost (timeout, reset,
// 5xx) may still have made a draft we have no id for; the sweep finds it by this
// tag and removes it. The GUID is fixed for good: changing it would orphan every
// tagged draft already in a mailbox.
const DRAFT_TAG_GUID = '12cd5de8-ad30-4791-8cbd-eb8e3f90d48c';
const DRAFT_TAG_ID = `String {${DRAFT_TAG_GUID}} Name EADraftRowId`;

// A failed Graph call, with what the error mapping needs and nothing else: the
// kind of failure ('http' | 'timeout' | 'network' | 'token'), the HTTP status,
// Graph's error.code and inner code, the parsed Retry-After, and a short label
// of the call. Never the request or response body.
class GraphCallError extends Error {
  constructor(message, { kind = 'http', status = null, graphCode = null, innerCode = null,
    retryAfterMs = null, op = null, body } = {}) {
    super(String(message || 'graph call failed').slice(0, 300));
    this.name = 'GraphCallError';
    this.kind = kind;
    this.status = status;
    this.graphCode = graphCode;
    this.innerCode = innerCode;
    this.retryAfterMs = retryAfterMs;
    this.op = op;
    if (body !== undefined) this.body = body;
  }
}

// Read per call, not at load: the env var is a test override (undocumented) and
// tests change it between requests.
function graphTimeoutMs() {
  return Number(process.env.CL2_GRAPH_TIMEOUT_MS) || 30000;
}

const enc = (id) => encodeURIComponent(String(id));
const sleep = (ms_) => new Promise((resolve) => setTimeout(resolve, ms_));
// Single quotes inside an OData string literal are escaped by doubling.
const odataString = (s) => String(s).replace(/'/g, "''");
// RFC Message-IDs are stored without their angle brackets (messages.message_id).
function stripBrackets(v) {
  if (v == null) return '';
  return String(v).trim().replace(/^<|>$/g, '');
}

// ────────────────────────────────────────────────────────────────────────
// Prefer and the timezone table (D7)
// ────────────────────────────────────────────────────────────────────────

// The client app knows the user's IANA zone; Graph's outlook.timezone wants a
// Windows name (IANA support is unconfirmed). Exact, case-sensitive keys only:
// anything not listed (Etc/UTC included) falls back to UTC, which is also what
// Graph does without the preference, so a wrong guess is never possible.
const TZ = {
  'America/New_York': 'Eastern Standard Time',
  'America/Chicago': 'Central Standard Time',
  'America/Denver': 'Mountain Standard Time',
  'America/Phoenix': 'US Mountain Standard Time',
  'America/Los_Angeles': 'Pacific Standard Time',
  'UTC': 'UTC'
};
function timezoneToWindows(iana) {
  return (typeof iana === 'string' && Object.prototype.hasOwnProperty.call(TZ, iana) && TZ[iana]) || 'UTC';
}
// The create value: immutable ids plus the zone of the quote's "Sent:" line, in
// ONE comma-combined header (fetch would merge two Prefer headers anyway, and a
// single value is what every request here asserts). html: true gives the
// read-back value instead (creates never ask for the body format).
function preferFor({ timezone, html } = {}) {
  if (html) return PREFER_RB;
  return `IdType="ImmutableId", outlook.timezone="${timezoneToWindows(timezone)}"`;
}

// ────────────────────────────────────────────────────────────────────────
// Tokens
// ────────────────────────────────────────────────────────────────────────

// One mint per route call. The refresh-token exchange is raced against the same
// 30 s budget as a Graph call so a stuck login endpoint can't hold a route open;
// a rotated refresh token is persisted by oauth/microsoft.js as for every caller.
async function mintToken(account, { send = false } = {}) {
  const scope = send ? SCOPE_SEND : SCOPE_DRAFT;
  let timer = null;
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new GraphCallError('token mint timed out', { kind: 'timeout', op: 'token' })),
      graphTimeoutMs());
  });
  // Property lookup at call time (not a destructured reference), so a stubbed
  // getter is the one that runs.
  const minting = Promise.resolve().then(() => ms.getAccessTokenForResource(account, scope));
  // A mint that loses the race still settles later; never let that surface as an
  // unhandled rejection.
  minting.catch(() => {});
  try {
    return await Promise.race([minting, timedOut]);
  } catch (e) {
    if (e instanceof GraphCallError) throw e;
    // err.body is the OAuth error body ({error, error_description}); only
    // error is ever read (mapGraphError).
    throw new GraphCallError('token refresh failed', { kind: 'token', op: 'token', body: e && e.body });
  } finally {
    clearTimeout(timer);
  }
}

// ────────────────────────────────────────────────────────────────────────
// graphCall: timeouts, Retry-After, keeping the status and code (D23, D24)
// ────────────────────────────────────────────────────────────────────────

// Retry-After is either delta-seconds or an HTTP-date.
function parseRetryAfter(value, now = Date.now()) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s) * 1000;
  const at = Date.parse(s);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

// A path relative to GRAPH_BASE, or an @odata.nextLink Graph handed back. The
// bearer token is only ever sent to Graph itself: an absolute URL on any other
// origin is refused before the request is made.
function graphUrl(path) {
  const p = String(path || '');
  if (p.startsWith('/')) return GRAPH_BASE + p;
  let u = null;
  try { u = new URL(p); } catch { u = null; }
  if (u && u.origin === GRAPH_ORIGIN && u.pathname.startsWith('/v1.0/')) return u.href;
  const e = new Error('graph_drafts: not a Graph path');
  e.code = 'BAD_GRAPH_PATH';
  throw e;
}

// opts:
//   prefer         the one Prefer value (default IdType only). null sends none:
//                  only the live-test script does that, to see how Graph treats
//                  an immutable id without the header.
//   body           JSON body (sent with Content-Type: application/json)
//   ifMatch        If-Match value, sent verbatim
//   expect         statuses that count as success (default [200])
//   any2xx         any 2xx counts as success (/send: Graph may answer 200 or 202)
//   retryThrottle  one retry after a 429 or a 503 + Retry-After of <= 10 s
//                  (default true; /send passes false: it is never repeated)
//   retry503       whether a 503 is retried at all (default true; the two creates
//                  pass false, because a 503 may have created the draft and a
//                  repeat could make a second one)
//   op             short label for errors
//   timeoutMs      per-call timeout override
async function graphCall(token, method, path, { prefer = PREFER_IMM, body, ifMatch, expect = [200], any2xx = false,
  retryThrottle = true, retry503 = true, op, timeoutMs } = {}) {
  const url = graphUrl(path);
  const label = op || `${method} request`;
  const headers = { Authorization: `Bearer ${token}` };
  if (prefer) headers.Prefer = prefer;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (ifMatch) headers['If-Match'] = ifMatch;
  const payload = body !== undefined ? JSON.stringify(body) : undefined;

  for (let attempt = 1; ; attempt++) {
    const signal = AbortSignal.timeout(timeoutMs != null ? timeoutMs : graphTimeoutMs());
    let res;
    let text = '';
    try {
      res = await fetch(url, { method, headers, body: payload, signal });
      // Reading the body stays under the same signal: a stalled body is a timeout.
      text = await res.text();
    } catch (e) {
      const name = e && e.name;
      if (signal.aborted || name === 'TimeoutError' || name === 'AbortError') {
        throw new GraphCallError(`graph ${label}: timed out`, { kind: 'timeout', op: label });
      }
      // undici's "fetch failed" (TypeError; the cause is in .cause) and any other
      // transport failure: the request may or may not have reached Graph.
      throw new GraphCallError(`graph ${label}: network error`, { kind: 'network', op: label });
    }
    let json = null;
    if (text) { try { json = JSON.parse(text); } catch { json = null; } }
    const status = res.status;
    if (expect.includes(status) || (any2xx && status >= 200 && status < 300)) {
      return { status, json, headers: res.headers };
    }
    const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
    const throttled = status === 429 || (status === 503 && retryAfterMs != null && retry503);
    if (retryThrottle && attempt === 1 && throttled && retryAfterMs != null && retryAfterMs <= 10000) {
      await sleep(retryAfterMs);
      continue;
    }
    const err = (json && json.error) || {};
    const graphCode = typeof err.code === 'string' ? err.code : null;
    const innerCode = (err.innerError && typeof err.innerError.code === 'string') ? err.innerError.code : null;
    throw new GraphCallError(`graph ${label}: HTTP ${status}${graphCode ? ` ${graphCode}` : ''}`,
      { kind: 'http', status, graphCode, innerCode, retryAfterMs, op: label });
  }
}

// ────────────────────────────────────────────────────────────────────────
// mapGraphError → the D23 response
// ────────────────────────────────────────────────────────────────────────

// Returns { status, code, extra }, extra being sendApiError's options
// (graphStatus, graphCode, retryAfterSec). Callers handle 404/403 themselves
// where the route gives them a meaning (gone, parent_missing, not_found).
function mapGraphError(err) {
  if (!(err instanceof GraphCallError)) return { status: 500, code: 'server_error', extra: {} };
  if (err.kind === 'timeout') return { status: 504, code: 'graph_timeout', extra: {} };
  if (err.kind === 'network') return { status: 502, code: 'graph_error', extra: { graphCode: 'network' } };
  if (err.kind === 'token') {
    const oauth = err.body && typeof err.body.error === 'string'
      ? err.body.error.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 60) : '';
    return { status: 502, code: 'graph_error', extra: { graphCode: `token_refresh_failed:${oauth || 'unknown'}` } };
  }
  const retryAfterSec = Math.ceil((err.retryAfterMs || 0) / 1000) || 30;
  if (err.status === 429) return { status: 429, code: 'throttled', extra: { retryAfterSec } };
  // D24: a 503 that names a Retry-After is throttling too; it was not retried
  // (too long, already retried once, or a create), so the caller waits instead.
  if (err.status === 503 && err.retryAfterMs != null) return { status: 429, code: 'throttled', extra: { retryAfterSec } };
  if (err.status === 412 || err.graphCode === 'ErrorIrresolvableConflict') return { status: 409, code: 'changed', extra: {} };
  const extra = {};
  if (err.status != null) extra.graphStatus = err.status;
  const code = err.graphCode || err.innerCode;
  if (code) extra.graphCode = code;
  return { status: 502, code: 'graph_error', extra };
}

// ────────────────────────────────────────────────────────────────────────
// Create flows (D4, D5, D9)
// ────────────────────────────────────────────────────────────────────────

const isGraphError = (e, ...statuses) => e instanceof GraphCallError && e.kind === 'http' && statuses.includes(e.status);

// The parent, resolved in its own mailbox by the RFC Message-ID the clone stored
// (messages.message_id). The stored graph_id is only a hint: it may be a default
// id that went stale when the item was filed, so it is accepted only when Graph
// says it names the same internetMessageId. Returns { id, via } with an immutable
// id, or null for a confirmed 0-match (the route answers 409 parent_missing).
// There is no fallback to a new conversation, ever: that would send the reply as
// an unthreaded new mail. A lookup error is thrown, never read as "missing".
async function resolveParent(token, { internetMessageId, graphIdHint } = {}) {
  const want = stripBrackets(internetMessageId);
  if (!want) return null;
  if (graphIdHint && db.isSchemaReady()) {
    try {
      const r = await graphCall(token, 'GET', `/me/messages/${enc(graphIdHint)}?$select=id,internetMessageId,isDraft`,
        { prefer: PREFER_IMM, op: 'parent hint' });
      const m = r.json || {};
      if (m.id && stripBrackets(m.internetMessageId) === want && m.isDraft !== true) return { id: m.id, via: 'hint' };
    } catch (e) {
      // A stale, foreign or malformed id: fall through to the search.
      if (!isGraphError(e, 400, 403, 404)) throw e;
    }
  }
  const filter = `internetMessageId eq '<${odataString(want)}>'`;
  // $top=2: self-sent mail exists in both Inbox and Sent Items. Either copy is a
  // valid parent, since the reply's recipients are PATCHed explicitly.
  const r = await graphCall(token, 'GET',
    `/me/messages?$filter=${encodeURIComponent(filter)}&$select=id,internetMessageId,isDraft,conversationId&$top=2`,
    { prefer: PREFER_IMM, op: 'parent search' });
  const hits = (r.json && Array.isArray(r.json.value) ? r.json.value : []).filter((m) => m && m.id && m.isDraft !== true);
  if (!hits.length) return null;
  const pick = hits.find((m) => m.id === graphIdHint) || hits[0];
  return { id: pick.id, via: 'search' };
}

function draftTagProp(rowId) {
  return { '@odata.type': '#microsoft.graph.singleValueExtendedProperty', id: DRAFT_TAG_ID, value: String(rowId) };
}

// Graph's recipient shape; the display name only when one was given.
function toGraphRecipients(list) {
  return (Array.isArray(list) ? list : []).map((r) => {
    const emailAddress = { address: String(r.address) };
    if (typeof r.name === 'string' && r.name.length) emailAddress.name = r.name;
    return { emailAddress };
  });
}

// A 2xx create that names no id: Graph made something we can't address. Reported
// as a 5xx-class outcome so the caller treats it as "outcome unknown" and leaves
// it to the sweep's tag search, never as "nothing was created".
function createdIdOf(r, label) {
  const id = r.json && typeof r.json.id === 'string' && r.json.id ? r.json.id : null;
  if (id) return id;
  throw new GraphCallError(`graph ${label}: no id in the response`,
    { kind: 'http', status: 502, graphCode: 'create_returned_no_id', op: label });
}

// createReply, never createReplyAll, with an empty comment so Outlook writes its
// native quote and the caller's HTML is spliced in afterwards (a comment is flattened to
// plain text, and comment + message.body is a 400). message carries only the
// draft tag: no body and no recipients, which are PATCHed explicitly.
async function createReplyDraft(token, parentId, { timezone, tag } = {}) {
  const body = { comment: '' };
  if (tag) body.message = { singleValueExtendedProperties: [tag] };
  const r = await graphCall(token, 'POST', `/me/messages/${enc(parentId)}/createReply`, {
    prefer: preferFor({ timezone }), body, expect: [201, 200], retry503: false, op: 'createReply'
  });
  return { id: createdIdOf(r, 'createReply') };
}

// POST /me/messages lands in the default Drafts folder (never a folder-scoped
// create), where the principal's delegates see it.
async function createNewDraft(token, { subject, html, to, cc, bcc, timezone, tag } = {}) {
  const body = {
    subject: String(subject == null ? '' : subject),
    body: { contentType: 'HTML', content: String(html == null ? '' : html) },
    toRecipients: toGraphRecipients(to),
    ccRecipients: toGraphRecipients(cc),
    bccRecipients: toGraphRecipients(bcc)
  };
  if (tag) body.singleValueExtendedProperties = [tag];
  const r = await graphCall(token, 'POST', '/me/messages', {
    prefer: preferFor({ timezone }), body, expect: [201, 200], retry503: false, op: 'create draft'
  });
  return { id: createdIdOf(r, 'create draft') };
}

// Request 4c. Prefer is advisory: if Graph did not honour IdType on the combined
// create header, the id it returned is a default id that dies when the item
// moves (on send, to Sent Items). Re-reading it with IdType alone and requiring
// the same id back is the only way to know the id we store is immutable.
async function recheckCreatedId(token, id) {
  const r = await graphCall(token, 'GET', `/me/messages/${enc(id)}?$select=id`, { prefer: PREFER_IMM, op: 'create id re-check' });
  return !!(r.json && r.json.id === id);
}

// Inserted HTML is spliced into the draft without sanitizing, but the read-back
// a reviewer sees (and the content hash) is Outlook's sanitized read. Anything
// the read sanitizer would remove could therefore be stored and sent while
// staying invisible in review, so such markup is refused before it is written.
// A conservative scan, not a parser: a false positive only asks for a cleaner
// fragment.
const UNSAFE_TAG_RE = /<\s*\/?\s*(script|iframe|frame|frameset|object|embed|applet|form|base|meta|link)\b/i;
// An event-handler attribute: on...= where an attribute can start (after
// whitespace, a quote or a slash), so a URL parameter such as &online= is not one.
const EVENT_ATTR_RE = /(^|[\s"'/])on[a-z]+\s*=/i;
const UNSAFE_SCHEME_RE = /(javascript|vbscript)\s*:/i;
function decodeForSchemeScan(html) {
  // Character references and embedded whitespace/control characters are how a
  // scheme is usually disguised (java&#x09;script:), so both are folded first.
  return html
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCodePoint(Math.min(parseInt(h, 16), 0x10ffff)))
    .replace(/&#(\d+);?/g, (_, d) => String.fromCodePoint(Math.min(parseInt(d, 10), 0x10ffff)))
    .replace(/&(tab|newline);?/gi, ' ')
    .replace(/&colon;?/gi, ':')
    .replace(/[\s\x00-\x1f\x7f]+/g, '');
}
function assertInsertSafe(html, { field = 'html' } = {}) {
  if (html == null || html === '') return;
  const s = String(html);
  if (UNSAFE_TAG_RE.test(s) || EVENT_ATTR_RE.test(s) || UNSAFE_SCHEME_RE.test(decodeForSchemeScan(s))) {
    const e = new Error(`${field} contains markup not allowed in a draft`);
    e.code = 'INSERT_UNSAFE';
    e.field = field;
    e.detail = e.message;
    throw e;
  }
}

// Request 5: the created draft's body, as HTML (a plain-text parent's reply is
// converted, so the splice always works on HTML).
async function getBodyHtml(token, id) {
  const r = await graphCall(token, 'GET', `/me/messages/${enc(id)}?$select=id,body`, { prefer: PREFER_RB, op: 'draft body' });
  const b = r.json && r.json.body;
  return b && typeof b.content === 'string' ? b.content : '';
}

// The insert goes right after <body…>, i.e. above Outlook's native quote, which
// stays byte for byte as Graph wrote it. No <body> tag: prepend.
function spliceAfterBodyTag(html, insert) {
  const m = /<body\b[^>]*>/i.exec(html || '');
  if (!m) return insert + (html || '');
  const at = m.index + m[0].length;
  return html.slice(0, at) + insert + html.slice(at);
}

// Request 6. Recipients are replaced, never merged: the lists come from the
// caller (server-derived), not from Graph's reply defaults. No If-Match here
// (whether Graph honours it on PATCH is unconfirmed, and refusing it would break
// every create); the send-time read-back and hash are what catch an edit.
async function patchDraft(token, id, { html, to, cc, bcc } = {}) {
  const body = {};
  if (html !== undefined) body.body = { contentType: 'HTML', content: String(html) };
  if (to !== undefined) body.toRecipients = toGraphRecipients(to);
  if (cc !== undefined) body.ccRecipients = toGraphRecipients(cc);
  if (bcc !== undefined) body.bccRecipients = toGraphRecipients(bcc);
  await graphCall(token, 'PATCH', `/me/messages/${enc(id)}`, { prefer: PREFER_IMM, body, op: 'patch draft' });
}

// ────────────────────────────────────────────────────────────────────────
// Read-back and guards
// ────────────────────────────────────────────────────────────────────────

// Requests 7a then 7b: attachments first, the message last, so on the send path
// the message read (whose etag goes into If-Match) is the newest thing we saw.
// The message keeps @odata.etag and parentFolderId.
async function readBack(token, id) {
  const attachments = [];
  let path = `/me/messages/${enc(id)}/attachments?$select=${ATTACHMENT_SELECT}&$top=${ATTACHMENT_PAGE}`;
  for (let page = 1; ; page++) {
    const r = await graphCall(token, 'GET', path, { prefer: PREFER_IMM, op: 'read-back attachments' });
    if (r.json && Array.isArray(r.json.value)) attachments.push(...r.json.value);
    const next = r.json && r.json['@odata.nextLink'];
    if (!next) break;
    // A partial list would hash as a different draft; refuse rather than guess.
    if (page >= MAX_ATTACHMENT_PAGES) {
      throw new GraphCallError('graph read-back attachments: too many pages',
        { kind: 'http', graphCode: 'attachment_list_too_long', op: 'read-back attachments' });
    }
    path = next;
  }
  const r = await graphCall(token, 'GET', `/me/messages/${enc(id)}?$select=${READBACK_SELECT}`,
    { prefer: PREFER_RB, op: 'read-back message' });
  return { message: r.json || {}, attachments };
}

// Request 8. found=false only for a 404; any other error is thrown. etag is the
// guard read's @odata.etag (for an If-Match on the delete that follows).
async function getIsDraft(token, id) {
  try {
    const r = await graphCall(token, 'GET', `/me/messages/${enc(id)}?$select=id,isDraft,parentFolderId`,
      { prefer: PREFER_IMM, op: 'draft guard' });
    const m = r.json || {};
    return { found: true, isDraft: m.isDraft === true, parentFolderId: m.parentFolderId || null,
      etag: m['@odata.etag'] || null };
  } catch (e) {
    if (isGraphError(e, 404)) return { found: false };
    throw e;
  }
}

// Every delete is guarded by an isDraft read: once sent, the immutable id names
// the sent message, and a delete would remove the principal's sent mail.
async function deleteGuarded(token, id, { permanent, ifMatch }) {
  const g = await getIsDraft(token, id);
  if (!g.found) return 'not_found';
  if (g.isDraft !== true) return 'not_draft';
  const tag = ifMatch === true ? g.etag : (ifMatch || null);
  try {
    if (permanent) {
      await graphCall(token, 'POST', `/me/messages/${enc(id)}/permanentDelete`,
        { prefer: PREFER_IMM, ifMatch: tag || undefined, expect: [204, 200, 202], op: 'permanent delete' });
    } else {
      await graphCall(token, 'DELETE', `/me/messages/${enc(id)}`, { prefer: PREFER_IMM, expect: [204, 200], op: 'delete draft' });
    }
  } catch (e) {
    if (isGraphError(e, 404)) return 'not_found';
    throw e;
  }
  return 'deleted';
}

// The user-facing DELETE route: a plain DELETE moves the draft to Deleted Items,
// so a discard stays restorable (and a moved draft then reads as gone).
function deleteIfDraft(token, id) {
  return deleteGuarded(token, id, { permanent: false });
}

// Half-built drafts, a replaced draft and orphans: a plain DELETE would leave an
// editable, sendable draft in Deleted Items, so these are removed for good.
// ifMatch: true sends the guard read's etag, a string is sent verbatim, absent
// sends none (until the live test shows Graph honours it on this path).
function permanentDeleteIfDraft(token, id, { ifMatch } = {}) {
  return deleteGuarded(token, id, { permanent: true, ifMatch });
}

// Request 8t: a draft by its tag (the registry row id). Prefers a draft hit.
async function findDraftByTag(token, rowId) {
  const filter = `singleValueExtendedProperties/Any(ep: ep/id eq '${odataString(DRAFT_TAG_ID)}' and ep/value eq '${odataString(rowId)}')`;
  const r = await graphCall(token, 'GET',
    `/me/messages?$filter=${encodeURIComponent(filter)}&$select=id,isDraft,parentFolderId&$top=2`,
    { prefer: PREFER_IMM, op: 'tag search' });
  const hits = (r.json && Array.isArray(r.json.value) ? r.json.value : []).filter((m) => m && m.id);
  if (!hits.length) return null;
  const m = hits.find((x) => x.isDraft === true) || hits[0];
  return { id: m.id, isDraft: m.isDraft === true, parentFolderId: m.parentFolderId || null };
}

// Request 11: copies of a message by its RFC Message-ID (a just-sent item's Sent
// copy, or the delivered copy of a self-addressed send).
async function searchByInternetMessageId(token, imid) {
  const want = stripBrackets(imid);
  if (!want) return [];
  const filter = `internetMessageId eq '<${odataString(want)}>'`;
  const r = await graphCall(token, 'GET',
    `/me/messages?$filter=${encodeURIComponent(filter)}&$select=id,isDraft,parentFolderId,internetMessageId&$top=2`,
    { prefer: PREFER_IMM, op: 'sent-copy search' });
  return (r.json && Array.isArray(r.json.value) ? r.json.value : []).filter((m) => m && m.id).map((m) => ({
    id: m.id, isDraft: m.isDraft === true, parentFolderId: m.parentFolderId || null,
    internetMessageId: stripBrackets(m.internetMessageId) || null
  }));
}

// Request 10, the only /send in this module, called only by the send route.
// No body, If-Match as given (the read-back's etag), and never repeated: not on
// a throttle, not on a 5xx, not on a timeout (the outcome is then unknown and
// reconciled by reading, never by sending again).
async function sendDraft(token, id, { ifMatch } = {}) {
  const r = await graphCall(token, 'POST', `/me/messages/${enc(id)}/send`, {
    prefer: PREFER_IMM, ifMatch: ifMatch || undefined, expect: [202], any2xx: true,
    retryThrottle: false, retry503: false, op: 'send'
  });
  return { status: r.status };
}

// ────────────────────────────────────────────────────────────────────────
// Hashing (D2) and the read-back object
// ────────────────────────────────────────────────────────────────────────

const sha256hex = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const addrs = (l) => (Array.isArray(l) ? l : []).map((r) =>
  String((r && r.emailAddress && r.emailAddress.address) || '').trim().toLowerCase()).sort();
const one = (r) => ((r && r.emailAddress && r.emailAddress.address)
  ? String(r.emailAddress.address).trim().toLowerCase() : null);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const bodyType = (m) => String((m.body && m.body.contentType) || '').toLowerCase();
const bodyContent = (m) => ((m.body && typeof m.body.content === 'string') ? m.body.content : '');
const subjectOf = (m) => (typeof m.subject === 'string' ? m.subject : '');

// What a send is checked against: everything the reviewer approved that changes
// where the mail goes or what it says (addresses, never display names), the body
// byte for byte as Graph returns it under the fixed Prefer set, the attachment
// list, and the changeKey. One function, so the read-back the client app shows
// and the send-time compare can never disagree.
function contentHash(m, atts) {
  m = m || {};
  const a = (atts || []).map((x) => [String(x.id || ''), String(x.name || ''), Number(x.size) || 0, x.isInline === true])
    .map((t) => JSON.stringify(t)).sort(cmp);
  const canon = ['outlook-draft-content/v2',
    addrs(m.toRecipients), addrs(m.ccRecipients), addrs(m.bccRecipients),
    addrs(m.replyTo),
    one(m.from), one(m.sender),
    subjectOf(m),
    bodyType(m),
    bodyContent(m),
    a,
    typeof m.changeKey === 'string' ? m.changeKey : ''];
  return sha256hex(JSON.stringify(canon));
}

// The same content compared against the Sent copy after a send: the Sent copy
// has its own changeKey and attachment ids, so both are left out.
function verifyHash(m, atts) {
  m = m || {};
  const a = (atts || []).map((x) => [String(x.name || ''), Number(x.size) || 0, x.isInline === true])
    .map((t) => JSON.stringify(t)).sort(cmp);
  const canon = ['outlook-draft-content/verify-v2',
    addrs(m.toRecipients), addrs(m.ccRecipients), addrs(m.bccRecipients),
    addrs(m.replyTo),
    one(m.from), one(m.sender),
    subjectOf(m),
    bodyType(m),
    bodyContent(m),
    a];
  return sha256hex(JSON.stringify(canon));
}

// The fields verifyHash covers, by name: lets the live test say WHICH field
// differs between a draft and its Sent copy without printing any of them.
function hashFields(m, atts) {
  m = m || {};
  return {
    toRecipients: addrs(m.toRecipients), ccRecipients: addrs(m.ccRecipients), bccRecipients: addrs(m.bccRecipients),
    replyTo: addrs(m.replyTo), from: one(m.from), sender: one(m.sender), subject: subjectOf(m),
    bodyContentType: bodyType(m), body: bodyContent(m),
    attachments: (atts || []).map((x) => JSON.stringify([String(x.name || ''), Number(x.size) || 0, x.isInline === true])).sort(cmp)
  };
}

function person(r) {
  if (!r || !r.emailAddress) return null;
  return { name: typeof r.emailAddress.name === 'string' ? r.emailAddress.name : '',
    address: typeof r.emailAddress.address === 'string' ? r.emailAddress.address : '' };
}
const people = (l) => (Array.isArray(l) ? l : []).map(person).filter(Boolean);

// The canonical read-back object (create, GET and PATCH answers). graphId is
// Graph's id exactly as returned (case-sensitive; never normalized). Registry
// fields come from the row: replaces is the graphId of the draft this one
// replaced, which the caller puts on the row as replaces_graph_id (this module
// reads no database).
function toReadBack(message, attachments, row) {
  const m = message || {};
  const r = row || {};
  const replaces = r.replaces_graph_id || r.replacesGraphId || (typeof r.replaces === 'string' ? r.replaces : null);
  return {
    graphId: m.id,
    status: r.status || null,
    kind: r.kind || null,
    accountId: r.account_id || null,
    threadId: r.thread_id || null,
    parentMessageId: r.parent_message_id || null,
    replaces: replaces || null,
    changeKey: typeof m.changeKey === 'string' ? m.changeKey : null,
    contentHash: contentHash(m, attachments),
    internetMessageId: stripBrackets(m.internetMessageId) || null,
    conversationId: m.conversationId || null,
    webLink: m.webLink || null,
    isDraft: m.isDraft === true,
    lastModified: m.lastModifiedDateTime || null,
    sentAt: m.isDraft === false ? (m.sentDateTime || null) : null,
    from: person(m.from),
    sender: person(m.sender),
    replyTo: people(m.replyTo),
    to: people(m.toRecipients),
    cc: people(m.ccRecipients),
    bcc: people(m.bccRecipients),
    subject: subjectOf(m),
    bodyHtml: bodyContent(m),
    attachments: (attachments || []).map((a) => ({
      id: a.id, name: a.name, size: Number(a.size) || 0, isInline: a.isInline === true,
      contentType: a.contentType == null ? null : a.contentType
    })),
    flags: Array.isArray(r.flags) ? [...r.flags] : []
  };
}

module.exports = {
  GRAPH_BASE, PREFER_IMM, PREFER_RB, READBACK_SELECT,
  GraphCallError,
  timezoneToWindows, preferFor, mintToken, graphCall, resolveParent, draftTagProp,
  createReplyDraft, createNewDraft, recheckCreatedId, assertInsertSafe,
  getBodyHtml, spliceAfterBodyTag, patchDraft, readBack, getIsDraft,
  deleteIfDraft, permanentDeleteIfDraft, findDraftByTag, searchByInternetMessageId,
  sendDraft, contentHash, verifyHash, toReadBack, mapGraphError,
  // Additions beyond the frozen list: the tag's property id (the live test
  // reads the property back by it) and the per-field view of verifyHash.
  DRAFT_TAG_ID, hashFields
};
