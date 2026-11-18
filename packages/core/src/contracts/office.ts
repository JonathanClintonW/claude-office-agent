/** Room kinds are layout semantics, NOT verified Claude roles. */
export const ROOM_KINDS = [
  'office',
  'development',
  'qa',
  'devops',
  'security',
  'research',
  'collaboration',
  'meeting',
  'break',
  'restroom',
  'reception',
  'corridor',
] as const;
export type RoomKind = (typeof ROOM_KINDS)[number];

/** Rooms that host department desks (agents can be mapped to them by local rules). */
export const DEPARTMENT_KINDS = ['development', 'qa', 'devops', 'security', 'research', 'collaboration'] as const;
export type DepartmentKind = (typeof DEPARTMENT_KINDS)[number];
