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

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Gmail-style attribution date, e.g. "Jun 12, 2026 at 3:10 AM" — short month,
// no seconds, " at " between date and time. Mirrors what Gmail writes in the
// "On … wrote:" line so replies read identically to a native Gmail reply.
function formatQuoteDate(d) {
  const date = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${date} at ${time}`;
}

// Build a Gmail-standard quoted block for the message being replied to, so the
// reply carries the context of what it answers. The markup matches Gmail's own:
// an outer div.gmail_quote, a div.gmail_attr attribution line, and a
// blockquote.gmail_quote with Gmail's exact inline style. ThreadView's
// collapseQuotedHistory detects the div.gmail_quote boundary, so the sent reply
// renders with the quote tucked behind a "•••" toggle; recipients in Gmail get
// the same "show trimmed content" collapse.
function buildReplyQuoteHtml(m) {
  if (!m) return '';
  const when = m.sent_at ? formatQuoteDate(new Date(Number(m.sent_at))) : '';
  const who = escapeHtml(m.from_addr || '');
  const inner = m.body_html || escapeHtml(m.body_text || '').replace(/\n/g, '<br/>');
  return `<br/><br/><div class="gmail_quote">` +
    `<div dir="ltr" class="gmail_attr">On ${escapeHtml(when)} ${who} wrote:<br></div>` +
    `<blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px #ccc solid;padding-left:1ex">${inner}</blockquote>` +
    `</div>`;
}

export default function ComposeReply({ threadId, accounts, defaultTo, defaultCc, replyTarget, quoteSource, onClearReplyTarget, onSent, onCancel }) {
  const [accountId, setAccountId] = useState(accounts[0]?.id || '');
  const [to, setTo] = useState(defaultTo || '');
  const [cc, setCc] = useState(defaultCc || '');
  // RFC Message-ID of the message we're replying to, when the user pinned a
  // specific one via its per-message Reply button. null = thread under the
  // latest message (server default).
  const [inReplyTo, setInReplyTo] = useState(null);
  const [html, setHtml] = useState('');
  const [files, setFiles] = useState([]);
  const [canned, setCanned] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [savedAt, setSavedAt] = useState(null);
  const [savingState, setSavingState] = useState('idle');  // idle | saving | saved
  const fileInput = useRef(null);
  const loadedRef = useRef(false);
  // Mirror of `html` read by the quote effect without re-running it on every
  // keystroke; `autoQuoteRef` holds the exact quote block we last auto-inserted
  // so we can tell "untouched auto-quote" (safe to replace) from real edits.
  const htmlRef = useRef('');
  const autoQuoteRef = useRef('');
  useEffect(() => { htmlRef.current = html; });

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
        if (r.draft.to_addrs) setTo(r.draft.to_addrs);
        if (r.draft.cc_addrs) setCc(r.draft.cc_addrs);
        if (r.draft.updated_at) setSavedAt(Number(r.draft.updated_at));
      }
      loadedRef.current = true;
    }).catch(() => { loadedRef.current = true; });
  }, [threadId]);

  // When the user clicks "Reply" on a specific message, pre-fill the To field
  // from THAT message and pin threading to it — without touching the body they
  // may already have typed. Keyed on the target's id so it only fires when a
  // different message is picked.
  useEffect(() => {
    if (!replyTarget) return;
    // Outbound = a message we sent; replying should go back to its original
    // recipients, not to ourselves.
    setTo(replyTarget.direction === 'outbound' ? (replyTarget.to_addrs || '') : (replyTarget.from_addr || ''));
    setCc('');
    setInReplyTo(replyTarget.message_id || null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replyTarget?.id]);

  // Pre-fill the editor with a quote of the message being replied to (the
  // pinned target, or the latest message for a thread-level reply). Keyed on
  // the quote source's id so switching targets swaps the quote — but only while
  // the body is still empty or holds nothing but our prior auto-quote, so a
  // loaded draft or text the user has typed is never clobbered.
  useEffect(() => {
    if (!quoteSource) return;
    const q = buildReplyQuoteHtml(quoteSource);
    if (isEmptyHtml(htmlRef.current) || htmlRef.current === autoQuoteRef.current) {
      setHtml(q);
      autoQuoteRef.current = q;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quoteSource?.id]);

  // Debounced autosave.
  useEffect(() => {
    if (!threadId || !loadedRef.current) return;
    if (isEmptyHtml(html)) return;
    // Body is nothing but the auto-inserted quote (the user hasn't written
    // anything yet) — don't persist a quote-only draft. Keeps opening/retargeting
    // a reply from littering the Drafts folder; we save once real text is added.
    if (html === autoQuoteRef.current) return;
    setSavingState('saving');
    const t = setTimeout(async () => {
      try {
        const r = await api(`/api/drafts/${threadId}`, {
          method: 'PUT',
          body: JSON.stringify({
            account_id: accountId,
            body_text: htmlToText(html),
            body_html: html,
            to_addrs: to,
            cc_addrs: cc
          })
        });
        if (r && r.updated_at) setSavedAt(Number(r.updated_at));
        setSavingState('saved');
      } catch {
        setSavingState('idle');
      }
    }, 700);
    return () => clearTimeout(t);
  }, [html, accountId, threadId, to, cc]);

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
        to,
        cc,
        body_text: text,
        body_html: html,
        in_reply_to: inReplyTo || null
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

      setHtml(''); setFiles([]); setTo(''); setCc(''); setInReplyTo(null); setSavedAt(null); setSavingState('idle');
      autoQuoteRef.current = '';
      onSent && onSent();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  async function discard() {
    if (!confirm('Discard draft?')) return;
    setHtml(''); setFiles([]); setTo(''); setCc(''); setInReplyTo(null); setSavedAt(null); setSavingState('idle');
    autoQuoteRef.current = '';
    try { await api(`/api/drafts/${threadId}`, { method: 'DELETE' }); } catch {}
    onCancel && onCancel();
  }

  return (
    <div className="composer">
      {replyTarget && (
        <div className="composer-row">
          <span className="muted small">
            Replying to {replyTarget.direction === 'outbound' ? (replyTarget.to_addrs || 'recipients') : (replyTarget.from_addr || 'this message')}
          </span>
          <button
            type="button"
            className="link"
            onClick={() => { setTo(defaultTo || ''); setCc(defaultCc || ''); setInReplyTo(null); onClearReplyTarget && onClearReplyTarget(); }}
          >
            reply to latest instead
          </button>
        </div>
      )}
      {replyTarget && !replyTarget.message_id && (
        <div className="composer-row">
          <span className="muted small" style={{ fontStyle: 'italic' }}>
            Can't thread this one precisely — your reply still quotes it and posts to the thread.
          </span>
        </div>
      )}
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

      <div className="composer-row">
        <label>To:</label>
        <input value={to} onChange={e => setTo(e.target.value)} placeholder="recipient@example.com" />
      </div>
      <div className="composer-row">
        <label>Cc:</label>
        <input value={cc} onChange={e => setCc(e.target.value)} placeholder="optional" />
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
