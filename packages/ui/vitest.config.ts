import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { name: 'ui', include: ['test/**/*.test.{ts,tsx}'], environment: 'jsdom' },
});
