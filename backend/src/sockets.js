const { Server } = require('socket.io');
const { verify } = require('./auth');

let io = null;

function initSockets(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: process.env.CLIENT_ORIGIN || '*', credentials: true }
  });

  io.use((socket, next) => {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    if (!token) return next(new Error('no token'));
    try {
      const payload = verify(token);
      socket.data.user = payload;
      next();
    } catch {
      next(new Error('invalid token'));
    }
  });

  io.on('connection', (socket) => {
    const ws = socket.data.user.workspace_id;
    socket.join(`ws:${ws}`);
  });

  return io;
}

function emitToWorkspace(workspaceId, event, payload) {
  if (!io) return;
  io.to(`ws:${workspaceId}`).emit(event, payload);
}

module.exports = { initSockets, emitToWorkspace };
