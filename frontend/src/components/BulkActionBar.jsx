import React, { useState } from 'react';
import { X, RotateCcw, Clock, Moon, Star, StarOff, UserPlus, Tag } from 'lucide-react';
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
      <button className="ghost small icon-text" onClick={() => bulk('close')} disabled={busy}>
        <X size={13} /> Close
      </button>
      <button className="ghost small icon-text" onClick={() => bulk('open')} disabled={busy}>
        <RotateCcw size={13} /> Re-open
      </button>
      <button className="ghost small icon-text" onClick={() => bulk('pending')} disabled={busy}>
        <Clock size={13} /> Pending
      </button>
      <button className="ghost small icon-text" onClick={() => bulk('snooze', 60 * 60 * 1000)} disabled={busy}>
        <Moon size={13} /> Snooze 1h
      </button>
      <button className="ghost small icon-text" onClick={() => bulk('star')} disabled={busy} style={{ color: '#f59e0b' }}>
        <Star size={13} fill="currentColor" /> Star
      </button>
      <button className="ghost small icon-text" onClick={() => bulk('unstar')} disabled={busy}>
        <StarOff size={13} /> Unstar
      </button>

      <div className="action-pop-wrap">
        <button className="ghost small icon-text" onClick={() => setShowAssign(s => !s)} disabled={busy}>
          <UserPlus size={13} /> Assign…
        </button>
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
          <button className="ghost small icon-text" onClick={() => setShowLabel(s => !s)} disabled={busy}>
            <Tag size={13} /> Label…
          </button>
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
