const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { v4: uuid } = require('uuid');
const { one, many, query, tx } = require('../db');
const { requireAuth, sign } = require('../auth');
const { sendEmail } = require('../email/smtp');
const wrap = require('../util/wrap');

const router = express.Router();

const INVITE_TTL_DAYS = 14;

function buildInviteUrl(req, token) {
  // Single-service deploy: same origin as the API. trust proxy is on so
  // req.protocol reflects the X-Forwarded-Proto header from Railway.
  const proto = req.protocol;
  const host = req.get('host');
  return `${proto}://${host}/invite/${token}`;
}

async function sendInviteEmail({ fromAccountId, toEmail, workspaceName, inviterName, link }) {
  const subject = `${inviterName} invited you to join ${workspaceName}`;
  const text =
    `Hi,\n\n` +
    `${inviterName} has invited you to join ${workspaceName} on Missive Clone — a shared inbox where teammates collaborate on email.\n\n` +
    `Click this link to accept the invite and set up your account:\n\n${link}\n\n` +
    `This link expires in ${INVITE_TTL_DAYS} days.\n\n` +
    `If you weren't expecting this, you can ignore this email.`;
  const html =
    `<p>Hi,</p>` +
    `<p><strong>${escapeHtml(inviterName)}</strong> has invited you to join <strong>${escapeHtml(workspaceName)}</strong> on Missive Clone — a shared inbox where teammates collaborate on email.</p>` +
    `<p><a href="${link}" style="background:#2f6feb;color:white;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block;font-weight:500">Accept invite</a></p>` +
    `<p style="color:#666;font-size:12px">Or paste this link into your browser:<br/><span style="font-family:monospace">${link}</span></p>` +
    `<p style="color:#999;font-size:12px">This link expires in ${INVITE_TTL_DAYS} days.</p>`;
  return sendEmail(fromAccountId, { to: toEmail, subject, text, html });
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ----- Authenticated: create + list invites -----
router.get('/', requireAuth, wrap(async (req, res) => {
  const rows = await many(
    `SELECT id, email, token, accepted_at, created_at, expires_at
     FROM invites WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 100`,
    [req.user.workspace_id]
  );
  res.json({ invites: rows });
}));

router.post('/', requireAuth, wrap(async (req, res) => {
  const { email, send_email_from } = req.body || {};
  if (!email) return res.status(400).json({ error: 'email required' });
  const lowered = email.toLowerCase();

  const existingUser = await one('SELECT id FROM users WHERE email = $1', [lowered]);
  if (existingUser) return res.status(409).json({ error: 'user already has an account' });

  const id = uuid();
  const token = crypto.randomBytes(24).toString('hex');
  const now = Date.now();
  const expires = now + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000;

  await query(
    `INSERT INTO invites (id, workspace_id, invited_by, email, token, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, req.user.workspace_id, req.user.id, lowered, token, now, expires]
  );

  // Optionally email the link directly from one of the workspace's mailboxes.
  let emailed = false;
  let emailError = null;
  if (send_email_from) {
    const acc = await one(
      'SELECT id FROM email_accounts WHERE id = $1 AND workspace_id = $2',
      [send_email_from, req.user.workspace_id]
    );
    if (!acc) {
      emailError = 'send_email_from account not found in this workspace';
    } else {
      try {
        const ws = await one('SELECT name FROM workspaces WHERE id = $1', [req.user.workspace_id]);
        const me = await one('SELECT name FROM users WHERE id = $1', [req.user.id]);
        await sendInviteEmail({
          fromAccountId: acc.id,
          toEmail: lowered,
          workspaceName: ws ? ws.name : 'your workspace',
          inviterName: me ? me.name : 'A teammate',
          link: buildInviteUrl(req, token)
        });
        emailed = true;
      } catch (e) {
        emailError = e.message;
        console.error('invite email failed:', e.message);
      }
    }
  }

  res.json({ id, token, email: lowered, expires_at: expires, emailed, email_error: emailError });
}));

// Resend / send email for an existing invite.
router.post('/:id/email', requireAuth, wrap(async (req, res) => {
  const { from_account_id } = req.body || {};
  if (!from_account_id) return res.status(400).json({ error: 'from_account_id required' });

  const inv = await one(
    'SELECT * FROM invites WHERE id = $1 AND workspace_id = $2',
    [req.params.id, req.user.workspace_id]
  );
  if (!inv) return res.status(404).json({ error: 'invite not found' });
  if (inv.accepted_at) return res.status(410).json({ error: 'invite already accepted' });
  if (Number(inv.expires_at) < Date.now()) return res.status(410).json({ error: 'invite expired' });

  const acc = await one(
    'SELECT id FROM email_accounts WHERE id = $1 AND workspace_id = $2',
    [from_account_id, req.user.workspace_id]
  );
  if (!acc) return res.status(400).json({ error: 'from_account_id invalid' });

  const ws = await one('SELECT name FROM workspaces WHERE id = $1', [req.user.workspace_id]);
  const me = await one('SELECT name FROM users WHERE id = $1', [req.user.id]);
  await sendInviteEmail({
    fromAccountId: acc.id,
    toEmail: inv.email,
    workspaceName: ws ? ws.name : 'your workspace',
    inviterName: me ? me.name : 'A teammate',
    link: buildInviteUrl(req, inv.token)
  });
  res.json({ ok: true });
}));

router.delete('/:id', requireAuth, wrap(async (req, res) => {
  const inv = await one(
    'SELECT id FROM invites WHERE id = $1 AND workspace_id = $2',
    [req.params.id, req.user.workspace_id]
  );
  if (!inv) return res.status(404).json({ error: 'not found' });
  await query('DELETE FROM invites WHERE id = $1', [inv.id]);
  res.json({ ok: true });
}));

// ----- Public: read invite by token (so the accept page can show context) -----
router.get('/by-token/:token', wrap(async (req, res) => {
  const inv = await one(
    `SELECT i.id, i.email, i.workspace_id, i.expires_at, i.accepted_at, w.name AS workspace_name
     FROM invites i JOIN workspaces w ON w.id = i.workspace_id
     WHERE i.token = $1`,
    [req.params.token]
  );
  if (!inv) return res.status(404).json({ error: 'invite not found' });
  if (inv.accepted_at) return res.status(410).json({ error: 'already accepted' });
  if (Number(inv.expires_at) < Date.now()) return res.status(410).json({ error: 'invite expired' });
  res.json({
    email: inv.email,
    workspace_name: inv.workspace_name,
    expires_at: inv.expires_at
  });
}));

// ----- Public: accept invite (creates user account in workspace) -----
router.post('/accept', wrap(async (req, res) => {
  const { token, name, password } = req.body || {};
  if (!token || !name || !password) return res.status(400).json({ error: 'token, name, password required' });

  const inv = await one('SELECT * FROM invites WHERE token = $1', [token]);
  if (!inv) return res.status(404).json({ error: 'invite not found' });
  if (inv.accepted_at) return res.status(410).json({ error: 'already accepted' });
  if (Number(inv.expires_at) < Date.now()) return res.status(410).json({ error: 'invite expired' });

  const existing = await one('SELECT id FROM users WHERE email = $1', [inv.email]);
  if (existing) return res.status(409).json({ error: 'email already registered' });

  const userId = uuid();
  const now = Date.now();
  const hash = bcrypt.hashSync(password, 10);

  await tx(async (c) => {
    await c.query(
      'INSERT INTO users (id, workspace_id, email, password_hash, name, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [userId, inv.workspace_id, inv.email, hash, name, now]
    );
    await c.query('UPDATE invites SET accepted_at = $1 WHERE id = $2', [now, inv.id]);
  });

  const user = await one('SELECT id, workspace_id, email, name FROM users WHERE id = $1', [userId]);
  res.json({ token: sign(user), user });
}));

module.exports = router;
