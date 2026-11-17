import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HOOK_EVENTS, TOKEN_HEADER } from '@agent-office/core';
import {
  applyPlan,
  assertPassiveHandler,
  collectHookScopes,
  detectDuplicateHookScopes,
  inspectSettingsText,
  isOurHandler,
  PASSIVE_HANDLER_TYPES,
  planInstall,
  planUninstall,
  projectSettingsPath,
  userSettingsPath,
  type InstallOptions,
} from '../src/hooks';
import { tempDir } from './helpers';

const USER_SETTINGS = {
  model: 'opus',
  permissions: { allow: ['Bash(npm test)'] },
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'C:\\tools\\audit.exe' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }],
  },
};

describe('hook installer', () => {
  let dir: ReturnType<typeof tempDir>;
  let settingsPath: string;
  let opts: InstallOptions;

  beforeEach(() => {
    dir = tempDir('hooks');
    settingsPath = join(dir.path, '.claude', 'settings.json');
    opts = {
      settingsPath,
      mode: 'command',
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
      forwarderPath: 'C:\\Users\\dev\\.agent-office\\bin\\agent-office-hook.cjs',
      home: 'C:\\Users\\dev\\.agent-office',
      port: 47821,
      token: 'a'.repeat(48),
    };
  });
  afterEach(() => dir.cleanup());

  const write = (obj: unknown, text?: string) => {
    mkdirSync(join(dir.path, '.claude'), { recursive: true });
    writeFileSync(settingsPath, text ?? JSON.stringify(obj, null, 2) + '\n');
  };
  const read = () => JSON.parse(readFileSync(settingsPath, 'utf8'));

  it('creates a settings file with async exec-form hooks for every event', () => {
    const plan = planInstall(opts);
    expect(plan.existed).toBe(false);
    expect(plan.events).toEqual([...HOOK_EVENTS]);
    const r = applyPlan(plan);
    expect(r).toEqual({ written: true, backupPath: undefined });
    const s = read();
    for (const e of HOOK_EVENTS) {
      expect(s.hooks[e]).toEqual([
        { hooks: [{ type: 'command', command: opts.nodePath, args: [opts.forwarderPath, '--home', opts.home], async: true, timeout: 10 }] },
      ]);
    }
    expect(inspectSettingsText(readFileSync(settingsPath, 'utf8'))).toMatchObject({ hooks: 'installed' });
  });

  it('preserves existing settings and hooks, writes a backup and is idempotent', () => {
    write(USER_SETTINGS);
    const original = readFileSync(settingsPath, 'utf8');
    const r = applyPlan(planInstall(opts), Date.parse('2026-11-17T10:00:00Z'));
    expect(r.backupPath).toMatch(/settings\.json\.agent-office-backup-2026-11-17T10-00-00-000Z$/);
    expect(readFileSync(r.backupPath!, 'utf8')).toBe(original);
    const s = read();
    expect(s.model).toBe('opus');
    expect(s.permissions).toEqual(USER_SETTINGS.permissions);
    expect(s.hooks.PreToolUse[0]).toEqual(USER_SETTINGS.hooks.PreToolUse[0]);
    expect(s.hooks.PreToolUse).toHaveLength(2);
    expect(s.hooks.Stop[0]).toEqual(USER_SETTINGS.hooks.Stop[0]);

    const again = planInstall(opts);
    expect(again.changed).toBe(false);
    expect(applyPlan(again)).toEqual({ written: false });
  });

  it('uses HTTP handlers in http mode, except SessionStart which only supports commands', () => {
    applyPlan(planInstall({ ...opts, mode: 'http' }));
    const s = read();
    expect(s.hooks.SessionStart[0].hooks[0].type).toBe('command');
    expect(s.hooks.PreToolUse[0].hooks[0]).toEqual({ type: 'http', url: 'http://127.0.0.1:47821/api/hook', headers: { [TOKEN_HEADER]: opts.token }, timeout: 3 });
    expect(isOurHandler(s.hooks.PreToolUse[0].hooks[0])).toBe(true);
  });

  it('skips command-only events with a warning when Node.js is unavailable', () => {
    const plan = planInstall({ ...opts, mode: 'http', nodePath: undefined });
    expect(plan.events).not.toContain('SessionStart');
    expect(plan.warnings.join()).toContain('SessionStart skipped');
  });

  it('uninstall removes only Agent Office handlers', () => {
    write(USER_SETTINGS);
    applyPlan(planInstall(opts));
    const plan = planUninstall(settingsPath);
    expect(plan.events.length).toBe(HOOK_EVENTS.length);
    applyPlan(plan);
    expect(read()).toEqual(USER_SETTINGS);
  });

  it('uninstall drops the hooks key only when it held nothing else', () => {
    write({ model: 'x' });
    applyPlan(planInstall(opts));
    applyPlan(planUninstall(settingsPath));
    expect(read()).toEqual({ model: 'x' });
  });

  it('refuses to modify invalid JSON or unexpected structures', () => {
    write(null, '{ "model": "x", // comment\n }');
    expect(() => planInstall(opts)).toThrow(/not valid JSON/);
    write({ hooks: [] });
    expect(() => planInstall(opts)).toThrow(/"hooks" is not an object/);
  });

  it('refuses to apply a stale plan if the file changed meanwhile', () => {
    write({ model: 'a' });
    const plan = planInstall(opts);
    write({ model: 'b' });
    expect(() => applyPlan(plan)).toThrow(/changed since the plan/);
    expect(read()).toEqual({ model: 'b' });
    expect(readdirSync(join(dir.path, '.claude')).filter((f) => f.includes('backup'))).toHaveLength(0);
  });

  it('warns about settings that would prevent hooks from running', () => {
    write({ disableAllHooks: true, allowedHttpHookUrls: ['https://corp.example/*'] });
    const plan = planInstall({ ...opts, mode: 'http' });
    expect(plan.warnings.some((w) => w.includes('disableAllHooks'))).toBe(true);
    expect(plan.warnings.some((w) => w.includes('allowedHttpHookUrls'))).toBe(true);
  });

  it('preserves CRLF line endings and indentation', () => {
    write(null, '{\r\n    "model": "x"\r\n}\r\n');
    applyPlan(planInstall(opts));
    const text = readFileSync(settingsPath, 'utf8');
    expect(text).toContain('\r\n    "model": "x"');
    expect(text.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('reports partial installs', () => {
    applyPlan(planInstall({ ...opts, events: ['PreToolUse', 'Stop'] }));
    expect(inspectSettingsText(readFileSync(settingsPath, 'utf8'))).toMatchObject({ hooks: 'partial', hookEvents: ['PreToolUse', 'Stop'] });
    expect(inspectSettingsText('nope').hooks).toBe('unreadable');
    expect(inspectSettingsText(undefined).hooks).toBe('not_installed');
    expect(existsSync(settingsPath)).toBe(true);
  });

  it('only ever writes async command or loopback http handlers, never prompt, agent or mcp_tool hooks', () => {
    // The user's own model-running hooks are preserved untouched and are not ours.
    const userHooks = {
      hooks: {
        Stop: [{ hooks: [{ type: 'prompt', prompt: 'Is the task complete?' }] }],
        SubagentStop: [{ hooks: [{ type: 'agent', prompt: 'Verify the result' }] }],
        PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'mcp_tool', server: 'lint', tool: 'check' }] }],
      },
    };
    const handlersOf = (text: string) =>
      Object.values((JSON.parse(text) as { hooks: Record<string, Array<{ hooks: Array<Record<string, unknown>> }>> }).hooks)
        .flat()
        .flatMap((g) => g.hooks);
    for (const mode of ['command', 'http'] as const) {
      for (const existing of [undefined, userHooks]) {
        if (existing) write(existing);
        else rmSync(settingsPath, { force: true });
        const plan = planInstall({ ...opts, mode });
        const before = new Set(existing ? handlersOf(JSON.stringify(existing)).map((h) => JSON.stringify(h)) : []);
        const added = handlersOf(plan.after).filter((h) => !before.has(JSON.stringify(h)));
        expect(added.length).toBe(HOOK_EVENTS.length);
        for (const h of added) {
          expect(isOurHandler(h)).toBe(true);
          expect(PASSIVE_HANDLER_TYPES.has(String(h.type))).toBe(true);
          expect(['prompt', 'agent', 'mcp_tool']).not.toContain(h.type);
          if (h.type === 'command') expect(h.async).toBe(true);
          if (h.type === 'http') expect(String(h.url)).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/hook$/);
        }
        // user hooks of other types survive and are never mistaken for ours
        if (existing) {
          const kept = handlersOf(plan.after).filter((h) => ['prompt', 'agent', 'mcp_tool'].includes(String(h.type)));
          expect(kept).toHaveLength(3);
          expect(kept.some(isOurHandler)).toBe(false);
        }
      }
    }
  });

  it('assertPassiveHandler rejects every non-passive handler shape', () => {
    expect(() => assertPassiveHandler({ type: 'command', command: 'node', async: true })).not.toThrow();
    expect(() => assertPassiveHandler({ type: 'http', url: 'http://127.0.0.1:47821/api/hook' })).not.toThrow();
    for (const type of ['prompt', 'agent', 'mcp_tool', 'unknown']) expect(() => assertPassiveHandler({ type, prompt: 'x' })).toThrow(/only command and http/);
    expect(() => assertPassiveHandler({ type: 'command', command: 'node' })).toThrow(/synchronous/);
    expect(() => assertPassiveHandler({ type: 'http', url: 'https://hooks.example.com/api/hook' })).toThrow(/127\.0\.0\.1/);
  });
});

describe('hooks installed in more than one scope', () => {
  const ours = JSON.stringify({
    hooks: Object.fromEntries(
      ['PreToolUse', 'Stop'].map((e) => [e, [{ hooks: [{ type: 'command', command: 'node', args: ['C:\\x\\agent-office-hook.cjs'], async: true }] }]]),
    ),
  });
  const onlyStop = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'http', url: 'http://127.0.0.1:47821/api/hook', headers: { [TOKEN_HEADER]: 't' } }] }] } });
  const foreign = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } });

  it('flags events registered in user settings and a project, or in both project files', () => {
    const r = detectDuplicateHookScopes(
      [
        { scope: 'project-local', project: 'c:\\work\\app', path: 'c:\\work\\app\\.claude\\settings.local.json', text: onlyStop },
        { scope: 'user', path: 'c:\\home\\.claude\\settings.json', text: ours },
      ],
      123,
    );
    expect(r).toEqual({
      scopes: [
        { scope: 'user', path: 'c:\\home\\.claude\\settings.json', events: ['PreToolUse', 'Stop'] },
        { scope: 'project-local', path: 'c:\\work\\app\\.claude\\settings.local.json', events: ['Stop'] },
      ],
      duplicateEvents: ['Stop'],
      checkedAt: 123,
    });
    const projectOnly = detectDuplicateHookScopes([
      { scope: 'project', project: '/w/app', path: '/w/app/.claude/settings.json', text: ours },
      { scope: 'project-local', project: '/w/app', path: '/w/app/.claude/settings.local.json', text: ours },
    ]);
    expect(projectOnly.duplicateEvents).toEqual(['PreToolUse', 'Stop']);
  });

  it('does not flag a single scope, foreign hooks, separate projects, or several user config dirs', () => {
    const cases = [
      [{ scope: 'user' as const, path: '/h/.claude/settings.json', text: ours }],
      [
        { scope: 'user' as const, path: '/h/.claude/settings.json', text: ours },
        { scope: 'user' as const, path: '/h/.claude-work/settings.json', text: ours },
      ],
      [
        { scope: 'user' as const, path: '/h/.claude/settings.json', text: foreign },
        { scope: 'project-local' as const, project: '/w/a', path: '/w/a/.claude/settings.local.json', text: ours },
        { scope: 'project-local' as const, project: '/w/b', path: '/w/b/.claude/settings.local.json', text: ours },
        { scope: 'project' as const, project: '/w/c', path: '/w/c/.claude/settings.json', text: undefined },
      ],
    ];
    for (const files of cases) expect(detectDuplicateHookScopes(files).duplicateEvents).toEqual([]);
  });

  it('reads real files and never counts a project rooted at the home directory twice', () => {
    const dir = tempDir('scopes');
    try {
      const home = join(dir.path, 'home');
      const claudeDir = join(home, '.claude');
      const project = join(dir.path, 'project');
      mkdirSync(claudeDir, { recursive: true });
      mkdirSync(join(project, '.claude'), { recursive: true });
      writeFileSync(userSettingsPath(claudeDir), ours);
      expect(collectHookScopes([claudeDir], [home, project], 5)).toEqual({
        scopes: [{ scope: 'user', path: userSettingsPath(claudeDir), events: ['PreToolUse', 'Stop'] }],
        duplicateEvents: [],
        checkedAt: 5,
      });
      writeFileSync(projectSettingsPath(project), onlyStop);
      expect(collectHookScopes([claudeDir], [home, project]).duplicateEvents).toEqual(['Stop']);
    } finally {
      dir.cleanup();
    }
  });
});
