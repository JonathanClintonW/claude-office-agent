// View contract. Every dashboard view receives the same props.
import type { StoreSnapshot } from '../store';

export interface ViewProps {
  snap: StoreSnapshot;
  /** Re-renders every second for relative times. */
  now: number;
  /** Select an agent: opens its inspector in the sidebar. */
  onSelectAgent(key: string): void;
}

export type ViewId = 'office' | 'tasks' | 'errors' | 'git' | 'analytics' | 'history' | 'team' | 'settings';
