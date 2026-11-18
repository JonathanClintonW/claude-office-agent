/**
 * Zero-extra-inference diagnostics. The counters cover only what the Agent Office runtime itself does,
 * never the tokens the user's own Claude Code sessions consume.
 */
export interface InferenceDiagnostics {
  /** 'active' when the runtime guard is installed in this process. */
  guard: 'active' | 'inactive';
  /** Runtime paths the guard instruments, e.g. ['http', 'https', 'fetch', 'child_process']. */
  instrumented: string[];
  /** Model-inference requests or Claude process launches initiated by the office runtime. Must stay 0. */
  officeInferenceCalls: number;
  /** Non-loopback network requests initiated by the office runtime. Expected 0. */
  externalRequests: number;
  lastViolation?: { at: number; kind: string; target: string };
  /** Process kind the monitor runs in. The guard never patches the shared VS Code extension host ('electron'). */
  host?: 'node' | 'electron';
  /** Why the guard is inactive (for example the shared VS Code extension host). */
  inactiveReason?: string;
  /** Inference attempts stopped before anything left the process. Equals officeInferenceCalls while the guard is active. */
  blocked?: number;
  /** Requests to 127.0.0.1, localhost, ::1 or a local socket: hook forwarding, health checks, WebSockets. */
  loopbackRequests?: number;
  /** Child processes started by the office runtime: read-only git, the OS browser opener for `--open`, anything else. */
  processLaunches?: { git: number; browser: number; other: number };
  /** Epoch ms when the counters started (guard install or last reset). */
  since?: number;
  /** The static test that covers code paths the runtime guard cannot observe. */
  staticCheck?: string;
}

/** Settings files containing Agent Office hooks. Installing in two scopes makes every hook fire twice. */
export interface HookScopeReport {
  scopes: Array<{ scope: 'user' | 'project' | 'project-local'; path: string; events: string[] }>;
  /** Hook events registered in more than one scope. Empty when there is no duplication. */
  duplicateEvents: string[];
  checkedAt: number;
}

/** What the `inference` plugin publishes under `MonitorMeta.plugins.inference`. */
export interface InferencePluginMeta extends InferenceDiagnostics {
  hookScopes?: HookScopeReport;
}

/** Repository path of the static zero-inference test, shown wherever the runtime guard cannot run. */
export const ZERO_INFERENCE_STATIC_TEST = 'packages/monitor/test/staticNoInference.test.ts';
