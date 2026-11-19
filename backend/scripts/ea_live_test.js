// Live checks of the Graph behaviour that Outlook drafts and send-by-id rely on.
// The team runs them on a TEST mailbox connected to the server, never on the
// principal's own mailbox, before EA_SEND_ENABLED is switched on. The results
// decide whether sending may be enabled (see the PR's runbook for the stop list).
//
//   railway run --service <server> node backend/scripts/ea_live_test.js \
//        --account <test account id> --confirm-email <its address> --step <L0..L14|all> [--yes-send]
//
// Every request goes through src/email/graph_drafts.js, so the checks exercise
// the exact request shapes the draft routes use, and the access token comes from
// src/oauth/microsoft.js as it does for the server. Rules the script enforces:
//   - it refuses to start unless --confirm-email equals the account's address;
//   - steps that send mail need --yes-send, and every mail it sends is addressed
//     to the test mailbox itself, except L11 (to --external);
//   - every subject starts with "[EA live test <run id>]";
//   - every draft it creates is deleted at the end of its step (two-part manual
//     steps leave theirs for the second half; --step cleanup removes them);
//   - it prints one JSON line per step on stdout (statuses, Graph error codes,
//     header values, booleans and counts; never a token, a body or an address),
//     and human-readable notes and instructions on stderr.
//
// Env: DATABASE_URL (to read the account), ENCRYPTION_KEY and MICROSOFT_* (to
// mint its token), DB_SCHEMA (default missive), DATABASE_SSL (as the server
// reads it). EA_LIVE_TEST_WAIT_MS sets the polling interval (default 5000 ms;
// 24 polls, so about two minutes). Exit codes: 0 every requested step ran, 2
// refused or usage, 1 a step failed unexpectedly.
//
// It never loads src/index.js (which starts the sync loop, the watchers and the
// dispatcher) and never runs db.init().
const crypto = require('crypto');
const { Client } = require('pg');

const USAGE = [
  'usage:',
  '  node backend/scripts/ea_live_test.js --account <id> --confirm-email <address> --step <step> [options]',
  '',
  '  --step           L0 L1 L1b L2 L3 L4 L5 L6 L7 L8 L9 L10 L11 L12 L13 L14, all, or cleanup',
  '                   (all = every automated step, plus the instructions for the manual ones)',
  '  --yes-send       required by every step that sends mail (L0, L1b, L2, L9, L10, L11, L12,',
  '                   the second half of L14, all, and L3-L6, which first run L0 for their parents)',
  '  --external      L11 only: an address the team controls outside the tenant',
  '  --graph-id       the draft (or Sent copy) of a two-part step: L7, L8, L14, cleanup',
  '  --note           free text recorded in the step\'s JSON result (what a human observed)',
  '',
  'env: DATABASE_URL, ENCRYPTION_KEY, MICROSOFT_* (as the server); DB_SCHEMA; EA_LIVE_TEST_WAIT_MS'
].join('\n');

const FLAGS = { account: 'value', 'confirm-email': 'value', step: 'value', 'yes-send': 'bool', external: 'value',
  'graph-id': 'value', note: 'value', help: 'bool' };
const STEP_NAMES = ['L0', 'L1', 'L1b', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9', 'L10', 'L11', 'L12', 'L13', 'L14'];
// Run by --step all, in this order; the manual steps only print instructions there.
const AUTO_STEPS = ['L0', 'L1', 'L1b', 'L2', 'L3', 'L4', 'L5', 'L6', 'L9', 'L10', 'L12'];
const MANUAL_STEPS = ['L7', 'L8', 'L11', 'L13', 'L14'];
const SENDING_STEPS = new Set(['L0', 'L1b', 'L2', 'L9', 'L10', 'L12']);
// Replies need the two parents L0 sends to the test mailbox.
const PARENT_STEPS = new Set(['L3', 'L4', 'L5', 'L6', 'L12']);
const TWO_PART = new Set(['L7', 'L8', 'L14', 'cleanup']);

const ACCOUNT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const GRAPH_ID_RE = /^[A-Za-z0-9_=-]{1,512}$/;
const ADDRESS_RE = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;
// A recipient that can never be delivered to (the .invalid TLD is reserved). L6
// only ever puts it on drafts that are deleted unsent.
const NOBODY = 'nobody@example.invalid';
// MAPI PR_MESSAGE_FLAGS; bit 0x4 is "submitted".
const PR_MESSAGE_FLAGS = 'Integer 0x0E07';
// A 1x1 PNG, the inline image of the HTML parent.
const DOT_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

const POLL_MS = Number(process.env.EA_LIVE_TEST_WAIT_MS) || 5000;
const POLLS = 24;

class Refusal extends Error {}

const say = (line) => process.stderr.write(`${line}\n`);
const emit = (result) => process.stdout.write(`${JSON.stringify(result)}\n`);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const shown = (v) => JSON.stringify(String(v).slice(0, 80).replace(/[^\x20-\x7e]/g, '?'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const enc = (id) => encodeURIComponent(String(id));
const odata = (s) => String(s).replace(/'/g, "''");
const bare = (v) => String(v == null ? '' : v).trim().replace(/^<|>$/g, '');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    let flag = argv[i];
    let value;
    const eq = flag.indexOf('=');
    if (flag.startsWith('--') && eq > 2) { value = flag.slice(eq + 1); flag = flag.slice(0, eq); }
    const name = flag.startsWith('--') ? flag.slice(2) : null;
    if (!name || !hasOwn(FLAGS, name)) {
      throw new Refusal(`unknown argument ${flag.startsWith('--') ? shown(flag) : '(a value without a flag)'}\n${USAGE}`);
    }
    if (hasOwn(out, name)) throw new Refusal(`--${name} given twice`);
    if (FLAGS[name] === 'bool') {
      if (value !== undefined) throw new Refusal(`--${name} takes no value`);
      out[name] = true;
    } else {
      if (value === undefined) { value = argv[i + 1]; i += 1; }
      if (value === undefined) throw new Refusal(`--${name} needs a value\n${USAGE}`);
      out[name] = value;
    }
  }
  return out;
}

function parseStep(v) {
  const s = String(v).trim();
  if (/^all$/i.test(s)) return 'all';
  if (/^cleanup$/i.test(s)) return 'cleanup';
  const hit = STEP_NAMES.find((n) => n.toLowerCase() === s.toLowerCase());
  if (!hit) throw new Refusal(`--step must be one of ${STEP_NAMES.join(' ')}, all or cleanup (got ${shown(s)})`);
  return hit;
}

// The server's DATABASE_SSL rule (src/db.js).
function sslOption() {
  const flag = (process.env.DATABASE_SSL || '').toLowerCase();
  if (flag === 'true') return { rejectUnauthorized: false };
  if (flag === 'false') return false;
  return process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false;
}
const SCHEMA = process.env.DB_SCHEMA || 'missive';
const QS = `"${SCHEMA.replace(/"/g, '""')}"`;

// Read-only: the one account row the token is minted from.
async function readAccount(accountId) {
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: sslOption(), connectionTimeoutMillis: 10000 });
  client.on('error', () => { /* a dropped connection fails the query in flight */ });
  await client.connect();
  try {
    await client.query(`SET statement_timeout = '15s'`);
    const { rows } = await client.query(
      `SELECT id, workspace_id, email, provider, oauth_refresh_token FROM ${QS}.email_accounts WHERE id = $1`, [accountId]);
    return rows[0] || null;
  } finally {
    await client.end().catch(() => {});
  }
}

// ────────────────────────────────────────────────────────────────────────
// The run
// ────────────────────────────────────────────────────────────────────────

function makeRun(gd, account, token, args) {
  const runId = crypto.randomBytes(3).toString('hex');
  const prefix = `[EA live test ${runId}]`;
  const self = account.email;
  const parentMarker = `EA-LIVE-PARENT-${runId}`;
  const run = { gd, token, prefix, runId, self, folders: null, parents: null, note: null, failed: false };
  if (args.note !== undefined) run.note = String(args.note).replace(/[^\x20-\x7e]/g, '?').slice(0, 200);

  // A raw request whose outcome is recorded rather than thrown.
  async function probe(method, path, opts = {}) {
    try {
      const r = await gd.graphCall(token, method, path, { expect: [200, 201, 202, 204], retryThrottle: false,
        retry503: false, op: 'live test', ...opts });
      return { status: r.status, json: r.json || {}, headers: r.headers };
    } catch (e) {
      if (e instanceof gd.GraphCallError) return { status: e.status, code: e.graphCode || e.innerCode || null, kind: e.kind, json: {} };
      throw e;
    }
  }
  const brief = (p) => {
    const o = { status: p.status };
    if (p.code) o.code = p.code;
    if (p.kind && p.kind !== 'http') o.kind = p.kind;
    return o;
  };
  // A GraphCallError as a status/code record; anything else is rethrown.
  const recorded = (e) => {
    if (e instanceof gd.GraphCallError) return { status: e.status, ...(e.graphCode ? { code: e.graphCode } : {}), ...(e.kind !== 'http' ? { kind: e.kind } : {}) };
    throw e;
  };

  async function folders() {
    if (run.folders) return run.folders;
    const out = {};
    for (const wk of ['inbox', 'drafts', 'sentitems', 'deleteditems']) {
      const r = await gd.graphCall(token, 'GET', `/me/mailFolders/${wk}?$select=id`, { op: 'folder id' });
      out[wk] = r.json && r.json.id;
    }
    run.folders = out;
    return out;
  }
  async function newSelfDraft(ctx, label, html) {
    const { id } = await gd.createNewDraft(token, { subject: `${prefix} ${label}`,
      html: html || `<p>EA live test ${runId}: ${label}.</p>`, to: [{ address: self }], cc: [], bcc: [], timezone: 'UTC' });
    ctx.created.push(id);
    return id;
  }
  async function readField(id, select, prefer) {
    const r = await gd.graphCall(token, 'GET', `/me/messages/${enc(id)}?$select=${select}`, { prefer, op: 'read' });
    return r.json || {};
  }
  const imidOf = async (id) => bare((await readField(id, 'id,internetMessageId')).internetMessageId);
  async function etagOf(id) {
    const m = await readField(id, 'id,changeKey');
    return m['@odata.etag'] || (m.changeKey ? `W/"${m.changeKey}"` : null);
  }
  // Every copy of a message by its RFC id (a wider $top than the routes use, to count).
  async function copiesOf(imid) {
    if (!imid) return [];
    const filter = `internetMessageId eq '<${odata(imid)}>'`;
    const r = await gd.graphCall(token, 'GET',
      `/me/messages?$filter=${encodeURIComponent(filter)}&$select=id,isDraft,parentFolderId&$top=10`, { op: 'copies' });
    return (r.json && Array.isArray(r.json.value)) ? r.json.value : [];
  }
  async function inboxCopies(imid) {
    const f = await folders();
    return (await copiesOf(imid)).filter((m) => m.parentFolderId === f.inbox && m.isDraft !== true);
  }
  async function pollUntil(fn) {
    for (let i = 1; i <= POLLS; i++) {
      const v = await fn(i);
      if (v) return { value: v, polls: i };
      await sleep(POLL_MS);
    }
    return { value: null, polls: POLLS };
  }
  // Until the immutable id reads isDraft=false (a 404 in between is the window
  // before the Sent copy exists, so it keeps polling).
  async function waitSent(id) {
    const r = await pollUntil(async () => {
      const g = await gd.getIsDraft(token, id);
      return g.found && g.isDraft === false ? g : null;
    });
    return { sent: !!r.value, polls: r.polls };
  }
  async function sendCapture(id, ifMatch) {
    try {
      const r = await gd.sendDraft(token, id, { ifMatch });
      return { status: r.status };
    } catch (e) { return recorded(e); }
  }
  // Removes the step's drafts, guarded: an item that was sent is left alone.
  async function cleanup(ctx) {
    const out = { deleted: 0, notDraft: 0, notFound: 0, failed: 0 };
    for (const id of ctx.created) {
      let res = null;
      try { res = await gd.permanentDeleteIfDraft(token, id); } catch {
        try { res = await gd.deleteIfDraft(token, id); } catch { res = null; }
      }
      if (res === 'deleted') out.deleted += 1;
      else if (res === 'not_draft') out.notDraft += 1;
      else if (res === 'not_found') out.notFound += 1;
      else out.failed += 1;
    }
    ctx.created = [];
    return out;
  }
  function requireParents() {
    if (!run.parents || !run.parents.html || !run.parents.text) {
      throw new Refusal('the L0 parents were not delivered to the Inbox, so the reply steps cannot run');
    }
    return run.parents;
  }
  const bodyOf = async (id) => gd.getBodyHtml(token, id);
  const addressesOf = (m, k) => (Array.isArray(m[k]) ? m[k] : []).map((r) => bare(r && r.emailAddress && r.emailAddress.address).toLowerCase());

  // ── L0: two self-addressed parents ───────────────────────────────────
  async function L0(ctx) {
    const f = await folders();
    const marker = `<p>${parentMarker}</p>`;
    const htmlId = await newSelfDraft(ctx, 'L0 parent (HTML)', `${marker}<p>HTML parent with an inline image.</p><p><img src="cid:ea-live-dot" alt="dot"></p>`);
    const att = await probe('POST', `/me/messages/${enc(htmlId)}/attachments`, { expect: [201, 200], body: {
      '@odata.type': '#microsoft.graph.fileAttachment', name: 'ea-live-dot.png', contentType: 'image/png',
      isInline: true, contentId: 'ea-live-dot', contentBytes: DOT_PNG } });
    const textRes = await gd.graphCall(token, 'POST', '/me/messages', { expect: [201, 200], op: 'create text parent', body: {
      subject: `${prefix} L0 parent (text)`, body: { contentType: 'Text', content: `${parentMarker}\r\nPlain-text parent.\r\nSecond line.` },
      toRecipients: [{ emailAddress: { address: self } }] } });
    const textId = textRes.json && textRes.json.id;
    ctx.created.push(textId);
    const out = { step: 'L0', inlineAttachment: brief(att) };
    run.parents = {};
    for (const [kind, id] of [['html', htmlId], ['text', textId]]) {
      const s = await sendCapture(id);
      const w = s.status >= 200 && s.status < 300 ? await waitSent(id) : { sent: false, polls: 0 };
      const imid = w.sent ? await imidOf(id) : null;
      const got = imid ? await pollUntil(async () => (await inboxCopies(imid))[0]) : { value: null, polls: 0 };
      out[kind] = { send: s, sent: w.sent, delivered: !!got.value, polls: got.polls };
      if (got.value) run.parents[kind] = { id: got.value.id, folderIsInbox: got.value.parentFolderId === f.inbox };
    }
    out.parentsReady = !!(run.parents.html && run.parents.text);
    return out;
  }

  // ── L1: If-Match on PATCH ────────────────────────────────────────────
  async function L1(ctx) {
    const id = await newSelfDraft(ctx, 'L1 If-Match on PATCH');
    const etagA = await etagOf(id);
    const first = await probe('PATCH', `/me/messages/${enc(id)}`, { body: { body: { contentType: 'HTML', content: '<p>L1 edit 1</p>' } } });
    const etagB = await etagOf(id);
    const stale = await probe('PATCH', `/me/messages/${enc(id)}`, { ifMatch: etagA, body: { body: { contentType: 'HTML', content: '<p>L1 edit 2</p>' } } });
    // The current tag, re-read so it is current whatever the stale PATCH did.
    const etagNow = await etagOf(id);
    const current = await probe('PATCH', `/me/messages/${enc(id)}`, { ifMatch: etagNow, body: { body: { contentType: 'HTML', content: '<p>L1 edit 3</p>' } } });
    const madeUp = await probe('PATCH', `/me/messages/${enc(id)}`, { ifMatch: 'W/"made-up"', body: { body: { contentType: 'HTML', content: '<p>L1 edit 4</p>' } } });
    const ok = (p) => p.status >= 200 && p.status < 300;
    let verdict = 'mixed';
    if (!ok(stale) && ok(current)) verdict = 'enforced';
    else if (ok(stale) && ok(current) && ok(madeUp)) verdict = 'ignored';
    else if (stale.status === 400 && current.status === 400) verdict = 'rejected';
    return { step: 'L1', plainPatch: brief(first), etagChangedByPatch: etagA !== etagB, staleTag: brief(stale),
      currentTag: brief(current), madeUpTag: brief(madeUp), patchIfMatch: verdict };
  }

  // ── L1b: If-Match on /send ───────────────────────────────────────────
  async function L1b(ctx) {
    // (a) a stale tag
    const a = await newSelfDraft(ctx, 'L1b(a) stale If-Match on send');
    const etagA = await etagOf(a);
    await gd.patchDraft(token, a, { html: '<p>L1b(a) edited after the tag was read</p>' });
    const sa = await sendCapture(a, etagA);
    const resA = { send: sa };
    if (sa.status >= 200 && sa.status < 300) {
      const w = await waitSent(a);
      const imid = w.sent ? await imidOf(a) : null;
      const got = imid ? await pollUntil(async () => (await inboxCopies(imid))[0]) : { value: null };
      resA.delivered = !!got.value;
    } else {
      const g = await gd.getIsDraft(token, a);
      resA.stillDraft = g.found && g.isDraft === true;
    }
    // (b) the current tag
    const b = await newSelfDraft(ctx, 'L1b(b) current If-Match on send');
    const etagB = await etagOf(b);
    const sb = await sendCapture(b, etagB);
    const resB = { send: sb };
    if (sb.status >= 200 && sb.status < 300) {
      const w = await waitSent(b);
      const imid = w.sent ? await imidOf(b) : null;
      const got = imid ? await pollUntil(async () => (await inboxCopies(imid))[0]) : { value: null };
      resB.delivered = !!got.value;
    }
    let verdict = 'other';
    if (sa.status >= 200 && sa.status < 300) verdict = 'ignored';
    else if (resA.stillDraft && sa.code === 'ErrorIrresolvableConflict') verdict = 'enforced';
    else if (sa.status === 400) verdict = 'rejected';
    return { step: 'L1b', a: resA, b: resB, sendIfMatch: verdict, currentTagAccepted: sb.status === 202 };
  }

  // ── L2: a second /send, and the window right after the 202 ───────────
  async function L2(ctx) {
    const f = await folders();
    const id = await newSelfDraft(ctx, 'L2 second send');
    const first = await sendCapture(id);
    const expand = encodeURIComponent(`singleValueExtendedProperties($filter=id eq '${PR_MESSAGE_FLAGS}')`);
    const look = await probe('GET', `/me/messages/${enc(id)}?$select=id,isDraft&$expand=${expand}`);
    const after = brief(look);
    if (look.status === 200) {
      after.isDraft = look.json.isDraft === true;
      const p = (look.json.singleValueExtendedProperties || []).find((x) => String(x.id).toLowerCase() === PR_MESSAGE_FLAGS.toLowerCase());
      const flags = p ? Number(p.value) : null;
      after.submittedBit = flags == null || Number.isNaN(flags) ? null : (flags & 4) !== 0;
    }
    let inWindow = { attempted: false };
    if (after.isDraft === true) inWindow = { attempted: true, ...(await sendCapture(id)) };
    const w = await waitSent(id);
    const afterSent = w.sent ? { attempted: true, ...(await sendCapture(id)) } : { attempted: false };
    // Let any second delivery arrive before counting.
    await sleep(POLL_MS * POLLS);
    const imid = w.sent ? await imidOf(id) : null;
    const copies = imid ? (await copiesOf(imid)).filter((m) => m.parentFolderId === f.inbox && m.isDraft !== true).length : null;
    if (w.sent) {
      const link = (await readField(id, 'id,webLink')).webLink;
      if (link) say(`L7 (manual): the Sent copy's webLink, to open in a new tab: ${link}`);
    }
    return { step: 'L2', firstSend: first, afterFirstSend: after, inWindowSecondSend: inWindow, sent: w.sent,
      secondSendAfterSent: afterSent, inboxCopies: copies, deliveredOnce: copies === 1 };
  }

  // ── L3: comment HTML, the splice, the draft tag ──────────────────────
  async function spliceCheck(ctx, parent) {
    const { id } = await gd.createReplyDraft(token, parent.id, { timezone: 'UTC' });
    ctx.created.push(id);
    const typed = await readField(id, 'id,body', gd.PREFER_RB);
    const before = (typed.body && typed.body.content) || '';
    const xMarker = `EA-LIVE-INSERT-${runId}`;
    await gd.patchDraft(token, id, { html: gd.spliceAfterBodyTag(before, `<p>${xMarker}</p>`) });
    const rb = await gd.readBack(token, id);
    const after = (rb.message.body && rb.message.body.content) || '';
    const at = after.indexOf(xMarker);
    return { bodyContentType: (typed.body && typed.body.contentType) || null, hasBodyTag: /<body\b/i.test(before),
      quoteBefore: before.includes(parentMarker), quoteAfter: after.includes(parentMarker), insertPresent: at >= 0,
      insertAboveQuote: at >= 0 && at < after.indexOf(parentMarker),
      inlineAttachments: rb.attachments.filter((x) => x.isInline === true).length };
  }
  async function L3(ctx) {
    const P = requireParents();
    // (a) HTML in the comment.
    const a = await probe('POST', `/me/messages/${enc(P.html.id)}/createReply`, { prefer: gd.preferFor({ timezone: 'UTC' }),
      body: { comment: '<p>a</p><p><b>b</b></p>' }, expect: [201, 200] });
    const resA = { create: brief(a) };
    if (a.json && a.json.id) {
      ctx.created.push(a.json.id);
      const html = await bodyOf(a.json.id);
      resA.comment = html.includes('<b>b</b>') ? 'rendered' : /&lt;\s*b\s*&gt;|&lt;p&gt;/i.test(html) ? 'escaped'
        : /a[\s\S]{0,40}b/.test(html.replace(/<[^>]*>/g, ' ')) ? 'flattened' : 'absent';
      resA.quotePresent = html.includes(parentMarker);
    }
    // (b) an empty comment, then the splice, on the HTML parent; (c) the same on the text parent.
    const b = await spliceCheck(ctx, P.html);
    const c = await spliceCheck(ctx, P.text);
    // (d) the draft tag on createReply, read back and found by request 8t.
    const tagValue = crypto.randomUUID();
    const d = {};
    let tagged = null;
    try {
      tagged = (await gd.createReplyDraft(token, P.html.id, { timezone: 'UTC', tag: gd.draftTagProp(tagValue) })).id;
      ctx.created.push(tagged);
      d.create = { status: 201 };
    } catch (e) { d.create = recorded(e); }
    if (tagged) {
      const expand = encodeURIComponent(`singleValueExtendedProperties($filter=id eq '${odata(gd.DRAFT_TAG_ID)}')`);
      const ex = await probe('GET', `/me/messages/${enc(tagged)}?$select=id,body&$expand=${expand}`, { prefer: gd.PREFER_RB });
      const props = ex.json.singleValueExtendedProperties || [];
      d.tagRoundTrip = props.some((p) => String(p.id).toLowerCase() === gd.DRAFT_TAG_ID.toLowerCase() && p.value === tagValue);
      d.quotePresent = !!(ex.json.body && String(ex.json.body.content || '').includes(parentMarker));
      const found = await gd.findDraftByTag(token, tagValue);
      d.foundByTag = !!found;
      d.sameId = !!found && found.id === tagged;
    }
    return { step: 'L3', a: resA, b, c, d };
  }

  // ── L4: timezone format; is IdType honoured on the combined header ───
  const sentLine = (html) => {
    const m = /Sent:\s*(?:<\/b>)?\s*([^<\r\n]*)/i.exec(html || '');
    return m ? m[1].trim() : null;
  };
  async function moveCheck(ctx, id) {
    const f = await folders();
    const idConfirmed = await gd.recheckCreatedId(token, id);
    const mv = await probe('POST', `/me/messages/${enc(id)}/move`, { body: { destinationId: f.deleteditems }, expect: [201, 200] });
    const after = await probe('GET', `/me/messages/${enc(id)}?$select=id,isDraft,parentFolderId`);
    return { idConfirmed, move: brief(mv), moveKeptId: !!(mv.json && mv.json.id === id),
      resolvesAfterMove: after.status === 200 && after.json.id === id, movedToTarget: after.json.parentFolderId === f.deleteditems };
  }
  async function L4(ctx) {
    const P = requireParents();
    const cases = [['windowsName', gd.preferFor({ timezone: 'America/New_York' })],
      ['ianaName', 'IdType="ImmutableId", outlook.timezone="America/New_York"'], ['noTimezone', gd.PREFER_IMM]];
    const out = { step: 'L4' };
    const lines = {};
    for (const [label, prefer] of cases) {
      const c = await probe('POST', `/me/messages/${enc(P.html.id)}/createReply`, { prefer, body: { comment: '' }, expect: [201, 200] });
      const r = { create: brief(c), preferenceApplied: (c.headers && c.headers.get('preference-applied')) || null };
      if (c.json && c.json.id) {
        ctx.created.push(c.json.id);
        lines[label] = sentLine(await bodyOf(c.json.id));
        r.sentLine = lines[label];
      }
      out[label] = r;
    }
    out.windowsDiffersFromDefault = lines.windowsName != null && lines.windowsName !== lines.noTimezone;
    out.ianaDiffersFromDefault = lines.ianaName != null && lines.ianaName !== lines.noTimezone;
    // An id made under the combined header must still resolve after a move.
    const { id } = await gd.createReplyDraft(token, P.html.id, { timezone: 'America/New_York' });
    ctx.created.push(id);
    out.combinedHeaderMove = await moveCheck(ctx, id);
    return out;
  }

  // ── L5: immutable ids as input, without the IdType header ────────────
  async function L5(ctx) {
    const P = requireParents();
    const c = await probe('POST', `/me/messages/${enc(P.html.id)}/createReply`, { prefer: null, body: { comment: '' }, expect: [201, 200] });
    const out = { step: 'L5', createWithoutIdType: brief(c) };
    if (c.json && c.json.id) {
      const imm = await probe('GET', `/me/messages/${enc(c.json.id)}?$select=id`, { prefer: gd.PREFER_IMM });
      const draftImm = imm.json && imm.json.id;
      out.createReturnedImmutableId = !!draftImm && draftImm === c.json.id;
      if (draftImm) {
        ctx.created.push(draftImm);
        out.getWithoutHeader = brief(await probe('GET', `/me/messages/${enc(draftImm)}?$select=id,isDraft`, { prefer: null }));
        out.patchWithoutHeader = brief(await probe('PATCH', `/me/messages/${enc(draftImm)}`, { prefer: null,
          body: { subject: `${prefix} L5 patched without IdType` } }));
        out.deleteWithoutHeader = brief(await probe('DELETE', `/me/messages/${enc(draftImm)}`, { prefer: null, expect: [204, 200] }));
      } else {
        ctx.created.push(c.json.id);
      }
    }
    // An id created with IdType alone (no timezone) must also survive a move.
    const io = await probe('POST', `/me/messages/${enc(P.html.id)}/createReply`, { prefer: gd.PREFER_IMM, body: { comment: '' }, expect: [201, 200] });
    out.idTypeOnlyCreate = brief(io);
    if (io.json && io.json.id) {
      ctx.created.push(io.json.id);
      out.idTypeOnlyMove = await moveCheck(ctx, io.json.id);
    }
    return out;
  }

  // ── L6: recipients on createReply and on PATCH: replace or merge ─────
  async function L6(ctx) {
    const P = requireParents();
    const classify = (m) => {
      const to = addressesOf(m, 'toRecipients');
      const hasDefault = to.includes(self.toLowerCase());
      const hasGiven = to.includes(NOBODY);
      return { toCount: to.length, hasDefault, hasGiven,
        behaviour: hasGiven && !hasDefault ? 'replace' : hasGiven && hasDefault ? 'merge' : hasGiven ? 'other' : 'ignored' };
    };
    const c = await probe('POST', `/me/messages/${enc(P.html.id)}/createReply`, { prefer: gd.preferFor({ timezone: 'UTC' }),
      body: { comment: '', message: { toRecipients: [{ emailAddress: { address: NOBODY } }] } }, expect: [201, 200] });
    const out = { step: 'L6', createWithRecipients: brief(c) };
    if (c.json && c.json.id) {
      ctx.created.push(c.json.id);
      Object.assign(out.createWithRecipients, classify(await readField(c.json.id, 'id,toRecipients')));
    }
    const { id } = await gd.createReplyDraft(token, P.html.id, { timezone: 'UTC' });
    ctx.created.push(id);
    await gd.patchDraft(token, id, { to: [{ address: NOBODY }] });
    out.patchRecipients = classify(await readField(id, 'id,toRecipients'));
    out.patchReplaces = out.patchRecipients.behaviour === 'replace';
    return out;
  }

  // ── L9: internetMessageId stability ──────────────────────────────────
  async function L9(ctx) {
    const id = await newSelfDraft(ctx, 'L9 internetMessageId');
    const atCreate = await imidOf(id);
    await gd.patchDraft(token, id, { html: '<p>L9 edited</p>' });
    const afterPatch = await imidOf(id);
    const rb = await gd.readBack(token, id);
    const onRead = bare(rb.message.internetMessageId);
    const s = await sendCapture(id, rb.message['@odata.etag']);
    const w = s.status >= 200 && s.status < 300 ? await waitSent(id) : { sent: false };
    const onSent = w.sent ? await imidOf(id) : null;
    const got = onSent ? await pollUntil(async () => (await inboxCopies(onSent))[0]) : { value: null };
    return { step: 'L9', presentAtCreate: !!atCreate, stableAfterPatch: atCreate === afterPatch, stableOnRead: afterPatch === onRead,
      send: s, sentCopySameImmutableId: w.sent, stableOnSentCopy: onSent != null && onSent === onRead, inboxCopyFound: !!got.value };
  }

  // ── L10: delete semantics; move vs purge; permanentDelete ────────────
  async function L10(ctx) {
    const f = await folders();
    const out = { step: 'L10' };
    // (a) a plain DELETE of a draft.
    const a = await newSelfDraft(ctx, 'L10(a) plain delete');
    const imidA = await imidOf(a);
    out.a = { delete: await gd.deleteIfDraft(token, a) };
    const ga = await gd.getIsDraft(token, a);
    Object.assign(out.a, { stillResolves: ga.found, isDraft: ga.found ? ga.isDraft : null,
      inDeletedItems: ga.found ? ga.parentFolderId === f.deleteditems : null,
      foundInDeletedItemsBySearch: (await copiesOf(imidA)).some((m) => m.parentFolderId === f.deleteditems) });
    // (b) a plain DELETE of a sent item (the test mailbox's own Sent copy).
    const b = await newSelfDraft(ctx, 'L10(b) delete after send');
    const sb = await sendCapture(b);
    const wb = sb.status >= 200 && sb.status < 300 ? await waitSent(b) : { sent: false };
    out.b = { send: sb, sent: wb.sent };
    if (wb.sent) {
      out.b.guardOnSentItem = await gd.permanentDeleteIfDraft(token, b);
      out.b.delete = brief(await probe('DELETE', `/me/messages/${enc(b)}`, { expect: [204, 200] }));
      const gb = await gd.getIsDraft(token, b);
      Object.assign(out.b, { stillResolves: gb.found, inDeletedItems: gb.found ? gb.parentFolderId === f.deleteditems : null });
    }
    // (c) permanentDelete, guarded, on a fresh draft.
    const c = await newSelfDraft(ctx, 'L10(c) permanent delete');
    try { out.c = { permanentDelete: await gd.permanentDeleteIfDraft(token, c) }; } catch (e) { out.c = { permanentDelete: recorded(e) }; }
    out.c.readAfter = brief(await probe('GET', `/me/messages/${enc(c)}?$select=id,isDraft`));
    // (c2) permanentDelete with a stale If-Match.
    const c2 = await newSelfDraft(ctx, 'L10(c2) permanent delete, stale If-Match');
    const stale = await etagOf(c2);
    await gd.patchDraft(token, c2, { html: '<p>L10(c2) edited after the tag was read</p>' });
    try { out.c2 = { staleTagPermanentDelete: await gd.permanentDeleteIfDraft(token, c2, { ifMatch: stale }) }; } catch (e) {
      out.c2 = { staleTagPermanentDelete: recorded(e) };
    }
    out.c2.readAfter = brief(await probe('GET', `/me/messages/${enc(c2)}?$select=id,isDraft`));
    return out;
  }

  // ── L12: hash stability, draft vs Sent copy ──────────────────────────
  async function L12(ctx) {
    const P = requireParents();
    const tagValue = crypto.randomUUID();
    const { id } = await gd.createReplyDraft(token, P.html.id, { timezone: 'UTC', tag: gd.draftTagProp(tagValue) });
    ctx.created.push(id);
    const idConfirmed = await gd.recheckCreatedId(token, id);
    const bodyHtml = `<p>EA live test ${runId}: L12 reply.</p>`;
    gd.assertInsertSafe(bodyHtml, { field: 'bodyHtml' });
    const before = await bodyOf(id);
    await gd.patchDraft(token, id, { html: gd.spliceAfterBodyTag(before, `<div>${bodyHtml}</div><div><br></div>`),
      to: [{ address: self }], cc: [], bcc: [] });
    const r1 = await gd.readBack(token, id);
    const r2 = await gd.readBack(token, id);
    const readBackStable = gd.contentHash(r1.message, r1.attachments) === gd.contentHash(r2.message, r2.attachments);
    const vDraft = gd.verifyHash(r2.message, r2.attachments);
    const fDraft = gd.hashFields(r2.message, r2.attachments);
    const s = await sendCapture(id, r2.message['@odata.etag'] || `W/"${r2.message.changeKey}"`);
    const w = s.status >= 200 && s.status < 300 ? await waitSent(id) : { sent: false };
    const out = { step: 'L12', idConfirmed, readBackStable, send: s, sent: w.sent };
    if (w.sent) {
      const r3 = await gd.readBack(token, id);
      const fSent = gd.hashFields(r3.message, r3.attachments);
      out.sentVerifyEqual = gd.verifyHash(r3.message, r3.attachments) === vDraft;
      out.differingFields = Object.keys(fDraft).filter((k) => JSON.stringify(fDraft[k]) !== JSON.stringify(fSent[k]));
    }
    return out;
  }

  // ── Manual steps: the automated half ─────────────────────────────────
  async function L7(ctx) {
    if (args['graph-id']) {
      const m = await readField(args['graph-id'], 'id,isDraft,webLink');
      if (m.webLink) say(`L7: webLink of ${args['graph-id']} (open it in a new tab, never inside a frame): ${m.webLink}`);
      return { step: 'L7', part: 'b', isDraft: m.isDraft === true, webLinkPresent: !!m.webLink };
    }
    const id = await newSelfDraft(ctx, 'L7 webLink');
    ctx.keep = true;
    const m = await readField(id, 'id,webLink');
    say(`L7: draft ${id}`);
    say(`L7: webLink (open it in a new tab, never inside a frame; note compose view or read view): ${m.webLink}`);
    say(`L7: record what you saw: --step L7 --graph-id ${id} --note "<compose or read view>"; then --step cleanup --graph-id ${id}`);
    return { step: 'L7', part: 'a', webLinkPresent: !!m.webLink };
  }
  async function L8(ctx) {
    if (args['graph-id']) {
      const rb = await gd.readBack(token, args['graph-id']);
      return { step: 'L8', part: 'b', isDraft: rb.message.isDraft === true, changeKey: rb.message.changeKey || null,
        contentHash: gd.contentHash(rb.message, rb.attachments) };
    }
    const id = await newSelfDraft(ctx, 'L8 changeKey on open');
    ctx.keep = true;
    const rb = await gd.readBack(token, id);
    say(`L8: draft ${id}`);
    say(`L8: webLink: ${rb.message.webLink}`);
    say(`L8: open it in Outlook on the web and in desktop Outlook without editing, close it, then run --step L8 --graph-id ${id}`);
    say('L8: and compare changeKey and contentHash with this step\'s JSON line; add a category in Outlook and run it again;');
    say(`L8: finally --step cleanup --graph-id ${id}`);
    return { step: 'L8', part: 'a', changeKey: rb.message.changeKey || null, contentHash: gd.contentHash(rb.message, rb.attachments) };
  }
  async function L11(ctx) {
    const marker = `EA-LIVE-SIGNATURE-CHECK-${runId}`;
    const { id } = await gd.createNewDraft(token, { subject: `${prefix} L11 signature check`,
      html: `<p>${marker}</p><p>This test message carries no signature.</p>`, to: [{ address: args.external }], cc: [], bcc: [], timezone: 'UTC' });
    ctx.created.push(id);
    const s = await sendCapture(id);
    const w = s.status >= 200 && s.status < 300 ? await waitSent(id) : { sent: false };
    say(`L11: sent "${prefix} L11 signature check" (marker ${marker}) to the external address.`);
    say('L11: check the received copy for any added signature or disclaimer, and have an admin review the');
    say('L11: outbound mail-flow / transport rules; then run the read-only SQL from the L11 instructions.');
    return { step: 'L11', send: s, sent: w.sent };
  }
  async function L14(ctx) {
    if (!args['graph-id']) {
      const id = await newSelfDraft(ctx, 'L14 open compose window');
      ctx.keep = true;
      const m = await readField(id, 'id,webLink');
      say(`L14: draft ${id}`);
      say(`L14: webLink: ${m.webLink}`);
      say(`L14: open it in a compose window (Outlook on the web or desktop) and leave it open, then run --step L14 --graph-id ${id} --yes-send`);
      return { step: 'L14', part: 'a', webLinkPresent: !!m.webLink };
    }
    const id = args['graph-id'];
    const f = await folders();
    const m = await readField(id, 'id,isDraft,subject');
    if (m.isDraft !== true) throw new Refusal('L14: --graph-id is not a draft');
    if (!String(m.subject || '').startsWith('[EA live test ')) throw new Refusal('L14: --graph-id is not a draft this script created');
    const listSame = async (wk) => {
      const r = await probe('GET', `/me/mailFolders/${wk}/messages?$select=id,subject&$top=50&$orderby=lastModifiedDateTime%20desc`);
      if (r.status !== 200) return { list: brief(r), ids: [] };
      return { list: brief(r), ids: (r.json.value || []).filter((x) => x.subject === m.subject).map((x) => x.id) };
    };
    const before = { drafts: await listSame('drafts'), sent: await listSame('sentitems') };
    const imidBefore = await imidOf(id);
    const s = await sendCapture(id);
    const w = s.status >= 200 && s.status < 300 ? await waitSent(id) : { sent: false };
    await sleep(POLL_MS * POLLS);
    const after = { drafts: await listSame('drafts'), sent: await listSame('sentitems') };
    const imid = w.sent ? await imidOf(id) : imidBefore;
    const copies = (await copiesOf(imid)).filter((x) => x.parentFolderId === f.inbox && x.isDraft !== true).length;
    const fresh = (k) => after[k].ids.filter((x) => x !== id && !before[k].ids.includes(x)).length;
    return { step: 'L14', part: 'b', send: s, sent: w.sent, inboxCopies: copies, newDraftItems: fresh('drafts'),
      newSentItems: fresh('sent'), listing: { drafts: after.drafts.list, sent: after.sent.list } };
  }
  async function cleanupStep() {
    const id = args['graph-id'];
    const m = await readField(id, 'id,isDraft,subject');
    if (!String(m.subject || '').startsWith('[EA live test ')) throw new Refusal('cleanup: --graph-id is not an item this script created');
    const res = await gd.permanentDeleteIfDraft(token, id);
    return { step: 'cleanup', result: res };
  }

  run.steps = { L0, L1, L1b, L2, L3, L4, L5, L6, L7, L8, L9, L10, L11, L12, L14, cleanup: cleanupStep };
  run.cleanup = cleanup;
  return run;
}

// Instructions for the manual steps (and for --step all, which only prints them).
function instructions(step, schema) {
  const s = {
    L7: ['L7 (webLink; manual): --step L7 creates a self-addressed draft and prints its webLink. Open the link in a new',
      '  browser tab (never inside a frame) and note whether Outlook shows the compose view or the read view. Open the',
      '  Sent copy link that L2 prints as well. Record what you saw with --step L7 --graph-id <id> --note "<text>",',
      '  then remove the draft with --step cleanup --graph-id <id>.'],
    L8: ['L8 (changeKey on open; manual): --step L8 creates a draft and prints its changeKey and contentHash. Open it in',
      '  Outlook on the web and in desktop Outlook without editing, close it, run --step L8 --graph-id <id> and compare',
      '  both values. Add a category in Outlook and run it again. Remove it with --step cleanup --graph-id <id>.'],
    L11: ['L11 (added signature or disclaimer; manual): --step L11 --external <address> --yes-send sends one mail with a',
      '  marker and no signature from the test mailbox to a mailbox the team controls outside the tenant. Check the',
      '  received copy for an added signature or disclaimer, and have an admin review the outbound mail-flow / transport',
      '  rules. Then read, without changing anything:',
      `    SELECT email, length(signature_text), length(signature_html), ea_append_signature FROM ${schema}.email_accounts`,
      '      WHERE id = \'<the principal\'s account id>\';',
      '  If a signature or disclaimer is added in transit, set ea_append_signature = false for that account.'],
    L13: ['L13 (routes end to end; manual): with this build deployed, set EA_SEND_ENABLED=<test account id> and restart.',
      '  Mint a read,draft token and a send token for the test account with backend/scripts/mint_scoped_token.js. Then',
      '  POST /api/threads/<thread id>/outlook-draft, GET /api/outlook-drafts/<graphId>, POST /api/outlook-drafts/',
      '  <graphId>/send with that contentHash, and poll the GET until status is "sent". Afterwards unset',
      '  EA_SEND_ENABLED, restart, and revoke both tokens with backend/scripts/revoke_scoped_token.js.'],
    L14: ['L14 (a compose window left open; manual): --step L14 creates a self-addressed draft and prints its webLink.',
      '  Open it in a compose window (Outlook on the web or desktop) and leave it open, then run',
      '  --step L14 --graph-id <id> --yes-send: it sends the draft, waits, counts the delivered copies and the new',
      '  items with the same subject in Drafts and Sent Items (a re-save or re-send from Outlook makes a new item).']
  };
  return s[step] || [];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { say(USAGE); return 0; }
  if (args.account === undefined || args['confirm-email'] === undefined || args.step === undefined) {
    throw new Refusal(`--account, --confirm-email and --step are required\n${USAGE}`);
  }
  const accountId = String(args.account);
  if (!ACCOUNT_ID_RE.test(accountId)) throw new Refusal(`--account: not an account id: ${shown(accountId)}`);
  const step = parseStep(args.step);
  if (args['graph-id'] !== undefined) {
    if (!TWO_PART.has(step)) throw new Refusal('--graph-id is for L7, L8, L14 and cleanup only');
    if (!GRAPH_ID_RE.test(String(args['graph-id']))) throw new Refusal(`--graph-id: not a Graph id: ${shown(args['graph-id'])}`);
  } else if (step === 'cleanup') {
    throw new Refusal('--step cleanup needs --graph-id');
  }
  if (args.external !== undefined) {
    if (step !== 'L11') throw new Refusal('--external is for L11 only');
    if (!ADDRESS_RE.test(String(args.external))) throw new Refusal(`--external: not an address: ${shown(args.external)}`);
  }
  const sends = step === 'all' || SENDING_STEPS.has(step) || PARENT_STEPS.has(step)
    || (step === 'L14' && args['graph-id'] !== undefined) || (step === 'L11' && args.external !== undefined);
  if (sends && !args['yes-send']) {
    throw new Refusal(`--step ${step} sends mail (to the test mailbox itself${step === 'L11' ? ', and to --external' : ''}); re-run with --yes-send`);
  }
  if (!process.env.DATABASE_URL) throw new Refusal('DATABASE_URL is not set');

  const account = await readAccount(accountId);
  if (!account) throw new Refusal(`unknown account ${shown(accountId)}`);
  const confirm = String(args['confirm-email']).trim().toLowerCase();
  if (!account.email || String(account.email).trim().toLowerCase() !== confirm) {
    throw new Refusal('--confirm-email does not match the account\'s address; nothing was done');
  }
  if (account.provider !== 'microsoft' || !account.oauth_refresh_token) {
    throw new Refusal('the account is not a connected Microsoft mailbox');
  }
  if (step === 'L13' || (step === 'L11' && args.external === undefined)) {
    for (const l of instructions(step, SCHEMA)) say(l);
    return 0;
  }

  // Loaded only now: src/db.js (through the token code) reads DATABASE_URL at load.
  const gd = require('../src/email/graph_drafts');
  const db = require('../src/db');
  try {
    const token = await gd.mintToken(account, { send: sends });
    const run = makeRun(gd, account, token, args);
    say(`EA live test run ${run.runId} on ${account.email}: subjects start with "${run.prefix}"`);
    const plan = step === 'all' ? AUTO_STEPS
      : (PARENT_STEPS.has(step) ? ['L0', step] : [step]);
    for (const name of plan) {
      const ctx = { created: [], keep: false };
      say(`${name}: running`);
      let result;
      try {
        result = await run.steps[name](ctx);
      } catch (e) {
        // A refused second half (the id is not this script's draft) changes nothing: exit 2.
        if (e instanceof Refusal && (name === 'L14' || name === 'cleanup')) throw e;
        run.failed = true;
        result = e instanceof Refusal ? { step: name, skipped: e.message } : { step: name, error: e instanceof gd.GraphCallError
          ? { kind: e.kind, status: e.status, code: e.graphCode || e.innerCode || null, op: e.op }
          : { name: (e && (e.code || e.name)) || 'error' } };
      }
      if (!ctx.keep && ctx.created.length) result.cleanup = await run.cleanup(ctx);
      if (run.note) result.note = run.note;
      emit(result);
      say(`${name}: done`);
    }
    if (step === 'all') {
      say('');
      say('Manual steps (run each as its own --step):');
      for (const name of MANUAL_STEPS) for (const l of instructions(name, SCHEMA)) say(l);
    }
    if (plan.some((n) => SENDING_STEPS.has(n))) {
      say(`The sent test mail ("${run.prefix} ...") stays in the test mailbox's Inbox and Sent Items; delete it when done.`);
    }
    return run.failed ? 1 : 0;
  } finally {
    if (db.pool) await db.pool.end().catch(() => {});
  }
}

main().then(
  (code) => { process.exitCode = code; },
  (e) => {
    if (e instanceof Refusal) {
      say(`refused: ${e.message}`);
      process.exitCode = 2;
    } else {
      say(`error: ${(e && (e.code || e.name)) || 'error'}${e && e.kind ? ` (${e.kind}${e.status ? ` ${e.status}` : ''})` : ''}`);
      process.exitCode = 1;
    }
  }
);
