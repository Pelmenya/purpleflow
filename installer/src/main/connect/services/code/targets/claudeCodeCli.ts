import { ensureAssistantCli } from '../../../core/applications.js';
import { commandExists, platform } from '../../../core/os.js';
import {
  upsertShellEnvVars,
  setWindowsUserEnvVars,
  readShellEnvVar,
  readWindowsUserEnvVar,
  removeShellEnvVars,
  removeWindowsUserEnvVars,
} from '../../../core/shellRc.js';
import { prepareClaudeCore, applyClaudeCore, removeClaudeCore } from '../../../core/claudeCore.js';
import { ANTHROPIC_BASE_URL } from '../../../constants.js';
import type { SetupContext, Target } from '../../../core/types.js';

function readCliEnv(key: string): string | undefined {
  return platform() === 'win32' ? readWindowsUserEnvVar(key) : readShellEnvVar(key);
}

async function hasRemainingConsumer(targets: readonly Target[], ctx: SetupContext): Promise<boolean> {
  for (const target of targets) {
    if (ctx.dryRun && ctx.removedTargetIds?.includes(target.id)) continue;
    try {
      if (await target.isConfigured?.()) return true;
    } catch {
      return true;
    } // An unreadable configuration is not evidence that its key is unused.
  }
  return false;
}

export function buildClaudeCodeCli(consumers: { key: readonly Target[]; core: readonly Target[] }): Target {
  return {
    id: 'claude-code-cli',
    title: 'Claude Code (CLI)',
    hint: 'терминал, npm-пакет @anthropic-ai/claude-code',
    detect: () => commandExists('claude'),
    ensureAvailable: (dryRun) => ensureAssistantCli('claude', dryRun),
    async preflight(ctx) {
      await prepareClaudeCore(ctx);
    },
    async apply(ctx) {
      const notes: string[] = [];

      const envVars = { ANTHROPIC_API_KEY: ctx.apiKey, ANTHROPIC_BASE_URL: ctx.baseUrl };
      if (ctx.platform === 'win32') {
        setWindowsUserEnvVars(envVars);
        notes.push('Переменные окружения сохранены через `setx` — подхватятся в новых окнах терминала.');
      } else {
        const { file } = upsertShellEnvVars(envVars);
        notes.push(`Переменные окружения добавлены в ${file}.`);
      }

      notes.push(...applyClaudeCore(ctx));
      notes.push('Выполни `claude` в папке проекта — сработает сразу, без перезапуска терминала и без /login.');

      return { notes };
    },
    isConfigured: () => Boolean(readCliEnv('ANTHROPIC_API_KEY')) && readCliEnv('ANTHROPIC_BASE_URL') === ANTHROPIC_BASE_URL,
    async remove(ctx) {
      const notes: string[] = [];
      const preserveKey = await hasRemainingConsumer(consumers.key, ctx);
      const keys =
        readCliEnv('ANTHROPIC_BASE_URL') === ctx.baseUrl ? ['ANTHROPIC_BASE_URL', ...(preserveKey ? [] : ['ANTHROPIC_API_KEY'])] : [];

      if (ctx.platform === 'win32') {
        removeWindowsUserEnvVars(keys);
        notes.push(
          keys.length
            ? `Удалены переменные Windows: ${keys.join(', ')}.`
            : 'Переменные Claude CLI с нашим адресом прокси не найдены — окружение сохранено.',
        );
      } else {
        const { file, removed } = removeShellEnvVars(keys);
        notes.push(
          removed ? `Из общего блока в ${file} убраны: ${keys.join(', ')}.` : `В ${file} не нашлось наших переменных — нечего убирать.`,
        );
      }

      if (preserveKey) notes.push('Общий ANTHROPIC_API_KEY сохранён: его использует другой клиент или его настройки не удалось проверить.');
      const preserveCore = await hasRemainingConsumer(consumers.core, ctx);
      notes.push(
        ...(preserveCore
          ? ['Общие настройки Claude Code сохранены: они нужны расширению в другом редакторе или его настройки не удалось проверить.']
          : removeClaudeCore()),
      );
      notes.push('Пакет @anthropic-ai/claude-code не удалялся — `npm uninstall -g @anthropic-ai/claude-code`, если нужно.');

      return { notes };
    },
  };
}
