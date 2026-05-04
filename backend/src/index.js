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
const { many } = db;
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

const corsOrigin = process.env.CLIENT_ORIGIN || true;
app.use(cors({ origin: corsOrigin, credentials: true }));
app.use(express.json({ limit: '5mb' }));

app.get('/api/health', (_req, res) => res.json({ ok: true }));
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
  console.log('Serving frontend from', distPath);
} else {
  console.log('No frontend build at', distPath, '- API only mode');
}

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'server error' });
});

const server = http.createServer(app);
initSockets(server);

const PORT = Number(process.env.PORT || 4000);

(async () => {
  try {
    await db.init();
    console.log('DB initialized');
  } catch (e) {
    console.error('DB init failed:', e.message);
    process.exit(1);
  }

  server.listen(PORT, () => {
    console.log(`API listening on :${PORT}`);
    startAllWatchers().catch(() => {});

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
  });
})();
