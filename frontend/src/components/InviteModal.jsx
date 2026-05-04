import React, { useEffect, useState } from 'react';
import { api } from '../api';

export default function InviteModal({ onClose }) {
  const [invites, setInvites] = useState([]);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [latestLink, setLatestLink] = useState('');

  async function load() {
    try { const r = await api('/api/invites'); setInvites(r.invites || []); }
    catch (e) { setErr(e.message); }
  }
  useEffect(() => { load(); }, []);

  async function create(e) {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      const r = await api('/api/invites', { method: 'POST', body: JSON.stringify({ email }) });
      setEmail('');
      setLatestLink(window.location.origin + '/invite/' + r.token);
      load();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  async function revoke(id) {
    if (!confirm('Revoke this invite?')) return;
    await api(`/api/invites/${id}`, { method: 'DELETE' });
    load();
  }

  function copyLink(token) {
    const link = window.location.origin + '/invite/' + token;
    navigator.clipboard.writeText(link).then(() => setLatestLink(link));
  }

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h3>Invite a teammate</h3>
        <form className="row" onSubmit={create}>
          <input
            placeholder="teammate@example.com"
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
          />
          <button disabled={busy} style={{ flex: '0 0 auto' }}>{busy ? '…' : 'Create invite'}</button>
        </form>
        {err && <div className="err">{err}</div>}
        {latestLink && (
          <div className="callout">
            <div className="muted small">Share this link with your teammate:</div>
            <div className="invite-link">{latestLink}</div>
          </div>
        )}

        <div className="side-section-title" style={{ color: '#59636e' }}>Pending invites</div>
        {invites.length === 0 && <div className="muted small">No invites yet</div>}
        {invites.map(i => (
          <div key={i.id} className="invite-row">
            <div>
              <strong>{i.email}</strong>
              <div className="muted small">
                {i.accepted_at ? 'Accepted ' + new Date(Number(i.accepted_at)).toLocaleString()
                  : 'Expires ' + new Date(Number(i.expires_at)).toLocaleDateString()}
              </div>
            </div>
            <div className="row" style={{ flex: '0 0 auto' }}>
              {!i.accepted_at && (
                <>
                  <button className="ghost small" onClick={() => copyLink(i.token)}>Copy link</button>
                  <button className="ghost small" onClick={() => revoke(i.id)}>Revoke</button>
                </>
              )}
            </div>
          </div>
        ))}

        <div className="row right">
          <button className="ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
