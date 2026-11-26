import { ANTHROPIC_PROXY_MODELS, CLAUDE_CODE_BUILTIN_MODELS, DEFAULT_ANTHROPIC_MODEL } from '../constants.js';

/** Каталог моделей: id для API → подпись в UI. */
export type ModelCatalog = Record<string, string>;

/**
 * Достаёт список моделей из ответа `GET /v1/models`. Anthropic отдаёт
 * `{ data: [{ id, display_name }] }`, OpenAI — `{ data: [{ id }] }`; на всякий случай
 * принимаем и голый массив. Всё, что не похоже на модель, пропускаем.
 */
export function parseModelsResponse(body: unknown): ModelCatalog | undefined {
  const list = Array.isArray(body) ? body : (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(list)) return undefined;

  const catalog: ModelCatalog = {};
  for (const item of list) {
    const id = typeof item === 'string' ? item : (item as { id?: unknown } | null)?.id;
    if (typeof id !== 'string' || id.length === 0) continue;
    const displayName = (item as { display_name?: unknown } | null)?.display_name;
    catalog[id] = typeof displayName === 'string' && displayName.length > 0 ? displayName : id;
  }
  return Object.keys(catalog).length > 0 || list.length === 0 ? catalog : undefined;
}

/**
 * Каталог моделей Claude, которые реально отдаёт прокси. Берём его из ответа прокси при
 * проверке ключа — зашитый список устаревает быстрее, чем выходят релизы мастера (в сентябре
 * 2026 прокси уже отдавал claude-*-5, а мастер всё ещё пинил claude-sonnet-4-6). Зашитый
 * ANTHROPIC_PROXY_MODELS — только запасной вариант, когда проверить не получилось.
 */
export function claudeCatalog(proxyModels: ModelCatalog | undefined): ModelCatalog {
  return proxyClaudeModels(proxyModels) ?? ANTHROPIC_PROXY_MODELS;
}

/**
 * Модели Claude из ответа прокси плюс встроенные в Claude Code (их прокси в /v1/models не отдаёт,
 * но принимает — см. CLAUDE_CODE_BUILTIN_MODELS). undefined — если прокси моделей Claude не
 * вернул: тогда сверять пин не с чем.
 */
export function proxyClaudeModels(proxyModels: ModelCatalog | undefined): ModelCatalog | undefined {
  if (!proxyModels) return undefined;
  const claude = Object.fromEntries(Object.entries(proxyModels).filter(([id]) => id.startsWith('claude')));
  // A valid empty discovery list can still serve the built-in Claude models. Модели прокси идут
  // первыми: встроенные он может не принять на балансе пользователя (на пробном работает только Haiku).
  const builtin = Object.fromEntries(Object.entries(CLAUDE_CODE_BUILTIN_MODELS).filter(([id]) => !(id in claude)));
  return { ...claude, ...builtin };
}

/** Модель из списка, которую прокси назвал в тексте отказа («Доступная модель: … (claude-haiku-5-5)»). */
export function suggestedModel(detail: string | undefined, candidates: string[], rejected: string[] = []): string | undefined {
  if (!detail) return undefined;
  const known = candidates.filter((id) => !rejected.includes(id) && detail.includes(id)).sort((a, b) => b.length - a.length)[0];
  if (known) return known;
  // Прокси может назвать модель, которой нет в /v1/models: берём id в скобках.
  const named = detail.match(/\(((?:claude|gpt)-[A-Za-z0-9.-]+)\)/)?.[1];
  return named && !rejected.includes(named) ? named : undefined;
}

/**
 * Модель по умолчанию для пина: наш DEFAULT_ANTHROPIC_MODEL, если прокси его отдаёт, иначе
 * первая Sonnet из каталога (разумный баланс цены и качества), иначе первая попавшаяся.
 */
export function defaultClaudeModel(catalog: ModelCatalog): string {
  if (DEFAULT_ANTHROPIC_MODEL in catalog) return DEFAULT_ANTHROPIC_MODEL;
  const ids = Object.keys(catalog);
  return ids.find((id) => id.includes('sonnet')) ?? ids[0] ?? DEFAULT_ANTHROPIC_MODEL;
}

/** Самая дешёвая модель для проверочного запроса: Haiku, если есть. */
export function cheapestClaudeModel(catalog: ModelCatalog): string {
  const ids = Object.keys(catalog);
  return ids.find((id) => id.includes('haiku')) ?? defaultClaudeModel(catalog);
}
