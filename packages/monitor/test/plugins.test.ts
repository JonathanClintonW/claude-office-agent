// Contract tests for the monitor plugin + RPC mechanism.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MonitorEvent } from '@agent-office/core';
import { loadOrCreateConfig } from '../src/config';
import type { MonitorPlugin } from '../src/plugin';
import { createMonitor, type Monitor } from '../src/server';
import { freePort, http, MirrorClient, tempDir } from './helpers';

describe('monitor plugins', () => {
  let home: ReturnType<typeof tempDir>;
  let monitor: Monitor;
  let port: number;
  let token: string;
  const seen: MonitorEvent[] = [];
  let stopped = false;

  const probe: MonitorPlugin = {
    name: 'probe',
    onEvent: (ev) => seen.push(ev),
    routes: {
      echo: (p) => ({ echoed: p.value ?? null }),
      boom: () => {
        throw new Error('nope');
      },
    },
    meta: () => ({ events: seen.length }),
    stop: () => {
      stopped = true;
    },
  };

  beforeEach(async () => {
    home = tempDir('plugins');
    port = await freePort();
    token = loadOrCreateConfig(home.path, { port }).token;
    seen.length = 0;
    stopped = false;
    monitor = createMonitor({ home: home.path, port, token, claudeDirs: [home.path], discovery: false, plugins: [probe], tickIntervalMs: 3_600_000 });
    await monitor.start();
  });
  afterEach(async () => {
    await monitor.stop();
    home.cleanup();
  });

  it('delivers sequenced events to started plugins and publishes their meta', () => {
    monitor.ingestHook({ session_id: 's1', hook_event_name: 'SessionStart' });
    expect(seen.map((e) => e.kind)).toEqual(['SessionStart']);
    expect(seen[0]!.seq).toBeGreaterThan(0);
    expect(monitor.getMeta().plugins).toEqual({ probe: { events: 1 } });
  });

  it('answers RPC directly, over WebSocket and over HTTP; rejects unknown or invalid methods', async () => {
    await expect(monitor.rpc('probe.echo', { value: 1 })).resolves.toEqual({ echoed: 1 });
    await expect(monitor.rpc('probe.missing')).rejects.toThrow('unknown method');
    await expect(monitor.rpc('../etc')).rejects.toThrow('invalid method');
    await expect(monitor.rpc('probe.boom')).rejects.toThrow('nope');

    const c = new MirrorClient(port, token);
    await c.opened();
    c.ws.send(JSON.stringify({ type: 'rpc', id: 7, method: 'probe.echo', params: { value: 'x' } }));
    await c.waitFor((x) => x.messages.some((m) => m.type === 'rpcResult'));
    expect(c.messages.find((m) => m.type === 'rpcResult')).toEqual({ type: 'rpcResult', id: 7, ok: true, result: { echoed: 'x' } });
    c.close();

    expect((await http(port, { path: '/api/rpc/probe.echo' })).status).toBe(401);
    const r = await http(port, { path: `/api/rpc/probe.echo?params=${encodeURIComponent('{"value":2}')}`, headers: { 'x-agent-office-token': token } });
    expect(JSON.parse(r.body)).toEqual({ ok: true, result: { echoed: 2 } });
  });

  it('stops plugins with the monitor', async () => {
    await monitor.stop();
    expect(stopped).toBe(true);
    await monitor.start(); // allow afterEach to stop again
  });
});
