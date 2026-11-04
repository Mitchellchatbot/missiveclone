const ms = require('../oauth/microsoft');
const { parseStoredExtraFolders, extraFolderKey, FOLDER_ID_RE } = require('../util/extra_folders');

const GRAPH_SCOPE = 'https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Mail.ReadWrite offline_access';
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

// Cheap HTML → plaintext. Graph hands us the full body as HTML; we derive the
// text part from it ourselves (Graph's own bodyPreview is truncated to ~255
// chars). Mirrors the IMAP path, where mailparser supplies a full text part.
function htmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

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
// Accepts every separator real clients/users emit — commas, semicolons
// (Outlook's default), and bare whitespace between addresses — because the
// compose UI takes free-text To/Cc fields. Splitting only on commas made a
// space- or semicolon-separated list collapse into a single bogus recipient,
// which Graph rejects with "<the whole string> is not resolved. All
// recipients must be resolved before a message can be submitted."
function parseAddresses(s) {
  if (!s) return [];
  // Split on commas/semicolons first so a "Name <addr>" group stays intact —
  // a display name may legitimately contain spaces.
  const groups = String(s).split(/[,;]+/).map(a => a.trim()).filter(Boolean);
  const out = [];
  for (const g of groups) {
    const m = g.match(/(.*)<([^>]+)>/);
    if (m) {
      out.push({
        emailAddress: {
          name: m[1].trim().replace(/^"|"$/g, ''),
          address: m[2].trim()
        }
      });
    } else {
      // Bare address(es): one group may still hold several whitespace-
      // separated addresses (e.g. "a@x.com b@y.com"). Bare addresses can't
      // contain spaces, so splitting on whitespace here is safe.
      for (const addr of g.split(/\s+/).filter(Boolean)) {
        out.push({ emailAddress: { address: addr } });
      }
    }
  }
  return out;
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
  let internetMessageId = stripBrackets(draft.internetMessageId);

  // 2) Attach files after creation so large ones can use an upload session
  //    (inlining them in the create body caps out at Graph's ~3 MB limit).
  if (attachments.length) await addAttachmentsToDraft(token, draftId, attachments, tag);

  // 2b) Re-read internetMessageId right before sending, exactly as the reply
  //     path does: Graph can regenerate it after the draft changes. The id we
  //     return is stored on the compose row, and if it doesn't match the id on
  //     the Sent Items copy, ingest can't recognise that copy as the same email
  //     and stores it a second time. Read before the send, not after — once
  //     sent the draft moves to Sent Items and draftId may no longer resolve.
  //     Falls back to the create-time value.
  try {
    const getRes = await fetch(
      `${GRAPH_BASE}/me/messages/${encodeURIComponent(draftId)}?$select=internetMessageId`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (getRes.ok) {
      const fresh = await getRes.json();
      if (fresh.internetMessageId) internetMessageId = stripBrackets(fresh.internetMessageId);
    }
  } catch (e) {
    console.warn(`${tag} could not re-read internetMessageId for draft ${draftId}: ${e.message}`);
  }

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

  // createReply seeds the draft with the parent message's inline attachments
  // (e.g. the original sender's signature logo, embedded via cid:). We never
  // add the original's attachments deliberately, and we don't want them riding
  // along on our reply — so list and delete every attachment the draft was
  // born with before we add our own. Best-effort: a failure here must not block
  // the send.
  try {
    const inheritedRes = await fetch(
      `${GRAPH_BASE}/me/messages/${encodeURIComponent(draftId)}/attachments?$select=id`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (inheritedRes.ok) {
      const inherited = (await inheritedRes.json()).value || [];
      for (const att of inherited) {
        const delRes = await fetch(
          `${GRAPH_BASE}/me/messages/${encodeURIComponent(draftId)}/attachments/${encodeURIComponent(att.id)}`,
          { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }
        );
        if (!delRes.ok) console.warn(`${tag} could not delete inherited attachment ${att.id} (HTTP ${delRes.status})`);
      }
      if (inherited.length) console.log(`${tag} stripped ${inherited.length} createReply-inherited attachment(s) from draft ${draftId}`);
    } else {
      console.warn(`${tag} could not list draft attachments to strip inherited ones (HTTP ${inheritedRes.status})`);
    }
  } catch (e) {
    console.warn(`${tag} error stripping inherited attachments: ${e.message}`);
  }

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
//
// The uploadUrl Graph hands back is pre-authenticated: it points at the
// outlook.office.com host and carries its own `?authtoken=` JWT in the query
// string. The chunk PUTs must therefore send NO Authorization header — adding
// our graph.microsoft.com bearer token would be an audience mismatch and
// Graph answers it with a 401. (Microsoft docs: "Attach large files to
// Outlook messages" → "Do not specify an Authorization request header.")
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
    const contentRange = `bytes ${start}-${end}/${total}`;
    const putRes = await putUploadChunk(uploadUrl, chunk, contentRange, tag);
    // Intermediate chunks return 200 (with nextExpectedRanges); the final
    // chunk returns 201 Created (the attachment resource). Anything else is
    // a failure.
    if (putRes.status !== 200 && putRes.status !== 201) {
      const detail = await putRes.text().catch(() => '');
      // Surface the headers Outlook/Graph use to explain an auth failure so a
      // future regression isn't an opaque empty-body 401 again.
      const diag = [
        `www-authenticate=${putRes.headers.get('www-authenticate') || '-'}`,
        `x-ms-diagnostics=${putRes.headers.get('x-ms-diagnostics') || '-'}`,
        `request-id=${putRes.headers.get('request-id') || '-'}`
      ].join(' ');
      throw new Error(
        `Graph attachment upload chunk failed (${contentRange}): ` +
        `${putRes.status} ${detail.slice(0, 200)} [${diag}]`
      );
    }
  }
  console.log(`${tag} uploaded large attachment "${att.name}" (${(total / 1024 / 1024).toFixed(1)} MB) via session`);
}

// PUT one chunk to the pre-authenticated upload-session URL, driving redirects
// by hand.
//
// Why not let fetch follow them: Node's global fetch (undici) auto-follows
// 3xx, and the outlook.office.com attachment-session endpoint can redirect the
// PUT to a region-specific host. The redirect Location is a path that does NOT
// echo the `?authtoken=` query string the original uploadUrl carries, so when
// undici re-issues the request it arrives with no credential and Outlook
// answers with an empty-body 401 — the failure we saw in the field. We set
// `redirect: 'manual'`, then re-attach the authtoken before following so the
// next hop stays authenticated. (Verified: auto-follow 401s, manual+re-attach
// succeeds.)
async function putUploadChunk(uploadUrl, chunk, contentRange, tag = '[graph]') {
  let url = uploadUrl;
  for (let hop = 0; hop < 4; hop++) {
    const res = await fetch(url, {
      method: 'PUT',
      redirect: 'manual',
      // No Authorization header — the URL is pre-authenticated. Adding our
      // graph.microsoft.com bearer here is an audience mismatch → 401.
      // Content-Type is required by the upload-session API.
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(chunk.length),
        'Content-Range': contentRange
      },
      body: chunk
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) return res; // nothing to follow; let caller report it
      url = withAuthToken(new URL(location, url), uploadUrl).toString();
      console.warn(`${tag} upload chunk redirected (${res.status}) → following ${new URL(url).host}`);
      continue;
    }
    return res;
  }
  throw new Error('Graph attachment upload chunk: too many redirects');
}

// Copy the `authtoken` query parameter from the original pre-authenticated
// uploadUrl onto a redirect target that lost it. Returns `target`.
function withAuthToken(target, originalUrl) {
  if (!target.searchParams.has('authtoken')) {
    const tok = new URL(originalUrl).searchParams.get('authtoken');
    if (tok) target.searchParams.set('authtoken', tok);
  }
  return target;
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
//
// webLink .. changeKey are the "read signals" (messages.web_link, is_read, ...).
// A stored deltaLink replays the $select it was minted with, so cursors minted
// before these were added keep delivering pages without them — graphToParsed
// records which properties a page actually carried, and nothing absent is ever
// written as NULL over a known value.
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
  'conversationId',
  'webLink',
  'isRead',
  'importance',
  'flag',
  'categories',
  'parentFolderId',
  'inferenceClassification',
  'changeKey'
].join(',');

// Prefer header values for Graph mail GETs. All preferences share ONE header
// value (comma-separated, RFC 7240): a fetch headers object can't carry two
// Prefer keys.
//
// IdType="ImmutableId" makes Graph hand out message/attachment ids that survive
// a move between folders (default ids change on every move, which would leave
// stored graph_ids pointing at nothing). It is sent per CURSOR, not globally:
// how Graph treats a delta token replayed with a different IdType than it was
// minted with is undocumented, and the possible answers include an expiry (a
// fleet-wide fresh re-walk) or a 4xx on every poll (no mail at all). So a cursor
// minted without the header (folder_sync_state.id_type NULL — every cursor that
// existed before this shipped) keeps replaying exactly today's request until it
// is reset (natural expiry, or a fresh rescan); fresh walks send the header and
// save their cursor as 'immutable'. Every request of one walk uses one choice,
// attachment listings and $value fetches included, so a walk never mixes id
// formats.
//
// ROLLBACK. The same mismatch runs the other way if a pre-CL1 build (#54, main)
// is redeployed: it replays every stored link with the html preference only and
// treats nothing but HTTP 410 as an expired cursor, so a cursor minted here with
// IdType that Graph won't replay without it stalls its folder on every poll (on
// #54 the inbox walk is outside any per-folder try, so sent and junk stop too).
// Whether Graph does that is the open question above, so cursors are NOT reset
// up front: a reset makes the old code walk that folder from scratch, and there
// that costs a download of every attachment's bytes (#54 fetches them before
// deduping), the folder's new mail held back until the whole snapshot is done
// (200 pages per pass), and every message without a Message-ID stored again and
// announced as new mail. Two steps instead, once the rollback deploy has finished
// (no instance of THIS build still polling: it would mark fresh walks immutable
// again). Session-mode psql; DB_SCHEMA is 'missive' in production.
//   1. Everywhere. Keeps every cursor and forgets only that this build minted it:
//        UPDATE missive.folder_sync_state SET id_type = NULL WHERE id_type = 'immutable' AND folder IN ('inbox', 'sentitems', 'junkemail');
//      The old code never writes id_type, and it requests the cursors it
//      re-mints on its next polls without IdType — so when this build is
//      deployed again it must replay them WITHOUT IdType, exactly as the old
//      code did. Only the built-ins: the old code never walks an extra folder,
//      so those cursors are still the ones this build minted, and keep saying so.
//   2. Only for the accounts whose walks then fail (last_synced_at frozen in GET
//      /api/accounts, or a delta GET error in last_sync_error):
//        UPDATE missive.folder_sync_state SET delta_link = NULL WHERE account_id = ANY(ARRAY['<account id>']) AND folder IN ('inbox', 'sentitems', 'junkemail');
//      The old code walks their folders afresh, at the costs listed above.
// The old code also never relabels a known row (its dup branch returns before
// any folder update, event or webhook). A row this build moved from INBOX to
// 'Junk Email' or to an extra folder's label stays there through the rollback,
// even if the user moves the mail back to the Inbox meanwhile: it is missing from
// DD's INBOX view and DD got no inbound event for it. After deploying this build
// again, run POST /api/accounts/<id>/rescan {"fresh": true} for every mailbox
// where that may have happened: the fresh inbox walk takes the row back to INBOX.
const PREFER_HTML = 'outlook.body-content-type="html"';
const PREFER_HTML_IMMUTABLE = 'outlook.body-content-type="html", IdType="ImmutableId"';
const PREFER_IMMUTABLE = 'IdType="ImmutableId"';
const ID_TYPE_IMMUTABLE = 'immutable';

// Fetch helper — adds Authorization header, throws on non-2xx with the
// Graph error body inlined so callers can log a useful diagnostic. 410
// (Gone) is the special "deltaLink expired" signal; we surface that as
// an .expired flag rather than throwing.
//
// opts.prefer overrides the Prefer value (default: today's html-only value).
// opts.meta, when given, receives the response's Preference-Applied header.
async function graphGet(url, token, { prefer = PREFER_HTML, meta = null } = {}) {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      // Without this, Graph returns Internet headers in lowercased form
      // which mailparser-style consumers wouldn't recognize.
      Prefer: prefer
    }
  });
  if (meta && res.headers && typeof res.headers.get === 'function') {
    meta.preferenceApplied = res.headers.get('preference-applied');
  }
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

// Read-signal sanitizers. These values go into the same INSERT that stores the
// message, where a data error (SQLSTATE class 22) rolls the message back with
// them — so they are made unable to fail: no NUL bytes (Postgres text rejects
// them), bounded sizes, enums reduced to short lower-case words. Anything that
// doesn't fit becomes NULL rather than being guessed at; signals are best-effort,
// the message is not.
const NUL_RE = /\u0000/g;

function cleanSignalText(v, max) {
  if (typeof v !== 'string') return null;
  const s = v.replace(NUL_RE, '');
  return s && s.length <= max ? s : null;
}

function cleanSignalEnum(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  return /^[a-z][a-z0-9_]{0,31}$/.test(s) ? s : null;
}

function cleanCategories(v) {
  if (!Array.isArray(v)) return null;
  const out = [];
  for (const c of v) {
    if (out.length >= 50) break;
    const s = cleanSignalText(c, 255);
    if (s) out.push(s);
  }
  return out;
}

// Only the properties the Graph object actually carries. A page from a cursor
// minted before MSG_SELECT grew these has none of them, and "absent" must not
// turn into NULL over a value a newer cursor stored (ingest leaves a column
// alone when its key is missing here). Present-but-empty is real data:
// categories [] is stored as '{}', a notFlagged flag as 'notflagged'.
function graphSignals(msg) {
  const has = (k) => Object.prototype.hasOwnProperty.call(msg, k);
  const out = {};
  if (has('webLink')) out.web_link = cleanSignalText(msg.webLink, 2048);
  if (has('isRead')) out.is_read = typeof msg.isRead === 'boolean' ? msg.isRead : null;
  if (has('importance')) out.importance = cleanSignalEnum(msg.importance);
  if (has('flag')) {
    out.flag_status = msg.flag && typeof msg.flag === 'object' ? cleanSignalEnum(msg.flag.flagStatus) : null;
  }
  if (has('categories')) out.categories = cleanCategories(msg.categories);
  if (has('parentFolderId')) out.parent_folder_id = cleanSignalText(msg.parentFolderId, 1024);
  if (has('inferenceClassification')) out.inference_classification = cleanSignalEnum(msg.inferenceClassification);
  if (has('changeKey')) out.change_key = cleanSignalText(msg.changeKey, 512);
  return out;
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
  // For HTML mail, Graph's bodyPreview is truncated to ~255 chars, which
  // starved DelegationDoer's email-intake classifier (it reads body_text) and
  // limited full-text search to the preview. Derive the full plaintext from
  // the HTML body instead, matching the IMAP/mailparser path; fall back to the
  // preview only if stripping yields nothing.
  const text = bodyType === 'text'
    ? bodyContent
    : (htmlToText(bodyContent) || msg.bodyPreview || '');

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
    _graphConversationId: msg.conversationId || null,
    // The message's Graph id (immutable or default, whichever the walk asked
    // for) and its read signals. Their presence is also what tells ingest this
    // delivery came from a Graph walk.
    _graphId: cleanSignalText(msg.id, 1024),
    _graphSignals: graphSignals(msg)
  };
}

// Pull all attachments for a message and shape them like mailparser does
// — { filename, contentType, size, cid, content (Buffer) }. fileAttachment
// is the only common type; itemAttachment (nested message) and
// referenceAttachment (OneDrive link) are exotic enough to skip for now.
// Fetch the raw bytes of a single file attachment via Graph's $value
// endpoint → Buffer. Graph only inlines `contentBytes` on the JSON resource
// for small attachments; for larger files (~>3 MB) contentBytes comes back
// null on BOTH the collection and the item resource, and the bytes must be
// streamed from /$value, which works for any size up to the 150 MB cap.
// This is what was missing — large inbound attachments were silently dropped
// because we only ever read contentBytes.
// `immutable`: the walk asked for immutable ids, so the message and attachment ids
// passed here are immutable ones — ask for the same format (see PREFER_*).
async function fetchAttachmentValue(token, messageGraphId, attachmentId, { immutable = false } = {}) {
  const url =
    `${GRAPH_BASE}/me/messages/${encodeURIComponent(messageGraphId)}` +
    `/attachments/${encodeURIComponent(attachmentId)}/$value`;
  const headers = { Authorization: `Bearer ${token}` };
  if (immutable) headers.Prefer = PREFER_IMMUTABLE;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Graph attachment $value → ${res.status}: ${detail.slice(0, 200)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function fetchAttachmentsForMessage(token, messageGraphId, { immutable = false } = {}) {
  const base =
    `${GRAPH_BASE}/me/messages/${encodeURIComponent(messageGraphId)}/attachments`;

  // List the attachment collection WITHOUT `$select`. The previous
  // `$select=...,contentId,...,@odata.type` 400'd on every message —
  // `contentId` lives only on the derived `microsoft.graph.fileAttachment`
  // type (not the base `microsoft.graph.attachment` the collection is typed
  // as) and `@odata.type` isn't a selectable term, so Graph rejected the
  // whole request ("Could not find a property named 'contentId' on type
  // 'microsoft.graph.attachment'"). syncFolderViaGraph swallowed the error
  // and stored the message with ZERO attachments — every inbound file
  // silently dropped, even though OWA and the outbound (send-time) copy
  // showed it. The bare GET returns the full polymorphic objects, including
  // `@odata.type`, `contentId`, `isInline`, and `contentBytes` inline.
  const json = await graphGet(base, token, { prefer: immutable ? PREFER_HTML_IMMUTABLE : PREFER_HTML });

  const out = [];
  for (const a of (json.value || [])) {
    // fileAttachment is the only type that carries raw bytes; itemAttachment
    // (nested message) and referenceAttachment (cloud-storage link) have no
    // $value payload, so skip them.
    if (a['@odata.type'] !== '#microsoft.graph.fileAttachment') continue;

    // Prefer the bytes the listing already returned (reliable for all sizes
    // on a bare GET — verified for a 274 KB PDF and a 10.6 MB image), and
    // fall back to the per-attachment $value endpoint when contentBytes is
    // absent. $value remains the proven path for any message where Graph
    // omits inline bytes (commit 3fc4ae7's "per-attachment GET, all sizes").
    let content;
    if (a.contentBytes) {
      content = Buffer.from(a.contentBytes, 'base64');
    } else {
      try {
        content = await fetchAttachmentValue(token, messageGraphId, a.id, { immutable });
      } catch (e) {
        console.warn(`[graph] $value fetch failed for ${a.id}: ${e.message}`);
        continue;
      }
    }
    if (!content || !content.length) continue;

    out.push({
      filename: a.name || 'attachment',
      contentType: a.contentType || 'application/octet-stream',
      size: a.size || content.length,
      cid: a.contentId || '',
      content
    });
  }
  return out;
}

// Does this error mean "the database or schema is broken" rather than "this one
// message is bad"? Structural errors affect every message identically, so
// skipping past them while advancing the delta cursor throws away real mail.
// Postgres SQLSTATEs, per the error-code table:
//   42703 undefined_column      42P01 undefined_table
//   42883 undefined_function    42P07 duplicate_table
//   53300 too_many_connections  57014 query_canceled (statement_timeout)
//   55P03 lock_not_available    40P01 deadlock_detected
//   08xxx connection exceptions
// 55P03/40P01: ingest waits on a per-message advisory lock (db.txLocked) with a
// lock_timeout. A timeout there says "another writer is busy with this
// message", not "this message is bad" — skipping it would advance the cursor
// past mail that was never stored. Abort and let the next poll retry.
//   42804 datatype_mismatch     42P18 indeterminate_datatype     42601 syntax_error
// These three are errors in the SQL TEXT (a bad cast or expression in ingest's
// statements), never in one message's data — so like a missing column they fail
// every message identically, and skipping would discard the whole walk.
//   57Pxx operator intervention: 57P01 admin_shutdown (a failover, a maintenance
//   restart, pg_terminate_backend), 57P02 crash_shutdown, 57P03 cannot_connect_now
//   (starting up / shutting down / in recovery), 57P04 database_dropped,
//   57P05 idle_session_timeout.
// The server ending the session mid-statement says nothing about the message,
// and its wording ("terminating connection due to administrator command") is
// not node-pg's "Connection terminated" that the message fallback below knows.
const STRUCTURAL_PG_CODES = new Set([
  '42703', '42P01', '42883', '42P07', '53300', '57014', '55P03', '40P01',
  '42804', '42P18', '42601'
]);

function isStructuralDbError(e) {
  const code = e && e.code;
  if (typeof code === 'string' &&
      (STRUCTURAL_PG_CODES.has(code) || code.startsWith('08') || code.startsWith('57P'))) {
    return true;
  }
  // The pg pool surfaces some failures without a SQLSTATE (pool exhausted,
  // socket closed mid-query). Fall back to the message.
  const msg = String((e && e.message) || '').toLowerCase();
  return (
    msg.includes('does not exist') ||
    msg.includes('timeout exceeded when trying to connect') ||
    msg.includes('canceling statement due to statement timeout') ||
    msg.includes('connection terminated') ||
    msg.includes('database is unavailable')
  );
}

// Narrower than isStructuralDbError: "the database can't be reached at all"
// (connection exceptions, too many connections, the server ending sessions —
// 57Pxx, see above — pool exhausted). Every folder fails the same way, so a pass
// stops instead of repeating it for each folder.
function isDbUnavailable(e) {
  const code = e && e.code;
  if (typeof code === 'string' && (code.startsWith('08') || code.startsWith('57P') || code === '53300')) return true;
  const msg = String((e && e.message) || '').toLowerCase();
  return (
    msg.includes('timeout exceeded when trying to connect') ||
    msg.includes('connection terminated') ||
    msg.includes('database is unavailable')
  );
}

// Graph's sync-state failures. The docs spell the codes syncStateNotFound /
// syncStateInvalid / resyncRequired, Outlook-backed endpoints commonly answer in
// PascalCase, and Exchange-style variants (ErrorInvalidSyncStateData) exist —
// sometimes on error.innerError rather than error. Match loosely, any status.
// Callers only consult this for a walk that started from a STORED cursor: on a
// fresh start URL there is no cursor to expire, so the same answer is a real
// error (clearing nothing and "restarting" every poll would look green forever).
const SYNC_STATE_CODE_RE = /sync\s*state|resync\s*required/i;

function graphErrorCodes(e) {
  const err = e && e.body && e.body.error;
  if (!err || typeof err !== 'object') return [];
  const inner = err.innerError || err.innererror;
  return [err.code, inner && typeof inner === 'object' ? inner.code : null]
    .filter((c) => typeof c === 'string' && c);
}

function isExpiredCursorError(e) {
  if (!e) return false;
  if (e.status === 410) return true;
  return graphErrorCodes(e).some((c) => SYNC_STATE_CODE_RE.test(c));
}

// A saved checkpoint (the unconsumed nextLink of a walk that hit MAX_PAGES)
// rather than a real deltaLink.
function isCheckpointLink(link) {
  const s = String(link || '');
  return /[?&]\$?skiptoken=/i.test(s) && !/[?&]\$?deltatoken=/i.test(s);
}

// A real deltaLink: the walk that saved it reached the end of the folder.
function isFinishedDeltaLink(link) {
  return /[?&]\$?deltatoken=/i.test(String(link || ''));
}

// Walk one Graph folder via delta. Returns { count, deltaLink } so the
// caller can persist the new resume cursor only AFTER all pages
// ingested cleanly. If a page mid-walk throws (network blip, ingest
// error), we keep the OLD deltaLink and the next poll re-fetches from
// the previous good point — message_id dedup makes that idempotent.
//
// `folder` is one entry of the pass's folder list (see syncAccountViaGraph):
//   key       — folder_sync_state.folder for its cursor: the built-ins keep
//               their well-known name ('inbox'), extra folders use
//               extraFolderKey().
//   path      — the Graph folder (well-known name or id) in the URL.
//   label     — the value written into messages.folder. For the built-ins it
//               must match what the IMAP path would have written (and what
//               DelegationDoer's threads filter queries against), e.g. 'INBOX'
//               uppercase. The two diverge because Graph URLs are lowercase
//               but DD's UI filter is IMAP-flavored.
//   direction — 'inbound' / 'outbound' for the built-ins; undefined for extra
//               folders, where ingest infers it per message (see below).
//   extra     — a per-account extra folder rather than a built-in one.
//   maxPages  — the per-pass page cap.
//   yieldsTo  — built-in keys whose rows this walk takes over only when they
//               hold the very item it delivers (junk: see ingestOpts below).
// `tokens` is the pass's shared Graph token source (graphTokenSource).
async function syncFolderViaGraph(account, folder, tokens) {
  const { ingestMessage } = require('./imap');
  const db = require('../db');

  // This folder's cursor and those of the folders it yields to: one round trip.
  const states = await db.many(
    'SELECT folder, delta_link, id_type FROM folder_sync_state WHERE account_id = $1 AND folder = ANY($2::text[])',
    [account.id, [folder.key, ...(folder.yieldsTo || [])]]
  );
  const stored = states.find((s) => s.folder === folder.key) || null;
  const fromCursor = !!(stored && stored.delta_link);
  // See PREFER_*: a legacy cursor replays exactly what it was minted with.
  const immutable = fromCursor ? stored.id_type === ID_TYPE_IMMUTABLE : true;
  const prefer = immutable ? PREFER_HTML_IMMUTABLE : PREFER_HTML;
  const resumingCheckpoint = fromCursor && isCheckpointLink(stored.delta_link);
  let url = fromCursor
    ? stored.delta_link
    : `${GRAPH_BASE}/me/mailFolders/${encodeURIComponent(folder.path)}/messages/delta?$select=${MSG_SELECT}&$top=50`;

  // What ingest needs to know about this walk beyond its label:
  //   graph.primary — a built-in walk owns a re-delivered row; an extra folder
  //     only takes over rows no built-in folder holds, or rows holding the very
  //     Graph item it delivers (a move keeps its immutable id). That precedence
  //     keeps a COPY filed in an extra folder (a new item, a new id) from
  //     pulling its original out of DD's INBOX view (both are direction
  //     'inbound', one dedup key, one row). See applyRedelivery in imap.js.
  //   graph.strictLabels — the one exception to "a built-in walk owns": the junk
  //     walk takes an INBOX row only when that row holds the very item it
  //     delivers (or no Graph id at all, or is marked removed). Another item
  //     with the same Message-ID in Junk — a duplicate delivery the filter
  //     junked, a copy — is not the Inbox mail moving there; taking the row
  //     would pull mail that is still in the Inbox out of DD's INBOX view into
  //     Spam, and that item's purge from Junk would then mark the row removed.
  //     The same-item test needs both ids immutable, so it applies only when
  //     this walk asks for immutable ids AND the inbox has a FINISHED immutable
  //     walk (a real deltaLink, not a checkpoint): after one, every INBOX row
  //     whose mail is in the Inbox carries that mail's immutable id. Otherwise
  //     a stored id may be an old default id, which changes on a move, so a
  //     moved row couldn't be told from a duplicate; the row is taken as before.
  //     Inbox wins the other way round: the inbox walk always takes a Junk row,
  //     because mail in the Inbox must be in DD's INBOX view.
  //   reopen — inbound mail found in an extra folder (an archive, newsletters
  //     filed by a rule) must not reopen or unsnooze threads the team closed.
  //   quietIfSentBefore — set per message below.
  const strictLabels = !immutable ? [] : BUILTIN_GRAPH_FOLDERS
    .filter((f) => (folder.yieldsTo || []).includes(f.key) && states.some((s) =>
      s.folder === f.key && s.id_type === ID_TYPE_IMMUTABLE && isFinishedDeltaLink(s.delta_link)))
    .map((f) => f.label);
  const ingestOpts = {
    graph: { primary: !folder.extra, protectedLabels: PROTECTED_FOLDER_LABELS, strictLabels },
    reopen: !folder.extra
  };

  let count = 0;
  let lastDeltaLink = null;
  let pageNum = 0;
  let expired = null;
  const meta = {};
  const maxPages = folder.maxPages || MAX_PAGES_BUILTIN;

  // 401 mid-walk usually means the token aged out (rare, the source re-mints
  // old tokens, but Graph sometimes invalidates out of band). Re-mint once and
  // retry the same URL.
  const getPage = async (u) => {
    try {
      return await graphGet(u, await tokens.get(), { prefer, meta });
    } catch (e) {
      if (e.status !== 401) throw e;
      return graphGet(u, await tokens.refresh(), { prefer, meta });
    }
  };

  while (url && pageNum < maxPages) {
    pageNum += 1;
    let page;
    try {
      page = await getPage(url);
    } catch (e) {
      if (fromCursor && isExpiredCursorError(e)) {
        expired = { status: e.status, code: graphErrorCodes(e)[0] || null };
        break;
      }
      throw e;
    }
    if (page.expired) {
      if (!fromCursor) {
        const err = new Error(`Graph delta for ${folder.label} answered 410 on a fresh start URL`);
        err.status = 410;
        throw err;
      }
      expired = { status: 410, code: null };
      break;
    }
    if (immutable && pageNum === 1) logPreferenceAppliedOnce(account, folder, meta.preferenceApplied);

    const messages = Array.isArray(page.value) ? page.value : [];
    // id -> its @removed entry, still standing at this point of the page.
    const removed = new Map();
    for (const m of messages) {
      // @removed: the message left this folder — deleted, or moved somewhere
      // (per-folder delta doesn't say which). Collected and marked with one
      // statement per page below.
      if (m && m['@removed']) {
        if (m.id) removed.set(m.id, m);
        continue;
      }
      // The batch below runs after every present entry of the page, so the
      // page's own order has to be applied here: a removal followed by the same
      // id present again (moved out and back, delete then undo, inside one poll
      // window) means present. A removal after it still wins.
      if (m && m.id) removed.delete(m.id);
      // Skip drafts — Outlook stores in-progress drafts in the inbox/sent
      // folders' delta stream, but they're not "real" mail.
      if (!m || m.isDraft) continue;

      const parsed = graphToParsed(m, []);
      // Attachments are fetched lazily, from inside ingest, and only when it is
      // going to store them: for a new message, or for a known one that still has
      // no attachment rows (the dup branch backfills those — anything stored
      // before the inbound attachment fixes, or whose rows were rejected). A known
      // message that already has its attachments costs no attachment GET at all,
      // which is what makes a fresh re-walk affordable. "Complete" is exactly
      // that dup branch's test; Graph's hasAttachments (wrong for our own sends,
      // blind to inline-only mail) and messages.has_attachments (stays 1 when the
      // rows were rejected) are never consulted. Deciding out here instead would
      // race the real lookup and cost another round trip.
      //
      // Graph's per-message `hasAttachments` flag is unreliable: a message
      // whose attachments were added AFTER its draft was created can carry a
      // real MIME attachment while the flag stays false. That's exactly our
      // own Graph send path (sendAsDraftViaGraph: create draft → add
      // attachment → send), so DelegationDoer-sent mail arrived with
      // hasAttachments=false and the old `if (m.hasAttachments)` gate skipped
      // the fetch — silently dropping the file for the recipient, even though
      // OWA (which reads the attachment collection, not the flag) showed it.
      // So the loader always probes and trusts the actual /attachments listing.
      //
      // It never throws: a failure means "no attachments this time" (the dup
      // backfill retries on a later re-walk), never "skip the message".
      parsed._loadAttachments = async () => {
        let attachments = [];
        try {
          attachments = await fetchAttachmentsWithToken(tokens, m.id, immutable);
        } catch (e) {
          // One bad attachment fetch shouldn't strand the whole message.
          console.warn(`[graph] attachment fetch failed for ${m.id} (${account.email}): ${e.message}`);
        }
        // Diagnostic: print when the flag and the actual fetch disagree, or
        // whenever we stored attachments. `hasAttachments=false → fetched N>0`
        // is the stale-flag case the always-probe rule exists for;
        // `hasAttachments=true → fetched 0` would instead point at a fetch gap
        // inside fetchAttachmentsForMessage.
        if (m.hasAttachments || attachments.length) {
          console.log(`[graph] ${account.email} ${folder.label}: hasAttachments=${!!m.hasAttachments} → fetched ${attachments.length} attachment(s)`);
        }
        return attachments;
      };

      // A new extra folder's first walk inserts everything filed there that
      // never passed through a synced folder — possibly years of it. Announcing
      // each one as new mail (socket + DD webhook) floods DD's notifications and
      // intake; a 340-webhook catch-up has pushed DD into Supabase Auth 429s
      // before. So mail older than DD's own 12h backlog guard is stored
      // silently, while recent mail a rule files there still announces. It is
      // stateless, so it holds across page-cap checkpoints too.
      const opts = folder.extra
        ? { ...ingestOpts, quietIfSentBefore: Date.now() - EXTRA_FOLDER_ANNOUNCE_MAX_AGE_MS }
        : ingestOpts;
      // Built-ins pass their fixed direction. Extra folders pass none, so ingest
      // infers it from From vs the account address: the user's own sent mail
      // filed in an extra folder must dedup onto its Sent Items row, not become
      // an inbound twin that fires the inbound webhook. A row that already holds
      // the item overrides the inference (applyRedelivery in imap.js).
      try {
        const ok = await ingestMessage(account, /* uid */ 0, folder.label, parsed, folder.direction, opts);
        if (ok) count += 1;
      } catch (e) {
        // Skip-and-continue is right for ONE corrupt message: the delta link we
        // save still covers it, so we don't retry forever.
        //
        // It is very wrong for a STRUCTURAL failure — a missing column, a dead
        // pool, a statement timeout. Those fail for every message equally, so
        // "skip and advance the cursor" silently discards the entire folder
        // walk and there is no way to get that mail back short of manually
        // clearing the cursor. Rethrow instead: the caller aborts the walk and
        // leaves the previous cursor in place, so the next poll retries.
        if (isStructuralDbError(e)) {
          console.error(`[graph] ABORTING walk for ${account.email}/${folder.label} — structural DB error, cursor NOT advanced: ${e.message}`);
          throw e;
        }
        console.warn(`[graph] ingest failed for ${m.id} (${account.email}): ${e.message}`);
      }
    }
    if (removed.size) await markRemovedBatch(db, account, folder.label, [...removed.values()]);

    if (page['@odata.nextLink']) {
      url = page['@odata.nextLink'];
      continue;
    }
    if (page['@odata.deltaLink']) {
      lastDeltaLink = page['@odata.deltaLink'];
    }
    url = null;
  }

  if (expired) {
    // The cursor is gone on Graph's side — Microsoft drops it after long gaps
    // (28 days default) or when its sync state is otherwise invalid. Clear it
    // (and its id type: the restart is a fresh walk) and let the next poll do a
    // fresh initial sync of this folder only. Don't try to recover inline.
    console.warn(
      `[graph] delta cursor expired for ${account.email}/${folder.label} ` +
      `(HTTP ${expired.status || '?'}${expired.code ? `, ${expired.code}` : ''}) — clearing it; the next poll restarts this folder`
    );
    await db.query(
      `UPDATE folder_sync_state SET delta_link = NULL, id_type = NULL
         WHERE account_id = $1 AND folder = $2`,
      [account.id, folder.key]
    );
    const streak = bumpExpiryStreak(account.id, folder.key);
    // A restart is normally routine. Two cases are not, and go to
    // last_sync_error: the cursor was the resume point of an unfinished initial
    // sync (that progress is lost, and a folder too big to finish between
    // expiries never reaches its deltaLink — so never sees new mail), or the
    // folder's cursor keeps expiring every time it is replayed (each expiry is
    // followed by a fresh walk that saves a new cursor, which expires again).
    let alert = null;
    if (resumingCheckpoint) {
      alert = `${folder.label}: the resume point of an unfinished initial sync expired (HTTP ${expired.status || '?'}) — restarting the folder from scratch`;
    } else if (streak >= EXPIRY_ALERT_STREAK) {
      alert = `${folder.label}: delta cursor expired on ${streak} replays in a row`;
    }
    return { count, restarted: true, alert };
  }

  // Resume-cursor selection:
  //   - Got a deltaLink → save it. Next poll picks up changes only.
  //   - Hit the page cap without deltaLink → save the unconsumed nextLink so
  //     the next poll continues the initial sync where we left off.
  //   - Neither (rare empty mailbox initial state) → leave previous
  //     cursor alone.
  if (!lastDeltaLink && pageNum >= maxPages && url) {
    console.warn(`[graph] folder walk hit its page cap (${maxPages}) for ${account.email}/${folder.label} — saving nextLink to resume`);
    lastDeltaLink = url;
  }

  // Persist resume cursor — only if we got one and only at the very end. Its id
  // type goes with it: every link of this walk was requested with `prefer`.
  if (lastDeltaLink) {
    await db.query(
      `INSERT INTO folder_sync_state (account_id, folder, last_sync_uid, delta_link, uid_validity, id_type)
       VALUES ($1, $2, 0, $3, NULL, $4)
       ON CONFLICT (account_id, folder)
       DO UPDATE SET delta_link = EXCLUDED.delta_link, id_type = EXCLUDED.id_type`,
      [account.id, folder.key, lastDeltaLink, immutable ? ID_TYPE_IMMUTABLE : null]
    );
  }
  // Only a stored cursor that REPLAYED cleanly ends an expiry streak. The walk
  // right after an expiry always starts fresh (its cursor was just cleared), so
  // it says nothing about whether the next deltaLink will hold — resetting there
  // would keep a folder whose cursor dies on every replay at 1 forever, and the
  // EXPIRY_ALERT_STREAK alert in the expiry branch above could never fire.
  if (fromCursor) expiryStreaks.delete(`${account.id}|${folder.key}`);

  return { count, deltaLink: lastDeltaLink };
}

// Page caps per folder per pass. 200 pages × 50 messages = 10k for the
// built-ins: enough headroom for an initial sync, but bounded so a runaway
// pagination loop can't hang the worker forever. Extra folders get far less:
// the next pass's inbox walk waits for every folder of this one, and ten fresh
// extra folders at 10k messages each would hold new mail back for hours. Their
// initial sync just spreads over more passes (each resuming from its saved
// nextLink).
const MAX_PAGES_BUILTIN = 200;
const EXTRA_FOLDER_MAX_PAGES = 20;
const EXTRA_FOLDER_ANNOUNCE_MAX_AGE_MS = 12 * 60 * 60_000;
const EXPIRY_ALERT_STREAK = 3;

// `${accountId}|${folderKey}` -> replays of a stored cursor that expired since
// the last replay that worked (the fresh walks a restart forces in between don't
// count either way). In memory on purpose: it only has to notice a loop while it
// happens.
const expiryStreaks = new Map();
function bumpExpiryStreak(accountId, key) {
  const k = `${accountId}|${key}`;
  const n = (expiryStreaks.get(k) || 0) + 1;
  expiryStreaks.set(k, n);
  return n;
}

// Prefer is advisory, so whether Graph honoured IdType="ImmutableId" can only be
// read off its Preference-Applied response header. Logged once per folder per
// process; every poll would be noise.
const preferenceLogged = new Set();
function logPreferenceAppliedOnce(account, folder, value) {
  const k = `${account.id}|${folder.key}`;
  if (preferenceLogged.has(k)) return;
  preferenceLogged.add(k);
  console.log(`[graph] ${account.email}/${folder.label}: immutable ids requested; Preference-Applied=${value || '(none)'}`);
}

async function fetchAttachmentsWithToken(tokens, messageGraphId, immutable) {
  try {
    return await fetchAttachmentsForMessage(await tokens.get(), messageGraphId, { immutable });
  } catch (e) {
    if (e.status !== 401) throw e;
    return fetchAttachmentsForMessage(await tokens.refresh(), messageGraphId, { immutable });
  }
}

// One statement per delta page for its @removed entries: mass removals are
// routine (retention policies, Sweep, bulk deletes), and a statement per entry
// would be a round trip each over the ocean link. It matches only rows still
// labelled with THIS walk's folder — a message moved to another synced folder
// may already have been relabelled by that folder's walk (it can run first) and
// must not be marked removed. Rows without a graph_id (stored before graph ids
// existed) can't match at all.
//
// A missed removal is only a missing marker; the message itself is stored. So
// failures are logged and skipped. Treating a timeout here like ingest's
// structural errors would abort the walk and replay the same page on every poll,
// stalling the folder's new mail over a marker. Only a database that can't be
// reached at all aborts (the next statement of the walk would fail anyway).
async function markRemovedBatch(db, account, folderLabel, entries) {
  const ids = [];
  const reasons = [];
  for (const e of entries) {
    const id = cleanSignalText(e.id, 1024);
    if (!id) continue;
    ids.push(id);
    const r = e['@removed'] && e['@removed'].reason;
    reasons.push(cleanSignalText(r, 64) || 'unknown');
  }
  if (!ids.length) return 0;
  try {
    const r = await db.query(
      `UPDATE messages m
          SET removed_at = $4::bigint, removed_reason = x.reason, signals_updated_at = $4::bigint
         FROM unnest($2::text[], $3::text[]) AS x(graph_id, reason)
        WHERE m.account_id = $1::text AND m.graph_id = x.graph_id
          AND m.folder = $5::text AND m.removed_at IS NULL`,
      [account.id, ids, reasons, Date.now(), folderLabel]
    );
    return r.rowCount || 0;
  } catch (e) {
    if (isDbUnavailable(e)) throw e;
    console.warn(`[graph] could not mark ${ids.length} removal(s) for ${account.email}/${folderLabel} — skipped: ${e.message}`);
    return 0;
  }
}

// The pass's Graph token. One refresh grant per pass — it used to be one per
// folder walk (3 per account per poll, and up to 13 with extra folders, all
// against the token endpoint). Re-minted once it is 40 minutes old (access
// tokens live 60-90) and on a 401. A failure to mint is tagged so the pass
// stops: every folder would fail the same way.
const TOKEN_REUSE_MS = 40 * 60_000;

function graphTokenSource(account) {
  let token = null;
  let mintedAt = 0;
  const mint = async () => {
    try {
      token = await ms.getAccessTokenForResource(account, GRAPH_SYNC_SCOPE);
    } catch (e) {
      token = null;
      if (e && typeof e === 'object') e.graphTokenMint = true;
      throw e;
    }
    mintedAt = Date.now();
    return token;
  };
  return {
    get: async () => (token && Date.now() - mintedAt < TOKEN_REUSE_MS ? token : mint()),
    refresh: mint
  };
}

// The built-in folders, walked first and in this order on every pass.
const BUILTIN_GRAPH_FOLDERS = [
  // label is what gets written into messages.folder. Match what the IMAP path
  // produced ('INBOX' uppercase) so DelegationDoer's INBOX-folder filter on
  // threads picks up Graph-synced messages.
  { key: 'inbox', path: 'inbox', direction: 'inbound', label: 'INBOX' },
  // Sent-folder filtering in DD uses direction='outbound' (not folder name),
  // so the sent label is cosmetic — keep it readable.
  { key: 'sentitems', path: 'sentitems', direction: 'outbound', label: 'Sent Items' },
  // Junk/Spam → DD's Spam view. The label contains 'Junk' so ingestMessage's
  // spam guard keeps it out of the intake pipeline, and DD's SPAM folder filter
  // matches it via ILIKE '%junk%'. It yields INBOX rows to the inbox (see
  // strictLabels in syncFolderViaGraph).
  { key: 'junkemail', path: 'junkemail', direction: 'inbound', label: 'Junk Email', yieldsTo: ['inbox'] }
];

// Labels a re-delivery from an EXTRA folder may not take a row away from — unless
// the row holds that very Graph item, i.e. it moved there (applyRedelivery): the
// built-ins' (otherwise the row's message is still there and the extra-folder
// item is a copy) and 'Sent' — what DD's own sends store (compose, reply,
// scheduled), which no walk produces and which #54's dedupe script uses to
// recognise DD-written rows (a moved 'Sent' row is re-stamped, never relabelled).
const PROTECTED_FOLDER_LABELS = [...BUILTIN_GRAPH_FOLDERS.map((f) => f.label), 'Sent'];

function extraGraphFolders(account) {
  return parseStoredExtraFolders(account.extra_sync_folders).map((f) => ({
    key: extraFolderKey(f),
    path: f.id,
    label: f.label,
    direction: undefined,
    extra: true,
    maxPages: EXTRA_FOLDER_MAX_PAGES
  }));
}

async function syncAccountViaGraph(account) {
  const { recordSyncError, formatSyncError } = require('./imap');
  const db = require('../db');

  const tokens = graphTokenSource(account);
  const folders = [...BUILTIN_GRAPH_FOLDERS, ...extraGraphFolders(account)];
  let totalCount = 0;
  // Per-folder isolation: a failure walking one folder (the inbox included)
  // doesn't skip the others. What gets recorded keeps today's meaning, where
  // the inbox is what last_synced_at vouches for:
  //   - last_synced_at advances only when the inbox walk succeeded, so a stuck
  //     inbox still shows as stale in GET /api/accounts while the other
  //     folders keep syncing;
  //   - last_sync_error names every folder that failed this pass (sent, junk
  //     and extra folders used to be log-only) and is cleared only by a pass in
  //     which all of them succeeded;
  //   - the pass throws (so /:id/sync answers 500 and the poll logs it) only
  //     when the inbox failed, as before.
  const failures = [];
  let inboxOk = false;
  for (const folder of folders) {
    let r;
    try {
      r = await syncFolderViaGraph(account, folder, tokens);
    } catch (e) {
      failures.push({ folder, err: e });
      console.warn(`[graph] ${folder.label} sync failed for ${account.email}: ${e.message}`);
      // No token, or no database: every remaining folder would fail the same way.
      if (e.graphTokenMint || isDbUnavailable(e)) break;
      continue;
    }
    totalCount += r.count || 0;
    if (r.alert) failures.push({ folder, err: new Error(r.alert) });
    else if (folder.key === 'inbox') inboxOk = true;
  }

  try {
    if (!failures.length) {
      await db.query(
        `UPDATE email_accounts
           SET last_synced_at = $1, last_sync_error = NULL, last_sync_error_at = NULL
           WHERE id = $2`,
        [Date.now(), account.id]
      );
      return totalCount;
    }
    if (inboxOk) {
      await db.query('UPDATE email_accounts SET last_synced_at = $1 WHERE id = $2', [Date.now(), account.id]);
    }
  } catch (e) {
    await recordSyncError(account.id, e);
    throw e;
  }
  // A lone inbox failure is recorded exactly as it always was: same text, same
  // OAuth details, and recordSyncError's auth handling sees the original error.
  const lone = failures.length === 1 && failures[0].folder.key === 'inbox' ? failures[0].err : null;
  const err = lone || new Error(
    failures.map(({ folder, err: e }) => `${folder.label}: ${formatSyncError(e)}`).join('; ')
  );
  await recordSyncError(account.id, err);
  if (!inboxOk) throw err;
  return totalCount;
}

// ── Extra-folder configuration (routes/accounts.js) ─────────────────────────

// The mailbox's folders one level at a time: top level, or the children of
// parentId. Follows @odata.nextLink (Graph pages folder lists), capped so a
// pathological mailbox can't loop.
async function listMailFolders(account, parentId = null) {
  const token = await ms.getAccessTokenForResource(account, GRAPH_SYNC_SCOPE);
  const query = '$top=100&$select=id,displayName,parentFolderId,totalItemCount,childFolderCount';
  let url = parentId
    ? `${GRAPH_BASE}/me/mailFolders/${encodeURIComponent(parentId)}/childFolders?${query}`
    : `${GRAPH_BASE}/me/mailFolders?${query}`;
  const out = [];
  for (let page = 0; url && page < 50; page++) {
    const json = await graphGet(url, token);
    if (json.expired) throw new Error('Graph folder list answered 410');
    for (const f of (json.value || [])) {
      out.push({
        id: f.id,
        displayName: f.displayName,
        parentFolderId: f.parentFolderId || null,
        totalItemCount: f.totalItemCount,
        childFolderCount: f.childFolderCount
      });
    }
    url = json['@odata.nextLink'] || null;
  }
  return out;
}

// One folder by id or well-known name; null when Graph doesn't know it (404, or
// 400 for a malformed id). Throws on anything else. A search folder's JSON also
// carries "@odata.type": "#microsoft.graph.mailSearchFolder" (OData annotates a
// derived type whatever the $select).
async function getMailFolder(token, idOrName) {
  try {
    const json = await graphGet(
      `${GRAPH_BASE}/me/mailFolders/${encodeURIComponent(idOrName)}?$select=id,displayName,parentFolderId`, token
    );
    return json && !json.expired && json.id ? json : null;
  } catch (e) {
    if (e.status === 404 || e.status === 400) return null;
    throw e;
  }
}

// Folders that must never be an extra folder, looked up by their real ids so
// they are caught when passed by id (validateExtraFolders catches the names).
const NEVER_EXTRA_FOLDERS = ['inbox', 'sentitems', 'junkemail', 'drafts', 'outbox', 'deleteditems'];

// A mail search folder (Outlook's Search Folders: a saved search) holds no mail
// of its own. It lists items that live in other folders, under THEIR ids, so an
// extra-folder walk of one would take over every Inbox row it matches (the
// same-item rule in imap.js applyRedelivery) and pull that mail out of DD's
// INBOX view. Known by its type annotation, or by sitting under the well-known
// searchfolders root (also refused itself).
function isSearchFolder(g, searchRootId) {
  if (/mailSearchFolder/i.test(String((g && g['@odata.type']) || ''))) return true;
  return !!searchRootId && (g.id === searchRootId || g.parentFolderId === searchRootId);
}

// Resolve a validated extra-folder list to canonical Graph ids, which is what
// gets stored (an alias like 'archive' and the folder's id are then one entry).
// Returns { folders } or { error } for anything the caller got wrong; throws
// when Graph itself fails.
async function resolveExtraFolders(account, folders) {
  if (!folders.length) return { folders: [] };
  const token = await ms.getAccessTokenForResource(account, GRAPH_SYNC_SCOPE);
  const builtin = new Set();
  for (const name of NEVER_EXTRA_FOLDERS) {
    const f = await getMailFolder(token, name);
    if (f) builtin.add(f.id);
  }
  // Best-effort: the type annotation alone still catches search folders if
  // this lookup is refused.
  const searchRoot = await getMailFolder(token, 'searchfolders').catch(() => null);
  const out = [];
  const seen = new Set();
  for (const f of folders) {
    const g = await getMailFolder(token, f.id);
    if (!g) return { error: `folder ${f.id} was not found in this mailbox` };
    const name = g.displayName || f.id;
    if (builtin.has(g.id)) {
      return { error: `"${name}" is a built-in folder (inbox, sent items, junk, drafts, outbox or deleted items) and cannot be an extra folder` };
    }
    if (isSearchFolder(g, searchRoot && searchRoot.id)) {
      return { error: `"${name}" is a search folder (it lists mail stored in other folders) and cannot be an extra folder` };
    }
    if (typeof g.id !== 'string' || !FOLDER_ID_RE.test(g.id)) return { error: `"${name}" has an id this clone cannot store` };
    if (seen.has(g.id)) return { error: `"${name}" is listed twice` };
    seen.add(g.id);
    out.push({ id: g.id, label: f.label });
  }
  return { folders: out };
}

module.exports = {
  sendEmailViaGraph, syncAccountViaGraph,
  // Extra-folder configuration (routes/accounts.js).
  listMailFolders, resolveExtraFolders,
  // ingestMessage decides with it whether a failed signal update may fall back.
  isStructuralDbError
};
