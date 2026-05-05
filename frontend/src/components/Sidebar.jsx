import React, { useState, useEffect } from 'react';
import {
  Inbox, UserCircle, Clock, Archive, Send, List, MessageSquare,
  RefreshCw, UserPlus, Bookmark, LogOut, ChevronDown, ChevronRight,
  PencilLine, CheckSquare, Moon as MoonIcon, Tag as TagIcon,
  ShieldCheck, Bell, Receipt, Calendar, AlertTriangle, Users,
  Star, Sun, Mail, Layers, PenLine, Send as SendIcon
} from 'lucide-react';
import Avatar from './Avatar.jsx';
import { api } from '../api';

export default function Sidebar({
  me, workspace,
  view, setView,
  filter, setFilter,
  search, setSearch,
  accounts, onAddAccount, onSync, onEditAccount,
  teamSpaces, currentTeamSpaceId, setCurrentTeamSpaceId,
  onManageTeamSpaces, onCompose, onLabels, onSignatures,
  onInvite, onCanned, onWorkspace,
  onLogout,
  darkMode, onToggleDark
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
    (filter.category || null) === (key.category || null) &&
    (filter.starred || false) === (key.starred || false);

  const inboxItem = (label, Ico, key, tsId) => (
    <div
      key={`${tsId || 'all'}-${label}`}
      className={'side-item nested ' + (matches(key, tsId) ? 'active' : '')}
      onClick={() => { setView('mail'); setCurrentTeamSpaceId(tsId); setFilter(key); }}
    >
      <Ico size={14} strokeWidth={2.2} />
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
        <PencilLine size={14} />
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
        className={'side-item ' + (view === 'mail' && filter.mine && !filter.category && !filter.starred ? 'active' : '')}
        onClick={() => { setView('mail'); setCurrentTeamSpaceId(null); setFilter({ status: '', assignee: null, folder: null, mine: true }); }}
      >
        <UserCircle size={16} /><span>My inbox</span>
      </div>
      <div
        className={'side-item ' + (view === 'mail' && filter.starred ? 'active' : '')}
        onClick={() => { setView('mail'); setCurrentTeamSpaceId(null); setFilter({ status: '', assignee: null, folder: null, starred: true }); }}
      >
        <Star size={16} fill="#f59e0b" stroke="#f59e0b" /><span>Starred</span>
      </div>

      <div className="side-section-title">Smart filters</div>
      {[
        { key: 'codes',       label: 'Verification codes',  Ico: ShieldCheck,    color: '#dc2626' },
        { key: 'newsletters', label: 'Newsletters & no-reply', Ico: Bell,        color: '#d97706' },
        { key: 'receipts',    label: 'Receipts & orders',   Ico: Receipt,        color: '#2f6feb' },
        { key: 'calendar',    label: 'Calendar invites',    Ico: Calendar,       color: '#7c3aed' },
        { key: 'people',      label: 'Real conversations',  Ico: Users,          color: '#0fa55a' },
        { key: 'bounces',     label: 'Delivery failures',   Ico: AlertTriangle,  color: '#b54708' }
      ].map(c => (
        <div
          key={c.key}
          className={'side-item ' + (view === 'mail' && filter.category === c.key ? 'active' : '')}
          onClick={() => { setView('mail'); setFilter({ ...filter, category: c.key, status: '', assignee: null, folder: null, snoozed: false, label_id: null }); }}
        >
          <c.Ico size={16} color={c.color} strokeWidth={2.2} /><span>{c.label}</span>
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
              {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              <Avatar name={ts.name} size={20} />
              <span className="space-name">{ts.name}</span>
              {ts.account_count > 0 && <span className="muted xs">{ts.account_count}</span>}
            </div>
            {isOpen && (
              <div className="space-children">
                {inboxItem('Inbox',          Inbox,    { status: 'open',    assignee: null, folder: null }, ts.id)}
                {inboxItem('Assigned to me', UserCircle, { status: 'open',  assignee: 'me', folder: null }, ts.id)}
                {inboxItem('Pending',        Clock,    { status: 'pending', assignee: null, folder: null }, ts.id)}
                {inboxItem('Snoozed',        MoonIcon, { status: '',        assignee: null, folder: null, snoozed: true }, ts.id)}
                {inboxItem('Closed',         Archive,  { status: 'closed',  assignee: null, folder: null }, ts.id)}
                {inboxItem('Sent',           Send,     { status: '',        assignee: null, folder: 'SENT' }, ts.id)}
              </div>
            )}
          </div>
        );
      })}

      <div className="side-section-title">All workspaces</div>
      <div
        className={'side-item ' + (view === 'mail' && !currentTeamSpaceId && !filter.label_id && !filter.mine && !filter.starred && !filter.category ? 'active' : '')}
        onClick={() => { setView('mail'); setCurrentTeamSpaceId(null); setFilter({ status: '', assignee: null, folder: null }); }}
      >
        <List size={16} /><span>All conversations</span>
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
        <div className="side-item" onClick={onLabels}><TagIcon size={16} /><span>Labels</span></div>
      )}

      <div className="side-section-title">Workspace</div>
      <div className={'side-item ' + (view === 'tasks' ? 'active' : '')} onClick={() => setView('tasks')}>
        <CheckSquare size={16} /><span>Tasks</span>
      </div>
      <div className={'side-item ' + (view === 'drafts' ? 'active' : '')} onClick={() => setView('drafts')}>
        <PenLine size={16} /><span>Drafts</span>
      </div>
      <div className={'side-item ' + (view === 'scheduled' ? 'active' : '')} onClick={() => setView('scheduled')}>
        <Clock size={16} /><span>Scheduled</span>
      </div>
      <div className={'side-item ' + (view === 'chat' ? 'active' : '')} onClick={() => setView('chat')}>
        <MessageSquare size={16} /><span>Team chat</span>
      </div>
      <div className="side-item" onClick={onInvite}>
        <UserPlus size={16} /><span>Invite teammate</span>
      </div>
      <div className="side-item" onClick={onCanned}>
        <Bookmark size={16} /><span>Canned responses</span>
      </div>
      <div className="side-item" onClick={onSignatures}>
        <PenLine size={16} /><span>Signatures</span>
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
      <button className="ghost small icon-text" onClick={onSync}>
        <RefreshCw size={12} /> Sync now
      </button>

      <div className="spacer" />

      <div className="me">
        <Avatar name={me.name} size={28} />
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <div className="ellipsis"><strong>{me.name}</strong></div>
          <div className="muted xs ellipsis">{me.email}</div>
        </div>
        {onToggleDark && (
          <button className="icon-btn" onClick={onToggleDark} title={darkMode ? 'Light mode' : 'Dark mode'}>
            {darkMode ? <Sun size={14} /> : <MoonIcon size={14} />}
          </button>
        )}
        <button className="icon-btn" onClick={onLogout} title="Log out">
          <LogOut size={14} />
        </button>
      </div>
    </aside>
  );
}
