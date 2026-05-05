import React, { useEffect, useRef, useState } from 'react';
import { Search, X, Clock, Trash2 } from 'lucide-react';

const RECENTS_KEY = 'missive_clone_recent_searches';
const MAX_RECENTS = 8;

const OPERATORS = [
  { token: 'from:',           label: 'from:',           hint: 'sender' },
  { token: 'to:',             label: 'to:',             hint: 'recipient' },
  { token: 'subject:',        label: 'subject:',        hint: 'subject contains' },
  { token: 'has:attachment',  label: 'has:attachment',  hint: 'has files' },
  { token: 'is:starred',      label: 'is:starred',      hint: 'starred' },
  { token: 'is:snoozed',      label: 'is:snoozed',      hint: 'snoozed' },
  { token: 'is:open',         label: 'is:open',         hint: 'open status' },
  { token: 'is:closed',       label: 'is:closed',       hint: 'closed status' },
  { token: 'is:pending',      label: 'is:pending',      hint: 'pending status' },
  { token: 'label:',          label: 'label:',          hint: 'has label' },
  { token: 'after:',          label: 'after:',          hint: 'YYYY-MM-DD' },
  { token: 'before:',         label: 'before:',         hint: 'YYYY-MM-DD' }
];

function readRecents() {
  try { return JSON.parse(localStorage.getItem(RECENTS_KEY) || '[]'); }
  catch { return []; }
}
function writeRecents(arr) {
  localStorage.setItem(RECENTS_KEY, JSON.stringify(arr));
}

export default function InboxSearchBar({ value, onChange, placeholder, scopeLabel }) {
  const inputRef = useRef(null);
  const wrapRef = useRef(null);
  const [recents, setRecents] = useState(readRecents);
  const [open, setOpen] = useState(false);

  // Close dropdown on outside click.
  useEffect(() => {
    function onDoc(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  function commit(q) {
    const clean = (q || '').trim();
    if (!clean || clean.length < 2) return;
    const next = [clean, ...recents.filter(r => r !== clean)].slice(0, MAX_RECENTS);
    setRecents(next);
    writeRecents(next);
  }

  function chooseRecent(q) {
    onChange(q);
    setOpen(false);
    inputRef.current && inputRef.current.blur();
  }
  function removeRecent(q, e) {
    e.stopPropagation();
    const next = recents.filter(r => r !== q);
    setRecents(next);
    writeRecents(next);
  }
  function clearAllRecents() {
    setRecents([]);
    writeRecents([]);
  }

  function appendOperator(token) {
    const cur = value || '';
    const sep = cur && !cur.endsWith(' ') ? ' ' : '';
    const next = cur + sep + token;
    onChange(next);
    setOpen(true);
    setTimeout(() => {
      const inp = inputRef.current;
      if (inp) {
        inp.focus();
        inp.setSelectionRange(next.length, next.length);
      }
    }, 0);
  }

  function onKey(e) {
    if (e.key === 'Enter') {
      commit(value);
      setOpen(false);
      e.target.blur();
    } else if (e.key === 'Escape') {
      setOpen(false);
      e.target.blur();
    }
  }

  // Filter recent suggestions to those matching the current input prefix.
  const v = (value || '').trim().toLowerCase();
  const matchingRecents = v
    ? recents.filter(r => r.toLowerCase().includes(v) && r.toLowerCase() !== v)
    : recents;

  return (
    <div className="inline-search" ref={wrapRef}>
      <div className="search-input-wrap">
        <Search size={15} className="search-icon" />
        <input
          ref={inputRef}
          type="text"
          placeholder={placeholder || 'Search conversations…'}
          value={value}
          onChange={e => onChange(e.target.value)}
          onFocus={() => setOpen(true)}
          onKeyDown={onKey}
          autoComplete="off"
          spellCheck="false"
        />
        {value && (
          <button
            className="search-clear"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => { onChange(''); inputRef.current && inputRef.current.focus(); }}
            title="Clear search"
            aria-label="Clear search"
          >
            <X size={13} />
          </button>
        )}

        {open && (
          <div className="search-suggest" onMouseDown={(e) => e.preventDefault()}>
            {matchingRecents.length > 0 && (
              <>
                <div className="suggest-header">
                  <span>Recent</span>
                  <button className="link" onClick={clearAllRecents}>Clear</button>
                </div>
                {matchingRecents.slice(0, 5).map(r => (
                  <div key={r} className="suggest-item recent-item" onClick={() => chooseRecent(r)}>
                    <Clock size={12} className="muted" />
                    <span className="recent-q">{r}</span>
                    <button
                      className="suggest-x"
                      onClick={(e) => removeRecent(r, e)}
                      title="Remove from recents"
                    ><Trash2 size={11} /></button>
                  </div>
                ))}
              </>
            )}
            <div className="suggest-header">
              <span>Search operators</span>
              <span className="muted xs">click to insert</span>
            </div>
            <div className="suggest-ops">
              {OPERATORS.map(op => (
                <button
                  key={op.token}
                  className="suggest-op"
                  onClick={() => appendOperator(op.token)}
                  title={op.hint}
                >
                  <span className="op-token">{op.label}</span>
                  <span className="op-hint">{op.hint}</span>
                </button>
              ))}
            </div>
            <div className="suggest-foot muted xs">
              Try: <code>from:gabby has:attachment</code> · <code>label:VIP after:2026-01-01</code>
            </div>
          </div>
        )}
      </div>
      {scopeLabel && (
        <div className="search-scope">
          <span>in</span>
          <strong>{scopeLabel}</strong>
        </div>
      )}
    </div>
  );
}
