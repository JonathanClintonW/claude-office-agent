import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { name: 'monitor', include: ['test/**/*.test.ts'], environment: 'node', testTimeout: 20000, hookTimeout: 30000 },
});
