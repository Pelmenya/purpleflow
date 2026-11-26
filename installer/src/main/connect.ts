// Запуск процесса настройки (connect/worker.ts) и пересылка его хода окну.
import os from 'node:os';
import path from 'node:path';
import { utilityProcess } from 'electron';
import type { ConnectProgress, WorkerRequest, WorkerResponse } from '../shared/connect';

export function runWorker(req: WorkerRequest, onProgress: (p: ConnectProgress) => void = () => {}): Promise<WorkerResponse> {
  return new Promise((resolve) => {
    // Окружение login-шелла уже в process.env: PATH с node, claude и codex, SHELL, CLAUDE_CONFIG_DIR, CODEX_HOME.
    // Команды проверок (opencode --version, code --list-extensions) запускаются из домашней папки, как в новом
    // терминале: менеджеры версий (mise, asdf, nvm) выбирают Node по папке, и .nvmrc случайной папки ломал бы их.
    const child = utilityProcess.fork(path.join(__dirname, 'connect.js'), [], {
      env: process.env,
      cwd: os.homedir(),
      serviceName: 'Установщик PurpleFlow: настройка',
    });
    let settled = false;
    const finish = (r: WorkerResponse) => {
      if (settled) return;
      settled = true;
      resolve(r);
      child.kill();
    };
    child.on('message', (m: WorkerResponse) => {
      if (m.type === 'progress') onProgress(m.progress);
      else finish(m);
    });
    // Сюда попадаем, только если процесс упал, не ответив: штатно его закрывает finish.
    child.on('exit', (code) => finish({ type: 'error', error: `процесс настройки неожиданно завершился (код ${code})` }));
    child.once('spawn', () => child.postMessage(req));
  });
}
