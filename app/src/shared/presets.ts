// Пресеты моделей: ступени по агентам и роли по пресетам. Чистая логика — нужна окну (быстрая настройка) и main (статистика).
import type { AgentKind, Models, Role } from '@purpleflow/core';

export type Agents = Record<Role, AgentKind> & { visual?: AgentKind; manager?: AgentKind; scan?: AgentKind };
export type PresetId = 'economy' | 'optimal' | 'max';
export type Tier = 'low' | 'mid' | 'high' | 'max';
export type Tiers = Record<Tier, string>;
export type Slot = Role | 'visual' | 'manager' | 'scan';

/**
 * Модели по уровням. Имена — те, что принимает и CLI, и AI-прокси PurpleSchool:
 * у claude алиасы CLI, у codex — линейка gpt-6 ступень в ступень: haiku → luna, sonnet → terra, opus → sol, Fable → astra.
 */
export const TIERS: Record<AgentKind, Record<Tier, string>> = {
  claude: { low: 'haiku', mid: 'sonnet', high: 'opus', max: 'claude-fable-5-2' },
  codex: { low: 'gpt-6-luna', mid: 'gpt-6.1-terra', high: 'gpt-6-sol', max: 'gpt-6-astra' },
  // У opencode ступени выбирает человек из моделей своих провайдеров (opencodeTiers); с AI-прокси по умолчанию — линейка прокси.
  opencode: { low: '', mid: '', high: '', max: '' },
  // Модели agy, которые есть и в AI-прокси PurpleSchool, и в аккаунте Google; суффикс — уровень рассуждений.
  // gemini-4-argon убран: провайдер в прокси отвечает на него ошибкой — вернуть, когда починят.
  agy: { low: 'gemini-3.8-flash-low', mid: 'gemini-3.8-flash-medium', high: 'gemini-3.8-flash-high', max: 'gemini-3.8-flash-high' },
};

/**
 * Уровень модели по ролям. Все роли — на основном агенте, и от пресета к пресету все растут на ступень:
 * сильнее всех — планировщик и ревьюер (от плана и проверки зависит качество), за ними — исполнитель и менеджер,
 * ниже — визуальная проверка и сканирование.
 */
export const PRESET_TIERS: Record<PresetId, Record<Slot, Tier>> = {
  economy: { planner: 'mid', executor: 'low', reviewer: 'mid', visual: 'low', manager: 'low', scan: 'low' },
  optimal: { planner: 'high', executor: 'mid', reviewer: 'high', visual: 'low', manager: 'mid', scan: 'low' },
  max: { planner: 'max', executor: 'high', reviewer: 'max', visual: 'mid', manager: 'high', scan: 'mid' },
};

/** Роли пресета по готовым ступеням основного агента. */
export function presetFromTiers(main: AgentKind, preset: PresetId, t: Tiers): { agents: Agents; models: Models } {
  const p = { tiers: PRESET_TIERS[preset] };
  // Ревью той же моделью находит меньше. Если уровни дали исполнителю модель ревьюера (две ступени на одной модели),
  // на ступень ниже уходит исполнитель, а не ревьюер: проверять должна модель не слабее автора кода.
  const order: Tier[] = ['max', 'high', 'mid', 'low'];
  const reviewer = t[p.tiers.reviewer];
  let executor = t[p.tiers.executor];
  if (executor === reviewer)
    executor =
      order
        .slice(order.indexOf(p.tiers.executor))
        .map((x) => t[x])
        .find((m) => m !== reviewer) ?? executor;
  // Менеджер на одной ступени с исполнителем — и на той же модели.
  const manager = p.tiers.manager === p.tiers.executor ? executor : t[p.tiers.manager];
  return {
    agents: { planner: main, executor: main, reviewer: main, visual: main, manager: main, scan: main },
    models: {
      planner: t[p.tiers.planner],
      executor,
      reviewer,
      visual: t[p.tiers.visual],
      manager,
      scan: t[p.tiers.scan],
    },
  };
}

/**
 * С каким пресетом запущен прогон — для статистики: планировщик, исполнитель и ревьюер на одном claude или codex
 * с моделями пресета. Остальное (opencode, разные агенты, свои модели) — custom.
 */
export function presetOf(agents: Partial<Record<Role, AgentKind>>, models: Partial<Record<Role, string>>): PresetId | 'custom' {
  const main = agents.executor;
  if (!main || main === 'opencode' || agents.planner !== main || agents.reviewer !== main) return 'custom';
  const roles: Role[] = ['planner', 'executor', 'reviewer'];
  // Пробный режим PurpleSchool: те же модели с префиксом прокси.
  const bare = (m: string | undefined) => (m ?? '').trim().replace(/^purpleflow\//, '');
  const found = (['economy', 'optimal', 'max'] as PresetId[]).find((id) => {
    const want = presetFromTiers(main, id, TIERS[main]).models;
    return roles.every((r) => bare(models[r]) === want[r]);
  });
  return found ?? 'custom';
}
