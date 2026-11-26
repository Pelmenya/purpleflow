// Настройка без вопросов: какие приложения есть, что уже подключено, подключить и отключить выбранное.
// Работает в отдельном процессе (см. worker.ts): у модулей мастера есть состояние на один запуск, а проверки
// редакторов синхронные и не должны тормозить окно.
import { ANTHROPIC_BASE_URL } from './constants.js';
import { platform } from './core/os.js';
import { readJsonc } from './core/jsonc.js';
import { readToml } from './core/toml.js';
import { setNoteSink } from './core/notes.js';
import { claudeSettingsPath } from './core/claudeSettingsDoctor.js';
import { defaultClaudeModel, proxyClaudeModels, suggestedModel, type ModelCatalog } from './core/models.js';
import { checkPurpleSchoolToken, probeAnthropicMessage, probeOpenaiResponse, type ProbeResult } from './core/validateToken.js';
import { services } from './services/registry.js';
import { codexConfigPath } from './services/openaiCodex/targets/openaiCodexCli.js';
import { codexEditors } from './services/openaiCodex/targets/codexEditors.js';
import type { Service, SetupContext, Target } from './core/types.js';
import type { ClientInfo, ClientResult, ConnectProgress } from '../../shared/connect';

/** CLI ставит сам установщик, поэтому их строки есть всегда; остальное показываем, только если приложение найдено. */
const ALWAYS = [
  'claude-code-cli',
  'openai-codex-cli',
  // Агенты в терминале ставятся из npm при включении, поэтому их строки тоже есть всегда.
  'opencode',
  'openai-opencode',
  'pi-cli',
  'openai-pi-cli',
  'anthropic-qwen-code',
  'openai-qwen-code',
  'crush',
  'openai-crush',
];

const TITLES: Record<string, string> = {
  'claude-code-cli': 'Claude Code',
  vscode: 'Claude Code в VS Code',
  cursor: 'Claude Code в Cursor',
  windsurf: 'Claude Code в Windsurf',
  'openai-codex-cli': 'Codex',
};

/** Предпочтения по умолчанию — те же, что «Оптимальный» пресет PurpleFlow. */
const OPENAI_DEFAULT = 'gpt-6.1-terra';
const MODEL_ATTEMPTS = 6;

const familyOf = (s: Service): 'claude' | 'codex' => ((s.authScheme ?? 'anthropic') === 'anthropic' ? 'claude' : 'codex');

function visibleTargets(): { service: Service; target: Target }[] {
  return services.flatMap((service) => service.targets.filter((t) => !t.id.startsWith('codex-')).map((target) => ({ service, target })));
}

export async function scan(): Promise<ClientInfo[]> {
  const list: ClientInfo[] = [];
  for (const { service, target } of visibleTargets()) {
    let installed: boolean;
    let configured: boolean;
    try {
      installed = Boolean(await target.detect());
    } catch {
      installed = false;
    }
    const available = installed || ALWAYS.includes(target.id);
    try {
      configured = Boolean(await (target.isConfigured ?? target.detect)());
    } catch {
      configured = false;
    }
    if (!available && !configured) continue;
    const family = familyOf(service);
    // OpenCode, Pi, Qwen и Neovim есть в обоих семействах — в одном списке их различает модель.
    list.push({
      id: target.id,
      family,
      installed,
      title: TITLES[target.id] ?? `${target.title} · ${family === 'claude' ? 'Claude' : 'GPT'}`,
      configured,
    });
  }
  return list;
}

/** Ключ из уже сделанной настройки: можно подключить ещё приложение без входа в аккаунт. */
export function existingKey(): string | undefined {
  try {
    const env = readJsonc<{ env?: Record<string, string> }>(claudeSettingsPath())?.env;
    if (env?.ANTHROPIC_BASE_URL === ANTHROPIC_BASE_URL && env.ANTHROPIC_API_KEY) return env.ANTHROPIC_API_KEY;
  } catch {
    /* нечитаемый файл — ключа нет */
  }
  try {
    const provider = readToml<{ model_providers?: Record<string, { experimental_bearer_token?: string }> }>(codexConfigPath())
      ?.model_providers?.purpleschool;
    if (provider?.experimental_bearer_token) return provider.experimental_bearer_token;
  } catch {
    /* то же */
  }
  return undefined;
}

function preferredModel(service: Service, catalog: ModelCatalog): string {
  if ((service.authScheme ?? 'anthropic') === 'anthropic') return defaultClaudeModel(catalog);
  const ids = Object.keys(catalog);
  return ids.includes(OPENAI_DEFAULT)
    ? OPENAI_DEFAULT
    : (ids.find((id) => id.includes('terra')) ?? ids.find((id) => id.startsWith('gpt')) ?? ids[0]!);
}

export class KeyRejected extends Error {}

/**
 * Модель без выбора: по умолчанию — средняя, и сразу проверочный запрос. На пробном балансе прокси отвечает 400
 * и называет доступную модель — берём её. Прочие ошибки (402, сеть) запись не останавливают: о них скажет заметка.
 */
async function pickModel(service: Service, apiKey: string): Promise<{ model: string; catalog: ModelCatalog; check: ProbeResult }> {
  const scheme = service.authScheme ?? 'anthropic';
  const token = await checkPurpleSchoolToken(service.baseUrl, apiKey, scheme);
  if (token.status === 'invalid') throw new KeyRejected('PurpleSchool не принял ключ. Войдите в аккаунт снова.');
  if (token.status !== 'valid' || !token.models)
    throw new Error('Не удалось получить список моделей PurpleSchool. Проверьте интернет и повторите.');
  const catalog = scheme === 'anthropic' ? proxyClaudeModels(token.models)! : token.models;
  if (Object.keys(catalog).length === 0) throw new Error('Для этого семейства нет доступных моделей.');

  const remaining = { ...catalog };
  const rejected: string[] = [];
  let model = preferredModel(service, remaining);
  for (let i = 0; i < MODEL_ATTEMPTS; i++) {
    const check =
      scheme === 'anthropic'
        ? await probeAnthropicMessage(service.baseUrl, apiKey, model)
        : await probeOpenaiResponse(service.baseUrl, apiKey, model);
    if (check.ok || check.status !== 400) return { model, catalog: model in catalog ? catalog : { ...catalog, [model]: model }, check };
    delete remaining[model];
    rejected.push(model);
    const next =
      suggestedModel(check.detail, Object.keys(remaining), rejected) ??
      (Object.keys(remaining).length ? preferredModel(service, remaining) : undefined);
    if (!next) break;
    model = next;
  }
  throw new Error('Прокси не принял ни одну модель — проверьте баланс в личном кабинете PurpleSchool. Настройки не записаны.');
}

function checkNote(check: ProbeResult, apiKey: string): string | undefined {
  if (check.ok) return undefined;
  const detail = check.detail ? `: ${check.detail.replaceAll(apiKey, '[ключ скрыт]').slice(0, 300)}` : '';
  if (check.status === 402) return `Похоже, закончился баланс${detail}. Пополните его в личном кабинете PurpleSchool.`;
  return `Проверочный запрос к модели не прошёл${check.status ? ` (HTTP ${check.status})` : ''}${detail}.`;
}

async function withNotes(fn: () => Promise<{ notes?: string[] } | void>): Promise<string[]> {
  const notes: string[] = [];
  setNoteSink((t) => notes.push(t));
  try {
    const r = await fn();
    return [...notes, ...(r?.notes ?? [])];
  } finally {
    setNoteSink(() => {});
  }
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function applyChanges(
  apiKey: string | undefined,
  enable: string[],
  disable: string[],
  progress: (p: ConnectProgress) => void,
): Promise<ClientResult[]> {
  const results: ClientResult[] = [];
  const done = (r: ClientResult) => {
    results.push(r);
    progress({ id: r.id, status: r.ok ? 'done' : 'failed' });
  };

  for (const service of services) {
    const on = service.targets.filter((t) => enable.includes(t.id));
    // Общие файлы Claude Code чистятся последними: их могут ещё использовать другие отключаемые клиенты.
    const off = [
      ...service.targets.filter((t) => disable.includes(t.id) && t.id !== 'claude-code-cli'),
      ...service.targets.filter((t) => disable.includes(t.id) && t.id === 'claude-code-cli'),
    ];

    if (on.length > 0) {
      for (const t of on) progress({ id: t.id, status: 'running', stage: 'queued' });
      // Сначала приложения на месте (при необходимости ставим claude и codex), и только потом ключ и платный
      // проверочный запрос к модели — как в прежнем мастере.
      const ready: Target[] = [];
      const early = new Map<string, string[]>();
      for (const t of on) {
        progress({ id: t.id, status: 'running', stage: 'check' });
        try {
          early.set(t.id, await withNotes(async () => t.ensureAvailable?.(false)));
          ready.push(t);
        } catch (e) {
          done({ id: t.id, ok: false, error: message(e) });
        }
      }
      if (ready.length > 0) {
        let picked: Awaited<ReturnType<typeof pickModel>> | undefined;
        try {
          if (!apiKey) throw new KeyRejected('Войдите в аккаунт PurpleSchool.');
          for (const t of ready) progress({ id: t.id, status: 'running', stage: 'model' });
          picked = await pickModel(service, apiKey);
        } catch (e) {
          for (const t of ready) done({ id: t.id, ok: false, error: message(e), needLogin: e instanceof KeyRejected });
        }
        if (picked) {
          const ctx: SetupContext = {
            apiKey: apiKey!,
            baseUrl: service.baseUrl,
            platform: platform(),
            dryRun: false,
            proxyModels: picked.catalog,
            model: picked.model,
          };
          const warning = checkNote(picked.check, ctx.apiKey);
          for (const t of ready) {
            progress({ id: t.id, status: 'running', stage: 'write' });
            try {
              const notes = await withNotes(async () => {
                await t.preflight?.(ctx);
                return t.apply(ctx);
              });
              if (t.id === 'openai-codex-cli') notes.push(...(await connectCodexEditors(ctx)));
              done({
                id: t.id,
                ok: true,
                model: picked.catalog[picked.model] ?? picked.model,
                notes: [...(warning ? [warning] : []), ...(early.get(t.id) ?? []), ...notes],
              });
            } catch (e) {
              done({ id: t.id, ok: false, error: message(e) });
            }
          }
        }
      }
    }

    const ctx: SetupContext = { apiKey: '', baseUrl: service.baseUrl, platform: platform(), dryRun: false };
    for (const t of off) {
      progress({ id: t.id, status: 'running', stage: 'remove' });
      try {
        const notes = await withNotes(async () => (t.remove ? t.remove(ctx) : undefined));
        (ctx.removedTargetIds ??= []).push(t.id);
        done({ id: t.id, ok: true, notes });
      } catch (e) {
        done({ id: t.id, ok: false, error: message(e) });
      }
    }
  }
  return results;
}

/**
 * Конфиг Codex общий для CLI и расширений, но у расширения бывают свои помехи: запуск в WSL или нестандартный
 * исполняемый файл. Проходим редакторы, где расширение Codex стоит; без расширения редактор просто пропускаем.
 */
async function connectCodexEditors(ctx: SetupContext): Promise<string[]> {
  const notes: string[] = [];
  for (const t of codexEditors) {
    if (!t.detect()) continue;
    try {
      notes.push(
        ...(
          await withNotes(async () => {
            await t.ensureAvailable?.(false);
            await t.preflight?.(ctx);
            return t.apply(ctx);
          })
        ).filter((n) => !n.startsWith('Провайдер PurpleSchool') && !n.startsWith('Конфигурация общая') && !n.startsWith('Ключ записан')),
      );
    } catch (e) {
      const text = message(e);
      if (!/Установи расширение/.test(text)) notes.push(`${t.title}: ${text}`);
    }
  }
  return notes;
}
