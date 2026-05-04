import React, { useEffect, useState, useCallback } from 'react';
import Sidebar from '../components/Sidebar.jsx';
import ThreadList from '../components/ThreadList.jsx';
import ThreadView from '../components/ThreadView.jsx';
import ChatView from '../components/ChatView.jsx';
import ConnectAccount from '../components/ConnectAccount.jsx';
import InviteModal from '../components/InviteModal.jsx';
import CannedModal from '../components/CannedModal.jsx';
import { api } from '../api';
import { getSocket, disconnectSocket } from '../socket';

export default function Dashboard({ me, onLogout }) {
  const [view, setView] = useState('mail');  // 'mail' | 'chat'
  const [filter, setFilter] = useState({ status: 'open', assignee: null, folder: null });
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [threads, setThreads] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [team, setTeam] = useState([]);
  const [showConnect, setShowConnect] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [showCanned, setShowCanned] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  const loadThreads = useCallback(async () => {
    const params = new URLSearchParams();
    if (filter.status) params.set('status', filter.status);
    if (filter.assignee) params.set('assignee', filter.assignee);
    if (filter.folder) params.set('folder', filter.folder);
    if (debouncedSearch) params.set('q', debouncedSearch);
    const res = await api('/api/threads?' + params.toString());
    setThreads(res.threads);
  }, [filter, debouncedSearch]);

  const loadAccounts = useCallback(async () => {
    const r = await api('/api/accounts'); setAccounts(r.accounts);
  }, []);
  const loadTeam = useCallback(async () => {
    const r = await api('/api/auth/team'); setTeam(r.members);
  }, []);

  useEffect(() => { loadThreads(); }, [loadThreads]);
  useEffect(() => { loadAccounts(); loadTeam(); }, [loadAccounts, loadTeam]);

  useEffect(() => {
    const s = getSocket();
    const onThread = () => loadThreads();
    s.on('thread:updated', onThread);
    s.on('message:new', onThread);
    return () => {
      s.off('thread:updated', onThread);
      s.off('message:new', onThread);
    };
  }, [loadThreads]);

  useEffect(() => () => disconnectSocket(), []);

  async function syncAll() {
    for (const a of accounts) {
      try { await api(`/api/accounts/${a.id}/sync`, { method: 'POST' }); } catch {}
    }
    loadThreads();
  }

  return (
    <div className="app">
      <Sidebar
        me={me.user} workspace={me.workspace}
        view={view} setView={setView}
        filter={filter} setFilter={setFilter}
        search={search} setSearch={setSearch}
        accounts={accounts}
        onAddAccount={() => setShowConnect(true)}
        onSync={syncAll}
        onInvite={() => setShowInvite(true)}
        onCanned={() => setShowCanned(true)}
        onLogout={onLogout}
      />

      {view === 'mail' && (
        <>
          <ThreadList
            threads={threads}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
          <ThreadView
            threadId={selectedId}
            me={me.user}
            team={team}
            accounts={accounts}
            onChanged={loadThreads}
          />
        </>
      )}

      {view === 'chat' && (
        <div className="chat-wrap">
          <ChatView me={me.user} team={team} />
        </div>
      )}

      {showConnect && (
        <ConnectAccount
          onClose={() => setShowConnect(false)}
          onCreated={() => { setShowConnect(false); loadAccounts(); }}
        />
      )}
      {showInvite && <InviteModal onClose={() => setShowInvite(false)} />}
      {showCanned && <CannedModal onClose={() => setShowCanned(false)} />}
    </div>
  );
}
