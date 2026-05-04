import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../api';

function fmt(ts) { return new Date(Number(ts)).toLocaleString(); }

export default function ScheduledView() {
  const [items, setItems] = useState([]);

  const load = useCallback(async () => {
    const r = await api('/api/scheduled');
    setItems(r.scheduled || []);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function cancel(id) {
    if (!confirm('Cancel this scheduled email?')) return;
    await api(`/api/scheduled/${id}`, { method: 'DELETE' });
    load();
  }

  return (
    <div className="drafts-pane">
      <div className="tv-header">
        <div className="tv-header-main">
          <div className="tv-subject">Scheduled</div>
          <div className="muted small">Emails queued to send later. Cancel any pending one before its send time.</div>
        </div>
      </div>
      <div className="drafts-list">
        {items.length === 0 && <div className="empty"><div className="empty-illust">⏰</div><div>No scheduled emails</div></div>}
        {items.map(s => (
          <div key={s.id} className="draft-row">
            <div className="draft-main">
              <div className="draft-subject ellipsis">{s.subject}</div>
              <div className="muted small ellipsis">From {s.from_email} → {s.to_addrs}</div>
              <div className="muted xs">
                {s.status === 'pending' && <>⏰ Send at <strong>{fmt(s.send_at)}</strong></>}
                {s.status === 'sent' && <>✓ Sent</>}
                {s.status === 'failed' && <span className="err-inline">✗ Failed: {s.error}</span>}
              </div>
            </div>
            {s.status === 'pending' && (
              <button className="ghost small" onClick={() => cancel(s.id)}>Cancel</button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
