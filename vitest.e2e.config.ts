import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    root: fileURLToPath(new URL('.', import.meta.url)),
    environment: 'node',
    include: ['test/e2e-browser.test.ts'],
    globals: true,
    testTimeout: 40_000,
    hookTimeout: 35_000,
  },
});
