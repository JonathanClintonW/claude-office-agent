import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { request } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { TOKEN_HEADER } from '@agent-office/core';
import { loadOrCreateConfig, readConfig, resolveAppHome, resolveClaudeDirs } from './config';
import {
  applyPlan,
  describePlan,
  FORWARDER_FILE,
  findNodeExecutable,
  inspectClaudeDir,
  installForwarder,
  planInstall,
  planUninstall,
  projectSettingsPath,
  userSettingsPath,
  type HookMode,
} from './hooks';
import { defaultPlugins } from './plugins';
import { createMonitor } from './server';
import { isScenarioName, SCENARIOS } from './simulate';

// More libuv threads: one slow file read (e.g. an antivirus scan) must not starve other I/O.
process.env.UV_THREADPOOL_SIZE ??= '16';

const HELP = `Agent Office: local monitor for Claude Code agents

Usage: agent-office <command> [options]

Commands:
  start                 Start the monitor (http://127.0.0.1:<port>)
  status                Show configuration, hook status and whether a monitor is running
  install-hooks         Add Agent Office hooks to Claude Code settings (dry run unless --yes)
  uninstall-hooks       Remove only Agent Office hooks (dry run unless --yes)
  simulate              Send a SIMULATED demo scenario to a running monitor

Options:
  --port <n>            Monitor port (default from config, 47821)
  --home <dir>          Agent Office data directory (default ~/.agent-office or AGENT_OFFICE_HOME)
  --claude-dir <dir>    Additional Claude config dir to watch (repeatable). ~/.claude and
                        CLAUDE_CONFIG_DIR are always included.
  --scope user|project  install/uninstall target: <claude-dir>/settings.json (user, default)
                        or <project>/.claude/settings.local.json (project)
  --project <dir>       Project directory for --scope project (default: current directory)
  --mode command|http   Hook transport (default command: async, silent when the monitor is down)
  --yes                 Apply changes (otherwise only print the plan)
  --open                Open the office in the default browser after starting
  --dev                 Allow the Vite dev server origin (http://localhost:5173) to connect
  --no-discovery        Disable registry/transcript discovery (hooks only)
  --loop                simulate: repeat the scenario until interrupted
  --linger <seconds>    simulate: keep the finished sessions idle this long before ending them (default 6)
  --scenario <name>     simulate: default | showcase (5 sessions, parallel and nested subagents, a team)
`;

interface Args {
  cmd: string;
  flags: Map<string, string[]>;
}

function parseArgs(argv: string[]): Args {
  const [cmd = 'help', ...rest] = argv;
  const flags = new Map<string, string[]>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = rest[i + 1];
    const value = next !== undefined && !next.startsWith('--') ? (i++, next) : 'true';
    flags.set(key, [...(flags.get(key) ?? []), value]);
  }
  return { cmd, flags };
}

const flag = (a: Args, k: string) => a.flags.get(k)?.at(-1);
const has = (a: Args, k: string) => a.flags.has(k);

/** Directory of the bundled CLI (dist/), also when it is started through the bin/ shim. */
const HERE = dirname(__filename);

function bundledForwarder(): string {
  // dist/cli.cjs and dist/agent-office-hook.cjs are emitted side by side.
  return join(HERE, FORWARDER_FILE);
}

function uiDir(): string | undefined {
  const candidates = [join(HERE, '..', '..', 'ui', 'dist'), join(HERE, 'ui')];
  return candidates.find((d) => existsSync(join(d, 'index.html')));
}

function health(port: number): Promise<boolean> {
  return new Promise((done) => {
    const req = request({ host: '127.0.0.1', port, path: '/api/health', timeout: 800 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => done(body.includes('"agent-office"')));
    });
    req.on('error', () => done(false));
    req.on('timeout', () => req.destroy());
    req.end();
  });
}

function postHook(port: number, token: string, payload: unknown): Promise<number> {
  const body = JSON.stringify({ v: 1, ts: Date.now(), payload });
  return new Promise((done) => {
    const req = request(
      { host: '127.0.0.1', port, path: '/api/hook', method: 'POST', headers: { 'content-type': 'application/json', [TOKEN_HEADER]: token } },
      (res) => {
        res.resume();
        done(res.statusCode ?? 0);
      },
    );
    req.on('error', () => done(0));
    req.end(body);
  });
}

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(cmd, args as string[], { detached: true, stdio: 'ignore' }).unref();
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const home = resolve(flag(args, 'home') ?? resolveAppHome());
  const portFlag = flag(args, 'port');
  const port = portFlag ? Number(portFlag) : undefined;
  if (port !== undefined && (!Number.isInteger(port) || port < 1024 || port > 65535)) {
    console.error('--port must be an integer between 1024 and 65535');
    return 2;
  }

  switch (args.cmd) {
    case 'start': {
      const cfg = loadOrCreateConfig(home, port ? { port } : {});
      const claudeDirs = resolveClaudeDirs([...cfg.claudeConfigDirs, ...(args.flags.get('claude-dir') ?? [])]);
      if (await health(cfg.port)) {
        console.log(`A monitor is already running on http://127.0.0.1:${cfg.port}/`);
        if (has(args, 'open')) openBrowser(`http://127.0.0.1:${cfg.port}/`);
        return 0;
      }
      const monitor = createMonitor({
        home,
        port: cfg.port,
        token: cfg.token,
        claudeDirs,
        uiDir: uiDir(),
        discovery: !has(args, 'no-discovery'),
        plugins: defaultPlugins(),
        allowedOrigins: has(args, 'dev') ? ['http://localhost:5173', 'http://127.0.0.1:5173'] : [],
        log: (m) => console.log(`[monitor] ${m}`),
      });
      let actual: number;
      try {
        ({ port: actual } = await monitor.start());
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') {
          console.error(`Port ${cfg.port} is in use by another process that is not answering as Agent Office.`);
          console.error('Stop that process (it may be a stale monitor) or choose another port with --port <n>.');
          return 1;
        }
        throw e;
      }
      const url = `http://127.0.0.1:${actual}/`;
      console.log(`Agent Office running at ${url}`);
      console.log(`Watching Claude config: ${claudeDirs.join(', ')}`);
      for (const d of monitor.getMeta().claudeDirs) {
        console.log(`  ${d.path}: hooks ${d.hooks}${d.hooksDisabled ? ' (disableAllHooks!)' : ''}, registry ${d.registryAvailable ? 'yes' : 'no'}, transcripts ${d.transcriptsAvailable ? 'yes' : 'no'}`);
      }
      if (has(args, 'open')) openBrowser(url);
      let stopping = false;
      const shutdown = async () => {
        if (stopping) return; // a second Ctrl+C must not run stop() concurrently
        stopping = true;
        await monitor.stop();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      return await new Promise<number>(() => {});
    }

    case 'status': {
      const cfg = readConfig(home);
      const claudeDirs = resolveClaudeDirs([...(cfg?.claudeConfigDirs ?? []), ...(args.flags.get('claude-dir') ?? [])]);
      const p = port ?? cfg?.port ?? 47821;
      console.log(`Home:     ${home}${cfg ? '' : ' (not initialised yet)'}`);
      console.log(`Monitor:  ${(await health(p)) ? `running on http://127.0.0.1:${p}/` : `not running (port ${p})`}`);
      console.log(`Node:     ${findNodeExecutable() ?? 'not found'}`);
      for (const d of claudeDirs) {
        const s = inspectClaudeDir(d);
        console.log(`Claude:   ${d}`);
        console.log(`  hooks: ${s.hooks}${s.hookEvents.length ? ` (${s.hookEvents.length} events)` : ''}${s.hooksDisabled ? ', disableAllHooks=true' : ''}`);
        console.log(`  session registry: ${s.registryAvailable ? 'available' : 'missing'}; transcripts: ${s.transcriptsAvailable ? 'available' : 'missing'}`);
      }
      return 0;
    }

    case 'install-hooks':
    case 'uninstall-hooks': {
      const scope = flag(args, 'scope') ?? 'user';
      if (scope !== 'user' && scope !== 'project') {
        console.error('--scope must be "user" or "project"');
        return 2;
      }
      const claudeDir = resolve(flag(args, 'claude-dir') ?? resolveClaudeDirs([])[0]!);
      const settingsPath = scope === 'project' ? projectSettingsPath(resolve(flag(args, 'project') ?? process.cwd())) : userSettingsPath(claudeDir);
      const apply = has(args, 'yes');
      let plan;
      if (args.cmd === 'install-hooks') {
        const mode = (flag(args, 'mode') ?? 'command') as HookMode;
        if (mode !== 'command' && mode !== 'http') {
          console.error('--mode must be "command" or "http"');
          return 2;
        }
        const cfg = loadOrCreateConfig(home, port ? { port } : {});
        const src = bundledForwarder();
        if (!existsSync(src)) {
          console.error(`Forwarder not found at ${src}. Run "npm run build:monitor" first.`);
          return 1;
        }
        const forwarderPath = apply ? installForwarder(src, home) : join(home, 'bin', FORWARDER_FILE);
        plan = planInstall({ settingsPath, mode, nodePath: findNodeExecutable(), forwarderPath, home, port: cfg.port, token: cfg.token });
      } else {
        plan = planUninstall(settingsPath);
      }
      console.log(describePlan(plan));
      if (!plan.changed) return 0;
      if (!apply) {
        console.log('\nDry run only. Re-run with --yes to apply. A backup is written before any change.');
        return 0;
      }
      const r = applyPlan(plan);
      console.log(`\nUpdated ${plan.settingsPath}${r.backupPath ? `\nBackup:  ${r.backupPath}` : ''}`);
      console.log('Claude Code picks up hook changes automatically; restart sessions if events do not appear.');
      return 0;
    }

    case 'simulate': {
      const cfg = readConfig(home);
      if (!cfg || !(await health(port ?? cfg.port))) {
        console.error('No running monitor found. Start one with "agent-office start".');
        return 1;
      }
      const p = port ?? cfg.port;
      const scenario = flag(args, 'scenario') ?? 'default';
      if (!isScenarioName(scenario)) {
        console.error(`Unknown scenario "${scenario}". Use one of: ${Object.keys(SCENARIOS).join(', ')}.`);
        return 2;
      }
      console.log('Sending SIMULATED events (sessions prefixed "sim-"). These are not real agents.');
      do {
        const runId = Date.now().toString(36);
        const steps = SCENARIOS[scenario].build(runId);
        const t0 = Date.now();
        for (const s of steps) {
          const wait = t0 + s.at - Date.now();
          if (wait > 0) await new Promise((r) => setTimeout(r, wait));
          const status = await postHook(p, cfg.token, s.payload);
          if (status !== 204) console.error(`event ${String(s.payload.hook_event_name)} rejected with HTTP ${status}`);
        }
        const linger = Math.max(0, Number(flag(args, 'linger') ?? 6));
        await new Promise((r) => setTimeout(r, linger * 1000));
        for (const e of SCENARIOS[scenario].end(runId)) await postHook(p, cfg.token, e);
        if (has(args, 'loop')) await new Promise((r) => setTimeout(r, 4000));
      } while (has(args, 'loop'));
      console.log('Simulation finished.');
      return 0;
    }

    default:
      console.log(HELP);
      return args.cmd === 'help' || args.cmd === '--help' ? 0 : 2;
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error((e as Error).message);
    process.exit(1);
  },
);
