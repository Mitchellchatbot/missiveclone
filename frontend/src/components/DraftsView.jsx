import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../api';

function snippet(html) {
  const div = document.createElement('div');
  div.innerHTML = html || '';
  const t = div.innerText.trim();
  return t.length > 140 ? t.slice(0, 140) + '…' : t;
}

function fmtTime(ts) {
  return new Date(Number(ts)).toLocaleString();
}

export default function DraftsView({ onOpenThread }) {
  const [drafts, setDrafts] = useState([]);

  const load = useCallback(async () => {
    const r = await api('/api/drafts');
    setDrafts(r.drafts || []);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function discard(threadId) {
    if (!confirm('Discard this draft?')) return;
    await api(`/api/drafts/${threadId}`, { method: 'DELETE' });
    load();
  }

  return (
    <div className="drafts-pane">
      <div className="tv-header">
        <div className="tv-header-main">
          <div className="tv-subject">Drafts</div>
          <div className="muted small">Replies you've started but haven't sent yet.</div>
        </div>
      </div>

      <div className="drafts-list">
        {drafts.length === 0 && <div className="empty"><div className="empty-illust">📝</div><div>No drafts</div></div>}
        {drafts.map(d => (
          <div key={d.thread_id} className="draft-row">
            <div className="draft-main" onClick={() => onOpenThread(d.thread_id)}>
              <div className="draft-subject ellipsis">
                Re: {d.thread_subject || '(no subject)'}
              </div>
              <div className="muted small ellipsis">{d.thread_participants}</div>
              <div className="draft-snippet">{snippet(d.body_html || d.body_text)}</div>
              <div className="muted xs">Saved {fmtTime(d.updated_at)}</div>
            </div>
            <button className="ghost small" onClick={() => discard(d.thread_id)}>Discard</button>
          </div>
        ))}
      </div>
    </div>
  );
}
