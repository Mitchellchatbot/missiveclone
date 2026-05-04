import React, { useRef, useEffect } from 'react';

// Minimal contentEditable editor with a small format toolbar.
// Uses execCommand which is deprecated but still works in every modern
// browser; sufficient for an MVP composer.
export default function RichEditor({ html, onChange, placeholder }) {
  const ref = useRef(null);

  useEffect(() => {
    if (ref.current && ref.current.innerHTML !== (html || '')) {
      ref.current.innerHTML = html || '';
    }
  }, [html]);

  function exec(cmd, value) {
    document.execCommand(cmd, false, value);
    if (ref.current) onChange(ref.current.innerHTML);
  }

  function onInput() {
    if (ref.current) onChange(ref.current.innerHTML);
  }

  function makeLink() {
    const url = prompt('URL');
    if (url) exec('createLink', url);
  }

  return (
    <div className="rich-editor">
      <div className="rich-toolbar">
        <button type="button" onClick={() => exec('bold')} title="Bold (Ctrl+B)"><b>B</b></button>
        <button type="button" onClick={() => exec('italic')} title="Italic (Ctrl+I)"><i>I</i></button>
        <button type="button" onClick={() => exec('underline')} title="Underline"><u>U</u></button>
        <span className="sep" />
        <button type="button" onClick={() => exec('insertUnorderedList')} title="Bulleted list">• List</button>
        <button type="button" onClick={() => exec('insertOrderedList')} title="Numbered list">1. List</button>
        <span className="sep" />
        <button type="button" onClick={makeLink} title="Insert link">Link</button>
        <button type="button" onClick={() => exec('removeFormat')} title="Clear formatting">Clear</button>
      </div>
      <div
        ref={ref}
        className="rich-area"
        contentEditable
        onInput={onInput}
        data-placeholder={placeholder || 'Reply…'}
      />
    </div>
  );
}
