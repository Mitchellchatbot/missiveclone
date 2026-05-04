import React, { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { api, setToken } from '../api';

export default function AcceptInvite({ onAuth }) {
  const { token } = useParams();
  const nav = useNavigate();
  const [info, setInfo] = useState(null);
  const [err, setErr] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api(`/api/invites/by-token/${token}`)
      .then(setInfo)
      .catch(e => setErr(e.message))
      .finally(() => setLoading(false));
  }, [token]);

  async function submit(e) {
    e.preventDefault();
    setErr(''); setBusy(true);
    try {
      const { token: jwt } = await api('/api/invites/accept', {
        method: 'POST',
        body: JSON.stringify({ token, name, password })
      });
      setToken(jwt);
      const me = await api('/api/auth/me');
      onAuth(me);
      nav('/');
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  if (loading) return <div className="center">Loading invite…</div>;
  if (err && !info) return (
    <div className="auth-wrap">
      <div className="auth-card">
        <h1>Invite</h1>
        <div className="err">{err}</div>
        <Link to="/login">Go to login</Link>
      </div>
    </div>
  );

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <h1>Join {info.workspace_name}</h1>
        <div className="muted">You were invited as <strong>{info.email}</strong>.</div>
        <input placeholder="Your name" value={name} onChange={e => setName(e.target.value)} required />
        <input placeholder="Choose a password" type="password" minLength={6}
               value={password} onChange={e => setPassword(e.target.value)} required />
        <button disabled={busy}>{busy ? '…' : 'Accept invite'}</button>
        {err && <div className="err">{err}</div>}
      </form>
    </div>
  );
}
