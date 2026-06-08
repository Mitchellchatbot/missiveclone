import React, { useRef, useEffect } from 'react';

// Pull image files out of a clipboard/drag DataTransfer. Browsers paste
// screenshots into a contentEditable as inline <img src="data:..."> blobs,
// which (a) bloat body_html past the server's 10 MB field cap so the send
// is rejected, and (b) never reach our real attachment pipeline. We grab
// them as Files instead and hand them to the composer to attach normally.
function imageFilesFrom(dataTransfer, counterRef) {
  const out = [];
  const items = dataTransfer ? dataTransfer.items : null;
  if (items) {
    for (const it of items) {
      if (it.kind === 'file' && it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) out.push(f);
      }
    }
  }
  // Give clipboard images (which arrive named "image.png") unique names so
  // multiple pastes don't collide in the attachment list.
  return out.map(f => {
    const generic = !f.name || /^image\.\w+$/i.test(f.name);
    if (!generic) return f;
    const ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
    return new File([f], `pasted-image-${++counterRef.current}.${ext}`, { type: f.type });
  });
}

// Minimal contentEditable editor with a small format toolbar.
// Uses execCommand which is deprecated but still works in every modern
// browser; sufficient for an MVP composer.
export default function RichEditor({ html, onChange, placeholder, onAttachFiles }) {
  const ref = useRef(null);
  const pasteCounter = useRef(0);

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

  // Intercept pasted images → route to attachments instead of inlining them
  // as base64 in the body. Non-image pastes fall through to default handling
  // so text/rich-text still pastes normally.
  function onPaste(e) {
    if (!onAttachFiles) return;
    const imgs = imageFilesFrom(e.clipboardData, pasteCounter);
    if (imgs.length) {
      e.preventDefault();
      onAttachFiles(imgs);
    }
  }

  function onDrop(e) {
    if (!onAttachFiles) return;
    const imgs = imageFilesFrom(e.dataTransfer, pasteCounter);
    if (imgs.length) {
      e.preventDefault();
      onAttachFiles(imgs);
    }
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
        onPaste={onPaste}
        onDrop={onDrop}
        data-placeholder={placeholder || 'Reply…'}
      />
    </div>
  );
}
