import React, { useEffect, useState } from 'react';
import Avatar from './Avatar.jsx';
import { getSocket } from '../socket';

export default function TopBar({ me, view, setView, currentTeamSpace }) {
  const [online, setOnline] = useState([]);

  useEffect(() => {
    const s = getSocket();
    const onPresence = (p) => setOnline(p.online || []);
    s.on('presence:update', onPresence);
    s.emit('presence:hello', { name: me.name });
    return () => s.off('presence:update', onPresence);
  }, [me.name]);

  return (
    <div className="topbar">
      <div className="topbar-left">
        <div className="tab-group">
          <button className={'tab ' + (view === 'mail' ? 'active' : '')} onClick={() => setView('mail')}>Mail</button>
          <button className={'tab ' + (view === 'tasks' ? 'active' : '')} onClick={() => setView('tasks')}>Tasks</button>
          <button className={'tab ' + (view === 'drafts' ? 'active' : '')} onClick={() => setView('drafts')}>Drafts</button>
          <button className={'tab ' + (view === 'chat' ? 'active' : '')} onClick={() => setView('chat')}>Team chat</button>
        </div>
        {currentTeamSpace && (
          <div className="topbar-context muted small">in <strong>{currentTeamSpace.name}</strong></div>
        )}
      </div>
      <div className="presence">
        {online.slice(0, 8).map(u => (
          <div key={u.user_id} className="presence-avatar" title={`${u.name} • online`}>
            <Avatar name={u.name} size={26} />
            <span className="dot" />
          </div>
        ))}
        {online.length > 8 && <div className="presence-more muted small">+{online.length - 8}</div>}
      </div>
    </div>
  );
}
