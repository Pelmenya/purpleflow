import fs from 'node:fs';
import path from 'node:path';
import { commandExists, crushrcPath, homeDir, openCodeConfigPath, piModelsPath, neovimConfigDir } from '../../core/os.js';
import { ANTHROPIC_BASE_URL } from '../../constants.js';
import { ensureNpmCli, requireCommand } from '../../core/applications.js';
import { readJsonc, writeJsoncField, removeJsoncField } from '../../core/jsonc.js';
import { backupFile } from '../../core/backup.js';
import { upsertShellEnvVars, setWindowsUserEnvVars } from '../../core/shellRc.js';
import type { SetupContext, Target } from '../../core/types.js';

export type Family = 'anthropic' | 'openai';

function keyName(family: Family): string {
  return family === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
}

function saveKey(ctx: SetupContext, family: Family): void {
  const vars = { [keyName(family)]: ctx.apiKey };
  if (ctx.platform === 'win32') setWindowsUserEnvVars(vars);
  else upsertShellEnvVars(vars);
}

function selectedModel(ctx: SetupContext): string {
  if (!ctx.model) throw new Error('Модель не выбрана. Запусти мастер снова.');
  return ctx.model;
}

/**
 * Окно контекста и предел ответа модели Claude. Клиенты со своим провайдером (OpenCode, Crush) не знают модели
 * прокси и без этих чисел берут 200K — и сжимают переписку задолго до настоящего предела. У всех Claude из
 * каталога прокси окно 1M и ответ до 128K, кроме Haiku 4.5: 200K и 64K. Не Claude — undefined: решает клиент.
 */
export function claudeLimit(id: string): { context: number; output: number } | undefined {
  if (!/^claude-/.test(id)) return undefined;
  // До 4.6 (claude-3-*, *-4-0…4-5, claude-sonnet-4-20250514) и Haiku 4.5 — 200K.
  if (/^claude-(3|[a-z]+-4-[0-5](-|$)|[a-z]+-4-\d{8})/.test(id)) return { context: 200_000, output: 64_000 };
  return { context: 1_000_000, output: 128_000 };
}

function providerId(family: Family): string {
  return `purpleschool-${family}`;
}

function commandCheck(command: string, help: string, minimum?: string): () => Promise<void> {
  return async () => {
    requireCommand(command, help, minimum);
  };
}

export function buildOpenCode(family: Family): Target {
  const provider = providerId(family);
  return {
    id: family === 'anthropic' ? 'opencode' : 'openai-opencode',
    title: 'OpenCode',
    hint: 'поставим, если его нет',
    detect: () => commandExists('opencode'),
    ensureAvailable: (dryRun) => ensureNpmCli({ command: 'opencode', pkg: 'opencode-ai' }, dryRun),
    async apply(ctx) {
      const model = selectedModel(ctx);
      const configPath = openCodeConfigPath();
      readJsonc(configPath);
      saveKey(ctx, family);
      if (!fs.existsSync(configPath)) writeJsoncField(configPath, ['$schema'], 'https://opencode.ai/config.json');
      writeJsoncField(configPath, ['provider', provider, 'npm'], family === 'anthropic' ? '@ai-sdk/anthropic' : '@ai-sdk/openai');
      writeJsoncField(configPath, ['provider', provider, 'name'], `PurpleSchool ${family === 'anthropic' ? 'Anthropic' : 'OpenAI'}`);
      writeJsoncField(configPath, ['provider', provider, 'options', 'baseURL'], `${ctx.baseUrl}/v1`);
      // Сам ключ, а не {env:…}: у OpenCode есть приложение с окном, и запущенное из Dock или меню «Пуск» оно не видит
      // переменных из ~/.zshrc — получало «Unauthorized». Так же Codex хранит ключ в своём config.toml.
      writeJsoncField(configPath, ['provider', provider, 'options', 'apiKey'], ctx.apiKey);
      const models = ctx.proxyModels ?? { [model]: model };
      writeJsoncField(
        configPath,
        ['provider', provider, 'models'],
        Object.fromEntries(
          Object.entries(models).map(([id, name]) => {
            const limit = claudeLimit(id);
            return [id, limit ? { name, limit } : { name }];
          }),
        ),
      );
      writeJsoncField(configPath, ['model'], `${provider}/${model}`);
      return {
        notes: [
          `Настроен ${configPath}. Открой новый терминал и запусти opencode. Выбрана модель ${provider}/${model}.`,
          'Конфиг проекта или сохранённая сессия могут перекрыть выбор: проверь модель через /models.',
        ],
      };
    },
    isConfigured: () => Boolean(readJsonc<{ provider?: Record<string, unknown> }>(openCodeConfigPath())?.provider?.[provider]),
    async remove() {
      const file = openCodeConfigPath();
      const config = readJsonc<{ model?: string }>(file);
      removeJsoncField(file, ['provider', provider]);
      if (config?.model?.startsWith(`${provider}/`)) removeJsoncField(file, ['model']);
      return { notes: ['Провайдер OpenCode удалён. Общая переменная ключа сохранена: её могут использовать другие клиенты.'] };
    },
  };
}

export function buildPi(family: Family): Target {
  const provider = family === 'anthropic' ? 'purpleschool-anthropic' : 'purpleschool';
  const settings = () => path.join(homeDir(), '.pi', 'agent', 'settings.json');
  return {
    id: family === 'anthropic' ? 'pi-cli' : 'openai-pi-cli',
    title: 'Pi',
    hint: 'поставим, если его нет',
    detect: () => commandExists('pi'),
    // На Windows Pi работает через Git Bash — он приходит вместе с обязательным Git.
    ensureAvailable: (dryRun) =>
      ensureNpmCli(
        { command: 'pi', pkg: '@earendil-works/pi-coding-agent', min: '1.5.0', node: '22.19.0', extraArgs: ['--ignore-scripts'] },
        dryRun,
      ),
    async apply(ctx) {
      const model = selectedModel(ctx);
      readJsonc(piModelsPath());
      readJsonc(settings());
      saveKey(ctx, family);
      writeJsoncField(piModelsPath(), ['providers', provider], {
        baseUrl: family === 'anthropic' ? ctx.baseUrl : `${ctx.baseUrl}/v1`,
        api: family === 'anthropic' ? 'anthropic-messages' : 'openai-responses',
        apiKey: `$${keyName(family)}`,
        models: Object.entries(ctx.proxyModels ?? { [model]: model }).map(([id, name]) => ({ id, name })),
      });
      writeJsoncField(settings(), ['defaultProvider'], provider);
      writeJsoncField(settings(), ['defaultModel'], model);
      if (family === 'anthropic') removeLegacyPiConnection();
      return {
        notes: [
          `Настроен ${piModelsPath()}. Модель новых сессий: ${provider}/${model}. Открой новый терминал и запусти pi; в существующей сессии выбери модель через /model.`,
        ],
      };
    },
    isConfigured: () =>
      Boolean(readJsonc<{ providers?: Record<string, unknown> }>(piModelsPath())?.providers?.[provider]) ||
      (family === 'anthropic' && hasLegacyPiConnection()),
    async remove() {
      removeJsoncField(piModelsPath(), ['providers', provider]);
      if (readJsonc<{ defaultProvider?: string }>(settings())?.defaultProvider === provider) {
        removeJsoncField(settings(), ['defaultProvider']);
        removeJsoncField(settings(), ['defaultModel']);
      }
      if (family === 'anthropic') removeLegacyPiConnection();
      return { notes: ['Провайдер Pi удалён. Общая переменная ключа сохранена для остальных клиентов.'] };
    },
  };
}

/** Recognize only the old pair written by this wizard; never remove another gateway. */
function hasLegacyPiConnection(): boolean {
  const legacy = readJsonc<{ providers?: { anthropic?: { baseUrl?: string; apiKey?: string } } }>(piModelsPath())?.providers?.anthropic;
  const baseUrl = legacy?.baseUrl?.replace(/\/$/, '');
  return (baseUrl === ANTHROPIC_BASE_URL || baseUrl === `${ANTHROPIC_BASE_URL}/v1`) && legacy?.apiKey === '$ANTHROPIC_API_KEY';
}

function removeLegacyPiConnection(): void {
  if (!hasLegacyPiConnection()) return;
  removeJsoncField(piModelsPath(), ['providers', 'anthropic', 'baseUrl']);
  removeJsoncField(piModelsPath(), ['providers', 'anthropic', 'apiKey']);
}

export function buildQwen(family: Family): Target {
  const settings = () => path.join(homeDir(), '.qwen', 'settings.json');
  return {
    id: `${family}-qwen-code`,
    title: 'Qwen Code',
    hint: 'поставим, если его нет',
    detect: () => commandExists('qwen'),
    ensureAvailable: (dryRun) => ensureNpmCli({ command: 'qwen', pkg: '@qwen-code/qwen-code', min: '0.24.6', node: '22.0.0' }, dryRun),
    async apply(ctx) {
      const model = selectedModel(ctx);
      const file = settings();
      const config = readJsonc<{ modelProviders?: Record<string, { id: string; baseUrl?: string }[]> }>(file);
      const baseUrl = family === 'openai' ? `${ctx.baseUrl}/v1` : ctx.baseUrl;
      const existing = config?.modelProviders?.[family] ?? [];
      if (!Array.isArray(existing)) throw new Error(`Некорректный modelProviders.${family} в ${file}. Исправь его вручную.`);
      const retained = existing.filter((entry) => entry.baseUrl !== baseUrl);
      const models = Object.entries(ctx.proxyModels ?? { [model]: model }).map(([id, name]) => ({
        id,
        name,
        envKey: keyName(family),
        baseUrl,
        ...(family === 'openai'
          ? { wireApi: 'responses' }
          : { generationConfig: { customHeaders: { 'x-api-key': `$${keyName(family)}` } } }),
      }));
      saveKey(ctx, family);
      writeJsoncField(file, ['modelProviders', family], [...models, ...retained]);
      writeJsoncField(file, ['security', 'auth', 'selectedType'], family);
      writeJsoncField(file, ['model', 'name'], model);
      writeJsoncField(file, ['model', 'baseUrl'], baseUrl);
      return {
        notes: [`Настроен ${file}. Открой новый терминал и запусти qwen. Выбрана модель ${model}; проверить выбор можно через /model.`],
      };
    },
    isConfigured: () => {
      const entries = readJsonc<{ modelProviders?: Record<string, { baseUrl?: string }[]> }>(settings())?.modelProviders?.[family];
      return Array.isArray(entries) && entries.some((entry) => entry.baseUrl?.includes(`/ai-proxy/${family}`));
    },
    async remove(ctx) {
      const file = settings();
      const config = readJsonc<{
        modelProviders?: Record<string, { id: string; baseUrl?: string }[]>;
        model?: { name?: string; baseUrl?: string };
        security?: { auth?: { selectedType?: string } };
      }>(file);
      const entries = config?.modelProviders?.[family];
      if (!Array.isArray(entries)) return { notes: ['Настройки Qwen Code не найдены.'] };
      const baseUrl = family === 'openai' ? `${ctx.baseUrl}/v1` : ctx.baseUrl;
      const removed = entries.filter((entry) => entry.baseUrl === baseUrl);
      const retained = entries.filter((entry) => entry.baseUrl !== baseUrl);
      writeJsoncField(file, ['modelProviders', family], retained);
      const selectedOurEndpoint =
        config?.model?.baseUrl === baseUrl ||
        (config?.model?.baseUrl === undefined && !retained.some((entry) => entry.id === config?.model?.name));
      if (
        config?.security?.auth?.selectedType === family &&
        selectedOurEndpoint &&
        removed.some((entry) => entry.id === config.model?.name)
      ) {
        removeJsoncField(file, ['model', 'name']);
        removeJsoncField(file, ['model', 'baseUrl']);
        removeJsoncField(file, ['security', 'auth', 'selectedType']);
      }
      return { notes: ['Модели PurpleSchool удалены из Qwen Code. Остальные модели и общий ключ сохранены.'] };
    },
  };
}

export function renderAvante(ctx: SetupContext, family: Family): string {
  const provider = family === 'anthropic' ? 'claude' : 'openai';
  const endpoint = family === 'anthropic' ? ctx.baseUrl : `${ctx.baseUrl}/v1`;
  // JSON strings are valid Lua quoted strings for URLs and our model ids.
  return `return {\n  "yetone/avante.nvim",\n  event = "VeryLazy",\n  version = false,\n  build = vim.fn.has("win32") ~= 0 and "powershell -ExecutionPolicy Bypass -File Build.ps1 -BuildFromSource false" or "make",\n  opts = {\n    provider = "${provider}",\n    providers = {\n      ${provider} = {\n        endpoint = ${JSON.stringify(endpoint)},\n        model = ${JSON.stringify(selectedModel(ctx))},\n        api_key_name = "${keyName(family)}",\n${family === 'openai' ? '        use_response_api = true,\n' : '        auth_type = "api",\n'}      },\n    },\n  },\n}\n`;
}

export function buildNeovim(family: Family): Target {
  const file = () => path.join(neovimConfigDir(), 'lua', 'plugins', 'purpleschool-avante.lua');
  return {
    id: family === 'anthropic' ? 'neovim-avante' : 'openai-neovim-avante',
    title: 'Neovim (avante.nvim)',
    hint: 'конфигурация lazy.nvim; для другого менеджера нужны ручные шаги',
    detect: () => commandExists('nvim'),
    ensureAvailable: commandCheck('nvim', 'Установи Neovim 0.11+ и настрой lazy.nvim: https://neovim.io/ .', '0.11.0'),
    async apply(ctx) {
      const snippet = renderAvante(ctx, family);
      const configDir = neovimConfigDir();
      const configExists = fs.existsSync(configDir);
      saveKey(ctx, family);
      if (configExists && !ctx.dryRun) {
        backupFile(file());
        fs.mkdirSync(path.dirname(file()), { recursive: true });
        fs.writeFileSync(file(), snippet, 'utf8');
      }
      const notes = configExists
        ? [`Подготовлен ${file()}. Он заменяет предыдущий выбор провайдера Avante от этого мастера.`]
        : ['Конфигурация Neovim не найдена. Добавь этот блок в настройку lazy.nvim:', snippet];
      notes.push(
        'Для lazy.nvim с импортом lua/plugins выполни :Lazy sync. Для другого менеджера перенеси блок вручную. Открой новый терминал перед запуском nvim. Наличие и загрузка avante.nvim автоматически не проверялись.',
      );
      return { notes };
    },
    isConfigured: () =>
      fs.existsSync(file()) && fs.readFileSync(file(), 'utf8').includes(`provider = "${family === 'anthropic' ? 'claude' : 'openai'}"`),
    async remove(ctx) {
      if (
        fs.existsSync(file()) &&
        fs.readFileSync(file(), 'utf8').includes(`provider = "${family === 'anthropic' ? 'claude' : 'openai'}"`) &&
        !ctx.dryRun
      ) {
        backupFile(file());
        fs.rmSync(file());
      }
      return { notes: ['Конфигурация Avante этого семейства удалена, если была создана мастером. Общий ключ сохранён.'] };
    },
  };
}

/** Строка для bash в одинарных кавычках: crushrc — это bash, и имя модели из ответа прокси не должно его сломать. */
const sq = (v: string) => `'${v.split("'").join(`'\\''`)}'`;

const crushMarkers = (family: Family) => [`# >>> purpleschool ${family} >>>`, `# <<< purpleschool ${family} <<<`] as const;

/** Наш блок в crushrc вместе с переводом строки перед ним и после. */
function findCrushBlock(text: string, family: Family): { from: number; to: number } | null {
  const [start, end] = crushMarkers(family);
  const a = text.indexOf(start);
  if (a < 0) return null;
  const b = text.indexOf(end, a);
  if (b < 0) return null;
  let to = b + end.length;
  if (text[to] === '\n') to += 1;
  return { from: a, to };
}

/**
 * Crush (charmbracelet): конфиг — crushrc в синтаксисе bash с командами provider add / model add. Пишем свой
 * размеченный блок на семейство и не трогаем остальное, как с shell-файлами. Тип провайдера — по README Crush:
 * messages для Anthropic-совместимого API, responses — для прокси OpenAI. Ключ — из переменной окружения.
 */
export function buildCrush(family: Family): Target {
  const provider = providerId(family);
  const read = () => (fs.existsSync(crushrcPath()) ? fs.readFileSync(crushrcPath(), 'utf8') : '');
  return {
    id: family === 'anthropic' ? 'crush' : 'openai-crush',
    title: 'Crush',
    hint: 'поставим, если его нет',
    detect: () => commandExists('crush'),
    ensureAvailable: (dryRun) => ensureNpmCli({ command: 'crush', pkg: '@charmland/crush' }, dryRun),
    async apply(ctx) {
      const model = selectedModel(ctx);
      const file = crushrcPath();
      const [start, end] = crushMarkers(family);
      const models = Object.entries(ctx.proxyModels ?? { [model]: model });
      const block = [
        start,
        `provider add ${provider} --type ${family === 'anthropic' ? 'messages' : 'responses'} --base-url ${sq(`${ctx.baseUrl}/v1`)} --api-key "$${keyName(family)}"`,
        ...models.map(
          ([id, name]) =>
            `model add ${sq(`${provider}/${id}`)} --name ${sq(name)} --context-window ${claudeLimit(id)?.context ?? (family === 'anthropic' ? 200000 : 128000)} --default-max-tokens ${family === 'anthropic' ? 32000 : 16000}`,
        ),
        end,
        '',
      ].join('\n');
      saveKey(ctx, family);
      if (!ctx.dryRun) {
        const original = read();
        const found = findCrushBlock(original, family);
        const next = found
          ? original.slice(0, found.from) + block + original.slice(found.to)
          : `${original}${original && !original.endsWith('\n') ? '\n' : ''}${original ? '\n' : ''}${block}`;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        if (original) backupFile(file);
        fs.writeFileSync(file, next, 'utf8');
      }
      return { notes: [`Настроен ${file}: провайдер ${provider} и модели PurpleSchool. Выберите модель в Crush через Ctrl+P → Models.`] };
    },
    isConfigured: () => findCrushBlock(read(), family) !== null,
    async remove(ctx) {
      const file = crushrcPath();
      const original = read();
      const found = findCrushBlock(original, family);
      if (!found) return { notes: ['Настроек Crush от установщика не нашлось.'] };
      if (!ctx.dryRun) {
        backupFile(file);
        const next = (original.slice(0, found.from) + original.slice(found.to)).replace(/\n{3,}/g, '\n\n');
        fs.writeFileSync(file, next, 'utf8');
      }
      return { notes: ['Провайдер PurpleSchool убран из Crush. Общая переменная ключа сохранена для остальных клиентов.'] };
    },
  };
}
