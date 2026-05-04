import React from 'react';

function hashHue(s) {
  let h = 0;
  for (const c of String(s || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 360;
}

function initials(name) {
  if (!name) return '?';
  const trimmed = String(name).trim();
  if (!trimmed) return '?';
  // Email-shaped? Use the local part.
  const head = trimmed.includes('@') ? trimmed.split('@')[0] : trimmed;
  const parts = head.split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export default function Avatar({ name, size = 28, title }) {
  const hue = hashHue(name);
  const style = {
    width: size,
    height: size,
    background: `hsl(${hue}, 55%, 50%)`,
    fontSize: Math.max(10, Math.round(size * 0.42))
  };
  return (
    <div className="avatar" style={style} title={title || name}>
      {initials(name)}
    </div>
  );
}
