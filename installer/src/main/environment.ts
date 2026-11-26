// Обязательное окружение: Node.js и git. Ставится теми же модулями ядра, что и кнопка «Настроить»
// в самом PurpleFlow, — поведение одно, исправления не расходятся.
import fs from 'node:fs';
import os from 'node:os';
import { addToPath, detectTool, which } from '@core/env';
import { run } from '@core/proc';
import { detectNode, installNode } from '@core/services/node';
import type { StepState } from '../shared/types';

type Emit = (s: StepState) => void;

const GIT_WAIT_MS = 30 * 60_000;
const GIT_POLL_MS = 4000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function checkNode(env: NodeJS.ProcessEnv): Promise<StepState> {
  const n = await detectNode(env);
  return n.path ? { id: 'node', status: 'ok', detail: n.version ?? undefined } : { id: 'node', status: 'missing' };
}

/** Инструменты Xcode стоят? Без них /usr/bin/git — заглушка, и её запуск сам открывает системное окно. */
async function xcodeToolsReady(env: NodeJS.ProcessEnv): Promise<boolean> {
  const r = await run('xcode-select', ['-p'], { cwd: os.homedir(), env, timeoutMs: 15_000 });
  return r.code === 0;
}

export async function checkGit(env: NodeJS.ProcessEnv): Promise<StepState> {
  const p = which('git', env);
  if (!p) return { id: 'git', status: 'missing' };
  if (process.platform === 'darwin' && p === '/usr/bin/git' && !(await xcodeToolsReady(env))) return { id: 'git', status: 'missing' };
  const t = await detectTool('git', env);
  return t.error ? { id: 'git', status: 'missing' } : { id: 'git', status: 'ok', detail: t.version ?? undefined };
}

export async function ensureNode(env: NodeJS.ProcessEnv, emit: Emit): Promise<boolean> {
  const cur = await checkNode(env);
  if (cur.status === 'ok') {
    emit(cur);
    return true;
  }
  emit({ id: 'node', status: 'running', detail: 'Скачиваем Node.js' });
  const r = await installNode(env);
  emit(r.ok ? { id: 'node', status: 'done', detail: r.info?.version ?? undefined } : { id: 'node', status: 'failed', detail: r.error });
  return r.ok;
}

/**
 * git ставится средствами ОС. На macOS — системное окно «Установить инструменты разработчика»: его подтверждает
 * сам пользователь, мы только открываем его и ждём. На Windows — winget, на Linux — подсказка.
 */
export async function ensureGit(env: NodeJS.ProcessEnv, emit: Emit): Promise<boolean> {
  const cur = await checkGit(env);
  if (cur.status === 'ok') {
    emit(cur);
    return true;
  }

  if (process.platform === 'darwin') {
    emit({ id: 'git', status: 'running' });
    await run('xcode-select', ['--install'], { cwd: os.homedir(), env, timeoutMs: 30_000 });
    emit({ id: 'git', status: 'waiting', detail: 'Нажмите «Установить» в системном окне и дождитесь конца установки' });
    const until = Date.now() + GIT_WAIT_MS;
    while (Date.now() < until) {
      await sleep(GIT_POLL_MS);
      const s = await checkGit(env);
      if (s.status === 'ok') {
        emit({ ...s, status: 'done' });
        return true;
      }
    }
    emit({
      id: 'git',
      status: 'failed',
      detail: 'Не дождались установки. Выполните xcode-select --install или поставьте Git с git-scm.com.',
    });
    return false;
  }

  if (process.platform === 'win32') {
    const winget = which('winget', env);
    if (!winget) {
      emit({ id: 'git', status: 'failed', detail: 'Нет winget. Установите Git с git-scm.com.' });
      return false;
    }
    emit({ id: 'git', status: 'running', detail: 'Ставим Git через winget' });
    const r = await run(
      winget,
      [
        'install',
        '--id',
        'Git.Git',
        '--exact',
        '--silent',
        '--source',
        'winget',
        '--accept-source-agreements',
        '--accept-package-agreements',
      ],
      { cwd: os.homedir(), env, timeoutMs: 15 * 60_000 },
    );
    // Git for Windows дописывает PATH в реестр, а наш процесс его уже прочитал.
    for (const d of ['C:\\Program Files\\Git\\cmd', `${process.env.LOCALAPPDATA ?? ''}\\Programs\\Git\\cmd`]) {
      if (fs.existsSync(d)) addToPath(env, d);
    }
    const s = await checkGit(env);
    if (s.status === 'ok') {
      emit({ ...s, status: 'done' });
      return true;
    }
    const why = (r.spawnError || r.stdout || r.stderr).trim().split('\n').slice(-2).join(' ').slice(0, 300);
    emit({ id: 'git', status: 'failed', detail: `Не удалось поставить Git${why ? `: ${why}` : ''}. Установите его с git-scm.com.` });
    return false;
  }

  emit({ id: 'git', status: 'failed', detail: 'Установите Git пакетным менеджером системы, например: sudo apt install git' });
  return false;
}
