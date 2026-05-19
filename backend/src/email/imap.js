const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { v4: uuid } = require('uuid');
const { one, many, query } = require('../db');
const { decrypt } = require('../crypto');
const { emitToWorkspace } = require('../sockets');
const ms = require('../oauth/microsoft');

const watchers = new Map();

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

async function findOrCreateThread(workspace_id, parsed, team_space_id) {
  const inReply = (parsed.inReplyTo || '').replace(/[<>]/g, '').trim() || null;
  const refs = (parsed.references ? (Array.isArray(parsed.references) ? parsed.references : [parsed.references]) : [])
    .map(r => r.replace(/[<>]/g, '').trim()).filter(Boolean);

  const candidates = [inReply, ...refs].filter(Boolean);
  for (const mid of candidates) {
    const m = await one(
      'SELECT thread_id FROM messages WHERE message_id = $1 AND workspace_id = $2',
      [mid, workspace_id]
    );
    if (m) return m.thread_id;
  }

  const subject = (parsed.subject || '').trim();
  const cleanSubj = subject.replace(/^(re|fwd|fw)\s*:\s*/i, '').trim();
  if (cleanSubj) {
    const t = await one(
      `SELECT id FROM threads WHERE workspace_id = $1 AND subject = $2
       ORDER BY last_message_at DESC LIMIT 1`,
      [workspace_id, cleanSubj]
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

async function ingestMessage(acc, uid, folder, parsed, direction) {
  const messageId = (parsed.messageId || '').replace(/[<>]/g, '');
  if (messageId) {
    const dup = await one(
      'SELECT id FROM messages WHERE message_id = $1 AND workspace_id = $2',
      [messageId, acc.workspace_id]
    );
    if (dup) return false;
  }

  const threadId = await findOrCreateThread(acc.workspace_id, parsed, acc.team_space_id);
  const id = uuid();
  const sentAt = parsed.date ? new Date(parsed.date).getTime() : Date.now();
  const fromAddr = parsed.from ? parsed.from.text : '';
  const fromAddrLower = (parsed.from && parsed.from.value && parsed.from.value[0] && parsed.from.value[0].address || '').toLowerCase();
  // If caller didn't pre-decide direction, infer from From: header.
  const dir = direction || (fromAddrLower === acc.email.toLowerCase() ? 'outbound' : 'inbound');
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

  for (const att of attachments) {
    if (!att.content) continue;
    const aid = uuid();
    await query(
      `INSERT INTO attachments
        (id, message_id, workspace_id, filename, content_type, size_bytes, content_id, data, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        aid, id, acc.workspace_id,
        att.filename || 'attachment',
        att.contentType || 'application/octet-stream',
        att.size || (att.content && att.content.length) || 0,
        (att.cid || '').replace(/[<>]/g, '') || null,
        att.content,
        Date.now()
      ]
    );
  }

  // Update thread search text + bump last_message_at.
  const searchAdd = [
    parsed.subject || '',
    fromAddr,
    normalizeAddrList(parsed.to),
    normalizeAddrList(parsed.cc),
    (parsed.text || '').slice(0, 4000)
  ].filter(Boolean).join(' ');

  await query(
    `UPDATE threads SET last_message_at = $1,
       status = CASE WHEN status = 'closed' AND $4 = 'inbound' THEN 'open' ELSE status END,
       snoozed_until = CASE WHEN $4 = 'inbound' THEN NULL ELSE snoozed_until END,
       search_text = coalesce(search_text, '') || ' ' || $2
     WHERE id = $3`,
    [sentAt, searchAdd, threadId, dir]
  );

  emitToWorkspace(acc.workspace_id, 'thread:updated', { thread_id: threadId });
  emitToWorkspace(acc.workspace_id, 'message:new', { thread_id: threadId, message_id: id });
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
  // Returns a tuple: { inbox, sent } using IMAP SPECIAL-USE flags when available.
  const list = await client.list();
  let inbox = 'INBOX';
  let sent = null;
  for (const box of list) {
    const flags = (box.flags && Array.from(box.flags)) || [];
    const su = (box.specialUse || '').toLowerCase();
    if (box.path === 'INBOX') inbox = 'INBOX';
    if (su === '\\sent' || flags.includes('\\Sent')) sent = box.path;
  }
  // Common fallbacks if SPECIAL-USE isn't reported.
  if (!sent) {
    const candidates = ['Sent', 'Sent Mail', 'Sent Items', '[Gmail]/Sent Mail', 'INBOX.Sent'];
    for (const c of candidates) {
      if (list.find(b => b.path === c)) { sent = c; break; }
    }
  }
  return { inbox, sent };
}

async function syncFolder(client, acc, folder, direction) {
  const mb = await client.mailboxOpen(folder);
  const currentValidity = mb && mb.uidValidity != null ? String(mb.uidValidity) : null;
  const uidNext = mb && mb.uidNext != null ? Number(mb.uidNext) : null;

  let { lastUid, uidValidity: storedValidity } = await getFolderState(acc.id, folder);

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

  let count = 0;
  let maxUid = lastUid;
  const range = `${lastUid + 1}:*`;
  for await (const msg of client.fetch(range, { uid: true, source: true })) {
    if (!msg.source) continue;
    const parsed = await simpleParser(msg.source);
    const ok = await ingestMessage(acc, msg.uid, folder, parsed, direction);
    if (ok) count++;
    if (msg.uid > maxUid) maxUid = msg.uid;
  }
  if (maxUid > lastUid || currentValidity !== storedValidity) {
    await setFolderState(acc.id, folder, maxUid, currentValidity);
  }
  return count;
}

async function syncAccount(accountId) {
  const acc = await getAccount(accountId);
  if (!acc) return 0;
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
    const { inbox, sent } = await detectFolders(client);
    if (sent && sent !== acc.sent_folder) {
      await query('UPDATE email_accounts SET sent_folder = $1 WHERE id = $2', [sent, acc.id]);
      acc.sent_folder = sent;
    }
    count += await syncFolder(client, acc, inbox, 'inbound');
    if (sent) {
      try { count += await syncFolder(client, acc, sent, 'outbound'); }
      catch (e) { console.warn('sent folder sync failed for', acc.email, '-', e.message); }
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

async function startWatching(accountId) {
  if (watchers.has(accountId)) return;
  const acc = await getAccount(accountId);
  if (!acc) return;
  let client;
  try {
    client = await buildClient(acc);
  } catch (e) {
    console.error('buildClient failed for', acc.email, '-', e.message);
    return;
  }
  watchers.set(accountId, client);

  // Without an 'error' listener, ImapFlow's long-lived IDLE socket emits
  // unhandled 'error' on TCP timeout (NAT eviction, server-side idle limit)
  // and crashes the whole Node process via uncaughtException. Catching it
  // here drops the dead watcher; the 2-min cron poll keeps the account in
  // sync until the next process restart re-attaches a fresh watcher.
  client.on('error', (err) => {
    console.warn('watcher socket error for', acc.email, '-', err && err.message);
    watchers.delete(accountId);
  });

  try {
    await client.connect();
    await client.mailboxOpen('INBOX');
    client.on('exists', async () => {
      try { await syncAccount(accountId); } catch (e) { console.error('idle sync', e.message); }
    });
  } catch (e) {
    console.error('watch error', e.message);
    watchers.delete(accountId);
  }
}

function stopWatching(accountId) {
  const c = watchers.get(accountId);
  if (c) {
    try { c.logout(); } catch {}
    watchers.delete(accountId);
  }
}

async function startAllWatchers() {
  const rows = await many('SELECT id FROM email_accounts');
  for (const r of rows) {
    startWatching(r.id).catch(() => {});
  }
}

module.exports = {
  syncAccount, startWatching, stopWatching, startAllWatchers,
  appendToSentFolder
};
