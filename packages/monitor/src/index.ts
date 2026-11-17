export { createMonitor, MONITOR_VERSION, type Monitor, type MonitorOptions } from './server';
export { defaultPlugins } from './plugins';
export type { MonitorPlugin, PluginContext, RpcHandler } from './plugin';
export { loadOrCreateConfig, readConfig, resolveAppHome, resolveClaudeDirs, defaultClaudeDir, type AppConfig } from './config';
export {
  applyPlan,
  describePlan,
  findNodeExecutable,
  FORWARDER_FILE,
  inspectClaudeDir,
  installForwarder,
  planInstall,
  planUninstall,
  projectSettingsPath,
  userSettingsPath,
  type HookMode,
  type HookPlan,
} from './hooks';
export { buildScenario, buildShowcaseScenario, endScenario, endShowcaseScenario, isScenarioName, SCENARIOS, showcaseSessions, simSessions, type ScenarioName } from './simulate';
