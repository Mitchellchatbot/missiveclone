import React from 'react';
import { Star, Mail, Moon, X, RotateCcw } from 'lucide-react';
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
  const angle = first.indexOf('<');
  return angle > 0 ? first.slice(0, angle).trim().replace(/"/g, '') : first;
}

const statusBadge = (s) => <span className={`badge badge-${s}`}>{s}</span>;

export default function ThreadList({
  threads, selectedId, onSelect,
  onCloseThread, onSnoozeThread, onToggleStar,
  selectedIds = new Set(), onToggleSelect,
  onLoadMore, hasMore = false, loadingMore = false
}) {
  function onScroll(e) {
    if (!hasMore || loadingMore || !onLoadMore) return;
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 200) onLoadMore();
  }

  function quick(action, t, e) {
    e.stopPropagation();
    if (action === 'close') onCloseThread && onCloseThread(t);
    if (action === 'snooze') onSnoozeThread && onSnoozeThread(t);
    if (action === 'star') onToggleStar && onToggleStar(t);
  }

  function toggleSel(t, e) {
    e.stopPropagation();
    onToggleSelect && onToggleSelect(t.id);
  }

  return (
    <div className="thread-list" onScroll={onScroll}>
      {threads.length === 0 && <div className="empty">No conversations</div>}
      {threads.map(t => {
        const fp = firstParticipant(t.participants);
        const isClosed = t.status === 'closed';
        const isStarred = !!t.starred;
        const isSelected = selectedIds.has(t.id);
        return (
          <div
            key={t.id}
            className={'thread-row ' + (selectedId === t.id ? 'selected' : '') + (isSelected ? ' multi-selected' : '')}
            onClick={() => onSelect(t.id)}
          >
            <div className="thread-row-left">
              {onToggleSelect && (
                <input
                  type="checkbox"
                  className="thread-select"
                  checked={isSelected}
                  onChange={() => {}}
                  onClick={(e) => toggleSel(t, e)}
                  title="Select"
                />
              )}
              {onToggleStar && (
                <button
                  className={'star-btn ' + (isStarred ? 'on' : '')}
                  onClick={(e) => quick('star', t, e)}
                  title={isStarred ? 'Unstar' : 'Star'}
                >
                  <Star size={15} fill={isStarred ? 'currentColor' : 'none'} strokeWidth={2} />
                </button>
              )}
              <Avatar name={fp || t.subject || '?'} size={36} />
            </div>
            <div className="thread-row-main">
              <div className="thread-row-top">
                <div className="thread-from ellipsis">{fp || '—'}</div>
                <div className="thread-row-actions">
                  {!isClosed && onSnoozeThread && (
                    <button
                      className="thread-action-btn snooze-btn"
                      title="Snooze 1 hour"
                      onClick={(e) => quick('snooze', t, e)}
                    ><Moon size={14} /></button>
                  )}
                  {onCloseThread && (
                    <button
                      className={'thread-action-btn ' + (isClosed ? 'reopen-btn' : 'close-btn')}
                      title={isClosed ? 'Re-open' : 'Close'}
                      onClick={(e) => quick('close', t, e)}
                    >{isClosed ? <RotateCcw size={14} /> : <X size={14} />}</button>
                  )}
                  <div className="thread-date">{fmtDate(t.last_message_at)}</div>
                </div>
              </div>
              <div className="thread-subject ellipsis">{t.subject || '(no subject)'}</div>
              <div className="thread-row-bottom">
                <div className="thread-tags">
                  {(t.account_emails || []).map(a => {
                    const email = typeof a === 'string' ? a : a.email;
                    const name = typeof a === 'string' ? null : a.name;
                    return (
                      <span key={email} className="account-chip" title={email}>
                        <Mail size={11} strokeWidth={2.2} />
                        {name ? `${name}` : email}
                      </span>
                    );
                  })}
                  {statusBadge(t.status)}
                  {t.assignee_name && <span className="badge badge-assignee">@{t.assignee_name}</span>}
                  {(t.labels || []).map(l => (
                    <span key={l.id} className="label-chip" style={{ background: l.color }}>{l.name}</span>
                  ))}
                  {t.snoozed_until && Number(t.snoozed_until) > Date.now() && (
                    <span className="badge badge-snoozed"><Moon size={10} /> snoozed</span>
                  )}
                </div>
              </div>
            </div>
          </div>
        );
      })}
      {loadingMore && <div className="thread-list-foot">Loading…</div>}
    </div>
  );
}
