import { io } from 'socket.io-client';
import { getToken, getApiBase } from './api';

let socket = null;

export function getSocket() {
  if (socket) return socket;
  const base = getApiBase();
  // io() with no URL -> current origin (works for dev proxy + single-service prod).
  socket = base
    ? io(base, { auth: { token: getToken() } })
    : io({ auth: { token: getToken() } });
  return socket;
}

export function disconnectSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}
