import type { AgentKind } from '@purpleflow/core';
import type { DropOption } from '../components/Dropdown';
import type { ProxyModels } from '../../../shared/models';

/**
 * Встроенные подсказки моделей: алиасы claude, Fable и линейка gpt-6 (с gpt-6.1-terra) — их принимают и CLI, и AI-прокси PurpleSchool.
 * Остальные модели прокси подмешиваются из GET /public/ai-proxy/models (mergeModelOptions). Можно ввести и любое имя.
 */
export const MODEL_OPTIONS: Record<AgentKind, DropOption<string>[]> = {
  claude: [
    { value: 'claude-fable-5-2', label: 'claude-fable-5-2', hint: 'Fable 5.2 — самая сильная, сложные задачи и планирование' },
    { value: 'claude-fable-5-1', label: 'claude-fable-5-1', hint: 'Fable 5.1 — предыдущая Fable' },
    { value: 'opus', label: 'opus', hint: 'Сильная — планирование и сложный код' },
    { value: 'sonnet', label: 'sonnet', hint: 'Рабочая — баланс скорости и качества' },
    { value: 'haiku', label: 'haiku', hint: 'Быстрая и дешёвая — простые задачи' },
  ],
  codex: [
    { value: 'gpt-6-astra', label: 'gpt-6-astra', hint: 'Самая сильная — сложные задачи и планирование' },
    { value: 'gpt-6-sol', label: 'gpt-6-sol', hint: 'Сильная — планирование и сложный код' },
    { value: 'gpt-6.1-terra', label: 'gpt-6.1-terra', hint: 'Рабочая — баланс скорости и качества' },
    { value: 'gpt-6-luna', label: 'gpt-6-luna', hint: 'Быстрая и дешёвая — простые задачи' },
  ],
  // Свои модели opencode — из его провайдеров (`opencode models`), подмешиваются в useModelOptions.
  opencode: [],
  // Модели Gemini, которые есть в AI-прокси; модели аккаунта Google (`agy models`) подмешиваются в useModelOptions.
  agy: [{ value: 'gemini-3.8-flash', label: 'gemini-3.8-flash', hint: 'Рабочая — уровень рассуждений суффиксом: -low, -medium, -high' }],
};

/**
 * Своё семейство агента — модели самого вендора: работают и по подписке пользователя, без прокси.
 * Остальные (например, Gemini у codex) прокси PurpleSchool отдаёт через совместимый API — только через него.
 */
const OWN_FAMILY: Record<AgentKind, RegExp> = {
  claude: /^claude-/,
  codex: /^(gpt-|o\d|codex-)/,
  // «провайдер/модель» — провайдер пользователя; имя без провайдера opencode отправит в AI-прокси.
  opencode: /\//,
  // Gemini — модели Google: работают и через прокси, и через аккаунт Google.
  agy: /^gemini-/,
};
/** Модель из списка, которая работает только через AI-прокси PurpleSchool. */
export function proxyOnly(options: DropOption<string>[], model: string): boolean {
  const v = model.trim();
  return Boolean(v) && options.some((o) => o.value === v && o.badge === PROXY_ONLY_BADGE);
}

/** Пометка моделей, которые работают только через AI-прокси, то есть только по подписке PurpleSchool. */
export const PROXY_ONLY_BADGE = 'подписка PurpleSchool';
export const PROXY_ONLY_TITLE =
  'Модель не от OpenAI и не от Anthropic: прокси PurpleSchool отдаёт её через совместимый API. Доступна только по подписке PurpleSchool.';

/**
 * Сначала встроенные (с нашими подсказками), за ними — остальные модели прокси с их названием в подсказке.
 * Модели не своего семейства видны всегда, с пометкой «подписка PurpleSchool»: без прокси выбор такой модели
 * ведёт ко входу или включению PurpleSchool (ModelInput), а не молча ломает запуск.
 */
export function mergeModelOptions(
  remote: ProxyModels | null,
  opencode: string[] = [],
  agy: string[] = [],
  /** Агенты идут через AI-прокси (ключ есть и включён). */
  viaProxy = false,
): Record<AgentKind, DropOption<string>[]> {
  const base = remote ? mergeRemote(remote) : MODEL_OPTIONS;
  const out = withLocal(base, 'opencode', opencode);
  // agy ходит либо в прокси, либо в аккаунт Google — смешивать списки нельзя: модель аккаунта через прокси даёт 404.
  // С прокси — только Gemini из прокси. Без него — все модели аккаунта (`agy models`); пока их нет (не вошёл,
  // список не пришёл) — модели прокси: их имена agy принимает и со своим входом.
  if (!viaProxy && agy.length) out.agy = agyAccountOptions(agy);
  return out;
}

/** Модели аккаунта Google: слаг с уровнем рассуждений, название — из `agy models` нет, подсказка — уровень. */
function agyAccountOptions(list: string[]): DropOption<string>[] {
  return [...new Set(list)].map((m) => ({ value: m, label: m }));
}

/** Модели, которые агент перечисляет сам (свои провайдеры, аккаунт) — первыми: они работают без AI-прокси. */
function withLocal(
  base: Record<AgentKind, DropOption<string>[]>,
  agent: AgentKind,
  list: string[],
): Record<AgentKind, DropOption<string>[]> {
  if (!list.length) return base;
  const known = new Set(base[agent].map((o) => o.value));
  const local = list
    .filter((m) => !known.has(m))
    .map((m) => ({ value: m, label: m, hint: m.endsWith('-free') ? 'бесплатная' : undefined }));
  const out: Record<AgentKind, DropOption<string>[]> = { ...base };
  out[agent] = [...local, ...base[agent]];
  return out;
}

function mergeRemote(remote: ProxyModels): Record<AgentKind, DropOption<string>[]> {
  const add = (agent: AgentKind, list: ProxyModels['anthropic']) => {
    const base = MODEL_OPTIONS[agent];
    const known = new Set(base.map((o) => o.value));
    const extra: DropOption<string>[] = [];
    for (const m of list) {
      if (known.has(m.id)) continue;
      const own = OWN_FAMILY[agent].test(m.id);
      const name = m.displayName && m.displayName !== m.id ? m.displayName : '';
      extra.push({
        value: m.id,
        label: m.id,
        hint: name || undefined,
        ...(own ? {} : { badge: PROXY_ONLY_BADGE, badgeTitle: PROXY_ONLY_TITLE }),
      });
    }
    return [...base, ...extra];
  };
  return {
    claude: add('claude', remote.anthropic),
    codex: add('codex', remote.openai),
    opencode: add('opencode', remote.openai),
    // agy через прокси ходит в Gemini API: из списка OpenAI-совместимых моделей ему подходят только Gemini.
    agy: add(
      'agy',
      remote.openai.filter((m) => /^gemini-/.test(m.id)),
    ),
  };
}
