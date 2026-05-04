import React, { useEffect, useState } from 'react';
import { api } from '../api';

export default function CannedModal({ onClose }) {
  const [items, setItems] = useState([]);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);

  async function load() {
    const r = await api('/api/canned');
    setItems(r.canned || []);
  }
  useEffect(() => { load(); }, []);

  async function add(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const html = body.replace(/\n/g, '<br/>');
      await api('/api/canned', {
        method: 'POST',
        body: JSON.stringify({ title, body_text: body, body_html: html })
      });
      setTitle(''); setBody('');
      load();
    } finally { setBusy(false); }
  }

  async function remove(id) {
    if (!confirm('Delete this canned response?')) return;
    await api(`/api/canned/${id}`, { method: 'DELETE' });
    load();
  }

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h3>Canned responses</h3>
        <div className="muted small">Save reusable replies. Insert them from the composer.</div>
        <form onSubmit={add} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <input placeholder="Title (e.g. 'Out of office')" value={title} onChange={e => setTitle(e.target.value)} required />
          <textarea rows={4} placeholder="Body text" value={body} onChange={e => setBody(e.target.value)} required />
          <button disabled={busy}>{busy ? '…' : 'Add'}</button>
        </form>

        <div className="side-section-title" style={{ color: '#59636e' }}>Existing</div>
        {items.length === 0 && <div className="muted small">No canned responses yet</div>}
        {items.map(c => (
          <div key={c.id} className="invite-row">
            <div>
              <strong>{c.title}</strong>
              <div className="muted small" style={{ whiteSpace: 'pre-wrap' }}>{c.body_text.slice(0, 120)}{c.body_text.length > 120 ? '…' : ''}</div>
            </div>
            <button className="ghost small" onClick={() => remove(c.id)}>Delete</button>
          </div>
        ))}

        <div className="row right">
          <button className="ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
