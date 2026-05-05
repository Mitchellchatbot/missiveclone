import React, { useState, useEffect } from 'react';
import Avatar from './Avatar.jsx';
import { api } from '../api';

const Icon = ({ d, size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
       stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);

const I = {
  inbox:    'M22 12h-6l-2 3h-4l-2-3H2 M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z',
  user:     'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2 M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  clock:    'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M12 6v6l4 2',
  archive:  'M21 8v13H3V8 M1 3h22v5H1z M10 12h4',
  send:     'M22 2L11 13 M22 2l-7 20-4-9-9-4 20-7z',
  list:     'M8 6h13 M8 12h13 M8 18h13 M3 6h.01 M3 12h.01 M3 18h.01',
  chat:     'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  refresh:  'M23 4v6h-6 M1 20v-6h6 M3.51 9a9 9 0 0 1 14.85-3.36L23 10 M20.49 15a9 9 0 0 1-14.85 3.36L1 14',
  invite:   'M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2 M8.5 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M20 8v6 M23 11h-6',
  bookmark: 'M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z',
  out:      'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4 M16 17l5-5-5-5 M21 12H9',
  chevDn:   'M6 9l6 6 6-6',
  chevRt:   'M9 18l6-6-6-6',
  pen:      'M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7 M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z',
  check:    'M9 11l3 3L22 4 M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11',
  zzz:      'M4 4h12l-12 16h12 M14 4l6 0 M14 12l6 0 M14 20l6 0',
  tag:      'M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z M7 7h.01',
  pencilSquare: 'M12 20h9 M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z',
  scheduled: 'M12 8v4l3 3 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z',
  shield:   'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  bell:     'M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9 M13.73 21a2 2 0 0 1-3.46 0',
  receipt:  'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M16 13H8 M16 17H8 M10 9H8',
  cal:      'M19 4H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z M16 2v4 M8 2v4 M3 10h18',
  users:    'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M23 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75',
  alert:    'M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z M12 9v4 M12 17h.01'
};

export default function Sidebar({
  me, workspace,
  view, setView,
  filter, setFilter,
  search, setSearch,
  accounts, onAddAccount, onSync, onEditAccount,
  teamSpaces, currentTeamSpaceId, setCurrentTeamSpaceId,
  onManageTeamSpaces, onCompose, onLabels, onSignatures,
  onInvite, onCanned, onWorkspace,
  onLogout
}) {
  const [openSpaces, setOpenSpaces] = useState(() => new Set(teamSpaces.map(t => t.id)));
  const [labels, setLabels] = useState([]);

  function toggleSpace(id) {
    setOpenSpaces(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  useEffect(() => {
    api('/api/labels').then(r => setLabels(r.labels || [])).catch(() => {});
  }, []);

  const matches = (key, tsId) =>
    view === 'mail' &&
    currentTeamSpaceId === tsId &&
    filter.status === key.status &&
    (filter.assignee || null) === (key.assignee || null) &&
    (filter.folder || null) === (key.folder || null) &&
    (filter.snoozed || false) === (key.snoozed || false) &&
    (filter.label_id || null) === (key.label_id || null) &&
    (filter.mine || false) === (key.mine || false) &&
    (filter.category || null) === (key.category || null);

  const inboxItem = (label, iconKey, key, tsId) => (
    <div
      key={`${tsId || 'all'}-${label}`}
      className={'side-item nested ' + (matches(key, tsId) ? 'active' : '')}
      onClick={() => { setView('mail'); setCurrentTeamSpaceId(tsId); setFilter(key); }}
    >
      <Icon d={I[iconKey]} size={14} />
      <span>{label}</span>
    </div>
  );

  return (
    <aside className="sidebar">
      <div className="ws-card" onClick={onWorkspace} style={{ cursor: 'pointer' }} title="Workspace settings">
        <Avatar name={workspace?.name || 'W'} size={32} />
        <div className="ws-name-wrap">
          <div className="ws-name">{workspace?.name || 'Workspace'}</div>
          <div className="muted small">{me.email}</div>
        </div>
      </div>

      <button className="compose-btn" onClick={onCompose}>
        <Icon d={I.pencilSquare} size={14} />
        New email
      </button>

      <div className="search-wrap">
        <input
          className="sidebar-search"
          placeholder="Search conversations…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      <div className="side-section-title">Personal</div>
      <div
        className={'side-item ' + (view === 'mail' && filter.mine && !filter.category ? 'active' : '')}
        onClick={() => { setView('mail'); setCurrentTeamSpaceId(null); setFilter({ status: '', assignee: null, folder: null, mine: true }); }}
      >
        <Icon d={I.user} /><span>My inbox</span>
      </div>

      <div className="side-section-title">Smart filters</div>
      {[
        { key: 'codes',       label: 'Verification codes', icon: 'shield' },
        { key: 'newsletters', label: 'Newsletters & no-reply', icon: 'bell' },
        { key: 'receipts',    label: 'Receipts & orders', icon: 'receipt' },
        { key: 'calendar',    label: 'Calendar invites', icon: 'cal' },
        { key: 'people',      label: 'Real conversations', icon: 'users' },
        { key: 'bounces',     label: 'Delivery failures', icon: 'alert' }
      ].map(c => (
        <div
          key={c.key}
          className={'side-item ' + (view === 'mail' && filter.category === c.key ? 'active' : '')}
          onClick={() => { setView('mail'); setFilter({ ...filter, category: c.key, status: '', assignee: null, folder: null, snoozed: false, label_id: null }); }}
        >
          <Icon d={I[c.icon]} /><span>{c.label}</span>
        </div>
      ))}

      <div className="side-section-title">Team spaces
        <button className="link" onClick={onManageTeamSpaces}>Manage</button>
      </div>

      {teamSpaces.length === 0 && <div className="muted small pad-h">No team spaces</div>}

      {teamSpaces.map(ts => {
        const isOpen = openSpaces.has(ts.id);
        return (
          <div key={ts.id} className="space-block">
            <div className="space-header" onClick={() => toggleSpace(ts.id)}>
              <Icon d={isOpen ? I.chevDn : I.chevRt} size={12} />
              <Avatar name={ts.name} size={20} />
              <span className="space-name">{ts.name}</span>
              {ts.account_count > 0 && <span className="muted xs">{ts.account_count}</span>}
            </div>
            {isOpen && (
              <div className="space-children">
                {inboxItem('Inbox',          'inbox',   { status: 'open',    assignee: null, folder: null }, ts.id)}
                {inboxItem('Assigned to me', 'user',    { status: 'open',    assignee: 'me', folder: null }, ts.id)}
                {inboxItem('Pending',        'clock',   { status: 'pending', assignee: null, folder: null }, ts.id)}
                {inboxItem('Snoozed',        'zzz',     { status: '',        assignee: null, folder: null, snoozed: true }, ts.id)}
                {inboxItem('Closed',         'archive', { status: 'closed',  assignee: null, folder: null }, ts.id)}
                {inboxItem('Sent',           'send',    { status: '',        assignee: null, folder: 'SENT' }, ts.id)}
              </div>
            )}
          </div>
        );
      })}

      <div className="side-section-title">All workspaces</div>
      <div
        className={'side-item ' + (view === 'mail' && !currentTeamSpaceId && !filter.label_id ? 'active' : '')}
        onClick={() => { setView('mail'); setCurrentTeamSpaceId(null); setFilter({ status: '', assignee: null, folder: null }); }}
      >
        <Icon d={I.list} /><span>All conversations</span>
      </div>

      {labels.length > 0 && (
        <>
          <div className="side-section-title">
            Labels
            <button className="link" onClick={onLabels}>Manage</button>
          </div>
          {labels.map(l => (
            <div
              key={l.id}
              className={'side-item ' + (filter.label_id === l.id ? 'active' : '')}
              onClick={() => { setView('mail'); setCurrentTeamSpaceId(null); setFilter({ status: '', assignee: null, folder: null, label_id: l.id }); }}
            >
              <span className="label-dot" style={{ background: l.color }} />
              <span>{l.name}</span>
            </div>
          ))}
        </>
      )}
      {labels.length === 0 && (
        <div className="side-item" onClick={onLabels}><Icon d={I.tag} /><span>Labels</span></div>
      )}

      <div className="side-section-title">Workspace</div>
      <div className={'side-item ' + (view === 'tasks' ? 'active' : '')} onClick={() => setView('tasks')}>
        <Icon d={I.check} /><span>Tasks</span>
      </div>
      <div className={'side-item ' + (view === 'drafts' ? 'active' : '')} onClick={() => setView('drafts')}>
        <Icon d={I.pen} /><span>Drafts</span>
      </div>
      <div className={'side-item ' + (view === 'scheduled' ? 'active' : '')} onClick={() => setView('scheduled')}>
        <Icon d={I.scheduled} /><span>Scheduled</span>
      </div>
      <div className={'side-item ' + (view === 'chat' ? 'active' : '')} onClick={() => setView('chat')}>
        <Icon d={I.chat} /><span>Team chat</span>
      </div>
      <div className="side-item" onClick={onInvite}>
        <Icon d={I.invite} /><span>Invite teammate</span>
      </div>
      <div className="side-item" onClick={onCanned}>
        <Icon d={I.bookmark} /><span>Canned responses</span>
      </div>
      <div className="side-item" onClick={onSignatures}>
        <Icon d={I.pen} /><span>Signatures</span>
      </div>

      <div className="side-section-title">
        Accounts
        <button className="link" onClick={onAddAccount}>+ Add</button>
      </div>
      {accounts.length === 0 && <div className="muted small pad-h">No accounts connected</div>}
      {accounts.map(a => (
        <div className="acct" key={a.id} title={a.email + ' · click to edit'} onClick={() => onEditAccount && onEditAccount(a.id)} style={{ cursor: 'pointer' }}>
          <Avatar name={a.email} size={22} />
          <div style={{ overflow: 'hidden' }}>
            <div className="ellipsis">{a.email}</div>
            <div className="muted xs ellipsis">
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
