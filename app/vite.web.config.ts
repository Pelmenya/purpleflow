import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: resolve(__dirname, 'src/web'),
  base: '/',
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer/src'),
      '@purpleflow/route': resolve(__dirname, '../core/src/route.ts'),
      '@sentry/electron/renderer': resolve(__dirname, 'src/web/sentry-stub.ts'),
    },
  },
  plugins: [react()],
  worker: { format: 'es' },
  build: {
    outDir: resolve(__dirname, 'out/web'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'src/web/index.html'),
        login: resolve(__dirname, 'src/web/login.html'),
      },
    },
  },
});
