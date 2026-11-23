import { describe, expect, it } from 'vitest';
import { defaultLayout, seatOf } from '@agent-office/core';
import { BREAK_RESERVE, coinsEarned, DESK_ITEMS, Economy, ESPRESSO_COFFEE_PRICE, OFFICE_KEY, PIZZA_PARTY, purchaseName, SHOP, shopItem, topEarner, type KeyValueStore } from '../src/economy';
import type { Actor } from '../src/office/behavior';
import { buildWorld, IdleDirector, type ActivityKind } from '../src/office/idleLife';

function memoryStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

const NOW = Date.now();

describe('shop catalog', () => {
  it('has unique items, free water, priced breaks and desk upgrades in rising price order', () => {
    expect(new Set(SHOP.map((i) => i.id)).size).toBe(SHOP.length);
    expect(shopItem('water').price).toBe(0);
    expect(shopItem('coffee').price).toBeGreaterThan(0);
    expect(shopItem('snack').price).toBeGreaterThan(0);
    const prices = DESK_ITEMS.map((d) => d.price);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
    expect(DESK_ITEMS.map((d) => d.id)).toEqual(['plant', 'duck', 'lamp', 'photo', 'chair']);
  });

  it('pays 1 coin per whole second of observed work', () => {
    expect(coinsEarned(0)).toBe(0);
    expect(coinsEarned(999)).toBe(0);
    expect(coinsEarned(61_500)).toBe(61);
    expect(coinsEarned(-5)).toBe(0);
  });
});

describe('Economy ledger', () => {
  it('only spends coins that were earned and never goes negative', () => {
    const e = new Economy();
    expect(e.balance('a', 25)).toBe(25);
    expect(e.buy('a', 'coffee', 25, NOW)).toBeUndefined(); // 30 > 25
    const p = e.buy('a', 'snack', 25, NOW);
    expect(p).toMatchObject({ agentKey: 'a', item: 'snack', price: 20 });
    expect(e.balance('a', 25)).toBe(5);
    expect(e.spent('a')).toBe(20);
    expect(e.balance('a', 10)).toBe(0); // earnings went down (e.g. state reset): clamp at 0
    expect(e.buy('a', 'water', 0, NOW)).toMatchObject({ price: 0 });
    expect(e.purchases('a')).toBe(2);
  });

  it('buys desk upgrades in order, once each, keeping a reserve for breaks', () => {
    const e = new Economy();
    const plant = shopItem('plant').price;
    expect(e.nextDeskItem('a', plant + BREAK_RESERVE - 1)).toBeUndefined();
    expect(e.nextDeskItem('a', plant + BREAK_RESERVE)?.id).toBe('plant');
    expect(e.buy('a', 'plant', 10_000, NOW)).toBeDefined();
    expect(e.buy('a', 'plant', 10_000, NOW)).toBeUndefined(); // already owned
    expect(e.nextDeskItem('a', 10_000)?.id).toBe('duck');
    for (const id of ['duck', 'lamp', 'photo', 'chair'] as const) e.buy('a', id, 10_000, NOW);
    expect(e.items('a')).toEqual(['plant', 'duck', 'lamp', 'photo', 'chair']);
    expect(e.nextDeskItem('a', 1_000_000)).toBeUndefined();
  });

  it('persists, survives corrupt storage, forgets long-gone agents and resets', () => {
    const store = memoryStore();
    const e = new Economy(store);
    e.buy('a', 'coffee', 100, NOW);
    e.buy('a', 'plant', 1000, NOW);
    const again = new Economy(store);
    expect(again.spent('a')).toBe(30 + 120);
    expect(again.items('a')).toEqual(['plant']);
    expect(again.recent()[0]).toMatchObject({ agentKey: 'a', item: 'plant' });

    store.data.set('agent-office:economy', '{not json');
    expect(new Economy(store).spent('a')).toBe(0);
    store.data.set('agent-office:economy', JSON.stringify({ v: 1, accounts: { old: { spent: 5, items: ['plant', 'bogus'], lastSeen: 0 }, b: { spent: -1 } } }));
    const loaded = new Economy(store);
    expect(loaded.spent('old')).toBe(0); // not seen for months
    expect(loaded.spent('b')).toBe(0); // invalid

    let calls = 0;
    e.subscribe(() => calls++);
    e.reset();
    expect(calls).toBe(1);
    expect(e.spent('a')).toBe(0);
    expect(e.recent()).toEqual([]);
  });
});

describe('idle life with office coins', () => {
  function seeded(seed = 7): () => number {
    let s = seed;
    return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
  }
  const PRICES: Partial<Record<ActivityKind, number>> = { coffee: 30, snack: 20 };

  function simulate(coins: number) {
    const layout = defaultLayout();
    const world = buildWorld(layout, [2, 6, 10], false);
    const seats = layout.items.filter((i) => i.type === 'desk').slice(0, 6).map(seatOf);
    const paid: ActivityKind[] = [];
    const started = new Set<string>();
    const director = new IdleDirector(seeded(), {
      firstDelay: [1000, 1000],
      cooldown: [3000, 3000],
      maxAwayShare: 1,
      priceOf: (k) => PRICES[k],
      onPaid: (_key, kind) => paid.push(kind),
    });
    director.setWorld(world);
    const actors: Actor[] = seats.map((s, i) => ({
      key: `a${i}`,
      idle: true,
      home: { ...s },
      pos: { ...s },
      moving: false,
      ctx: { kind: 'session', sessionId: `s${i}`, status: 'idle', coins },
    }));
    for (let t = NOW; t < NOW + 30 * 60_000; t += 200) {
      const d = director.tick(t, actors);
      for (const a of actors) {
        const di = d.get(a.key);
        if (!di) continue;
        if (di.type === 'do') started.add(`${a.key}:${di.activity}:${di.at.x},${di.at.y}`);
        a.pos = { ...(di.type === 'home' ? a.home : di.type === 'go' ? di.to : di.at) };
      }
    }
    const kinds = [...started].map((s) => s.split(':')[1]);
    return { paid, kinds };
  }

  it('never takes a break the agent cannot afford', () => {
    const { paid, kinds } = simulate(10);
    expect(paid).toEqual([]);
    expect(kinds).not.toContain('coffee');
    expect(kinds).not.toContain('snack');
    expect(kinds.length).toBeGreaterThan(0); // free activities still happen
  });

  it('charges each paid break once, on arrival at the machine', () => {
    const { paid } = simulate(1_000_000);
    expect(paid.length).toBeGreaterThan(0);
    expect(paid.every((k) => k === 'coffee' || k === 'snack')).toBe(true);
  });
});

describe('office fund, shared upgrades and pizza parties', () => {
  it('collects what agents spend and buys shared upgrades in order once it can pay', () => {
    const e = new Economy();
    expect(e.fund()).toEqual({ income: 0, spent: 0, balance: 0 });
    e.buy('a', 'coffee', 10_000, NOW);
    e.buy('a', 'plant', 10_000, NOW);
    expect(e.fund().income).toBe(30 + 120);
    expect(e.nextOfficeUpgrade()?.id).toBe('espresso');
    expect(e.buyOfficeUpgrade(NOW)).toBeUndefined(); // 150 < 250
    e.buy('b', 'duck', 10_000, NOW); // +300
    expect(e.buyOfficeUpgrade(NOW)?.id).toBe('espresso');
    expect(e.fund()).toEqual({ income: 450, spent: 250, balance: 200 });
    expect(e.recent()[0]).toMatchObject({ agentKey: OFFICE_KEY, item: 'espresso', price: 250 });
    expect(e.nextOfficeUpgrade()?.id).toBe('arcade');
  });

  it('makes coffee cheaper with the espresso machine', () => {
    const e = new Economy();
    expect(e.price('coffee')).toBe(30);
    e.buy('a', 'chair', 100_000, NOW); // 2400 into the fund
    e.buyOfficeUpgrade(NOW);
    expect(e.hasUpgrade('espresso')).toBe(true);
    expect(e.price('coffee')).toBe(ESPRESSO_COFFEE_PRICE);
    expect(e.buy('b', 'coffee', 25, NOW)?.price).toBe(ESPRESSO_COFFEE_PRICE);
    expect(purchaseName('espresso')).toBe('Espresso machine');
  });

  it('splits a pizza party across the team, covering short members, with a cooldown', () => {
    const e = new Economy();
    const team = [
      { key: 'lead', earned: 200 },
      { key: 'sub1', earned: 30 },
      { key: 'sub2', earned: 100 },
    ];
    expect(e.payParty(team.slice(0, 2), 's1', NOW)).toBe(false); // fewer than 3
    expect(e.payParty(team, 's1', NOW)).toBe(true);
    const paid = e.spent('lead') + e.spent('sub1') + e.spent('sub2');
    expect(paid).toBe(PIZZA_PARTY.price);
    expect(e.spent('sub1')).toBe(30); // all it had
    expect(e.balance('sub2', 100)).toBeGreaterThanOrEqual(0);
    expect(e.fund().income).toBe(0); // pizza money does not go to the fund
    expect(e.partiesHeld()).toBe(1);
    expect(e.payParty(team.map((m) => ({ ...m, earned: m.earned + 1000 })), 's1', NOW + 60_000)).toBe(false); // cooldown
    expect(e.payParty(team.map((m) => ({ ...m, earned: m.earned + 1000 })), 's1', NOW + PIZZA_PARTY.cooldownMs)).toBe(true);
    const poor = new Economy();
    expect(poor.payParty(team.map((m) => ({ ...m, earned: 10 })), 's2', NOW)).toBe(false); // 30 < 240
    expect(poor.spent('lead')).toBe(0);
  });

  it('picks the top earner among agents with at least a few coins', () => {
    expect(topEarner([])).toBeUndefined();
    expect(topEarner([{ key: 'a', earned: 5 }])).toBeUndefined();
    expect(topEarner([{ key: 'a', earned: 50 }, { key: 'b', earned: 80 }, { key: 'c', earned: 80 }])).toBe('b');
  });

  it('persists the fund, office upgrades and party cooldowns', () => {
    const store = memoryStore();
    const e = new Economy(store);
    e.buy('a', 'chair', 100_000, NOW);
    e.buyOfficeUpgrade(NOW);
    e.payParty([{ key: 'x', earned: 100 }, { key: 'y', earned: 100 }, { key: 'z', earned: 100 }], 's1', NOW);
    const again = new Economy(store);
    expect(again.fund()).toEqual(e.fund());
    expect(again.officeUpgrades()).toEqual(['espresso']);
    expect(again.partyReady('s1', NOW + 1000)).toBe(false);
    expect(again.partiesHeld()).toBe(1);
    again.reset();
    expect(again.officeUpgrades()).toEqual([]);
    expect(again.fund().income).toBe(0);
  });
});

describe('several tabs share one ledger', () => {
  it('reloads what another tab saved instead of overwriting it', () => {
    const store = memoryStore();
    const tabA = new Economy(store);
    const tabB = new Economy(store);
    tabA.buy('a', 'plant', 1000, NOW);
    tabB.reload(); // the storage event from tab A
    tabB.buy('b', 'coffee', 1000, NOW);
    tabA.reload(); // the storage event from tab B
    const fresh = new Economy(store);
    expect(fresh.items('a')).toEqual(['plant']);
    expect(fresh.spent('b')).toBe(30);
    expect(fresh.fund().income).toBe(150);
    let notified = 0;
    tabA.subscribe(() => notified++);
    tabA.reload();
    expect(notified).toBe(1);
  });
});
