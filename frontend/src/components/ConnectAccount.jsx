import React, { useState } from 'react';
import { api } from '../api';

const presets = {
  gmail: {
    imap_host: 'imap.gmail.com', imap_port: 993, imap_secure: true,
    smtp_host: 'smtp.gmail.com', smtp_port: 465, smtp_secure: true
  },
  outlook: {
    imap_host: 'outlook.office365.com', imap_port: 993, imap_secure: true,
    smtp_host: 'smtp.office365.com', smtp_port: 587, smtp_secure: false
  },
  yahoo: {
    imap_host: 'imap.mail.yahoo.com', imap_port: 993, imap_secure: true,
    smtp_host: 'smtp.mail.yahoo.com', smtp_port: 465, smtp_secure: true
  },
  custom: {
    imap_host: '', imap_port: 993, imap_secure: true,
    smtp_host: '', smtp_port: 587, smtp_secure: false
  }
};

export default function ConnectAccount({ teamSpaces, defaultTeamSpaceId, onClose, onCreated }) {
  const [preset, setPreset] = useState('gmail');
  const [form, setForm] = useState({
    email: '', display_name: '', pass: '', ...presets.gmail
  });
  const [tsId, setTsId] = useState(defaultTeamSpaceId || (teamSpaces && teamSpaces[0] ? teamSpaces[0].id : ''));
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function connectMicrosoft() {
    setErr(''); setBusy(true);
    try {
      const params = new URLSearchParams();
      if (tsId) params.set('team_space_id', tsId);
      const r = await api('/api/oauth/microsoft/start?' + params.toString());
      if (r && r.url) {
        window.location.href = r.url;   // full-page redirect to Microsoft
      } else {
        setErr('OAuth start did not return a URL');
      }
    } catch (e) { setErr(e.message); setBusy(false); }
  }

  function applyPreset(p) {
    setPreset(p);
    setForm(f => ({ ...f, ...presets[p] }));
  }
  function set(k, v) { setForm(f => ({ ...f, [k]: v })); }

  async function submit(e) {
    e.preventDefault();
    setErr(''); setBusy(true);
    try {
      await api('/api/accounts', {
        method: 'POST',
        body: JSON.stringify({
          email: form.email, display_name: form.display_name,
          team_space_id: tsId || null,
          imap_host: form.imap_host, imap_port: Number(form.imap_port), imap_secure: !!form.imap_secure,
          imap_user: form.email, imap_pass: form.pass,
          smtp_host: form.smtp_host, smtp_port: Number(form.smtp_port), smtp_secure: !!form.smtp_secure,
          smtp_user: form.email, smtp_pass: form.pass
        })
      });
      onCreated && onCreated();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="modal-back" onClick={onClose}>
      <form className="modal" onClick={e => e.stopPropagation()} onSubmit={submit}>
        <h3>Connect email account</h3>

        {teamSpaces && teamSpaces.length > 0 && (
          <select value={tsId} onChange={e => setTsId(e.target.value)}>
            {teamSpaces.map(ts => <option key={ts.id} value={ts.id}>Add to: {ts.name}</option>)}
          </select>
        )}

        <button type="button" className="ms-btn" onClick={connectMicrosoft} disabled={busy}>
          <svg width="18" height="18" viewBox="0 0 23 23" style={{ marginRight: 8, verticalAlign: 'middle' }}>
            <rect x="1" y="1" width="10" height="10" fill="#f25022"/>
            <rect x="12" y="1" width="10" height="10" fill="#7fba00"/>
            <rect x="1" y="12" width="10" height="10" fill="#00a4ef"/>
            <rect x="12" y="12" width="10" height="10" fill="#ffb900"/>
          </svg>
          Sign in with Microsoft (recommended for Outlook)
        </button>

        <div className="divider"><span>or use IMAP / SMTP</span></div>

        <div className="muted small">
          For Gmail: enable 2FA and use an <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">App Password</a>.
          Outlook with M365 will likely fail here — use the Microsoft button above.
        </div>
        <div className="row">
          {Object.keys(presets).map(p => (
            <button type="button" key={p} className={'chip ' + (preset === p ? 'active' : '')} onClick={() => applyPreset(p)}>{p}</button>
          ))}
        </div>
        <input placeholder="Email address" type="email" value={form.email} onChange={e => set('email', e.target.value)} required />
        <input placeholder="Display name (optional)" value={form.display_name} onChange={e => set('display_name', e.target.value)} />
        <input placeholder="Password / App password" type="password" value={form.pass} onChange={e => set('pass', e.target.value)} required />

        <div className="row">
          <input placeholder="IMAP host" value={form.imap_host} onChange={e => set('imap_host', e.target.value)} required />
          <input placeholder="IMAP port" type="number" value={form.imap_port} onChange={e => set('imap_port', e.target.value)} required />
          <label className="check"><input type="checkbox" checked={form.imap_secure} onChange={e => set('imap_secure', e.target.checked)} /> SSL</label>
        </div>
        <div className="row">
          <input placeholder="SMTP host" value={form.smtp_host} onChange={e => set('smtp_host', e.target.value)} required />
          <input placeholder="SMTP port" type="number" value={form.smtp_port} onChange={e => set('smtp_port', e.target.value)} required />
          <label className="check"><input type="checkbox" checked={form.smtp_secure} onChange={e => set('smtp_secure', e.target.checked)} /> SSL</label>
        </div>

        {err && <div className="err">{err}</div>}
        <div className="row right">
          <button type="button" className="ghost" onClick={onClose}>Cancel</button>
          <button disabled={busy}>{busy ? 'Connecting…' : 'Connect'}</button>
        </div>
      </form>
    </div>
  );
}
