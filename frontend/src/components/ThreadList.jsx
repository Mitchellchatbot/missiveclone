import React from 'react';
import Avatar from './Avatar.jsx';

function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(Number(ts));
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  if (now - d < 7 * 86400000) return d.toLocaleDateString(undefined, { weekday: 'short' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function firstParticipant(s) {
  if (!s) return '';
  const first = s.split(';')[0].trim();
  // Strip <addr> if "Name <addr>" form
  const angle = first.indexOf('<');
  return angle > 0 ? first.slice(0, angle).trim().replace(/"/g, '') : first;
}

const statusBadge = (s) => <span className={`badge badge-${s}`}>{s}</span>;

export default function ThreadList({ threads, selectedId, onSelect }) {
  return (
    <div className="thread-list">
      {threads.length === 0 && <div className="empty">No conversations</div>}
      {threads.map(t => {
        const fp = firstParticipant(t.participants);
        return (
          <div
            key={t.id}
            className={'thread-row ' + (selectedId === t.id ? 'selected' : '')}
            onClick={() => onSelect(t.id)}
          >
            <Avatar name={fp || t.subject || '?'} size={36} />
            <div className="thread-row-main">
              <div className="thread-row-top">
                <div className="thread-from ellipsis">{fp || '—'}</div>
                <div className="thread-date">{fmtDate(t.last_message_at)}</div>
              </div>
              <div className="thread-subject ellipsis">{t.subject || '(no subject)'}</div>
              <div className="thread-row-bottom">
                <div className="thread-tags">
                  {statusBadge(t.status)}
                  {t.assignee_name && <span className="badge badge-assignee">@{t.assignee_name}</span>}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
