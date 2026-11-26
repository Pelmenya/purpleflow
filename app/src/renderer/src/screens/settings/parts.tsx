// Справочники и мелкие элементы вкладок настроек.
import type { AgentKind, ConnectionCheck, Role, ToolName } from '@purpleflow/core';
import { CheckCircle2, PlugZap, XCircle } from 'lucide-react';
import { Button } from '../../components/ui';
import { AGENT_KINDS, agentList } from '../../lib/tools';
import type { SettingsDraft } from './useSettingsDraft';

export const TOOL_INFO: Record<ToolName, { title: string; install: string; note?: string }> = {
  git: { title: 'Git', install: 'git-scm.com' },
  claude: { title: 'Claude Code', install: 'npm i -g @anthropic-ai/claude-code' },
  codex: { title: 'Codex CLI', install: 'npm i -g @openai/codex' },
  opencode: { title: 'OpenCode', install: 'npm i -g opencode-ai' },
  // У Antigravity CLI нет пакета в npm — только установщик Google.
  agy: {
    title: 'Antigravity CLI',
    install: 'antigravity.google/docs/cli/install',
    note: 'Antigravity работает не во всех странах: из неподдерживаемого региона аккаунт не пройдёт проверку доступности.',
  },
  openspec: { title: 'OpenSpec', install: 'npm i -g @fission-ai/openspec' },
};
export const ROLES: { id: Role; title: string; text: string }[] = [
  { id: 'planner', title: 'Планировщик', text: 'Пишет proposal, tasks и дельты спецификаций' },
  { id: 'executor', title: 'Исполнитель', text: 'Реализует tasks.md и пишет тесты' },
  { id: 'reviewer', title: 'Ревьюер', text: 'Сверяет дифф с планом — лучше другая модель, чем у исполнителя' },
];
/** Подсказка в пустом поле модели; opencode с AI-прокси без своей модели идёт в рабочую модель прокси (как в ядре). */
export const modelPlaceholder = (agent: AgentKind, proxyOn: boolean) =>
  agent === 'opencode' && proxyOn ? 'по умолчанию gpt-6.1-terra через AI-прокси' : MODEL_PLACEHOLDER[agent];

export const MODEL_PLACEHOLDER: Record<AgentKind, string> = {
  claude: 'opus, sonnet, haiku или полное имя',
  codex: 'по умолчанию codex',
  opencode: 'провайдер/модель, по умолчанию — из настроек opencode',
  agy: 'gemini-3.8-flash; суффикс -low/-medium/-high — уровень рассуждений',
};
/** Выбор CLI-агента для роли. */
export function AgentSwitch({
  label,
  value,
  enabled,
  onChange,
  disabled,
}: {
  label: string;
  value: AgentKind;
  disabled?: boolean;
  /** Включённые CLI: выключенный не предлагаем. */
  enabled: AgentKind[];
  onChange: (a: AgentKind) => void;
}) {
  return (
    <div className="segmented small" role="radiogroup" aria-label={`Агент: ${label}`}>
      {enabled.map((a) => (
        <button
          key={a}
          role="radio"
          aria-checked={value === a}
          className={value === a ? 'is-on' : ''}
          disabled={disabled}
          onClick={() => onChange(a)}
        >
          {a}
        </button>
      ))}
    </div>
  );
}

/**
 * Какими CLI пользоваться. Выключенный не выполняет ни одной роли и не нужен на машине;
 * последний включённый выключить нельзя.
 */
export function AgentToggles({ draft }: { draft: SettingsDraft }) {
  const { enabled, setEnabled, savingEnabled } = draft;
  return (
    <div className="agent-toggles">
      <span className="qs-label">Агенты</span>
      <div className="agent-toggles-list">
        {AGENT_KINDS.map((a) => {
          const on = enabled.includes(a);
          const last = on && enabled.length === 1;
          return (
            <button
              key={a}
              role="switch"
              aria-checked={on}
              className={`switch ${on ? 'is-on' : ''}`}
              disabled={last || savingEnabled}
              title={last ? 'Нужен хотя бы один агент' : undefined}
              onClick={() =>
                void setEnabled(on ? enabled.filter((x) => x !== a) : AGENT_KINDS.filter((x) => x === a || enabled.includes(x)))
              }
            >
              <i />
              <span>{TOOL_INFO[a].title}</span>
            </button>
          );
        })}
      </div>
      <p>
        OpenCode подключает любых провайдеров — OpenRouter, DeepSeek, локальные модели; их настраивают в самом opencode (
        <code>opencode auth login</code>).{' '}
        {enabled.length === 1
          ? `Все роли выполняет ${enabled[0]}, остальные агенты не нужны и не запускаются. Включить их можно здесь же.`
          : `Роли можно делить между ${agentList(enabled)} — например, ревью другой моделью находит больше. Оставьте один, если пользуетесь только им.`}
      </p>
    </div>
  );
}

/** Сохранить настройки и отправить агентам короткий запрос. */
export function CheckButton({ draft }: { draft: SettingsDraft }) {
  return (
    <Button tone="ghost" icon={<PlugZap size={15} />} busy={draft.checking} onClick={() => void draft.check()}>
      Проверить подключение
    </Button>
  );
}

/** Ответы агентов на проверку подключения. */
export function ChecksList({ checks }: { checks: ConnectionCheck[] }) {
  return (
    <div className="checks">
      {checks.map((c) => (
        <div key={c.agent} className={`check ${c.ok ? 'is-ok' : 'is-bad'}`}>
          {c.ok ? <CheckCircle2 size={18} /> : <XCircle size={18} />}
          <div>
            <strong>{c.agent}</strong>{' '}
            <span className="muted mono">
              {c.model} · {(c.durationMs / 1000).toFixed(1)} с
            </span>
            <p>{c.ok ? `Ответил: «${c.reply}»` : c.error}</p>
          </div>
        </div>
      ))}
    </div>
  );
}
