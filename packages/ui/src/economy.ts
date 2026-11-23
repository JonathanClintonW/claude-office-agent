/**
 * Office coins: a game layer, not money and not tokens. Agents earn coins only for real,
 * observed working time (core `workedMs`); spending is part of the local simulation (coffee,
 * vending machine, desk upgrades, team pizza parties). What agents spend on breaks and desk
 * upgrades goes into an office fund that buys shared upgrades. Purchases are stored only in
 * this browser/webview.
 */
import { useSyncExternalStore } from 'react';
import { agentWorkedMs, TERMINAL_STATUSES, type OfficeState } from '@agent-office/core';

export const COINS_PER_SECOND = 1;

export type ConsumableId = 'coffee' | 'snack' | 'water';
export type DeskItemId = 'plant' | 'duck' | 'lamp' | 'photo' | 'chair';
export type ShopItemId = ConsumableId | DeskItemId;
export type OfficeUpgradeId = 'espresso' | 'arcade';
/** Everything that can appear in the purchase log. */
export type PurchaseItem = ShopItemId | OfficeUpgradeId | 'pizza';

export interface ShopItem {
  id: ShopItemId;
  name: string;
  kind: 'consumable' | 'desk';
  price: number;
  description: string;
}

/** Desk items are bought in this order, cheapest first. */
export const SHOP: readonly ShopItem[] = [
  { id: 'water', name: 'Water', kind: 'consumable', price: 0, description: 'Free at the water cooler, for agents saving up.' },
  { id: 'snack', name: 'Vending machine snack', kind: 'consumable', price: 20, description: 'Bought at the vending machine during a break.' },
  { id: 'coffee', name: 'Coffee', kind: 'consumable', price: 30, description: 'From the coffee machine, sipped back at the desk.' },
  { id: 'plant', name: 'Desk plant', kind: 'desk', price: 120, description: 'A little green on the desk.' },
  { id: 'duck', name: 'Rubber duck', kind: 'desk', price: 300, description: 'Sits on the monitor. Every debugger needs one.' },
  { id: 'lamp', name: 'Desk lamp', kind: 'desk', price: 600, description: 'Glows at night.' },
  { id: 'photo', name: 'Photo frame', kind: 'desk', price: 1200, description: 'Stands on the monitor.' },
  { id: 'chair', name: 'Golden chair', kind: 'desk', price: 2400, description: 'The top upgrade: the desk chair turns gold.' },
];

export const DESK_ITEMS: readonly ShopItem[] = SHOP.filter((i) => i.kind === 'desk');
const BY_ID = new Map(SHOP.map((i) => [i.id, i]));

export function shopItem(id: ShopItemId): ShopItem {
  return BY_ID.get(id)!;
}

export interface OfficeUpgrade {
  id: OfficeUpgradeId;
  name: string;
  price: number;
  description: string;
}

/** Shared upgrades the office fund buys automatically, in this order. */
export const OFFICE_UPGRADES: readonly OfficeUpgrade[] = [
  { id: 'espresso', name: 'Espresso machine', price: 250, description: 'Upgrades the coffee machines: coffee costs 20 instead of 30.' },
  { id: 'arcade', name: 'Arcade cabinet', price: 600, description: 'An arcade cabinet in the break room. Idle agents play for free.' },
];

export function officeUpgrade(id: OfficeUpgradeId): OfficeUpgrade {
  return OFFICE_UPGRADES.find((u) => u.id === id)!;
}

export const ESPRESSO_COFFEE_PRICE = 20;

/** A team (a session and its subagents/teammates) can throw a pizza party with pooled savings. */
export const PIZZA_PARTY = { price: 240, minMembers: 3, cooldownMs: 20 * 60_000 } as const;

/** The top earner needs at least this many coins earned. */
export const TOP_EARNER_MIN = 10;

/** `agentKey` of purchases made by the office fund. */
export const OFFICE_KEY = '*office*';

export function purchaseName(item: PurchaseItem): string {
  if (item === 'pizza') return 'Pizza party (share)';
  const up = OFFICE_UPGRADES.find((u) => u.id === item);
  return up ? up.name : shopItem(item as ShopItemId).name;
}

/** Coins an agent kept for breaks: desk items are only bought when this much is left afterwards. */
export const BREAK_RESERVE = 60;

export function coinsEarned(workedMs: number): number {
  return Math.max(0, Math.floor((workedMs / 1000) * COINS_PER_SECOND));
}

/** Coins earned by every agent still in the office (not ended or completed). */
export function officeEarnings(state: OfficeState, now: number): Array<{ key: string; earned: number }> {
  return Object.values(state.agents)
    .filter((a) => !TERMINAL_STATUSES.has(a.status))
    .map((a) => ({ key: a.key, earned: coinsEarned(agentWorkedMs(a, now)) }));
}

/** The agent that earned the most (at least TOP_EARNER_MIN); ties go to the lower key. */
export function topEarner(candidates: Iterable<{ key: string; earned: number }>): string | undefined {
  let best: { key: string; earned: number } | undefined;
  for (const c of candidates) {
    if (c.earned < TOP_EARNER_MIN) continue;
    if (!best || c.earned > best.earned || (c.earned === best.earned && c.key < best.key)) best = c;
  }
  return best?.key;
}

export interface Purchase {
  at: number;
  /** The agent, or OFFICE_KEY for office upgrades. */
  agentKey: string;
  item: PurchaseItem;
  price: number;
}

interface Account {
  spent: number;
  items: DeskItemId[];
  purchases: number;
  lastSeen: number;
}

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const STORAGE_KEY = 'agent-office:economy';
const MAX_LOG = 200;
const MAX_ACCOUNTS = 500;
/** Accounts of agents not seen for this long are dropped (agent keys are per session). */
const FORGET_AFTER_MS = 30 * 24 * 3600_000;
const PURCHASE_ITEMS = new Set<string>([...SHOP.map((i) => i.id), ...OFFICE_UPGRADES.map((u) => u.id), 'pizza']);

function isDeskItem(id: unknown): id is DeskItemId {
  return typeof id === 'string' && DESK_ITEMS.some((d) => d.id === id);
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

export class Economy {
  private accounts = new Map<string, Account>();
  private log: Purchase[] = [];
  private fundIncome = 0;
  private fundSpent = 0;
  private office: OfficeUpgradeId[] = [];
  private lastParty = new Map<string, number>();
  private parties = 0;
  private listeners = new Set<() => void>();
  private version = 0;

  constructor(
    private readonly store?: KeyValueStore,
    private readonly key = STORAGE_KEY,
  ) {
    this.load();
  }

  /** Current price of an item (coffee is cheaper once the office owns the espresso machine). */
  price(item: ShopItemId): number {
    if (item === 'coffee' && this.office.includes('espresso')) return ESPRESSO_COFFEE_PRICE;
    return shopItem(item).price;
  }

  balance(agentKey: string, earned: number): number {
    return Math.max(0, earned - (this.accounts.get(agentKey)?.spent ?? 0));
  }

  spent(agentKey: string): number {
    return this.accounts.get(agentKey)?.spent ?? 0;
  }

  items(agentKey: string): readonly DeskItemId[] {
    return this.accounts.get(agentKey)?.items ?? [];
  }

  purchases(agentKey: string): number {
    return this.accounts.get(agentKey)?.purchases ?? 0;
  }

  recent(limit = 50): Purchase[] {
    return this.log.slice(-limit).reverse();
  }

  /** Buy `item` with coins earned so far; undefined (nothing recorded) when it can't be afforded or is already owned. */
  buy(agentKey: string, item: ShopItemId, earned: number, now: number): Purchase | undefined {
    const it = BY_ID.get(item);
    if (!it) return undefined;
    const price = this.price(item);
    const acc = this.accounts.get(agentKey) ?? { spent: 0, items: [], purchases: 0, lastSeen: now };
    if (it.kind === 'desk' && acc.items.includes(it.id as DeskItemId)) return undefined;
    if (Math.max(0, earned - acc.spent) < price) return undefined;
    acc.spent += price;
    acc.purchases += 1;
    acc.lastSeen = now;
    if (it.kind === 'desk') acc.items.push(it.id as DeskItemId);
    this.accounts.set(agentKey, acc);
    this.fundIncome += price;
    return this.record({ at: now, agentKey, item, price });
  }

  /** The next desk item worth buying now, keeping BREAK_RESERVE coins for breaks. */
  nextDeskItem(agentKey: string, earned: number): ShopItem | undefined {
    const owned = this.items(agentKey);
    const next = DESK_ITEMS.find((d) => !owned.includes(d.id as DeskItemId));
    return next && this.balance(agentKey, earned) >= next.price + BREAK_RESERVE ? next : undefined;
  }

  /** The office fund: what agents spent on breaks and desk upgrades, minus the shared upgrades it bought. */
  fund(): { income: number; spent: number; balance: number } {
    return { income: this.fundIncome, spent: this.fundSpent, balance: Math.max(0, this.fundIncome - this.fundSpent) };
  }

  officeUpgrades(): readonly OfficeUpgradeId[] {
    return this.office;
  }

  hasUpgrade(id: OfficeUpgradeId): boolean {
    return this.office.includes(id);
  }

  nextOfficeUpgrade(): OfficeUpgrade | undefined {
    return OFFICE_UPGRADES.find((u) => !this.office.includes(u.id));
  }

  /** The office buys its next shared upgrade once the fund can pay for it. */
  buyOfficeUpgrade(now: number): OfficeUpgrade | undefined {
    const next = this.nextOfficeUpgrade();
    if (!next || this.fund().balance < next.price) return undefined;
    this.office.push(next.id);
    this.fundSpent += next.price;
    this.record({ at: now, agentKey: OFFICE_KEY, item: next.id, price: next.price });
    return next;
  }

  partyReady(sessionId: string, now: number): boolean {
    const last = this.lastParty.get(sessionId);
    return last === undefined || now - last >= PIZZA_PARTY.cooldownMs;
  }

  lastPartyAt(sessionId: string): number | undefined {
    return this.lastParty.get(sessionId);
  }

  partiesHeld(): number {
    return this.parties;
  }

  /**
   * Pay a team's pizza party from the members' pooled savings: the poorest pay what they can
   * of an even share, the others cover the rest. False (nothing charged) when the team can't
   * afford it or had a party within the cooldown.
   */
  payParty(members: ReadonlyArray<{ key: string; earned: number }>, sessionId: string, now: number): boolean {
    if (members.length < PIZZA_PARTY.minMembers || !this.partyReady(sessionId, now)) return false;
    const funds = members.map((m) => ({ key: m.key, balance: this.balance(m.key, m.earned) })).sort((x, y) => x.balance - y.balance || (x.key < y.key ? -1 : 1));
    if (funds.reduce((s, f) => s + f.balance, 0) < PIZZA_PARTY.price) return false;
    let remaining: number = PIZZA_PARTY.price;
    funds.forEach((f, i) => {
      const share = Math.min(f.balance, Math.ceil(remaining / (funds.length - i)));
      remaining -= share;
      if (!share) return;
      const acc = this.accounts.get(f.key) ?? { spent: 0, items: [], purchases: 0, lastSeen: now };
      acc.spent += share;
      acc.purchases += 1;
      acc.lastSeen = now;
      this.accounts.set(f.key, acc);
      this.log.push({ at: now, agentKey: f.key, item: 'pizza', price: share });
    });
    this.lastParty.set(sessionId, now);
    this.parties += 1;
    this.trimLog();
    this.changed();
    return true;
  }

  /** Mark agents as still around (keeps their accounts from being forgotten). */
  seen(agentKeys: Iterable<string>, now: number): void {
    let dirty = false;
    for (const k of agentKeys) {
      const acc = this.accounts.get(k);
      if (acc && now - acc.lastSeen > 3600_000) {
        acc.lastSeen = now;
        dirty = true;
      }
    }
    if (dirty) this.save();
  }

  reset(): void {
    this.accounts.clear();
    this.log = [];
    this.fundIncome = 0;
    this.fundSpent = 0;
    this.office = [];
    this.lastParty.clear();
    this.parties = 0;
    this.changed();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getVersion(): number {
    return this.version;
  }

  private record(p: Purchase): Purchase {
    this.log.push(p);
    this.trimLog();
    this.changed();
    return p;
  }

  private trimLog(): void {
    if (this.log.length > MAX_LOG) this.log.splice(0, this.log.length - MAX_LOG);
  }

  private changed(): void {
    this.version += 1;
    this.save();
    for (const l of this.listeners) l();
  }

  /** Replace the in-memory ledger with what is stored (another tab saved it). Does not write back. */
  reload(): void {
    this.accounts.clear();
    this.log = [];
    this.fundIncome = 0;
    this.fundSpent = 0;
    this.office = [];
    this.lastParty.clear();
    this.parties = 0;
    this.load();
    this.version += 1;
    for (const l of this.listeners) l();
  }

  private load(): void {
    try {
      const raw = this.store?.getItem(this.key);
      if (!raw) return;
      const data = JSON.parse(raw) as {
        v?: number;
        accounts?: Record<string, Partial<Account>>;
        log?: Partial<Purchase>[];
        fund?: { income?: unknown; spent?: unknown };
        office?: unknown[];
        parties?: Record<string, unknown>;
        partyCount?: unknown;
      };
      if (data.v !== 1) return;
      const now = Date.now();
      for (const [k, a] of Object.entries(data.accounts ?? {})) {
        if (typeof a?.spent !== 'number' || !Number.isFinite(a.spent) || a.spent < 0) continue;
        const lastSeen = typeof a.lastSeen === 'number' ? a.lastSeen : now;
        if (now - lastSeen > FORGET_AFTER_MS) continue;
        const items = Array.isArray(a.items) ? [...new Set(a.items.filter(isDeskItem))] : [];
        this.accounts.set(k, { spent: a.spent, items, purchases: typeof a.purchases === 'number' ? a.purchases : 0, lastSeen });
      }
      this.log = (data.log ?? [])
        .filter((p): p is Purchase => typeof p?.at === 'number' && typeof p.agentKey === 'string' && PURCHASE_ITEMS.has(p.item as string) && typeof p.price === 'number')
        .slice(-MAX_LOG);
      this.fundIncome = num(data.fund?.income);
      this.fundSpent = Math.min(num(data.fund?.spent), this.fundIncome);
      this.office = OFFICE_UPGRADES.map((u) => u.id).filter((id) => Array.isArray(data.office) && data.office.includes(id));
      for (const [sid, at] of Object.entries(data.parties ?? {})) if (typeof at === 'number' && now - at < 24 * 3600_000) this.lastParty.set(sid, at);
      this.parties = num(data.partyCount);
    } catch {
      /* corrupt or unavailable storage: start empty */
    }
  }

  private save(): void {
    if (!this.store) return;
    if (this.accounts.size > MAX_ACCOUNTS) {
      const oldest = [...this.accounts].sort((x, y) => x[1].lastSeen - y[1].lastSeen).slice(0, this.accounts.size - MAX_ACCOUNTS);
      for (const [k] of oldest) this.accounts.delete(k);
    }
    try {
      this.store.setItem(
        this.key,
        JSON.stringify({
          v: 1,
          accounts: Object.fromEntries(this.accounts),
          log: this.log,
          fund: { income: this.fundIncome, spent: this.fundSpent },
          office: this.office,
          parties: Object.fromEntries(this.lastParty),
          partyCount: this.parties,
        }),
      );
    } catch {
      /* storage full or unavailable (some webviews) */
    }
  }
}

function browserStore(): KeyValueStore | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** The office's shared ledger (one per browser tab / webview). */
export const economy = new Economy(browserStore());

// Several tabs share one ledger: pick up what another tab saved, so the next save does not overwrite it.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (ev) => {
    if (ev.key === STORAGE_KEY) economy.reload();
  });
}

/** Re-render when a purchase happens. */
export function useEconomy(e: Economy = economy): Economy {
  useSyncExternalStore(
    (l) => e.subscribe(l),
    () => e.getVersion(),
  );
  return e;
}
