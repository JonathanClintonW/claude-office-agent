import { describe, expect, it } from 'vitest';
import { defaultLayout, seatOf } from '@agent-office/core';
import type { ActorContext, RoomInfo, Spot, SpotKind } from '../src/office/behavior';
import { allDialogueLines } from '../src/office/dialogue';
import { ACTIVITY_KINDS, buildWorld, IdleDirector, type ActivityKind, type Actor, type Directive, type DirectorOptions, type World } from '../src/office/idleLife';
import type { OfficeWorld } from '../src/office/world';

type LifeWorld = World & Partial<Pick<OfficeWorld, 'lounges' | 'doorways'>>;

function seeded(seed = 42): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

const FAST = { firstDelay: [1000, 1000] as [number, number], cooldown: [5000, 5000] as [number, number], maxAwayShare: 0.5 };
/** One trip per test window. */
const ONCE = { ...FAST, cooldown: [600_000, 600_000] as [number, number] };

function actor(key: string, x: number, y: number, idle = true): Actor {
  return { key, idle, home: { x, y }, pos: { x, y }, moving: false };
}

/** Run the director, teleporting actors to wherever they are told to go. */
function run(director: IdleDirector, actors: Actor[], from: number, ms: number, onTick?: (t: number, d: Map<string, Directive>) => void, step = 200): number {
  let t = from;
  for (; t < from + ms; t += step) {
    const d = director.tick(t, actors);
    for (const a of actors) {
      const di = d.get(a.key);
      if (!di) continue;
      const to = di.type === 'home' ? a.home : di.type === 'go' ? di.to : di.at;
      a.pos = { ...to };
      a.moving = false;
    }
    onTick?.(t, d);
  }
  return t;
}

describe('buildWorld', () => {
  it('finds coffee, water, restrooms, couches and windows with reachable access tiles', () => {
    const layout = defaultLayout();
    const w = buildWorld(layout, [2, 6, 10], false);
    const kinds = w.spots.map((s) => s.kind);
    expect(kinds.filter((k) => k === 'toilet')).toHaveLength(2);
    expect(kinds).toContain('coffee');
    expect(kinds).toContain('water');
    expect(kinds.filter((k) => k === 'couch')).toHaveLength(4);
    expect(kinds.filter((k) => k === 'window').length).toBeGreaterThan(0);
    const seats = new Set(layout.items.filter((i) => i.type === 'desk').map((d) => `${seatOf(d).x},${seatOf(d).y}`));
    for (const t of w.chatTiles) {
      expect(seats.has(`${t.x},${t.y}`)).toBe(false);
      expect(seats.has(`${t.x + 1},${t.y}`)).toBe(false);
    }
  });
});

describe('IdleDirector', () => {
  const coffeeOnly: World = { spots: [{ id: 'c', kind: 'coffee', at: { x: 5, y: 5 }, face: 'up' }], chatTiles: [], rooms: [], night: false };

  it('waits before the first trip, then goes and comes back', () => {
    const d = new IdleDirector(seeded(), ONCE);
    d.setWorld(coffeeOnly);
    const a = actor('a', 1, 1);
    const seen: string[] = [];
    run(d, [a], 0, 900, (_t, m) => seen.push(m.get('a')!.type));
    expect(seen.every((x) => x === 'home')).toBe(true);
    run(d, [a], 1000, 12_000, (_t, m) => seen.push(m.get('a')!.type));
    expect(seen).toContain('do');
    expect(seen.at(-1)).toBe('home');
    expect(a.pos).toEqual(a.home);
  });

  it('never moves agents that are working, waiting or unknown', () => {
    const d = new IdleDirector(seeded(), FAST);
    d.setWorld(coffeeOnly);
    const busy = actor('b', 1, 1, false);
    run(d, [busy], 0, 30_000, (_t, m) => expect(m.get('b')).toEqual({ type: 'home', hurry: false }));
  });

  it('sends an away agent home in a hurry as soon as real work arrives', () => {
    const d = new IdleDirector(seeded(), FAST);
    d.setWorld({ spots: [{ id: 'wc', kind: 'toilet', at: { x: 9, y: 9 }, face: 'up' }], chatTiles: [], rooms: [], night: false });
    const a = actor('a', 1, 1);
    let t = 0;
    let hidden = false;
    t = run(d, [a], t, 8_000, (_tt, m) => {
      const di = m.get('a')!;
      if (di.type === 'do' && di.hidden) hidden = true;
    });
    expect(hidden).toBe(true);
    expect(d.isInUse('wc')).toBe(true);
    a.idle = false; // e.g. a permission request
    const next = d.tick(t, [a]);
    expect(next.get('a')).toEqual({ type: 'home', hurry: true });
    expect(d.isInUse('wc')).toBe(false);
  });

  it('lets only one agent use the restroom at a time', () => {
    const d = new IdleDirector(seeded(7), { ...FAST, maxAwayShare: 1 });
    d.setWorld({ spots: [{ id: 'wc', kind: 'toilet', at: { x: 9, y: 9 }, face: 'up' }], chatTiles: [], rooms: [], night: false });
    const actors = [actor('a', 1, 1), actor('b', 3, 1), actor('c', 5, 1)];
    run(d, actors, 0, 60_000, (_t, m) => {
      const inside = actors.filter((x) => {
        const di = m.get(x.key)!;
        return di.type === 'do' && di.hidden;
      });
      expect(inside.length).toBeLessThanOrEqual(1);
    });
  });

  it('pairs two idle agents for a chat: they face each other and take turns talking', () => {
    const d = new IdleDirector(seeded(3), { ...ONCE, maxAwayShare: 1, activities: ['chat'] });
    d.setWorld({ spots: [], chatTiles: [{ x: 4, y: 6 }], rooms: [], night: false });
    const a = actor('a', 1, 1);
    const b = actor('b', 7, 1);
    let both = 0;
    let overlap = 0;
    const faces = new Set<string>();
    run(d, [a, b], 0, 30_000, (_t, m) => {
      const da = m.get('a')!;
      const db = m.get('b')!;
      if (da.type === 'do' && db.type === 'do' && da.activity === 'chat') {
        both++;
        faces.add(`${da.face}/${db.face}`);
        expect(da.at).toEqual({ x: 4, y: 6 });
        expect(db.at).toEqual({ x: 5, y: 6 });
        if ((da.bubble || da.speech) && (db.bubble || db.speech)) overlap++;
      }
    });
    expect(both).toBeGreaterThan(10);
    expect([...faces]).toEqual(['right/left']);
    expect(overlap).toBe(0);
    expect(a.pos).toEqual(a.home);
    expect(b.pos).toEqual(b.home);
  });

  it('ends the chat for the partner when one agent gets work', () => {
    const d = new IdleDirector(seeded(3), { ...FAST, maxAwayShare: 1, activities: ['chat'] });
    d.setWorld({ spots: [], chatTiles: [{ x: 4, y: 6 }], rooms: [], night: false });
    const a = actor('a', 1, 1);
    const b = actor('b', 7, 1);
    let t = 0;
    let chatting = false;
    while (!chatting && t < 20_000) {
      const m = d.tick(t, [a, b]);
      for (const x of [a, b]) {
        const di = m.get(x.key)!;
        x.pos = { ...(di.type === 'home' ? x.home : di.type === 'go' ? di.to : di.at) };
      }
      chatting = m.get('a')!.type === 'do' && m.get('b')!.type === 'do';
      t += 200;
    }
    expect(chatting).toBe(true);
    a.idle = false;
    const m = d.tick(t, [a, b]);
    expect(m.get('a')).toEqual({ type: 'home', hurry: true });
    expect(m.get('b')!.type).toBe('home');
  });

  it('keeps at least half of the idle agents at their desks', () => {
    const d = new IdleDirector(seeded(11), FAST);
    d.setWorld({
      spots: Array.from({ length: 10 }, (_, i) => ({ id: `w${i}`, kind: 'window' as const, at: { x: i, y: 2 }, face: 'up' as const })),
      chatTiles: [],
      rooms: [],
      night: false,
    });
    const actors = Array.from({ length: 6 }, (_, i) => actor(`a${i}`, i, 8));
    run(d, actors, 0, 60_000, (_t, m) => {
      const away = actors.filter((x) => m.get(x.key)!.type !== 'home').length;
      expect(away).toBeLessThanOrEqual(3);
    });
  });

  it('sends everyone home when disabled', () => {
    const d = new IdleDirector(seeded(), FAST);
    d.setWorld(coffeeOnly);
    const a = actor('a', 1, 1);
    run(d, [a], 0, 2_000);
    d.setEnabled(false);
    expect(d.tick(2_200, [a]).get('a')!.type).toBe('home');
    expect(d.activityOf('a')).toBeUndefined();
  });
});

const spot = (id: string, kind: SpotKind, x: number, y: number, face: Spot['face'] = 'up'): Spot => ({ id, kind, at: { x, y }, face });
const ctx = (over: Partial<ActorContext> = {}): ActorContext => ({ kind: 'session', sessionId: 's', status: 'idle', ...over });
const EMPTY: World = { spots: [], chatTiles: [], rooms: [], night: false };
const COFFEE: World = { ...EMPTY, spots: [spot('c', 'coffee', 5, 5)] };

const RICH: World = {
  spots: [
    spot('c', 'coffee', 2, 3),
    spot('w', 'water', 4, 3),
    spot('s', 'snack', 6, 3),
    spot('b1', 'books', 8, 3),
    spot('nb', 'board', 10, 3),
    spot('wb', 'whiteboard', 12, 3),
    spot('p1', 'plant', 14, 3),
    spot('p2', 'plant', 16, 3),
    spot('wc', 'toilet', 18, 3),
    spot('k', 'couch', 2, 9, 'down'),
    spot('win', 'window', 4, 2),
  ],
  chatTiles: [
    { x: 3, y: 6 },
    { x: 7, y: 6 },
    { x: 11, y: 6 },
    { x: 15, y: 6 },
  ],
  rooms: [],
  night: false,
};

/** RICH plus rooms, a lounge chair and a doorway to another room (strolls and lounges). */
const RICH_ROOMS: World & Partial<Pick<OfficeWorld, 'lounges' | 'doorways'>> = {
  ...RICH,
  rooms: [
    { id: 'lobby', name: 'Lobby', kind: 'reception', x: 0, y: 0, w: 22, h: 9, seats: [], capacity: 0 },
    { id: 'desks', name: 'Desks', kind: 'development', x: 0, y: 9, w: 22, h: 3, seats: [], capacity: 0 },
  ],
  lounges: [{ id: 'l1', at: { x: 20, y: 5 }, face: 'down', roomId: 'lobby' }],
  doorways: [{ roomId: 'lobby', at: { x: 10, y: 8 }, face: 'up' }],
};

const HOMES: Array<[number, number]> = [
  [1, 10],
  [5, 10],
  [9, 10],
  [13, 10],
  [17, 10],
  [19, 10],
];
const crowd = (n = HOMES.length) => HOMES.slice(0, n).map(([x, y], i) => actor(`a${i}`, x, y));

/** Activity starts per actor (from activityOf transitions). */
function trackStarts(d: IdleDirector, actors: Actor[], from: number, ms: number, onTick?: (t: number, m: Map<string, Directive>) => void) {
  const starts = new Map<string, ActivityKind[]>(actors.map((a) => [a.key, []]));
  const prev = new Map<string, ActivityKind | undefined>();
  run(d, actors, from, ms, (t, m) => {
    for (const a of actors) {
      const k = d.activityOf(a.key);
      if (k && k !== prev.get(a.key)) starts.get(a.key)!.push(k);
      prev.set(a.key, k);
    }
    onTick?.(t, m);
  });
  return starts;
}

describe('IdleDirector activities', () => {
  it('does every activity the world supports, each with its own pose', () => {
    const d = new IdleDirector(seeded(5), { ...FAST, maxAwayShare: 1 });
    d.setWorld(RICH_ROOMS);
    const actors = crowd();
    const homes = new Map(actors.map((a) => [a.key, { ...a.home }]));
    const poses = new Map<string, Set<string>>();
    run(d, actors, 0, 30 * 60_000, (_t, m) => {
      for (const [k, di] of m) {
        if (di.type !== 'do') continue;
        if (!poses.has(di.activity)) poses.set(di.activity, new Set());
        poses.get(di.activity)!.add(di.pose);
        if (di.activity === 'walk') expect(RICH.chatTiles).toContainEqual(di.at);
        if (di.activity === 'stretch') expect(di.at).toEqual(homes.get(k));
      }
    });
    const all: ActivityKind[] = ['chat', 'coffee', 'water', 'snack', 'toilet', 'couch', 'window', 'books', 'board', 'whiteboard', 'plant', 'stretch', 'walk', 'stroll', 'lounge'];
    for (const k of all) expect(poses.has(k), k).toBe(true);
    expect(poses.get('snack')).toContain('eat');
    expect(poses.get('books')).toContain('read');
    expect(poses.get('stretch')).toContain('stretch');
    expect(poses.get('water')).toContain('drink');
    expect(poses.get('couch')).toContain('couch');
    expect(poses.get('chat')).toContain('talk');
    expect(poses.get('lounge')).toContain('sit_meeting');
    // Real work for everyone: all activities end at once.
    for (const a of actors) a.idle = false;
    const m = d.tick(30 * 60_000, actors);
    for (const a of actors) {
      expect(m.get(a.key)!.type).toBe('home');
      expect(d.activityOf(a.key)).toBeUndefined();
    }
  });

  it('skips spot kinds the world does not have', () => {
    const seen = (world: World) => {
      const d = new IdleDirector(seeded(9), { ...FAST, maxAwayShare: 1 });
      d.setWorld(world);
      const kinds = new Set<string>();
      run(d, crowd(3), 0, 20 * 60_000, (_t, m) => {
        for (const di of m.values()) if (di.type === 'do') kinds.add(di.activity);
      });
      return [...kinds].sort();
    };
    expect(seen(COFFEE)).toEqual(['coffee', 'stretch']);
    expect(seen(EMPTY)).toEqual(['stretch']);
  });

  it('never repeats an activity immediately and caps concurrent actors per kind', () => {
    const many: World = {
      ...EMPTY,
      spots: [...Array.from({ length: 8 }, (_, i) => spot(`win${i}`, 'window', i * 2, 2)), ...Array.from({ length: 8 }, (_, i) => spot(`p${i}`, 'plant', i * 2, 4))],
    };
    for (const cap of [1, 2]) {
      const d = new IdleDirector(seeded(21 + cap), { ...FAST, maxAwayShare: 1, maxPerKind: cap });
      d.setWorld(many);
      const actors = Array.from({ length: 8 }, (_, i) => actor(`a${i}`, i * 2, 9));
      let peak = 0;
      const starts = trackStarts(d, actors, 0, 20 * 60_000, () => {
        const counts = new Map<string, number>();
        for (const a of actors) {
          const k = d.activityOf(a.key);
          if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
        }
        for (const n of counts.values()) {
          expect(n).toBeLessThanOrEqual(cap);
          peak = Math.max(peak, n);
        }
      });
      expect(peak).toBe(cap);
      for (const seq of starts.values()) {
        expect(seq.length).toBeGreaterThan(2);
        for (let i = 1; i < seq.length; i++) expect(seq[i]).not.toBe(seq[i - 1]);
      }
    }
  });

  it('caps simultaneous chats (conversations, not people)', () => {
    const d = new IdleDirector(seeded(4), { ...FAST, maxAwayShare: 1, activities: ['chat', 'stretch'] });
    d.setWorld({ ...EMPTY, chatTiles: Array.from({ length: 10 }, (_, i) => ({ x: i * 3, y: 6 })) });
    const actors = Array.from({ length: 10 }, (_, i) => actor(`a${i}`, i * 3, 10));
    let peak = 0;
    run(d, actors, 0, 20 * 60_000, () => {
      const chatting = actors.filter((a) => d.activityOf(a.key) === 'chat').length;
      expect(chatting).toBeLessThanOrEqual(4);
      peak = Math.max(peak, chatting);
    });
    expect(peak).toBe(4);
  });
});

describe('IdleDirector frequency', () => {
  const firstStart = (freq: number, afterFirstTick = false) => {
    const d = new IdleDirector(seeded(1), { firstDelay: [10_000, 10_000], cooldown: [10_000, 10_000], maxAwayShare: 1, activities: ['coffee'] });
    d.setWorld(COFFEE);
    if (!afterFirstTick) d.setFrequency(freq);
    const a = actor('a', 1, 1);
    for (let t = 0; t < 60_000; t += 100) {
      d.tick(t, [a]);
      if (t === 0 && afterFirstTick) d.setFrequency(freq);
      if (d.activityOf('a')) return t;
    }
    return -1;
  };

  it('scales the first delay by 1/multiplier, including waits already scheduled', () => {
    expect(firstStart(1)).toBe(10_000);
    expect(firstStart(2)).toBe(5_000);
    expect(firstStart(0.5)).toBe(20_000);
    expect(firstStart(2, true)).toBe(5_000);
  });

  it('makes trips more or less frequent', () => {
    const trips = (freq: number) => {
      const d = new IdleDirector(seeded(1), { firstDelay: [10_000, 10_000], cooldown: [20_000, 20_000], maxAwayShare: 1 });
      d.setWorld(COFFEE);
      d.setFrequency(freq);
      const starts = trackStarts(d, [actor('a', 1, 1)], 0, 10 * 60_000);
      return starts.get('a')!.length;
    };
    const [low, normal, high] = [trips(0.5), trips(1), trips(2)];
    expect(high).toBeGreaterThan(normal);
    expect(normal).toBeGreaterThan(low);
  });

  it('ignores invalid multipliers and clamps extremes', () => {
    const d = new IdleDirector(seeded(), FAST);
    d.setFrequency(Number.NaN);
    expect(d.frequency).toBe(1);
    d.setFrequency(0);
    expect(d.frequency).toBe(1);
    d.setFrequency(1000);
    expect(d.frequency).toBe(10);
  });
});

describe('IdleDirector simulated speech', () => {
  const LINES = new Set(allDialogueLines());

  it('only ever says verbatim template lines, in chats and sometimes solo, never in the restroom', () => {
    const d = new IdleDirector(seeded(13), { ...FAST, maxAwayShare: 1, soloSpeechChance: 1, smallTalkChance: 0.5, hourOf: () => 9 });
    d.setWorld(RICH);
    const contexts: ActorContext[] = [
      ctx({ recentFailure: { kind: 'test', at: 0 } }),
      ctx({ lastWorkMs: 30 * 60_000 }),
      ctx({ finishedAt: 0 }),
      ctx(),
      ctx({ kind: 'teammate' }),
      ctx({ kind: 'teammate', recentFailure: { kind: 'build', at: 0 } }),
    ];
    const actors = crowd().map((a, i) => ({ ...a, ctx: contexts[i] }));
    let chat = 0;
    let solo = 0;
    const speakers = new Set<string>();
    run(d, actors, 0, 30 * 60_000, (_t, m) => {
      for (const [k, di] of m) {
        if (di.type !== 'do' || di.speech === undefined) continue;
        expect(LINES.has(di.speech), di.speech).toBe(true);
        expect(di.activity).not.toBe('toilet');
        expect(di.bubble).toBeUndefined();
        if (di.activity === 'chat') {
          chat++;
          speakers.add(k);
        } else solo++;
      }
    });
    expect(chat).toBeGreaterThan(0);
    expect(solo).toBeGreaterThan(0);
    expect(speakers.size).toBeGreaterThanOrEqual(2);
  });

  it('alternates speakers in a chat and never talks over each other', () => {
    const d = new IdleDirector(seeded(8), { ...ONCE, maxAwayShare: 1, activities: ['chat'], smallTalkChance: 1 });
    d.setWorld({ ...EMPTY, chatTiles: [{ x: 4, y: 6 }] });
    const a = actor('a', 1, 1);
    const b = actor('b', 7, 1);
    const turns: string[] = [];
    run(d, [a, b], 0, 30_000, (_t, m) => {
      const da = m.get('a')!;
      const db = m.get('b')!;
      const sa = da.type === 'do' && (da.speech || da.bubble);
      const sb = db.type === 'do' && (db.speech || db.bubble);
      expect(sa && sb).toBeFalsy();
      const who = sa ? 'a' : sb ? 'b' : undefined;
      if (who && turns.at(-1) !== who) turns.push(who);
    });
    expect(turns.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < turns.length; i++) expect(turns[i]).not.toBe(turns[i - 1]);
  });

  const conversation = (partner: ActorContext, hour = 14): Array<[string, string]> => {
    const t0 = 1_000_000;
    const d = new IdleDirector(() => 0, { ...ONCE, maxAwayShare: 1, activities: ['chat'], hourOf: () => hour });
    d.setWorld({ ...EMPTY, chatTiles: [{ x: 4, y: 6 }] });
    const a = { ...actor('a', 1, 1), ctx: ctx() };
    const b = { ...actor('b', 7, 1), ctx: { ...partner, recentFailure: partner.recentFailure && { ...partner.recentFailure, at: t0 - 60_000 }, finishedAt: partner.finishedAt && t0 } };
    const said: Array<[string, string]> = [];
    run(d, [a, b], t0, 30_000, (_t, m) => {
      for (const k of ['a', 'b']) {
        const di = m.get(k)!;
        if (di.type === 'do' && di.speech && said.at(-1)?.[1] !== di.speech) said.push([k, di.speech]);
      }
    });
    return said;
  };

  it('chooses lines from real context: a partner with a recent test failure', () => {
    const said = conversation(ctx({ recentFailure: { kind: 'test', at: 0 } }));
    expect(said[0]).toEqual(['a', 'Another bug?']);
    expect(said[1]).toEqual(['b', 'Those tests are giving me trouble.']);
  });

  it('chooses lines from real context: a partner that just finished', () => {
    const said = conversation(ctx({ finishedAt: 1 }));
    expect(said[0]).toEqual(['a', 'All done?']);
    expect(said[1]).toEqual(['b', 'Done for now!']);
  });

  it('chooses lines from the clock when nothing else is known', () => {
    expect(conversation(ctx(), 22)[0]).toEqual(['a', 'Working late?']);
    expect(conversation(ctx(), 14)[0]).toEqual(['a', "How's your project going?"]);
  });
});

describe('IdleDirector priorities', () => {
  const until = (d: IdleDirector, actors: Actor[], cond: () => boolean, from = 0): number => {
    let t = from;
    for (; t < from + 60_000 && !cond(); t += 200) run(d, actors, t, 200);
    return t;
  };

  it('real work interrupts a chat: home in a hurry, partner home, no more speech', () => {
    const d = new IdleDirector(seeded(3), { ...FAST, maxAwayShare: 1, activities: ['chat'] });
    d.setWorld({ ...EMPTY, chatTiles: [{ x: 4, y: 6 }] });
    const a = actor('a', 1, 1);
    const b = actor('b', 7, 1);
    let speaking = false;
    let t = 0;
    for (; t < 30_000 && !speaking; t += 200) {
      const m = d.tick(t, [a, b]);
      for (const x of [a, b]) {
        const di = m.get(x.key)!;
        x.pos = { ...(di.type === 'home' ? x.home : di.type === 'go' ? di.to : di.at) };
        if (di.type === 'do' && di.speech) speaking = true;
      }
    }
    expect(speaking).toBe(true);
    a.idle = false;
    const m = d.tick(t, [a, b]);
    expect(m.get('a')).toEqual({ type: 'home', hurry: true });
    expect(m.get('b')!.type).toBe('home');
    run(d, [a, b], t + 200, 20_000, (_t, mm) => {
      for (const di of mm.values()) if (di.type === 'do') expect(di.speech).toBeUndefined();
      expect(mm.get('a')!.type).toBe('home');
    });
  });

  it('an actor claimed by a higher-priority provider aborts and goes home calmly', () => {
    const d = new IdleDirector(seeded(), { ...FAST, activities: ['coffee'] });
    d.setWorld(COFFEE);
    const a = { ...actor('a', 1, 1), ctx: ctx() };
    const t = until(d, [a], () => d.activityOf('a') === 'coffee');
    a.idle = false; // claimed: real status is still idle
    expect(d.tick(t, [a]).get('a')).toEqual({ type: 'home', hurry: false });
    expect(d.activityOf('a')).toBeUndefined();
    expect(d.isInUse('c')).toBe(false);
  });

  it('hurries home when the real status changes even with context', () => {
    const d = new IdleDirector(seeded(), { ...FAST, activities: ['coffee'] });
    d.setWorld(COFFEE);
    const a = { ...actor('a', 1, 1), ctx: ctx() };
    const t = until(d, [a], () => d.activityOf('a') === 'coffee');
    a.idle = false;
    a.ctx = ctx({ status: 'waiting_permission' });
    expect(d.tick(t, [a]).get('a')).toEqual({ type: 'home', hurry: true });
  });

  it('never schedules an actor another provider has away, nor picks it as a chat partner', () => {
    const d = new IdleDirector(seeded(3), { ...FAST, maxAwayShare: 1 });
    d.setWorld({ ...COFFEE, chatTiles: [{ x: 4, y: 6 }] });
    const a = { ...actor('a', 1, 1), away: true };
    run(d, [a], 0, 60_000, (_t, m) => {
      expect(m.get('a')).toEqual({ type: 'home', hurry: false });
      expect(d.activityOf('a')).toBeUndefined();
    });
    const c = new IdleDirector(seeded(3), { ...FAST, maxAwayShare: 1, activities: ['chat'] });
    c.setWorld({ ...EMPTY, chatTiles: [{ x: 4, y: 6 }] });
    const x = actor('x', 1, 1);
    const y = { ...actor('y', 7, 1), away: true };
    run(c, [x, y], 0, 60_000, (_t, m) => {
      expect(m.get('x')!.type).toBe('home');
      expect(m.get('y')!.type).toBe('home');
    });
  });

  it('gives up calmly when the target is never reached', () => {
    const d = new IdleDirector(seeded(), { ...FAST, activities: ['coffee'] });
    d.setWorld(COFFEE);
    const a = actor('a', 1, 1); // never moves (path blocked)
    let last: Directive | undefined;
    for (let t = 0; t <= 50_000; t += 500) last = d.tick(t, [a]).get('a');
    expect(last).toEqual({ type: 'home', hurry: false });
    expect(d.activityOf('a')).toBeUndefined();
  });

  it('is deterministic for a seeded RNG', () => {
    const trace = (seed: number) => {
      const d = new IdleDirector(seeded(seed), { ...FAST, maxAwayShare: 1, soloSpeechChance: 0.5, hourOf: () => 15 });
      d.setWorld(RICH);
      const actors = crowd().map((a, i) => ({ ...a, ctx: ctx(i % 2 ? { lastWorkMs: 40 * 60_000 } : { recentFailure: { kind: 'tool', at: 0 } }) }));
      const out: string[] = [];
      run(d, actors, 0, 10 * 60_000, (_t, m) => out.push(JSON.stringify([...m])));
      return out.join('\n');
    };
    expect(trace(77)).toBe(trace(77));
    expect(trace(77)).not.toBe(trace(78));
  });
});

// Type check: DirectorOptions must not gain required fields.
const _legacyOptions: DirectorOptions = { firstDelay: [1, 2], cooldown: [3, 4], maxAwayShare: 0.5 };
void _legacyOptions;

const room = (id: string, kind: RoomInfo['kind'], x: number, y: number, w: number, h: number): RoomInfo => ({ id, name: id, kind, x, y, w, h, seats: [], capacity: 0 });

/** A world with every activity: spots and chat tiles in a lobby, a lounge chair, doorways, desks below. */
const ALL: LifeWorld = {
  ...RICH,
  rooms: [room('lobby', 'reception', 0, 0, 24, 8), room('wc', 'restroom', 24, 0, 4, 8), room('desks', 'development', 0, 12, 24, 4)],
  lounges: [{ id: 'l1', at: { x: 20, y: 5 }, face: 'down', roomId: 'lobby' }],
  doorways: [
    { roomId: 'lobby', at: { x: 12, y: 7 }, face: 'up' },
    { roomId: 'wc', at: { x: 25, y: 7 }, face: 'up' },
    { roomId: 'desks', at: { x: 9, y: 12 }, face: 'down' },
  ],
};

/** One tile per tick towards `to` (x first), like a worker walking. */
function step(a: Actor, to: { x: number; y: number }): void {
  if (a.pos.x !== to.x) a.pos = { x: a.pos.x + Math.sign(to.x - a.pos.x), y: a.pos.y };
  else if (a.pos.y !== to.y) a.pos = { x: a.pos.x, y: a.pos.y + Math.sign(to.y - a.pos.y) };
  a.moving = a.pos.x !== to.x || a.pos.y !== to.y;
}

function walkAll(actors: Actor[], m: Map<string, Directive>): void {
  for (const x of actors) {
    const di = m.get(x.key);
    if (di) step(x, di.type === 'home' ? x.home : di.type === 'go' ? di.to : di.at);
  }
}

describe('IdleDirector: real events always win, for every activity and phase', () => {
  for (const kind of ACTIVITY_KINDS)
    for (const phase of ['go', 'do', 'back'] as const) {
      if (kind === 'stretch' && phase !== 'do') continue; // done in place at the desk
      it(`${kind}: real work during '${phase}' sends the actor home in a hurry, and nothing simulated follows`, () => {
        const d = new IdleDirector(seeded(17), { ...FAST, maxAwayShare: 1, activities: [kind], soloSpeechChance: 1 });
        d.setWorld(ALL);
        const a = { ...actor('a', 1, 14), ctx: ctx() };
        const b = { ...actor('b', 5, 14), ctx: ctx() };
        const actors = [a, b];
        let t = 0;
        let seenDo = false;
        let hit = false;
        for (; t < 300_000 && !hit; t += 200) {
          const m = d.tick(t, actors);
          const di = m.get('a')!;
          if (di.type === 'do') seenDo = true;
          hit =
            phase === 'go'
              ? di.type === 'go' && a.moving
              : phase === 'do'
                ? di.type === 'do' && !a.moving && d.activityOf('a') === kind && (kind !== 'chat' || m.get('b')!.type === 'do')
                : seenDo && di.type === 'home' && a.moving && d.activityOf('a') === kind;
          if (!hit) walkAll(actors, m);
        }
        expect(hit, `reached phase ${phase}`).toBe(true);
        // a real tool event arrives
        a.idle = false;
        a.ctx = ctx({ status: 'working' });
        expect(d.tick(t, actors).get('a')).toEqual({ type: 'home', hurry: true });
        expect(d.activityOf('a')).toBeUndefined();
        for (const id of ['wc', 'c', 'k']) expect(d.isInUse(id)).toBe(false);
        for (let u = t + 200; u < t + 30_000; u += 200) {
          const m = d.tick(u, actors);
          const di = m.get('a')!;
          expect(di.type).toBe('home');
          if (a.moving || a.pos.x !== a.home.x || a.pos.y !== a.home.y) expect(di).toEqual({ type: 'home', hurry: true });
          walkAll(actors, m);
        }
        expect(a.pos).toEqual(a.home);
        expect(d.activityOf('a')).toBeUndefined();
      });
    }

  it('hurries an actor that was already walking back without an activity', () => {
    const d = new IdleDirector(seeded(3), { ...FAST, activities: ['coffee'] });
    d.setWorld(COFFEE);
    const a = { ...actor('a', 1, 14), ctx: ctx() };
    let t = 0;
    const far = () => Math.abs(a.pos.x - a.home.x) + Math.abs(a.pos.y - a.home.y) >= 3;
    for (; t < 60_000 && !(d.activityOf('a') && a.moving && far()); t += 200) walkAll([a], d.tick(t, [a]));
    // claimed by another provider (still really idle): the activity ends calmly...
    a.idle = false;
    expect(d.tick(t, [a]).get('a')).toEqual({ type: 'home', hurry: false });
    step(a, a.home);
    expect(a.moving).toBe(true);
    // ...then real work arrives while it is still on its way back: now it hurries
    a.ctx = ctx({ status: 'waiting_permission' });
    expect(d.tick(t + 200, [a]).get('a')).toEqual({ type: 'home', hurry: true });
  });

  it('switching idle life off or moving furniture sends actors home calmly (no real status change)', () => {
    const world: World = { ...EMPTY, spots: [spot('c', 'coffee', 5, 5), spot('w', 'water', 7, 5)] };
    const d = new IdleDirector(seeded(), { ...FAST, activities: ['coffee', 'water'] });
    d.setWorld(world);
    const a = { ...actor('a', 1, 1), ctx: ctx() };
    let t = 0;
    for (; t < 60_000 && !d.activityOf('a'); t += 200) run(d, [a], t, 200);
    d.setEnabled(false);
    expect(d.tick(t + 200, [a]).get('a')).toEqual({ type: 'home', hurry: false });
    d.setEnabled(true);
    for (t += 400; t < 120_000 && !d.activityOf('a'); t += 200) run(d, [a], t, 200);
    const kind = d.activityOf('a');
    expect(kind).toBeDefined();
    // only the lighting changed: the activity goes on
    d.setWorld({ ...world, night: true });
    expect(d.activityOf('a')).toBe(kind);
    // the furniture moved: back home, calmly
    d.setWorld({ ...world, spots: [spot('c', 'coffee', 9, 9), spot('w', 'water', 7, 7)] });
    expect(d.activityOf('a')).toBeUndefined();
    expect(d.tick(t + 200, [a]).get('a')).toEqual({ type: 'home', hurry: false });
  });
});

describe('IdleDirector strolls and lounge chairs', () => {
  it("strolls to another room's doorway (never its own room or the restroom), looks around and walks back", () => {
    const d = new IdleDirector(seeded(2), { ...ONCE, activities: ['stroll'], soloSpeechChance: 1 });
    d.setWorld(ALL);
    const a = { ...actor('a', 1, 14), ctx: { ...ctx(), homeRoomId: 'desks' } };
    const faces = new Set<string>();
    const lines = new Set<string>();
    let did = 0;
    run(d, [a], 0, 30_000, (_t, m) => {
      const di = m.get('a')!;
      if (di.type === 'go') expect(di.to).toEqual({ x: 12, y: 7 });
      if (di.type !== 'do') return;
      did++;
      expect(di.activity).toBe('stroll');
      expect(di.at).toEqual({ x: 12, y: 7 });
      expect(di.pose).toBe('stand');
      faces.add(di.face);
      if (di.speech) lines.add(di.speech);
    });
    expect(did).toBeGreaterThan(5);
    expect(faces).toContain('up'); // looking into the lobby
    expect(faces.size).toBeGreaterThan(1); // and around
    for (const l of lines) expect(['Stretching my legs.', 'Quick walk.']).toContain(l);
    expect(a.pos).toEqual(a.home);
  });

  it('skips strolls when there is no other room to visit', () => {
    const d = new IdleDirector(seeded(2), { ...FAST, activities: ['stroll'] });
    d.setWorld({ ...ALL, doorways: ALL.doorways!.filter((x) => x.roomId !== 'lobby') });
    const a = { ...actor('a', 1, 14), ctx: { ...ctx(), homeRoomId: 'desks' } };
    run(d, [a], 0, 60_000, (_t, m) => expect(m.get('a')!.type).toBe('home'));
  });

  it('sits in a free lounge chair for a while, one actor per chair', () => {
    const d = new IdleDirector(seeded(4), { ...FAST, maxAwayShare: 1, activities: ['lounge', 'stretch'] });
    d.setWorld(ALL);
    const actors = [actor('a', 1, 14), actor('b', 5, 14), actor('c', 9, 14)];
    let seated = 0;
    run(d, actors, 0, 20 * 60_000, (_t, m) => {
      const on = actors.filter((x) => {
        const di = m.get(x.key)!;
        return di.type === 'do' && di.activity === 'lounge';
      });
      expect(on.length).toBeLessThanOrEqual(1);
      for (const x of on) {
        const di = m.get(x.key) as Extract<Directive, { type: 'do' }>;
        expect(di.at).toEqual({ x: 20, y: 5 });
        expect(di.pose).toBe('sit_meeting');
        seated++;
      }
    });
    expect(seated).toBeGreaterThan(20);
  });
});

describe('IdleDirector room capacity and shared tiles', () => {
  const crowded: LifeWorld = {
    ...EMPTY,
    rooms: [room('break', 'break', 0, 0, 12, 6)],
    spots: [spot('k1', 'couch', 1, 2), spot('k2', 'couch', 2, 2), spot('k3', 'couch', 3, 2), spot('w', 'water', 5, 2), spot('s', 'snack', 7, 2), spot('c', 'coffee', 9, 2)].map((s) => ({
      ...s,
      roomId: 'break',
    })),
  };
  const inBreak = (p: { x: number; y: number }) => p.x < 12 && p.y < 6;

  it('never sends more than maxPerRoom people into one room', () => {
    for (const cap of [1, 2, 3]) {
      const d = new IdleDirector(seeded(30 + cap), { ...FAST, maxAwayShare: 1, maxPerKind: 3, maxPerRoom: cap });
      d.setWorld(crowded);
      const actors = Array.from({ length: 6 }, (_, i) => actor(`a${i}`, i * 2, 12));
      let peak = 0;
      run(d, actors, 0, 20 * 60_000, (_t, m) => {
        const n = actors.filter((x) => {
          const di = m.get(x.key)!;
          return di.type !== 'home' && inBreak(di.type === 'go' ? di.to : di.at);
        }).length;
        expect(n).toBeLessThanOrEqual(cap);
        peak = Math.max(peak, n);
      });
      expect(peak).toBe(cap);
    }
  });

  it('counts people another provider has in the room', () => {
    const d = new IdleDirector(seeded(8), { ...FAST, maxAwayShare: 1, maxPerRoom: 2, activities: ['couch', 'water', 'snack', 'coffee'] });
    d.setWorld(crowded);
    // two actors at a (simulated) group break, standing in the room
    const guests = [
      { ...actor('g1', 0, 12), pos: { x: 4, y: 4 }, away: true },
      { ...actor('g2', 2, 12), pos: { x: 6, y: 4 }, away: true },
    ];
    const actors = [...guests, actor('a', 8, 12), actor('b', 10, 12)];
    for (let t = 0; t < 10 * 60_000; t += 200) {
      const m = d.tick(t, actors);
      for (const x of actors.slice(2)) expect(m.get(x.key)!.type, x.key).toBe('home');
    }
  });

  it('never gives two actors the same tile, even when a spot, a doorway and a chat tile coincide', () => {
    const w: LifeWorld = {
      ...EMPTY,
      rooms: [room('lobby', 'reception', 0, 0, 24, 8), room('desks', 'development', 0, 12, 24, 4)],
      spots: [spot('b', 'books', 12, 7)],
      chatTiles: [{ x: 11, y: 7 }],
      lounges: [{ id: 'l', at: { x: 12, y: 7 }, face: 'down', roomId: 'lobby' }],
      doorways: [{ roomId: 'lobby', at: { x: 12, y: 7 }, face: 'up' }],
    };
    const d = new IdleDirector(seeded(12), { ...FAST, maxAwayShare: 1, maxPerKind: 3, activities: ['books', 'walk', 'stroll', 'lounge', 'chat'] });
    d.setWorld(w);
    const actors = Array.from({ length: 6 }, (_, i) => ({ ...actor(`a${i}`, i * 3, 14), ctx: { ...ctx(), homeRoomId: 'desks' } }));
    const kinds = new Set<string>();
    run(d, actors, 0, 30 * 60_000, (_t, m) => {
      const taken = new Map<string, string>();
      for (const x of actors) {
        const di = m.get(x.key)!;
        if (di.type === 'home') continue;
        if (di.type === 'do') kinds.add(di.activity);
        const p = di.type === 'go' ? di.to : di.at;
        const k = `${p.x},${p.y}`;
        expect(taken.get(k), k).toBeUndefined();
        taken.set(k, x.key);
      }
    });
    expect(kinds.size).toBeGreaterThanOrEqual(3);
  });
});
