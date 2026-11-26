import type { AgentKind, Role, ToolName } from '@purpleflow/core';

export const AGENT_KINDS: AgentKind[] = ['claude', 'codex', 'opencode', 'agy'];

/** Включённые CLI-агенты; не задано или пусто — claude и codex (opencode и agy — по желанию). */
export function enabledList(enabled?: AgentKind[]): AgentKind[] {
  const list = AGENT_KINDS.filter((a) => enabled?.includes(a));
  return list.length ? list : ['claude', 'codex'];
}

export const isAgent = (t: ToolName): t is AgentKind => (AGENT_KINDS as string[]).includes(t);

/** Все инструменты в порядке показа: git, агенты, openspec. */
export const TOOL_NAMES: ToolName[] = ['git', ...AGENT_KINDS, 'openspec'];

/** Инструменты, которые показываем: выключенные агенты — нет. */
export const shownTools = (enabled?: AgentKind[]) => TOOL_NAMES.filter((t) => !isAgent(t) || enabledList(enabled).includes(t));

/**
 * Нужен ли инструмент: git и openspec — всегда, агент — если включён
 * и на нём работает хотя бы одна роль.
 */
export function toolNeeded(t: ToolName, agents?: Partial<Record<Role, AgentKind>>, enabled?: AgentKind[]): boolean {
  if (!isAgent(t)) return true;
  if (!enabledList(enabled).includes(t)) return false;
  return !agents || Object.values(agents).includes(t);
}

/** «claude», «claude и codex», «claude, codex и opencode» — с союзом «и» или «или». */
export function agentList(list: string[], conj: 'и' | 'или' = 'и'): string {
  return list.length < 2 ? (list[0] ?? '') : `${list.slice(0, -1).join(', ')} ${conj} ${list.at(-1)}`;
}
