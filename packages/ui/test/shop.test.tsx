import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentKeyFor, createInitialState, defaultLayout, normalizeHookPayload, reduce, type Agent, type OfficeState } from '@agent-office/core';
import { Wallet } from '../src/components/Wallet';
import { economy } from '../src/economy';
import type { StoreSnapshot } from '../src/store';
import type { HostInfo } from '../src/transport';
import { ShopView } from '../src/views/ShopView';

afterEach(() => {
  cleanup();
  economy.reset();
});

const host: HostInfo = { kind: 'browser', workspaceFolders: [], canOpenFiles: false, canFocusClaude: false };
const T = Date.now() - 600_000;

function worked(): OfficeState {
  let s = createInitialState();
  let seq = 0;
  const step = (name: string, ts: number, extra: Record<string, unknown> = {}) => {
    const r = normalizeHookPayload({ session_id: 'sess-shop', cwd: 'c:\\work\\app', hook_event_name: name, ...extra }, ts);
    if (!r.ok) throw new Error(r.error);
    s = reduce(s, { ...r.event, seq: ++seq });
  };
  step('SessionStart', T, { source: 'startup' });
  step('UserPromptSubmit', T + 1000);
  step('PreToolUse', T + 61_000, { tool_name: 'Read', tool_use_id: 'r1', tool_input: { file_path: 'c:\\work\\app\\a.ts' } });
  step('PostToolUse', T + 121_000, { tool_name: 'Read', tool_use_id: 'r1', tool_input: { file_path: 'c:\\work\\app\\a.ts' }, tool_response: {} });
  step('Stop', T + 181_000);
  return s;
}

describe('ShopView', () => {
  it('shows honest wording, wallets from observed work, the price list and simulated purchases', () => {
    const state = worked();
    const key = agentKeyFor('sess-shop');
    economy.buy(key, 'coffee', 180, Date.now());
    const snap: StoreSnapshot = { state, layout: defaultLayout(), connection: 'open', synced: true, host, version: 1 };
    const onSelect = vi.fn();
    render(<ShopView snap={snap} now={Date.now()} onSelectAgent={onSelect} />);
    expect(screen.getByText(/not money and not Claude tokens/)).toBeTruthy();
    expect(screen.getByText(/Nothing here calls a model/)).toBeTruthy();
    const row = screen.getAllByRole('row').find((r) => r.textContent?.includes('180'));
    expect(row?.textContent).toContain('150'); // 180 earned - 30 coffee
    expect(screen.getByText('Golden chair')).toBeTruthy();
    expect(screen.getByText('free')).toBeTruthy();
    expect(screen.getByText(/bought/).textContent).toContain('Coffee');
    fireEvent.click(screen.getByRole('button', { name: /Reset purchases/ }));
    fireEvent.click(screen.getByRole('button', { name: /Click again/ }));
    expect(economy.spent(key)).toBe(0);
  });
});

describe('Wallet', () => {
  it('shows balance, earnings for observed work and the next desk upgrade', () => {
    const state = worked();
    const a = state.agents[agentKeyFor('sess-shop')] as Agent;
    render(<Wallet agent={a} now={Date.now()} />);
    expect(document.querySelector('.wallet .coin-amount')?.textContent).toBe('180'); // balance: nothing spent yet
    expect(screen.getByText(/for 3m 0s of observed work/)).toBeTruthy();
    expect(screen.getByText('Desk plant')).toBeTruthy();
    expect(screen.getByText(/Not money, not tokens/)).toBeTruthy();
  });
});
