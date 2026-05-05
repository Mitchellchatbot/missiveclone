import React, { useEffect, useState, useCallback } from 'react';
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
import { api } from '../api';
import { getSocket, disconnectSocket } from '../socket';

export default function Dashboard({ me, onLogout }) {
  const [view, setView] = useState('mail');  // mail | chat | tasks | drafts | scheduled
  const [filter, setFilter] = useState({ status: 'open', assignee: null, folder: null });
  const [currentTeamSpaceId, setCurrentTeamSpaceId] = useState(null);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [threads, setThreads] = useState([]);
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
  const [onboardingDismissed, setOnboardingDismissed] = useState(
    () => localStorage.getItem('missive_clone_onboarding_dismissed') === '1'
  );

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  const loadThreads = useCallback(async () => {
    const params = new URLSearchParams();
    if (filter.status) params.set('status', filter.status);
    if (filter.assignee) params.set('assignee', filter.assignee);
    if (filter.folder) params.set('folder', filter.folder);
    if (filter.snoozed) params.set('snoozed', 'true');
    if (filter.label_id) params.set('label_id', filter.label_id);
    if (currentTeamSpaceId) params.set('team_space_id', currentTeamSpaceId);
    if (debouncedSearch) params.set('q', debouncedSearch);
    const res = await api('/api/threads?' + params.toString());
    setThreads(res.threads);
  }, [filter, currentTeamSpaceId, debouncedSearch]);

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

  async function syncAll() {
    for (const a of accounts) {
      try { await api(`/api/accounts/${a.id}/sync`, { method: 'POST' }); } catch {}
    }
    loadThreads();
  }

  function openThreadFromDraft(threadId) {
    setView('mail');
    setSelectedId(threadId);
  }

  const currentTeamSpace = teamSpaces.find(t => t.id === currentTeamSpaceId) || null;

  // First-run onboarding: full-screen takeover when the user has never
  // connected a mailbox and hasn't explicitly skipped. Once they connect,
  // accounts.length > 0 and this screen disappears automatically.
  if (accountsLoaded && accounts.length === 0 && !onboardingDismissed) {
    return (
      <OnboardingScreen
        me={me}
        teamSpaces={teamSpaces}
        onDone={loadAccounts}
        onSkip={() => {
          localStorage.setItem('missive_clone_onboarding_dismissed', '1');
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
      />

      <div className="main-col">
        <TopBar
          me={me.user}
          view={view} setView={setView}
          currentTeamSpace={currentTeamSpace}
          onCompose={() => setShowCompose(true)}
        />

        {accounts.length === 0 && (
          <div className="onboarding-banner">
            <div>
              <strong>👋 Welcome.</strong> You haven't connected an inbox yet.
              Connect your Outlook (or any IMAP account) so your emails show up here.
            </div>
            <button onClick={() => setShowConnect(true)}>Connect inbox</button>
          </div>
        )}

        {view === 'mail' && (
          <div className="mail-grid">
            <ThreadList threads={threads} selectedId={selectedId} onSelect={setSelectedId} />
            <ThreadView
              threadId={selectedId}
              me={me.user}
              team={team}
              accounts={accounts}
              onChanged={loadThreads}
            />
          </div>
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
      {showInvite && <InviteModal onClose={() => setShowInvite(false)} />}
      {showCanned && <CannedModal onClose={() => setShowCanned(false)} />}
      {showSpaces && <TeamSpaceModal onClose={() => { setShowSpaces(false); loadTeamSpaces(); loadAccounts(); }} />}
      {showLabels && <LabelsModal onClose={() => { setShowLabels(false); loadThreads(); }} />}
      {showSigs && <SignaturesModal accounts={accounts} onClose={() => setShowSigs(false)} />}
      {showCompose && (
        <ComposeNew
          accounts={accounts}
          defaultAccountId={accounts[0]?.id}
          onClose={() => setShowCompose(false)}
          onSent={(r) => {
            setShowCompose(false);
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
