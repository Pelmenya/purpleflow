import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { installNpmGlobal, installTool } from '@core/services/setup';
import { commandExists, homeDir, platform } from './os.js';

/** Windows editor/npm launchers are .cmd files, not executables. Only constant flags are accepted. */
export function runCommand(command: string, args: string[], timeout = 15000, input?: string): string {
  const options = {
    cwd: homeDir(),
    encoding: 'utf8' as const,
    timeout,
    input,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] as ['ignore' | 'pipe', 'pipe', 'pipe'],
  };
  if (platform() === 'win32' && !command.toLowerCase().endsWith('.exe')) {
    const parts = [command, ...args];
    if (parts.some((part) => /["%\r\n!]/.test(part))) throw new Error('Недопустимый путь или аргумент команды Windows.');
    return execSync(parts.map((part) => `"${part}"`).join(' '), options).trim();
  }
  return execFileSync(command, args, options).trim();
}

export function requireCommand(command: string, installHelp: string, minVersion?: string): string {
  if (!commandExists(command)) throw new Error(`${command} не найден. ${installHelp} Затем запусти мастер снова.`);
  let version: string;
  try {
    version = runCommand(command, ['--version']);
  } catch {
    throw new Error(`Не удалось запустить ${command} --version. Исправь установку приложения и повтори настройку.`);
  }
  if (!version) throw new Error(`${command} не вернул версию. Проверь установку приложения.`);
  if (minVersion && !versionAtLeast(version, minVersion)) {
    throw new Error(`Для ${command} нужна версия ${minVersion} или новее. Установлена: ${version}. ${installHelp}`);
  }
  return version;
}

export function versionAtLeast(value: string, minimum: string): boolean {
  const match = value.match(/(?:^|\s|v)(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const current = match.slice(1).map(Number);
  const required = minimum.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (current[i] !== required[i]) return current[i]! > required[i]!;
  }
  return true;
}

/**
 * Только два пакета, которые мастеру разрешено ставить. Ставит их тот же модуль ядра, что и кнопка «Настроить»
 * в PurpleFlow: без sudo, с запасным каталогом ~/.npm-global при EACCES и с дополнением PATH этого процесса.
 */
export async function ensureAssistantCli(command: 'claude' | 'codex', dryRun: boolean): Promise<void> {
  if (commandExists(command)) {
    requireCommand(command, `Переустанови ${command}.`);
    return;
  }
  const packageName = command === 'claude' ? '@anthropic-ai/claude-code' : '@openai/codex';
  if (dryRun) return;
  const r = await installTool(command, process.env);
  if (!r.ok) throw new Error(`Не удалось установить ${packageName}: ${r.error ?? 'неизвестная ошибка'}`);
  requireCommand(command, 'Установка прошла, но команда не запускается.');
}

export function resolveExecutable(command: string): string | undefined {
  const suffixes = platform() === 'win32' ? ['.cmd', '.exe', '.bat', ''] : [''];
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const suffix of suffixes) {
      const file = path.join(directory, command + suffix);
      try {
        if (!fs.statSync(file).isFile()) continue;
        fs.accessSync(file, platform() === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
        return file;
      } catch {
        /* Try another PATH entry. */
      }
    }
  }
  return undefined;
}

/** Версия Node, которой будут работать агенты: та, что в PATH пользователя, а не Node внутри установщика. */
export function systemNodeVersion(): string | undefined {
  try {
    return runCommand('node', ['--version']).replace(/^v/, '');
  } catch {
    return undefined;
  }
}

export interface NpmCli {
  command: string;
  pkg: string;
  /** Минимальная версия самого агента. */
  min?: string;
  /** Минимальная версия Node (engines пакета). */
  node?: string;
  extraArgs?: string[];
}

/**
 * Агент в терминале: есть — проверяем версию, нет — ставим из npm (без sudo, как claude и codex). Установщик
 * показывает агентов всегда, поэтому «не найден» здесь — повод поставить, а не ошибка.
 */
export async function ensureNpmCli(cli: NpmCli, dryRun: boolean): Promise<void> {
  const help = `Обновите его: npm install -g ${cli.pkg}`;
  if (cli.node) {
    const node = systemNodeVersion();
    if (!node || !versionAtLeast(node, cli.node)) {
      throw new Error(
        `Для ${cli.command} нужен Node.js ${cli.node} или новее${node ? `, сейчас ${node}` : ''}. Обновите Node.js и повторите.`,
      );
    }
  }
  if (commandExists(cli.command)) {
    requireCommand(cli.command, help, cli.min);
    return;
  }
  if (dryRun) return;
  const r = await installNpmGlobal(cli.command, cli.pkg, process.env, cli.extraArgs);
  if (!r.ok) throw new Error(r.error);
  requireCommand(cli.command, 'Установка прошла, но команда не запускается.', cli.min);
}
