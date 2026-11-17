import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import WebSocket from 'ws';
import { createInitialState, reduce, type OfficeState, type ServerMessage } from '@agent-office/core';

export function tempDir(prefix: string): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), `agent-office-test-${prefix}-`));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

export interface HttpResult {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

export function http(port: number, opts: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path, headers: { host: `127.0.0.1:${port}`, ...opts.headers } },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      },
    );
    req.on('error', reject);
    req.end(opts.body);
  });
}

/** WebSocket client that mirrors server state by replaying events, exactly like the UI. */
export class MirrorClient {
  ws: WebSocket;
  messages: ServerMessage[] = [];
  state: OfficeState = createInitialState();
  gaps = 0;
  private waiters: Array<() => void> = [];

  constructor(port: number, token: string, headers: Record<string, string> = {}) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`, { headers });
    this.ws.on('message', (d) => {
      const msg = JSON.parse(String(d)) as ServerMessage;
      this.messages.push(msg);
      if (msg.type === 'snapshot') this.state = msg.state;
      if (msg.type === 'events') {
        for (const ev of msg.events) {
          if (ev.seq <= this.state.lastSeq) continue; // duplicate delivery (already in the snapshot)
          if (ev.seq !== this.state.lastSeq + 1) this.gaps += 1;
          this.state = reduce(this.state, ev);
        }
      }
      for (const w of this.waiters.splice(0)) w();
    });
  }

  opened(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
      this.ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    });
  }

  async waitFor(pred: (c: MirrorClient) => boolean, timeoutMs = 5000): Promise<void> {
    const until = Date.now() + timeoutMs;
    while (!pred(this)) {
      if (Date.now() > until) throw new Error('timed out waiting for condition');
      await new Promise<void>((r) => {
        this.waiters.push(r);
        setTimeout(r, 50);
      });
    }
  }

  close(): void {
    this.ws.close();
  }
}

let forwarderBundle: Promise<string> | undefined;

/** Build the real hook forwarder once per test run. */
export function buildForwarder(outDir: string): Promise<string> {
  forwarderBundle ??= build({
    entryPoints: [join(__dirname, '..', 'src', 'forwarder.ts')],
    outfile: join(outDir, 'agent-office-hook.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    logLevel: 'silent',
  }).then(() => join(outDir, 'agent-office-hook.cjs'));
  return forwarderBundle;
}

export interface ProcResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run the forwarder the way Claude Code runs a command hook: JSON on stdin. */
export function runForwarder(forwarder: string, home: string, stdin: string): Promise<ProcResult> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [forwarder, '--home', home], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (c) => (stdout += c));
    p.stderr.on('data', (c) => (stderr += c));
    p.on('error', reject);
    p.on('close', (code) => resolve({ code, stdout, stderr }));
    p.stdin.end(stdin);
  });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
