// The Outlook draft registry (outlook_drafts), the send state machine, and the
// sweep that settles drafts left mid-way (orphaned creates, stale or unknown
// sends, post-send verification, rechecks after a not-found, retention).
// routes/outlook_drafts.js calls the route functions; index.js runs the sweep
// every 30 s.
//
// Every route function takes { req, params, body } and resolves to
//   { status, body, retryAfterSec?, store }
// where `store` says whether the idempotency record keeps this outcome: only
// outcomes a retry with the same key could not change are kept (2xx, a
// kind-specific 400, a 404 of a row in a final state, a 409 where the draft
// itself moved on); a throttle, a Graph or timeout failure, a mailbox that is
// not connected and lease contention release the key so a retry runs again.
// The send route keeps every outcome (util/idempotency.js), so a replayed send
// key can never send twice.
//
// Graph I/O goes through email/graph_drafts.js only; this module owns the SQL.
// Ids in log lines appear as `gfp`, the first 12 hex characters of their sha256,
// and no line ever carries a subject, body, address or token.
const crypto = require('crypto');
const { v4: uuid } = require('uuid');
const db = require('../db');
const gd = require('./graph_drafts');
const { scopedAccounts, sendEnabledFor } = require('../util/scope');

// ------------------------------------------------------------------ timings
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// The operation lease (op_lock) taken by send, PATCH and DELETE on a saved row.
// Longer than the longest of those routes (a recreate: token, guard, delete,
// then a whole create with its cleanup), so it can't lapse mid-operation.
const LEASE_MS = 330 * 1000;
// A row still `creating` this long after its insert is an orphan for the sweep.
const ORPHAN_AFTER_MS = 15 * MIN;
// A `sending` row this old belongs to a process that died mid-send.
const STALE_SENDING_MS = 5 * MIN;
// An `unknown` send that still reads as a draft this long after it started is
// put back to `saved` (flagged); one that can't be found by then stays unknown.
const UNKNOWN_HORIZON_MS = 30 * MIN;
const VERIFY_OVERDUE_MS = 60 * MIN;
const STOP_CHECKING_MS = DAY;
// Post-send checks: next_check_at = anchor + SCHEDULE[min(check_count, 8)], then
// hourly, never closer than MIN_GAP_MS to now.
const SCHEDULE = [20e3, 40e3, MIN, 2 * MIN, 5 * MIN, 10 * MIN, 20 * MIN, 30 * MIN, HOUR];
const MIN_GAP_MS = 20e3;
// A saved row that read as not found is `gone` but rechecked 1, 5 and 15 min
// later, in case the item was mid-submit rather than deleted.
const GONE_RECHECK_AT = [MIN, 5 * MIN, 15 * MIN];
const ERROR_RETRY_MS = 5 * MIN;
// A sweep tick claims each row for this long from the moment it claims it.
// Longer than the slowest single row: a few Graph calls, each with its 30 s
// timeout and at most one throttle retry. A row whose instance stopped mid-row
// waits this long before another instance takes it up.
const SWEEP_CLAIM_MS = 5 * MIN;
// A tick claims no new row once it has run this long; the rest of its batch
// waits for the next tick, so every row it does claim is finished well inside
// that row's claim.
const SWEEP_TICK_BUDGET_MS = SWEEP_CLAIM_MS / 2;
const SWEEP_BATCH = 20;
const PURGE_EVERY_MS = DAY;
const RETENTION_MS = 90 * DAY;
const PURGE_BATCH = 1000;
const PURGE_MAX_BATCHES = 10;
// Route budgets. The env overrides exist for the test harness only.
function routeBudgetMs() { return Number(process.env.CL2_ROUTE_BUDGET_MS) || 120 * 1000; }
function presendBudgetMs() { return Number(process.env.CL2_PRESEND_BUDGET_MS) || 60 * 1000; }

const SENT_STATES = ['sent_pending_verification', 'sent', 'sent_mismatch'];
const FINAL_STATES = ['sent', 'sent_mismatch', 'sent_external', 'gone', 'deleted'];
// Flags that describe a wait; dropped once a send is settled.
const PENDING_FLAGS = ['send_status_unknown', 'verify_overdue', 'not_found_after_send'];

// ------------------------------------------------------------------ helpers
function gfp(id) {
  return id ? crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 12) : '-';
}

// One ops line: the registry id, the account, the draft's gfp and what happened.
// Never content.
function opsLine(level, what, row, extra) {
  const line = `[outlook-drafts] ${what} id=${row.id} account=${row.account_id} gfp=${gfp(row.graph_id)}${extra ? ` ${extra}` : ''}`;
  if (level === 'warn') console.warn(line);
  else if (level === 'error') console.error(line);
  else console.log(line);
}

// An error's code or class name for a log line, never its message.
function errLabel(e) {
  const s = String((e && (e.kind === 'http' ? `http_${e.status}` : (e.kind || e.code || e.name))) || 'error');
  return /^[A-Za-z0-9_.:-]{1,60}$/.test(s) ? s : 'error';
}

const num = (v) => (v == null ? null : Number(v));
const stripBrackets = (s) => (typeof s === 'string' ? s.trim().replace(/^</, '').replace(/>$/, '') : null);

function errorBody(code, { detail, draftStatus, graphStatus, graphCode, replacedBy } = {}) {
  const body = { error: code };
  if (detail) body.detail = String(detail).slice(0, 200);
  if (draftStatus) body.draftStatus = draftStatus;
  if (graphStatus != null) body.graphStatus = graphStatus;
  if (graphCode) body.graphCode = String(graphCode).slice(0, 100);
  if (replacedBy && code === 'gone') body.replacedBy = replacedBy;
  return body;
}

// An error outcome. `store` defaults to false: see the header for what is kept.
function fail(status, code, opts = {}) {
  const out = { status, body: errorBody(code, opts), store: !!opts.store };
  if (opts.retryAfterSec != null) out.retryAfterSec = opts.retryAfterSec;
  return out;
}

function notConnected() {
  return fail(400, 'bad_request', { detail: 'not a connected Microsoft mailbox' });
}

function isGraphError(e) {
  return !!e && (e instanceof gd.GraphCallError || e.name === 'GraphCallError');
}
function httpStatusOf(e) {
  return isGraphError(e) && e.kind === 'http' && e.status != null ? Number(e.status) : null;
}
const isNotFound = (e) => httpStatusOf(e) === 404;

// The route ran out of its time budget between two Graph steps.
class BudgetExceeded extends Error {
  constructor() { super('route budget exceeded'); this.name = 'BudgetExceeded'; this.code = 'BUDGET'; }
}
// Graph answered a create with an id that is not the immutable one (request 4c).
class IdNotApplied extends Error {
  constructor() { super('immutable id not applied'); this.name = 'IdNotApplied'; this.code = 'ID_NOT_APPLIED'; }
}
// A registry write that should have matched one row matched none.
class RegistryChanged extends Error {
  constructor() { super('registry row changed'); this.name = 'RegistryChanged'; this.code = 'REGISTRY_CHANGED'; }
}

// A Graph failure as the error-contract fields. graph_drafts.mapGraphError is the
// mapping; the fallbacks fill only what it leaves out.
function mapGraph(e) {
  let m = null;
  try { m = gd.mapGraphError(e); } catch { m = null; }
  const x = (m && (m.extra || m)) || {};
  let status = m && Number.isInteger(m.status) ? m.status : null;
  let code = m && typeof m.code === 'string' ? m.code : null;
  if (!status || !code) {
    if (e.kind === 'timeout') { status = 504; code = 'graph_timeout'; }
    else if (e.kind === 'http' && (e.status === 429 || (e.status === 503 && e.retryAfterMs != null))) { status = 429; code = 'throttled'; }
    else if (e.kind === 'http' && (e.status === 412 || e.graphCode === 'ErrorIrresolvableConflict')) { status = 409; code = 'changed'; }
    else { status = 502; code = 'graph_error'; }
  }
  const out = { status, code };
  if (code === 'throttled') {
    const ra = x.retryAfterSec != null ? x.retryAfterSec : x.retryAfter;
    out.retryAfterSec = Number.isFinite(Number(ra)) && Number(ra) > 0
      ? Math.ceil(Number(ra)) : (Math.ceil(Number(e.retryAfterMs) / 1000) || 30);
  }
  if (code === 'graph_error') {
    out.graphStatus = x.graphStatus !== undefined ? x.graphStatus : (e.kind === 'http' ? e.status : null);
    let gc = x.graphCode;
    if (gc === undefined) {
      if (e.kind === 'network') gc = 'network';
      else if (e.kind === 'token') gc = `token_refresh_failed:${(e.body && e.body.error) || 'unknown'}`;
      else gc = e.graphCode || e.innerCode || null;
    }
    out.graphCode = gc;
  }
  return out;
}

// The response for a failed step: a Graph failure mapped by mapGraph, a budget
// that ran out (504), the id re-check (502), anything else rethrown for the
// route's 500.
function failureFor(e, draftStatus) {
  if (e instanceof BudgetExceeded) return fail(504, 'graph_timeout', { draftStatus });
  if (e instanceof IdNotApplied) return fail(502, 'graph_error', { graphCode: 'immutable_id_not_applied', draftStatus });
  if (!isGraphError(e)) throw e;
  const m = mapGraph(e);
  return fail(m.status, m.code, { draftStatus, graphStatus: m.graphStatus, graphCode: m.graphCode, retryAfterSec: m.retryAfterSec });
}

// What the clone keeps from one read-back of a draft (or of its Sent copy).
function liveFields({ message, attachments }) {
  return {
    isDraft: message.isDraft === true,
    contentHash: gd.contentHash(message, attachments),
    verifyHash: gd.verifyHash(message, attachments),
    changeKey: typeof message.changeKey === 'string' ? message.changeKey : null,
    internetMessageId: stripBrackets(message.internetMessageId),
    conversationId: typeof message.conversationId === 'string' ? message.conversationId : null,
    webLink: typeof message.webLink === 'string' ? message.webLink : null,
    parentFolderId: typeof message.parentFolderId === 'string' ? message.parentFolderId : null
  };
}

// Still a draft, but no longer in the folder it was created in, means it
// was deleted in Outlook (with immutable ids a delete is a move to Deleted Items).
function movedOut(row, f) {
  return !!(row.drafts_folder_id && f.parentFolderId && f.parentFolderId !== row.drafts_folder_id);
}

// The read-back object. The registry is authoritative for the fields it owns, so
// they are set from the row whatever the shaping derived.
function readBackBody(live, row, replacesGraphId) {
  const view = { ...row, replaces: replacesGraphId || null, replaces_graph_id: replacesGraphId || null };
  const rb = gd.toReadBack(live.message, live.attachments, view);
  rb.status = row.status;
  rb.kind = row.kind;
  rb.accountId = row.account_id;
  rb.threadId = row.thread_id || null;
  rb.parentMessageId = row.parent_message_id || null;
  rb.replaces = replacesGraphId || null;
  rb.flags = Array.isArray(row.flags) ? [...row.flags] : [];
  return rb;
}

// The poll answer when Graph can't be read for a row that is past `saved`.
function registryView(row) {
  return {
    graphId: row.graph_id, status: row.status, flags: Array.isArray(row.flags) ? [...row.flags] : [],
    internetMessageId: row.internet_message_id || null, webLink: row.web_link || null,
    verifiedAt: row.verified_at != null ? new Date(Number(row.verified_at)).toISOString() : null, live: false
  };
}

// ------------------------------------------------------------- registry SQL
const COLUMN_RE = /^[a-z_]+$/;
// The flags expression: add then remove, keeping first-seen order, no repeats.
function flagsSql(addParam, removeParam) {
  return `flags = COALESCE((SELECT array_agg(f ORDER BY o) FROM (SELECT f, min(o) AS o
            FROM unnest(flags || ${addParam}::text[]) WITH ORDINALITY AS u(f, o)
           WHERE f <> ALL(${removeParam}::text[]) GROUP BY f) s), '{}'::text[])`;
}

// UPDATE outlook_drafts SET <set> WHERE id = $1 AND <guard>, returning the row
// (or null when the guard matched nothing). Column names come from this file
// only. Guards: status (a CAS on the status), lock (the lease holder's fence),
// leaseFreeAt (no live lease at that instant), nextCheckAt (the sweep's claim).
async function updateRow(id, guard, set) {
  const params = [id];
  const p = (v) => { params.push(v); return `$${params.length}`; };
  const cols = [];
  for (const [k, v] of Object.entries(set)) {
    if (k === 'addFlags' || k === 'removeFlags') continue;
    if (!COLUMN_RE.test(k)) throw new Error(`updateRow: bad column ${k}`);
    cols.push(`${k} = ${p(v)}`);
  }
  if (set.addFlags || set.removeFlags) cols.push(flagsSql(p(set.addFlags || []), p(set.removeFlags || [])));
  const conds = ['id = $1'];
  if (guard.status) conds.push(`status = ${p(guard.status)}`);
  if (guard.lock) conds.push(`op_lock = ${p(guard.lock)}`);
  if (guard.leaseFreeAt != null) conds.push(`(op_lock_until IS NULL OR op_lock_until < ${p(guard.leaseFreeAt)})`);
  if (guard.nextCheckAt !== undefined) conds.push(`next_check_at = ${p(guard.nextCheckAt)}`);
  const r = await db.query(`UPDATE outlook_drafts SET ${cols.join(', ')} WHERE ${conds.join(' AND ')} RETURNING *`, params);
  return r.rows[0] || null;
}

const rowById = (id) => db.one('SELECT * FROM outlook_drafts WHERE id = $1', [id]);

// The route's view of the caller: its workspace and the accounts its token names.
function callerOf(req) {
  return {
    workspaceId: (req.auth && req.auth.workspaceId) || (req.user && req.user.workspace_id) || null,
    accounts: scopedAccounts(req) || [],
    jti: req.auth && req.auth.jti,
    idemKey: req.get('Idempotency-Key') || null,
    startedAt: Date.now()
  };
}

// A draft by its Graph id, only among the caller's accounts and workspace.
// Graph ids are case-sensitive and compared exactly.
function findRow(caller, graphId) {
  return db.one(
    `SELECT * FROM outlook_drafts WHERE graph_id = $1 AND account_id = ANY($2::text[]) AND workspace_id = $3`,
    [graphId, caller.accounts, caller.workspaceId]);
}

function accountRow(id, workspaceId) {
  return db.one('SELECT * FROM email_accounts WHERE id = $1 AND workspace_id = $2', [id, workspaceId]);
}

const isConnectedMs = (acc) => !!acc && acc.provider === 'microsoft' && !!acc.oauth_refresh_token;

// The Graph id of the draft that replaced this one, once that draft was saved
// (content_hash is first written at the `saved` transition) or turned out to
// have gone out from Outlook. A replacement whose create failed part-way has
// its graph_id recorded before the cleanup deletes it again; naming it would
// send the client to a draft that is already gone, so it is left out.
async function replacedByGraphId(row) {
  if (!row.replaced_by_id) return null;
  const r = await db.one(
    `SELECT graph_id FROM outlook_drafts WHERE id = $1 AND workspace_id = $2
        AND status <> 'creating' AND (content_hash IS NOT NULL OR status = 'sent_external')`,
    [row.replaced_by_id, row.workspace_id]);
  return (r && r.graph_id) || null;
}

async function replacesGraphIdOf(row) {
  if (!row.replaces_id) return null;
  const r = await db.one('SELECT graph_id FROM outlook_drafts WHERE id = $1 AND workspace_id = $2',
    [row.replaces_id, row.workspace_id]);
  return (r && r.graph_id) || null;
}

// The answer for a row that is not `saved` (the PATCH/DELETE/send
// columns). A 404 gone is kept only once it is final: a `gone` the sweep still
// rechecks may yet turn out to have been sent.
async function notSavedAnswer(row) {
  const draftStatus = row.status;
  switch (row.status) {
    case 'creating':
      return fail(404, 'not_found');
    case 'sending': case 'unknown':
      return fail(409, 'already_sending', { draftStatus });
    case 'sent_pending_verification': case 'sent': case 'sent_mismatch':
      return fail(409, 'already_sent', { draftStatus, store: true });
    case 'sent_external':
      return fail(409, 'sent_externally', { draftStatus, store: true });
    default:
      return goneAnswer(row);
  }
}

async function goneAnswer(row) {
  const confirmed = !(Array.isArray(row.flags) && row.flags.includes('gone_unconfirmed'));
  return fail(404, 'gone', { draftStatus: row.status, replacedBy: await replacedByGraphId(row), store: confirmed });
}

// After a write lost its CAS: answer from the row as it is now.
async function answerFromRegistry(rowId) {
  const row = await rowById(rowId);
  if (!row) return fail(404, 'not_found');
  if (row.status === 'saved') return fail(409, 'changed', { draftStatus: 'saved' });
  return notSavedAnswer(row);
}

// A predecessor in the replaces chain that already went out: its replacement
// must not be sent or recreated (the content was delivered once already).
async function sentAncestor(row) {
  if (!row.replaces_id) return null;
  return db.one(
    `WITH RECURSIVE chain AS (
       SELECT id, replaces_id, status, 0 AS depth FROM outlook_drafts WHERE id = $1 AND workspace_id = $2
       UNION ALL
       SELECT o.id, o.replaces_id, o.status, c.depth + 1
         FROM outlook_drafts o JOIN chain c ON o.id = c.replaces_id
        WHERE o.workspace_id = $2 AND c.depth < 100)
     SELECT id, status FROM chain
      WHERE depth > 0 AND status IN ('sent_external','sent','sent_pending_verification','sent_mismatch')
      LIMIT 1`,
    [row.id, row.workspace_id]);
}

// --------------------------------------------------------------- the lease
async function takeLease(rowId) {
  const lock = uuid();
  const now = Date.now();
  const r = await db.query(
    `UPDATE outlook_drafts SET op_lock = $2, op_lock_until = $3, updated_at = $4
      WHERE id = $1 AND status = 'saved' AND (op_lock_until IS NULL OR op_lock_until < $4) RETURNING id`,
    [rowId, lock, now + LEASE_MS, now]);
  return r.rowCount === 1 ? lock : null;
}

async function releaseLease(rowId, lock) {
  try {
    await db.query('UPDATE outlook_drafts SET op_lock = NULL, op_lock_until = NULL WHERE id = $1 AND op_lock = $2', [rowId, lock]);
  } catch (e) {
    // The lease lapses on its own after LEASE_MS.
    console.error(`[outlook-drafts] unexpected release ${errLabel(e)}`);
  }
}

// PATCH/DELETE found the lease taken: answered like a request in progress, and
// not kept, so the same key can run once the other operation is done.
async function leaseContention(rowId) {
  const row = await rowById(rowId);
  if (row && row.status !== 'saved') return notSavedAnswer(row);
  return fail(429, 'throttled', { detail: 'another operation on this draft is in progress', draftStatus: 'saved', retryAfterSec: 2 });
}

// The lease holder's transition of a saved row. A write that matches nothing
// means the row moved under us: the route stops and answers from the registry.
async function leaseTransition(row, lock, toStatus, set = {}) {
  const now = Date.now();
  const done = await updateRow(row.id, { status: 'saved', lock }, {
    status: toStatus, op_lock: null, op_lock_until: null, next_check_at: null, updated_at: now, ...set
  });
  if (!done) throw new RegistryChanged();
  return done;
}

// A saved row that Graph no longer finds: `gone`, rechecked at +1/+5/+15 min in
// case the item was being sent rather than deleted.
function goneUnconfirmedSet(now) {
  return { next_check_at: now + GONE_RECHECK_AT[0], check_count: 0, last_error: 'not_found', addFlags: ['gone_unconfirmed'] };
}

// ----------------------------------------------------------- the create path
// The signature a new draft carries: the account's stored HTML when
// ea_append_signature is on and it has visible content, unless it holds markup
// the read sanitizer would strip, in which case it is left out and flagged.
function signatureFor(account) {
  const html = typeof account.signature_html === 'string' ? account.signature_html : '';
  if (account.ea_append_signature === false || !html.trim()) return { html: null, skipped: false };
  try {
    gd.assertInsertSafe(html, { field: 'signature_html' });
    return { html, skipped: false };
  } catch (e) {
    if (!e || e.code !== 'INSERT_UNSAFE') throw e;
    return { html: null, skipped: true };
  }
}

// bodyHtml is spliced into the draft unsanitized, so markup Outlook's read
// sanitizer would strip (and so leave out of the hashed read-back) is refused
// before anything is created.
function unsafeBody(bodyHtml) {
  try {
    gd.assertInsertSafe(bodyHtml, { field: 'bodyHtml' });
    return null;
  } catch (e) {
    if (!e || e.code !== 'INSERT_UNSAFE') throw e;
    return fail(400, 'bad_request', { detail: 'bodyHtml contains markup not allowed in a draft', store: true });
  }
}

function checkBudget(deadline) {
  if (Date.now() > deadline) throw new BudgetExceeded();
}

// Deletes a draft this route created and could not finish, guarded by an
// isDraft read and permanent: a draft only moved to Deleted Items still
// opens as a sendable draft there. The row follows what the guard saw; a
// cleanup that fails leaves the row `creating` for the sweep.
async function cleanupCreated(token, rowId, createdId, why) {
  let outcome;
  try {
    outcome = await gd.permanentDeleteIfDraft(token, createdId, {});
  } catch (e) {
    console.warn(`[outlook-drafts] half-built draft left for the sweep id=${rowId} gfp=${gfp(createdId)} ${errLabel(e)}`);
    return;
  }
  const now = Date.now();
  try {
    if (outcome === 'not_draft') {
      const row = await rowById(rowId);
      await updateRow(rowId, { status: 'creating' }, {
        status: 'sent_external', graph_id: (row && row.graph_id) || createdId, next_check_at: null, last_error: why, updated_at: now
      });
    } else {
      await updateRow(rowId, { status: 'creating' }, { status: 'deleted', next_check_at: null, last_error: why, updated_at: now });
    }
  } catch (e) {
    console.error(`[outlook-drafts] unexpected cleanup ${errLabel(e)}`);
  }
}

// The create path, shared by both create routes and by PATCH's recreate.
//   spec: { kind, account, parent (reply), input, token?, replaces?: { row, lock } }
// Resolves to the route outcome: 201 with the read-back, or the mapped error.
async function buildDraft(caller, spec) {
  const { kind, account, input } = spec;
  const deadline = caller.startedAt + routeBudgetMs();
  const sig = signatureFor(account);
  const to = input.to;
  const cc = input.cc || [];
  const bcc = kind === 'new' ? (input.bcc || []) : [];

  // 1. Token and (reply) the parent's id in its own mailbox. Nothing exists yet.
  let token = spec.token || null;
  let parentGraphId = null;
  try {
    if (!token) token = await gd.mintToken(account, { send: false });
    checkBudget(deadline);
    if (kind === 'reply') {
      const found = await gd.resolveParent(token, {
        internetMessageId: spec.parent.message_id, graphIdHint: spec.parent.graph_id || null
      });
      // A confirmed 0-match. Never a new conversation in its place.
      if (!found) return fail(409, 'parent_missing', { detail: 'the parent message is not in the mailbox' });
      parentGraphId = found.id;
      checkBudget(deadline);
    }
  } catch (e) {
    return failureFor(e);
  }

  // 2. The registry row, before the draft exists: a create whose answer is lost
  // still leaves a row the sweep can find the draft by (its tag carries the id).
  const rowId = uuid();
  const now = Date.now();
  await db.query(
    `INSERT INTO outlook_drafts (id, workspace_id, account_id, graph_id, kind, status, thread_id, parent_message_id,
       parent_internet_message_id, created_by_jti, idempotency_key, replaces_id, flags, created_at, updated_at, next_check_at)
     VALUES ($1, $2, $3, NULL, $4, 'creating', $5, $6, $7, $8, $9, $10, $11, $12, $12, $13)`,
    [rowId, caller.workspaceId, account.id, kind,
      kind === 'reply' ? spec.parent.thread_id : null, kind === 'reply' ? spec.parent.id : null,
      kind === 'reply' ? stripBrackets(spec.parent.message_id) : null,
      caller.jti, caller.idemKey, spec.replaces ? spec.replaces.row.id : null,
      sig.skipped ? ['signature_skipped'] : [], now, now + ORPHAN_AFTER_MS]);
  if (spec.replaces) {
    const linked = await updateRow(spec.replaces.row.id, { lock: spec.replaces.lock }, { replaced_by_id: rowId });
    if (!linked) {
      await updateRow(rowId, { status: 'creating' }, { status: 'deleted', next_check_at: null, last_error: 'replaced_row_changed', updated_at: Date.now() });
      return answerFromRegistry(spec.replaces.row.id);
    }
  }

  // 3. The create. Its outcome decides whether a draft may exist.
  const insertHtml = `<div>${input.bodyHtml}</div>${sig.html ? `<div><br></div><div>${sig.html}</div>` : ''}`;
  let created;
  try {
    checkBudget(deadline);
    created = kind === 'reply'
      ? await gd.createReplyDraft(token, parentGraphId, { timezone: input.timezone, tag: gd.draftTagProp(rowId) })
      : await gd.createNewDraft(token, { subject: input.subject, html: insertHtml, to, cc, bcc, timezone: input.timezone, tag: gd.draftTagProp(rowId) });
  } catch (e) {
    return createFailed(e, rowId, kind);
  }
  const createdId = created && created.id;

  // 4. Everything after a confirmed create: any failure deletes the draft again.
  let phase = 'recheck';
  try {
    if (typeof createdId !== 'string' || !createdId) throw new IdNotApplied();
    // The id must be the immutable one: a default id dies when the item moves
    // to Sent Items, and the post-send checks look it up by this id.
    if (!(await gd.recheckCreatedId(token, createdId))) throw new IdNotApplied();
    phase = 'record';
    const recorded = await updateRow(rowId, { status: 'creating' }, { graph_id: createdId, updated_at: Date.now() });
    if (!recorded) throw new RegistryChanged();
    if (kind === 'reply') {
      checkBudget(deadline);
      phase = 'body';
      const html = await gd.getBodyHtml(token, createdId);
      checkBudget(deadline);
      // The caller's HTML and the signature go right after <body...>, above Outlook's own
      // quote of the parent; the recipients are replaced with the caller's.
      phase = 'patch';
      await gd.patchDraft(token, createdId, { html: gd.spliceAfterBodyTag(html, `${insertHtml}<div><br></div>`), to, cc, bcc: [] });
    }
    checkBudget(deadline);
    phase = 'readback';
    const live = await gd.readBack(token, createdId);
    const f = liveFields(live);
    phase = 'save';
    const saved = await updateRow(rowId, { status: 'creating' }, {
      status: 'saved', content_hash: f.contentHash, verify_hash: f.verifyHash, change_key: f.changeKey,
      internet_message_id: f.internetMessageId, conversation_id: f.conversationId, web_link: f.webLink,
      drafts_folder_id: f.parentFolderId, next_check_at: null, last_error: null, updated_at: Date.now()
    });
    if (!saved) throw new RegistryChanged();
    const replaces = spec.replaces ? spec.replaces.row.graph_id : null;
    return { status: 201, body: readBackBody(live, saved, replaces), store: true };
  } catch (e) {
    const label = e instanceof BudgetExceeded ? 'budget' : errLabel(e);
    if (typeof createdId === 'string' && createdId) await cleanupCreated(token, rowId, createdId, `${phase}_failed`);
    if (!isGraphError(e) && !(e instanceof BudgetExceeded) && !(e instanceof IdNotApplied)) {
      console.error(`[outlook-drafts] unexpected create ${phase} ${label}`);
      return fail(500, 'server_error');
    }
    return failureFor(e);
  }
}

// The create call failed. Definite refusals (a 4xx) mean no draft was made and
// the row is closed; an unknown outcome (timeout, network, 5xx) may have made
// one, so the row stays `creating` and the sweep finds it by its tag later.
async function createFailed(e, rowId, kind) {
  const now = Date.now();
  const status = httpStatusOf(e);
  try {
    if (e instanceof BudgetExceeded) {
      await updateRow(rowId, { status: 'creating' }, { status: 'deleted', next_check_at: null, last_error: 'budget', updated_at: now });
      return failureFor(e);
    }
    if (kind === 'reply' && (status === 404 || status === 403)) {
      await updateRow(rowId, { status: 'creating' }, { status: 'deleted', next_check_at: null, last_error: 'parent_gone', updated_at: now });
      return fail(409, 'parent_missing', { detail: 'the parent message is not in the mailbox' });
    }
    if (status != null && status >= 400 && status < 500) {
      await updateRow(rowId, { status: 'creating' }, { status: 'deleted', next_check_at: null, last_error: `graph_${status}`, updated_at: now });
      return failureFor(e);
    }
    await updateRow(rowId, { status: 'creating' }, { last_error: 'create_unconfirmed' });
  } catch (dbErr) {
    console.error(`[outlook-drafts] unexpected create record ${errLabel(dbErr)}`);
  }
  if (!isGraphError(e)) {
    console.error(`[outlook-drafts] unexpected create ${errLabel(e)}`);
    return fail(500, 'server_error');
  }
  return failureFor(e);
}

// ------------------------------------------------------------- route: create
// POST /api/threads/:id/outlook-draft (scope draft). The parent must be a copy
// in this thread held by one of the token's accounts; the draft goes into that
// copy's own mailbox.
async function createReplyDraft({ req, params, body }) {
  const caller = callerOf(req);
  const unsafe = unsafeBody(body.bodyHtml);
  if (unsafe) return unsafe;
  const parent = await db.one(
    `SELECT m.id, m.account_id, m.thread_id, m.message_id, m.graph_id,
            ea.provider, (ea.oauth_refresh_token IS NOT NULL) AS has_rt, ea.signature_html, ea.ea_append_signature
       FROM messages m JOIN email_accounts ea ON ea.id = m.account_id
      WHERE m.id = $1 AND m.thread_id = $2 AND m.workspace_id = $3 AND m.account_id = ANY($4::text[])`,
    [body.parentMessageId, params.id, caller.workspaceId, caller.accounts]);
  // Unknown, foreign and wrong-thread parents all answer the same.
  if (!parent) return fail(404, 'not_found');
  if (parent.provider !== 'microsoft' || !parent.has_rt) return notConnected();
  if (!stripBrackets(parent.message_id)) return fail(409, 'parent_missing', { detail: 'the parent message has no Internet message id' });
  const account = await accountRow(parent.account_id, caller.workspaceId);
  if (!isConnectedMs(account)) return notConnected();
  return buildDraft(caller, { kind: 'reply', account, parent, input: body });
}

// POST /api/compose/outlook-draft (scope draft). A new message in the account's
// default Drafts folder.
async function createNewDraft({ req, body }) {
  const caller = callerOf(req);
  const unsafe = unsafeBody(body.bodyHtml);
  if (unsafe) return unsafe;
  const acc = await db.one(
    `SELECT id FROM email_accounts WHERE id = $1 AND workspace_id = $2 AND id = ANY($3::text[])`,
    [body.accountId, caller.workspaceId, caller.accounts]);
  if (!acc) return fail(404, 'not_found');
  const account = await accountRow(acc.id, caller.workspaceId);
  if (!isConnectedMs(account)) return notConnected();
  return buildDraft(caller, { kind: 'new', account, input: body });
}

// --------------------------------------------------------------- route: GET
// GET /api/outlook-drafts/:graphId (scope draft): the client's poll. A saved draft is
// read live and what Outlook did to it recorded; any other status is only reported
// (the sweep owns those transitions), from the registry when Graph can't be read.
async function getDraft({ req, params }) {
  const caller = callerOf(req);
  const row = await findRow(caller, params.graphId);
  if (!row || row.status === 'creating') return fail(404, 'not_found');
  if (row.status === 'gone' || row.status === 'deleted') return goneAnswer(row);
  const account = await accountRow(row.account_id, caller.workspaceId);
  let live;
  try {
    if (!account) throw Object.assign(new Error('account missing'), { code: 'ACCOUNT_MISSING' });
    const token = await gd.mintToken(account, { send: false });
    live = await gd.readBack(token, row.graph_id);
  } catch (e) {
    if (row.status !== 'saved') {
      if (isGraphError(e) || (e && e.code === 'ACCOUNT_MISSING')) return { status: 200, body: registryView(row), store: false };
      throw e;
    }
    if (e && e.code === 'ACCOUNT_MISSING') return fail(404, 'not_found');
    if (isNotFound(e)) {
      const now = Date.now();
      const gone = await updateRow(row.id, { status: 'saved', leaseFreeAt: now }, { status: 'gone', updated_at: now, ...goneUnconfirmedSet(now) });
      if (gone) return goneAnswer(gone);
      return pollAnswerAfterLostCas(row.id, null);
    }
    return failureFor(e, 'saved');
  }
  const replaces = await replacesGraphIdOf(row);
  if (row.status !== 'saved') return { status: 200, body: readBackBody(live, row, replaces), store: false };
  const f = liveFields(live);
  const now = Date.now();
  if (!f.isDraft) {
    const done = await updateRow(row.id, { status: 'saved', leaseFreeAt: now }, {
      status: 'sent_external', internet_message_id: f.internetMessageId || row.internet_message_id,
      web_link: f.webLink || row.web_link, next_check_at: null, updated_at: now
    });
    if (!done) return pollAnswerAfterLostCas(row.id, live);
    return { status: 200, body: readBackBody(live, done, replaces), store: false };
  }
  if (movedOut(row, f)) {
    const gone = await updateRow(row.id, { status: 'saved', leaseFreeAt: now }, {
      status: 'gone', next_check_at: null, last_error: 'moved', updated_at: now
    });
    if (gone) return goneAnswer(gone);
    return pollAnswerAfterLostCas(row.id, live);
  }
  const fresh = await updateRow(row.id, { status: 'saved' }, {
    change_key: f.changeKey, content_hash: f.contentHash, verify_hash: f.verifyHash,
    internet_message_id: f.internetMessageId, conversation_id: f.conversationId, web_link: f.webLink, updated_at: now
  });
  if (!fresh) return pollAnswerAfterLostCas(row.id, live);
  return { status: 200, body: readBackBody(live, fresh, replaces), store: false };
}

// A GET whose transition lost to another operation: report what the registry
// holds now, with the live read when there is one.
async function pollAnswerAfterLostCas(rowId, live) {
  const row = await rowById(rowId);
  if (!row || row.status === 'creating') return fail(404, 'not_found');
  if (row.status === 'gone' || row.status === 'deleted') return goneAnswer(row);
  if (!live) return { status: 200, body: registryView(row), store: false };
  return { status: 200, body: readBackBody(live, row, await replacesGraphIdOf(row)), store: false };
}

// The live state of a leased saved row, for PATCH and DELETE: with
// ifContentHash, a full read-back to compare; without, the isDraft guard.
// Resolves to an outcome that ends the route, or null to go on.
async function checkLeasedDraft(row, lock, token, ifContentHash) {
  let found;
  let isDraft;
  let f = null;
  try {
    if (ifContentHash) {
      f = liveFields(await gd.readBack(token, row.graph_id));
      found = true;
      isDraft = f.isDraft;
    } else {
      const g = await gd.getIsDraft(token, row.graph_id);
      found = !!(g && g.found);
      isDraft = !!(g && g.isDraft === true);
      f = { parentFolderId: (g && g.parentFolderId) || null };
    }
  } catch (e) {
    if (!isNotFound(e)) throw e;
    found = false;
  }
  const now = Date.now();
  if (!found) {
    const gone = await leaseTransition(row, lock, 'gone', goneUnconfirmedSet(now));
    return goneAnswer(gone);
  }
  if (!isDraft) {
    await leaseTransition(row, lock, 'sent_external', {});
    return fail(409, 'sent_externally', { draftStatus: 'sent_external', store: true });
  }
  if (movedOut(row, f)) {
    const gone = await leaseTransition(row, lock, 'gone', { last_error: 'moved' });
    return goneAnswer(gone);
  }
  if (ifContentHash && f.contentHash !== ifContentHash) {
    // Edited after the client last showed it (a delegate, "open in Outlook"): nothing is
    // discarded; the client reads it again and asks again.
    const fresh = await updateRow(row.id, { status: 'saved', lock }, {
      change_key: f.changeKey, content_hash: f.contentHash, verify_hash: f.verifyHash,
      internet_message_id: f.internetMessageId, web_link: f.webLink, op_lock: null, op_lock_until: null, updated_at: now
    });
    if (!fresh) throw new RegistryChanged();
    return fail(409, 'changed', { detail: 'the draft changed since it was last read', draftStatus: 'saved', store: true });
  }
  return null;
}

// ------------------------------------------------------------- route: PATCH
// A recreate whose new create failed answers with the create's error, made
// after the old draft was already deleted. Like every other error on a graphId
// route it carries draftStatus, the registry status of the draft the URL names
// (now `deleted`), so the client knows the old draft is gone and creates again
// instead of retrying against it. not_found never carries one.
async function withDraftStatus(out, rowId) {
  if (out.status < 400 || !out.body || out.body.draftStatus || out.body.error === 'not_found') return out;
  let draftStatus = 'deleted';
  try {
    const cur = await rowById(rowId);
    if (cur && cur.status) draftStatus = cur.status;
  } catch (e) {
    // The row was written `deleted` by this request, under its lease.
    console.error(`[outlook-drafts] unexpected recreate status ${errLabel(e)}`);
  }
  return { ...out, body: errorBody(out.body.error, { ...out.body, draftStatus }) };
}

// PATCH /api/outlook-drafts/:graphId (scope draft) = recreate: the old
// draft is permanently deleted first, then the new one is created from the
// request, so a reviewed draft and its replacement are never both live.
async function recreateDraft({ req, params, body }) {
  const caller = callerOf(req);
  const row = await findRow(caller, params.graphId);
  if (!row || row.status === 'creating') return fail(404, 'not_found');
  // Rules that depend on the draft's kind; deterministic, so the 400 is kept.
  if (row.kind === 'reply') {
    if (body.subject !== undefined) return fail(400, 'bad_request', { detail: 'subject: a reply draft keeps the subject Outlook gives it', store: true });
    if (body.bcc !== undefined) return fail(400, 'bad_request', { detail: 'bcc: not allowed on a reply draft', store: true });
  } else if (body.subject === undefined) {
    return fail(400, 'bad_request', { detail: 'subject: required', store: true });
  }
  const unsafe = unsafeBody(body.bodyHtml);
  if (unsafe) return unsafe;
  if (row.status !== 'saved') return notSavedAnswer(row);
  const ancestor = await sentAncestor(row);
  if (ancestor) return fail(409, 'sent_externally', { detail: 'a draft this one replaced was already sent', draftStatus: row.status, store: true });
  // What the new draft is built from, checked before the old one is touched.
  const account = await accountRow(row.account_id, caller.workspaceId);
  if (!account) return fail(404, 'not_found');
  if (!isConnectedMs(account)) return notConnected();
  let parent = null;
  if (row.kind === 'reply') {
    parent = await db.one(
      `SELECT id, thread_id, message_id, graph_id FROM messages WHERE id = $1 AND workspace_id = $2 AND account_id = $3`,
      [row.parent_message_id, caller.workspaceId, row.account_id]);
    if (!parent || !stripBrackets(parent.message_id)) return fail(409, 'parent_missing', { detail: 'the parent message is no longer available' });
  }
  const lock = await takeLease(row.id);
  if (!lock) return leaseContention(row.id);
  try {
    let token;
    try {
      token = await gd.mintToken(account, { send: false });
      const stop = await checkLeasedDraft(row, lock, token, body.ifContentHash);
      if (stop) return stop;
      const outcome = await gd.permanentDeleteIfDraft(token, row.graph_id, {});
      const now = Date.now();
      if (outcome === 'not_draft') {
        await leaseTransition(row, lock, 'sent_external', {});
        opsLine('warn', 'replaced draft was sent from Outlook', row, 'saved->sent_external');
        return fail(409, 'sent_externally', { draftStatus: 'sent_external', store: true });
      }
      if (outcome === 'not_found') {
        const gone = await leaseTransition(row, lock, 'gone', goneUnconfirmedSet(now));
        return goneAnswer(gone);
      }
      // The old draft is gone from the mailbox; its row keeps the lease until
      // the replacement is linked to it.
      const del = await updateRow(row.id, { status: 'saved', lock }, { status: 'deleted', next_check_at: null, last_error: null, updated_at: now });
      if (!del) throw new RegistryChanged();
    } catch (e) {
      if (e instanceof RegistryChanged) return answerFromRegistry(row.id);
      return failureFor(e, 'saved');
    }
    // The new draft. If this fails the old one stays deleted: the client holds the
    // content and creates again.
    const out = await buildDraft(caller, {
      kind: row.kind, account, parent, input: body, token, replaces: { row, lock }
    });
    if (out.status === 201) return { ...out, status: 200 };
    return withDraftStatus(out, row.id);
  } catch (e) {
    if (e instanceof RegistryChanged) return answerFromRegistry(row.id);
    throw e;
  } finally {
    await releaseLease(row.id, lock);
  }
}

// ------------------------------------------------------------ route: DELETE
// DELETE /api/outlook-drafts/:graphId (scope draft): discard. A plain Graph
// DELETE, so the draft stays restorable from Deleted Items.
async function deleteDraft({ req, params, body }) {
  const caller = callerOf(req);
  const row = await findRow(caller, params.graphId);
  if (!row || row.status === 'creating') return fail(404, 'not_found');
  if (row.status !== 'saved') return notSavedAnswer(row);
  const account = await accountRow(row.account_id, caller.workspaceId);
  if (!account) return fail(404, 'not_found');
  const lock = await takeLease(row.id);
  if (!lock) return leaseContention(row.id);
  try {
    const token = await gd.mintToken(account, { send: false });
    const stop = await checkLeasedDraft(row, lock, token, body && body.ifContentHash);
    if (stop) return stop;
    const outcome = await gd.deleteIfDraft(token, row.graph_id);
    const now = Date.now();
    if (outcome === 'not_draft') {
      await leaseTransition(row, lock, 'sent_external', {});
      return fail(409, 'sent_externally', { draftStatus: 'sent_external', store: true });
    }
    if (outcome === 'not_found') {
      const gone = await leaseTransition(row, lock, 'gone', goneUnconfirmedSet(now));
      return goneAnswer(gone);
    }
    await leaseTransition(row, lock, 'deleted', { last_error: null });
    return { status: 200, body: { graphId: row.graph_id, status: 'deleted' }, store: true };
  } catch (e) {
    if (e instanceof RegistryChanged) return answerFromRegistry(row.id);
    return failureFor(e, 'saved');
  } finally {
    await releaseLease(row.id, lock);
  }
}

// -------------------------------------------------------------- route: send
// POST /api/outlook-drafts/:graphId/send (scope send). In order: claim the
// row (single flight, on status only), read the draft back, require its hash to
// be the one the client confirmed, then one /send with If-Match. Nothing awaits between
// that read-back and /send. /send is never retried, and an answer that leaves
// the outcome open moves the row to `unknown` for the sweep, never back to a
// state that could send again on its own.
async function sendDraft({ req, params, body }) {
  const caller = callerOf(req);
  const row = await findRow(caller, params.graphId);
  if (!row || row.status === 'creating') return fail(404, 'not_found', { store: true });
  if (row.status !== 'saved') return { ...(await notSavedAnswer(row)), store: true };
  if (!sendEnabledFor(row.account_id)) {
    return fail(403, 'forbidden_scope', { detail: 'send_disabled', store: true });
  }
  // A predecessor that already went out from Outlook: its replacement is not
  // sent as well. Read before the claim, never between read-back and /send.
  if (await sentAncestor(row)) {
    return fail(409, 'sent_externally', { detail: 'a draft this one replaced was already sent', draftStatus: row.status, store: true });
  }

  // 1. Single flight: saved -> sending, with the lease. confirm_hash is written
  // here so a crash after /send still leaves what the client confirmed on the row.
  const lock = uuid();
  const now = Date.now();
  const claimed = await updateRow(row.id, { status: 'saved', leaseFreeAt: now }, {
    status: 'sending', op_lock: lock, op_lock_until: now + LEASE_MS, send_started_at: now,
    next_check_at: now + STALE_SENDING_MS, confirm_hash: body.confirmHash, last_error: null, updated_at: now
  });
  if (!claimed) {
    const cur = await rowById(row.id);
    if (cur && cur.status === 'saved') return fail(409, 'changed', { detail: 'another operation on this draft is in progress', draftStatus: 'saved', store: true });
    return { ...(cur ? await notSavedAnswer(cur) : fail(404, 'not_found')), store: true };
  }

  // Every exit below leaves the row in a defined state. "revert" = back to
  // saved (nothing was sent).
  const revert = async (code, set = {}) => updateRow(row.id, { status: 'sending', lock }, {
    status: 'saved', op_lock: null, op_lock_until: null, next_check_at: null, last_error: code, updated_at: Date.now(), ...set
  });
  const answer = async (wrote, outcome) => {
    if (wrote) return { ...outcome, store: true };
    // The fenced write matched nothing: the row moved on (the stale sweep, say).
    const cur = await rowById(row.id);
    return { ...fail(409, 'changed', { draftStatus: cur ? cur.status : undefined }), store: true };
  };

  // 2. The account and a send-capable token.
  let token;
  try {
    const account = await db.one('SELECT * FROM email_accounts WHERE id = $1', [row.account_id]);
    if (!account) return answer(await revert('account_missing'), fail(404, 'not_found'));
    token = await gd.mintToken(account, { send: true });
  } catch (e) {
    if (!isGraphError(e)) { await revert('unexpected'); throw e; }
    return answer(await revert('token'), failureFor(e, 'saved'));
  }

  // 3. Read back: attachments, then the message, so the message read is last.
  const t0 = Date.now();
  let live;
  try {
    live = await gd.readBack(token, row.graph_id);
  } catch (e) {
    if (isNotFound(e)) {
      // Not found before anything was sent: `gone`, but rechecked in case
      // the item was mid-submit from Outlook rather than deleted.
      const n = Date.now();
      const gone = await updateRow(row.id, { status: 'sending', lock }, {
        status: 'gone', op_lock: null, op_lock_until: null, updated_at: n, ...goneUnconfirmedSet(n)
      });
      return answer(gone, fail(404, 'gone', { draftStatus: 'gone' }));
    }
    if (!isGraphError(e)) { await revert('unexpected'); throw e; }
    return answer(await revert(errLabel(e)), failureFor(e, 'saved'));
  }
  const message = live.message;
  const f = liveFields(live);
  if (f.isDraft && movedOut(row, f)) {
    const gone = await updateRow(row.id, { status: 'sending', lock }, {
      status: 'gone', op_lock: null, op_lock_until: null, next_check_at: null, last_error: 'moved', updated_at: Date.now()
    });
    return answer(gone, fail(404, 'gone', { draftStatus: 'gone' }));
  }
  if (!f.isDraft) {
    const ext = await updateRow(row.id, { status: 'sending', lock }, {
      status: 'sent_external', op_lock: null, op_lock_until: null, next_check_at: null,
      internet_message_id: f.internetMessageId || row.internet_message_id, web_link: f.webLink || row.web_link, updated_at: Date.now()
    });
    return answer(ext, fail(409, 'sent_externally', { draftStatus: 'sent_external' }));
  }
  if (f.contentHash !== body.confirmHash) {
    // Not what the client confirmed. The row takes the new read-back; the answer carries
    // nothing of it (the send token never learns a draft's version).
    const back = await revert('changed', {
      change_key: f.changeKey, content_hash: f.contentHash, verify_hash: f.verifyHash,
      internet_message_id: f.internetMessageId || row.internet_message_id, web_link: f.webLink || row.web_link
    });
    return answer(back, fail(409, 'changed', { detail: 'the draft is not the version that was confirmed', draftStatus: 'saved' }));
  }
  if (Date.now() - t0 > presendBudgetMs()) {
    return answer(await revert('presend_budget'), fail(504, 'graph_timeout', { detail: 'nothing was sent', draftStatus: 'saved' }));
  }
  const vh = f.verifyHash;
  const etag = typeof message['@odata.etag'] === 'string' && message['@odata.etag']
    ? message['@odata.etag'] : `W/"${f.changeKey || ''}"`;

  // 4. The one /send.
  let sent;
  try {
    sent = await gd.sendDraft(token, row.graph_id, { ifMatch: etag });
  } catch (e) {
    return sendFailed(e, row, lock, { h: f.contentHash, vh, imid: f.internetMessageId }, revert, answer);
  }

  // 5. Accepted: verification follows in the sweep.
  const acceptedAt = Date.now();
  const accepted = { graphId: row.graph_id, status: 'sent_pending_verification', internetMessageId: f.internetMessageId || row.internet_message_id || null };
  try {
    const done = await updateRow(row.id, { status: 'sending', lock }, {
      status: 'sent_pending_verification', content_hash: f.contentHash, verify_hash: vh, change_key: f.changeKey,
      internet_message_id: f.internetMessageId || row.internet_message_id, web_link: f.webLink || row.web_link,
      send_accepted_at: acceptedAt, next_check_at: acceptedAt + SCHEDULE[0], check_count: 0,
      op_lock: null, op_lock_until: null, updated_at: acceptedAt, removeFlags: ['send_status_unknown']
    });
    if (done) return { status: 202, body: accepted, store: true };
  } catch (e) {
    console.error(`[outlook-drafts] unexpected send accepted_write ${errLabel(e)}`);
  }
  // Graph accepted the send but the row could not record it. Record the outcome
  // as unknown (with the hashes the check needs) so the sweep settles it from
  // the Sent copy; if even that fails the stale-sending sweep gets there.
  let recorded = 'sending';
  try {
    const unk = await updateRow(row.id, { status: 'sending', lock }, unknownSet({ h: f.contentHash, vh, imid: f.internetMessageId }, 'accepted_unrecorded', row));
    if (unk) recorded = 'unknown';
  } catch (e) {
    console.error(`[outlook-drafts] unexpected send unknown_write ${errLabel(e)}`);
  }
  opsLine('warn', 'send outcome unknown', row, `sending->${recorded} graph=${sent && sent.status}`);
  return { status: 202, body: { ...accepted, status: recorded }, store: true };
}

// The `unknown` write: the send may or may not have gone out. It keeps the
// send-time hashes and Internet message id so the sweep can verify the Sent
// copy, or look for it, and it never sends again.
function unknownSet({ h, vh, imid }, code, row, extraFlags = []) {
  const now = Date.now();
  return {
    status: 'unknown', verify_hash: vh, content_hash: h, internet_message_id: imid || row.internet_message_id,
    last_error: code, next_check_at: now + SCHEDULE[0], check_count: 0, op_lock: null, op_lock_until: null,
    updated_at: now, ...(extraFlags.length ? { addFlags: extraFlags } : {})
  };
}

// /send did not answer 2xx.
async function sendFailed(e, row, lock, hashes, revert, answer) {
  const status = httpStatusOf(e);
  if (!isGraphError(e)) {
    // Unknown whether Graph got it: never back to saved.
    await updateRow(row.id, { status: 'sending', lock }, unknownSet(hashes, 'unexpected', row)).catch(() => null);
    opsLine('warn', 'send outcome unknown', row, `sending->unknown ${errLabel(e)}`);
    throw e;
  }
  if (status === 412 || (status != null && e.graphCode === 'ErrorIrresolvableConflict')) {
    return answer(await revert('changed'), fail(409, 'changed', { detail: 'the draft changed before it was sent', draftStatus: 'saved' }));
  }
  if (status === 429) {
    const ra = Math.ceil(Number(e.retryAfterMs) / 1000) || 30;
    return answer(await revert('throttled'), fail(429, 'throttled', { draftStatus: 'saved', retryAfterSec: ra }));
  }
  if (status === 404) {
    // Ambiguous: deleted, or an Outlook submit in flight. Never read as "not
    // sent"; the sweep looks for the Sent copy.
    const unk = await updateRow(row.id, { status: 'sending', lock }, unknownSet(hashes, 'not_found', row, ['not_found_after_send']));
    if (unk) opsLine('warn', 'send outcome unknown', row, 'sending->unknown graph=404');
    return answer(unk, fail(504, 'graph_timeout', { detail: 'the send outcome is not known yet', draftStatus: 'unknown' }));
  }
  // The Graph status and code as they came back (a 503 with a Retry-After is
  // still a 502 here: unlike a 429, it may have been accepted).
  const graphCode = status != null ? (e.graphCode || e.innerCode) : mapGraph(e).graphCode;
  if (status != null && status >= 400 && status < 500) {
    return answer(await revert(`graph_${status}`), fail(502, 'graph_error', { draftStatus: 'saved', graphStatus: status, graphCode }));
  }
  // A timeout, a 5xx or the network: it may have gone out.
  const unk = await updateRow(row.id, { status: 'sending', lock }, unknownSet(hashes, errLabel(e), row));
  if (unk) opsLine('warn', 'send outcome unknown', row, `sending->unknown ${errLabel(e)}`);
  if (e.kind === 'timeout') return answer(unk, fail(504, 'graph_timeout', { detail: 'the send outcome is not known yet', draftStatus: 'unknown' }));
  return answer(unk, fail(502, 'graph_error', { draftStatus: 'unknown', graphStatus: status, graphCode }));
}

// The registry status of the draft a request names, for an answer that has no
// row in hand (a key still in progress). Null when there is none.
async function draftStatusOf({ req, params }) {
  if (!params || !params.graphId) return null;
  const row = await findRow(callerOf(req), params.graphId);
  return row && row.status !== 'creating' ? row.status : null;
}

// ------------------------------------------------------------------ the sweep
// The CL2 DDL runs in the background after boot (index.js). If it could not
// complete (lock contention on email_accounts, say), the sweep tries again once
// this long has passed since the last attempt, and does nothing else that tick.
const CL2_SCHEMA_RETRY_MS = 5 * 60 * 1000;

let sweeping = false; // one tick at a time in this process
let lastPurgeAt = 0;

// The next post-send check: anchor + SCHEDULE[n] for the n-th check, hourly
// after the last offset, and never sooner than MIN_GAP_MS from now (a row
// whose slot has already passed is not worked again on the very next tick).
function nextSlot(row, now, anchor) {
  const count = (Number(row.check_count) || 0) + 1;
  const at = count < SCHEDULE.length ? anchor + SCHEDULE[count] : anchor + SCHEDULE[SCHEDULE.length - 1] * (count - SCHEDULE.length + 2);
  return { check_count: count, next_check_at: Math.max(at, now + MIN_GAP_MS) };
}

// One Graph token per account per tick, shared by that account's rows.
function tokenFor(accountId, ctx) {
  if (!ctx.tokens.has(accountId)) {
    const p = (async () => {
      const account = await db.one('SELECT * FROM email_accounts WHERE id = $1', [accountId]);
      if (!account) throw Object.assign(new Error('account missing'), { code: 'ACCOUNT_MISSING' });
      return gd.mintToken(account, { send: false });
    })();
    p.catch(() => {}); // awaited by each row; this only keeps an unawaited failure quiet
    ctx.tokens.set(accountId, p);
  }
  return ctx.tokens.get(accountId);
}

// A sweep write to a row it claimed: the claim's next_check_at fences it.
function sweepWrite(row, guard, set) {
  return updateRow(row.id, { nextCheckAt: row.next_check_at, ...guard }, set);
}

// The three-tier check of a sent row, given the Sent copy when one
// could be read:
//   1. the verify hash the send route wrote at its 202 (send_accepted_at set);
//   2. else, when the stored read-back is the one the client confirmed (content_hash =
//      confirm_hash), the verify hash stored with it;
//   3. else no compare is possible: `sent` + `unverified`, verified_at unset.
// verified_at is set only after an actual compare.
async function settleSent(row, live, ctx) {
  const now = ctx.now;
  let status = 'sent';
  let compared = false;
  const add = [];
  if (live) {
    const vhNow = gd.verifyHash(live.message, live.attachments);
    const tier1 = row.send_accepted_at != null && !!row.verify_hash;
    const tier2 = !tier1 && !!row.verify_hash && !!row.content_hash && row.content_hash === row.confirm_hash;
    if (tier1 || tier2) {
      compared = true;
      status = vhNow === row.verify_hash ? 'sent' : 'sent_mismatch';
    } else {
      add.push('unverified');
    }
  } else {
    add.push('unverified');
  }
  const f = live ? liveFields(live) : {};
  const done = await sweepWrite(row, { status: row.status }, {
    status, verified_at: compared ? now : null, internet_message_id: f.internetMessageId || row.internet_message_id,
    web_link: f.webLink || row.web_link, next_check_at: null, op_lock: null, op_lock_until: null, updated_at: now,
    addFlags: add, removeFlags: PENDING_FLAGS
  });
  if (!done) return;
  if (compared) ctx.summary.verified++;
  if (row.status === 'unknown') ctx.summary.reconciled++;
  if (status === 'sent_mismatch') opsLine('warn', 'sent content mismatch', row, `${row.status}->sent_mismatch`);
  else if (!compared) opsLine('warn', 'sent unverified', row, `${row.status}->sent`);
}

// A row still `creating` after 15 minutes. A draft Graph may have made is
// found by its id, or by its tag when the create's answer never arrived, and
// permanently deleted (guarded by isDraft).
async function sweepOrphan(row, ctx) {
  const { now } = ctx;
  if (now - Number(row.created_at) < ORPHAN_AFTER_MS) {
    await sweepWrite(row, { status: 'creating' }, { next_check_at: Number(row.created_at) + ORPHAN_AFTER_MS });
    return;
  }
  const token = await tokenFor(row.account_id, ctx);
  ctx.summary.orphans++;
  if (!row.graph_id) {
    const hit = await gd.findDraftByTag(token, row.id);
    if (!hit) {
      const done = await sweepWrite(row, { status: 'creating' }, {
        status: 'deleted', next_check_at: null, last_error: 'create_unconfirmed', updated_at: now, addFlags: ['create_unconfirmed']
      });
      if (done) opsLine('info', 'orphan create unconfirmed (no draft)', row, 'creating->deleted');
      return;
    }
    const outcome = hit.isDraft === true ? await gd.permanentDeleteIfDraft(token, hit.id, {}) : 'not_draft';
    if (outcome === 'not_draft') {
      // Already sent from Outlook: left in place, the Sent walk ingests it.
      const done = await sweepWrite(row, { status: 'creating' }, {
        status: 'sent_external', graph_id: hit.id, next_check_at: null, last_error: 'create_unconfirmed', updated_at: now,
        addFlags: ['create_unconfirmed']
      });
      if (done) opsLine('warn', 'orphan found sent', done, 'creating->sent_external');
      return;
    }
    const done = await sweepWrite(row, { status: 'creating' }, {
      status: 'deleted', next_check_at: null, last_error: 'create_unconfirmed', updated_at: now, addFlags: ['create_unconfirmed']
    });
    if (done) opsLine('warn', 'orphan create unconfirmed', { ...row, graph_id: hit.id }, 'creating->deleted');
    return;
  }
  const outcome = await gd.permanentDeleteIfDraft(token, row.graph_id, {});
  const to = outcome === 'not_draft' ? 'sent_external' : outcome === 'not_found' ? 'gone' : 'deleted';
  const done = await sweepWrite(row, { status: 'creating' }, { status: to, next_check_at: null, last_error: 'orphan', updated_at: now });
  if (!done) return;
  if (to === 'deleted') opsLine('info', 'orphan draft deleted', row, 'creating->deleted');
  else if (to === 'sent_external') opsLine('warn', 'orphan found sent', row, 'creating->sent_external');
}

// A `sending` row left by a process that stopped mid-send: its outcome is
// unknown. The hashes it carries stay for the check that follows.
async function sweepStaleSending(row, ctx) {
  const { now } = ctx;
  const started = num(row.send_started_at) || num(row.updated_at) || now;
  if (now - started < STALE_SENDING_MS) {
    await sweepWrite(row, { status: 'sending' }, { next_check_at: started + STALE_SENDING_MS });
    return;
  }
  const done = await sweepWrite(row, { status: 'sending' }, {
    status: 'unknown', op_lock: null, op_lock_until: null, next_check_at: now, check_count: 0,
    last_error: 'stale_sending', updated_at: now
  });
  if (done) {
    ctx.summary.staleSending++;
    opsLine('warn', 'send outcome unknown (stale)', row, 'sending->unknown');
  }
}

// An `unknown` send: settled from Graph, never by sending again.
async function sweepUnknown(row, ctx) {
  const { now } = ctx;
  const token = await tokenFor(row.account_id, ctx);
  if (Array.isArray(row.flags) && row.flags.includes('not_found_after_send')) return searchSentCopy(row, token, ctx);
  let live;
  try {
    live = await gd.readBack(token, row.graph_id);
  } catch (e) {
    if (!isNotFound(e)) throw e;
    // A not-found right after a send is not "not sent": look for the Sent copy.
    const flagged = await sweepWrite(row, { status: 'unknown' }, { addFlags: ['not_found_after_send'], last_error: 'not_found' });
    if (!flagged) return;
    return searchSentCopy(flagged, token, ctx);
  }
  const f = liveFields(live);
  if (!f.isDraft) return settleSent(row, live, ctx);
  if (movedOut(row, f)) {
    const done = await sweepWrite(row, { status: 'unknown' }, {
      status: 'gone', next_check_at: null, op_lock: null, op_lock_until: null, last_error: 'moved', updated_at: now
    });
    if (done) ctx.summary.reconciled++;
    return;
  }
  const started = num(row.send_started_at) || num(row.updated_at) || now;
  if (now - started >= UNKNOWN_HORIZON_MS) {
    // Still a draft half an hour on: it was not sent. Back to saved, flagged so
    // the client can show "check Outlook"; the clone does not send it again.
    const done = await sweepWrite(row, { status: 'unknown' }, {
      status: 'saved', op_lock: null, op_lock_until: null, next_check_at: null, updated_at: now,
      addFlags: ['send_status_unknown'], removeFlags: ['not_found_after_send']
    });
    if (done) {
      ctx.summary.reconciled++;
      opsLine('warn', 'send status unknown, reverted', row, 'unknown->saved');
    }
    return;
  }
  await sweepWrite(row, { status: 'unknown' }, nextSlot(row, now, started));
}

// A send that answered not-found (or whose reconcile read did) is
// settled only by finding its Sent copy, by Internet message id in Graph or as
// the clone's own outbound row. Not found by the horizon: still unknown,
// flagged; never `gone`.
async function searchSentCopy(row, token, ctx) {
  const { now } = ctx;
  ctx.summary.notFoundSearches++;
  const imid = stripBrackets(row.internet_message_id);
  if (imid) {
    const hits = ((await gd.searchByInternetMessageId(token, imid)) || []).filter((h) => h && h.isDraft === false);
    if (hits.length) {
      const pick = hits.find((h) => h.id === row.graph_id) || hits[0];
      const live = await gd.readBack(token, pick.id);
      return settleSent(row, live, ctx);
    }
    const own = await db.one(
      `SELECT 1 AS found FROM messages WHERE message_id = $1 AND account_id = $2 AND direction = 'outbound' LIMIT 1`,
      [imid, row.account_id]);
    if (own) return settleSent(row, null, ctx);
  }
  const started = num(row.send_started_at) || num(row.updated_at) || now;
  if (now - started < UNKNOWN_HORIZON_MS) {
    await sweepWrite(row, { status: 'unknown' }, nextSlot(row, now, started));
    return;
  }
  const first = !(Array.isArray(row.flags) && row.flags.includes('send_status_unknown'));
  const done = await sweepWrite(row, { status: 'unknown' }, {
    check_count: (Number(row.check_count) || 0) + 1,
    next_check_at: now - started >= STOP_CHECKING_MS ? null : now + HOUR,
    addFlags: ['send_status_unknown']
  });
  if (done && first) opsLine('warn', 'send status unknown', row, 'unknown');
}

// Post-send verification: the Sent copy is read and checked.
async function sweepVerify(row, ctx) {
  const { now } = ctx;
  const token = await tokenFor(row.account_id, ctx);
  let live = null;
  try {
    live = await gd.readBack(token, row.graph_id);
  } catch (e) {
    if (!isNotFound(e)) throw e;
  }
  if (live && live.message && live.message.isDraft === false) return settleSent(row, live, ctx);
  const accepted = num(row.send_accepted_at) || num(row.send_started_at) || now;
  if (now - accepted >= STOP_CHECKING_MS) {
    await sweepWrite(row, { status: 'sent_pending_verification' }, {
      check_count: (Number(row.check_count) || 0) + 1, next_check_at: null
    });
    return;
  }
  if (now - accepted >= VERIFY_OVERDUE_MS) {
    const first = !(Array.isArray(row.flags) && row.flags.includes('verify_overdue'));
    const done = await sweepWrite(row, { status: 'sent_pending_verification' }, {
      check_count: (Number(row.check_count) || 0) + 1, next_check_at: now + HOUR, addFlags: ['verify_overdue']
    });
    if (done && first) opsLine('warn', 'send verification overdue', row, 'sent_pending_verification');
    return;
  }
  await sweepWrite(row, { status: 'sent_pending_verification' }, nextSlot(row, now, accepted));
}

// A saved row read as not found was marked `gone` but rechecked: if the id
// reads as sent, or its Sent copy turns up, it was sent from Outlook after all.
// Every slot of GONE_RECHECK_AT runs unless one of them settles the row: a
// draft that reads as still in Drafts at +1 min may yet be sent from Outlook
// before +5 or +15.
async function sweepGoneRecheck(row, ctx) {
  const { now } = ctx;
  const token = await tokenFor(row.account_id, ctx);
  const g = await gd.getIsDraft(token, row.graph_id);
  const settle = (set) => sweepWrite(row, { status: 'gone' }, { next_check_at: null, removeFlags: ['gone_unconfirmed'], ...set });
  const count = (Number(row.check_count) || 0) + 1;
  const last = count >= GONE_RECHECK_AT.length;
  if (g && g.found && g.isDraft === false) {
    const done = await settle({ status: 'sent_external', updated_at: now });
    if (done) opsLine('info', 'gone draft found sent', row, 'gone->sent_external');
    return;
  }
  if (g && g.found) {
    // Still a draft. Moved out of Drafts: deleted after all, nothing to wait for.
    if (movedOut(row, { parentFolderId: g.parentFolderId || null })) {
      await settle({ check_count: count });
      return;
    }
    // Still in Drafts: the earlier not-found was transient. The row stays gone;
    // the remaining rechecks still run, and after the last one the line lets
    // the team look at the mailbox.
    if (last) {
      const done = await settle({ check_count: count });
      if (done) opsLine('warn', 'gone draft still in Drafts', row, 'gone');
      return;
    }
  } else {
    const imid = stripBrackets(row.internet_message_id);
    if (imid) {
      const hits = ((await gd.searchByInternetMessageId(token, imid)) || []).filter((h) => h && h.isDraft === false);
      const own = hits.length ? null : await db.one(
        `SELECT 1 AS found FROM messages WHERE message_id = $1 AND account_id = $2 AND direction = 'outbound' LIMIT 1`,
        [imid, row.account_id]);
      if (hits.length || own) {
        const done = await settle({ status: 'sent_external', updated_at: now });
        if (done) opsLine('info', 'gone draft found sent', row, 'gone->sent_external');
        return;
      }
    }
  }
  const anchor = num(row.updated_at) || now;
  await sweepWrite(row, { status: 'gone' }, {
    check_count: count,
    next_check_at: last ? null : Math.max(anchor + GONE_RECHECK_AT[count], now + MIN_GAP_MS)
  });
}

async function sweepRow(row, ctx) {
  switch (row.status) {
    case 'creating': return sweepOrphan(row, ctx);
    case 'sending': return sweepStaleSending(row, ctx);
    case 'unknown': return sweepUnknown(row, ctx);
    case 'sent_pending_verification': return sweepVerify(row, ctx);
    case 'gone':
      if (Array.isArray(row.flags) && row.flags.includes('gone_unconfirmed')) return sweepGoneRecheck(row, ctx);
      break;
    default:
      break;
  }
  // Nothing scheduled for this status.
  await sweepWrite(row, {}, { next_check_at: null });
  return undefined;
}

// A row whose check failed (Graph, the token, the database) is tried again in
// five minutes; the others in the tick go on.
async function retryLater(row, ctx, e) {
  const accountGone = e && e.code === 'ACCOUNT_MISSING';
  try {
    await sweepWrite(row, {}, {
      next_check_at: accountGone ? null : ctx.now + ERROR_RETRY_MS,
      last_error: accountGone ? 'account_missing' : errLabel(e)
    });
  } catch (e2) {
    console.error(`[outlook-drafts] unexpected sweep reschedule ${errLabel(e2)}`);
  }
  if (!isGraphError(e) && !accountGone) opsLine('error', `unexpected sweep ${errLabel(e)}`, row, row.status);
}

// Retention: expired idempotency keys, and drafts in a final state
// untouched for 90 days. scoped_tokens is never purged.
async function purgeIfDue(now, summary) {
  if (now - lastPurgeAt < PURGE_EVERY_MS) return;
  lastPurgeAt = now;
  for (let i = 0; i < PURGE_MAX_BATCHES; i++) {
    const r = await db.query(
      `DELETE FROM idempotency_keys WHERE (jti, route, idem_key) IN
         (SELECT jti, route, idem_key FROM idempotency_keys WHERE expires_at < $1 LIMIT ${PURGE_BATCH})`, [now]);
    summary.purged += r.rowCount;
    if (r.rowCount < PURGE_BATCH) break;
  }
  for (let i = 0; i < PURGE_MAX_BATCHES; i++) {
    const r = await db.query(
      `DELETE FROM outlook_drafts WHERE id IN
         (SELECT id FROM outlook_drafts WHERE status = ANY($1::text[]) AND updated_at < $2 LIMIT ${PURGE_BATCH})`,
      [FINAL_STATES, now - RETENTION_MS]);
    summary.purged += r.rowCount;
    if (r.rowCount < PURGE_BATCH) break;
  }
}

// One tick. Never throws (index.js calls it from a bare setInterval). Each due
// row is claimed by moving its next_check_at SWEEP_CLAIM_MS past the moment of
// the claim: while that holds, no other instance's tick picks the row up, and
// every write the sweep makes to the row is fenced on the claim value, so a
// claim taken over after it lapsed leaves the earlier holder's writes matching
// nothing. The sweep never calls /send.
//
// `now` is the tick's clock for every schedule it writes (the test harness
// moves it); the claim adds the wall-clock time the tick has taken so far, so a
// row claimed late in a slow tick still gets its full claim.
async function runOutlookDraftSweep({ now = Date.now() } = {}) {
  const summary = { schema: db.isCl2Ready(), orphans: 0, staleSending: 0, reconciled: 0,
    verified: 0, notFoundSearches: 0, purged: 0 };
  if (sweeping) return summary;
  sweeping = true;
  try {
    if (!db.isCl2Ready()) {
      if (now - db.cl2SchemaLastAttemptAt() >= CL2_SCHEMA_RETRY_MS) summary.schema = await db.ensureCl2Schema();
      return summary;
    }
    const due = await db.many(
      `SELECT id, next_check_at FROM outlook_drafts
        WHERE next_check_at IS NOT NULL AND next_check_at <= $1 ORDER BY next_check_at LIMIT ${SWEEP_BATCH}`, [now]);
    const ctx = { now, tokens: new Map(), summary };
    const t0 = Date.now();
    for (const seen of due) {
      const elapsed = Math.max(0, Date.now() - t0);
      if (elapsed > SWEEP_TICK_BUDGET_MS) break;
      let row = null;
      try {
        row = await db.one(
          `UPDATE outlook_drafts SET next_check_at = $3 WHERE id = $1 AND next_check_at = $2 RETURNING *`,
          [seen.id, seen.next_check_at, now + elapsed + SWEEP_CLAIM_MS]);
      } catch (e) {
        console.error(`[outlook-drafts] unexpected sweep claim ${errLabel(e)}`);
      }
      if (!row) continue;
      try {
        await sweepRow(row, ctx);
      } catch (e) {
        await retryLater(row, ctx, e);
      }
    }
    await purgeIfDue(now, summary);
    return summary;
  } catch (e) {
    console.error(`[outlook-drafts] unexpected sweep ${errLabel(e)}`);
    return summary;
  } finally {
    sweeping = false;
  }
}

module.exports = {
  createReplyDraft, createNewDraft, getDraft, recreateDraft, deleteDraft, sendDraft,
  draftStatusOf, runOutlookDraftSweep
};
