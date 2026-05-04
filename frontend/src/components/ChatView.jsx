import React, { useEffect, useRef, useState, useCallback } from 'react';
import { api } from '../api';
import { getSocket } from '../socket';
import Avatar from './Avatar.jsx';

function fmtTime(ts) {
  const d = new Date(Number(ts));
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function fmtDate(ts) {
  const d = new Date(Number(ts));
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return 'Today';
  const y = new Date(today.getTime() - 86400000);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString();
}

export default function ChatView({ me, team }) {
  const [messages, setMessages] = useState([]);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const listRef = useRef(null);

  const load = useCallback(async () => {
    const r = await api('/api/chat');
    setMessages(r.messages || []);
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const s = getSocket();
    const onNew = (msg) => setMessages(prev => [...prev, msg]);
    s.on('chat:new', onNew);
    return () => s.off('chat:new', onNew);
  }, []);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages]);

  async function send(e) {
    e.preventDefault();
    if (!body.trim() || busy) return;
    setBusy(true);
    try {
      // Parse @mentions to ids.
      const re = /@([a-zA-Z0-9_.-]+)/g;
      const mentions = [];
      let m; while ((m = re.exec(body)) !== null) {
        const handle = m[1].toLowerCase();
        const u = team.find(t =>
          t.name.toLowerCase().replace(/\s+/g, '') === handle ||
          t.email.split('@')[0].toLowerCase() === handle
        );
        if (u) mentions.push(u.id);
      }
      await api('/api/chat', { method: 'POST', body: JSON.stringify({ body, mentions }) });
      setBody('');
    } finally { setBusy(false); }
  }

  // Group messages by day for date dividers.
  const grouped = [];
  let lastDay = '';
  for (const m of messages) {
    const day = fmtDate(m.created_at);
    if (day !== lastDay) {
      grouped.push({ divider: true, day });
      lastDay = day;
    }
    grouped.push(m);
  }

  return (
    <div className="chat-pane">
      <div className="chat-header">
        <div>
          <div className="chat-title">Team chat</div>
          <div className="muted small">Workspace-wide conversation. @mention teammates.</div>
        </div>
      </div>
      <div className="chat-messages" ref={listRef}>
        {grouped.length === 0 && <div className="empty">No messages yet — say hi 👋</div>}
        {grouped.map((g, i) => g.divider
          ? <div key={'d' + i} className="chat-divider"><span>{g.day}</span></div>
          : (
            <div key={g.id} className={'chat-msg ' + (g.user_id === me.id ? 'mine' : '')}>
              <Avatar name={g.user_name || g.user_email} size={32} />
              <div className="chat-body">
                <div className="chat-meta">
                  <strong>{g.user_name}</strong>
                  <span className="muted small">{fmtTime(g.created_at)}</span>
                </div>
                <div className="chat-text">{g.body}</div>
              </div>
            </div>
          ))}
      </div>
      <form className="chat-compose" onSubmit={send}>
        <textarea
          rows={2}
          placeholder="Message your team…  (Enter to send, Shift+Enter for newline)"
          value={body}
          onChange={e => setBody(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(e); }
          }}
        />
        <button disabled={busy || !body.trim()}>Send</button>
      </form>
    </div>
  );
}
