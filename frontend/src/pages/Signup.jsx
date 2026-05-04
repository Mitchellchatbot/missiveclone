import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, setToken } from '../api';

export default function Signup({ onAuth }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [workspace, setWorkspace] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setErr(''); setBusy(true);
    try {
      const { token } = await api('/api/auth/signup', {
        method: 'POST',
        body: JSON.stringify({ name, email, password, workspace_name: workspace })
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
        <h2>Sign up</h2>
        <input placeholder="Your name" value={name} onChange={e => setName(e.target.value)} required />
        <input placeholder="Email" type="email" value={email} onChange={e => setEmail(e.target.value)} required />
        <input placeholder="Password (min 6)" type="password" minLength={6} value={password} onChange={e => setPassword(e.target.value)} required />
        <input placeholder="Workspace name (optional)" value={workspace} onChange={e => setWorkspace(e.target.value)} />
        <button disabled={busy}>{busy ? '…' : 'Create account'}</button>
        {err && <div className="err">{err}</div>}
        <div className="muted">Have an account? <Link to="/login">Log in</Link></div>
      </form>
    </div>
  );
}
