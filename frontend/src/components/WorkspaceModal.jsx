import React, { useEffect, useState } from 'react';
import { api } from '../api';
import Avatar from './Avatar.jsx';

export default function WorkspaceModal({ me, onClose, onChanged }) {
  const [workspace, setWorkspace] = useState(null);
  const [members, setMembers] = useState([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function load() {
    const r = await api('/api/auth/me');
    setWorkspace(r.workspace);
    setName(r.workspace.name);
    const t = await api('/api/auth/team');
    setMembers(t.members || []);
  }

  useEffect(() => { load(); }, []);

  async function save() {
    if (!name.trim()) return;
    setBusy(true); setErr('');
    try {
      await api('/api/auth/workspace', { method: 'PATCH', body: JSON.stringify({ name }) });
      await load();
      onChanged && onChanged();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  async function removeMember(userId, name) {
    if (!confirm(`Remove ${name} from this workspace? They will lose access immediately.`)) return;
    try {
      await api(`/api/auth/team/${userId}`, { method: 'DELETE' });
      load();
    } catch (e) { alert(e.message); }
  }

  if (!workspace) return null;

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h3>Workspace settings</h3>

        <div className="muted small">Workspace name</div>
        <div className="row">
          <input value={name} onChange={e => setName(e.target.value)} />
          <button onClick={save} disabled={busy || name === workspace.name} style={{ flex: '0 0 auto' }}>
            {busy ? '…' : 'Save'}
          </button>
        </div>
        {err && <div className="err">{err}</div>}

        <div className="side-section-title" style={{ color: '#59636e' }}>Members ({members.length})</div>
        {members.map(m => (
          <div key={m.id} className="invite-row">
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', minWidth: 0 }}>
              <Avatar name={m.name} size={32} />
              <div style={{ minWidth: 0 }}>
                <strong>{m.name}</strong>
                {m.id === me.id && <span className="muted small"> (you)</span>}
                <div className="muted small ellipsis">{m.email}</div>
              </div>
            </div>
            {m.id !== me.id && (
              <button className="ghost small" onClick={() => removeMember(m.id, m.name)}>Remove</button>
            )}
          </div>
        ))}

        <div className="row right">
          <button className="ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
