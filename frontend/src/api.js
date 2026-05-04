const TOKEN_KEY = 'missive_clone_token';

// Empty string -> same-origin (works for Vite dev proxy + single-service prod).
// Set VITE_API_URL at build time only when frontend & backend are on
// different domains.
const API_BASE = import.meta.env.VITE_API_URL || '';

export function getApiBase() { return API_BASE; }

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(t) {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}

export async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(API_BASE + path, { ...opts, headers });
  const ct = res.headers.get('content-type') || '';
  const body = ct.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    const msg = (body && body.error) || res.statusText;
    throw new Error(msg);
  }
  return body;
}
