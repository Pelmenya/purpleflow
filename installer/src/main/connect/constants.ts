export const ANTHROPIC_BASE_URL = 'https://app.purpleschool.ru/api-v2/public/ai-proxy/anthropic';

// Без /v1 — как и ANTHROPIC_BASE_URL, конкретный target сам решает, добавлять ли /v1
// (checkPurpleSchoolToken всегда бьёт в `${baseUrl}/v1/models`).
export const OPENAI_BASE_URL = 'https://app.purpleschool.ru/api-v2/public/ai-proxy/openai';

export const CABINET_URL = 'https://app.purpleschool.ru/';

export const BACKUP_DIR_NAME = '.purpleschool-ai-backups';

export const RC_BLOCK_START = '# >>> purpleschool ai-for-code >>>';
export const RC_BLOCK_END = '# <<< purpleschool ai-for-code <<<';

/**
 * Модели Claude, которые прокси принимает, но НЕ отдаёт в `GET /v1/models`: для клиента Claude Code
 * бэкенд намеренно исключает их из списка (DEFAULT_CLAUDE_CODE_MODELS в automation — Claude Code
 * знает их сам, а gateway discovery добавляет только «дополнительные»). Поэтому каталог, который
 * мы собираем из ответа прокси, всегда дополняем этими тремя — иначе рабочую claude-sonnet-5
 * мы бы сочли «неподдерживаемой» (так и было в 0.7.0).
 */
export const CLAUDE_CODE_BUILTIN_MODELS: Record<string, string> = {
  'claude-sonnet-5': 'Claude Sonnet 5',
  'claude-opus-4-8': 'Claude Opus 4.8',
  'claude-haiku-4-5-20251001': 'Claude Haiku 4.5',
};

/**
 * Запасной каталог — если спросить прокси не удалось. Сверено с таблицей ai_proxy_models и
 * активными ценами провайдера ANTHROPIC 28.09.2026: ровно эти id принимает /v1/messages.
 * Haiku — только с датой: прокси срезает суффикс у запрошенного имени, но не дописывает его,
 * так что «claude-haiku-4-5» даёт 400 Model not supported. Ключ — id для API, значение — подпись.
 */
export const ANTHROPIC_PROXY_MODELS: Record<string, string> = {
  ...CLAUDE_CODE_BUILTIN_MODELS,
  'claude-opus-5-5': 'Claude Opus 5.5',
  'claude-opus-5': 'Claude Opus 5',
  'claude-opus-4-7': 'Claude Opus 4.7',
  'claude-opus-4-6': 'Claude Opus 4.6',
  'claude-sonnet-4-6': 'Claude Sonnet 4.6',
};

/**
 * Модель, которую мы пиним в ~/.claude.json, если у пользователя пина нет или он указывает
 * на модель вне каталога прокси. Claude Code подставляет пин в каждый запрос, поэтому
 * унаследованный от прежней конфигурации пин (например "sonnet[1m]") ломает вообще всё.
 */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-5';

/** Пин по умолчанию из прошлых версий мастера — тоже наш, убираем его при удалении. */
export const LEGACY_DEFAULT_ANTHROPIC_MODELS = ['claude-sonnet-4-6'];
