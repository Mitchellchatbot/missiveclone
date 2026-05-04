import React, { useState, useMemo } from 'react';
import { api } from '../api';
import Avatar from './Avatar.jsx';

function parseMentions(body, team) {
  const mentions = [];
  const re = /@([a-zA-Z0-9_.-]+)/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const handle = m[1].toLowerCase();
    const u = team.find(t =>
      t.name.toLowerCase().replace(/\s+/g, '') === handle ||
      t.email.split('@')[0].toLowerCase() === handle
    );
    if (u) mentions.push(u.id);
  }
  return mentions;
}

function fmtTime(ts) {
  return new Date(Number(ts)).toLocaleString([], {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
  });
}

export default function Comments({ threadId, comments, team, me, onAdded }) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);

  async function add(e) {
    e && e.preventDefault();
    if (!body.trim()) return;
    setBusy(true);
    try {
      const mentions = parseMentions(body, team);
      await api(`/api/threads/${threadId}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body, mentions })
      });
      setBody('');
      onAdded && onAdded();
    } finally { setBusy(false); }
  }

  const teamHints = useMemo(() => team.map(t => '@' + t.name.replace(/\s+/g, '')).join(', '), [team]);

  return (
    <div className="comments">
      <div className="comments-title">
        <span>💬 Internal notes</span>
        <span className="muted small"> — only visible to your team</span>
      </div>
      <div className="comments-list">
        {comments.length === 0 && <div className="muted small">No notes yet</div>}
        {comments.map(c => (
          <div className="comment" key={c.id}>
            <Avatar name={c.user_name} size={28} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="comment-meta">
                <strong>{c.user_name}</strong>
                <span className="muted small"> · {fmtTime(c.created_at)}</span>
              </div>
              <div className="comment-body">{c.body}</div>
            </div>
          </div>
        ))}
      </div>
      <form className="comment-compose" onSubmit={add}>
        <textarea
          placeholder={`Add a note  (mention with @, e.g. ${teamHints || '@teammate'})`}
          rows={2}
          value={body}
          onChange={e => setBody(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) add(e);
          }}
        />
        <button onClick={add} disabled={busy || !body.trim()}>{busy ? '…' : 'Post'}</button>
      </form>
    </div>
  );
}
