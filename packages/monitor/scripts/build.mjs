import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'warning',
  // `ws` optional native accelerators are not needed.
  external: ['bufferutil', 'utf-8-validate'],
};

await build({ ...common, entryPoints: [join(root, 'src/cli.ts')], outfile: join(root, 'dist/cli.cjs'), banner: { js: '#!/usr/bin/env node' } });
// The hook forwarder must start fast: no dependencies beyond node builtins and core.
await build({ ...common, entryPoints: [join(root, 'src/forwarder.ts')], outfile: join(root, 'dist/agent-office-hook.cjs'), minify: true });
console.log('monitor built: dist/cli.cjs, dist/agent-office-hook.cjs');
