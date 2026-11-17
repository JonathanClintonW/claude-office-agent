import { describe, expect, it } from 'vitest';
import { defaultLayout, validateLayout } from '../src/layout';
import { baseName, displayPath, fromGitBashPath, isPathInside, normalizePathKey } from '../src/paths';

describe('Windows-aware paths', () => {
  it('normalises drive letters, separators and Git Bash paths', () => {
    expect(normalizePathKey('C:\\Work\\Projects\\App\\')).toBe('c:\\work\\projects\\app');
    expect(normalizePathKey('c:/work/projects/app')).toBe('c:\\work\\projects\\app');
    expect(normalizePathKey('/c/work/projects/app')).toBe('c:\\work\\projects\\app');
    expect(normalizePathKey('C:\\')).toBe('c:\\');
    expect(normalizePathKey('\\\\server\\share\\x')).toBe('\\\\server\\share\\x');
    expect(normalizePathKey('/home/Dev/x/')).toBe('/home/Dev/x');
    expect(fromGitBashPath('/d/work')).toBe('d:\\work');
  });

  it('compares containment case-insensitively on Windows only', () => {
    expect(isPathInside('c:\\work\\Acme\\src', 'C:\\Work\\acme')).toBe(true);
    expect(isPathInside('c:\\work\\Acme-api', 'c:\\work\\Acme')).toBe(false);
    expect(isPathInside('/home/dev/app', '/home/Dev')).toBe(false);
    expect(isPathInside('/home/dev/app/x', '/home/dev/app')).toBe(true);
  });

  it('produces display names and relative paths', () => {
    expect(baseName('c:\\work\\agent-office')).toBe('agent-office');
    expect(displayPath('c:\\work\\app\\src\\a.ts', 'C:\\work\\app')).toBe('src\\a.ts');
    expect(displayPath('d:\\other\\a.ts', 'c:\\app')).toBe('d:\\other\\a.ts');
  });
});

describe('layout validation', () => {
  it('accepts the default layout', () => {
    expect(validateLayout(defaultLayout())).toMatchObject({ ok: true });
  });

  it('rejects overlapping items, blocked chairs and out-of-bounds data', () => {
    const base = defaultLayout();
    const overlap = { ...base, items: [...base.items, { id: 'dup', type: 'plant', x: base.items[0]!.x, y: base.items[0]!.y }] };
    expect(validateLayout(overlap).ok).toBe(false);
    const chair = { ...base, items: [{ id: 'd', type: 'desk', x: 4, y: 5 }, { id: 'p', type: 'plant', x: 4, y: 6 }] };
    const door = { ...base, items: [{ id: 'p', type: 'plant', x: base.door.x, y: base.rows - 1 }] };
    expect(validateLayout(door)).toMatchObject({ ok: false, error: 'the door tile is blocked' });
    expect(validateLayout(chair)).toMatchObject({ ok: false, error: 'desk d chair is blocked' });
    expect(validateLayout({ ...base, cols: 1000 }).ok).toBe(false);
    expect(validateLayout({ ...base, items: [{ id: '../x', type: 'desk', x: 1, y: 3 }] }).ok).toBe(false);
    expect(validateLayout({ ...base, items: [{ id: 'x', type: 'bomb', x: 1, y: 3 }] }).ok).toBe(false);
  });

  it('drops unknown fields and sanitises zone colours', () => {
    const r = validateLayout({
      ...defaultLayout(),
      evil: '<script>',
      zones: [{ id: 'z', name: 'Acme', x: 0, y: 2, w: 5, h: 5, color: 'red;background:url(x)', workspaceMatch: 'Acme' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.layout as unknown as Record<string, unknown>).evil).toBeUndefined();
    expect(r.layout.zones[0]!.color).toBe('#3a4a6b');
  });
});
