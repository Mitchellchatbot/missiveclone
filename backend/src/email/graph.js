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

  // Graph's `internetMessageHeaders` only accepts custom headers prefixed
  // `x-`/`X-` — standard RFC 5322 headers like In-Reply-To and References
  // are rejected (Graph errors with "should start with 'x-' or 'X-'").
  // Outlook threads Microsoft↔Microsoft via `conversationId` automatically,
  // and non-Microsoft clients fall back to subject matching, so dropping
  // these headers on the Graph path is the supported approach.
  //
  // If you need true RFC threading guarantees for a specific account, use
  // the SMTP transport instead — smtp.js still sets both headers correctly.
  if (mail.inReplyTo || (mail.references && mail.references.length)) {
    // Surface them as informational X-* so they're at least visible on the
    // wire (useful for debugging) without tripping Graph's validator.
    const headers = [];
    if (mail.inReplyTo) headers.push({ name: 'X-Orig-In-Reply-To', value: `<${mail.inReplyTo}>` });
    if (mail.references && mail.references.length) {
      headers.push({ name: 'X-Orig-References', value: mail.references.map(r => `<${r}>`).join(' ') });
    }
    message.internetMessageHeaders = headers;
  }

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
