import React, { useEffect, useState } from 'react';
import { api } from '../api';

export default function SignaturesModal({ accounts, onClose }) {
  const [accountId, setAccountId] = useState(accounts[0]?.id || '');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState(null);

  async function load(id) {
    if (!id) return;
    const r = await api(`/api/accounts/${id}/signature`);
    setText(r.signature_text || '');
  }
  useEffect(() => { load(accountId); }, [accountId]);

  async function save() {
    setBusy(true);
    try {
      const html = text.replace(/\n/g, '<br/>');
      await api(`/api/accounts/${accountId}/signature`, {
        method: 'PUT',
        body: JSON.stringify({ signature_text: text, signature_html: html })
      });
      setSavedAt(Date.now());
    } finally { setBusy(false); }
  }

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h3>Email signatures</h3>
        <div className="muted small">Appended to outgoing mail from the selected account.</div>

        <select value={accountId} onChange={e => setAccountId(e.target.value)}>
          {accounts.length === 0 && <option value="">— no accounts —</option>}
          {accounts.map(a => <option key={a.id} value={a.id}>{a.email}</option>)}
        </select>

        <textarea
          rows={8}
          placeholder="Aly Scaled&#10;Founder, Scaled AI&#10;aly@scaledai.org"
          value={text}
          onChange={e => setText(e.target.value)}
        />

        <div className="row right">
          {savedAt && <span className="muted small" style={{ flex: 1, textAlign: 'left' }}>Saved {new Date(savedAt).toLocaleTimeString()}</span>}
          <button className="ghost" onClick={onClose}>Close</button>
          <button onClick={save} disabled={busy || !accountId}>{busy ? '…' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}
