/**
 * Path helpers that behave identically on Windows and POSIX hosts: paths arrive as `c:\work\app`,
 * Git Bash `/c/work/app` or with mixed separators. They only compare strings, never touch the filesystem.
 */

const WIN_DRIVE = /^[a-zA-Z]:([\\/]|$)/;
const GIT_BASH_DRIVE = /^\/([a-zA-Z])(\/|$)/;

export function isWindowsPath(p: string): boolean {
  return WIN_DRIVE.test(p) || p.startsWith('\\\\') || p.startsWith('//');
}

/** Convert `/c/foo` (Git Bash / MSYS) into `c:\foo`; other paths are returned unchanged. */
export function fromGitBashPath(p: string): string {
  const m = GIT_BASH_DRIVE.exec(p);
  if (!m) return p;
  return `${m[1]}:\\${p.slice(3).replace(/\//g, '\\')}`;
}

/**
 * Canonical key for comparing paths. Windows paths are case-folded and use `\`.
 * POSIX paths are kept case-sensitive.
 */
export function normalizePathKey(input: string): string {
  let p = fromGitBashPath(input.trim());
  if (isWindowsPath(p)) {
    p = p.replace(/\//g, '\\');
    // collapse duplicate separators but keep a UNC prefix
    const unc = p.startsWith('\\\\');
    p = (unc ? '\\\\' : '') + p.slice(unc ? 2 : 0).replace(/\\{2,}/g, '\\');
    if (/^[a-zA-Z]:$/.test(p)) p += '\\';
    if (p.length > 3) p = p.replace(/\\+$/, '');
    return p.toLowerCase();
  }
  p = p.replace(/\/{2,}/g, '/');
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return p || '/';
}

export function isPathInside(child: string, parent: string): boolean {
  const c = normalizePathKey(child);
  const p = normalizePathKey(parent);
  if (c === p) return true;
  const sep = isWindowsPath(c) ? '\\' : '/';
  const prefix = p.endsWith(sep) ? p : p + sep;
  return c.startsWith(prefix);
}

export function baseName(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** Path relative to `base` for display, falling back to the original path. */
export function displayPath(path: string, base?: string): string {
  if (!base) return path;
  if (!isPathInside(path, base)) return path;
  const normBase = normalizePathKey(base);
  const normPath = normalizePathKey(path);
  if (normBase === normPath) return '.';
  // Slice the original string so the user's casing is preserved.
  const cut = fromGitBashPath(path).replace(/\//g, isWindowsPath(path) ? '\\' : '/');
  const rel = cut.slice(normBase.length).replace(/^[\\/]+/, '');
  return rel || '.';
}
