import React, { useEffect, useRef, useState } from 'react';
import { api, getToken, getApiBase } from '../api';
import RichEditor from './RichEditor.jsx';

function htmlToText(html) {
  const div = document.createElement('div');
  div.innerHTML = html || '';
  return div.innerText;
}

function isEmptyHtml(html) {
  return !htmlToText(html || '').trim();
}

export default function ComposeReply({ threadId, accounts, onSent, onCancel }) {
  const [accountId, setAccountId] = useState(accounts[0]?.id || '');
  const [html, setHtml] = useState('');
  const [files, setFiles] = useState([]);
  const [canned, setCanned] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [savedAt, setSavedAt] = useState(null);
  const [savingState, setSavingState] = useState('idle');  // idle | saving | saved
  const fileInput = useRef(null);
  const loadedRef = useRef(false);

  // Pick a default account once accounts load.
  useEffect(() => {
    if (!accountId && accounts[0]) setAccountId(accounts[0].id);
  }, [accounts, accountId]);

  // Load canned responses.
  useEffect(() => {
    api('/api/canned').then(r => setCanned(r.canned || [])).catch(() => {});
  }, []);

  // Load existing draft for this thread once.
  useEffect(() => {
    if (!threadId) return;
    loadedRef.current = false;
    api(`/api/drafts/${threadId}`).then(r => {
      if (r && r.draft) {
        if (r.draft.body_html) setHtml(r.draft.body_html);
        if (r.draft.account_id) setAccountId(r.draft.account_id);
        if (r.draft.updated_at) setSavedAt(Number(r.draft.updated_at));
      }
      loadedRef.current = true;
    }).catch(() => { loadedRef.current = true; });
  }, [threadId]);

  // Debounced autosave.
  useEffect(() => {
    if (!threadId || !loadedRef.current) return;
    if (isEmptyHtml(html)) return;
    setSavingState('saving');
    const t = setTimeout(async () => {
      try {
        const r = await api(`/api/drafts/${threadId}`, {
          method: 'PUT',
          body: JSON.stringify({
            account_id: accountId,
            body_text: htmlToText(html),
            body_html: html
          })
        });
        if (r && r.updated_at) setSavedAt(Number(r.updated_at));
        setSavingState('saved');
      } catch {
        setSavingState('idle');
      }
    }, 700);
    return () => clearTimeout(t);
  }, [html, accountId, threadId]);

  function addFiles(list) { setFiles(prev => [...prev, ...Array.from(list || [])]); }
  function removeFile(idx) { setFiles(prev => prev.filter((_, i) => i !== idx)); }
  function applyCanned(id) {
    if (!id) return;
    const c = canned.find(x => x.id === id);
    if (!c) return;
    setHtml(prev => (prev || '') + (c.body_html || c.body_text.replace(/\n/g, '<br/>')));
  }

  async function send() {
    if (!accountId) { setErr('Connect an email account first'); return; }
    setBusy(true); setErr('');
    try {
      const text = htmlToText(html);
      const fd = new FormData();
      fd.append('payload', JSON.stringify({
        account_id: accountId,
        body_text: text,
        body_html: html
      }));
      for (const f of files) fd.append('files', f);

      const token = getToken();
      const res = await fetch(getApiBase() + `/api/threads/${threadId}/reply`, {
        method: 'POST',
        body: fd,
        headers: token ? { Authorization: `Bearer ${token}` } : {}
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'send failed');

      setHtml(''); setFiles([]); setSavedAt(null); setSavingState('idle');
      onSent && onSent();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  async function discard() {
    if (!confirm('Discard draft?')) return;
    setHtml(''); setFiles([]); setSavedAt(null); setSavingState('idle');
    try { await api(`/api/drafts/${threadId}`, { method: 'DELETE' }); } catch {}
    onCancel && onCancel();
  }

  return (
    <div className="composer">
      <div className="composer-row">
        <label>From:</label>
        <select value={accountId} onChange={e => setAccountId(e.target.value)}>
          {accounts.length === 0 && <option value="">— no accounts —</option>}
          {accounts.map(a => <option key={a.id} value={a.id}>{a.email}</option>)}
        </select>
        {canned.length > 0 && (
          <select onChange={e => { applyCanned(e.target.value); e.target.value = ''; }} defaultValue="">
            <option value="">Insert canned…</option>
            {canned.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}
          </select>
        )}
        <div className="save-status">
          {savingState === 'saving' && <span className="muted small">Saving…</span>}
          {savingState === 'saved' && savedAt && (
            <span className="muted small">Saved {new Date(savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
          )}
        </div>
      </div>

      <RichEditor html={html} onChange={setHtml} onAttachFiles={addFiles} />

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

      <div className="composer-actions">
        <button type="button" className="ghost" onClick={() => fileInput.current.click()}>📎 Attach</button>
        <button type="button" className="ghost" onClick={discard}>Discard</button>
        <div className="spacer" />
        <button type="button" className="ghost" onClick={onCancel}>Close</button>
        <button type="button" onClick={send} disabled={busy || isEmptyHtml(html)}>
          {busy ? 'Sending…' : 'Send'}
        </button>
      </div>
      {err && <div className="err">{err}</div>}
    </div>
  );
}
