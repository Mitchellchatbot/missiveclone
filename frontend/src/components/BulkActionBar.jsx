import React, { useState } from 'react';
import { api } from '../api';

export default function BulkActionBar({ selectedIds, onClear, onChanged, team, labels }) {
  const [busy, setBusy] = useState(false);
  const [showAssign, setShowAssign] = useState(false);
  const [showLabel, setShowLabel] = useState(false);

  async function bulk(action, value) {
    setBusy(true);
    try {
      await api('/api/threads/bulk', {
        method: 'POST',
        body: JSON.stringify({ action, thread_ids: Array.from(selectedIds), value })
      });
      onChanged && onChanged();
      onClear && onClear();
    } finally { setBusy(false); }
  }

  const n = selectedIds.size;

  return (
    <div className="bulk-bar">
      <div className="bulk-count"><strong>{n}</strong> selected</div>
      <button className="ghost small" onClick={() => bulk('close')} disabled={busy}>✕ Close</button>
      <button className="ghost small" onClick={() => bulk('open')} disabled={busy}>↺ Re-open</button>
      <button className="ghost small" onClick={() => bulk('pending')} disabled={busy}>⏰ Pending</button>
      <button className="ghost small" onClick={() => bulk('snooze', 60 * 60 * 1000)} disabled={busy}>💤 Snooze 1h</button>
      <button className="ghost small" onClick={() => bulk('star')} disabled={busy}>★ Star</button>
      <button className="ghost small" onClick={() => bulk('unstar')} disabled={busy}>☆ Unstar</button>

      <div className="action-pop-wrap">
        <button className="ghost small" onClick={() => setShowAssign(s => !s)} disabled={busy}>👤 Assign…</button>
        {showAssign && (
          <div className="schedule-pop" onMouseLeave={() => setShowAssign(false)}>
            <div className="schedule-opt" onClick={() => { bulk('assign', null); setShowAssign(false); }}>
              <span className="muted">Unassigned</span>
            </div>
            {team.map(m => (
              <div key={m.id} className="schedule-opt" onClick={() => { bulk('assign', m.id); setShowAssign(false); }}>
                {m.name}
              </div>
            ))}
          </div>
        )}
      </div>

      {labels && labels.length > 0 && (
        <div className="action-pop-wrap">
          <button className="ghost small" onClick={() => setShowLabel(s => !s)} disabled={busy}>🏷 Label…</button>
          {showLabel && (
            <div className="schedule-pop" onMouseLeave={() => setShowLabel(false)}>
              {labels.map(l => (
                <div key={l.id} className="schedule-opt" onClick={() => { bulk('label_add', l.id); setShowLabel(false); }}>
                  <span className="label-chip" style={{ background: l.color }}>{l.name}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="spacer" />
      <button className="ghost small" onClick={onClear} disabled={busy}>Cancel</button>
    </div>
  );
}
