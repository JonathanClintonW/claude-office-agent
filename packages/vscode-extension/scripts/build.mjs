import { build } from 'esbuild';
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const common = { bundle: true, platform: 'node', target: 'node20', format: 'cjs', logLevel: 'warning', legalComments: 'none' };

await build({
  ...common,
  entryPoints: [join(root, 'src/extension.ts')],
  outfile: join(root, 'dist/extension.cjs'),
  external: ['vscode', 'bufferutil', 'utf-8-validate'],
  minify: true,
});
await build({ ...common, entryPoints: [join(root, '../monitor/src/forwarder.ts')], outfile: join(root, 'dist/agent-office-hook.cjs'), minify: true });

const ui = join(root, '../ui/dist');
if (!existsSync(join(ui, 'index.html'))) throw new Error('Build the UI first: npm run build -w @agent-office/ui');
rmSync(join(root, 'media/ui'), { recursive: true, force: true });
cpSync(ui, join(root, 'media/ui'), { recursive: true });
// Bundled fonts are SIL OFL 1.1: their licence text must ship with them.
const modules = join(root, '../../node_modules');
for (const font of ['pixelify-sans', 'silkscreen']) {
  cpSync(join(modules, '@fontsource', font, 'LICENSE'), join(root, 'media/ui/licenses', `${font}-OFL.txt`));
}
// The bundles strip licence comments, so ship the notices of every bundled package (MIT, ISC,
// BSD-3-Clause all require the notice to travel with copies).
const BUNDLED = [
  'react',
  'react-dom',
  'scheduler',
  'pixi.js',
  'eventemitter3',
  'earcut',
  'colord',
  'ismobilejs',
  'parse-svg-path',
  '@xmldom/xmldom',
  'gifuct-js',
  'js-binary-schema-parser',
  'tiny-lru',
  'ws',
];
const missing = [];
for (const name of BUNDLED) {
  const dir = join(modules, name);
  const file = existsSync(dir) ? readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(f)) : undefined;
  if (!file) {
    missing.push(name);
    continue;
  }
  const { version, license } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const text = readFileSync(join(dir, file), 'utf8');
  writeFileSync(join(root, 'media/ui/licenses', `${name.replace('/', '__')}-LICENSE.txt`), `${name}@${version} (${license})\n\n${text}`);
}
if (missing.length) throw new Error(`No licence file found for bundled package(s): ${missing.join(', ')}`);
for (const f of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
  if (existsSync(join(root, '../..', f))) cpSync(join(root, '../..', f), join(root, f));
}
console.log('extension built: dist/extension.cjs, dist/agent-office-hook.cjs, media/ui');
