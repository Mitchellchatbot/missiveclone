import React, { useEffect, useState, useCallback, useMemo } from 'react';
import DOMPurify from 'dompurify';
import { api, getApiBase } from '../api';
import { getSocket } from '../socket';
import ComposeReply from './ComposeReply.jsx';
import Comments from './Comments.jsx';
import Avatar from './Avatar.jsx';

function fmtFull(ts) { return new Date(Number(ts)).toLocaleString(); }

function sanitize(html) {
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'link', 'meta', 'form', 'input'],
    FORBID_ATTR: ['style', 'onerror', 'onclick', 'onload', 'onmouseover'],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|cid):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i
  });
}

function fmtSize(b) {
  if (!b) return '';
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return Math.round(b / 1024) + ' KB';
  return (b / (1024 * 1024)).toFixed(1) + ' MB';
}

function nameFromAddr(s) {
  if (!s) return '';
  const a = s.indexOf('<');
  return (a > 0 ? s.slice(0, a) : s).trim().replace(/"/g, '');
}

const SNOOZE_PRESETS = [
  { label: 'In 1 hour', ms: 60 * 60 * 1000 },
  { label: 'In 4 hours', ms: 4 * 60 * 60 * 1000 },
  { label: 'Tomorrow 9 AM', fn: () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d.getTime() - Date.now(); } },
  { label: 'Next Monday 9 AM', fn: () => { const d = new Date(); const days = (8 - d.getDay()) % 7 || 7; d.setDate(d.getDate() + days); d.setHours(9, 0, 0, 0); return d.getTime() - Date.now(); } }
];

export default function ThreadView({ threadId, me, team, accounts, onChanged }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [showReply, setShowReply] = useState(false);
  const [showSnooze, setShowSnooze] = useState(false);
  const [showLabel, setShowLabel] = useState(false);
  const [allLabels, setAllLabels] = useState([]);

  const load = useCallback(async () => {
    if (!threadId) { setData(null); return; }
    setLoading(true);
    try {
      const r = await api(`/api/threads/${threadId}`);
      setData(r);
    } finally { setLoading(false); }
  }, [threadId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    api('/api/labels').then(r => setAllLabels(r.labels || [])).catch(() => {});
  }, []);

  useEffect(() => {
    if (!threadId) return;
    const s = getSocket();
    const onAny = (p) => { if (p && p.thread_id === threadId) load(); };
    s.on('message:new', onAny);
    s.on('comment:new', onAny);
    s.on('thread:updated', onAny);
    return () => {
      s.off('message:new', onAny);
      s.off('comment:new', onAny);
      s.off('thread:updated', onAny);
    };
  }, [threadId, load]);

  async function setStatus(status) {
    await api(`/api/threads/${threadId}`, { method: 'PATCH', body: JSON.stringify({ status }) });
    onChanged && onChanged(); load();
  }
  async function setAssignee(id) {
    await api(`/api/threads/${threadId}`, { method: 'PATCH', body: JSON.stringify({ assignee_id: id || null }) });
    onChanged && onChanged(); load();
  }
  async function snooze(ms) {
    await api(`/api/threads/${threadId}`, { method: 'PATCH', body: JSON.stringify({ snoozed_until: Date.now() + ms }) });
    setShowSnooze(false);
    onChanged && onChanged(); load();
  }
  async function unsnooze() {
    await api(`/api/threads/${threadId}`, { method: 'PATCH', body: JSON.stringify({ snoozed_until: null }) });
    onChanged && onChanged(); load();
  }
  async function toggleLabel(label, currently) {
    if (currently) {
      await api('/api/labels/remove', { method: 'POST', body: JSON.stringify({ thread_id: threadId, label_id: label.id }) });
    } else {
      await api('/api/labels/apply', { method: 'POST', body: JSON.stringify({ thread_id: threadId, label_id: label.id }) });
    }
    onChanged && onChanged(); load();
  }

  if (!threadId) return (
    <div className="thread-view empty">
      <div className="empty-illust">📬</div>
      <div>Select a conversation</div>
    </div>
  );
  if (loading || !data) return <div className="thread-view"><div className="loading">Loading…</div></div>;

  const { thread, messages, comments } = data;
  const isSnoozed = thread.snoozed_until && Number(thread.snoozed_until) > Date.now();
  const labelIds = new Set((thread.labels || []).map(l => l.id));

  return (
    <div className="thread-view">
      <div className="tv-header">
        <div className="tv-header-main">
          <div className="tv-subject">{thread.subject || '(no subject)'}</div>
          <div className="muted small ellipsis">{thread.participants}</div>
          {(thread.account_emails && thread.account_emails.length > 0) && (
            <div className="tv-mailboxes">
              {thread.account_emails.map(a => {
                const email = typeof a === 'string' ? a : a.email;
                const name = typeof a === 'string' ? null : a.name;
                return (
                  <span key={email} className="account-chip" title={email}>
                    📧 {name ? `${name} (${email})` : email}
                  </span>
                );
              })}
            </div>
          )}
          {(thread.labels && thread.labels.length > 0) && (
            <div className="tv-labels">
              {thread.labels.map(l => (
                <span key={l.id} className="label-chip" style={{ background: l.color }}>{l.name}</span>
              ))}
            </div>
          )}
          {isSnoozed && (
            <div className="muted small">💤 Snoozed until {new Date(Number(thread.snoozed_until)).toLocaleString()} <button className="link" onClick={unsnooze}>unsnooze</button></div>
          )}
        </div>
        <div className="tv-controls">
          <select value={thread.status} onChange={e => setStatus(e.target.value)} className={'status-select status-' + thread.status}>
            <option value="open">Open</option>
            <option value="pending">Pending</option>
            <option value="closed">Closed</option>
          </select>
          <select value={thread.assignee_id || ''} onChange={e => setAssignee(e.target.value)}>
            <option value="">Unassigned</option>
            {team.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          <div style={{ position: 'relative' }}>
            <button className="ghost" onClick={() => setShowLabel(s => !s)}>🏷 Label</button>
            {showLabel && (
              <div className="schedule-pop" onMouseLeave={() => setShowLabel(false)}>
                {allLabels.length === 0 && <div className="muted small pad-h">No labels yet — create some via "Labels" in the sidebar.</div>}
                {allLabels.map(l => (
                  <div key={l.id} className="schedule-opt" onClick={() => toggleLabel(l, labelIds.has(l.id))}>
                    <input type="checkbox" checked={labelIds.has(l.id)} readOnly />
                    <span className="label-chip" style={{ background: l.color }}>{l.name}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div style={{ position: 'relative' }}>
            <button className="ghost" onClick={() => setShowSnooze(s => !s)}>💤 Snooze</button>
            {showSnooze && (
              <div className="schedule-pop" onMouseLeave={() => setShowSnooze(false)}>
                {SNOOZE_PRESETS.map(p => (
                  <div key={p.label} className="schedule-opt" onClick={() => snooze(p.fn ? p.fn() : p.ms)}>
                    {p.label}
                  </div>
                ))}
              </div>
            )}
          </div>
          <button onClick={() => setShowReply(s => !s)}>↩ Reply</button>
        </div>
      </div>

      <div className="tv-messages">
        {messages.map(m => <MessageBlock key={m.id} m={m} />)}
      </div>

      {showReply && (
        <ComposeReply
          threadId={threadId}
          accounts={accounts}
          onSent={() => { setShowReply(false); load(); onChanged && onChanged(); }}
          onCancel={() => setShowReply(false)}
        />
      )}

      <Comments
        threadId={threadId}
        comments={comments}
        team={team}
        me={me}
        onAdded={load}
      />
    </div>
  );
}

function MessageBlock({ m }) {
  const safeHtml = useMemo(() => m.body_html ? sanitize(m.body_html) : null, [m.body_html]);
  const senderName = m.direction === 'outbound' ? (m.from_addr ? nameFromAddr(m.from_addr) : 'You') : nameFromAddr(m.from_addr) || 'Unknown';
  return (
    <div className={'msg msg-' + m.direction}>
      <div className="msg-head">
        <Avatar name={senderName} size={36} />
        <div className="msg-head-main">
          <div><strong>{senderName}</strong> <span className="muted small">to {m.to_addrs}</span></div>
          <div className="muted xs">
            {fmtFull(m.sent_at)}
            {m.account_email && (
              <span className="account-chip" style={{ marginLeft: 6 }} title={m.account_email}>
                via {m.account_name ? `${m.account_name} (${m.account_email})` : m.account_email}
              </span>
            )}
          </div>
        </div>
      </div>
      {safeHtml
        ? <div className="msg-body" dangerouslySetInnerHTML={{ __html: safeHtml }} />
        : <pre className="msg-body">{m.body_text}</pre>}
      {m.attachments && m.attachments.length > 0 && (
        <div className="att-list">
          {m.attachments.map(a => (
            <a key={a.id}
              href={getApiBase() + `/api/attachments/${a.id}`}
              onClick={e => downloadAttachment(e, a)}
              className="att">
              📎 <span>{a.filename}</span> <span className="muted xs">{fmtSize(a.size_bytes)}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

async function downloadAttachment(e, a) {
  e.preventDefault();
  try {
    const { getToken } = await import('../api');
    const token = getToken();
    const res = await fetch(getApiBase() + `/api/attachments/${a.id}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    });
    if (!res.ok) throw new Error('download failed');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = a.filename || 'attachment';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (err) {
    alert(err.message);
  }
}
