import React, { useEffect, useState } from 'react';
import { api } from '../api';

export default function AccountModal({ accountId, accounts, teamSpaces, onClose, onChanged }) {
  const acc = accounts.find(a => a.id === accountId);
  const [displayName, setDisplayName] = useState('');
  const [tsId, setTsId] = useState('');
  const [moveThreads, setMoveThreads] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (acc) {
      setDisplayName(acc.display_name || '');
      setTsId(acc.team_space_id || '');
    }
  }, [acc]);

  if (!acc) return null;

  async function save() {
    setBusy(true); setErr('');
    try {
      await api(`/api/accounts/${acc.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          display_name: displayName,
          team_space_id: tsId || null,
          move_threads: moveThreads
        })
      });
      onChanged && onChanged();
      onClose();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  async function disconnect() {
    if (!confirm(`Disconnect ${acc.email}? Existing emails stay in the database, but no new ones will sync.`)) return;
    try {
      await api(`/api/accounts/${acc.id}`, { method: 'DELETE' });
      onChanged && onChanged();
      onClose();
    } catch (e) { alert(e.message); }
  }

  async function syncNow() {
    try {
      await api(`/api/accounts/${acc.id}/sync`, { method: 'POST' });
      alert('Sync complete');
      onChanged && onChanged();
    } catch (e) { alert(e.message); }
  }

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h3>{acc.email}</h3>
        <div className="muted small">
          IMAP: {acc.imap_host || 'oauth'} · Last synced: {acc.last_synced_at ? new Date(Number(acc.last_synced_at)).toLocaleString() : 'never'}
        </div>

        <div className="muted small">Display name</div>
        <input
          value={displayName}
          onChange={e => setDisplayName(e.target.value)}
          placeholder="e.g. Aly Scaled"
        />

        <div className="muted small">Team space</div>
        <select value={tsId} onChange={e => setTsId(e.target.value)}>
          <option value="">— none —</option>
          {teamSpaces.map(ts => <option key={ts.id} value={ts.id}>{ts.name}</option>)}
        </select>
        <label className="check small">
          <input type="checkbox" checked={moveThreads} onChange={e => setMoveThreads(e.target.checked)} />
          Also move existing threads to the new team space
        </label>

        {err && <div className="err">{err}</div>}

        <div className="row right">
          <button className="ghost" onClick={syncNow}>Sync now</button>
          <button className="ghost" onClick={disconnect} style={{ color: '#c01048', borderColor: '#fda4af' }}>Disconnect</button>
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button onClick={save} disabled={busy}>{busy ? '…' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}
