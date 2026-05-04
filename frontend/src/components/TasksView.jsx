import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../api';
import { getSocket } from '../socket';
import Avatar from './Avatar.jsx';

function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(Number(ts));
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export default function TasksView({ me, team, teamSpaces, currentTeamSpace }) {
  const [tasks, setTasks] = useState([]);
  const [filter, setFilter] = useState('all');     // all | open | mine | done
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (filter === 'open') params.set('status', 'open');
    if (filter === 'done') params.set('status', 'done');
    if (filter === 'mine') params.set('assignee', 'me');
    if (currentTeamSpace) params.set('team_space_id', currentTeamSpace.id);
    const r = await api('/api/tasks?' + params.toString());
    setTasks(r.tasks || []);
  }, [filter, currentTeamSpace]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const s = getSocket();
    const on = () => load();
    s.on('task:updated', on);
    return () => s.off('task:updated', on);
  }, [load]);

  async function toggle(t) {
    const next = t.status === 'done' ? 'open' : 'done';
    await api(`/api/tasks/${t.id}`, { method: 'PATCH', body: JSON.stringify({ status: next }) });
    load();
  }

  return (
    <div className="tasks-pane">
      <div className="tv-header">
        <div className="tv-header-main">
          <div className="tv-subject">Tasks</div>
          <div className="muted small">
            {currentTeamSpace ? `in ${currentTeamSpace.name}` : 'Across all team spaces'}
          </div>
        </div>
        <div className="tv-controls">
          <select value={filter} onChange={e => setFilter(e.target.value)}>
            <option value="all">All</option>
            <option value="open">Open</option>
            <option value="mine">Assigned to me</option>
            <option value="done">Done</option>
          </select>
          <button onClick={() => setShowCreate(true)}>+ New task</button>
        </div>
      </div>

      <div className="tasks-list">
        {tasks.length === 0 && <div className="empty"><div className="empty-illust">✓</div><div>No tasks yet</div></div>}
        {tasks.map(t => (
          <div key={t.id} className={'task-row ' + (t.status === 'done' ? 'done' : '')}>
            <input type="checkbox" checked={t.status === 'done'} onChange={() => toggle(t)} />
            <div className="task-main">
              <div className="task-title">{t.title}</div>
              {t.description && <div className="muted small">{t.description}</div>}
              <div className="task-meta">
                {t.assignee_name && (
                  <span className="task-tag"><Avatar name={t.assignee_name} size={16} /> {t.assignee_name}</span>
                )}
                {t.due_at && <span className="task-tag">📅 {fmtDate(t.due_at)}</span>}
                <span className={'badge badge-' + (t.status === 'done' ? 'closed' : 'open')}>{t.status}</span>
              </div>
            </div>
          </div>
        ))}
      </div>

      {showCreate && (
        <NewTaskModal
          me={me} team={team}
          teamSpaces={teamSpaces}
          defaultTeamSpaceId={currentTeamSpace ? currentTeamSpace.id : null}
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); load(); }}
        />
      )}
    </div>
  );
}

function NewTaskModal({ team, teamSpaces, defaultTeamSpaceId, onClose, onCreated }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [assignee, setAssignee] = useState('');
  const [tsId, setTsId] = useState(defaultTeamSpaceId || (teamSpaces[0] && teamSpaces[0].id) || '');
  const [due, setDue] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    try {
      await api('/api/tasks', {
        method: 'POST',
        body: JSON.stringify({
          title, description, assignee_id: assignee || null,
          team_space_id: tsId || null,
          due_at: due ? new Date(due).getTime() : null
        })
      });
      onCreated();
    } finally { setBusy(false); }
  }

  return (
    <div className="modal-back" onClick={onClose}>
      <form className="modal" onClick={e => e.stopPropagation()} onSubmit={submit}>
        <h3>New task</h3>
        <input placeholder="What needs to happen?" value={title} onChange={e => setTitle(e.target.value)} required autoFocus />
        <textarea rows={3} placeholder="Notes (optional)" value={description} onChange={e => setDescription(e.target.value)} />
        <div className="row">
          <select value={assignee} onChange={e => setAssignee(e.target.value)}>
            <option value="">Unassigned</option>
            {team.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          <select value={tsId} onChange={e => setTsId(e.target.value)}>
            {teamSpaces.map(ts => <option key={ts.id} value={ts.id}>{ts.name}</option>)}
          </select>
          <input type="date" value={due} onChange={e => setDue(e.target.value)} />
        </div>
        <div className="row right">
          <button type="button" className="ghost" onClick={onClose}>Cancel</button>
          <button disabled={busy || !title.trim()}>{busy ? '…' : 'Create'}</button>
        </div>
      </form>
    </div>
  );
}
