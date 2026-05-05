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

  // Mailboxes in the currently-selected team space (or all of them, if no space).
  const accountsInScope = (accounts || []).filter(a =>
    !currentTeamSpaceId || a.team_space_id === currentTeamSpaceId
  );

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
        {view === 'mail' && currentTeamSpace && (
          <div className="topbar-context muted small">in <strong>{currentTeamSpace.name}</strong></div>
        )}
        {view === 'mail' && filter && setFilter && accountsInScope.length > 1 && (
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
