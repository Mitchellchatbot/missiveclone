import React, { useEffect, useState } from 'react';
import Avatar from './Avatar.jsx';
import { getSocket } from '../socket';

export default function TopBar({
  me, view, setView, currentTeamSpace, onCompose,
  accounts, currentTeamSpaceId, filter, setFilter
}) {
  const [online, setOnline] = useState([]);

  useEffect(() => {
    const s = getSocket();
    const onPresence = (p) => setOnline(p.online || []);
    s.on('presence:update', onPresence);
    s.emit('presence:hello', { name: me.name });
    return () => s.off('presence:update', onPresence);
  }, [me.name]);

  // Mailboxes in scope:
  // - My Inbox (filter.mine === true): only the current user's own mailboxes.
  // - Team space: only mailboxes attached to that team space.
  // - All conversations (no team space): every mailbox in the workspace.
  const accountsInScope = (accounts || []).filter(a => {
    if (filter && filter.mine) return a.user_id === me.id;
    if (currentTeamSpaceId) return a.team_space_id === currentTeamSpaceId;
    return true;
  });

  // Context line shows where the user is currently scoped.
  const showMineContext = view === 'mail' && filter && filter.mine;
  const showTeamSpaceContext = view === 'mail' && currentTeamSpace && !showMineContext;

  // The picker is hidden in My Inbox (no meaningful choice — all results are
  // already in your mailboxes) and only shows when there are 2+ mailboxes
  // to choose between.
  const showPicker =
    view === 'mail' &&
    !showMineContext &&
    filter && setFilter &&
    accountsInScope.length > 1;

  return (
    <div className="topbar">
      <div className="topbar-left">
        <div className="tab-group">
          <button className={'tab ' + (view === 'mail' ? 'active' : '')} onClick={() => setView('mail')}>Mail</button>
          <button className={'tab ' + (view === 'tasks' ? 'active' : '')} onClick={() => setView('tasks')}>Tasks</button>
          <button className={'tab ' + (view === 'drafts' ? 'active' : '')} onClick={() => setView('drafts')}>Drafts</button>
          <button className={'tab ' + (view === 'scheduled' ? 'active' : '')} onClick={() => setView('scheduled')}>Scheduled</button>
          <button className={'tab ' + (view === 'chat' ? 'active' : '')} onClick={() => setView('chat')}>Team chat</button>
        </div>
        {showMineContext && (
          <div className="topbar-context muted small">My inbox · <strong>{me.email}</strong></div>
        )}
        {showTeamSpaceContext && (
          <div className="topbar-context muted small">in <strong>{currentTeamSpace.name}</strong></div>
        )}
        {showPicker && (
          <select
            className="mailbox-picker"
            value={filter.mailbox_id || ''}
            onChange={e => setFilter({ ...filter, mailbox_id: e.target.value || null })}
            title="Filter to one specific mailbox"
          >
            <option value="">All mailboxes ({accountsInScope.length})</option>
            {accountsInScope.map(a => (
              <option key={a.id} value={a.id}>
                {a.display_name ? `${a.display_name} (${a.email})` : a.email}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="topbar-right">
        <div className="presence">
          {online.slice(0, 8).map(u => (
            <div key={u.user_id} className="presence-avatar" title={`${u.name} • online`}>
              <Avatar name={u.name} size={26} />
              <span className="dot" />
            </div>
          ))}
          {online.length > 8 && <div className="presence-more muted small">+{online.length - 8}</div>}
        </div>
        {onCompose && <button className="compose-top" onClick={onCompose}>+ Compose</button>}
      </div>
    </div>
  );
}
