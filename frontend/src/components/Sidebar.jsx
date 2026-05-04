import React from 'react';
import Avatar from './Avatar.jsx';

const Icon = ({ d, size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
       stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);
// Minimal icon set, sourced as SVG path data.
const I = {
  inbox:    'M22 12h-6l-2 3h-4l-2-3H2 M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z',
  user:     'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2 M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  clock:    'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M12 6v6l4 2',
  archive:  'M21 8v13H3V8 M1 3h22v5H1z M10 12h4',
  send:     'M22 2L11 13 M22 2l-7 20-4-9-9-4 20-7z',
  list:     'M8 6h13 M8 12h13 M8 18h13 M3 6h.01 M3 12h.01 M3 18h.01',
  chat:     'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  plus:     'M12 5v14 M5 12h14',
  refresh:  'M23 4v6h-6 M1 20v-6h6 M3.51 9a9 9 0 0 1 14.85-3.36L23 10 M20.49 15a9 9 0 0 1-14.85 3.36L1 14',
  invite:   'M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2 M8.5 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M20 8v6 M23 11h-6',
  bookmark: 'M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z',
  out:      'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4 M16 17l5-5-5-5 M21 12H9'
};

export default function Sidebar({
  me, workspace, filter, setFilter, view, setView,
  search, setSearch,
  accounts, onAddAccount, onSync,
  onInvite, onCanned,
  onLogout
}) {
  const matches = (key) =>
    view === 'mail' &&
    filter.status === key.status &&
    (filter.assignee || null) === (key.assignee || null) &&
    (filter.folder || null) === (key.folder || null);

  const item = (label, iconKey, key) => (
    <div
      key={label}
      className={'side-item ' + (matches(key) ? 'active' : '')}
      onClick={() => { setView('mail'); setFilter(key); }}
    >
      <Icon d={I[iconKey]} />
      <span>{label}</span>
    </div>
  );

  return (
    <aside className="sidebar">
      <div className="ws-card">
        <Avatar name={workspace?.name || 'W'} size={32} />
        <div className="ws-name-wrap">
          <div className="ws-name">{workspace?.name || 'Workspace'}</div>
          <div className="muted small">{me.email}</div>
        </div>
      </div>

      <div className="search-wrap">
        <input
          className="sidebar-search"
          placeholder="Search conversations…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      <div className="side-section-title">Mail</div>
      {item('Inbox',          'inbox',    { status: 'open',    assignee: null, folder: null })}
      {item('Assigned to me', 'user',     { status: 'open',    assignee: 'me', folder: null })}
      {item('Pending',        'clock',    { status: 'pending', assignee: null, folder: null })}
      {item('Closed',         'archive',  { status: 'closed',  assignee: null, folder: null })}
      {item('Sent',           'send',     { status: '',        assignee: null, folder: 'SENT' })}
      {item('All',            'list',     { status: '',        assignee: null, folder: null })}

      <div className="side-section-title">Team</div>
      <div className={'side-item ' + (view === 'chat' ? 'active' : '')} onClick={() => setView('chat')}>
        <Icon d={I.chat} /><span>Team chat</span>
      </div>
      <div className="side-item" onClick={onInvite}>
        <Icon d={I.invite} /><span>Invite teammate</span>
      </div>
      <div className="side-item" onClick={onCanned}>
        <Icon d={I.bookmark} /><span>Canned responses</span>
      </div>

      <div className="side-section-title">
        Accounts
        <button className="link" onClick={onAddAccount}>+ Add</button>
      </div>
      {accounts.length === 0 && <div className="muted small pad-h">No accounts connected</div>}
      {accounts.map(a => (
        <div className="acct" key={a.id} title={`IMAP: ${a.imap_host}`}>
          <Avatar name={a.email} size={22} />
          <div style={{ overflow: 'hidden' }}>
            <div className="ellipsis">{a.email}</div>
            <div className="muted xs">
              {a.last_synced_at
                ? 'Synced ' + new Date(Number(a.last_synced_at)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                : 'Never synced'}
            </div>
          </div>
        </div>
      ))}
      <button className="ghost small inline-icon" onClick={onSync}>
        <Icon d={I.refresh} size={12} /> Sync now
      </button>

      <div className="spacer" />

      <div className="me">
        <Avatar name={me.name} size={28} />
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <div className="ellipsis"><strong>{me.name}</strong></div>
          <div className="muted xs ellipsis">{me.email}</div>
        </div>
        <button className="icon-btn" onClick={onLogout} title="Log out">
          <Icon d={I.out} />
        </button>
      </div>
    </aside>
  );
}
