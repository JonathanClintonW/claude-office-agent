// Primary navigation between the office and dashboard views.
import type { ViewId } from '../views/types';

const TABS: Array<[ViewId, string]> = [
  ['office', 'Office'],
  ['tasks', 'Tasks'],
  ['errors', 'Errors'],
  ['git', 'Git'],
  ['analytics', 'Analytics'],
  ['history', 'History'],
  ['team', 'Team'],
  ['settings', 'Settings'],
];

export function NavTabs({ view, onView, badges }: { view: ViewId; onView(v: ViewId): void; badges?: Partial<Record<ViewId, number>> }) {
  return (
    <nav className="navtabs" aria-label="Views">
      {TABS.map(([id, label]) => (
        <button key={id} className={`navtab ${view === id ? 'active' : ''}`} aria-current={view === id ? 'page' : undefined} onClick={() => onView(id)}>
          {label}
          {badges?.[id] ? <span className="num alert">{badges[id]}</span> : null}
        </button>
      ))}
    </nav>
  );
}
