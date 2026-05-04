import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, setToken } from '../api';

export default function Login({ onAuth }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setErr(''); setBusy(true);
    try {
      const { token, user } = await api('/api/auth/login', {
        method: 'POST', body: JSON.stringify({ email, password })
      });
      setToken(token);
      const me = await api('/api/auth/me');
      onAuth(me);
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <h1>Missive Clone</h1>
        <h2>Log in</h2>
        <input placeholder="Email" type="email" value={email} onChange={e => setEmail(e.target.value)} required />
        <input placeholder="Password" type="password" value={password} onChange={e => setPassword(e.target.value)} required />
        <button disabled={busy}>{busy ? '…' : 'Log in'}</button>
        {err && <div className="err">{err}</div>}
        <div className="muted">No account? <Link to="/signup">Sign up</Link></div>
      </form>
    </div>
  );
}
