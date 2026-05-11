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
  if (attachments.length) message.attachments = attachments;

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

  // 2) Send.
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

  for (const att of attachments) {
    const aRes = await fetch(
      `${GRAPH_BASE}/me/messages/${encodeURIComponent(draftId)}/attachments`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(att)
      }
    );
    await assertGraphOk(aRes, 201, 'attach to reply draft');
  }

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

function buildAttachments(rawAttachments) {
  const list = Array.isArray(rawAttachments) ? rawAttachments : [];
  if (!list.length) return [];
  const totalBytes = list.reduce((n, a) => n + (a.size || (a.content ? a.content.length : 0)), 0);
  if (totalBytes > 3 * 1024 * 1024) {
    throw new Error(
      `Total attachment size ${(totalBytes / 1024 / 1024).toFixed(1)} MB exceeds Graph's 3 MB inline limit. ` +
      `Use smaller files or split across messages.`
    );
  }
  return list.map(a => ({
    '@odata.type': '#microsoft.graph.fileAttachment',
    name: a.filename || 'attachment',
    contentType: a.content_type || 'application/octet-stream',
    contentBytes: Buffer.isBuffer(a.content)
      ? a.content.toString('base64')
      : Buffer.from(a.content || '').toString('base64')
  }));
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

module.exports = { sendEmailViaGraph };
