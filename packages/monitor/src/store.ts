import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInitialState, defaultLayout, validateLayout, type OfficeLayout, type OfficeState } from '@agent-office/core';
import { writeFileAtomic } from './config';

const STATE_FILE = 'state.json';
const LAYOUT_FILE = 'layout.json';

export function loadState(home: string): OfficeState | undefined {
  try {
    const s = JSON.parse(readFileSync(join(home, STATE_FILE), 'utf8')) as OfficeState;
    if (s && s.version === 1 && s.agents && typeof s.agents === 'object' && Array.isArray(s.log)) {
      const base = createInitialState();
      return { ...base, ...s, spawns: s.spawns ?? {}, notices: s.notices ?? [], tasks: s.tasks ?? {} };
    }
  } catch {
    /* missing or corrupt: start fresh */
  }
  return undefined;
}

export function saveState(home: string, state: OfficeState): void {
  writeFileAtomic(join(home, STATE_FILE), JSON.stringify(state));
}

export function loadLayout(home: string): OfficeLayout {
  try {
    const r = validateLayout(JSON.parse(readFileSync(join(home, LAYOUT_FILE), 'utf8')));
    if (r.ok) return r.layout;
  } catch {
    /* fall through */
  }
  return defaultLayout();
}

export function saveLayout(home: string, layout: OfficeLayout): void {
  writeFileAtomic(join(home, LAYOUT_FILE), JSON.stringify(layout, null, 2) + '\n');
}
