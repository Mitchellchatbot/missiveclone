const nodemailer = require('nodemailer');
const MailComposer = require('nodemailer/lib/mail-composer');
const { one } = require('../db');
const { decrypt } = require('../crypto');
const { appendToSentFolder } = require('./imap');
const ms = require('../oauth/microsoft');

async function buildTransport(acc) {
  if (acc.provider === 'microsoft') {
    const accessToken = await ms.ensureFreshAccessToken(acc);
    return nodemailer.createTransport({
      host: acc.smtp_host || 'smtp.office365.com',
      port: acc.smtp_port || 587,
      secure: false,
      requireTLS: true,
      auth: {
        type: 'OAuth2',
        user: acc.email,
        accessToken
      }
    });
  }
  return nodemailer.createTransport({
    host: acc.smtp_host,
    port: acc.smtp_port,
    secure: !!acc.smtp_secure,
    auth: { user: acc.smtp_user, pass: decrypt(acc.smtp_pass) }
  });
}

function compileRaw(mail) {
  return new Promise((resolve, reject) => {
    const m = new MailComposer(mail);
    m.compile().build((err, msg) => err ? reject(err) : resolve(msg));
  });
}

async function sendEmail(accountId, { to, cc, bcc, subject, text, html, inReplyTo, references, attachments }) {
  const acc = await one('SELECT * FROM email_accounts WHERE id = $1', [accountId]);
  if (!acc) throw new Error('account not found');
  const tx = await buildTransport(acc);
  const fromName = acc.display_name || acc.email;
  const headers = {};
  if (inReplyTo) headers['In-Reply-To'] = `<${inReplyTo}>`;
  if (references && references.length) headers['References'] = references.map(r => `<${r}>`).join(' ');

  // Append signature if configured. Skipped if the body already contains the
  // signature (handles the case where the client pre-rendered it).
  let outText = text || '';
  let outHtml = html || '';
  if (acc.signature_text && outText && !outText.includes(acc.signature_text)) {
    outText = outText + '\n\n-- \n' + acc.signature_text;
  }
  if (acc.signature_html && outHtml && !outHtml.includes(acc.signature_html)) {
    outHtml = outHtml + '<br/><br/>--<br/>' + acc.signature_html;
  }

  const mail = {
    from: `"${fromName}" <${acc.email}>`,
    to, cc, bcc, subject, text: outText, html: outHtml, headers,
    attachments: (attachments || []).map(a => ({
      filename: a.filename,
      content: a.content,                 // Buffer
      contentType: a.content_type,
      cid: a.content_id || undefined
    }))
  };

  // Send via SMTP.
  const info = await tx.sendMail(mail);

  // Best-effort: append the same message to the IMAP Sent folder so it shows
  // up in webmail UIs. Skip for hosts whose SMTP auto-saves to Sent
  // (Gmail, Outlook/M365) — appending there creates duplicates.
  const host = (acc.smtp_host || '').toLowerCase();
  const autoSaves = host.includes('gmail.com') ||
                    host.includes('office365.com') ||
                    host.includes('outlook.com');
  if (!autoSaves) {
    try {
      const raw = await compileRaw(mail);
      appendToSentFolder(acc, raw).catch(() => {});
    } catch (e) {
      console.warn('compile-for-append failed:', e.message);
    }
  }

  return { messageId: (info.messageId || '').replace(/[<>]/g, ''), accepted: info.accepted };
}

module.exports = { sendEmail };
