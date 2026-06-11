import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import DOMPurify from 'dompurify';
import { Star, Mail, Moon, Tag, Reply, Forward, Paperclip, Clock } from 'lucide-react';
import { api, getApiBase } from '../api';
import { getSocket } from '../socket';
import ComposeReply from './ComposeReply.jsx';
import Comments from './Comments.jsx';
import Avatar from './Avatar.jsx';

function fmtFull(ts) { return new Date(Number(ts)).toLocaleString(); }

// Sanitize for iframe rendering. We KEEP style attributes (emails depend on
// them for layout) and KEEP <style> blocks — the iframe sandbox is the real
// isolation boundary, not DOMPurify. We still strip scripts, forms, and
// inline event handlers as defense-in-depth.
function sanitizeForIframe(html) {
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'meta', 'link'],
    FORBID_ATTR: ['onerror', 'onclick', 'onload', 'onmouseover', 'onfocus', 'onblur', 'onsubmit'],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|cid):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i
  });
}

// Gmail-style quote collapsing. Email clients append the entire prior thread
// to every reply (Gmail blockquotes, Outlook "From:/Sent:" header blocks, etc).
// Rendering that verbatim makes a thread repeat itself and look jumbled. Like
// Gmail, we keep the full body but detect where the quoted history begins and
// hide everything from there behind a "•••" toggle, so each message shows only
// its new content by default. Operates on the already-sanitized HTML string and
// returns { html, hasQuote }. Any parse failure falls back to the input
// untouched so an edge case can never blank out a message.
const QUOTE_TEXT_RE = /^\s*(On .+ wrote:|From:\s.+Sent:\s.+|-{2,}\s*Original Message\s*-{2,})/is;

function collapseQuotedHistory(safeHtml) {
  try {
    const doc = new DOMParser().parseFromString(safeHtml, 'text/html');
    const body = doc.body;
    if (!body) return { html: safeHtml, hasQuote: false };

    // Find the earliest boundary node in document order, preferring structural
    // markers (reliable) over text heuristics (last resort).
    let boundary =
      doc.querySelector('blockquote.gmail_quote, div.gmail_quote') ||
      doc.querySelector('blockquote[type="cite"]') ||
      doc.querySelector('#divRplyFwdMsg, #appendonsend');

    // Outlook divider: a border-top div immediately followed by a "From:" block.
    if (!boundary) {
      for (const div of doc.querySelectorAll('div[style*="border-top"]')) {
        if (/From:/i.test(div.textContent || '') || /From:/i.test(div.nextElementSibling?.textContent || '')) {
          boundary = div;
          break;
        }
      }
    }

    // Generic top-level blockquote (Apple Mail and others).
    if (!boundary) boundary = body.querySelector(':scope > blockquote');

    // Text fallback: first block-level child whose text opens a quoted header.
    if (!boundary) {
      for (const el of body.children) {
        if (QUOTE_TEXT_RE.test(el.textContent || '')) { boundary = el; break; }
      }
    }

    if (!boundary) return { html: safeHtml, hasQuote: false };

    // Walk up to the boundary's body-level ancestor so we collapse it together
    // with all following siblings (the rest of the quoted thread).
    let top = boundary;
    while (top.parentNode && top.parentNode !== body) top = top.parentNode;
    if (top.parentNode !== body) return { html: safeHtml, hasQuote: false };

    // False-positive guard: only collapse if there is real content BEFORE the
    // boundary. A genuine reply always has new text above the quote; if the
    // quote is the very first content, the "quote" is the whole message (e.g. a
    // bare forward or an over-eager text match) — show it all rather than hiding
    // an entire legitimate email behind a tiny toggle.
    let hasPreceding = false;
    for (let n = top.previousSibling; n; n = n.previousSibling) {
      if (n.nodeType === 1 || (n.nodeType === 3 && (n.textContent || '').trim())) { hasPreceding = true; break; }
    }
    if (!hasPreceding) return { html: safeHtml, hasQuote: false };

    // Wrap the boundary + everything after it in a native <details> disclosure.
    // This is intentionally script-free: the message iframe is sandboxed WITHOUT
    // allow-scripts, so no injected JS would run. <details>/<summary> toggles
    // natively in that sandbox. Closed by default → only the "•••" summary shows.
    const details = doc.createElement('details');
    details.className = 'dd-quote';
    const summary = doc.createElement('summary');
    summary.className = 'dd-quote-toggle';
    summary.textContent = '•••';
    details.appendChild(summary);
    body.insertBefore(details, top);
    while (details.nextSibling) details.appendChild(details.nextSibling);

    return { html: body.innerHTML, hasQuote: true };
  } catch {
    return { html: safeHtml, hasQuote: false };
  }
}

// Wrap the sanitized HTML into a complete document so the iframe renders it
// with our base styles. <base target="_blank"> makes every link open in a
// new tab, which is what email clients do.
function buildEmailDoc(rawHtml) {
  const { html: safe } = collapseQuotedHistory(sanitizeForIframe(rawHtml || ''));
  return `<!doctype html><html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<base target="_blank">
<style>
  body { margin: 0; padding: 12px 14px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 14px; line-height: 1.55; color: #101828; word-wrap: break-word; }
  img { max-width: 100% !important; height: auto !important; }
  table { max-width: 100% !important; }
  a { color: #2f6feb; }
  pre, code { white-space: pre-wrap; word-break: break-word; }
  blockquote { border-left: 3px solid #d0d7de; padding-left: 10px; color: #59636e; margin: 8px 0; }
  details.dd-quote { margin: 6px 0; }
  summary.dd-quote-toggle { display: inline-block; width: fit-content; margin: 2px 0; padding: 2px 10px; line-height: 1; font-size: 14px; letter-spacing: 1px; color: #59636e; background: #eef1f4; border: 1px solid #d0d7de; border-radius: 12px; cursor: pointer; list-style: none; user-select: none; }
  summary.dd-quote-toggle::-webkit-details-marker { display: none; }
  summary.dd-quote-toggle::marker { content: ''; }
  summary.dd-quote-toggle:hover { background: #e3e7ec; }
</style>
</head><body>${safe}</body></html>`;
}

function fmtSize(b) {
  if (!b) return '';
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return Math.round(b / 1024) + ' KB';
  return (b / (1024 * 1024)).toFixed(1) + ' MB';
}

function nameFromAddr(s) {
  if (!s) return '';
  const a = s.indexOf('<');
  return (a > 0 ? s.slice(0, a) : s).trim().replace(/"/g, '');
}

// One-line preview for a collapsed message stub, from the stored plaintext body.
function msgSnippet(m) {
  const t = (m.body_text || '').replace(/\s+/g, ' ').trim();
  return t.length > 140 ? t.slice(0, 140) + '…' : t;
}

function escapeAttr(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const SNOOZE_PRESETS = [
  { label: 'In 1 hour', ms: 60 * 60 * 1000 },
  { label: 'In 4 hours', ms: 4 * 60 * 60 * 1000 },
  { label: 'Tomorrow 9 AM', fn: () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d.getTime() - Date.now(); } },
  { label: 'Next Monday 9 AM', fn: () => { const d = new Date(); const days = (8 - d.getDay()) % 7 || 7; d.setDate(d.getDate() + days); d.setHours(9, 0, 0, 0); return d.getTime() - Date.now(); } }
];

export default function ThreadView({ threadId, me, team, accounts, onChanged, onForward }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [showReply, setShowReply] = useState(false);
  const [showSnooze, setShowSnooze] = useState(false);
  const [showLabel, setShowLabel] = useState(false);
  const [allLabels, setAllLabels] = useState([]);

  // Gmail-style thread collapse: a thread can hold many messages, and rendering
  // every one fully expanded turns it into a wall of email. Instead we show only
  // the latest message expanded and collapse the rest into one-line header stubs
  // the user can click open. `expandedIds` is the set of message ids shown
  // expanded; `null` means "not initialised yet — default to the latest".
  const [expandedIds, setExpandedIds] = useState(null);
  const toggleMsg = useCallback((id, lastId) => {
    setExpandedIds(prev => {
      // Seed from the default (latest expanded) the first time, so collapsing the
      // latest message works even before the init effect has run.
      const next = new Set(prev || (lastId != null ? [lastId] : []));
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  // Messages render oldest-first (sent_at ASC), so the newest reply sits at the
  // bottom of a potentially very long thread. Open scrolled to it — mirrors the
  // chat pane (see ChatView listRef) — instead of dumping the user at the top of
  // a 40-message thread. `endRef` marks the end of the message list; `pinnedRef`
  // tracks whether we should keep snapping to the bottom (true until the user
  // scrolls up to read history, false again once they return to the bottom).
  const endRef = useRef(null);
  const pinnedRef = useRef(true);
  // Coalesces the burst of resize callbacks (one per iframe) into a single
  // scroll, and remembers whether we've already landed on this thread once.
  const scrollTimerRef = useRef(0);
  const didInitialScrollRef = useRef(false);

  const scrollToLatest = useCallback(() => {
    if (!pinnedRef.current) return;
    // Email bodies are iframes that load and resize at staggered times. Each
    // resize calls in here; scrolling on every one makes the viewport visibly
    // hop as the thread's total height settles ("the shake"). Instead we debounce:
    // each call pushes the scroll back, so it fires exactly once — after the
    // resizes go quiet, i.e. after the content has actually finished rendering.
    if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
    scrollTimerRef.current = setTimeout(() => {
      scrollTimerRef.current = 0;
      if (!pinnedRef.current || !endRef.current) return;
      // First landing for a thread is instant (open directly at the newest
      // message); later updates — a reply arriving while we watch — animate.
      endRef.current.scrollIntoView({
        block: 'end',
        behavior: didInitialScrollRef.current ? 'smooth' : 'auto'
      });
      didInitialScrollRef.current = true;
    }, 120);
  }, []);

  function onScroll(e) {
    // Only ever RE-PIN here, when the user is back at the bottom. We must not
    // unpin from 'scroll': email bodies live in iframes that resize after load,
    // and both those programmatic scrolls and Chromium's scroll-anchoring fire
    // 'scroll' with the position briefly away from the bottom. Treating that as
    // "user left the bottom" was disabling auto-follow before the newest message
    // finished rendering — i.e. it looked like the scroll never happened.
    // Unpinning is driven by an explicit user gesture instead (onWheel).
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) pinnedRef.current = true;
  }

  function onWheel(e) {
    // Explicit scroll-up = "let me read the history" — stop auto-following.
    if (e.deltaY < 0) pinnedRef.current = false;
  }

  const load = useCallback(async () => {
    if (!threadId) { setData(null); return; }
    setLoading(true);
    try {
      const r = await api(`/api/threads/${threadId}`);
      setData(r);
    } finally { setLoading(false); }
  }, [threadId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    api('/api/labels').then(r => setAllLabels(r.labels || [])).catch(() => {});
  }, []);

  // Opening a different thread should land on its newest message again —
  // instantly, not with a smooth animation across the previous thread's content.
  useEffect(() => {
    pinnedRef.current = true;
    didInitialScrollRef.current = false;
    return () => { if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current); };
  }, [threadId]);

  // Snap to the latest message once a thread's messages render. Iframe bodies
  // resize afterwards (see MessageBlock autoResize -> onResize), which re-runs
  // this while still pinned so we stay at the bottom as the layout settles.
  useEffect(() => { scrollToLatest(); }, [data, scrollToLatest]);

  // Default the collapse state to "latest message expanded, rest collapsed"
  // whenever the thread switches or a new message arrives. We key on the message
  // id list (not the whole `data` object) so unrelated reloads — starring,
  // labelling, status changes, all of which re-fetch — DON'T discard the user's
  // manual expand/collapse choices.
  const msgSigRef = useRef('');
  useEffect(() => {
    const msgs = (data && data.messages) || [];
    const sig = threadId + ':' + msgs.map(m => m.id).join(',');
    if (sig === msgSigRef.current) return;
    msgSigRef.current = sig;
    setExpandedIds(msgs.length ? new Set([msgs[msgs.length - 1].id]) : null);
  }, [threadId, data]);

  useEffect(() => {
    if (!threadId) return;
    const s = getSocket();
    const onAny = (p) => { if (p && p.thread_id === threadId) load(); };
    s.on('message:new', onAny);
    s.on('comment:new', onAny);
    s.on('thread:updated', onAny);
    return () => {
      s.off('message:new', onAny);
      s.off('comment:new', onAny);
      s.off('thread:updated', onAny);
    };
  }, [threadId, load]);

  async function setStatus(status) {
    await api(`/api/threads/${threadId}`, { method: 'PATCH', body: JSON.stringify({ status }) });
    onChanged && onChanged(); load();
  }
  async function setAssignee(id) {
    await api(`/api/threads/${threadId}`, { method: 'PATCH', body: JSON.stringify({ assignee_id: id || null }) });
    onChanged && onChanged(); load();
  }
  async function snooze(ms) {
    await api(`/api/threads/${threadId}`, { method: 'PATCH', body: JSON.stringify({ snoozed_until: Date.now() + ms }) });
    setShowSnooze(false);
    onChanged && onChanged(); load();
  }
  async function unsnooze() {
    await api(`/api/threads/${threadId}`, { method: 'PATCH', body: JSON.stringify({ snoozed_until: null }) });
    onChanged && onChanged(); load();
  }
  async function toggleLabel(label, currently) {
    if (currently) {
      await api('/api/labels/remove', { method: 'POST', body: JSON.stringify({ thread_id: threadId, label_id: label.id }) });
    } else {
      await api('/api/labels/apply', { method: 'POST', body: JSON.stringify({ thread_id: threadId, label_id: label.id }) });
    }
    onChanged && onChanged(); load();
  }
  async function toggleStar() {
    if (!data || !data.thread) return;
    await api(`/api/threads/${threadId}`, {
      method: 'PATCH',
      body: JSON.stringify({ starred: !data.thread.starred })
    });
    onChanged && onChanged(); load();
  }
  function forwardLast() {
    if (!data || !data.messages || !data.messages.length) return;
    const last = data.messages[data.messages.length - 1];
    onForward && onForward({
      subject: 'Fwd: ' + (data.thread.subject || '').replace(/^fwd:\s*/i, ''),
      bodyHtml:
        `<br/><br/>---------- Forwarded message ----------<br/>` +
        `<b>From:</b> ${escapeAttr(last.from_addr || '')}<br/>` +
        `<b>Date:</b> ${new Date(Number(last.sent_at)).toLocaleString()}<br/>` +
        `<b>Subject:</b> ${escapeAttr(last.subject || '')}<br/>` +
        `<b>To:</b> ${escapeAttr(last.to_addrs || '')}<br/><br/>` +
        (last.body_html || (last.body_text || '').replace(/\n/g, '<br/>')),
      accountId: last.account_id || undefined
    });
  }

  if (!threadId) return (
    <div className="thread-view empty">
      <div className="empty-illust">📬</div>
      <div>Select a conversation</div>
    </div>
  );
  if (loading || !data) return <div className="thread-view"><div className="loading">Loading…</div></div>;

  const { thread, messages, comments } = data;
  const isSnoozed = thread.snoozed_until && Number(thread.snoozed_until) > Date.now();
  const labelIds = new Set((thread.labels || []).map(l => l.id));

  return (
    <div className="thread-view" onScroll={onScroll} onWheel={onWheel}>
      <div className="tv-header">
        <div className="tv-header-top">
          <button
            className={'star-btn-lg ' + (thread.starred ? 'on' : '')}
            onClick={toggleStar}
            title={thread.starred ? 'Unstar' : 'Star'}
          ><Star size={20} fill={thread.starred ? 'currentColor' : 'none'} strokeWidth={2} /></button>
          <div className="tv-header-main">
            <div className="tv-subject">{thread.subject || '(no subject)'}</div>
            <div className="muted small tv-participants">{thread.participants}</div>
          </div>
          <button className="ghost icon-text" onClick={forwardLast} title="Forward last message">
            <Forward size={14} /> Forward
          </button>
          <button className="tv-reply-btn icon-text" onClick={() => setShowReply(s => !s)}>
            <Reply size={14} /> Reply
          </button>
        </div>

        {((thread.account_emails && thread.account_emails.length > 0) ||
          (thread.labels && thread.labels.length > 0) || isSnoozed) && (
          <div className="tv-meta-row">
            {(thread.account_emails || []).map(a => {
              const email = typeof a === 'string' ? a : a.email;
              const name = typeof a === 'string' ? null : a.name;
              return (
                <span key={email} className="account-chip" title={email}>
                  <Mail size={11} strokeWidth={2.2} />
                  {name ? `${name} (${email})` : email}
                </span>
              );
            })}
            {(thread.labels || []).map(l => (
              <span key={l.id} className="label-chip" style={{ background: l.color }}>{l.name}</span>
            ))}
            {isSnoozed && (
              <span className="badge badge-snoozed">
                <Moon size={10} /> Snoozed until {new Date(Number(thread.snoozed_until)).toLocaleString()}
                <button className="link" onClick={unsnooze} style={{ marginLeft: 6 }}>unsnooze</button>
              </span>
            )}
          </div>
        )}

        <div className="tv-actions-row">
          <select value={thread.status} onChange={e => setStatus(e.target.value)} className={'status-select status-' + thread.status}>
            <option value="open">Open</option>
            <option value="pending">Pending</option>
            <option value="closed">Closed</option>
          </select>
          <select value={thread.assignee_id || ''} onChange={e => setAssignee(e.target.value)}>
            <option value="">Unassigned</option>
            {team.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          <div className="action-pop-wrap">
            <button className="ghost icon-text" onClick={() => setShowLabel(s => !s)}>
              <Tag size={14} /> Label
            </button>
            {showLabel && (
              <div className="schedule-pop" onMouseLeave={() => setShowLabel(false)}>
                {allLabels.length === 0 && <div className="muted small pad-h">No labels yet — create some via "Labels" in the sidebar.</div>}
                {allLabels.map(l => (
                  <div key={l.id} className="schedule-opt" onClick={() => toggleLabel(l, labelIds.has(l.id))}>
                    <input type="checkbox" checked={labelIds.has(l.id)} readOnly />
                    <span className="label-chip" style={{ background: l.color }}>{l.name}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="action-pop-wrap">
            <button className="ghost icon-text" onClick={() => setShowSnooze(s => !s)}>
              <Moon size={14} /> Snooze
            </button>
            {showSnooze && (
              <div className="schedule-pop" onMouseLeave={() => setShowSnooze(false)}>
                {SNOOZE_PRESETS.map(p => (
                  <div key={p.label} className="schedule-opt" onClick={() => snooze(p.fn ? p.fn() : p.ms)}>
                    {p.label}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="tv-messages">
        {messages.map((m, i) => {
          const lastId = messages[messages.length - 1].id;
          // Before the init effect runs, expandedIds is null — fall back to
          // "latest only" so the newest message is open on first paint.
          const expanded = expandedIds ? expandedIds.has(m.id) : i === messages.length - 1;
          return (
            <MessageBlock
              key={m.id}
              m={m}
              expanded={expanded}
              onToggle={() => toggleMsg(m.id, lastId)}
              onResize={scrollToLatest}
            />
          );
        })}
      </div>
      {/* Anchor for scroll-to-latest — sits just below the newest message. */}
      <div ref={endRef} />

      {showReply && (
        <ComposeReply
          threadId={threadId}
          accounts={accounts}
          defaultTo={messages.length ? messages[messages.length - 1].from_addr : ''}
          defaultCc={messages.length ? messages[messages.length - 1].cc_addrs : ''}
          onSent={() => { setShowReply(false); load(); onChanged && onChanged(); }}
          onCancel={() => setShowReply(false)}
        />
      )}

      <Comments
        threadId={threadId}
        comments={comments}
        team={team}
        me={me}
        onAdded={load}
      />
    </div>
  );
}

function MessageBlock({ m, expanded, onToggle, onResize }) {
  const docHtml = useMemo(() => m.body_html ? buildEmailDoc(m.body_html) : null, [m.body_html]);
  const senderName = m.direction === 'outbound' ? (m.from_addr ? nameFromAddr(m.from_addr) : 'You') : nameFromAddr(m.from_addr) || 'Unknown';

  // Collapsed: a compact, clickable one-line stub (Gmail-style). The body iframe
  // is not mounted at all while collapsed, which also speeds up opening long
  // threads (only the expanded message renders an iframe).
  if (!expanded) {
    return (
      <div className={'msg-collapsed msg-' + m.direction} onClick={onToggle} title="Expand">
        <Avatar name={senderName} size={28} />
        <div className="msg-collapsed-main">
          <span className="msg-collapsed-from">{senderName}</span>
          <span className="msg-collapsed-snippet">{msgSnippet(m)}</span>
        </div>
        {m.attachments && m.attachments.length > 0 && (
          <Paperclip size={13} className="msg-collapsed-clip" />
        )}
        <span className="msg-collapsed-date">{fmtFull(m.sent_at)}</span>
      </div>
    );
  }

  function autoResize(e) {
    const iframe = e.target;
    function fit() {
      try {
        const doc = iframe.contentDocument;
        if (doc && doc.body) {
          const h = Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight);
          iframe.style.height = Math.min(h + 24, 1500) + 'px';
        }
      } catch {
        // Cross-origin — sandbox without allow-same-origin. Use a safe default.
        iframe.style.height = '500px';
      }
      // The body just changed height; let the thread re-snap to the latest
      // message if it's still pinned to the bottom.
      if (onResize) onResize();
    }
    fit();
    // The quoted-history "•••" disclosure is a script-free <details> (the iframe
    // sandbox has no allow-scripts). Expanding it grows the content, so re-fit
    // the iframe height from here, the parent. `toggle` doesn't bubble, so we
    // listen in the capture phase. The listener dies with the iframe document.
    try { iframe.contentDocument.addEventListener('toggle', fit, true); } catch {}
  }

  return (
    <div className={'msg msg-' + m.direction}>
      <div className="msg-head" onClick={onToggle} style={{ cursor: 'pointer' }} title="Collapse">
        <Avatar name={senderName} size={36} />
        <div className="msg-head-main">
          <div><strong>{senderName}</strong> <span className="muted small">to {m.to_addrs}</span></div>
          <div className="muted xs">
            {fmtFull(m.sent_at)}
            {m.account_email && (
              <span className="account-chip" style={{ marginLeft: 6 }} title={m.account_email}>
                <Mail size={11} strokeWidth={2.2} />
                via {m.account_name || m.account_email}
              </span>
            )}
          </div>
        </div>
      </div>
      {docHtml
        ? (
          <iframe
            className="msg-iframe"
            sandbox="allow-popups allow-popups-to-escape-sandbox allow-same-origin"
            srcDoc={docHtml}
            onLoad={autoResize}
            title="Email content"
          />
        )
        : <pre className="msg-body">{m.body_text}</pre>}
      {m.attachments && m.attachments.length > 0 && (
        <div className="att-list">
          {m.attachments.map(a => (
            <a key={a.id}
              href={getApiBase() + `/api/attachments/${a.id}`}
              onClick={e => downloadAttachment(e, a)}
              className="att">
              <Paperclip size={12} /> <span>{a.filename}</span> <span className="muted xs">{fmtSize(a.size_bytes)}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

async function downloadAttachment(e, a) {
  e.preventDefault();
  try {
    const { getToken } = await import('../api');
    const token = getToken();
    const res = await fetch(getApiBase() + `/api/attachments/${a.id}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    });
    if (!res.ok) throw new Error('download failed');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = a.filename || 'attachment';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (err) {
    alert(err.message);
  }
}
