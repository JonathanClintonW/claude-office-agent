# Office coins

Office coins are an optional game layer on top of the office. They are not money, not Claude tokens and not a cost estimate, and nothing about them calls a model or the network. Turn them off under **Settings → Office coins (game)**.

## Earning: real, observed work only

- An agent earns **1 coin per second of observed working time**, meaning the time its real status is `working` according to Claude Code hooks, the session registry or transcripts.
- Working time is counted by the shared reducer (`packages/core/src/state.ts`, field `workMs`): when an event arrives for an agent that was working, the gap since its previous event is added. Each gap is capped at the same limits that flag an agent as quiet (5 minutes, or 20 minutes while a tool runs), so a session stuck in `working` without events stops earning.
- Waiting for permission or input, idle, failed and finished agents do not earn.
- Because earnings come from the office state, every view (browser tabs, VS Code) shows the same earnings, and they survive monitor restarts. Agents seen before this feature existed start at 0.

## Spending: part of the simulation

Spending happens automatically in the local office simulation:

| Item | Price | When |
| --- | --- | --- |
| Water | free | Idle-life water break |
| Vending machine snack | 20 | Idle-life snack break, charged on arrival at the machine |
| Coffee | 30 | Idle-life coffee break, charged on arrival at the machine |
| Desk plant | 120 | Desk upgrade |
| Rubber duck | 300 | Desk upgrade, sits on the monitor |
| Desk lamp | 600 | Desk upgrade, glows at night |
| Photo frame | 1,200 | Desk upgrade, stands on the monitor |
| Golden chair | 2,400 | Desk upgrade, the chair turns gold |

- Agents only take paid breaks they can afford; otherwise idle life picks something free (water, a walk, the window).
- An idle agent sitting at its desk buys the next desk upgrade, in the order above, once it would still have 60 coins left for breaks. Upgrades appear on the agent's desk while it sits there.
- Purchases are simulated per view (like the rest of idle life) and stored only in this browser or webview (`localStorage`, key `agent-office:economy`). **Shop → Reset purchases** clears them; earnings stay because they come from observed work.
- Replays never spend coins.

## Office fund and shared upgrades

Every coin agents spend on breaks and desk upgrades goes into the **office fund**. The office buys the next shared upgrade by itself as soon as the fund can pay for it:

| Upgrade | Price | Effect |
| --- | --- | --- |
| Espresso machine | 250 | The coffee machines are upgraded; coffee costs 20 instead of 30. |
| Arcade cabinet | 600 | An arcade cabinet appears on a free wall tile of the break room (a collaboration room or the reception if there is no break room). Idle agents play it for free. |

The arcade is placed in the office view only; your saved layout is never changed. You can also place arcades yourself with the layout editor: they show as a shipping crate until the office fund unlocks the arcade.

## Pizza parties

When at least 3 agents of one session (the lead and its subagents or teammates) are idle at their desks and their savings add up to **240 coins**, the team orders pizza: they walk to the break room (or a meeting or collaboration room with enough free seats), a pizza box appears on the table and they eat together for 20–30 seconds. Everyone pays an even share and the others cover members who are short. A team holds at most one party every 20 minutes. Real work always wins: an agent that gets work leaves at once, and the party goes on while at least two remain. Pizza money is not part of the office fund.

## Top earner

The agent that has earned the most coins among those in the office (at least 10) wears a small crown, and the inspector and the Shop tab show a **top earner** badge.

## Where to see it

- **Inspector → Office coins:** balance, earnings with the observed working time behind them, spending, desk upgrades and what the agent is saving for.
- **Shop tab:** totals, a wallet table for every agent with earnings or purchases, the office fund and its upgrades, pizza-party rules, the price list and recent purchases.
- **In the office:** a coin pop-up and a short chime (when sound is on) on every purchase, the balance under the name of the selected or hovered agent, and the bought items on desks.

## Code

| File | Contents |
| --- | --- |
| `packages/core/src/state.ts` | `workMs` accounting, `workedMs()`, `agentWorkedMs()` |
| `packages/ui/src/economy.ts` | Price list, earning rate, ledger, purchase rules, persistence |
| `packages/ui/src/office/idleLife.ts` | `priceOf` / `onPaid` options: affordability and charging for breaks |
| `packages/ui/src/office/scene.ts` | Desk upgrades, coin pop-ups, labels |
| `packages/ui/src/views/ShopView.tsx`, `components/Wallet.tsx` | Shop tab and inspector section |

Tests: `packages/core/test/work.test.ts`, `packages/ui/test/economy.test.ts`, `packages/ui/test/shop.test.tsx`, and the Shop tab in `packages/ui/test/zeroTokenApp.test.tsx` (no network calls).
