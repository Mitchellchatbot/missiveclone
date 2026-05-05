import React, { useEffect, useState } from 'react';
import { api } from '../api';

export default function InviteModal({ accounts, onClose }) {
  const [invites, setInvites] = useState([]);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [latestLink, setLatestLink] = useState('');
  const [latestStatus, setLatestStatus] = useState('');
  const [sendByEmail, setSendByEmail] = useState(true);
  const [fromAccountId, setFromAccountId] = useState((accounts && accounts[0]?.id) || '');

  useEffect(() => {
    if (!fromAccountId && accounts && accounts[0]) setFromAccountId(accounts[0].id);
  }, [accounts, fromAccountId]);

  async function load() {
    try { const r = await api('/api/invites'); setInvites(r.invites || []); }
    catch (e) { setErr(e.message); }
  }
  useEffect(() => { load(); }, []);

  async function create(e) {
    e.preventDefault();
    setBusy(true); setErr(''); setLatestStatus('');
    try {
      const body = { email };
      if (sendByEmail && fromAccountId) body.send_email_from = fromAccountId;
      const r = await api('/api/invites', { method: 'POST', body: JSON.stringify(body) });
      setEmail('');
      setLatestLink(window.location.origin + '/invite/' + r.token);
      if (sendByEmail && fromAccountId) {
        if (r.emailed) setLatestStatus(`✅ Invite emailed to ${r.email}`);
        else setLatestStatus(`⚠ Invite created but email failed: ${r.email_error || 'unknown error'}. Copy the link and send it manually.`);
      } else {
        setLatestStatus('Invite link created — copy and share it.');
      }
      load();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  async function emailExisting(id) {
    if (!fromAccountId) {
      alert('Connect an email account first, then come back here.');
      return;
    }
    try {
      await api(`/api/invites/${id}/email`, {
        method: 'POST',
        body: JSON.stringify({ from_account_id: fromAccountId })
      });
      alert('Invite emailed.');
    } catch (e) {
      alert('Email failed: ' + e.message);
    }
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

  const noAccounts = !accounts || accounts.length === 0;

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h3>Invite a teammate</h3>
        <div className="muted small">
          Send them an invite link. They'll set their own password and join your workspace.
        </div>

        <form onSubmit={create} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <input
            placeholder="teammate@example.com"
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
          />

          <label className="check small" style={{ marginTop: 4 }}>
            <input
              type="checkbox"
              checked={sendByEmail && !noAccounts}
              disabled={noAccounts}
              onChange={e => setSendByEmail(e.target.checked)}
            />
            Email the invite link directly to them
            {noAccounts && <span className="muted small"> (connect a mailbox first)</span>}
          </label>

          {sendByEmail && !noAccounts && (
            <div className="row" style={{ gap: 6 }}>
              <span className="muted small" style={{ flex: '0 0 auto' }}>From:</span>
              <select value={fromAccountId} onChange={e => setFromAccountId(e.target.value)}>
                {accounts.map(a => (
                  <option key={a.id} value={a.id}>
                    {a.display_name ? `${a.display_name} (${a.email})` : a.email}
                  </option>
                ))}
              </select>
            </div>
          )}

          <button disabled={busy}>
            {busy ? '…' : (sendByEmail && !noAccounts ? 'Create & email invite' : 'Create invite link')}
          </button>
        </form>

        {err && <div className="err">{err}</div>}

        {(latestLink || latestStatus) && (
          <div className="callout">
            {latestStatus && <div style={{ marginBottom: 6 }}>{latestStatus}</div>}
            {latestLink && (
              <>
                <div className="muted small">Or share this link:</div>
                <div className="invite-link">{latestLink}</div>
                <button className="link" onClick={() => navigator.clipboard.writeText(latestLink)} style={{ marginTop: 4 }}>Copy link</button>
              </>
            )}
          </div>
        )}

        <div className="side-section-title" style={{ color: '#59636e' }}>Pending invites</div>
        {invites.length === 0 && <div className="muted small">No invites yet</div>}
        {invites.map(i => (
          <div key={i.id} className="invite-row">
            <div style={{ minWidth: 0 }}>
              <strong>{i.email}</strong>
              <div className="muted small">
                {i.accepted_at ? '✅ Accepted ' + new Date(Number(i.accepted_at)).toLocaleString()
                  : '⏰ Expires ' + new Date(Number(i.expires_at)).toLocaleDateString()}
              </div>
            </div>
            <div className="row" style={{ flex: '0 0 auto', gap: 4 }}>
              {!i.accepted_at && (
                <>
                  {!noAccounts && (
                    <button className="ghost small" onClick={() => emailExisting(i.id)}>📧 Email</button>
                  )}
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
