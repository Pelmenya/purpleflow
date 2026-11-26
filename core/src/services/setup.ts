// Установка недостающих инструментов из окна. Имена пакетов зашиты здесь: окно передаёт только имя инструмента, а не команду.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addToPath, detectTool, prependPath, which } from '../env.js';
import { run } from '../proc.js';
import type { ToolInstallResult, ToolName } from '../types.js';

const NPM_PACKAGES: Partial<Record<ToolName, string>> = {
  claude: '@anthropic-ai/claude-code',
  codex: '@openai/codex',
  opencode: 'opencode-ai',
  openspec: '@fission-ai/openspec',
};

/**
 * npm 11 по умолчанию не запускает install-скрипты пакетов, а claude-code без своего скрипта не ставит исполняемый файл.
 * Разрешаем скрипт только ему — так же делал прежний мастер ai-for-code. Старый npm принимает флаг как обычный параметр.
 */
const ALLOW_SCRIPTS: Partial<Record<ToolName, string[]>> = {
  claude: ['--allow-scripts=@anthropic-ai/claude-code'],
};

const INSTALL_TIMEOUT_MS = 5 * 60_000;

/** git ставится средствами ОС и просит подтверждения у пользователя: делать это молча нельзя. */
function gitHint(): string {
  if (process.platform === 'darwin') return 'Git ставится вместе с инструментами Xcode: выполните xcode-select --install в терминале.';
  if (process.platform === 'win32') return 'Установите Git с git-scm.com или командой winget install Git.Git.';
  return 'Установите Git через пакетный менеджер системы.';
}

/**
 * У Antigravity CLI нет пакета в npm: он ставится своим установщиком Google и требует входа в аккаунт.
 * Молча качать чужой установщик из окна нельзя — человек ставит сам и указывает путь в настройках.
 */
function agyHint(): string {
  return 'Antigravity CLI ставится установщиком с antigravity.google/docs/cli/install, отдельного npm-пакета нет. С AI-прокси PurpleSchool вход в Google не нужен; без прокси agy работает через ваш аккаунт Google. После установки укажите путь к agy в настройках, если он не попал в PATH.';
}

/** Последние строки вывода: в начале npm пишет предупреждения, причина сбоя — в конце. */
const tail = (s: string) => s.trim().split('\n').slice(-3).join('\n').slice(-400);

/**
 * npm install --global одного пакета без sudo: при EACCES — в ~/.npm-global. После установки каталог с командой
 * дописывается в PATH этого процесса, чтобы она нашлась без перезапуска. Общая часть для инструментов PurpleFlow
 * и агентов, которые ставит установщик (Pi, Qwen Code).
 */
export async function installNpmGlobal(
  command: string,
  pkg: string,
  env: NodeJS.ProcessEnv,
  extraArgs: string[] = [],
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const npm = which('npm', env);
  if (!npm) return { ok: false, error: 'Не найден npm: сначала нужен Node.js.' };

  const npmEnv = prependPath(env, path.dirname(npm));
  const install = (extra: string[] = []) =>
    run(npm, ['install', '--global', '--no-audit', '--no-fund', ...extraArgs, ...extra, pkg], {
      cwd: os.homedir(),
      env: npmEnv,
      timeoutMs: INSTALL_TIMEOUT_MS,
      group: 'tool-setup',
    });

  let r = await install();
  // Системный Node пишет в каталог root. sudo из окна не просим: ставим в домашний каталог, его PATH дополняется в env.ts.
  if (r.code !== 0 && process.platform !== 'win32' && /EACCES|EPERM/.test(r.stderr)) {
    const prefix = path.join(os.homedir(), '.npm-global');
    fs.mkdirSync(prefix, { recursive: true });
    r = await install(['--prefix', prefix]);
    if (r.code === 0) addToPath(env, path.join(prefix, 'bin'));
  }
  if (r.spawnError || r.timedOut || r.code !== 0) {
    const why = r.timedOut ? 'Установка не уложилась в 5 минут' : r.spawnError || tail(r.stderr || r.stdout) || `код ${r.code}`;
    return { ok: false, error: `Не удалось установить ${pkg}: ${why}` };
  }

  let found = which(command, env);
  if (!found) {
    // Каталог npm мог появиться только сейчас (на Windows это %APPDATA%\npm), поэтому в начальном PATH его не было.
    const prefix = (await run(npm, ['prefix', '--global'], { cwd: os.homedir(), env: npmEnv, timeoutMs: 15_000 })).stdout.trim();
    if (prefix) {
      addToPath(env, process.platform === 'win32' ? prefix : path.join(prefix, 'bin'));
      found = which(command, env);
    }
  }
  return found ? { ok: true, path: found } : { ok: false, error: `${pkg} установлен, но ${command} не найден в PATH.` };
}

export async function installTool(name: ToolName, env: NodeJS.ProcessEnv, manual?: string): Promise<ToolInstallResult> {
  const pkg = NPM_PACKAGES[name];
  if (!pkg) return { name, ok: false, error: name === 'git' ? gitHint() : name === 'agy' ? agyHint() : `Неизвестный инструмент: ${name}` };
  // Установка не исправит чужой путь: окно продолжит запускать файл, указанный вручную.
  if (manual?.trim()) return { name, ok: false, error: 'Указан путь вручную. Очистите его, чтобы установить инструмент автоматически.' };
  const r = await installNpmGlobal(name, pkg, env, ALLOW_SCRIPTS[name] ?? []);
  if (!r.ok) return { name, ok: false, error: r.error };
  const info = await detectTool(name, env);
  if (info.error) return { name, ok: false, info, error: info.error };
  return { name, ok: true, info };
}
