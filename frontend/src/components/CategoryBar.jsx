import React from 'react';

const CATEGORIES = [
  { key: null,          label: 'All',         icon: '📥' },
  { key: 'people',      label: 'People',      icon: '👥' },
  { key: 'codes',       label: 'Codes',       icon: '🛡️' },
  { key: 'newsletters', label: 'Newsletters', icon: '🔔' },
  { key: 'receipts',    label: 'Receipts',    icon: '🧾' },
  { key: 'calendar',    label: 'Calendar',    icon: '📅' },
  { key: 'bounces',     label: 'Bounces',     icon: '⚠️' }
];

export default function CategoryBar({ filter, setFilter }) {
  const active = filter.category || null;
  return (
    <div className="cat-bar">
      {CATEGORIES.map(c => (
        <button
          key={c.key || 'all'}
          className={'cat-pill ' + (active === c.key ? 'active' : '')}
          onClick={() => setFilter({ ...filter, category: c.key })}
        >
          <span className="cat-icon">{c.icon}</span>
          <span>{c.label}</span>
        </button>
      ))}
    </div>
  );
}
