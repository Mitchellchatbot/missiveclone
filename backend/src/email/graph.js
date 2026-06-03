const ms = require('../oauth/microsoft');

const GRAPH_SCOPE = 'https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Mail.ReadWrite offline_access';
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

// Find the Graph message id for a given RFC Message-ID header value, by
// searching Inbox + Sent across the mailbox. Returns null if not found
// (e.g. the parent message hasn't synced into the mailbox yet, or it
// originated from an account we can't query).
async function findGraphMessageIdByInternetId(token, internetMessageId) {
  if (!internetMessageId) return null;
  // Graph's internetMessageId includes the angle brackets in the stored
  // value. Strip whatever the caller passed in and re-wrap.
  const id = String(internetMessageId).replace(/^<|>$/g, '');
  // Single quotes inside an OData literal are escaped by doubling.
  const escapedForOData = id.replace(/'/g, "''");
  const filter = `internetMessageId eq '<${escapedForOData}>'`;
  const url =
    `${GRAPH_BASE}/me/messages?$filter=${encodeURIComponent(filter)}` +
    `&$select=id,conversationId&$top=1`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.warn(`[graph] findGraphMessageIdByInternetId(${id}) failed: ${res.status} ${detail.slice(0, 200)}`);
      return null;
    }
    const data = await res.json();
    const first = (data.value && data.value[0]) || null;
    if (!first) {
      console.warn(`[graph] findGraphMessageIdByInternetId(${id}) → 0 matches`);
    }
    return first ? first.id : null;
  } catch (err) {
    console.warn(`[graph] findGraphMessageIdByInternetId(${id}) threw: ${err.message}`);
    return null;
  }
}

// Parse "Name <addr>, addr2, addr3" into Graph's recipient shape.
function parseAddresses(s) {
  if (!s) return [];
  const parts = String(s).split(',').map(a => a.trim()).filter(Boolean);
  return parts.map(a => {
    const m = a.match(/(.*)<([^>]+)>/);
    if (m) {
      return {
        emailAddress: {
          name: m[1].trim().replace(/^"|"$/g, ''),
          address: m[2].trim()
        }
      };
    }
    return { emailAddress: { address: a } };
  });
}

/**
 * Send an email via Microsoft Graph (POST /me/sendMail).
 * Works with OAuth tokens directly — no SMTP, no SMTP AUTH tenant setting.
 *
 * Trade-offs vs SMTP:
 *   - Per-message attachment limit ~3 MB (use upload sessions for larger).
 *   - saveToSentItems: true makes Microsoft auto-save to the Sent folder.
 *   - Graph doesn't expose the resulting Internet Message-ID synchronously,
 *     so callers should not rely on it for threading state. The IMAP sync
 *     will pick up the sent message a moment later anyway.
 */
async function sendEmailViaGraph(account, mail) {
  const token = await ms.getAccessTokenForResource(account, GRAPH_SCOPE);
  const attachments = buildAttachments(mail.attachments);
  const tag = `[graph ${account.email}]`;

  // Threading via Graph requires the `createReply` action, not raw
  // `sendMail` with In-Reply-To headers — Graph silently ignores RFC
  // threading headers and ALWAYS creates a new conversationId on
  // /sendMail, which makes Outlook show the result as a fresh thread.
  if (mail.inReplyTo) {
    const parentId = await findGraphMessageIdByInternetId(token, mail.inReplyTo);
    if (parentId) {
      console.log(`${tag} reply → parent ${parentId} (inReplyTo=${mail.inReplyTo})`);
      return sendAsReplyViaGraph(token, parentId, mail, attachments, tag);
    }
    console.warn(`${tag} reply → parent NOT FOUND for inReplyTo=${mail.inReplyTo}; falling back to draft-send (no thread inheritance)`);
  } else {
    console.log(`${tag} new outbound (no inReplyTo)`);
  }
  return sendAsDraftViaGraph(token, mail, attachments, tag);
}

// Draft-then-send for new outbound (no parent). Returns the draft's
// internetMessageId so subsequent replies in the thread can locate it.
// Using create-draft + send instead of plain /me/sendMail because the
// latter returns 202 with no id — we'd lose track of our own outbound.
async function sendAsDraftViaGraph(token, mail, attachments, tag = '[graph]') {
  const message = {
    subject: mail.subject || '',
    body: {
      contentType: mail.html ? 'HTML' : 'Text',
      content: mail.html || mail.text || ''
    },
    toRecipients: parseAddresses(mail.to),
    ccRecipients: parseAddresses(mail.cc),
    bccRecipients: parseAddresses(mail.bcc)
  };

  // 1) Create draft. Graph returns the Message resource with both id +
  //    internetMessageId populated.
  const draftRes = await fetch(`${GRAPH_BASE}/me/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(message)
  });
  await assertGraphOk(draftRes, 201, 'create draft');
  const draft = await draftRes.json();
  const draftId = draft.id;
  const internetMessageId = stripBrackets(draft.internetMessageId);

  // 2) Attach files after creation so large ones can use an upload session
  //    (inlining them in the create body caps out at Graph's ~3 MB limit).
  if (attachments.length) await addAttachmentsToDraft(token, draftId, attachments, tag);

  // 3) Send.
  const sendRes = await fetch(
    `${GRAPH_BASE}/me/messages/${encodeURIComponent(draftId)}/send`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}` } }
  );
  await assertGraphOk(sendRes, 202, 'send draft');
  console.log(`${tag} sent draft ${draftId} (internetMessageId=${internetMessageId || 'unknown'})`);

  return {
    messageId: internetMessageId || null,
    accepted: parseAddresses(mail.to).map(r => r.emailAddress.address)
  };
}

// createReply -> patch -> send. Inherits the parent's conversationId so
// Outlook threads the reply with the original message.
async function sendAsReplyViaGraph(token, parentMessageId, mail, attachments, tag = '[graph reply]') {
  // 1) Create the draft reply. Graph returns a full Message resource
  //    with conversationId inherited from the parent.
  const draftRes = await fetch(
    `${GRAPH_BASE}/me/messages/${encodeURIComponent(parentMessageId)}/createReply`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}` } }
  );
  await assertGraphOk(draftRes, 201, 'createReply');
  const draft = await draftRes.json();
  const draftId = draft.id;

  // 2) PATCH the draft with our body + recipient overrides.
  const patch = {
    subject: mail.subject || draft.subject,
    body: {
      contentType: mail.html ? 'HTML' : 'Text',
      content: mail.html || mail.text || ''
    },
    toRecipients: parseAddresses(mail.to),
    ccRecipients: parseAddresses(mail.cc),
    bccRecipients: parseAddresses(mail.bcc)
  };
  const patchRes = await fetch(`${GRAPH_BASE}/me/messages/${encodeURIComponent(draftId)}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(patch)
  });
  await assertGraphOk(patchRes, 200, 'PATCH reply draft');

  if (attachments.length) await addAttachmentsToDraft(token, draftId, attachments, tag);

  // 3) Re-read the draft so we get the post-PATCH internetMessageId
  //    (sometimes Graph regenerates it after subject/body changes).
  const getRes = await fetch(
    `${GRAPH_BASE}/me/messages/${encodeURIComponent(draftId)}?$select=internetMessageId,conversationId`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  let internetMessageId = stripBrackets(draft.internetMessageId);
  if (getRes.ok) {
    const fresh = await getRes.json();
    if (fresh.internetMessageId) internetMessageId = stripBrackets(fresh.internetMessageId);
  }

  // 4) Send.
  const sendRes = await fetch(
    `${GRAPH_BASE}/me/messages/${encodeURIComponent(draftId)}/send`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}` } }
  );
  await assertGraphOk(sendRes, 202, 'send reply draft');
  console.log(`${tag} sent reply draft ${draftId} (internetMessageId=${internetMessageId || 'unknown'})`);

  return {
    messageId: internetMessageId || null,
    accepted: parseAddresses(mail.to).map(r => r.emailAddress.address)
  };
}

function stripBrackets(v) {
  if (!v) return null;
  return String(v).replace(/^<|>$/g, '');
}

// Graph rejects an attachment added in a single request (inline in the
// message JSON, or POSTed to /attachments) once it exceeds ~3 MB. Anything
// larger has to go through an upload session (chunked PUTs). We split on
// this boundary in addAttachmentsToDraft.
const GRAPH_ATTACHMENT_INLINE_LIMIT = 3 * 1024 * 1024;

// Largest chunk we PUT per upload-session request. Graph requires every
// chunk except the last to be a multiple of 320 KiB and recommends staying
// at/under 4 MB; 3.75 MB (320 KiB × 12) satisfies both.
const GRAPH_UPLOAD_CHUNK = 320 * 1024 * 12;

// Normalize the wire attachment shape ({ filename, content, content_type,
// size }) into { name, contentType, buffer }. No size cap here — large
// files are handled via upload sessions when they're attached to a draft.
function buildAttachments(rawAttachments) {
  const list = Array.isArray(rawAttachments) ? rawAttachments : [];
  if (!list.length) return [];
  return list.map(a => ({
    name: a.filename || 'attachment',
    contentType: a.content_type || 'application/octet-stream',
    buffer: Buffer.isBuffer(a.content)
      ? a.content
      : Buffer.from(a.content || '')
  }));
}

// Shape a normalized attachment as a Graph fileAttachment for single-request
// (inline) upload.
function toFileAttachment(att) {
  return {
    '@odata.type': '#microsoft.graph.fileAttachment',
    name: att.name,
    contentType: att.contentType,
    contentBytes: att.buffer.toString('base64')
  };
}

// Attach every file to an already-created draft. Small files go in a single
// POST /attachments; files over the inline limit go through an upload
// session so we can send screenshots, PDFs, etc. up to Graph's 150 MB cap.
async function addAttachmentsToDraft(token, draftId, attachments, tag) {
  for (const att of attachments) {
    if (att.buffer.length <= GRAPH_ATTACHMENT_INLINE_LIMIT) {
      const aRes = await fetch(
        `${GRAPH_BASE}/me/messages/${encodeURIComponent(draftId)}/attachments`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(toFileAttachment(att))
        }
      );
      await assertGraphOk(aRes, 201, 'attach to draft');
    } else {
      await uploadAttachmentViaSession(token, draftId, att, tag);
    }
  }
}

// Upload a large attachment to a draft via Graph's upload-session protocol:
// open a session, then PUT the bytes in chunks with Content-Range headers.
// The session uploadUrl is pre-authorized, so chunk PUTs must NOT carry the
// Authorization header.
async function uploadAttachmentViaSession(token, draftId, att, tag = '[graph]') {
  const total = att.buffer.length;
  const sessionRes = await fetch(
    `${GRAPH_BASE}/me/messages/${encodeURIComponent(draftId)}/attachments/createUploadSession`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        AttachmentItem: {
          attachmentType: 'file',
          name: att.name,
          contentType: att.contentType,
          size: total
        }
      })
    }
  );
  await assertGraphOk(sessionRes, 201, 'create attachment upload session');
  const { uploadUrl } = await sessionRes.json();
  if (!uploadUrl) throw new Error('Graph create attachment upload session: no uploadUrl returned');

  for (let start = 0; start < total; start += GRAPH_UPLOAD_CHUNK) {
    const end = Math.min(start + GRAPH_UPLOAD_CHUNK, total) - 1;
    const chunk = att.buffer.subarray(start, end + 1);
    const putRes = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Length': String(chunk.length),
        'Content-Range': `bytes ${start}-${end}/${total}`
      },
      body: chunk
    });
    // Intermediate chunks return 200 (with nextExpectedRanges); the final
    // chunk returns 201 Created (the attachment resource). Anything else is
    // a failure.
    if (putRes.status !== 200 && putRes.status !== 201) {
      const detail = await putRes.text().catch(() => '');
      throw new Error(
        `Graph attachment upload chunk failed (bytes ${start}-${end}/${total}): ` +
        `${putRes.status} ${detail.slice(0, 200)}`
      );
    }
  }
  console.log(`${tag} uploaded large attachment "${att.name}" (${(total / 1024 / 1024).toFixed(1)} MB) via session`);
}

async function assertGraphOk(res, expectedStatus, op) {
  if (res.status === expectedStatus) return;
  let bodyText = '';
  try { bodyText = await res.text(); } catch { /* ignore */ }
  let parsed;
  try { parsed = JSON.parse(bodyText); } catch { /* ignore */ }
  const detail = (parsed && parsed.error && parsed.error.message) || bodyText || `HTTP ${res.status}`;
  let hint = '';
  if (res.status === 401 || res.status === 403) {
    hint = ' Token may be missing the Mail.Send / Mail.ReadWrite Graph permission. ' +
           'Reconnect this Microsoft account and admin-consent both scopes.';
  } else if (res.status === 429) {
    hint = ' Rate-limited by Graph. Try again in a minute.';
  }
  throw new Error(`Graph ${op} failed: ${detail}${hint}`);
}

// ────────────────────────────────────────────────────────────────────────
// Graph-based inbound sync. Replaces IMAP for Microsoft accounts.
//
// Why: outlook.office365.com:993 throttles aggressively under any kind of
// fleet load — once we held ~14 mailboxes on one Railway egress IP every
// mailbox got "Connection not available" on IMAP, leaving Mitchell and
// 13 others permanently unable to do an initial sync. Graph has its own
// rate limits but they're per-user (not per-IP), it never requires the
// tenant admin to flip an IMAP-enabled toggle per user, and Microsoft is
// deprecating Basic Auth + IMAP-OAuth entirely.
//
// Architecture: each call to syncAccountViaGraph runs a delta query on
// the inbox and sent-items folders. Microsoft returns @odata.nextLink
// for pagination and @odata.deltaLink at the end of the stream; we
// persist that deltaLink in folder_sync_state.delta_link so the next
// poll only fetches *changes* since the last call. Initial sync (no
// deltaLink yet) walks the full mailbox once, paginated.
// ────────────────────────────────────────────────────────────────────────

const GRAPH_SYNC_SCOPE =
  'https://graph.microsoft.com/Mail.ReadWrite offline_access';

// Fields fetched per message. internetMessageHeaders is required for
// threading via In-Reply-To / References (same path IMAP uses). body is
// requested in HTML — we keep both bodyPreview (always populated by
// Graph) as the text fallback.
const MSG_SELECT = [
  'id',
  'internetMessageId',
  'subject',
  'from',
  'toRecipients',
  'ccRecipients',
  'bccRecipients',
  'body',
  'bodyPreview',
  'receivedDateTime',
  'sentDateTime',
  'hasAttachments',
  'internetMessageHeaders',
  'isDraft',
  'conversationId'
].join(',');

// Fetch helper — adds Authorization header, throws on non-2xx with the
// Graph error body inlined so callers can log a useful diagnostic. 410
// (Gone) is the special "deltaLink expired" signal; we surface that as
// an .expired flag rather than throwing.
async function graphGet(url, token) {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      // Without this, Graph returns Internet headers in lowercased form
      // which mailparser-style consumers wouldn't recognize.
      Prefer: 'outlook.body-content-type="html"'
    }
  });
  if (res.status === 410) {
    return { expired: true, status: 410 };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let parsed;
    try { parsed = JSON.parse(text); } catch { /* ignore */ }
    const detail = (parsed && parsed.error && parsed.error.message) || text || `HTTP ${res.status}`;
    const err = new Error(`Graph GET ${url.split('?')[0]} → ${res.status}: ${detail.slice(0, 300)}`);
    err.status = res.status;
    err.body = parsed || null;
    throw err;
  }
  return await res.json();
}

// Turn a single Graph message + (optional, separately-fetched) attachments
// array into the mailparser-shaped object ingestMessage expects. We don't
// invoke mailparser here — Graph already gave us structured fields.
function graphToParsed(msg, attachments) {
  // Pull RFC headers off internetMessageHeaders so RFC-based threading
  // (the only kind that's safe across accounts) keeps working.
  const headers = Array.isArray(msg.internetMessageHeaders) ? msg.internetMessageHeaders : [];
  const headerVal = (name) => {
    const h = headers.find(h => h.name && h.name.toLowerCase() === name.toLowerCase());
    return h ? h.value : null;
  };
  const inReplyTo = headerVal('In-Reply-To') || null;
  const references = headerVal('References') || null;
  const referencesArr = references
    ? references.split(/\s+/).map(s => s.trim()).filter(Boolean)
    : [];

  const fromAddr = msg.from && msg.from.emailAddress
    ? {
        text: msg.from.emailAddress.name
          ? `${msg.from.emailAddress.name} <${msg.from.emailAddress.address}>`
          : msg.from.emailAddress.address,
        value: [{ name: msg.from.emailAddress.name || '', address: msg.from.emailAddress.address || '' }]
      }
    : null;

  const toRecipientsToList = (list) => {
    if (!Array.isArray(list) || list.length === 0) return null;
    const text = list
      .map(r => r.emailAddress && (r.emailAddress.name
        ? `${r.emailAddress.name} <${r.emailAddress.address}>`
        : r.emailAddress.address))
      .filter(Boolean)
      .join(', ');
    return text ? { text } : null;
  };

  const bodyContent = (msg.body && msg.body.content) || '';
  const bodyType = (msg.body && msg.body.contentType || '').toLowerCase();
  const html = bodyType === 'html' ? bodyContent : '';
  const text = bodyType === 'text' ? bodyContent : (msg.bodyPreview || '');

  // Microsoft strips angle brackets from internetMessageId in storage but
  // adds them back on read. Either way ingestMessage strips them, so
  // pass through as-is.
  const messageId = msg.internetMessageId || '';

  const date = msg.receivedDateTime
    ? new Date(msg.receivedDateTime)
    : (msg.sentDateTime ? new Date(msg.sentDateTime) : new Date());

  return {
    messageId,
    inReplyTo,
    references: referencesArr,
    subject: msg.subject || '',
    from: fromAddr,
    to: toRecipientsToList(msg.toRecipients),
    cc: toRecipientsToList(msg.ccRecipients),
    bcc: toRecipientsToList(msg.bccRecipients),
    text,
    html,
    date,
    attachments: attachments || [],
    // Surface conversationId so future enhancements can use Microsoft's
    // own thread grouping if RFC-based grouping ever loses a candidate.
    _graphConversationId: msg.conversationId || null
  };
}

// Pull all attachments for a message and shape them like mailparser does
// — { filename, contentType, size, cid, content (Buffer) }. fileAttachment
// is the only common type; itemAttachment (nested message) and
// referenceAttachment (OneDrive link) are exotic enough to skip for now.
async function fetchAttachmentsForMessage(token, messageGraphId) {
  const base =
    `${GRAPH_BASE}/me/messages/${encodeURIComponent(messageGraphId)}/attachments`;

  // 1) List attachment metadata only — NOT the bytes. We deliberately do
  //    NOT use $expand=microsoft.graph.fileAttachment/contentBytes: Graph
  //    omits contentBytes from the collection for files larger than ~3 MB,
  //    so expanding it can't be relied on and silently dropped large
  //    attachments. Keep the list lean; fetch bytes per-item below.
  const list = await graphGet(
    `${base}?$select=id,name,contentType,size,contentId,isInline`,
    token
  );

  const out = [];
  for (const meta of (list.value || [])) {
    // 2) Fetch each attachment individually. A single-attachment GET returns
    //    the full resource — @odata.type plus, for a fileAttachment,
    //    contentBytes regardless of size (up to Graph's 150 MB cap). This is
    //    the ONLY method that reliably yields bytes for large attachments;
    //    the collection endpoint won't.
    let full;
    try {
      full = await graphGet(`${base}/${encodeURIComponent(meta.id)}`, token);
    } catch (e) {
      console.warn(`[graph] attachment ${meta.id} fetch failed: ${e.message}`);
      continue;
    }
    // fileAttachment is the only type that carries bytes. itemAttachment
    // (a nested message) and referenceAttachment (a cloud-storage link)
    // have no contentBytes — skip them.
    if (full['@odata.type'] !== '#microsoft.graph.fileAttachment') continue;
    if (!full.contentBytes) continue;

    out.push({
      filename: full.name || 'attachment',
      contentType: full.contentType || 'application/octet-stream',
      size: full.size || 0,
      cid: full.contentId || '',
      content: Buffer.from(full.contentBytes, 'base64')
    });
  }
  return out;
}

// Walk one Graph folder via delta. Returns { count, deltaLink } so the
// caller can persist the new resume cursor only AFTER all pages
// ingested cleanly. If a page mid-walk throws (network blip, ingest
// error), we keep the OLD deltaLink and the next poll re-fetches from
// the previous good point — message_id dedup makes that idempotent.
//
// `folderPath` is Graph's well-known name ('inbox' | 'sentitems') used
// in the URL + folder_sync_state key. `folderLabel` is the value
// written into messages.folder — it must match what the IMAP path
// would have written (and what DelegationDoer's threads filter
// queries against), e.g. 'INBOX' uppercase. The two diverge because
// Graph URLs are lowercase but DD's UI filter is IMAP-flavored.
async function syncFolderViaGraph(account, folderPath, direction, folderLabel) {
  const { ingestMessage } = require('./imap');
  const db = require('../db');

  // Refresh the token once at the top of the folder walk. A walk may
  // take many seconds; if Graph hands us back a long stream we don't
  // want the token to expire mid-stream. ensureFreshAccessToken on the
  // IMAP path does the same thing.
  let token = await ms.getAccessTokenForResource(account, GRAPH_SYNC_SCOPE);

  const stored = await db.one(
    'SELECT delta_link FROM folder_sync_state WHERE account_id = $1 AND folder = $2',
    [account.id, folderPath]
  );
  let url = stored && stored.delta_link
    ? stored.delta_link
    : `${GRAPH_BASE}/me/mailFolders/${encodeURIComponent(folderPath)}/messages/delta?$select=${MSG_SELECT}&$top=50`;

  let count = 0;
  let lastDeltaLink = null;
  let pageNum = 0;
  // Safety brake: 200 pages × 50 messages = 10k per folder per call,
  // enough headroom for an initial sync but bounded enough that a runaway
  // pagination loop can't hang the worker forever.
  const MAX_PAGES = 200;

  while (url && pageNum < MAX_PAGES) {
    pageNum += 1;
    let page;
    try {
      page = await graphGet(url, token);
    } catch (e) {
      // 401 mid-walk usually means the token aged out past its expiry
      // (rare given we just minted it, but Graph sometimes invalidates
      // out of band). Re-mint once and retry the same URL.
      if (e.status === 401) {
        token = await ms.getAccessTokenForResource(account, GRAPH_SYNC_SCOPE);
        page = await graphGet(url, token);
      } else {
        throw e;
      }
    }
    if (page.expired) {
      // deltaLink expired — Microsoft drops the cursor after long gaps
      // (28 days default). Clear it and restart from scratch on the
      // next call. Don't try to recover inline; just stop and let the
      // next poll do a fresh initial sync.
      console.warn(`[graph] delta cursor expired for ${account.email}/${folderPath} — clearing and restarting next poll`);
      await db.query(
        `UPDATE folder_sync_state SET delta_link = NULL
           WHERE account_id = $1 AND folder = $2`,
        [account.id, folderPath]
      );
      return { count: 0, restarted: true };
    }

    const messages = Array.isArray(page.value) ? page.value : [];
    for (const m of messages) {
      // Skip drafts — Outlook stores in-progress drafts in the inbox/sent
      // folders' delta stream, but they're not "real" mail.
      if (m.isDraft) continue;
      // @removed marks a deletion in delta semantics. We currently don't
      // mirror Outlook deletions (would require tombstoning local rows),
      // so skip and move on. Same as IMAP path's behavior.
      if (m['@removed']) continue;

      let attachments = [];
      if (m.hasAttachments) {
        try {
          attachments = await fetchAttachmentsForMessage(token, m.id);
        } catch (e) {
          // One bad attachment fetch shouldn't strand the whole message.
          // Log and continue with empty attachments — the message body
          // still goes in and the user can re-fetch the attachment via
          // a "redownload" path later if needed.
          console.warn(`[graph] attachment fetch failed for ${m.id} (${account.email}): ${e.message}`);
        }
        // Diagnostic: a message Graph flagged hasAttachments that yields 0
        // stored attachments means the fetch dropped them. Seeing this line
        // at all also confirms THIS build (not an older deploy) is running.
        console.log(`[graph] ${account.email} ${folderLabel}: hasAttachments msg → fetched ${attachments.length} attachment(s)`);
      }

      const parsed = graphToParsed(m, attachments);
      try {
        const ok = await ingestMessage(account, /* uid */ 0, folderLabel, parsed, direction);
        if (ok) count += 1;
      } catch (e) {
        // Don't let one corrupt message kill the whole folder walk. Log
        // and move on. The delta link we'd save still covers this message
        // so we won't retry forever — caller can re-fetch by clearing
        // the delta link manually if a fix lands.
        console.warn(`[graph] ingest failed for ${m.id} (${account.email}): ${e.message}`);
      }
    }

    if (page['@odata.nextLink']) {
      url = page['@odata.nextLink'];
      continue;
    }
    if (page['@odata.deltaLink']) {
      lastDeltaLink = page['@odata.deltaLink'];
    }
    url = null;
  }

  // Resume-cursor selection:
  //   - Got a deltaLink → save it. Next poll picks up changes only.
  //   - Hit MAX_PAGES without deltaLink → save the unconsumed nextLink so
  //     the next poll continues the initial sync where we left off.
  //   - Neither (rare empty mailbox initial state) → leave previous
  //     cursor alone.
  if (!lastDeltaLink && pageNum >= MAX_PAGES && url) {
    console.warn(`[graph] folder walk hit MAX_PAGES for ${account.email}/${folderPath} — saving nextLink to resume`);
    lastDeltaLink = url;
  }

  // Persist resume cursor — only if we got one and only at the very end.
  if (lastDeltaLink) {
    await db.query(
      `INSERT INTO folder_sync_state (account_id, folder, last_sync_uid, delta_link, uid_validity)
       VALUES ($1, $2, 0, $3, NULL)
       ON CONFLICT (account_id, folder)
       DO UPDATE SET delta_link = EXCLUDED.delta_link`,
      [account.id, folderPath, lastDeltaLink]
    );
  }

  return { count, deltaLink: lastDeltaLink };
}

async function syncAccountViaGraph(account) {
  const { recordSyncError } = require('./imap');
  const db = require('../db');

  // Microsoft uses fixed well-known names for the inbox + sent folders;
  // no need to detect them like IMAP requires.
  let totalCount = 0;
  try {
    // folderLabel is what gets written into messages.folder. Match what
    // the IMAP path produced ('INBOX' uppercase) so DelegationDoer's
    // INBOX-folder filter on threads picks up Graph-synced messages.
    // Sent-folder filtering in DD uses direction='outbound' (not folder
    // name), so the sent label is cosmetic — keep it readable.
    const inbox = await syncFolderViaGraph(account, 'inbox', 'inbound', 'INBOX');
    totalCount += inbox.count || 0;
    try {
      const sent = await syncFolderViaGraph(account, 'sentitems', 'outbound', 'Sent Items');
      totalCount += sent.count || 0;
    } catch (e) {
      // Sent-folder failure is non-fatal — inbox is the priority.
      console.warn(`[graph] sentitems sync failed for ${account.email}: ${e.message}`);
    }
    try {
      // Junk/Spam → DD's Spam view. folderLabel contains 'Junk' so
      // ingestMessage's spam guard keeps it out of the intake pipeline,
      // and DD's SPAM folder filter matches it via ILIKE '%junk%'.
      const junk = await syncFolderViaGraph(account, 'junkemail', 'inbound', 'Junk Email');
      totalCount += junk.count || 0;
    } catch (e) {
      // Junk-folder failure is non-fatal — inbox is the priority.
      console.warn(`[graph] junkemail sync failed for ${account.email}: ${e.message}`);
    }
    await db.query(
      `UPDATE email_accounts
         SET last_synced_at = $1, last_sync_error = NULL, last_sync_error_at = NULL
         WHERE id = $2`,
      [Date.now(), account.id]
    );
    return totalCount;
  } catch (e) {
    await recordSyncError(account.id, e);
    throw e;
  }
}

module.exports = { sendEmailViaGraph, syncAccountViaGraph };
