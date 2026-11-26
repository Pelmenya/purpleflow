import { note } from '../../../core/notes.js';
import path from 'node:path';
import { commandExists, homeDir } from '../../../core/os.js';
import { ensureAssistantCli } from '../../../core/applications.js';
import { removeShellEnvVars, removeWindowsUserEnvVars } from '../../../core/shellRc.js';
import { readToml, writeTomlField, removeTomlField } from '../../../core/toml.js';
import type { SetupContext, Target } from '../../../core/types.js';

export function codexConfigPath(): string {
  return path.join(process.env.CODEX_HOME ?? path.join(homeDir(), '.codex'), 'config.toml');
}

interface CodexConfig {
  model?: string;
  model_provider?: string;
  profile?: string;
  profiles?: Record<string, Record<string, unknown>>;
  forced_login_method?: string;
  model_providers?: Record<string, unknown>;
}

export async function prepareCodexCore(): Promise<void> {
  const config = readToml<CodexConfig>(codexConfigPath());
  if (config?.forced_login_method === 'chatgpt')
    note('В Codex был принудительно выбран вход через ChatGPT — ограничение снято, иначе ключ PurpleSchool не работает.');
  if (config?.profile) {
    note(
      `Активен профиль Codex «${config.profile}». Модель и провайдер будут заданы и в этом профиле, чтобы он не перекрывал настройки PurpleSchool.`,
    );
  }
}

export function applyCodexCore(ctx: SetupContext): string[] {
  const configPath = codexConfigPath();
  const config = readToml<CodexConfig>(configPath);

  // Ключ пишем в сам config.toml, а не в переменную окружения. С env_key Codex требует
  // OPENAI_API_KEY в окружении процесса, а его нет в терминале, открытом до настройки, и в
  // редакторе, запущенном из Dock/меню «Пуск» (неделя 02–15.11.2026: `7797dcd3`, `b75e5dda`,
  // `b2f1f9cc` — «Missing environment variable: OPENAI_API_KEY»). experimental_bearer_token
  // проверен на Codex 0.167.2: ключ уходит в Authorization без переменной. env_key рядом
  // оставлять нельзя — с ним Codex снова требует переменную, поэтому таблица провайдера
  // перезаписывается целиком.
  writeTomlField(configPath, ['model_providers', 'purpleschool'], {
    name: 'PurpleSchool OpenAI Proxy',
    base_url: `${ctx.baseUrl}/v1`,
    experimental_bearer_token: ctx.apiKey,
    wire_api: 'responses',
    supports_websockets: false,
  });
  writeTomlField(configPath, ['model_provider'], 'purpleschool');
  if (ctx.model) writeTomlField(configPath, ['model'], ctx.model);
  if (config?.profile) {
    writeTomlField(configPath, ['profiles', config.profile, 'model_provider'], 'purpleschool');
    if (ctx.model) writeTomlField(configPath, ['profiles', config.profile, 'model'], ctx.model);
  }
  if (config?.forced_login_method === 'chatgpt') removeTomlField(configPath, ['forced_login_method']);
  return [
    `Провайдер PurpleSchool и модель ${ctx.model ?? 'из существующих настроек'} записаны в ${configPath}.`,
    'Конфигурация общая для Codex CLI и расширений Codex во всех редакторах. Комментарии TOML не сохраняются; оригинал есть в резервной копии.',
    'Ключ записан в этот же файл, переменная OPENAI_API_KEY не нужна: Codex заработает и в текущем терминале, и в редакторе, открытом из Dock или меню «Пуск».',
  ];
}

// Клиенты, которым нужна переменная OPENAI_API_KEY. Задаётся в index.ts, чтобы не было циклического импорта.
let keyConsumers: readonly Target[] = [];
export function setOpenaiKeyConsumers(targets: readonly Target[]): void {
  keyConsumers = targets;
}

async function keyStillUsed(ctx: SetupContext): Promise<boolean> {
  for (const target of keyConsumers) {
    if (ctx.removedTargetIds?.includes(target.id)) continue;
    try {
      if (await target.isConfigured?.()) return true;
    } catch {
      return true;
    } // Нечитаемая настройка не доказывает, что ключ не нужен.
  }
  return false;
}

export const openaiCodexCli: Target = {
  id: 'openai-codex-cli',
  title: 'Codex CLI (терминал)',
  hint: 'будет установлен автоматически, если отсутствует',
  detect: () => commandExists('codex'),
  ensureAvailable: (dryRun) => ensureAssistantCli('codex', dryRun),
  preflight: prepareCodexCore,
  async apply(ctx) {
    return { notes: [...applyCodexCore(ctx), 'Выполни codex в папке проекта.'] };
  },
  isConfigured: () => Boolean(readToml<CodexConfig>(codexConfigPath())?.model_providers?.purpleschool),
  async remove(ctx) {
    const configPath = codexConfigPath();
    const config = readToml<CodexConfig>(configPath);
    // До 0.8.1 ключ Codex лежал в OPENAI_API_KEY — убираем и его, если переменной не пользуются
    // OpenAI-варианты OpenCode, Qwen Code, Pi или Neovim.
    if (!(await keyStillUsed(ctx))) {
      if (ctx.platform === 'win32') removeWindowsUserEnvVars(['OPENAI_API_KEY']);
      else removeShellEnvVars(['OPENAI_API_KEY']);
    }
    removeTomlField(configPath, ['model_providers', 'purpleschool']);
    if (config?.model_provider === 'purpleschool') {
      removeTomlField(configPath, ['model_provider']);
      removeTomlField(configPath, ['model']);
    }
    for (const [name, profile] of Object.entries(config?.profiles ?? {})) {
      if (profile.model_provider !== 'purpleschool') continue;
      removeTomlField(configPath, ['profiles', name, 'model_provider']);
      removeTomlField(configPath, ['profiles', name, 'model']);
    }
    return { notes: ['Общие настройки PurpleSchool удалены из Codex CLI и расширений. Сам CLI и расширения не удалялись.'] };
  },
};
