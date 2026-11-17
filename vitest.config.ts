import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/core', 'packages/monitor', 'packages/ui', 'packages/vscode-extension'],
  },
});
