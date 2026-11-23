import { useMemo, useState } from 'react';
import { agentWorkedMs, displayName, formatDuration, isSimulated, type Agent } from '@agent-office/core';
import { SimBadge, StatusPill } from '../components/common';
import {
  BREAK_RESERVE,
  COINS_PER_SECOND,
  coinsEarned,
  OFFICE_KEY,
  OFFICE_UPGRADES,
  officeEarnings,
  PIZZA_PARTY,
  purchaseName,
  SHOP,
  shopItem,
  topEarner,
  useEconomy,
} from '../economy';
import { clock } from '../hooks';
import { useSettings } from '../settings';
import type { ViewProps } from './types';
import './analytics.css';
import './shop.css';

const MAX_ROWS = 40;

interface Row {
  agent: Agent;
  worked: number;
  earned: number;
  spent: number;
  balance: number;
}

export function TopEarnerBadge() {
  return (
    <span className="badge top-earner" title="Top earner: the most coins earned among the agents in the office">
      👑 top earner
    </span>
  );
}

/** Office coins: what agents earned for observed work, what the simulation spent, the office fund and the price list. */
export function ShopView({ snap, now, onSelectAgent }: ViewProps) {
  const [settings, update] = useSettings();
  const e = useEconomy();
  const version = e.getVersion();
  const [confirmReset, setConfirmReset] = useState(false);
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const a of Object.values(snap.state.agents)) {
      const worked = agentWorkedMs(a, now);
      const earned = coinsEarned(worked);
      const spent = e.spent(a.key);
      if (!earned && !spent) continue;
      out.push({ agent: a, worked, earned, spent, balance: e.balance(a.key, earned) });
    }
    return out.sort((x, y) => y.balance - x.balance || y.earned - x.earned);
    // `version` changes on every purchase.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap.state, now, e, version]);
  const top = topEarner(officeEarnings(snap.state, now));
  const totals = rows.reduce((t, r) => ({ earned: t.earned + r.earned, spent: t.spent + r.spent, balance: t.balance + r.balance }), { earned: 0, spent: 0, balance: 0 });
  const owners = (id: string) => rows.filter((r) => e.items(r.agent.key).includes(id as never)).length;
  const nameOf = (key: string) => {
    if (key === OFFICE_KEY) return 'The office';
    const a = snap.state.agents[key];
    return a ? displayName(a) : 'An agent that left the office';
  };
  const fund = e.fund();
  const next = e.nextOfficeUpgrade();

  return (
    <section className="page shop" aria-label="Shop">
      <h2>Shop</h2>
      <p className="small">
        <b>Office coins are a game</b>, not money and not Claude tokens. Agents earn {COINS_PER_SECOND} coin per second of <b>observed</b> working time,
        only while Claude Code reports them working; quiet gaps are capped, so a stuck session cannot farm coins. Spending is part of the local office
        simulation: idle agents pay for coffee and vending-machine snacks (water is free), an idle agent sitting at its desk buys the next desk upgrade
        once it can keep {BREAK_RESERVE} coins for breaks, and teams throw pizza parties. Earnings come from the shared office state, so every view
        agrees; purchases are simulated per view and stored only in this browser/webview. Nothing here calls a model.
      </p>
      {!settings.coins ? (
        <p className="banner info" role="status">
          Office coins are off.{' '}
          <button className="link" onClick={() => update({ coins: true })}>
            Turn them on
          </button>
        </p>
      ) : null}

      <div className="shop-totals" aria-label="Totals">
        <div className="card shop-total">
          <span className="muted small">Earned</span>
          <b>{totals.earned.toLocaleString()}</b>
        </div>
        <div className="card shop-total">
          <span className="muted small">Spent</span>
          <b>{totals.spent.toLocaleString()}</b>
        </div>
        <div className="card shop-total">
          <span className="muted small">In wallets</span>
          <b className="coin-amount">{totals.balance.toLocaleString()}</b>
        </div>
        <div className="card shop-total">
          <span className="muted small">Office fund</span>
          <b className="coin-amount">{fund.balance.toLocaleString()}</b>
        </div>
      </div>

      <h3>Wallets</h3>
      {rows.length ? (
        <div className="an-table-wrap">
          <table className="an-table">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Status</th>
                <th className="num">Worked</th>
                <th className="num">Earned</th>
                <th className="num">Spent</th>
                <th className="num">Balance</th>
                <th>Desk</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, MAX_ROWS).map((r) => (
                <tr key={r.agent.key}>
                  <td className="an-name">
                    <button className="link" onClick={() => onSelectAgent(r.agent.key)}>
                      {displayName(r.agent)}
                    </button>
                    {r.agent.key === top ? <TopEarnerBadge /> : null}
                    {isSimulated(r.agent) ? <SimBadge /> : null}
                  </td>
                  <td>
                    <StatusPill status={r.agent.status} stale={r.agent.stale} />
                  </td>
                  <td className="num">{formatDuration(r.worked)}</td>
                  <td className="num">{r.earned.toLocaleString()}</td>
                  <td className="num">{r.spent.toLocaleString()}</td>
                  <td className="num coin-amount">{r.balance.toLocaleString()}</td>
                  <td className="small">{e.items(r.agent.key).map((id) => shopItem(id).name).join(', ') || <span className="muted">none yet</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted small">No coins earned yet. Agents start earning as soon as Claude Code reports them working.</p>
      )}

      <h3>Office fund</h3>
      <p className="small">
        Coins agents spend on breaks and desk upgrades go into the office fund ({fund.income.toLocaleString()} collected, {fund.spent.toLocaleString()}{' '}
        spent). The office buys the next shared upgrade by itself as soon as the fund can pay for it.
      </p>
      <div className="an-table-wrap">
        <table className="an-table">
          <thead>
            <tr>
              <th>Upgrade</th>
              <th className="num">Price</th>
              <th>Status</th>
              <th>What it does</th>
            </tr>
          </thead>
          <tbody>
            {OFFICE_UPGRADES.map((u) => (
              <tr key={u.id}>
                <td>{u.name}</td>
                <td className="num">{u.price.toLocaleString()}</td>
                <td className="small">
                  {e.hasUpgrade(u.id) ? (
                    <span className="coin-amount">installed</span>
                  ) : next?.id === u.id ? (
                    `next: ${Math.max(0, u.price - fund.balance).toLocaleString()} more`
                  ) : (
                    <span className="muted">later</span>
                  )}
                </td>
                <td className="small">{u.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3>Pizza parties</h3>
      <p className="small">
        When at least {PIZZA_PARTY.minMembers} agents of one session are idle and their savings add up to {PIZZA_PARTY.price} coins, the team orders pizza
        and eats together in a break, meeting or collaboration room, at most once every {PIZZA_PARTY.cooldownMs / 60_000} minutes per team. Everyone pays an even share; the
        others cover members who are short. {e.partiesHeld() ? `${e.partiesHeld()} so far.` : 'None yet.'}
      </p>

      <h3>Price list</h3>
      <div className="an-table-wrap">
        <table className="an-table">
          <thead>
            <tr>
              <th>Item</th>
              <th>Type</th>
              <th className="num">Price</th>
              <th>What happens</th>
              <th className="num">Owners here</th>
            </tr>
          </thead>
          <tbody>
            {SHOP.map((it) => {
              const price = e.price(it.id);
              return (
                <tr key={it.id}>
                  <td>{it.name}</td>
                  <td>{it.kind === 'desk' ? 'desk upgrade' : 'break'}</td>
                  <td className="num">
                    {price ? price.toLocaleString() : 'free'}
                    {price < it.price ? <span className="muted small"> (was {it.price})</span> : null}
                  </td>
                  <td className="small">{it.description}</td>
                  <td className="num">{it.kind === 'desk' ? owners(it.id) : '—'}</td>
                </tr>
              );
            })}
            <tr>
              <td>Pizza party</td>
              <td>team</td>
              <td className="num">{PIZZA_PARTY.price.toLocaleString()}</td>
              <td className="small">Split across a team of at least {PIZZA_PARTY.minMembers} idle agents.</td>
              <td className="num">—</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3>Recent purchases (simulated)</h3>
      {e.recent(1).length ? (
        <ul className="shop-log small">
          {e.recent(15).map((p, i) => (
            <li key={`${p.at}-${p.agentKey}-${p.item}-${i}`}>
              <span className="muted">{clock(p.at)}</span> {nameOf(p.agentKey)} bought <b>{purchaseName(p.item)}</b>{' '}
              <span className="coin-amount">−{p.price.toLocaleString()}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">Nothing bought yet. Idle agents shop during breaks.</p>
      )}
      <p>
        <button
          className="btn small"
          onClick={() => {
            if (!confirmReset) return setConfirmReset(true);
            e.reset();
            setConfirmReset(false);
          }}
        >
          {confirmReset ? 'Click again to reset all purchases' : 'Reset purchases'}
        </button>{' '}
        <span className="muted small">Clears spending, desk upgrades, the office fund and its upgrades in this view. Earnings come from observed work and stay.</span>
      </p>
    </section>
  );
}
