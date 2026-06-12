import React, { useEffect, useState, useCallback, useRef } from 'react';
import Sidebar from '../components/Sidebar.jsx';
import TopBar from '../components/TopBar.jsx';
import ThreadList from '../components/ThreadList.jsx';
import ThreadView from '../components/ThreadView.jsx';
import ChatView from '../components/ChatView.jsx';
import TasksView from '../components/TasksView.jsx';
import DraftsView from '../components/DraftsView.jsx';
import ScheduledView from '../components/ScheduledView.jsx';
import ConnectAccount from '../components/ConnectAccount.jsx';
import InviteModal from '../components/InviteModal.jsx';
import CannedModal from '../components/CannedModal.jsx';
import TeamSpaceModal from '../components/TeamSpaceModal.jsx';
import LabelsModal from '../components/LabelsModal.jsx';
import SignaturesModal from '../components/SignaturesModal.jsx';
import ComposeNew from '../components/ComposeNew.jsx';
import WorkspaceModal from '../components/WorkspaceModal.jsx';
import AccountModal from '../components/AccountModal.jsx';
import OnboardingScreen from '../components/OnboardingScreen.jsx';
import CategoryBar from '../components/CategoryBar.jsx';
import BulkActionBar from '../components/BulkActionBar.jsx';
import InboxSearchBar from '../components/InboxSearchBar.jsx';
import { api } from '../api';
import { getSocket, disconnectSocket } from '../socket';

const PAGE_SIZE = 50;

export default function Dashboard({ me, onLogout }) {
  const [view, setView] = useState('mail');  // mail | chat | tasks | drafts | scheduled
  const [filter, setFilter] = useState({ status: 'open', assignee: null, folder: null });
  const [currentTeamSpaceId, setCurrentTeamSpaceId] = useState(null);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [threads, setThreads] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // Current loaded rows, read inside callbacks without making them a dependency
  // (which would re-trigger the load effect on every list change).
  const threadsRef = useRef([]);
  // Synchronous in-flight guard for loadMore (see note there).
  const loadingMoreRef = useRef(false);
  const [selectedId, setSelectedId] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [team, setTeam] = useState([]);
  const [teamSpaces, setTeamSpaces] = useState([]);
  const [showConnect, setShowConnect] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [showCanned, setShowCanned] = useState(false);
  const [showSpaces, setShowSpaces] = useState(false);
  const [showLabels, setShowLabels] = useState(false);
  const [showSigs, setShowSigs] = useState(false);
  const [showCompose, setShowCompose] = useState(false);
  const [showWorkspace, setShowWorkspace] = useState(false);
  const [editAccountId, setEditAccountId] = useState(null);
  const [accountsLoaded, setAccountsLoaded] = useState(false);
  const [selectedThreadIds, setSelectedThreadIds] = useState(() => new Set());
  const [forwardInitial, setForwardInitial] = useState(null);
  const [labels, setLabels] = useState([]);
  // Dismiss flag is per-user-id so two teammates sharing a browser don't
  // affect each other, and rejoining workspaces re-shows the onboarding.
  const dismissKey = `missive_clone_onboarding_dismissed_${me.user.id}`;
  const [onboardingDismissed, setOnboardingDismissed] = useState(
    () => localStorage.getItem(dismissKey) === '1'
  );

  // Dark mode
  const [darkMode, setDarkMode] = useState(
    () => localStorage.getItem('missive_clone_theme') === 'dark'
  );
  useEffect(() => {
    document.documentElement.dataset.theme = darkMode ? 'dark' : 'light';
    localStorage.setItem('missive_clone_theme', darkMode ? 'dark' : 'light');
  }, [darkMode]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  // Keep a ref of the loaded rows so loadThreads/loadMore can read the current
  // count at call time without depending on `threads` (which would loop the
  // load effect below).
  useEffect(() => { threadsRef.current = threads; }, [threads]);

  const buildThreadParams = useCallback(() => {
    const params = new URLSearchParams();
    if (filter.status) params.set('status', filter.status);
    if (filter.assignee) params.set('assignee', filter.assignee);
    if (filter.folder) params.set('folder', filter.folder);
    if (filter.snoozed) params.set('snoozed', 'true');
    if (filter.label_id) params.set('label_id', filter.label_id);
    if (filter.mine) params.set('mine', 'true');
    if (filter.category) params.set('category', filter.category);
    if (filter.mailbox_id) params.set('mailbox_id', filter.mailbox_id);
    if (filter.starred) params.set('starred', 'true');
    if (currentTeamSpaceId) params.set('team_space_id', currentTeamSpaceId);
    if (debouncedSearch) params.set('q', debouncedSearch);
    return params;
  }, [filter, currentTeamSpaceId, debouncedSearch]);

  // Reset/refresh path: reload page 0 but keep the depth the user has already
  // scrolled to, so socket events and mutations don't collapse the list back to
  // the first 50 rows (and reset scroll position).
  const loadThreads = useCallback(async () => {
    const params = buildThreadParams();
    const limit = Math.min(200, Math.max(PAGE_SIZE, threadsRef.current.length));
    params.set('limit', String(limit));
    params.set('offset', '0');
    const res = await api('/api/threads?' + params.toString());
    setThreads(res.threads);
    setHasMore(res.hasMore);
  }, [buildThreadParams]);

  // Infinite scroll: append the next page of older conversations.
  const loadMore = useCallback(async () => {
    // Guard on the ref, not the `loadingMore` state: the scroll event fires
    // many times before the setLoadingMore re-render lands, so a state guard
    // would let several identical fetches through for the same offset and
    // append the same rows repeatedly.
    if (loadingMoreRef.current || !hasMore) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const params = buildThreadParams();
      params.set('limit', String(PAGE_SIZE));
      params.set('offset', String(threadsRef.current.length));
      const res = await api('/api/threads?' + params.toString());
      // De-dupe by id: offset pagination can overlap at a page boundary when a
      // thread is bumped to the top by a new message between fetches; appending
      // blindly would produce duplicate React keys.
      setThreads(prev => {
        const seen = new Set(prev.map(t => t.id));
        return [...prev, ...res.threads.filter(t => !seen.has(t.id))];
      });
      setHasMore(res.hasMore);
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [buildThreadParams, hasMore]);

  const loadAccounts = useCallback(async () => {
    const r = await api('/api/accounts');
    setAccounts(r.accounts);
    setAccountsLoaded(true);
  }, []);
  const loadTeam = useCallback(async () => {
    const r = await api('/api/auth/team'); setTeam(r.members);
  }, []);
  const loadTeamSpaces = useCallback(async () => {
    const r = await api('/api/team_spaces');
    setTeamSpaces(r.team_spaces || []);
    if (r.team_spaces && r.team_spaces.length && currentTeamSpaceId === null) {
      setCurrentTeamSpaceId(r.team_spaces[0].id);
    }
  }, [currentTeamSpaceId]);

  useEffect(() => { loadThreads(); }, [loadThreads]);
  useEffect(() => { loadAccounts(); loadTeam(); loadTeamSpaces(); }, [loadAccounts, loadTeam, loadTeamSpaces]);
  useEffect(() => {
    api('/api/labels').then(r => setLabels(r.labels || [])).catch(() => {});
  }, []);

  useEffect(() => {
    const s = getSocket();
    const onThread = () => loadThreads();
    const onTeamSpace = () => loadTeamSpaces();
    s.on('thread:updated', onThread);
    s.on('message:new', onThread);
    s.on('team_space:updated', onTeamSpace);
    return () => {
      s.off('thread:updated', onThread);
      s.off('message:new', onThread);
      s.off('team_space:updated', onTeamSpace);
    };
  }, [loadThreads, loadTeamSpaces]);

  useEffect(() => () => disconnectSocket(), []);

  // Deep-link from external apps (e.g. DelegationDoer's "Open in Missive"
  // buttons): a `?thread=ID` query param auto-selects that thread on load.
  // We also relax the status filter so threads in any state (closed, etc.)
  // are visible. The URL is cleaned up after handling so the deep-link
  // doesn't keep re-firing on later state changes.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const tid = params.get('thread');
    if (tid) {
      setSelectedId(tid);
      setFilter((f) => ({ ...f, status: null }));
      params.delete('thread');
      const qs = params.toString();
      const next = window.location.pathname + (qs ? `?${qs}` : '');
      window.history.replaceState({}, '', next);
    }
  }, []);

  async function syncAll() {
    for (const a of accounts) {
      try { await api(`/api/accounts/${a.id}/sync`, { method: 'POST' }); } catch {}
    }
    loadThreads();
  }

  async function closeThread(t) {
    const next = t.status === 'closed' ? 'open' : 'closed';
    await api(`/api/threads/${t.id}`, { method: 'PATCH', body: JSON.stringify({ status: next }) });
    if (next === 'closed' && selectedId === t.id) setSelectedId(null);
    loadThreads();
  }

  async function snoozeThread(t) {
    const oneHour = 60 * 60 * 1000;
    await api(`/api/threads/${t.id}`, { method: 'PATCH', body: JSON.stringify({ snoozed_until: Date.now() + oneHour }) });
    if (selectedId === t.id) setSelectedId(null);
    loadThreads();
  }

  async function toggleStar(t) {
    await api(`/api/threads/${t.id}`, { method: 'PATCH', body: JSON.stringify({ starred: !t.starred }) });
    loadThreads();
  }

  function toggleSelect(id) {
    setSelectedThreadIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }
  function clearSelection() { setSelectedThreadIds(new Set()); }

  function openForward(args) {
    setForwardInitial(args);
    setShowCompose(true);
  }

  // ----- Keyboard shortcuts -----
  useEffect(() => {
    function inEditable(target) {
      if (!target) return false;
      const tag = target.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
    }
    function onKey(e) {
      if (inEditable(e.target)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (view !== 'mail') return;

      const idx = threads.findIndex(t => t.id === selectedId);

      if (e.key === 'j') {
        e.preventDefault();
        const next = idx < threads.length - 1 ? threads[idx + 1] : threads[0];
        if (next) setSelectedId(next.id);
      } else if (e.key === 'k') {
        e.preventDefault();
        const prev = idx > 0 ? threads[idx - 1] : threads[threads.length - 1];
        if (prev) setSelectedId(prev.id);
      } else if (e.key === 'e' && selectedId) {
        e.preventDefault();
        const t = threads.find(x => x.id === selectedId);
        if (t) closeThread(t);
      } else if (e.key === 's' && selectedId) {
        e.preventDefault();
        const t = threads.find(x => x.id === selectedId);
        if (t) snoozeThread(t);
      } else if (e.key === 'l' && selectedId) {
        e.preventDefault();
        const t = threads.find(x => x.id === selectedId);
        if (t) toggleStar(t);
      } else if (e.key === 'c') {
        e.preventDefault();
        setForwardInitial(null);
        setShowCompose(true);
      } else if (e.key === '/') {
        e.preventDefault();
        const sb = document.querySelector('.sidebar-search');
        if (sb) sb.focus();
      } else if (e.key === 'Escape') {
        if (selectedThreadIds.size > 0) clearSelection();
        else setSelectedId(null);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view, threads, selectedId, selectedThreadIds]);

  function openThreadFromDraft(threadId) {
    setView('mail');
    setSelectedId(threadId);
  }

  const currentTeamSpace = teamSpaces.find(t => t.id === currentTeamSpaceId) || null;

  // Count mailboxes THIS user owns, not the whole workspace. Otherwise
  // anyone joining a workspace where someone else already connected a
  // mailbox skips the onboarding entirely (the bug Sean hit).
  const myAccountCount = accounts.filter(a => a.user_id === me.user.id).length;

  // Full-screen first-run onboarding. Fires for every user the first
  // time they land in the dashboard with no mailbox of their own,
  // even if a teammate has already connected mailboxes to the workspace.
  if (accountsLoaded && myAccountCount === 0 && !onboardingDismissed) {
    return (
      <OnboardingScreen
        me={me}
        teamSpaces={teamSpaces}
        onDone={loadAccounts}
        onSkip={() => {
          localStorage.setItem(dismissKey, '1');
          setOnboardingDismissed(true);
        }}
      />
    );
  }

  return (
    <div className="app">
      <Sidebar
        me={me.user} workspace={me.workspace}
        view={view} setView={setView}
        filter={filter} setFilter={setFilter}
        search={search} setSearch={setSearch}
        accounts={accounts}
        teamSpaces={teamSpaces}
        currentTeamSpaceId={currentTeamSpaceId}
        setCurrentTeamSpaceId={setCurrentTeamSpaceId}
        onManageTeamSpaces={() => setShowSpaces(true)}
        onAddAccount={() => setShowConnect(true)}
        onEditAccount={(id) => setEditAccountId(id)}
        onSync={syncAll}
        onCompose={() => setShowCompose(true)}
        onLabels={() => setShowLabels(true)}
        onSignatures={() => setShowSigs(true)}
        onInvite={() => setShowInvite(true)}
        onCanned={() => setShowCanned(true)}
        onWorkspace={() => setShowWorkspace(true)}
        onLogout={onLogout}
        darkMode={darkMode}
        onToggleDark={() => setDarkMode(d => !d)}
      />

      <div className="main-col">
        <TopBar
          me={me.user}
          view={view} setView={setView}
          currentTeamSpace={currentTeamSpace}
          currentTeamSpaceId={currentTeamSpaceId}
          accounts={accounts}
          filter={filter}
          setFilter={setFilter}
          onCompose={() => setShowCompose(true)}
        />

        {myAccountCount === 0 && (
          <div className="onboarding-banner">
            <div>
              <strong>👋 Hi {me.user.name?.split(' ')[0] || 'there'}.</strong> You haven't connected your own inbox yet.
              Connect your Outlook so emails sent to you show up here too.
            </div>
            <button onClick={() => setShowConnect(true)}>Connect my inbox</button>
          </div>
        )}

        {view === 'mail' && (
          <>
            <InboxSearchBar
              value={search}
              onChange={setSearch}
              placeholder={
                filter.mine ? 'Search your inbox…' :
                currentTeamSpace ? `Search ${currentTeamSpace.name}…` :
                filter.starred ? 'Search starred…' :
                filter.label_id ? 'Search this label…' :
                filter.category ? 'Search filtered…' :
                'Search all conversations…'
              }
              scopeLabel={
                filter.mine ? 'My inbox' :
                currentTeamSpace ? currentTeamSpace.name :
                null
              }
            />
            <CategoryBar filter={filter} setFilter={setFilter} />
            {selectedThreadIds.size > 0 && (
              <BulkActionBar
                selectedIds={selectedThreadIds}
                onClear={clearSelection}
                onChanged={loadThreads}
                team={team}
                labels={labels}
              />
            )}
            <div className="mail-grid">
              <ThreadList
                threads={threads}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onCloseThread={closeThread}
                onSnoozeThread={snoozeThread}
                onToggleStar={toggleStar}
                selectedIds={selectedThreadIds}
                onToggleSelect={toggleSelect}
                onLoadMore={loadMore}
                hasMore={hasMore}
                loadingMore={loadingMore}
              />
              <ThreadView
                threadId={selectedId}
                me={me.user}
                team={team}
                accounts={accounts}
                onChanged={loadThreads}
                onForward={openForward}
              />
            </div>
          </>
        )}

        {view === 'chat' && <ChatView me={me.user} team={team} />}
        {view === 'tasks' && (
          <TasksView me={me.user} team={team} teamSpaces={teamSpaces} currentTeamSpace={currentTeamSpace} />
        )}
        {view === 'drafts' && <DraftsView onOpenThread={openThreadFromDraft} />}
        {view === 'scheduled' && <ScheduledView />}
      </div>

      {showConnect && (
        <ConnectAccount
          teamSpaces={teamSpaces}
          defaultTeamSpaceId={currentTeamSpaceId}
          onClose={() => setShowConnect(false)}
          onCreated={() => { setShowConnect(false); loadAccounts(); loadTeamSpaces(); }}
        />
      )}
      {showInvite && <InviteModal accounts={accounts} onClose={() => setShowInvite(false)} />}
      {showCanned && <CannedModal onClose={() => setShowCanned(false)} />}
      {showSpaces && <TeamSpaceModal onClose={() => { setShowSpaces(false); loadTeamSpaces(); loadAccounts(); }} />}
      {showLabels && <LabelsModal onClose={() => { setShowLabels(false); loadThreads(); }} />}
      {showSigs && <SignaturesModal accounts={accounts} onClose={() => setShowSigs(false)} />}
      {showCompose && (
        <ComposeNew
          accounts={accounts}
          defaultAccountId={(forwardInitial && forwardInitial.accountId) || accounts[0]?.id}
          initial={forwardInitial}
          onClose={() => { setShowCompose(false); setForwardInitial(null); }}
          onSent={(r) => {
            setShowCompose(false);
            setForwardInitial(null);
            loadThreads();
            if (r && r.thread_id) {
              setView('mail');
              setSelectedId(r.thread_id);
            }
          }}
        />
      )}
      {showWorkspace && (
        <WorkspaceModal me={me.user} onClose={() => setShowWorkspace(false)} onChanged={() => { /* workspace reload can be added if needed */ }} />
      )}
      {editAccountId && (
        <AccountModal
          accountId={editAccountId}
          accounts={accounts}
          teamSpaces={teamSpaces}
          onClose={() => setEditAccountId(null)}
          onChanged={() => { loadAccounts(); loadTeamSpaces(); loadThreads(); }}
        />
      )}
    </div>
  );
}
