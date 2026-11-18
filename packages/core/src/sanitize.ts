/**
 * Data minimisation for hook payloads: the monitor never stores full tool inputs or responses, only a
 * short, secret-redacted summary that answers "what is this agent doing?".
 */

const SECRET_RULES: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, '[REDACTED PRIVATE KEY]'],
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, 'sk-ant-[REDACTED]'],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}/g, 'sk-[REDACTED]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, 'github_pat_[REDACTED]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, 'gh_[REDACTED]'],
  [/\bglpat-[A-Za-z0-9_-]{16,}/g, 'glpat-[REDACTED]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, 'xox-[REDACTED]'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, 'AKIA[REDACTED]'],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, 'AIza[REDACTED]'],
  [/\bnpm_[A-Za-z0-9]{30,}/g, 'npm_[REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[REDACTED JWT]'],
  [/\b(bearer|basic|token)(\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1$2[REDACTED]'],
  // credentials embedded in URLs: scheme://user:pass@host
  [/([a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)[^@\s/]+@/gi, '$1[REDACTED]@'],
  // --password value / --token=value
  [
    /(--?(?:password|passwd|pass|token|secret|api[-_]?key|access[-_]?key|auth|client[-_]?secret)(?:\s+|=))("[^"]*"|'[^']*'|[^\s"']+)/gi,
    '$1[REDACTED]',
  ],
  // KEY=value, "key": "value", key: value where the key name looks secret
  [
    /((?:^|[\s"'{,;&?])[A-Za-z0-9_.-]*?(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential|auth)[A-Za-z0-9_.-]*["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s"',;&}]+)/gi,
    '$1[REDACTED]',
  ],
];

export function redactSecrets(input: string): string {
  let out = input;
  for (const [re, replacement] of SECRET_RULES) out = out.replace(re, replacement);
  return out;
}

export function truncate(input: string, max: number): string {
  if (input.length <= max) return input;
  return input.slice(0, Math.max(0, max - 1)) + '…';
}

export function oneLine(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

/** Redact, collapse whitespace and truncate: the standard treatment for free text. */
export function safeText(input: unknown, max = 240): string | undefined {
  if (typeof input !== 'string') return undefined;
  const t = truncate(oneLine(redactSecrets(input)), max);
  return t.length ? t : undefined;
}

/** Like safeText but keeps line breaks (used for last assistant messages and errors). */
export function safeMultiline(input: unknown, max = 600): string | undefined {
  if (typeof input !== 'string') return undefined;
  const t = truncate(redactSecrets(input).replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(), max);
  return t.length ? t : undefined;
}

/** Strip query string and fragment, which frequently contain tokens. */
export function safeUrl(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined;
  try {
    const u = new URL(input);
    u.username = '';
    u.password = '';
    const hadQuery = u.search.length > 0;
    return truncate(`${u.protocol}//${u.host}${u.pathname}${hadQuery ? '?…' : ''}`, 200);
  } catch {
    return safeText(input.split(/[?#]/)[0], 200);
  }
}

export interface ToolSummary {
  /** Short human readable description, e.g. "Run tests" or "Edit server.ts". */
  summary: string;
  /** Primary target such as a file path, command or URL (redacted and truncated). */
  target?: string;
  /** MCP server for mcp__server__tool tools. */
  mcpServer?: string;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function fileLabel(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/**
 * Summarise a tool call from its (untrusted) input without retaining content such as
 * file bodies, edit strings, prompts or full command output.
 */
export function summarizeToolInput(toolName: string, input: unknown): ToolSummary {
  const i: Record<string, unknown> = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};

  if (toolName.startsWith('mcp__')) {
    const [, server = '?', ...rest] = toolName.split('__');
    const tool = rest.join('__') || '?';
    const keys = Object.keys(i).slice(0, 6);
    return {
      summary: truncate(`${server} › ${tool}`, 120),
      target: keys.length ? truncate(`args: ${keys.join(', ')}`, 160) : undefined,
      mcpServer: truncate(server, 80),
    };
  }

  switch (toolName) {
    case 'Bash':
    case 'PowerShell':
    case 'BashOutput': {
      const cmd = safeText(i.command, 200);
      const desc = safeText(i.description, 120);
      return { summary: desc ?? cmd ?? toolName, target: cmd };
    }
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
    case 'NotebookRead': {
      const p = str(i.file_path) ?? str(i.notebook_path) ?? str(i.path);
      return p
        ? { summary: `${toolName} ${truncate(fileLabel(p), 80)}`, target: truncate(p, 260) }
        : { summary: toolName };
    }
    case 'Glob': {
      const pattern = safeText(i.pattern, 120);
      return { summary: pattern ? `Glob ${pattern}` : 'Glob', target: safeText(i.path, 260) };
    }
    case 'Grep': {
      const pattern = safeText(i.pattern, 100);
      return { summary: pattern ? `Grep ${pattern}` : 'Grep', target: safeText(i.path, 260) ?? safeText(i.glob, 120) };
    }
    case 'WebFetch': {
      const url = safeUrl(i.url);
      return { summary: url ? `Fetch ${url}` : 'WebFetch', target: url };
    }
    case 'WebSearch': {
      const q = safeText(i.query, 120);
      return { summary: q ? `Search "${q}"` : 'WebSearch' };
    }
    case 'Agent':
    case 'Task': {
      const desc = safeText(i.description, 120);
      const type = safeText(i.subagent_type, 80);
      return { summary: desc ? `Delegate: ${desc}` : 'Delegate to subagent', target: type };
    }
    case 'TodoWrite': {
      const todos = Array.isArray(i.todos) ? i.todos : [];
      const by = { pending: 0, in_progress: 0, completed: 0 };
      for (const t of todos) {
        const s = t && typeof t === 'object' ? (t as Record<string, unknown>).status : undefined;
        if (s === 'pending' || s === 'in_progress' || s === 'completed') by[s]++;
      }
      return { summary: `Todo list: ${todos.length} items (${by.completed} done, ${by.in_progress} active)` };
    }
    case 'AskUserQuestion': {
      const qs = Array.isArray(i.questions) ? i.questions : [];
      const first = qs[0] && typeof qs[0] === 'object' ? (qs[0] as Record<string, unknown>) : {};
      const q = safeText(first.question ?? first.header, 120);
      return { summary: q ? `Asking: ${q}` : 'Asking the user a question' };
    }
    case 'ExitPlanMode':
      return { summary: 'Requesting plan approval' };
    case 'Skill': {
      const s = safeText(i.skill ?? i.name, 80);
      return { summary: s ? `Skill ${s}` : 'Skill' };
    }
    case 'SlashCommand': {
      const c = safeText(i.command, 80);
      return { summary: c ? `Command ${c.split(' ')[0]}` : 'SlashCommand' };
    }
    default: {
      const subject = safeText(i.subject ?? i.description ?? i.title, 120);
      if (subject) return { summary: `${toolName}: ${subject}` };
      const keys = Object.keys(i).slice(0, 5);
      return { summary: keys.length ? truncate(`${toolName} (${keys.join(', ')})`, 120) : toolName };
    }
  }
}

const MAX_STRING = 2000;

function trimDeep(v: unknown, depth: number): unknown {
  if (typeof v === 'string') return v.length > MAX_STRING ? v.slice(0, MAX_STRING) + '…' : v;
  if (v === null || typeof v !== 'object') return v;
  if (depth <= 0) return Array.isArray(v) ? `[array(${v.length})]` : '[object]';
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => trimDeep(x, depth - 1));
  const out: Record<string, unknown> = {};
  let n = 0;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (n++ >= 40) break;
    out[k] = trimDeep(val, depth - 1);
  }
  return out;
}

/**
 * Applied by the hook forwarder before anything leaves the Claude Code process tree: drops fields we never
 * use (prompts, tool responses, permission suggestions) and bounds the rest. The monitor normalises again,
 * so this only needs to be conservative, not complete.
 */
export function pretrimHookPayload(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    switch (k) {
      case 'prompt':
      case 'tool_calls':
      case 'permission_suggestions':
      case 'session_crons':
      case 'error_details':
        continue;
      case 'tool_response': {
        if (v && typeof v === 'object' && !Array.isArray(v) && 'success' in v) {
          out.tool_response = { success: Boolean((v as Record<string, unknown>).success) };
        }
        continue;
      }
      case 'background_tasks': {
        if (Array.isArray(v)) {
          out.background_tasks = v.slice(0, 50).map((t) =>
            t && typeof t === 'object' ? { status: (t as Record<string, unknown>).status } : {},
          );
        }
        continue;
      }
      case 'tool_input':
        out.tool_input = trimDeep(v, 3);
        continue;
      default:
        out[k] = trimDeep(v, 2);
    }
  }
  return out;
}
