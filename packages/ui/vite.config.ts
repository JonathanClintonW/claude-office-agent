import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/**
 * Dev only: inject the local monitor token so `npm run dev:ui` can talk to `agent-office start --dev`.
 * Production builds contain no token; the monitor (or the VS Code extension) injects it at serve time.
 */
function devMonitorConfig(): Plugin {
  return {
    name: 'agent-office-dev-config',
    apply: 'serve',
    transformIndexHtml(html) {
      try {
        const home = process.env.AGENT_OFFICE_HOME || join(homedir(), '.agent-office');
        const cfg = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as { port: number; token: string };
        const inject = { token: cfg.token, wsUrl: `ws://127.0.0.1:${cfg.port}/ws` };
        return html.replace('<head>', `<head><script>window.__AGENT_OFFICE__=${JSON.stringify(inject)}</script>`);
      } catch {
        return html;
      }
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), devMonitorConfig()],
  // assetsInlineLimit 0: fonts must be real files; data: URIs are blocked by the strict CSP.
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1500, sourcemap: false, assetsInlineLimit: 0 },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
});
