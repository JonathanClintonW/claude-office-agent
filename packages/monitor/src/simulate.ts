/**
 * Scripted mock Claude Code hook traffic for UI development, demos and integration tests.
 *
 * All sessions use the `sim-` prefix and are labelled SIMULATED in the UI, so simulated
 * activity can never be mistaken for real agents.
 */

export interface ScriptStep {
  at: number;
  payload: Record<string, unknown>;
}


function base(session: string, cwd: string) {
  return (event: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    session_id: session,
    cwd,
    transcript_path: `C:\\simulated\\${session}.jsonl`,
    permission_mode: 'default',
    hook_event_name: event,
    ...extra,
  });
}

/** Session ids are unique per run so repeated demos never merge into one history. */
export function simSessions(runId: string): [string, string, string] {
  return [`sim-webshop-${runId}`, `sim-api-${runId}`, `sim-infra-${runId}`];
}

export function buildScenario(runId = '0001'): ScriptStep[] {
  const [A, B, C] = simSessions(runId);
  const a = base(A, 'C:\\demo\\webshop');
  const b = base(B, 'C:\\demo\\api-server');
  const c = base(C, 'C:\\demo\\infra');
  const steps: ScriptStep[] = [];
  const at = (t: number, payload: Record<string, unknown>) => steps.push({ at: t, payload });
  const tool = (t: number, mk: typeof a, id: string, name: string, input: Record<string, unknown>, dur: number, extra: Record<string, unknown> = {}) => {
    at(t, mk('PreToolUse', { tool_name: name, tool_use_id: id, tool_input: input, ...extra }));
    at(t + dur, mk('PostToolUse', { tool_name: name, tool_use_id: id, tool_input: input, tool_response: { success: true }, duration_ms: dur, ...extra }));
  };

  // --- Session A: fixes a bug with an Explore subagent, a permission prompt, a failure, and tasks.
  at(0, a('SessionStart', { source: 'startup', model: 'claude-opus-5-5' }));
  at(600, a('UserPromptSubmit', { prompt: '[simulated prompt]' }));
  tool(1000, a, 'sa-1', 'Read', { file_path: 'C:\\demo\\webshop\\package.json' }, 300);
  at(1800, a('PreToolUse', { tool_name: 'Agent', tool_use_id: 'sa-2', tool_input: { description: 'Map the checkout flow', subagent_type: 'Explore' } }));
  const ex = { agent_id: 'sim-explore-1', agent_type: 'Explore' };
  at(2000, a('SubagentStart', ex));
  tool(2400, a, 'sx-1', 'Grep', { pattern: 'calculateTotal', path: 'src' }, 500, ex);
  tool(3200, a, 'sx-2', 'Read', { file_path: 'C:\\demo\\webshop\\src\\cart\\totals.ts' }, 400, ex);
  tool(4000, a, 'sx-3', 'Read', { file_path: 'C:\\demo\\webshop\\src\\checkout\\Summary.tsx' }, 400, ex);
  tool(5000, a, 'sx-4', 'Glob', { pattern: '**/*.test.ts' }, 300, ex);
  at(6000, a('SubagentStop', { ...ex, last_assistant_message: 'Checkout totals are computed in src/cart/totals.ts using float math.' }));
  at(6100, a('PostToolUse', { tool_name: 'Agent', tool_use_id: 'sa-2', tool_input: {}, tool_response: {}, duration_ms: 4300 }));
  at(6500, a('TaskCreated', { task_id: '1', task_subject: 'Fix cart rounding', task_description: 'Use integer cents in totals.ts' }));
  at(6600, a('TaskCreated', { task_id: '2', task_subject: 'Add regression test for rounding' }));
  tool(7000, a, 'sa-3', 'Edit', { file_path: 'C:\\demo\\webshop\\src\\cart\\totals.ts', old_string: '[omitted]', new_string: '[omitted]' }, 200);
  at(7600, a('PreToolUse', { tool_name: 'Bash', tool_use_id: 'sa-4', tool_input: { command: 'npm test -- cart', description: 'Run cart tests' } }));
  at(7700, a('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'npm test -- cart', description: 'Run cart tests' } }));
  at(7750, a('Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }));
  at(11000, a('PostToolUseFailure', { tool_name: 'Bash', tool_use_id: 'sa-4', tool_input: {}, error: 'Exit code 1: 1 failing test (totals rounds 0.1 + 0.2)', duration_ms: 2100 }));
  at(11400, a('TaskCompleted', { task_id: '1', task_subject: 'Fix cart rounding' }));
  tool(12000, a, 'sa-5', 'Write', { file_path: 'C:\\demo\\webshop\\src\\cart\\totals.test.ts', content: '[omitted]' }, 200);
  tool(12600, a, 'sa-6', 'Bash', { command: 'npm test -- cart', description: 'Re-run cart tests' }, 2500);
  at(15300, a('TaskCompleted', { task_id: '2', task_subject: 'Add regression test for rounding' }));
  at(16000, a('Stop', { last_assistant_message: 'Fixed the rounding bug by switching totals to integer cents and added a regression test.' }));

  // --- Session B: asks a question, then coordinates teammates.
  at(1200, b('SessionStart', { source: 'startup', model: 'claude-sonnet-5-5' }));
  at(1500, b('UserPromptSubmit', {}));
  tool(2200, b, 'sb-1', 'Glob', { pattern: 'src/routes/**/*.ts' }, 200);
  at(3000, b('PreToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'sb-2', tool_input: { questions: [{ question: 'Should the new endpoint be versioned under /v2?' }] } }));
  at(9000, b('PostToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'sb-2', tool_input: {}, tool_response: {} }));
  const alice = { agent_id: 'sim-tm-alice', agent_type: 'teammate' };
  const bob = { agent_id: 'sim-tm-bob', agent_type: 'teammate' };
  at(9500, b('TaskCreated', { ...alice, task_id: 'r1', task_subject: 'Implement /v2/orders route', teammate_name: 'alice' }));
  at(9600, b('TaskCreated', { ...bob, task_id: 'r2', task_subject: 'Write OpenAPI spec', teammate_name: 'bob' }));
  tool(10000, b, 'st-1', 'Write', { file_path: 'C:\\demo\\api-server\\src\\routes\\v2\\orders.ts', content: '[omitted]' }, 600, alice);
  tool(10200, b, 'st-2', 'WebFetch', { url: 'https://spec.openapis.org/oas/v3.1.0' }, 1800, bob);
  tool(12500, b, 'st-3', 'Edit', { file_path: 'C:\\demo\\api-server\\openapi.yaml' }, 400, bob);
  at(13000, b('TaskCompleted', { ...bob, task_id: 'r2', task_subject: 'Write OpenAPI spec', teammate_name: 'bob' }));
  at(13100, b('TeammateIdle', { ...bob, teammate_name: 'bob' }));
  tool(13500, b, 'st-4', 'Bash', { command: 'npm run lint', description: 'Lint new route' }, 1500, alice);
  at(15500, b('TaskCompleted', { ...alice, task_id: 'r1', task_subject: 'Implement /v2/orders route', teammate_name: 'alice' }));
  at(15600, b('TeammateIdle', { ...alice, teammate_name: 'alice' }));
  at(16500, b('Stop', { last_assistant_message: 'Added /v2/orders and documented it in openapi.yaml.' }));

  // --- Session C: a long build that ends in an API error.
  at(2500, c('SessionStart', { source: 'resume', model: 'claude-haiku-5-5' }));
  at(2800, c('UserPromptSubmit', {}));
  at(3500, c('PreToolUse', { tool_name: 'Bash', tool_use_id: 'sc-1', tool_input: { command: 'docker compose build', description: 'Build images' } }));
  at(13500, c('PostToolUse', { tool_name: 'Bash', tool_use_id: 'sc-1', tool_input: {}, tool_response: {}, duration_ms: 10000 }));
  at(14500, c('StopFailure', { error: 'rate_limit', last_assistant_message: 'API Error: rate limited' }));

  return steps.sort((x, y) => x.at - y.at);
}

export function endScenario(runId = '0001'): Record<string, unknown>[] {
  return simSessions(runId).map((s) => ({ session_id: s, hook_event_name: 'SessionEnd', reason: 'other', cwd: 'C:\\demo' }));
}

// ---------------------------------------------------------------- showcase scenario

/** Session ids of the showcase scenario (all `sim-` prefixed, unique per run). */
export function showcaseSessions(runId: string): [string, string, string, string, string] {
  return [`sim-webshop-${runId}`, `sim-api-${runId}`, `sim-infra-${runId}`, `sim-audit-${runId}`, `sim-docs-${runId}`];
}

/**
 * A busier demo for screenshots and presentations: five sessions over about 70 seconds with
 * parallel subagents in several departments, one nested subagent, an agent team with task
 * handoffs, a permission prompt, a question, a failed and re-run test, a failed command and a
 * failed turn. Every session id starts with `sim-`, so the UI labels all of it SIMULATED. Only
 * hook fields the reducer understands are used; no prompt text is sent.
 */
export function buildShowcaseScenario(runId = '0001'): ScriptStep[] {
  const [W, A, I, S, R] = showcaseSessions(runId);
  const w = base(W, 'C:\\demo\\webshop');
  const a = base(A, 'C:\\demo\\api-server');
  const inf = base(I, 'C:\\demo\\infra');
  const s = base(S, 'C:\\demo\\payments');
  const r = base(R, 'C:\\demo\\docs-site');
  const steps: ScriptStep[] = [];
  type Mk = typeof w;
  type Extra = Record<string, unknown>;
  // The script below is written on a compact clock and stretched by SCALE, so agents have time to
  // walk from the door to their desks while their work is still going on.
  const SCALE = 2.5;
  const at = (t: number, payload: Record<string, unknown>) => steps.push({ at: Math.round(t * SCALE), payload });
  const ms = (dur: number) => Math.round(dur * SCALE);
  const tool = (t: number, mk: Mk, id: string, name: string, input: Extra, dur: number, extra: Extra = {}) => {
    at(t, mk('PreToolUse', { tool_name: name, tool_use_id: id, tool_input: input, ...extra }));
    at(t + dur, mk('PostToolUse', { tool_name: name, tool_use_id: id, tool_input: input, tool_response: { success: true }, duration_ms: ms(dur), ...extra }));
  };
  const fail = (t: number, mk: Mk, id: string, name: string, input: Extra, dur: number, error: string, extra: Extra = {}) => {
    at(t, mk('PreToolUse', { tool_name: name, tool_use_id: id, tool_input: input, ...extra }));
    at(t + dur, mk('PostToolUseFailure', { tool_name: name, tool_use_id: id, tool_input: input, error, duration_ms: ms(dur), ...extra }));
  };
  /** An Agent tool call by `by` (the session when empty) followed by the matching SubagentStart. */
  const spawn = (t: number, mk: Mk, id: string, child: Extra, description: string, by: Extra = {}) => {
    at(t, mk('PreToolUse', { tool_name: 'Agent', tool_use_id: id, tool_input: { description, subagent_type: child.agent_type }, ...by }));
    at(t + 200, mk('SubagentStart', child));
  };
  const spawned = (t: number, mk: Mk, id: string, dur: number, by: Extra = {}) =>
    at(t, mk('PostToolUse', { tool_name: 'Agent', tool_use_id: id, tool_input: {}, tool_response: {}, duration_ms: ms(dur), ...by }));

  // --- Webshop: a lead with four parallel subagents (research, QA, development) and a nested one.
  const ex = { agent_id: 'sim-w-explore', agent_type: 'Explore' };
  const rv = { agent_id: 'sim-w-review', agent_type: 'code-reviewer' };
  const tr = { agent_id: 'sim-w-tests', agent_type: 'test-runner' };
  const gp = { agent_id: 'sim-w-general', agent_type: 'general-purpose' };
  const nx = { agent_id: 'sim-w-nested', agent_type: 'Explore' };
  at(0, w('SessionStart', { source: 'startup', model: 'claude-opus-5-5', session_title: 'Demo: checkout fixes' }));
  at(400, w('UserPromptSubmit', {}));
  tool(900, w, 'w-1', 'Read', { file_path: 'C:\\demo\\webshop\\package.json' }, 300);
  spawn(1500, w, 'w-a1', ex, 'Map the checkout flow');
  spawn(1900, w, 'w-a2', rv, 'Review the cart module');
  spawn(2300, w, 'w-a3', tr, 'Run the cart test suite');
  spawn(2700, w, 'w-a4', gp, 'Refactor price formatting');
  at(3500, w('TaskCreated', { task_id: 'w1', task_subject: 'Fix cart rounding', task_description: 'Use integer cents in totals.ts' }));
  at(3600, w('TaskCreated', { task_id: 'w2', task_subject: 'Review the cart module' }));
  at(3700, w('TaskCreated', { task_id: 'w3', task_subject: 'Add a rounding regression test' }));
  // Explore (research department)
  tool(3000, w, 'wx-1', 'Grep', { pattern: 'calculateTotal', path: 'src' }, 800, ex);
  tool(4200, w, 'wx-2', 'Read', { file_path: 'C:\\demo\\webshop\\src\\cart\\totals.ts' }, 600, ex);
  tool(5200, w, 'wx-3', 'Read', { file_path: 'C:\\demo\\webshop\\src\\checkout\\Summary.tsx' }, 600, ex);
  tool(6200, w, 'wx-4', 'Glob', { pattern: '**/*.test.ts' }, 300, ex);
  tool(7000, w, 'wx-5', 'Read', { file_path: 'C:\\demo\\webshop\\src\\cart\\discounts.ts' }, 600, ex);
  tool(8000, w, 'wx-6', 'Read', { file_path: 'C:\\demo\\webshop\\src\\cart\\tax.ts' }, 2400, ex);
  at(12000, w('SubagentStop', { ...ex, last_assistant_message: 'Totals are computed in src/cart/totals.ts with floating-point math.' }));
  spawned(12100, w, 'w-a1', 10600);
  // general-purpose (development) spawns a nested Explore
  tool(3300, w, 'wg-1', 'Read', { file_path: 'C:\\demo\\webshop\\src\\format\\price.ts' }, 600, gp);
  spawn(4400, w, 'wg-a1', nx, 'Find the currency helpers', gp);
  tool(5000, w, 'wn-1', 'Grep', { pattern: 'formatCurrency', path: 'src' }, 600, nx);
  tool(6000, w, 'wn-2', 'Read', { file_path: 'C:\\demo\\webshop\\src\\format\\currency.ts' }, 800, nx);
  tool(7400, w, 'wn-3', 'Grep', { pattern: 'toFixed\\(', path: 'src' }, 1600, nx);
  tool(9500, w, 'wn-4', 'Read', { file_path: 'C:\\demo\\webshop\\src\\format\\locale.ts' }, 3000, nx);
  at(13000, w('SubagentStop', { ...nx, last_assistant_message: 'Currency helpers live in src/format/currency.ts.' }));
  spawned(13100, w, 'wg-a1', 8700, gp);
  tool(13500, w, 'wg-2', 'Edit', { file_path: 'C:\\demo\\webshop\\src\\format\\price.ts' }, 400, gp);
  tool(14500, w, 'wg-3', 'Edit', { file_path: 'C:\\demo\\webshop\\src\\format\\currency.ts' }, 400, gp);
  tool(15500, w, 'wg-4', 'Write', { file_path: 'C:\\demo\\webshop\\src\\format\\money.ts', content: '[omitted]' }, 400, gp);
  tool(16500, w, 'wg-5', 'Edit', { file_path: 'C:\\demo\\webshop\\src\\checkout\\Summary.tsx' }, 3000, gp);
  tool(20000, w, 'wg-6', 'Edit', { file_path: 'C:\\demo\\webshop\\src\\cart\\totals.ts' }, 3500, gp);
  at(24000, w('SubagentStop', { ...gp, last_assistant_message: 'Price formatting now goes through src/format/money.ts.' }));
  spawned(24100, w, 'w-a4', 21200);
  // code-reviewer (QA department)
  tool(3000, w, 'wr-1', 'Read', { file_path: 'C:\\demo\\webshop\\src\\cart\\index.ts' }, 600, rv);
  tool(4500, w, 'wr-2', 'Grep', { pattern: 'TODO|FIXME', path: 'src/cart' }, 700, rv);
  tool(6000, w, 'wr-3', 'Read', { file_path: 'C:\\demo\\webshop\\src\\cart\\totals.ts' }, 700, rv);
  tool(8000, w, 'wr-4', 'Read', { file_path: 'C:\\demo\\webshop\\src\\cart\\discounts.ts' }, 800, rv);
  tool(10500, w, 'wr-5', 'Read', { file_path: 'C:\\demo\\webshop\\src\\cart\\coupons.ts' }, 700, rv);
  tool(13000, w, 'wr-6', 'Grep', { pattern: 'Math.round', path: 'src' }, 800, rv);
  tool(15000, w, 'wr-7', 'Read', { file_path: 'C:\\demo\\webshop\\src\\cart\\tax.ts' }, 8000, rv);
  at(25800, w('TaskCompleted', { ...rv, task_id: 'w2', task_subject: 'Review the cart module' }));
  at(26000, w('SubagentStop', { ...rv, last_assistant_message: 'Review done: two rounding call sites, both covered.' }));
  spawned(26100, w, 'w-a2', 24000);
  // test-runner (QA department): a failing run, a fix, a passing run
  fail(3200, w, 'wt-1', 'Bash', { command: 'npx vitest run cart', description: 'Run the cart tests' }, 6000, 'Exit code 1: 1 failed (totals rounds 0.1 + 0.2)', tr);
  tool(9800, w, 'wt-2', 'Read', { file_path: 'C:\\demo\\webshop\\src\\cart\\totals.test.ts' }, 500, tr);
  tool(10800, w, 'wt-3', 'Write', { file_path: 'C:\\demo\\webshop\\src\\cart\\rounding.test.ts', content: '[omitted]' }, 400, tr);
  tool(14000, w, 'wt-4', 'Bash', { command: 'npx vitest run cart', description: 'Re-run the cart tests' }, 5000, tr);
  at(19500, w('TaskCompleted', { ...tr, task_id: 'w3', task_subject: 'Add a rounding regression test' }));
  at(20000, w('SubagentStop', { ...tr, last_assistant_message: 'All cart tests pass.' }));
  spawned(20100, w, 'w-a3', 17800);
  // the lead edits, then waits for permission to run the build
  tool(13000, w, 'w-2', 'Edit', { file_path: 'C:\\demo\\webshop\\src\\cart\\totals.ts', old_string: '[omitted]', new_string: '[omitted]' }, 400);
  at(14500, w('PreToolUse', { tool_name: 'Bash', tool_use_id: 'w-3', tool_input: { command: 'npm run build', description: 'Build the shop' } }));
  at(14600, w('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'npm run build', description: 'Build the shop' } }));
  at(14650, w('Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }));
  at(24000, w('PostToolUse', { tool_name: 'Bash', tool_use_id: 'w-3', tool_input: {}, tool_response: { success: true }, duration_ms: 2400 }));
  at(24500, w('TaskCompleted', { task_id: 'w1', task_subject: 'Fix cart rounding' }));
  at(28000, w('Stop', { last_assistant_message: 'Fixed the rounding bug, refactored price formatting and added a regression test.' }));

  // --- API server: a question, then an agent team with three teammates and a task handoff.
  const team = { team_name: 'api-team' };
  const alice = { agent_id: 'sim-tm-alice', agent_type: 'teammate', teammate_name: 'alice', ...team };
  const bob = { agent_id: 'sim-tm-bob', agent_type: 'teammate', teammate_name: 'bob', ...team };
  const carol = { agent_id: 'sim-tm-carol', agent_type: 'teammate', teammate_name: 'carol', ...team };
  const ids = (m: Extra) => ({ agent_id: m.agent_id, agent_type: m.agent_type });
  at(800, a('SessionStart', { source: 'startup', model: 'claude-sonnet-5-5', session_title: 'Demo: orders API v2' }));
  at(1100, a('UserPromptSubmit', {}));
  tool(1600, a, 'a-1', 'Glob', { pattern: 'src/routes/**/*.ts' }, 300);
  at(2400, a('PreToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'a-2', tool_input: { questions: [{ question: 'Should the new endpoint be versioned under /v2?' }] } }));
  at(8400, a('PostToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'a-2', tool_input: {}, tool_response: {} }));
  at(8800, a('TaskCreated', { ...alice, task_id: 'a1', task_subject: 'Implement the /v2/orders route' }));
  at(8900, a('TaskCreated', { ...bob, task_id: 'a2', task_subject: 'Write the OpenAPI spec' }));
  at(9000, a('TaskCreated', { ...carol, task_id: 'a3', task_subject: 'Add contract tests' }));
  at(9200, a('TaskCreated', { task_id: 'a4', task_subject: 'Update the changelog', teammate_name: 'bob', ...team }));
  tool(9500, a, 'aa-1', 'Read', { file_path: 'C:\\demo\\api-server\\src\\routes\\orders.ts' }, 500, ids(alice));
  tool(10500, a, 'aa-2', 'Write', { file_path: 'C:\\demo\\api-server\\src\\routes\\v2\\orders.ts', content: '[omitted]' }, 800, ids(alice));
  tool(12500, a, 'aa-3', 'Edit', { file_path: 'C:\\demo\\api-server\\src\\routes\\index.ts' }, 500, ids(alice));
  tool(15000, a, 'aa-4', 'Bash', { command: 'npm run lint', description: 'Lint the new route' }, 2000, ids(alice));
  tool(18000, a, 'aa-5', 'Edit', { file_path: 'C:\\demo\\api-server\\src\\routes\\v2\\orders.ts' }, 2500, ids(alice));
  at(21000, a('TaskCompleted', { ...alice, task_id: 'a1', task_subject: 'Implement the /v2/orders route' }));
  at(21200, a('TeammateIdle', alice));
  tool(9600, a, 'ab-1', 'WebFetch', { url: 'https://spec.openapis.org/oas/v3.1.0' }, 2200, ids(bob));
  tool(12500, a, 'ab-2', 'Edit', { file_path: 'C:\\demo\\api-server\\openapi.yaml' }, 700, ids(bob));
  tool(15000, a, 'ab-3', 'Edit', { file_path: 'C:\\demo\\api-server\\openapi.yaml' }, 600, ids(bob));
  at(17000, a('TaskCompleted', { ...bob, task_id: 'a2', task_subject: 'Write the OpenAPI spec' }));
  tool(17500, a, 'ab-4', 'Edit', { file_path: 'C:\\demo\\api-server\\CHANGELOG.md' }, 500, ids(bob));
  at(18500, a('TaskCompleted', { ...bob, task_id: 'a4', task_subject: 'Update the changelog' }));
  at(18700, a('TeammateIdle', bob));
  tool(9800, a, 'ac-1', 'Read', { file_path: 'C:\\demo\\api-server\\test\\orders.test.ts' }, 600, ids(carol));
  tool(11000, a, 'ac-2', 'Write', { file_path: 'C:\\demo\\api-server\\test\\v2-orders.test.ts', content: '[omitted]' }, 800, ids(carol));
  tool(13000, a, 'ac-3', 'Bash', { command: 'npm test -- v2-orders', description: 'Run the contract tests' }, 6000, ids(carol));
  at(23000, a('TaskCompleted', { ...carol, task_id: 'a3', task_subject: 'Add contract tests' }));
  at(23200, a('TeammateIdle', carol));
  at(24000, a('Stop', { last_assistant_message: 'Added /v2/orders with an OpenAPI spec and contract tests.' }));

  // --- Infra: a DevOps subagent with a long build and a failing plan; the turn ends with an API error.
  const dv = { agent_id: 'sim-i-devops', agent_type: 'devops-engineer' };
  at(1500, inf('SessionStart', { source: 'resume', model: 'claude-haiku-5-5', session_title: 'Demo: container builds' }));
  at(1800, inf('UserPromptSubmit', {}));
  spawn(2600, inf, 'i-a1', dv, 'Rebuild the images');
  tool(3200, inf, 'id-1', 'Read', { file_path: 'C:\\demo\\infra\\docker-compose.yml' }, 400, dv);
  tool(4200, inf, 'id-2', 'Bash', { command: 'docker compose build', description: 'Build the images' }, 14800, dv);
  fail(20000, inf, 'id-3', 'Bash', { command: 'terraform plan', description: 'Plan the infrastructure change' }, 3000, 'Exit code 1: no credentials configured (demo)', dv);
  at(25000, inf('SubagentStop', { ...dv, last_assistant_message: 'Images built; terraform plan failed.' }));
  spawned(25100, inf, 'i-a1', 22500);
  at(27000, inf('StopFailure', { error: 'rate_limit', last_assistant_message: 'API Error: rate limited' }));

  // --- Payments audit: a security subagent.
  const sec = { agent_id: 'sim-s-security', agent_type: 'security-reviewer' };
  at(2000, s('SessionStart', { source: 'startup', model: 'claude-opus-5-5', session_title: 'Demo: dependency audit' }));
  at(2300, s('UserPromptSubmit', {}));
  spawn(3000, s, 's-a1', sec, 'Scan for leaked secrets');
  tool(3500, s, 'ss-1', 'Grep', { pattern: 'api[_-]?key', path: '.' }, 1000, sec);
  tool(5000, s, 'ss-2', 'Read', { file_path: 'C:\\demo\\payments\\src\\config.ts' }, 800, sec);
  tool(6500, s, 'ss-3', 'Grep', { pattern: 'BEGIN PRIVATE KEY', path: '.' }, 1000, sec);
  tool(8500, s, 'ss-4', 'Read', { file_path: 'C:\\demo\\payments\\package.json' }, 700, sec);
  tool(10000, s, 'ss-5', 'Bash', { command: 'npm audit --omit=dev', description: 'Audit production dependencies' }, 4000, sec);
  tool(15000, s, 'ss-6', 'Read', { file_path: 'C:\\demo\\payments\\src\\webhooks.ts' }, 800, sec);
  tool(17000, s, 'ss-7', 'Grep', { pattern: 'verifySignature', path: 'src' }, 3000, sec);
  at(21000, s('SubagentStop', { ...sec, last_assistant_message: 'No secrets found; one advisory in a dev dependency.' }));
  spawned(21100, s, 's-a1', 18100);
  at(21500, s('TaskCreated', { task_id: 's1', task_subject: 'Upgrade the flagged dependency' }));
  at(23000, s('Stop', { last_assistant_message: 'Audit complete; one follow-up task created.' }));

  // --- Docs site: a Plan subagent researching on the web.
  const pl = { agent_id: 'sim-r-plan', agent_type: 'Plan' };
  at(3000, r('SessionStart', { source: 'startup', model: 'claude-sonnet-5-5', session_title: 'Demo: docs search' }));
  at(3300, r('UserPromptSubmit', {}));
  spawn(3800, r, 'r-a1', pl, 'Plan the docs search feature');
  tool(4400, r, 'rp-1', 'WebSearch', { query: 'static site search index' }, 2000, pl);
  tool(7000, r, 'rp-2', 'WebFetch', { url: 'https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API' }, 2500, pl);
  tool(10000, r, 'rp-3', 'Read', { file_path: 'C:\\demo\\docs-site\\src\\search.ts' }, 600, pl);
  tool(11000, r, 'rp-4', 'Glob', { pattern: 'content/**/*.md' }, 300, pl);
  tool(12000, r, 'rp-5', 'Read', { file_path: 'C:\\demo\\docs-site\\astro.config.mjs' }, 3000, pl);
  at(16000, r('SubagentStop', { ...pl, last_assistant_message: 'Plan: build a static index at build time and search it in a worker.' }));
  spawned(16100, r, 'r-a1', 12300);
  tool(17000, r, 'r-1', 'Write', { file_path: 'C:\\demo\\docs-site\\PLAN.md', content: '[omitted]' }, 600);
  at(18500, r('Stop', { last_assistant_message: 'Wrote the search plan to PLAN.md.' }));

  return steps.sort((x, y) => x.at - y.at);
}

export function endShowcaseScenario(runId = '0001'): Record<string, unknown>[] {
  return showcaseSessions(runId).map((id) => ({ session_id: id, hook_event_name: 'SessionEnd', reason: 'other', cwd: 'C:\\demo' }));
}

/** Named demo scenarios for `agent-office simulate --scenario <name>`. */
export const SCENARIOS = {
  default: { build: buildScenario, end: endScenario },
  showcase: { build: buildShowcaseScenario, end: endShowcaseScenario },
} as const satisfies Record<string, { build(runId: string): ScriptStep[]; end(runId: string): Record<string, unknown>[] }>;

export type ScenarioName = keyof typeof SCENARIOS;

export function isScenarioName(name: string): name is ScenarioName {
  return Object.hasOwn(SCENARIOS, name);
}
