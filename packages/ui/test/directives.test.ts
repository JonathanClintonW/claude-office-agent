import { describe, expect, it } from 'vitest';
import type { AgentStatus } from '@agent-office/core';
import type { Directive } from '../src/office/behavior';
import { allowed, ATTENTION_STATUSES, resolveDirectives, restPhase, type ArbiterActor, type Claim } from '../src/office/directives';

const actor = (key: string, over: Partial<ArbiterActor> = {}): ArbiterActor => ({ key, idle: true, status: 'idle', home: { x: key.length * 10, y: 20 }, ...over });
const go = (x: number, y: number): Directive => ({ type: 'go', to: { x, y } });
const doAt = (x: number, y: number, extra: Partial<Extract<Directive, { type: 'do' }>> = {}): Directive => ({ type: 'do', at: { x, y }, face: 'down', pose: 'stand', activity: 'coffee', ...extra });
const claim = (directive: Directive, trusted = false): Claim => ({ directive, trusted });

describe('resolveDirectives: real status wins', () => {
  const BUSY: AgentStatus[] = ['working', 'waiting_permission', 'waiting_input', 'failed', 'unknown'];

  it('sends a busy actor home in a hurry, whatever an untrusted provider wanted', () => {
    for (const status of BUSY) {
      const a = actor('a', { idle: false, status });
      for (const d of [go(3, 3), doAt(3, 3), doAt(3, 3, { verified: true })]) {
        const out = resolveDirectives([a], new Map([['a', claim(d)]]), new Map());
        expect(out.get('a'), `${status} ${JSON.stringify(d)}`).toEqual({ type: 'home', hurry: true });
      }
    }
  });

  it('lets a trusted provider (verified collaboration events) move a working actor briefly, never for attention states', () => {
    const working = actor('a', { idle: false, status: 'working' });
    expect(resolveDirectives([working], new Map([['a', claim(go(3, 3), true)]]), new Map()).get('a')).toEqual(go(3, 3));
    const verified = doAt(3, 3, { verified: true, pose: 'talk', activity: 'briefing' });
    expect(resolveDirectives([working], new Map([['a', claim(verified, true)]]), new Map()).get('a')).toEqual(verified);
    // an unverified pose for a busy actor is never shown, even from a trusted provider
    expect(resolveDirectives([working], new Map([['a', claim(doAt(3, 3), true)]]), new Map()).get('a')).toEqual({ type: 'home', hurry: true });
    for (const status of ATTENTION_STATUSES) {
      const a = actor('a', { idle: false, status });
      expect(allowed(a, claim(verified, true)), status).toBe(false);
      expect(resolveDirectives([a], new Map([['a', claim(go(3, 3), true)]]), new Map()).get('a')).toEqual({ type: 'home', hurry: true });
    }
  });

  it('sends a really idle but stale or celebrating actor home calmly', () => {
    const a = actor('a', { idle: false, status: 'idle' });
    expect(resolveDirectives([a], new Map([['a', claim(doAt(3, 3))]]), new Map()).get('a')).toEqual({ type: 'home', hurry: false });
    // a hurried home from a provider is kept
    expect(resolveDirectives([a], new Map([['a', claim(doAt(3, 3))]]), new Map([['a', { type: 'home', hurry: true }]])).get('a')).toEqual({ type: 'home', hurry: true });
  });

  it('passes idle actors through and defaults to a calm home', () => {
    const a = actor('a');
    const b = actor('bb');
    const out = resolveDirectives([a, b], new Map([['a', claim(doAt(3, 3))]]), new Map());
    expect(out.get('a')).toEqual(doAt(3, 3));
    expect(out.get('bb')).toEqual({ type: 'home', hurry: false });
  });
});

describe('resolveDirectives: one worker per destination', () => {
  it('holds the second actor sent to the same tile until it is free', () => {
    const a = actor('a');
    const b = actor('bb');
    const claims = new Map([
      ['a', claim(go(5, 5))],
      ['bb', claim(doAt(5, 5))],
    ]);
    const out = resolveDirectives([a, b], claims, new Map());
    expect(out.get('a')).toEqual(go(5, 5));
    expect(out.get('bb')).toEqual({ type: 'hold' });
    // once a leaves, b gets it
    expect(resolveDirectives([a, b], new Map([['bb', claim(doAt(5, 5))]]), new Map()).get('bb')).toEqual(doAt(5, 5));
  });

  it('lets whoever is already heading there keep the tile, regardless of order', () => {
    const a = actor('a');
    const b = actor('bb', { target: { x: 5, y: 5 } });
    const claims = new Map([
      ['a', claim(go(5, 5))],
      ['bb', claim(go(5, 5))],
    ]);
    const out = resolveDirectives([a, b], claims, new Map());
    expect(out.get('bb')).toEqual(go(5, 5));
    expect(out.get('a')).toEqual({ type: 'hold' });
  });

  it("never sends anyone to another worker's home tile; an actor's own home is fine", () => {
    const a = actor('a', { home: { x: 7, y: 7 } });
    const b = actor('bb');
    const out = resolveDirectives([a, b], new Map([['bb', claim(go(7, 7))]]), new Map());
    expect(out.get('bb')).toEqual({ type: 'hold' });
    const stretch = doAt(7, 7, { activity: 'stretch', pose: 'stretch' });
    expect(resolveDirectives([a], new Map([['a', claim(stretch)]]), new Map()).get('a')).toEqual(stretch);
  });

  it('sends a busy actor whose verified detour is taken on to its desk instead of holding it', () => {
    const idler = actor('a', { target: { x: 4, y: 4 } });
    const sub = actor('bb', { idle: false, status: 'working' });
    const claims = new Map([
      ['a', claim(go(4, 4))],
      ['bb', claim(go(4, 4), true)],
    ]);
    const out = resolveDirectives([idler, sub], claims, new Map());
    expect(out.get('a')).toEqual(go(4, 4));
    expect(out.get('bb')).toEqual({ type: 'home', hurry: false });
  });
});

describe('restPhase', () => {
  it('rests as the home says on the home tile (seated at a desk), standing anywhere else', () => {
    const home = { x: 3, y: 4 };
    expect(restPhase({ x: 3, y: 4 }, home, 'seated', 'standing')).toBe('seated');
    expect(restPhase({ x: 3, y: 5 }, home, 'seated', 'standing')).toBe('standing');
    // the lounge home of an agent without a desk is a standing place
    expect(restPhase(home, home, 'standing', 'standing')).toBe('standing');
    // a worker found standing at its desk by a later `home` directive sits back down
    expect(restPhase({ x: 3, y: 4 }, home, 'seated', 'standing' as string)).toBe('seated');
  });
});
