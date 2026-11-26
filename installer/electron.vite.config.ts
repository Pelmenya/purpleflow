import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

// Установка окружения — те же модули ядра, что у кнопки «Настроить» в PurpleFlow: собираются из исходников core/src.
const coreAlias = { '@core': resolve(__dirname, '../core/src') };

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['@purpleflow/core'] })],
    resolve: { alias: coreAlias },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          // Процесс настройки приложений (перенесённый мастер ai-for-code): отдельный бандл для utilityProcess.
          connect: resolve(__dirname, 'src/main/connect/worker.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {},
});
