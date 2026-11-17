// The plugin set used by the CLI monitor and the VS Code embedded monitor.
import type { MonitorPlugin } from '../plugin';
import { gitPlugin } from './git';
import { historyPlugin } from './history';
import { inferencePlugin } from './inference';
import { usagePlugin } from './usage';

/** Fresh plugin instances (each monitor needs its own). All plugins are passive and inference-free. */
export function defaultPlugins(): MonitorPlugin[] {
  return [inferencePlugin(), usagePlugin(), historyPlugin(), gitPlugin()];
}
