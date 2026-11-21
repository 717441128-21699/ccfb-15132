import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: 'web',
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
      '@player': fileURLToPath(new URL('./player', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8080', changeOrigin: true },
      '/streams': { target: 'http://localhost:8080', changeOrigin: true },
    },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL('./web/index.html', import.meta.url)),
        debug: fileURLToPath(new URL('./web/debug.html', import.meta.url)),
        stats: fileURLToPath(new URL('./web/stats.html', import.meta.url)),
      },
    },
  },
  test: {
    root: fileURLToPath(new URL('.', import.meta.url)),
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: ['test/e2e-browser.test.ts', '**/node_modules/**'],
    globals: false,
  },
});
