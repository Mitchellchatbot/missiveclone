import React, { useEffect, useRef, useState } from 'react';
import { getToken, getApiBase } from '../api';
import RichEditor from './RichEditor.jsx';

function htmlToText(html) {
  const div = document.createElement('div');
  div.innerHTML = html || '';
  return div.innerText;
}

function presetTimes() {
  const now = new Date();
  const t1 = new Date(now); t1.setHours(t1.getHours() + 1);
  const t2 = new Date(now); t2.setHours(t2.getHours() + 4);
  const tomorrow9 = new Date(now);
  tomorrow9.setDate(tomorrow9.getDate() + 1);
  tomorrow9.setHours(9, 0, 0, 0);
  const monday9 = new Date(now);
  const days = (8 - monday9.getDay()) % 7 || 7;
  monday9.setDate(monday9.getDate() + days);
  monday9.setHours(9, 0, 0, 0);
  return [
    { label: 'In 1 hour', ts: t1.getTime() },
    { label: 'In 4 hours', ts: t2.getTime() },
    { label: 'Tomorrow 9 AM', ts: tomorrow9.getTime() },
    { label: 'Next Monday 9 AM', ts: monday9.getTime() }
  ];
}

export default function ComposeNew({ accounts, defaultAccountId, initial, onClose, onSent }) {
  const [accountId, setAccountId] = useState(
    (initial && initial.accountId) || defaultAccountId || accounts[0]?.id || ''
  );
  const [to, setTo] = useState((initial && initial.to) || '');
  const [cc, setCc] = useState((initial && initial.cc) || '');
  const [subject, setSubject] = useState((initial && initial.subject) || '');
  const [html, setHtml] = useState((initial && initial.bodyHtml) || '');
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [scheduleAt, setScheduleAt] = useState(null);
  const [showSchedule, setShowSchedule] = useState(false);
  const fileInput = useRef(null);

  function addFiles(list) { setFiles(p => [...p, ...Array.from(list || [])]); }
  function removeFile(i) { setFiles(p => p.filter((_, idx) => idx !== i)); }

  async function send(scheduledMs) {
    if (!accountId) { setErr('Pick an account'); return; }
    if (!to.trim() || !subject.trim()) { setErr('To and Subject required'); return; }
    setBusy(true); setErr('');
    try {
      const text = htmlToText(html);
      const fd = new FormData();
      fd.append('payload', JSON.stringify({
        account_id: accountId, to, cc, subject,
        body_text: text, body_html: html,
        send_at: scheduledMs || null
      }));
      if (!scheduledMs) {
        for (const f of files) fd.append('files', f);
      }
      const token = getToken();
      const res = await fetch(getApiBase() + '/api/compose', {
        method: 'POST', body: fd,
        headers: token ? { Authorization: `Bearer ${token}` } : {}
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'send failed');
      onSent && onSent(body);
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal compose-modal" onClick={e => e.stopPropagation()}>
        <h3>New email</h3>

        <div className="composer-row">
          <label>From:</label>
          <select value={accountId} onChange={e => setAccountId(e.target.value)}>
            {accounts.length === 0 && <option value="">— no accounts —</option>}
            {accounts.map(a => <option key={a.id} value={a.id}>{a.email}</option>)}
          </select>
        </div>

        <div className="composer-row">
          <label>To:</label>
          <input value={to} onChange={e => setTo(e.target.value)} placeholder="recipient@example.com" />
        </div>
        <div className="composer-row">
          <label>Cc:</label>
          <input value={cc} onChange={e => setCc(e.target.value)} placeholder="optional" />
        </div>
        <div className="composer-row">
          <label>Subject:</label>
          <input value={subject} onChange={e => setSubject(e.target.value)} required />
        </div>

        <RichEditor html={html} onChange={setHtml} onAttachFiles={addFiles} placeholder="Write your message…" />

        <input
          ref={fileInput}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={e => { addFiles(e.target.files); e.target.value = ''; }}
        />

        {files.length > 0 && (
          <div className="attached-list">
            {files.map((f, i) => (
              <div key={i} className="attached">
                <span>📎 {f.name}</span>
                <span className="muted small">({Math.round(f.size / 1024)} KB)</span>
                <button type="button" className="link" onClick={() => removeFile(i)}>remove</button>
              </div>
            ))}
          </div>
        )}

        {scheduleAt && (
          <div className="callout">Scheduled for <strong>{new Date(scheduleAt).toLocaleString()}</strong>
            <button className="link" style={{ marginLeft: 8 }} onClick={() => setScheduleAt(null)}>cancel</button>
          </div>
        )}

        <div className="composer-actions">
          <button type="button" className="ghost" onClick={() => fileInput.current.click()}>📎 Attach</button>
          <div style={{ position: 'relative' }}>
            <button type="button" className="ghost" onClick={() => setShowSchedule(s => !s)}>⏰ Schedule</button>
            {showSchedule && (
              <div className="schedule-pop" onMouseLeave={() => setShowSchedule(false)}>
                {presetTimes().map(p => (
                  <div key={p.label} className="schedule-opt"
                    onClick={() => { setScheduleAt(p.ts); setShowSchedule(false); }}>
                    {p.label}
                    <span className="muted small">{new Date(p.ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                  </div>
                ))}
                <div className="schedule-opt">
                  <input type="datetime-local"
                    onChange={e => {
                      if (e.target.value) {
                        setScheduleAt(new Date(e.target.value).getTime());
                        setShowSchedule(false);
                      }
                    }} />
                </div>
              </div>
            )}
          </div>
          <div className="spacer" />
          <button type="button" className="ghost" onClick={onClose}>Discard</button>
          {scheduleAt
            ? <button onClick={() => send(scheduleAt)} disabled={busy}>{busy ? '…' : 'Schedule'}</button>
            : <button onClick={() => send(null)} disabled={busy}>{busy ? 'Sending…' : 'Send'}</button>}
        </div>
        {err && <div className="err">{err}</div>}
      </div>
    </div>
  );
}
