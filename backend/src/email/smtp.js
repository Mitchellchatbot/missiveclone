const nodemailer = require('nodemailer');
const MailComposer = require('nodemailer/lib/mail-composer');
const { one } = require('../db');
const { decrypt } = require('../crypto');
const { appendToSentFolder } = require('./imap');

function buildTransport(acc) {
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

async function sendEmail(accountId, { to, cc, subject, text, html, inReplyTo, references, attachments }) {
  const acc = await one('SELECT * FROM email_accounts WHERE id = $1', [accountId]);
  if (!acc) throw new Error('account not found');
  const tx = buildTransport(acc);
  const fromName = acc.display_name || acc.email;
  const headers = {};
  if (inReplyTo) headers['In-Reply-To'] = `<${inReplyTo}>`;
  if (references && references.length) headers['References'] = references.map(r => `<${r}>`).join(' ');

  const mail = {
    from: `"${fromName}" <${acc.email}>`,
    to, cc, subject, text, html, headers,
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
