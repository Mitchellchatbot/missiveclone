const ms = require('../oauth/microsoft');

const GRAPH_SCOPE = 'https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Mail.ReadWrite offline_access';

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

  // Threading headers for Graph: `internetMessageHeaders` only allows
  // headers prefixed `x-`/`X-`, so standard names like In-Reply-To and
  // References are rejected there. The supported workaround is to set
  // them via `singleValueExtendedProperties` under PSETID_INTERNET_HEADERS
  // (GUID 00020386-0000-0000-C000-000000000046, MAPI's "internet headers"
  // namespace). Graph translates these into real RFC 5322 headers on the
  // outbound message, which is what non-Microsoft recipients (and Outlook
  // web) use to thread the reply correctly.
  const extProps = [];
  if (mail.inReplyTo) {
    extProps.push({
      id: 'String {00020386-0000-0000-C000-000000000046} Name In-Reply-To',
      value: `<${mail.inReplyTo}>`
    });
  }
  if (mail.references && mail.references.length) {
    extProps.push({
      id: 'String {00020386-0000-0000-C000-000000000046} Name References',
      value: mail.references.map(r => `<${r}>`).join(' ')
    });
  }
  if (extProps.length) message.singleValueExtendedProperties = extProps;

  // Inline attachments (base64). Graph caps this at ~3 MB total per message;
  // larger attachments need an upload-session API which we skip in MVP.
  if (Array.isArray(mail.attachments) && mail.attachments.length) {
    const totalBytes = mail.attachments.reduce((n, a) => n + (a.size || (a.content ? a.content.length : 0)), 0);
    if (totalBytes > 3 * 1024 * 1024) {
      throw new Error(
        `Total attachment size ${(totalBytes / 1024 / 1024).toFixed(1)} MB exceeds Graph's 3 MB inline limit. ` +
        `Use smaller files or split across messages.`
      );
    }
    message.attachments = mail.attachments.map(a => ({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: a.filename || 'attachment',
      contentType: a.content_type || 'application/octet-stream',
      contentBytes: Buffer.isBuffer(a.content)
        ? a.content.toString('base64')
        : Buffer.from(a.content || '').toString('base64')
    }));
  }

  const res = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ message, saveToSentItems: true })
  });

  // Graph returns 202 Accepted on success.
  if (res.status !== 202) {
    let bodyText = '';
    try { bodyText = await res.text(); } catch { /* ignore */ }
    let parsed;
    try { parsed = JSON.parse(bodyText); } catch { /* ignore */ }
    const detail = (parsed && parsed.error && parsed.error.message) || bodyText || `HTTP ${res.status}`;

    let hint = '';
    if (res.status === 401 || res.status === 403) {
      hint = ' Token may be missing the Mail.Send Graph permission. ' +
             'Disconnect and reconnect this Microsoft account, then admin-consent ' +
             'the Mail.Send permission in your Azure App registration.';
    } else if (res.status === 429) {
      hint = ' Rate-limited by Graph. Try again in a minute.';
    }
    throw new Error(`Graph sendMail failed: ${detail}${hint}`);
  }

  return { messageId: null, accepted: parseAddresses(mail.to).map(r => r.emailAddress.address) };
}

module.exports = { sendEmailViaGraph };
