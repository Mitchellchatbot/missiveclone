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
const { initSockets } = require('./sockets');
const { startAllWatchers, syncAccount } = require('./email/imap');

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
    database_ssl: process.env.DATABASE_SSL || null
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

      setInterval(async () => {
        try {
          const accs = await many('SELECT id FROM email_accounts');
          for (const a of accs) {
            syncAccount(a.id).catch(err => console.error('poll sync', a.id, err.message));
          }
        } catch (e) {
          console.error('poll loop', e.message);
        }
      }, 2 * 60 * 1000);
    } catch (e) {
      dbInitError = e.message;
      console.error('[boot] DB init FAILED:', e.message);
      console.error('Hit GET /api/status for diagnostic info.');
    }
  })();
});

process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));
