import React, { useEffect, useState } from 'react';
import { api } from '../api';

const COLOR_PALETTE = [
  '#2f6feb', '#0fa55a', '#d97706', '#dc2626', '#7c3aed',
  '#ec4899', '#0ea5e9', '#475569', '#a16207', '#059669'
];

export default function LabelsModal({ onClose }) {
  const [labels, setLabels] = useState([]);
  const [name, setName] = useState('');
  const [color, setColor] = useState(COLOR_PALETTE[0]);

  async function load() {
    const r = await api('/api/labels');
    setLabels(r.labels || []);
  }
  useEffect(() => { load(); }, []);

  async function add(e) {
    e.preventDefault();
    if (!name.trim()) return;
    await api('/api/labels', { method: 'POST', body: JSON.stringify({ name, color }) });
    setName('');
    load();
  }

  async function remove(id) {
    if (!confirm('Delete this label? It will be removed from all threads.')) return;
    await api(`/api/labels/${id}`, { method: 'DELETE' });
    load();
  }

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h3>Labels</h3>
        <div className="muted small">Tag conversations with custom labels. Visible workspace-wide.</div>

        <form onSubmit={add} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <input placeholder="Label name (e.g. VIP, Bug, Urgent)" value={name} onChange={e => setName(e.target.value)} required />
          <div className="color-picker">
            {COLOR_PALETTE.map(c => (
              <button
                key={c} type="button"
                className={'color-swatch ' + (color === c ? 'active' : '')}
                style={{ background: c }}
                onClick={() => setColor(c)}
              />
            ))}
          </div>
          <button>Create label</button>
        </form>

        <div className="side-section-title" style={{ color: '#59636e' }}>Existing</div>
        {labels.length === 0 && <div className="muted small">No labels yet</div>}
        {labels.map(l => (
          <div key={l.id} className="invite-row">
            <span className="label-chip" style={{ background: l.color }}>{l.name}</span>
            <button className="ghost small" onClick={() => remove(l.id)}>Delete</button>
          </div>
        ))}

        <div className="row right">
          <button className="ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
