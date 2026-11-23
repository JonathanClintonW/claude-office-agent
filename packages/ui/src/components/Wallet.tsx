import { agentWorkedMs, formatDuration, type Agent, type OfficeState } from '@agent-office/core';
import { BREAK_RESERVE, coinsEarned, DESK_ITEMS, officeEarnings, shopItem, topEarner, useEconomy } from '../economy';
import { TopEarnerBadge } from '../views/ShopView';
import { useSettings } from '../settings';
import '../views/shop.css';

/** Inspector section: the agent's office coins (a game layer over its observed working time). */
export function Wallet({ agent: a, now, state }: { agent: Agent; now: number; state?: OfficeState }) {
  const [settings] = useSettings();
  const e = useEconomy();
  if (!settings.coins) return null;
  const worked = agentWorkedMs(a, now);
  const earned = coinsEarned(worked);
  const owned = e.items(a.key);
  const next = DESK_ITEMS.find((d) => !owned.includes(d.id as (typeof owned)[number]));
  return (
    <>
      <h3>
        Office coins <span className="pill">game</span>
        {state && topEarner(officeEarnings(state, now)) === a.key ? <TopEarnerBadge /> : null}
      </h3>
      <dl className="facts wallet">
        <dt>Balance</dt>
        <dd>
          <b className="coin-amount">{e.balance(a.key, earned).toLocaleString()}</b> coins
        </dd>
        <dt>Earned</dt>
        <dd title="1 coin per second while the agent's real status is working; quiet gaps are capped.">
          {earned.toLocaleString()} <span className="muted small">for {formatDuration(worked)} of observed work</span>
        </dd>
        <dt>Spent</dt>
        <dd>
          {e.spent(a.key).toLocaleString()} <span className="muted small">on {e.purchases(a.key)} simulated purchases</span>
        </dd>
        <dt>Desk</dt>
        <dd>{owned.length ? owned.map((id) => shopItem(id).name).join(', ') : <span className="muted">no upgrades yet</span>}</dd>
        {next ? (
          <>
            <dt>Saving for</dt>
            <dd>
              {next.name} <span className="muted small">(buys it at {(next.price + BREAK_RESERVE).toLocaleString()} coins, idle at the desk)</span>
            </dd>
          </>
        ) : null}
      </dl>
      <p className="muted small">Coins are a game: earned only from real, observed work and spent by the office simulation. Not money, not tokens.</p>
    </>
  );
}
