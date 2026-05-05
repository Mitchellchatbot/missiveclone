import React from 'react';
import { Inbox, Users, ShieldCheck, Bell, Receipt, Calendar, AlertTriangle } from 'lucide-react';

const CATEGORIES = [
  { key: null,          label: 'All',         icon: Inbox,          color: '#5a6577' },
  { key: 'people',      label: 'People',      icon: Users,          color: '#0fa55a' },
  { key: 'codes',       label: 'Codes',       icon: ShieldCheck,    color: '#dc2626' },
  { key: 'newsletters', label: 'Newsletters', icon: Bell,           color: '#d97706' },
  { key: 'receipts',    label: 'Receipts',    icon: Receipt,        color: '#2f6feb' },
  { key: 'calendar',    label: 'Calendar',    icon: Calendar,       color: '#7c3aed' },
  { key: 'bounces',     label: 'Bounces',     icon: AlertTriangle,  color: '#b54708' }
];

export default function CategoryBar({ filter, setFilter }) {
  const active = filter.category || null;
  return (
    <div className="cat-bar">
      {CATEGORIES.map(c => {
        const Ico = c.icon;
        const isActive = active === c.key;
        return (
          <button
            key={c.key || 'all'}
            className={'cat-pill ' + (isActive ? 'active' : '')}
            onClick={() => setFilter({ ...filter, category: c.key })}
            style={isActive ? { background: c.color, borderColor: c.color, color: 'white' } : { color: c.color }}
          >
            <Ico size={14} strokeWidth={2.2} />
            <span>{c.label}</span>
          </button>
        );
      })}
    </div>
  );
}
