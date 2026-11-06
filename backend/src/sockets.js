const { Server } = require('socket.io');
const { verifySession, logNonSessionToken } = require('./auth');

let io = null;

// The client's address the way Express works out req.ip under `trust proxy` 1
// (index.js): the right-most X-Forwarded-For hop, which the proxy in front of
// us appended, else the peer address. Only used to log a rejected token.
function handshakeIp(handshake) {
  const xff = handshake.headers && handshake.headers['x-forwarded-for'];
  const hops = typeof xff === 'string' ? xff.split(',').map((s) => s.trim()).filter(Boolean) : [];
  return hops.length ? hops[hops.length - 1] : handshake.address;
}

// workspace_id -> Map(user_id -> { name, email, count })
const presence = new Map();

function snapshotForWorkspace(wsId) {
  const m = presence.get(wsId);
  if (!m) return [];
  return Array.from(m.entries()).map(([uid, info]) => ({
    user_id: uid, name: info.name, email: info.email
  }));
}

function broadcastPresence(wsId) {
  if (!io) return;
  io.to(`ws:${wsId}`).emit('presence:update', { online: snapshotForWorkspace(wsId) });
}

function initSockets(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: process.env.CLIENT_ORIGIN || '*', credentials: true }
  });

  io.use((socket, next) => {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    if (!token) return next(new Error('no token'));
    try {
      // Same session check as requireAuth: an OAuth state or any other
      // non-session JWT is refused here too, not just on HTTP.
      const payload = verifySession(token);
      socket.data.user = payload;
      next();
    } catch (e) {
      logNonSessionToken(e, token, { via: 'socket', ip: handshakeIp(socket.handshake) });
      next(new Error('invalid token'));
    }
  });

  io.on('connection', (socket) => {
    const u = socket.data.user;
    const ws = u.workspace_id;
    socket.join(`ws:${ws}`);

    if (!presence.has(ws)) presence.set(ws, new Map());
    const m = presence.get(ws);
    const existing = m.get(u.id);
    if (existing) {
      existing.count += 1;
    } else {
      m.set(u.id, { name: u.email, email: u.email, count: 1 });
    }
    broadcastPresence(ws);

    socket.on('presence:hello', (info) => {
      const cur = m.get(u.id);
      if (cur && info && info.name) {
        cur.name = info.name;
        broadcastPresence(ws);
      }
    });

    socket.on('disconnect', () => {
      const cur = m.get(u.id);
      if (!cur) return;
      cur.count -= 1;
      if (cur.count <= 0) m.delete(u.id);
      broadcastPresence(ws);
    });
  });

  return io;
}

function emitToWorkspace(workspaceId, event, payload) {
  if (!io) return;
  io.to(`ws:${workspaceId}`).emit(event, payload);
}

module.exports = { initSockets, emitToWorkspace };
