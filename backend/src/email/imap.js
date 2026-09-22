const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { v4: uuid } = require('uuid');
const crypto = require('crypto');
const { one, many, query, tx, txLocked } = require('../db');
const { decrypt } = require('../crypto');
const { emitToWorkspace } = require('../sockets');
const ms = require('../oauth/microsoft');

// Per-account live IMAP IDLE clients. Map key is account id.
const watchers = new Map();
// Per-account exponential-backoff state for the self-healing reconnect.
// Tracked separately from `watchers` so a queued retry can be cancelled
// when stopWatching() is called.
const retryState = new Map();

// DD webhook target. Read once at module load — set on Railway as
// WEBHOOK_URL=https://<dd-host>/api/missive-webhook. Both env vars
// must be present or we skip silently (keeps local dev working).
const WEBHOOK_URL = process.env.WEBHOOK_URL || null;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || null;

// Fire-and-forget webhook to DD when a new message lands. Non-blocking:
// ingest must complete even if DD is down. Polling on the DD side is
// the backstop, so we don't retry on failure — just log.
//
// Logging is intentionally loud — silent "ingest works but DD never
// notified" used to be the worst class of bug here. Now every call
// logs config state, request status, and any non-2xx response so a
// glance at Railway logs tells you whether the link is alive.
function fireWebhook(event, payload) {
  if (!WEBHOOK_URL || !WEBHOOK_SECRET) {
    console.warn('[webhook] skipped — missing env', {
      event,
      hasUrl: !!WEBHOOK_URL,
      hasSecret: !!WEBHOOK_SECRET,
      account_id: payload && payload.account_id
    });
    return;
  }
  const body = JSON.stringify({ event, ts: Date.now(), ...payload });
  const sig = crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
  fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Missive-Signature': sig
    },
    body
  }).then(async (res) => {
    if (!res.ok) {
      // 401 here = DD's MISSIVE_WEBHOOK_SECRET doesn't match WEBHOOK_SECRET.
      // Reading the body up to 200 chars to surface the DD error message.
      const text = await res.text().catch(() => '');
      console.warn('[webhook] non-2xx from DD', {
        event,
        status: res.status,
        account_id: payload && payload.account_id,
        body: text.slice(0, 200)
      });
    } else {
      console.log('[webhook] delivered', {
        event,
        status: res.status,
        account_id: payload && payload.account_id
      });
    }
  }).catch((err) => {
    console.warn('[webhook] fire failed (network)', event, err && err.message);
  });
}

function getAccount(id) {
  return one('SELECT * FROM email_accounts WHERE id = $1', [id]);
}

// Mirrors SMTP_TIMEOUTS in smtp.js. socketTimeout applies only to transient
// sync/append clients — the long-lived IDLE watcher keeps imapflow's 5-min
// default (it recovers IDLE via NOOP on timeout; a short value would churn it).
const IMAP_TIMEOUTS = {
  connectionTimeout: 20 * 1000,
  greetingTimeout:   20 * 1000,
  socketTimeout:     60 * 1000
};

// imapflow's emitError() emits 'error' on the client for any post-connect
// socket failure (TCP/TLS timeout, RST). With zero 'error' listeners Node
// rethrows it as an uncaughtException — exactly what the listener-less
// transient sync/append clients were doing on outlook.office365.com socket
// timeouts. The IDLE watcher attaches its own onDead handler; this guard
// covers every other (transient) client so no socket error can crash the process.
function attachErrorGuard(client, acc) {
  client.on('error', (err) => {
    console.warn('[imap] client error for', acc.email, '-', err && err.message);
  });
}

async function buildClient(acc, { idle = false } = {}) {
  // socketTimeout only on transient clients; IDLE watcher keeps the 5-min default.
  const timeouts = {
    connectionTimeout: IMAP_TIMEOUTS.connectionTimeout,
    greetingTimeout: IMAP_TIMEOUTS.greetingTimeout,
    ...(idle ? {} : { socketTimeout: IMAP_TIMEOUTS.socketTimeout })
  };
  let client;
  if (acc.provider === 'microsoft') {
    const accessToken = await ms.ensureFreshAccessToken(acc);
    client = new ImapFlow({
      host: acc.imap_host || 'outlook.office365.com',
      port: acc.imap_port || 993,
      secure: true,
      auth: { user: acc.email, accessToken },
      logger: false,
      ...timeouts
    });
  } else {
    client = new ImapFlow({
      host: acc.imap_host,
      port: acc.imap_port,
      secure: !!acc.imap_secure,
      auth: { user: acc.imap_user, pass: decrypt(acc.imap_pass) },
      logger: false,
      ...timeouts
    });
  }
  // The IDLE watcher owns its own error handling (onDead) and reconnect backoff,
  // so only guard transient clients here to avoid duplicate 'error' logging.
  if (!idle) attachErrorGuard(client, acc);
  return client;
}

function normalizeAddrList(list) {
  if (!list) return '';
  if (Array.isArray(list)) return list.map(a => a.text || `${a.name || ''} <${a.address || ''}>`).join(', ');
  return list.text || '';
}

// Every email address in an address field, lower-cased. Three shapes reach this:
// mailparser's { text, value: [{ address }] }, mailparser's ARRAY of those (it
// returns one per header when a message carries duplicate To:/Cc: lines — the
// reason normalizeAddrList above has an array branch), and the Graph path's
// { text } with no `value` at all.
//
// Structured `value` is strongly preferred over scraping the text: a rendered
// address list is full of display names, and those routinely contain addresses
// that are NOT recipients — `"support@x.com via Zendesk" <notifications@x.com>`
// would otherwise contribute support@x.com as a real correspondent.
const ADDR_RE = /[\w.!#$%&'*+/=?^`{|}~-]+@[\w-]+(?:\.[\w-]+)+/g;

function addressesOf(field) {
  if (!field) return [];
  // Duplicate-header array: recurse, so each element goes through the same
  // value-then-text preference instead of being silently skipped.
  if (Array.isArray(field)) return [...new Set(field.flatMap(addressesOf))];

  if (Array.isArray(field.value) && field.value.length) {
    const out = field.value
      .map((v) => v && v.address)
      .filter(Boolean)
      .map((a) => String(a).toLowerCase());
    if (out.length) return [...new Set(out)];
  }
  // No structured value (the Graph path builds `{ text }` only). Split the list
  // first, then take each entry's <angle-bracketed> address when it has one and
  // scrape the whole entry when it doesn't — a rendered list legitimately mixes
  // `Name <addr>` and bare `addr`, so handling only one form drops recipients.
  // Splitting per entry is also what keeps a display name from contributing:
  // in `"support@x.com via Zendesk" <notifications@x.com>` only the bracketed
  // address counts.
  const out = [];
  for (const entry of String(field.text || '').split(/[,;]+/)) {
    const angled = entry.match(/<([^>]*)>/);
    const source = angled ? angled[1] : entry;
    for (const m of source.matchAll(ADDR_RE)) out.push(m[0].toLowerCase());
  }
  return [...new Set(out)];
}

// Match an address inside a comma-joined "Name <addr>" list without matching a
// longer address that merely contains it. A plain LIKE '%addr%' is far too
// loose here: `%ann@acme.com%` hits "Jo Ann" <joann@acme.com>, and
// `%info@acme.com%` hits info@acme.com.br. Anchoring on characters that can't
// appear adjacent in a real address fixes both. Regex metacharacters in the
// address (dots, +) are escaped so they can't alter the pattern.
// Lower-cased addresses of every mailbox connected in a workspace. Cached
// briefly because resolveThread runs once per ingested message and a full
// folder walk can be thousands — this must not become a query per message. The
// set only changes when someone connects or disconnects a mailbox, so a short
// TTL is plenty; a stale entry just means one message uses the previous set.
const ACCOUNT_EMAIL_TTL_MS = 60_000;
const accountEmailCache = new Map(); // workspace_id -> { at, emails:Set }

async function workspaceAccountEmails(workspace_id) {
  const hit = accountEmailCache.get(workspace_id);
  if (hit && Date.now() - hit.at < ACCOUNT_EMAIL_TTL_MS) return hit.emails;
  try {
    const rows = await many(
      `SELECT email FROM email_accounts WHERE workspace_id = $1`,
      [workspace_id]
    );
    const emails = new Set(
      rows.map((r) => String(r.email || '').toLowerCase()).filter(Boolean)
    );
    accountEmailCache.set(workspace_id, { at: Date.now(), emails });
    return emails;
  } catch {
    // Never let this block ingest — worst case we treat a sibling mailbox as a
    // counterparty, which is the behaviour we had before this refinement.
    return hit ? hit.emails : new Set();
  }
}

function addressBoundaryPattern(addr) {
  const esc = addr.replace(/[.^$*+?()[\]{}|\\]/g, '\\$&');
  return `(^|[^a-z0-9!#$%&'*+/=?^_\`{|}~.-])${esc}($|[^a-z0-9.-])`;
}

// Decide which thread an incoming message belongs to. Write-free: returns
// { threadId } for an existing thread, or { newThread } describing one to create
// (see the tail of this function for why the INSERT lives in ingestMessage).
async function resolveThread(workspace_id, parsed, team_space_id, account_id, account_email) {
  // RFC 5322 threading first — Message-ID chain via In-Reply-To /
  // References. This is the only path that's safe across accounts;
  // a real reply chain genuinely belongs in one thread.
  const inReply = (parsed.inReplyTo || '').replace(/[<>]/g, '').trim() || null;
  const refs = (parsed.references ? (Array.isArray(parsed.references) ? parsed.references : [parsed.references]) : [])
    .map(r => r.replace(/[<>]/g, '').trim()).filter(Boolean);

  const candidates = [inReply, ...refs].filter(Boolean);
  if (candidates.length) {
    const m = await one(
      `SELECT thread_id FROM messages
       WHERE workspace_id = $1 AND message_id = ANY($2::text[])
       LIMIT 1`,
      [workspace_id, candidates]
    );
    if (m) return { threadId: m.thread_id };
  }

  // Provider conversation id (Microsoft Graph). RFC threading above misses
  // whenever the headers aren't there to follow — the client didn't set
  // In-Reply-To, or we're ingesting the Sent copy before the message it
  // answers. Graph's conversationId covers exactly that gap: it's the same
  // value on the inbox copy and the sent copy of one exchange. Scoped to the
  // same account because conversationId is only unique within a mailbox.
  const convId = parsed._graphConversationId || null;
  if (convId && account_id) {
    const c = await one(
      `SELECT thread_id FROM messages
        WHERE workspace_id = $1 AND account_id = $2 AND provider_conversation_id = $3
        -- ORDER BY matters: on a conversation that is ALREADY split (the very
        -- situation this exists to stop) the same conversation id sits on
        -- messages in both threads, and an unordered LIMIT 1 would pick a
        -- different one from query to query. Oldest message wins, so everything
        -- converges on the thread the conversation actually started in.
        ORDER BY sent_at ASC, id ASC
        LIMIT 1`,
      [workspace_id, account_id, convId]
    );
    if (c) return { threadId: c.thread_id };
  }

  // Subject-based fallback — used when the email is the first in a
  // conversation (no In-Reply-To) and we have no conversation id either
  // (i.e. the IMAP path). Scoped to the SAME account_id, and to a thread this
  // message shares a COUNTERPARTY with.
  //
  // It used to require an existing message *from the same sender*, which
  // quietly broke the common case: our own outbound copy of a reply, arriving
  // with no usable headers, found no message from US in the customer's thread
  // and so started a second thread — one holding only our sent mail, invisible
  // in the Inbox view (that filter needs a message with folder='INBOX'). Worse,
  // it was self-reinforcing: the new thread now DID contain a message from us,
  // so every later send matched it and the conversation stayed split forever.
  //
  // Matching on the counterparty instead keeps the guard that mattered. The
  // incident this scoping was added for was a workspace-wide subject match
  // collapsing every "Email Account Activity" GoDaddy notification across all
  // 23 mailboxes into one 160-message mega-thread; those share a subject but
  // NOT a correspondent, and account_id still pins us to a single mailbox.
  //
  // Cc is deliberately excluded on BOTH sides. Including it makes any address
  // that is routinely copied — an internal accounting@ or ops@ — a universal
  // merge key, so two different vendors' "Invoice" threads would join purely
  // because the same colleague is copied on everything. The old sender-scoped
  // rule kept those apart and this must too. From/To alone still covers the
  // case this fix exists for: our Sent copy has the customer in To, and their
  // thread has them in From.
  const subject = (parsed.subject || '').trim();
  const cleanSubj = subject.replace(/^(re|fwd|fw)\s*:\s*/i, '').trim();
  const selfLower = (account_email || '').toLowerCase();
  // Every mailbox connected in this workspace, not just this one. Two connected
  // accounts that appear on each other's mail would otherwise be counterparties
  // for each other and become the same universal merge key as a shared Cc.
  const ourAddresses = await workspaceAccountEmails(workspace_id);
  const isOurs = (a) => a === selfLower || ourAddresses.has(a);

  const mentioned = [...new Set([...addressesOf(parsed.from), ...addressesOf(parsed.to)])];
  let counterparties = mentioned.filter((a) => a && !isOurs(a));
  // Genuinely self-addressed mail (notes to self) has no counterparty at all.
  // Skipping the fallback there would start a new thread for every such message
  // — a regression against the old sender-scoped rule, which matched on our own
  // address. Fall back to matching on ourselves, which is what it did.
  if (counterparties.length === 0 && mentioned.length > 0) counterparties = mentioned;

  // Mass sends do not get the subject fallback at all. A marketing blast goes to
  // many people under one subject, and the moment two such sends share a single
  // recipient the subject rule would chain them into one thread — measured on
  // production, one blast subject had 43 threads in a mailbox of which 35 shared
  // a recipient with another. Above this many correspondents the message is a
  // broadcast, not a conversation, so it starts its own thread; a genuine
  // reply-all still threads via the RFC chain or the conversation id, which both
  // run before this. (The OLD rule was worse here — it matched on OUR OWN
  // from_addr, which is present in every blast thread, so it merged all of them.)
  const MAX_FALLBACK_CORRESPONDENTS = 5;
  if (counterparties.length > MAX_FALLBACK_CORRESPONDENTS) {
    counterparties = [];
  }

  if (cleanSubj && account_id && counterparties.length) {
    const patterns = counterparties.map(addressBoundaryPattern);
    const t = await one(
      `SELECT t.id FROM threads t
        WHERE t.workspace_id = $1
          AND t.subject = $2
          AND EXISTS (
            SELECT 1 FROM messages m
             WHERE m.thread_id = t.id
               AND m.account_id = $3
               AND (
                 LOWER(m.from_addr) ~ ANY($4::text[])
                 OR LOWER(m.to_addrs) ~ ANY($4::text[])
               )
          )
        ORDER BY t.last_message_at DESC
        LIMIT 1`,
      [workspace_id, cleanSubj, account_id, patterns]
    );
    if (t) return { threadId: t.id };
  }

  // No existing thread matched. Describe the thread to create instead of
  // creating it: ingestMessage inserts it in the same locked statement as the
  // message, so a message that turns out to be a duplicate (another walk won
  // the race) never leaves an empty thread behind.
  const now = Date.now();
  const sentAt = parsed.date ? new Date(parsed.date).getTime() : now;
  const participants = [
    ...(parsed.from ? [parsed.from.text] : []),
    ...(parsed.to ? [normalizeAddrList(parsed.to)] : []),
  ].filter(Boolean).join('; ');

  return {
    newThread: {
      id: uuid(),
      team_space_id: team_space_id || null,
      subject: cleanSubj || subject || '(no subject)',
      participants,
      last_message_at: sentAt,
      message_id_root: (parsed.messageId || '').replace(/[<>]/g, '') || null,
      search_text: (cleanSubj || subject || '') + ' ' + participants,
      created_at: now
    }
  };
}

// Append a new fragment to threads.search_text under a character cap,
// resilient to the GIN to_tsvector trigger's 1 MB-per-tsvector ceiling.
//
// Callers must pass IDENTITY FIELDS ONLY (subject + sender/recipients), never
// message body — search_text backs the inbox tsvector search and body text
// caused false matches (a name in a quote/signature matched the whole thread).
//
// Why the retry: to_tsvector emits a lexeme + position list per occurrence,
// so for token-dense content (URLs, IDs, code) the output tsvector can
// exceed the input string in bytes. A cap on the input doesn't guarantee
// the trigger won't reject. Real-world incident: a thread's cap-250K
// search_text produced a 1.05 MB tsvector and crashed every subsequent
// ingest for that account.
//
// First try the normal capped append (100K chars — empirically safe with
// headroom). If that overflows, replace search_text with just the new
// fragment: search degrades for that one bloated thread, but ingest never
// breaks. Both attempts swallow tsvector errors; other errors propagate.
async function appendThreadSearchText(threadId, fragment) {
  const SEARCH_TEXT_CAP = 100000;
  const isTsvectorOverflow = (e) =>
    String((e && e.message) || '').includes('too long for tsvector');

  try {
    await query(
      `UPDATE threads SET search_text = RIGHT(coalesce(search_text, '') || ' ' || $2, $3)
       WHERE id = $1`,
      [threadId, fragment, SEARCH_TEXT_CAP]
    );
    return;
  } catch (e) {
    if (!isTsvectorOverflow(e)) throw e;
    console.warn(`[ingest] tsvector overflow on thread ${threadId} appending search_text — replacing with latest fragment only`);
  }
  try {
    await query(
      `UPDATE threads SET search_text = $1 WHERE id = $2`,
      [String(fragment).slice(0, SEARCH_TEXT_CAP), threadId]
    );
  } catch (e) {
    if (isTsvectorOverflow(e)) {
      console.error(`[ingest] cannot update search_text for thread ${threadId} even after reset — skipping`);
      return;
    }
    throw e;
  }
}

// Build the VALUES list for a multi-row attachments insert, appending its
// parameters to `params`. Shared by the new-message insert and the dup-backfill
// branch in ingestMessage so both shape rows identically. Bytes (att.content)
// are stored inline in the `data` column.
//
// Every column is cast explicitly. These VALUES feed INSERT ... SELECT inside a
// CTE, where there is no target column to infer a parameter's type from: an
// uncast parameter resolves to text, and a Buffer bound as text fails for
// bytea. (unnest(bytea[]) is avoided on purpose: node-pg sends a Buffer array
// as hex text, doubling the payload; plain Buffer parameters go over as binary.)
//
// One created_at for the whole batch is deliberate: rows of a single insert
// share it, so a later cleanup can tell a legitimately repeated attachment
// (same batch) from a race-duplicated one (a separate insert).
function attachmentValues(messageId, workspaceId, attRows, params) {
  const nowMs = Date.now();
  const values = [];
  for (const att of attRows) {
    const base = params.length;
    values.push(
      `($${base+1}::text, $${base+2}::text, $${base+3}::text, $${base+4}::text, $${base+5}::text, ` +
      `$${base+6}::int, $${base+7}::text, $${base+8}::bytea, $${base+9}::bigint)`
    );
    params.push(
      uuid(), messageId, workspaceId,
      att.filename || 'attachment',
      att.contentType || 'application/octet-stream',
      att.size || (att.content && att.content.length) || 0,
      (att.cid || '').replace(/[<>]/g, '') || null,
      att.content,
      nowMs
    );
  }
  return values.join(', ');
}

const ATTACHMENT_COLUMNS =
  'id, message_id, workspace_id, filename, content_type, size_bytes, content_id, data, created_at';

// Advisory-lock key for one message's dedup identity. Ingest, the attachment
// backfill, compose, reply and scheduled send all take the same key, so any
// two writers of the same (account, direction, Message-ID) serialize. See
// txLocked in db.js.
function ingestLockKey(accountId, direction, messageId) {
  return `mc-ingest|${accountId}|${direction}|${messageId}`;
}

// Errors that mean "these attachment rows can't be stored", as opposed to "the
// database is unavailable":
//   - SQLSTATE class 22 (data exception): the row's content is bad (e.g. a NUL
//     byte in a text column) — retrying the same row fails again.
//   - 57014 (statement timeout) once the lock is held: a big attachment that
//     can't be written within the statement_timeout over the slow link — it
//     would time out again on every re-walk.
// A 57014 while still waiting for the lock is not one of these (lockPhase).
function isAttachmentRejected(e) {
  if (!e || typeof e.code !== 'string') return false;
  return e.code.startsWith('22') || (e.code === '57014' && !e.lockPhase);
}

async function ingestMessage(acc, uid, folder, parsed, direction) {
  const messageId = (parsed.messageId || '').replace(/[<>]/g, '');
  const fromAddr = parsed.from ? parsed.from.text : '';
  const fromAddrLower = (parsed.from && parsed.from.value && parsed.from.value[0] && parsed.from.value[0].address || '').toLowerCase();
  // If caller didn't pre-decide direction, infer from From: header.
  const dir = direction || (fromAddrLower === acc.email.toLowerCase() ? 'outbound' : 'inbound');
  if (messageId) {
    // Dedup is scoped to (message_id, account_id, direction). Key
    // properties:
    //   - Re-polling the same folder catches duplicates (same direction
    //     each time) ✓
    //   - A self-sent email landing in Sent (direction=outbound) AND
    //     in INBOX (direction=inbound) for the same mailbox gets two
    //     records, matching Gmail/Outlook behavior ✓
    //   - The same email reaching two different mailboxes in the same
    //     workspace produces one record per mailbox (different
    //     account_id) ✓
    // The old (message_id, workspace_id) key was too aggressive — it
    // caused self-sent emails composed in DelegationDoer to never
    // appear in the sender's own INBOX view (the outbound record was
    // created by compose, then dedup blocked the inbound copy from
    // ever being ingested).
    //
    // This is the lock-free fast path: most messages in a re-walk already
    // exist and cost exactly this one round trip. has_att rides along so the
    // backfill check below needs no second query. ORDER BY picks the same
    // copy DD renders when legacy duplicates exist, so a backfill lands on it.
    // A miss here is NOT final — the locked insert below re-checks.
    const dup = await one(
      `SELECT m.id, EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id) AS has_att
         FROM messages m
        WHERE m.message_id = $1
          AND m.account_id = $2
          AND m.direction = $3
        ORDER BY m.sent_at, m.id
        LIMIT 1`,
      [messageId, acc.id, dir]
    );
    if (dup) {
      // Backfill the provider conversation id onto a message stored before that
      // column existed. Without this the Graph half of the threading fix only
      // ever helps mail that arrives AFTER deploy: this short-circuit returns
      // before the INSERT, so /rescan-all (which clears the delta cursor and
      // re-walks every message) would re-see every message and write none of
      // them. Only fills NULLs, so it never overwrites a known value.
      const convId = parsed._graphConversationId || null;
      if (convId) {
        await query(
          `UPDATE messages SET provider_conversation_id = $1
            WHERE id = $2 AND provider_conversation_id IS NULL`,
          [convId, dup.id]
        );
      }
      // Backfill attachments onto a message we already stored without them.
      // Anything synced before the inbound attachment fixes (the
      // hasAttachments-gate removal + $value-for-all in graph.js) was ingested
      // with zero attachment rows, and this dup short-circuit would otherwise
      // skip it forever. A rescan (accounts.js /rescan-all clears the delta
      // cursor, re-walking every message) now self-heals those rows here.
      //
      // Guarded so it only fires when the stored row has NO attachments and we
      // now have some. The guard used to be a separate COUNT then INSERT, which
      // two overlapping walks could both pass — that is how one message ended
      // up with its logo stored twice. Now the "still none?" check and the
      // insert are one statement under the message's lock, and the walk that
      // inserted the message holds that same lock through its own attachment
      // insert, so a concurrent backfill waits and then sees those rows.
      const incoming = (Array.isArray(parsed.attachments) ? parsed.attachments : [])
        .filter(a => a.content);
      if (incoming.length && !dup.has_att) {
        const params = [dup.id];
        const values = attachmentValues(dup.id, acc.workspace_id, incoming, params);
        // A data exception or statement timeout here means these attachment rows
        // can't be stored (see isAttachmentRejected), and would fail the same way
        // on every re-walk — log it and move on rather than failing (IMAP:
        // wedging) the walk on a message that is already stored. See the
        // matching fallback in the insert below.
        let r;
        try {
          r = await txLocked(ingestLockKey(acc.id, dir, messageId), (client) => client.query(
            `WITH a AS (
               INSERT INTO attachments (${ATTACHMENT_COLUMNS})
               SELECT v.* FROM (VALUES ${values}) AS v
                WHERE NOT EXISTS (SELECT 1 FROM attachments x WHERE x.message_id = $1::text)
               RETURNING 1
             ), u AS (
               UPDATE messages SET has_attachments = 1
                WHERE id = $1::text AND EXISTS (SELECT 1 FROM a)
               RETURNING 1
             )
             SELECT (SELECT count(*) FROM a)::int AS n`,
            params
          ));
        } catch (e) {
          if (!isAttachmentRejected(e)) throw e;
          console.warn(`[ingest] attachment backfill rejected for ${messageId} (${acc.email}): ${e.message}`);
        }
        const n = r && r.rows[0] ? r.rows[0].n : 0;
        if (n > 0) {
          console.log(`[ingest] backfilled ${n} attachment(s) onto existing message ${messageId} (${acc.email})`);
        }
      }
      return false;
    }
  }

  // Thread lookups run on the global pool, outside the transaction: they only
  // read, and keeping them out keeps the lock held for as short as possible.
  const resolved = await resolveThread(acc.workspace_id, parsed, acc.team_space_id, acc.id, acc.email);
  const newThread = resolved.newThread || null;
  const threadId = newThread ? newThread.id : resolved.threadId;
  const id = uuid();
  const sentAt = parsed.date ? new Date(parsed.date).getTime() : Date.now();
  const attachments = Array.isArray(parsed.attachments) ? parsed.attachments : [];
  const hasAtt = attachments.length > 0 ? 1 : 0;

  // One statement does the re-check and every insert:
  //   d — is the message there now? Its snapshot is taken after the lock was
  //       granted, so it sees a copy another walk committed while we waited.
  //   t — the new thread, only if resolveThread asked for one and d is empty.
  //   m — the message, only if d is empty. The bare ON CONFLICT DO NOTHING
  //       (never a targeted one, which fails 42P10 while the index is absent)
  //       absorbs a clash with uq_messages_acct_dir_msgid from a writer that
  //       doesn't take this lock.
  //   a — the attachments, only if m inserted.
  // Parent and child rows in one statement pass the FK checks, because RI
  // triggers fire at the end of the statement. Every parameter is cast: in
  // INSERT ... SELECT there is no target column to infer types from.
  const params = [
    messageId || null, acc.id, dir,                                    // $1-$3
    !!newThread, threadId, acc.workspace_id,                           // $4-$6
    newThread && newThread.team_space_id,                              // $7
    newThread && newThread.subject,                                    // $8
    newThread && newThread.participants,                               // $9
    newThread && newThread.last_message_at,                            // $10
    newThread && newThread.message_id_root,                            // $11
    newThread && newThread.search_text,                                // $12
    newThread && newThread.created_at,                                 // $13
    id, folder || null,                                                // $14-$15
    (parsed.inReplyTo || '').replace(/[<>]/g, '') || null,             // $16
    parsed.subject || '',                                              // $17
    fromAddr,                                                          // $18
    normalizeAddrList(parsed.to),                                      // $19
    normalizeAddrList(parsed.cc),                                      // $20
    parsed.text || '',                                                 // $21
    parsed.html || '',                                                 // $22
    sentAt, uid, hasAtt, Date.now(),                                   // $23-$26
    // Null on the IMAP path — only Graph gives us a conversation id.
    parsed._graphConversationId || null                                // $27
  ];
  const attRows = attachments.filter(a => a.content);
  // Attachment parameters are appended after $27; remember where the message's
  // own parameters end so the no-attachments retry below can drop them (an
  // unreferenced parameter fails the whole statement).
  const baseParamCount = params.length;
  const attValues = attRows.length ? attachmentValues(id, acc.workspace_id, attRows, params) : null;

  const buildInsertSql = (withAtt) =>
    `WITH d AS (
       SELECT id FROM messages
        WHERE message_id = $1::text AND account_id = $2::text AND direction = $3::text
        ORDER BY sent_at, id
        LIMIT 1
     ), t AS (
       INSERT INTO threads (id, workspace_id, team_space_id, subject, participants, last_message_at, status,
                            message_id_root, search_text, created_at)
       SELECT $5::text, $6::text, $7::text, $8::text, $9::text, $10::bigint, 'open',
              $11::text, $12::text, $13::bigint
        WHERE $4::boolean AND NOT EXISTS (SELECT 1 FROM d)
       RETURNING id
     ), m AS (
       INSERT INTO messages
         (id, thread_id, account_id, workspace_id, direction, folder, message_id, in_reply_to,
          subject, from_addr, to_addrs, cc_addrs, body_text, body_html, sent_at, imap_uid,
          has_attachments, created_at, provider_conversation_id)
       SELECT $14::text, $5::text, $2::text, $6::text, $3::text, $15::text, $1::text, $16::text,
              $17::text, $18::text, $19::text, $20::text, $21::text, $22::text, $23::bigint, $24::bigint,
              $25::int, $26::bigint, $27::text
        WHERE NOT EXISTS (SELECT 1 FROM d)
       ON CONFLICT DO NOTHING
       RETURNING id
     )${withAtt ? `, a AS (
       INSERT INTO attachments (${ATTACHMENT_COLUMNS})
       SELECT v.* FROM (VALUES ${attValues}) AS v
        WHERE EXISTS (SELECT 1 FROM m)
       RETURNING 1
     )` : ''}
     SELECT (SELECT id FROM d) AS dup_id, (SELECT id FROM m) AS new_id`;

  const runWith = (withAtt) => async (client) => {
    const r = await client.query(buildInsertSql(withAtt), withAtt ? params : params.slice(0, baseParamCount));
    const row = r.rows[0] || {};
    // Neither a dup nor an insert: m hit ON CONFLICT (a writer that doesn't
    // take this lock got there first). t may have inserted a thread for us
    // that now holds nothing — drop it before COMMIT.
    if (!row.new_id && !row.dup_id && newThread) {
      await client.query(
        `DELETE FROM threads t WHERE t.id = $1
            AND NOT EXISTS (SELECT 1 FROM messages x WHERE x.thread_id = t.id)`,
        [newThread.id]
      );
    }
    return row;
  };
  // No Message-ID means no dedup identity (these were never deduped), so there
  // is nothing to lock on — a plain transaction keeps thread + message atomic.
  const store = (withAtt) => messageId
    ? txLocked(ingestLockKey(acc.id, dir, messageId), runWith(withAtt))
    : tx(runWith(withAtt));
  let result;
  try {
    result = await store(!!attValues);
  } catch (e) {
    // Message and attachments share one statement, so a bad attachment row (a
    // data exception, class 22 — e.g. a NUL byte in a filename or content id)
    // or one too big to write before the statement_timeout (57014) would roll
    // the message back too. Graph skips a non-structural failure and its saved
    // delta link then covers the message, so it would be lost for good; a
    // timeout (structural) would instead stall the walk on it every poll.
    // Store the message alone instead; has_attachments stays set and the
    // dup-backfill branch above retries the attachments on a later rescan. If
    // the database itself is timing out, this retry fails too and throws.
    if (!attValues || !isAttachmentRejected(e)) throw e;
    console.warn(`[ingest] attachments rejected for ${messageId || '(no Message-ID)'} (${acc.email}) — storing message without them: ${e.message}`);
    result = await store(false);
  }

  if (!result.new_id) {
    // Another walk (or instance) stored this message between our fast-path
    // check and taking the lock. Nothing was written, so no side effects fire.
    // This line is the metric for the guard working — it should be rare.
    console.log(`[ingest] lost race ${messageId} (${acc.email}) — already stored as ${result.dup_id || 'a conflicting row'}`);
    // Same conversation-id backfill as the fast-path dup branch: the winner is
    // often compose/reply, which stores none, and a delta walk won't come back.
    if (result.dup_id && parsed._graphConversationId) {
      await query(
        'UPDATE messages SET provider_conversation_id = $1 WHERE id = $2 AND provider_conversation_id IS NULL',
        [parsed._graphConversationId, result.dup_id]
      );
    }
    return false;
  }

  // Update thread search text + bump last_message_at.
  //
  // search_text holds IDENTITY FIELDS ONLY — subject + sender/recipients
  // (from/to/cc), accumulated across the thread's messages. Deliberately NO
  // message body: inbox search matches this column via tsvector, and including
  // body text made a name buried in a signature, quoted reply, or footer match
  // the entire thread — surfacing conversations the search term doesn't visibly
  // belong to. Don't re-add body here (or in compose.js / threads.js reply /
  // index.js scheduled send) without reintroducing that bug.
  const searchAdd = [
    parsed.subject || '',
    fromAddr,
    normalizeAddrList(parsed.to),
    normalizeAddrList(parsed.cc)
  ].filter(Boolean).join(' ');

  // Split into two updates so a tsvector overflow on the GIN index can't
  // abort ingestMessage. The non-search fields always succeed; search_text
  // is best-effort via appendThreadSearchText. Both run after COMMIT, outside
  // the lock, so they never hold it and need no SAVEPOINT.
  //
  // last_message_at only ever advances — never regresses. Messages can be
  // ingested out of chronological order (separate INBOX/Sent sync passes,
  // UID-reset backfills re-fetching from UID 1, delayed/forwarded mail that
  // threads by subject). An unconditional assignment lets an older message
  // clobber a newer thread timestamp, stranding active threads low in the
  // inbox list (which orders by last_message_at DESC). GREATEST keeps the
  // thread stamped with its newest message regardless of ingest order.
  await query(
    `UPDATE threads SET last_message_at = GREATEST(last_message_at, $1),
       status = CASE WHEN status = 'closed' AND $3 = 'inbound' THEN 'open' ELSE status END,
       snoozed_until = CASE WHEN $3 = 'inbound' THEN NULL ELSE snoozed_until END
     WHERE id = $2`,
    [sentAt, threadId, dir]
  );
  await appendThreadSearchText(threadId, searchAdd);

  // account_id is included so consumers that filter by which inbox the
  // event belongs to (e.g. DelegationDoer's per-user SSE stream, which
  // only delivers events for the accounts a worker is allowed to see)
  // can scope without a second round-trip. Missiveclone's own frontend
  // ignores extra fields.
  emitToWorkspace(acc.workspace_id, 'thread:updated', { thread_id: threadId, account_id: acc.id });
  emitToWorkspace(acc.workspace_id, 'message:new', { thread_id: threadId, message_id: id, account_id: acc.id });

  // Push to DelegationDoer so the sidebar badge + inbox list can refresh
  // in real time instead of waiting on the 30s poll. Only fires for
  // inbound — outbound messages were initiated from DD and the UI
  // already updated optimistically. Spam/Junk is deliberately excluded:
  // it's visible in DD's Spam view but must not trigger auto-intake,
  // routing, or inbound-mail notifications.
  const isSpamFolder = /spam|junk/i.test(folder || '');
  if (dir === 'inbound' && !isSpamFolder) {
    fireWebhook('message:new', {
      workspace_id: acc.workspace_id,
      account_id: acc.id,
      thread_id: threadId,
      message_id: id,
      // Sent along so DelegationDoer can auto-apply per-client labels
      // without a second HTTP round-trip to fetch the message. Same
      // shape as messages.from_addr / to_addrs / cc_addrs in the DB.
      from_addr: fromAddr || null,
      to_addrs: normalizeAddrList(parsed.to) || null,
      cc_addrs: normalizeAddrList(parsed.cc) || null
    });
  }
  return true;
}

async function getFolderState(accountId, folder) {
  const r = await one(
    'SELECT last_sync_uid, uid_validity FROM folder_sync_state WHERE account_id = $1 AND folder = $2',
    [accountId, folder]
  );
  return r
    ? { lastUid: Number(r.last_sync_uid), uidValidity: r.uid_validity || null }
    : { lastUid: 0, uidValidity: null };
}

async function setFolderState(accountId, folder, lastUid, uidValidity) {
  await query(
    `INSERT INTO folder_sync_state (account_id, folder, last_sync_uid, uid_validity)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (account_id, folder)
     DO UPDATE SET last_sync_uid = EXCLUDED.last_sync_uid,
                   uid_validity  = EXCLUDED.uid_validity`,
    [accountId, folder, lastUid, uidValidity]
  );
}

async function detectFolders(client) {
  // Returns { inbox, sent, junk } using IMAP SPECIAL-USE flags when available.
  const list = await client.list();
  let inbox = 'INBOX';
  let sent = null;
  let junk = null;
  for (const box of list) {
    const flags = (box.flags && Array.from(box.flags)) || [];
    const su = (box.specialUse || '').toLowerCase();
    if (box.path === 'INBOX') inbox = 'INBOX';
    if (su === '\\sent' || flags.includes('\\Sent')) sent = box.path;
    if (su === '\\junk' || flags.includes('\\Junk')) junk = box.path;
  }
  // Common fallbacks if SPECIAL-USE isn't reported.
  if (!sent) {
    const candidates = ['Sent', 'Sent Mail', 'Sent Items', '[Gmail]/Sent Mail', 'INBOX.Sent'];
    for (const c of candidates) {
      if (list.find(b => b.path === c)) { sent = c; break; }
    }
  }
  if (!junk) {
    const candidates = ['Junk', 'Junk Email', 'Junk E-mail', 'Spam',
                        '[Gmail]/Spam', 'INBOX.Junk', 'INBOX.spam', 'Bulk Mail'];
    for (const c of candidates) {
      if (list.find(b => b.path === c)) { junk = c; break; }
    }
  }
  return { inbox, sent, junk };
}

async function syncFolder(client, acc, folder, direction) {
  const mb = await client.mailboxOpen(folder);
  const currentValidity = mb && mb.uidValidity != null ? String(mb.uidValidity) : null;
  const uidNext = mb && mb.uidNext != null ? Number(mb.uidNext) : null;
  const exists = mb && mb.exists != null ? Number(mb.exists) : null;

  let { lastUid, uidValidity: storedValidity } = await getFolderState(acc.id, folder);

  // Empty mailbox — Outlook doesn't always advertise UIDNEXT in this case,
  // and rejects `1:*` (and `<n>:*`) as "The specified message set is
  // invalid". Record the current UIDVALIDITY and exit cleanly so the
  // account doesn't stay marked as failed with a stale watermark.
  if (exists === 0) {
    if (lastUid !== 0 || currentValidity !== storedValidity) {
      await setFolderState(acc.id, folder, 0, currentValidity);
    }
    return 0;
  }

  // Two stale-watermark cases that both produce Outlook's
  // "The specified message set is invalid" on `<lastUid+1>:*`:
  //   1. UIDVALIDITY changed (mailbox recreated server-side).
  //   2. We never tracked UIDVALIDITY before this fix and the mailbox
  //      silently reset under us — detectable as lastUid >= uidNext.
  // Either way, treat it as a fresh import. ingestMessage dedupes on
  // message_id, so re-fetching previously-seen messages is bandwidth
  // cost only — no duplicate rows.
  const validityChanged = storedValidity && currentValidity && storedValidity !== currentValidity;
  const watermarkPastUidNext = uidNext != null && lastUid >= uidNext;
  if (validityChanged || watermarkPastUidNext) {
    console.warn(
      `folder state stale for ${acc.email}/${folder} ` +
      `(lastUid=${lastUid}, uidNext=${uidNext}, ` +
      `stored=${storedValidity}, current=${currentValidity}) — resetting`
    );
    lastUid = 0;
  }

  // Nothing to fetch — record current UIDVALIDITY so we can detect a
  // future reset, then exit. Avoids issuing `1:*` against an empty box.
  if (uidNext != null && lastUid + 1 >= uidNext) {
    if (currentValidity !== storedValidity) {
      await setFolderState(acc.id, folder, lastUid, currentValidity);
    }
    return 0;
  }

  // Pull messages. If Outlook rejects the range as invalid (our pre-check
  // missed it because uidNext wasn't reported — happens for some mailboxes
  // /folder responses), reset to 0 and try once more from the bottom.
  // Without this fallback, stuck accounts can never self-heal because the
  // FETCH throws before the success branch writes uid_validity.
  let count = 0;
  let maxUid = lastUid;
  let attempted = false;
  while (true) {
    const range = `${lastUid + 1}:*`;
    try {
      for await (const msg of client.fetch(range, { uid: true, source: true })) {
        if (!msg.source) continue;
        const parsed = await simpleParser(msg.source);
        const ok = await ingestMessage(acc, msg.uid, folder, parsed, direction);
        if (ok) count++;
        if (msg.uid > maxUid) maxUid = msg.uid;
      }
      break;
    } catch (e) {
      const text = `${e && e.message} ${e && e.responseText}`.toLowerCase();
      const looksStale = text.includes('invalid') || text.includes('message set');
      if (!attempted && looksStale && lastUid > 0) {
        console.warn(
          `fetch rejected as stale for ${acc.email}/${folder} ` +
          `(lastUid=${lastUid}, uidNext=${uidNext}) — resetting to 0 and retrying`
        );
        lastUid = 0;
        maxUid = 0;
        count = 0;
        attempted = true;
        continue;
      }
      throw e;
    }
  }

  if (maxUid > lastUid || currentValidity !== storedValidity) {
    await setFolderState(acc.id, folder, maxUid, currentValidity);
  }
  return count;
}

// One walk per account at a time (per instance). The 30s poll, IMAP IDLE,
// /:id/sync and /rescan-all all start walks, and cursors (Graph delta_link,
// IMAP last_sync_uid) are only saved when a walk ENDS — so a walk that ran past
// 30s used to be joined by a second, then a third, each replaying the same mail
// from the same old cursor. That overlap (initial onboarding syncs, the
// post-outage catch-up) is where the duplicate message rows came from.
//
// A call made while a walk is running coalesces onto it and gets its result.
// `rerun` (IDLE saw new mail after the walk may have passed it) and `fresh`
// (/rescan-all: drop the cursors and re-walk everything) can't be satisfied by
// the running walk, so they set a flag and exactly ONE follow-up walk runs when
// it finishes — clearing the cursors first if fresh was asked for. Clearing
// them mid-walk would be undone: the running walk saves its own cursor at the
// end. A long first sync is exactly when overlap does the most damage, so a
// running walk is logged after 15 minutes but left alone — until STUCK_WALK_MS.
// Nothing guarantees a walk settles (a query on a silently dead socket, a Graph
// fetch that never ends), and without an escape one hung await would stop this
// mailbox syncing until a restart. Past the cap, the next call presumes the walk
// stuck and starts a new one alongside it. That overlap is duplicate-safe now
// (the per-message ingest lock and its locked re-check); if the old walk does
// finish and save its older cursor, the next walk just replays stored mail.
const inflight = new Map(); // accountId -> { p, startedAt, again, fresh, warnedMin }
const STILL_RUNNING_WARN_MS = 15 * 60_000;
const STUCK_WALK_MS = 45 * 60_000;

function syncAccount(accountId, { rerun = false, fresh = false } = {}) {
  const cur = inflight.get(accountId);
  if (cur && Date.now() - cur.startedAt >= STUCK_WALK_MS) {
    console.warn(`[sync] walk for ${accountId} has run ${Math.floor((Date.now() - cur.startedAt) / 60_000)}m — presuming it stuck, starting a new one alongside`);
    // The new walk takes over the old one's pending requests; the old one,
    // if it ever finishes, must not chain a follow-up or clear the new entry.
    fresh = fresh || cur.fresh;
    cur.again = false;
    inflight.delete(accountId);
  } else if (cur) {
    if (rerun || fresh) cur.again = true;
    if (fresh) cur.fresh = true;
    const ranMs = Date.now() - cur.startedAt;
    const mins = Math.floor(ranMs / 60_000);
    // Once per minute at most — the poll alone calls in every 30s.
    if (ranMs >= STILL_RUNNING_WARN_MS && cur.warnedMin !== mins) {
      cur.warnedMin = mins;
      console.warn(`[sync] still running ${mins}m for ${accountId} — not starting another walk`);
    }
    return cur.p;
  }
  const entry = { startedAt: Date.now(), again: false, fresh: false, warnedMin: null };
  entry.p = (async () => {
    try {
      if (fresh) await clearCursors(accountId);
      return await _syncAccountImpl(accountId);
    } finally {
      if (inflight.get(accountId) === entry) inflight.delete(accountId);
      if (entry.again) {
        syncAccount(accountId, { fresh: entry.fresh }).catch((err) => {
          console.warn(`[sync] follow-up walk failed for ${accountId}: ${err && err.message}`);
        });
      }
    }
  })();
  inflight.set(accountId, entry);
  return entry.p;
}

// Resolves true once no walk is running for this account — waiting out the
// current one and any follow-up it chains — or false if that takes longer than
// maxMs. For writers that must not overlap a walk of the same account but don't
// go through the per-message lock (util/relink_orphans.js).
async function waitForIdle(accountId, maxMs) {
  const deadline = Date.now() + maxMs;
  for (;;) {
    const cur = inflight.get(accountId);
    if (!cur) return true;
    const left = deadline - Date.now();
    if (left <= 0) return false;
    let timer;
    await Promise.race([
      cur.p.catch(() => {}),
      new Promise((resolve) => { timer = setTimeout(resolve, left); })
    ]);
    clearTimeout(timer);
  }
}

// Forget where every folder walk left off, so the next walk re-reads the whole
// mailbox: Graph resumes from delta_link, IMAP from last_sync_uid (uid_validity
// is kept — it describes the server mailbox, not our progress). Re-reading is
// safe because ingest dedupes on (message_id, account_id, direction). Only
// called from syncAccount's wrapper, before a walk starts, so no running walk
// (bar one already presumed stuck) can save its old cursor over the reset.
async function clearCursors(accountId) {
  await query(
    `UPDATE folder_sync_state SET delta_link = NULL, last_sync_uid = 0
      WHERE account_id = $1`,
    [accountId]
  );
}

async function _syncAccountImpl(accountId) {
  const acc = await getAccount(accountId);
  if (!acc) return 0;
  // Microsoft accounts sync via Graph instead of IMAP — outlook.office365.com
  // IMAP throttles aggressively per egress IP, which strands every mailbox
  // on the same Railway service simultaneously. See graph.js header for
  // the full story. graph.js handles recordSyncError and last_synced_at
  // bookkeeping, so we just return its count.
  if (acc.provider === 'microsoft') {
    const { syncAccountViaGraph } = require('./graph');
    return syncAccountViaGraph(acc);
  }
  let client;
  try {
    client = await buildClient(acc);
    await client.connect();
  } catch (e) {
    await recordSyncError(accountId, e);
    throw e;
  }
  let count = 0;
  try {
    const { inbox, sent, junk } = await detectFolders(client);
    if (sent && sent !== acc.sent_folder) {
      await query('UPDATE email_accounts SET sent_folder = $1 WHERE id = $2', [sent, acc.id]);
      acc.sent_folder = sent;
    }
    count += await syncFolder(client, acc, inbox, 'inbound');
    if (sent) {
      try { count += await syncFolder(client, acc, sent, 'outbound'); }
      catch (e) { console.warn('sent folder sync failed for', acc.email, '-', e.message); }
    }
    // Junk/Spam is inbound mail the provider already filtered out. We sync
    // it (folder = the provider's junk path) so DelegationDoer can offer a
    // Spam view, but ingestMessage suppresses the DD webhook for it so spam
    // never enters the auto-intake/routing/notification pipeline.
    if (junk) {
      try { count += await syncFolder(client, acc, junk, 'inbound'); }
      catch (e) { console.warn('junk folder sync failed for', acc.email, '-', e.message); }
    }
    await query(
      `UPDATE email_accounts
         SET last_synced_at = $1, last_sync_error = NULL, last_sync_error_at = NULL
         WHERE id = $2`,
      [Date.now(), acc.id]
    );
  } catch (e) {
    await recordSyncError(accountId, e);
    throw e;
  } finally {
    await client.logout().catch(() => {});
  }
  return count;
}

// ImapFlow throws errors whose .message is often just "Command failed";
// the diagnostic info (auth-failed flag, server response, IMAP command,
// OAuth refresh body) is on sibling properties. Microsoft's token endpoint
// stashes the error JSON on err.body. We pull a curated set of fields into
// a single readable string capped at 500 chars — never the full err.response
// (can include credentials) or arbitrary stack traces.
function formatSyncError(err) {
  if (!err) return 'unknown error';
  const msg = err.message ? String(err.message) : String(err);
  const tags = [];
  if (err.code) tags.push(`code=${err.code}`);
  if (err.responseStatus) tags.push(`status=${err.responseStatus}`);
  if (err.serverResponseCode) tags.push(`server=${err.serverResponseCode}`);
  if (err.authenticationFailed) tags.push('authFailed');
  if (err.command) tags.push(`cmd=${err.command}`);
  const parts = [msg];
  if (tags.length) parts.push(`[${tags.join(', ')}]`);
  if (typeof err.responseText === 'string' && err.responseText) {
    parts.push(`resp: ${err.responseText}`);
  }
  if (err.body && typeof err.body === 'object') {
    const safe = {};
    for (const k of ['error', 'error_description', 'error_codes', 'correlation_id', 'trace_id']) {
      if (err.body[k] !== undefined) safe[k] = err.body[k];
    }
    if (Object.keys(safe).length) parts.push(`oauth: ${JSON.stringify(safe)}`);
  }
  return parts.join(' ').slice(0, 500);
}

async function recordSyncError(accountId, err) {
  try {
    const msg = formatSyncError(err);
    await query(
      `UPDATE email_accounts
         SET last_sync_error = $1, last_sync_error_at = $2
         WHERE id = $3`,
      [msg, Date.now(), accountId]
    );

    // IMAP rejected the OAuth bearer token. The cached access_token is bad
    // (revoked, wrong scope, or stale). Null it out so the next poll forces
    // ensureFreshAccessToken to mint a new one via the refresh_token instead
    // of replaying the same bad token for ~60 min until natural expiry.
    // Harmless if the refresh token is also dead — the resulting refresh
    // error is more diagnostic than a repeating AUTHENTICATE failure.
    if (err && err.authenticationFailed) {
      await query(
        `UPDATE email_accounts
           SET oauth_access_token = NULL, oauth_expires_at = 0
           WHERE id = $1 AND provider = 'microsoft'`,
        [accountId]
      );
    }
  } catch (writeErr) {
    console.error('recordSyncError write failed', writeErr.message);
  }
}

async function appendToSentFolder(acc, raw) {
  if (!acc.sent_folder) return;
  const client = await buildClient(acc);
  try {
    await client.connect();
    await client.append(acc.sent_folder, raw, ['\\Seen']);
  } catch (e) {
    console.warn('append-to-sent failed for', acc.email, '-', e.message);
  } finally {
    await client.logout().catch(() => {});
  }
}

// Reconnect backoff: 5s base, doubled on each consecutive failure,
// capped at 5 min, with ±25% jitter so a fleet of mailboxes coming
// back from a shared incident doesn't synchronize their retries.
const RETRY_BASE_MS = 5_000;
const RETRY_CAP_MS = 5 * 60_000;

function scheduleReconnect(accountId, attempt) {
  const prev = retryState.get(accountId);
  if (prev && prev.timer) clearTimeout(prev.timer);
  const base = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * Math.pow(2, Math.max(0, attempt - 1)));
  const jitter = base * (0.75 + Math.random() * 0.5);
  const delay = Math.round(jitter);
  const timer = setTimeout(() => {
    retryState.delete(accountId);
    startWatching(accountId).catch((err) => {
      console.warn('[watch] retry failed for', accountId, '-', err && err.message);
    });
  }, delay);
  retryState.set(accountId, { timer, attempt });
}

async function startWatching(accountId) {
  if (watchers.has(accountId)) return;
  const acc = await getAccount(accountId);
  if (!acc) return;
  // Microsoft accounts don't use IMAP IDLE — Graph delta polling via the
  // 30s cron in index.js handles incremental sync. IDLE was the main
  // source of "Connection not available" stalls. No watcher, no retry
  // state, no work to do here. Real-time latency on Microsoft is now
  // bounded by the cron interval; the migration off IDLE is the whole
  // point of routing to Graph in the first place.
  if (acc.provider === 'microsoft') return;
  let client;
  try {
    client = await buildClient(acc, { idle: true });
  } catch (e) {
    console.error('buildClient failed for', acc.email, '-', e.message);
    const prev = retryState.get(accountId);
    scheduleReconnect(accountId, (prev && prev.attempt ? prev.attempt + 1 : 1));
    return;
  }
  watchers.set(accountId, client);

  // Without an 'error' listener, ImapFlow's long-lived IDLE socket emits
  // unhandled 'error' on TCP timeout (NAT eviction, server-side idle
  // limit) and crashes the whole Node process via uncaughtException.
  // Catching it here drops the dead watcher AND schedules a reconnect
  // with exponential backoff so the account self-heals without needing
  // a process restart — that was the previous behaviour and it was
  // silently leaving accounts unwatched for hours.
  const onDead = (label) => (err) => {
    console.warn(`watcher ${label} for`, acc.email, '-', err && err.message);
    if (watchers.get(accountId) === client) {
      watchers.delete(accountId);
      const prev = retryState.get(accountId);
      scheduleReconnect(accountId, (prev && prev.attempt ? prev.attempt + 1 : 1));
    }
  };
  client.on('error', onDead('error'));
  client.on('close', onDead('close'));
  client.on('end', onDead('end'));

  try {
    await client.connect();
    await client.mailboxOpen('INBOX');
    client.on('exists', async () => {
      // rerun: if a walk is already running it may have passed this new
      // message's UID already, so ask for one more walk after it.
      try { await syncAccount(accountId, { rerun: true }); } catch (e) { console.error('idle sync', e.message); }
    });
    // Connected cleanly — clear any backoff so the *next* drop starts
    // at 5s again instead of inheriting an old long delay.
    retryState.delete(accountId);
  } catch (e) {
    console.error('watch error', e.message);
    if (watchers.get(accountId) === client) watchers.delete(accountId);
    const prev = retryState.get(accountId);
    scheduleReconnect(accountId, (prev && prev.attempt ? prev.attempt + 1 : 1));
  }
}

function stopWatching(accountId) {
  const c = watchers.get(accountId);
  if (c) {
    try { c.logout(); } catch {}
    watchers.delete(accountId);
  }
  const rs = retryState.get(accountId);
  if (rs && rs.timer) {
    clearTimeout(rs.timer);
    retryState.delete(accountId);
  }
}

async function startAllWatchers() {
  // Watchers are IMAP-IDLE only. Microsoft accounts sync via the 30s Graph
  // poll and bail inside startWatching anyway, so skip them at the source.
  const rows = await many("SELECT id FROM email_accounts WHERE provider IS DISTINCT FROM 'microsoft'");
  for (const r of rows) {
    startWatching(r.id).catch(() => {});
  }
}

// Periodic watchdog. Cron-style: every 5 minutes, look at every connected
// account, and if its watcher is missing from the map, re-attach. This
// catches the rare case where on-error didn't fire (or fired but the
// retry timer was lost across a redeploy) — backstop to the per-watcher
// auto-heal so an account can't stay dark indefinitely.
function startWatchdog() {
  setInterval(async () => {
    try {
      // Microsoft accounts never get an IMAP watcher (they bail inside
      // startWatching), so they'd otherwise be re-flagged every tick — logging
      // "re-attaching watcher" forever without ever opening a connection.
      const rows = await many("SELECT id, email FROM email_accounts WHERE provider IS DISTINCT FROM 'microsoft'");
      for (const r of rows) {
        if (!watchers.has(r.id) && !retryState.has(r.id)) {
          console.warn('[watchdog] re-attaching watcher for', r.email);
          startWatching(r.id).catch(() => {});
        }
      }
    } catch (e) {
      console.error('[watchdog]', e && e.message);
    }
  }, 5 * 60_000);
}

module.exports = {
  syncAccount, startWatching, stopWatching, startAllWatchers, startWatchdog,
  appendToSentFolder, appendThreadSearchText, fireWebhook,
  // Exposed so graph.js can drive the same ingest pipeline without
  // duplicating thread/message/attachment INSERT logic.
  ingestMessage, recordSyncError, getAccount,
  // Compose, reply and scheduled send take the same per-message lock as ingest.
  ingestLockKey,
  // Orphan relink waits for the account's walk to finish before it runs.
  waitForIdle
};
