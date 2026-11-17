/**
 * Claude Code hook command: `node agent-office-hook.cjs --home <dir>`.
 *
 * Contract (important for safety):
 * - Never writes to stdout/stderr: hook output could otherwise be interpreted by Claude Code.
 * - Always exits 0: exit code 2 would block the action the hook guards.
 * - Runs as an async hook, so it never delays Claude Code.
 * - Sends a pre-trimmed payload to 127.0.0.1 only; spools to disk when the monitor is down.
 */
import { request } from 'node:http';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pretrimHookPayload, TOKEN_HEADER, type HookEnvelope } from '@agent-office/core';
import { readConfig } from './config';
import { appendToSpool } from './spool';

const capturedAt = Date.now();
const MAX_STDIN = 32 * 1024 * 1024;

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function readStdin(timeoutMs: number): Promise<string> {
  return new Promise((done) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const finish = () => done(Buffer.concat(chunks).toString('utf8'));
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.on('data', (c: Buffer) => {
      size += c.length;
      if (size <= MAX_STDIN) chunks.push(c);
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      finish();
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      finish();
    });
  });
}

type PostResult = 'ok' | 'rejected' | 'unavailable';

function post(port: number, token: string, body: string, timeoutMs: number): Promise<PostResult> {
  return new Promise((done) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/hook',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), [TOKEN_HEADER]: token },
        timeout: timeoutMs,
      },
      (res) => {
        res.resume();
        const s = res.statusCode ?? 0;
        done(s >= 200 && s < 300 ? 'ok' : s >= 500 ? 'unavailable' : 'rejected');
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => done('unavailable'));
    req.end(body);
  });
}

async function main(): Promise<void> {
  const home = resolve(argValue('--home') ?? process.env.AGENT_OFFICE_HOME ?? join(homedir(), '.agent-office'));
  const raw = await readStdin(5000);
  if (!raw.trim()) return;
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
  const envelope: HookEnvelope = { v: 1, ts: capturedAt, payload: pretrimHookPayload(payload as Record<string, unknown>) };
  const body = JSON.stringify(envelope);
  const cfg = readConfig(home);
  if (cfg) {
    const r = await post(cfg.port, cfg.token, body, 1500);
    if (r !== 'unavailable') return;
  }
  appendToSpool(home, body);
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
