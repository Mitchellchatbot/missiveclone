import React, { useEffect, useState } from 'react';
import { api } from '../api';
import Avatar from './Avatar.jsx';

export default function TeamSpaceModal({ onClose }) {
  const [spaces, setSpaces] = useState([]);
  const [team, setTeam] = useState([]);
  const [name, setName] = useState('');
  const [members, setMembers] = useState([]);
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState('');
  const [busy, setBusy] = useState(false);

  async function loadAll() {
    const [s, t] = await Promise.all([api('/api/team_spaces'), api('/api/auth/team')]);
    setSpaces(s.team_spaces || []);
    setTeam(t.members || []);
  }

  useEffect(() => { loadAll(); }, []);

  function toggle(uid) {
    setMembers(m => m.includes(uid) ? m.filter(x => x !== uid) : [...m, uid]);
  }

  async function create(e) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      await api('/api/team_spaces', {
        method: 'POST',
        body: JSON.stringify({ name, member_ids: members })
      });
      setName(''); setMembers([]);
      loadAll();
    } finally { setBusy(false); }
  }

  async function rename(id) {
    if (!editName.trim()) return;
    await api(`/api/team_spaces/${id}`, { method: 'PATCH', body: JSON.stringify({ name: editName }) });
    setEditingId(null); setEditName('');
    loadAll();
  }

  async function remove(id) {
    if (!confirm('Delete this team space? Connected mailboxes and threads stay but are no longer scoped to it.')) return;
    try {
      await api(`/api/team_spaces/${id}`, { method: 'DELETE' });
      loadAll();
    } catch (e) { alert(e.message); }
  }

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h3>Team spaces</h3>
        <div className="muted small">
          Group mailboxes by team. Each space has its own inbox view.
        </div>

        <div className="side-section-title" style={{ color: '#59636e', marginTop: 4 }}>Existing</div>
        {spaces.map(s => (
          <div key={s.id} className="invite-row">
            {editingId === s.id ? (
              <input value={editName} onChange={e => setEditName(e.target.value)} autoFocus
                     onKeyDown={e => e.key === 'Enter' && rename(s.id)} />
            ) : (
              <div>
                <strong>{s.name}</strong>
                <div className="muted small">{s.member_count} member{s.member_count === 1 ? '' : 's'} · {s.account_count} mailbox{s.account_count === 1 ? '' : 'es'}</div>
              </div>
            )}
            <div className="row" style={{ flex: '0 0 auto', gap: 4 }}>
              {editingId === s.id ? (
                <>
                  <button className="ghost small" onClick={() => rename(s.id)}>Save</button>
                  <button className="ghost small" onClick={() => setEditingId(null)}>Cancel</button>
                </>
              ) : (
                <>
                  <button className="ghost small" onClick={() => { setEditingId(s.id); setEditName(s.name); }}>Rename</button>
                  <button className="ghost small" onClick={() => remove(s.id)}>Delete</button>
                </>
              )}
            </div>
          </div>
        ))}

        <div className="side-section-title" style={{ color: '#59636e', marginTop: 12 }}>Create new</div>
        <form onSubmit={create} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <input placeholder="Space name (e.g. Sales, Support, Tech)" value={name} onChange={e => setName(e.target.value)} required />
          <div className="muted small">Members (you're added automatically):</div>
          <div className="member-grid">
            {team.filter(m => m.id !== undefined).map(m => (
              <label key={m.id} className={'member-chip ' + (members.includes(m.id) ? 'active' : '')}>
                <input
                  type="checkbox" style={{ display: 'none' }}
                  checked={members.includes(m.id)}
                  onChange={() => toggle(m.id)}
                />
                <Avatar name={m.name} size={20} />
                <span>{m.name}</span>
              </label>
            ))}
          </div>
          <button disabled={busy || !name.trim()}>{busy ? '…' : 'Create space'}</button>
        </form>

        <div className="row right">
          <button className="ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
