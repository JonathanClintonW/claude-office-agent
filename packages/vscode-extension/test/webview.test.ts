import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createInitialState, normalizeHookPayload, reduce } from '@agent-office/core';
import { buildWebviewHtml, isAllowedTranscript, parseWebviewMessage, summarize } from '../src/webview';

const index = `<!doctype html>
<html lang="en">
  <head>
    <title>Agent Office</title>
    <script type="module" crossorigin src="./assets/index-abc.js"></script>
    <link rel="stylesheet" crossorigin href="./assets/index-abc.css">
  </head>
  <body><div id="root"></div></body>
</html>`;

describe('webview html', () => {
  const html = buildWebviewHtml(index, { baseUri: 'https://file+.vscode-resource.vscode-cdn.net/ext/media/ui', cspSource: 'https://*.vscode-cdn.net', nonce: 'N0NCE' });

  it('adds a strict CSP with no network access and no eval', () => {
    const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html)![1]!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("script-src https://*.vscode-cdn.net 'nonce-N0NCE'");
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
  });

  it('sets a base URL for relative assets and puts the nonce on every script', () => {
    expect(html).toContain('<base href="https://file+.vscode-resource.vscode-cdn.net/ext/media/ui/">');
    const scripts = html.match(/<script\b[^>]*>/g)!;
    expect(scripts.length).toBeGreaterThan(0);
    for (const s of scripts) expect(s).toContain('nonce="N0NCE"');
  });

  it('works on the real built UI', () => {
    const real = readFileSync(join(__dirname, '..', '..', 'ui', 'dist', 'index.html'), 'utf8');
    const out = buildWebviewHtml(real, { baseUri: 'vscode-resource:/x', cspSource: 'vscode-resource:', nonce: 'abc' });
    expect(out).toContain('Content-Security-Policy');
    for (const s of out.match(/<script\b[^>]*>/g)!) expect(s).toContain('nonce="abc"');
  });
});

describe('webview message validation', () => {
  it('accepts only known message shapes', () => {
    expect(parseWebviewMessage({ type: 'ready' })).toEqual({ type: 'ready' });
    expect(parseWebviewMessage({ type: 'client', msg: { type: 'resync' } })).toEqual({ type: 'client', msg: { type: 'resync' } });
    expect(parseWebviewMessage({ type: 'client', msg: { type: 'saveLayout', layout: { version: 1 } } })).toMatchObject({ type: 'client' });
    expect(parseWebviewMessage({ type: 'client', msg: { type: 'deleteEverything' } })).toBeUndefined();
    expect(parseWebviewMessage({ type: 'runCommand', cmd: 'rm -rf' })).toBeUndefined();
    expect(parseWebviewMessage({ type: 'openTranscript', path: 42 })).toBeUndefined();
    expect(parseWebviewMessage(null)).toBeUndefined();
  });

  it('only opens transcripts inside a watched Claude config dir', () => {
    const dirs = ['C:\\Users\\dev\\.claude'];
    const ok = 'C:\\Users\\dev\\.claude\\projects\\c--work\\0f9c.jsonl';
    if (process.platform === 'win32') {
      expect(isAllowedTranscript(ok, dirs)).toBe(true);
      expect(isAllowedTranscript(ok.toLowerCase(), dirs)).toBe(true);
    }
    expect(isAllowedTranscript('C:\\Users\\dev\\.claude\\settings.json', dirs)).toBe(false);
    expect(isAllowedTranscript('C:\\Users\\dev\\.claude\\projects\\..\\..\\secrets.jsonl', dirs)).toBe(false);
    expect(isAllowedTranscript('C:\\Windows\\x.jsonl', dirs)).toBe(false);
  });
});

describe('status bar summary', () => {
  it('summarises live agents and flags attention', () => {
    let s = createInitialState();
    let seq = 0;
    for (const [sid, ev, extra] of [
      ['a', 'UserPromptSubmit', {}],
      ['b', 'PermissionRequest', { tool_name: 'Bash', tool_input: {} }],
      ['c', 'SessionEnd', {}],
    ] as const) {
      const r = normalizeHookPayload({ session_id: sid, hook_event_name: ev, ...extra }, Date.now());
      if (!r.ok) throw new Error(r.error);
      s = reduce(s, { ...r.event, seq: ++seq });
    }
    expect(summarize(s, true)).toMatchObject({ text: '$(organization) 1 working · 1 needs you', attention: true });
    expect(summarize(s, false).text).toContain('offline');
  });
});
