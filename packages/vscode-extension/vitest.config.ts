import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { name: 'vscode-extension', include: ['test/**/*.test.ts'], environment: 'node', testTimeout: 20000 },
});
