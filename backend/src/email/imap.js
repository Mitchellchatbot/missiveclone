const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { v4: uuid } = require('uuid');
const crypto = require('crypto');
const { one, many, query } = require('../db');
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

async function buildClient(acc) {
  if (acc.provider === 'microsoft') {
    const accessToken = await ms.ensureFreshAccessToken(acc);
    return new ImapFlow({
      host: acc.imap_host || 'outlook.office365.com',
      port: acc.imap_port || 993,
      secure: true,
      auth: { user: acc.email, accessToken },
      logger: false
    });
  }
  return new ImapFlow({
    host: acc.imap_host,
    port: acc.imap_port,
    secure: !!acc.imap_secure,
    auth: { user: acc.imap_user, pass: decrypt(acc.imap_pass) },
    logger: false
  });
}

function normalizeAddrList(list) {
  if (!list) return '';
  if (Array.isArray(list)) return list.map(a => a.text || `${a.name || ''} <${a.address || ''}>`).join(', ');
  return list.text || '';
}

async function findOrCreateThread(workspace_id, parsed, team_space_id, account_id) {
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
    if (m) return m.thread_id;
  }

  // Subject-based fallback — used when the email is the first in a
  // conversation (no In-Reply-To). Scoped to the SAME account_id +
  // SAME sender so unrelated notification emails to different
  // mailboxes don't merge. Previous behavior was workspace-wide
  // subject match, which collapsed every "Email Account Activity"
  // GoDaddy notification across all 23 mailboxes into one
  // 160-message mega-thread. Don't do that.
  const subject = (parsed.subject || '').trim();
  const cleanSubj = subject.replace(/^(re|fwd|fw)\s*:\s*/i, '').trim();
  const fromAddrLower = (parsed.from && parsed.from.value && parsed.from.value[0] && parsed.from.value[0].address || '').toLowerCase();
  if (cleanSubj && account_id && fromAddrLower) {
    const t = await one(
      `SELECT t.id FROM threads t
        WHERE t.workspace_id = $1
          AND t.subject = $2
          AND EXISTS (
            SELECT 1 FROM messages m
             WHERE m.thread_id = t.id
               AND m.account_id = $3
               AND LOWER(m.from_addr) LIKE '%' || $4 || '%'
          )
        ORDER BY t.last_message_at DESC
        LIMIT 1`,
      [workspace_id, cleanSubj, account_id, fromAddrLower]
    );
    if (t) return t.id;
  }

  const id = uuid();
  const now = Date.now();
  const sentAt = parsed.date ? new Date(parsed.date).getTime() : now;
  const participants = [
    ...(parsed.from ? [parsed.from.text] : []),
    ...(parsed.to ? [normalizeAddrList(parsed.to)] : []),
  ].filter(Boolean).join('; ');

  await query(
    `INSERT INTO threads (id, workspace_id, team_space_id, subject, participants, last_message_at, status,
                          message_id_root, search_text, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'open', $7, $8, $9)`,
    [
      id, workspace_id, team_space_id || null,
      cleanSubj || subject || '(no subject)', participants, sentAt,
      (parsed.messageId || '').replace(/[<>]/g, '') || null,
      (cleanSubj || subject || '') + ' ' + participants,
      now
    ]
  );
  return id;
}

// Append a new fragment to threads.search_text under a character cap,
// resilient to the GIN to_tsvector trigger's 1 MB-per-tsvector ceiling.
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

// Insert attachment rows for a message. Shared by the normal ingest path and
// the dup-backfill branch in ingestMessage so both build the multi-row INSERT
// identically. Bytes (att.content) are stored inline in the `data` column.
async function insertAttachmentRows(messageId, workspaceId, attRows) {
  if (!attRows.length) return;
  const nowMs = Date.now();
  const values = [];
  const params = [];
  for (const att of attRows) {
    const base = params.length;
    values.push(`($${base+1}, $${base+2}, $${base+3}, $${base+4}, $${base+5}, $${base+6}, $${base+7}, $${base+8}, $${base+9})`);
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
  await query(
    `INSERT INTO attachments
      (id, message_id, workspace_id, filename, content_type, size_bytes, content_id, data, created_at)
     VALUES ${values.join(', ')}`,
    params
  );
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
    const dup = await one(
      `SELECT id FROM messages
        WHERE message_id = $1
          AND account_id = $2
          AND direction = $3`,
      [messageId, acc.id, dir]
    );
    if (dup) {
      // Backfill attachments onto a message we already stored without them.
      // Anything synced before the inbound attachment fixes (the
      // hasAttachments-gate removal + $value-for-all in graph.js) was ingested
      // with zero attachment rows, and this dup short-circuit would otherwise
      // skip it forever. A rescan (accounts.js /rescan-all clears the delta
      // cursor, re-walking every message) now self-heals those rows here.
      // Guarded so it only fires when the stored row has NO attachments and we
      // now have some — it never duplicates rows or re-touches complete ones.
      const incoming = (Array.isArray(parsed.attachments) ? parsed.attachments : [])
        .filter(a => a.content);
      if (incoming.length) {
        const have = await one(
          'SELECT COUNT(*)::int AS n FROM attachments WHERE message_id = $1',
          [dup.id]
        );
        if (have && have.n === 0) {
          await insertAttachmentRows(dup.id, acc.workspace_id, incoming);
          await query('UPDATE messages SET has_attachments = 1 WHERE id = $1', [dup.id]);
          console.log(`[ingest] backfilled ${incoming.length} attachment(s) onto existing message ${messageId} (${acc.email})`);
        }
      }
      return false;
    }
  }

  const threadId = await findOrCreateThread(acc.workspace_id, parsed, acc.team_space_id, acc.id);
  const id = uuid();
  const sentAt = parsed.date ? new Date(parsed.date).getTime() : Date.now();
  const attachments = Array.isArray(parsed.attachments) ? parsed.attachments : [];
  const hasAtt = attachments.length > 0 ? 1 : 0;

  await query(
    `INSERT INTO messages
      (id, thread_id, account_id, workspace_id, direction, folder, message_id, in_reply_to,
       subject, from_addr, to_addrs, cc_addrs, body_text, body_html, sent_at, imap_uid,
       has_attachments, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
    [
      id, threadId, acc.id, acc.workspace_id, dir, folder || null, messageId || null,
      (parsed.inReplyTo || '').replace(/[<>]/g, '') || null,
      parsed.subject || '',
      fromAddr,
      normalizeAddrList(parsed.to),
      normalizeAddrList(parsed.cc),
      parsed.text || '',
      parsed.html || '',
      sentAt, uid, hasAtt, Date.now()
    ]
  );

  await insertAttachmentRows(id, acc.workspace_id, attachments.filter(a => a.content));

  // Update thread search text + bump last_message_at.
  const searchAdd = [
    parsed.subject || '',
    fromAddr,
    normalizeAddrList(parsed.to),
    normalizeAddrList(parsed.cc),
    (parsed.text || '').slice(0, 4000)
  ].filter(Boolean).join(' ');

  // Split into two updates so a tsvector overflow on the GIN index can't
  // abort ingestMessage. The non-search fields always succeed; search_text
  // is best-effort via appendThreadSearchText.
  await query(
    `UPDATE threads SET last_message_at = $1,
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

async function syncAccount(accountId) {
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
    client = await buildClient(acc);
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
      try { await syncAccount(accountId); } catch (e) { console.error('idle sync', e.message); }
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
  const rows = await many('SELECT id FROM email_accounts');
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
      const rows = await many('SELECT id, email FROM email_accounts');
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
  ingestMessage, recordSyncError, getAccount
};
