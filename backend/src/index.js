require('dotenv').config();
const http = require('http');
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');

if (!process.env.JWT_SECRET) {
  console.warn('WARNING: JWT_SECRET not set; using a temporary one. Set it in env for production.');
  process.env.JWT_SECRET = require('crypto').randomBytes(32).toString('hex');
}

// Backstop: an unlistened socket 'error' from a long-lived ImapFlow watcher
// (or any background async failure) would otherwise kill the process and
// trigger a Railway restart loop. Log and keep running — per-watcher cleanup
// happens at the source via client.on('error') in email/imap.js.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', (err && err.stack) || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', (reason && reason.stack) || reason);
});

const db = require('./db');
const { many, ping, HAS_DB } = db;
const authRoutes = require('./routes/auth');
const accountRoutes = require('./routes/accounts');
const threadRoutes = require('./routes/threads');
const attachmentRoutes = require('./routes/attachments');
const inviteRoutes = require('./routes/invites');
const cannedRoutes = require('./routes/canned');
const draftRoutes = require('./routes/drafts');
const chatRoutes = require('./routes/chat');
const teamSpaceRoutes = require('./routes/team_spaces');
const taskRoutes = require('./routes/tasks');
const composeRoutes = require('./routes/compose');
const labelRoutes = require('./routes/labels');
const scheduledRoutes = require('./routes/scheduled');
const oauthMicrosoftRoutes = require('./routes/oauth_microsoft');
const { initSockets } = require('./sockets');
const { startAllWatchers, startWatchdog, syncAccount } = require('./email/imap');

const app = express();
app.set('trust proxy', 1);

const corsOrigin = process.env.CLIENT_ORIGIN || true;
app.use(cors({ origin: corsOrigin, credentials: true }));
app.use(express.json({ limit: '5mb' }));

// Healthcheck must always succeed so platforms can detect "container is alive"
// even before DB init finishes.
let dbReady = false;
let dbInitError = null;
app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.get('/api/status', async (_req, res) => {
  const dbPing = await ping();
  res.json({
    ok: true,
    has_database_url: HAS_DB,
    db_ready: dbReady,
    db_init_error: dbInitError,
    db_ping: dbPing,
    node_env: process.env.NODE_ENV || null,
    has_jwt_secret: !!process.env.JWT_SECRET,
    has_encryption_key: !!process.env.ENCRYPTION_KEY,
    database_ssl: process.env.DATABASE_SSL || null,
    microsoft_oauth: {
      configured: !!(process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET && process.env.MICROSOFT_REDIRECT_URI),
      tenant: process.env.MICROSOFT_TENANT || 'common',
      redirect_uri: process.env.MICROSOFT_REDIRECT_URI || null
    }
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/accounts', accountRoutes);
app.use('/api/threads', threadRoutes);
app.use('/api/attachments', attachmentRoutes);
app.use('/api/invites', inviteRoutes);
app.use('/api/canned', cannedRoutes);
app.use('/api/drafts', draftRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/team_spaces', teamSpaceRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/compose', composeRoutes);
app.use('/api/labels', labelRoutes);
app.use('/api/scheduled', scheduledRoutes);
app.use('/api/oauth/microsoft', oauthMicrosoftRoutes);

// Serve the built frontend (single-service deploy on Railway etc.)
const distPath = path.join(__dirname, '..', '..', 'frontend', 'dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/socket.io')) return next();
    res.sendFile(path.join(distPath, 'index.html'));
  });
  console.log('[boot] serving frontend from', distPath);
} else {
  console.log('[boot] no frontend build at', distPath, '- API only mode');
}

app.use((err, _req, res, _next) => {
  console.error('[express error]', err);
  // multer rejects oversized uploads/fields during multipart parsing, before
  // the route runs. Surface a clear, actionable message instead of a generic
  // 500 — the common case is a body bloated by pasted screenshots.
  if (err && err.name === 'MulterError') {
    const map = {
      LIMIT_FIELD_VALUE: 'The message is too large to send. If you pasted images into the body, attach them as files instead.',
      LIMIT_FILE_SIZE: 'An attachment is too large (max 150 MB each).',
      LIMIT_FILE_COUNT: 'Too many attachments (max 10).',
      LIMIT_UNEXPECTED_FILE: 'Unexpected upload field.'
    };
    return res.status(413).json({ error: map[err.code] || ('Upload error: ' + err.message) });
  }
  res.status(500).json({ error: err.message || 'server error' });
});

const server = http.createServer(app);
initSockets(server);

const PORT = Number(process.env.PORT || 4000);

console.log('[boot] env:', {
  NODE_ENV: process.env.NODE_ENV || null,
  PORT,
  has_DATABASE_URL: !!process.env.DATABASE_URL,
  DATABASE_SSL: process.env.DATABASE_SSL || null,
  has_JWT_SECRET: !!process.env.JWT_SECRET,
  has_ENCRYPTION_KEY: !!process.env.ENCRYPTION_KEY,
  CLIENT_ORIGIN: process.env.CLIENT_ORIGIN || '(unset, allowing any)'
});

// Listen FIRST so the platform healthcheck succeeds. Initialize the DB after
// — if it fails, /api/status will report the error so we can debug.
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[boot] HTTP listening on 0.0.0.0:${PORT}`);

  if (!HAS_DB) {
    console.warn('[boot] skipping DB init: DATABASE_URL is missing');
    return;
  }

  (async () => {
    try {
      console.log('[boot] initializing database…');
      await db.init();
      dbReady = true;
      console.log('[boot] DB ready');

      try { await startAllWatchers(); } catch (e) { console.error('[boot] watchers failed', e.message); }
      try { startWatchdog(); } catch (e) { console.error('[boot] watchdog failed', e.message); }

      // Fallback poll. Dropped from 2 min → 30s now that the pool's
      // larger and watchers self-heal on disconnect — this is purely a
      // safety net for the rare case where IDLE silently misses an
      // EXISTS event (some Exchange tenants under load).
      setInterval(async () => {
        try {
          const accs = await many('SELECT id FROM email_accounts');
          for (const a of accs) {
            syncAccount(a.id).catch(err => console.error('poll sync', a.id, err.message));
          }
        } catch (e) {
          console.error('poll loop', e.message);
        }
      }, 30 * 1000);

      // Scheduled-send dispatcher — every 30s, send any due messages.
      const { sendEmail } = require('./email/smtp');
      const { v4: uuid } = require('uuid');
      const { query, tx, emitToWorkspace } = (() => {
        const dbm = require('./db');
        const sock = require('./sockets');
        return { query: dbm.query, tx: dbm.tx, emitToWorkspace: sock.emitToWorkspace };
      })();
      setInterval(async () => {
        try {
          const due = await many(
            `SELECT * FROM scheduled_messages WHERE status = 'pending' AND send_at <= $1 LIMIT 20`,
            [Date.now()]
          );
          for (const s of due) {
            let attachments = [];
            let sent;
            // Phase 1 — actually send. A throw here means the email never went
            // out, so marking the row 'failed' is correct.
            try {
              await query(`UPDATE scheduled_messages SET status = 'sending' WHERE id = $1`, [s.id]);

              // Replay any attachments stashed at schedule time. BYTEA comes
              // back from pg as a Buffer, which is exactly what sendEmail (SMTP
              // + Graph) expects in attachments[].content.
              const atts = await query(
                `SELECT filename, content_type, content_id, data
                   FROM scheduled_attachments WHERE scheduled_message_id = $1`,
                [s.id]
              );
              attachments = atts.rows.map(r => ({
                filename: r.filename,
                content: r.data,
                content_type: r.content_type,
                content_id: r.content_id || undefined
              }));

              console.log(`[scheduled] sending ${s.id} with ${attachments.length} attachment(s)`);
              sent = await sendEmail(s.account_id, {
                to: s.to_addrs,
                cc: s.cc_addrs,
                subject: s.subject,
                text: s.body_text || '',
                html: s.body_html || '',
                inReplyTo: s.in_reply_to || null,
                attachments
              });
            } catch (e) {
              console.error('[scheduled] send failed', s.id, e.message);
              await query(
                `UPDATE scheduled_messages SET status = 'failed', error = $1 WHERE id = $2`,
                [e.message, s.id]
              );
              continue;
            }

            // Phase 2 — the email is already out. A DB failure here must NOT
            // mark the row 'failed': that would misreport a sent email and
            // could prompt a manual resend. Only the inbox copy + live events
            // are at stake; record 'sent' regardless.
            try {
              // Materialize as a thread/message so it shows up in the inbox.
              // One tx so the inbox copy is all-or-nothing (the send already
              // happened above — never wrap that network call in a tx).
              const threadId = uuid();
              const msgId = uuid();
              const now = Date.now();
              await tx(async (client) => {
                await client.query(
                  `INSERT INTO threads (id, workspace_id, subject, participants,
                                        last_message_at, status, message_id_root, search_text, created_at)
                   VALUES ($1, $2, $3, $4, $5, 'open', $6, $7, $8)`,
                  [threadId, s.workspace_id,
                   s.subject || '', [s.to_addrs, s.cc_addrs].filter(Boolean).join('; '),
                   now, sent.messageId || null,
                   (s.subject || '') + ' ' + [s.to_addrs, s.cc_addrs].filter(Boolean).join(' '),
                   now]
                );
                await client.query(
                  `INSERT INTO messages (id, thread_id, account_id, workspace_id, direction, folder,
                    message_id, subject, from_addr, to_addrs, cc_addrs, body_text, body_html,
                    sent_at, has_attachments, is_automated, created_at)
                   VALUES ($1, $2, $3, $4, 'outbound', 'Sent', $5, $6, '', $7, $8, $9, $10, $11, $12, $13, $14)`,
                  [msgId, threadId, s.account_id, s.workspace_id, sent.messageId,
                   s.subject || '', s.to_addrs || '', s.cc_addrs || '',
                   s.body_text || '', s.body_html || '', now, attachments.length ? 1 : 0, s.is_automated || 0, now]
                );
                for (const a of attachments) {
                  await client.query(
                    `INSERT INTO attachments (id, message_id, workspace_id, filename, content_type, size_bytes, content_id, data, created_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                    [uuid(), msgId, s.workspace_id, a.filename, a.content_type,
                     a.content ? a.content.length : 0, a.content_id || null, a.content, now]
                  );
                }
              });

              // The bytes now live in `attachments` against the real message;
              // drop the scheduled copy to reclaim BYTEA, keeping the 'sent'
              // status row so ScheduledView still shows the history.
              await query(`DELETE FROM scheduled_attachments WHERE scheduled_message_id = $1`, [s.id]);

              await query(`UPDATE scheduled_messages SET status = 'sent', thread_id = $1 WHERE id = $2`, [threadId, s.id]);
              emitToWorkspace(s.workspace_id, 'thread:updated', { thread_id: threadId, account_id: s.account_id });
              emitToWorkspace(s.workspace_id, 'message:new', { thread_id: threadId, message_id: msgId, account_id: s.account_id });
              // Push to DD via webhook so the scheduled email shows
              // up live just like a compose-sent one would.
              const { fireWebhook } = require('./email/imap');
              fireWebhook('message:new', {
                workspace_id: s.workspace_id,
                account_id: s.account_id,
                thread_id: threadId,
                message_id: msgId
              });
            } catch (e) {
              // Already sent — never 'failed'. Best-effort mark 'sent' so the
              // dispatcher (which only re-picks 'pending') never resends it; a
              // row stuck in 'sending' is likewise never re-picked.
              console.error('[scheduled] sent but post-send bookkeeping failed', s.id, e.message);
              try {
                await query(
                  `UPDATE scheduled_messages SET status = 'sent', error = $1 WHERE id = $2`,
                  ['post-send bookkeeping failed: ' + e.message, s.id]
                );
              } catch (e2) {
                console.error('[scheduled] could not mark sent after bookkeeping failure', s.id, e2.message);
              }
            }
          }
        } catch (e) {
          console.error('scheduler tick', e.message);
        }
      }, 30 * 1000);
    } catch (e) {
      dbInitError = e.message;
      console.error('[boot] DB init FAILED:', e.message);
      console.error('Hit GET /api/status for diagnostic info.');
    }
  })();
});

process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));
