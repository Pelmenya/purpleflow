// Уровни рассуждений по агентам для выбора в чате; тот же список, что EFFORTS в ядре (core/src/model/settings.ts).
import type { AgentKind } from '@purpleflow/core';
import type { DropOption } from '../components/Dropdown';

export const EFFORT_LEVELS: Record<AgentKind, readonly string[]> = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['low', 'medium', 'high', 'xhigh'],
  opencode: [],
  agy: ['low', 'medium', 'high', 'xhigh'],
};

const HINTS: Record<string, string> = {
  low: 'Быстро и дёшево — простые вопросы',
  medium: 'Обычные задачи',
  high: 'Сложные правки',
  xhigh: 'Ещё глубже',
  max: 'Максимум, дольше всего',
};

/** Уровень, если агент его понимает; иначе '' — «как в CLI». */
export function effortOf(agent: AgentKind, effort: string | undefined): string {
  return effort && EFFORT_LEVELS[agent].includes(effort) ? effort : '';
}

export function effortOptions(agent: AgentKind): DropOption<string>[] {
  return [
    { value: '', label: 'как в CLI', hint: 'Флаг не передаётся — уровень из настроек самого CLI' },
    ...EFFORT_LEVELS[agent].map((e) => ({ value: e, label: e, hint: HINTS[e] })),
  ];
}
