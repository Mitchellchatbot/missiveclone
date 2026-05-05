import React, { useRef } from 'react';
import { Search, X } from 'lucide-react';

export default function InboxSearchBar({ value, onChange, placeholder, scopeLabel }) {
  const inputRef = useRef(null);
  return (
    <div className="inline-search">
      <div className="search-input-wrap">
        <Search size={15} className="search-icon" />
        <input
          ref={inputRef}
          type="text"
          placeholder={placeholder || 'Search conversations…'}
          value={value}
          onChange={e => onChange(e.target.value)}
          autoComplete="off"
          spellCheck="false"
        />
        {value && (
          <button
            className="search-clear"
            onClick={() => { onChange(''); inputRef.current && inputRef.current.focus(); }}
            title="Clear search"
            aria-label="Clear search"
          >
            <X size={13} />
          </button>
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
