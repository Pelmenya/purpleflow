// Вкладка «Модели»: агент и модель для каждой роли, таймауты и параллельные прогоны.
import { Brain, ExternalLink, Wand2 } from 'lucide-react';
import { useState } from 'react';
import { ModelInput } from '../../components/ModelInput';
import { Select } from '../../components/Dropdown';
import { EFFORT_LEVELS, effortOf, effortOptions } from '../../lib/effort';
import { QuickSetup } from '../../components/QuickSetup';
import { Button, Field, NumberInput } from '../../components/ui';
import { isTrialSetup, trialSetup } from '../../lib/presets';
import { agentList } from '../../lib/tools';
import { PLANS_URL, trialOptions, useTrialLock } from '../../lib/trial';
import { useModelOptions } from '../../lib/useModelOptions';
import { useStore } from '../../lib/store';
import { AgentSwitch, modelPlaceholder, ROLES } from './parts';
import type { SettingsDraft } from './useSettingsDraft';

export function ModelsTab({ draft }: { draft: SettingsDraft }) {
  const { state, saveSettings } = useStore();
  const modelOptions = useModelOptions();
  const s = state.settings!;
  const tools = state.tools;
  const [quick, setQuick] = useState(false);
  // Пробный режим: роли только на моделях программы — пресеты и свои модели закрыты до подписки или пакета.
  const trial = useTrialLock();
  const lockedOptions = trial ? trialOptions(['claude', 'codex', 'opencode'], trial) : null;
  const options = lockedOptions ?? modelOptions;
  const {
    models,
    setModels,
    efforts,
    setEfforts,
    agents,
    setAgents,
    pickAgent,
    visualAgent,
    managerAgent,
    scanAgent,
    claudeFound,
    enabled,
    proxyOn,
    flashSaved,
    agentTimeout,
    setAgentTimeout,
    testTimeout,
    setTestTimeout,
    parallel,
    setParallel,
  } = draft;
  return (
    <section className="panel">
      <header className="panel-head">
        <div>
          <h2>Агенты и модели по ролям</h2>
          <p>
            {enabled.length > 1
              ? `Каждую роль может выполнять ${agentList(enabled, 'или')}.`
              : `Все роли выполняет ${enabled[0]} — остальные агенты выключены на вкладке «Инструменты».`}{' '}
            Имя модели передаётся выбранному CLI как есть, пусто — его модель по умолчанию.{' '}
            {enabled.length > 1 ? `Служебные вызовы (сводка, уроки) — на первом найденном из ${agentList(enabled)}. ` : ''}Новые настройки
            действуют на прогоны, запущенные после сохранения.
          </p>
        </div>
        <Button
          tone="primary"
          icon={<Wand2 size={15} />}
          disabled={Boolean(trial)}
          title={trial ? 'На пробном балансе пресеты недоступны' : undefined}
          onClick={() => setQuick(true)}
        >
          Быстрая настройка
        </Button>
      </header>
      {trial && <TrialNotice trial={trial} draft={draft} />}
      {quick && (
        <QuickSetup
          installed={{
            claude: claudeFound,
            codex: Boolean(tools?.codex.path && !tools.codex.error),
            opencode: Boolean(tools?.opencode?.path && !tools.opencode.error),
            agy: Boolean(tools?.agy?.path && !tools.agy.error),
          }}
          enabled={enabled}
          proxy={proxyOn}
          initialMain={agents.executor}
          onClose={() => setQuick(false)}
          onApply={async (v) => {
            setAgents(v.agents);
            setModels(v.models);
            await saveSettings({ agents: v.agents, models: v.models });
            flashSaved();
          }}
        />
      )}
      <div className="roles">
        {ROLES.map((r) => {
          const agent = agents[r.id];
          const sameAsExecutor = r.id === 'reviewer' && agent === agents.executor && models.reviewer.trim() === models.executor.trim();
          return (
            <div key={r.id} className={`role bezel role-${agent}`}>
              <div className="role-head">
                <strong>{r.title}</strong>
                <AgentSwitch
                  disabled={Boolean(trial)}
                  enabled={enabled}
                  label={r.title}
                  value={agent}
                  onChange={(a) => pickAgent(r.id, a)}
                />
              </div>
              <p>{r.text}</p>
              {sameAsExecutor && <p className="role-warn">Совпадает с исполнителем — ревью той же моделью находит меньше.</p>}
              <ModelInput
                disabled={Boolean(trial)}
                className="role-model"
                ariaLabel={`Модель: ${r.title}`}
                options={options[agent]}
                placeholder={modelPlaceholder(agent, proxyOn)}
                value={models[r.id]}
                onChange={(v) => setModels({ ...models, [r.id]: v })}
              />
              {EFFORT_LEVELS[agent].length > 0 && (
                <Select<string>
                  className="role-effort"
                  ariaLabel={`Уровень рассуждений: ${r.title}`}
                  title="Уровень рассуждений (effort): выше — дольше и дороже, но тщательнее"
                  icon={<Brain size={14} />}
                  value={effortOf(agent, efforts[r.id])}
                  minWidth={280}
                  onChange={(v) => setEfforts({ ...efforts, [r.id]: v || undefined })}
                  options={effortOptions(agent)}
                />
              )}
            </div>
          );
        })}
        <div className={`role bezel role-${visualAgent}`}>
          <div className="role-head">
            <strong>Визуальная проверка</strong>
            <AgentSwitch
              disabled={Boolean(trial)}
              enabled={enabled}
              label="Визуальная проверка"
              value={visualAgent}
              onChange={(a) => pickAgent('visual', a)}
            />
          </div>
          <p>
            Запускает приложение и проверяет результат в браузере через pw.
            {visualAgent !== 'claude'
              ? ` На ${visualAgent} — без песочницы: браузеру нужны сеть и запись вне проекта, код он не меняет по инструкции.`
              : ''}{' '}
            Пусто — модель исполнителя, если он на том же агенте.
          </p>
          <ModelInput
            disabled={Boolean(trial)}
            className="role-model"
            ariaLabel="Модель: визуальная проверка"
            options={options[visualAgent]}
            placeholder={
              agents.executor === visualAgent && models.executor
                ? `как у исполнителя: ${models.executor}`
                : modelPlaceholder(visualAgent, proxyOn)
            }
            value={models.visual ?? ''}
            onChange={(v) => setModels({ ...models, visual: v })}
          />
        </div>
        <div className={`role bezel role-${managerAgent}`}>
          <div className="role-head">
            <strong>Менеджер прогона</strong>
            <AgentSwitch
              disabled={Boolean(trial)}
              enabled={enabled}
              label="Менеджер прогона"
              value={managerAgent}
              onChange={(a) => pickAgent('manager', a)}
            />
          </div>
          <p>
            Отвечает в чате прогона, как идут дела, и предлагает поправить ход работы. Хватит быстрой модели.
            {agents.manager || enabled.length === 1 ? '' : ` Пока не выбран — первый найденный из ${agentList(enabled)}.`} Пусто — модель
            первой роли на том же агенте.
          </p>
          <ModelInput
            disabled={Boolean(trial)}
            className="role-model"
            ariaLabel="Модель: менеджер прогона"
            options={options[managerAgent]}
            placeholder={modelPlaceholder(managerAgent, proxyOn)}
            value={models.manager ?? ''}
            onChange={(v) => setModels({ ...models, manager: v })}
          />
        </div>
        <div className={`role bezel role-${scanAgent}`}>
          <div className="role-head">
            <strong>Сканирование проекта</strong>
            <AgentSwitch
              disabled={Boolean(trial)}
              enabled={enabled}
              label="Сканирование проекта"
              value={scanAgent}
              onChange={(a) => pickAgent('scan', a)}
            />
          </div>
          <p>
            Находит команды проекта и собирает профиль — стек, структуру, соглашения. Только читает код.
            {agents.scan || enabled.length === 1 ? '' : ` Пока не выбран — первый найденный из ${agentList(enabled)}.`}
            {enabled.length > 1 ? ' Если агент не вошёл в аккаунт или упал — сканирование повторит другой.' : ''} Пусто — модель первой роли
            на том же агенте.
          </p>
          <ModelInput
            disabled={Boolean(trial)}
            className="role-model"
            ariaLabel="Модель: сканирование проекта"
            options={options[scanAgent]}
            placeholder={modelPlaceholder(scanAgent, proxyOn)}
            value={models.scan ?? ''}
            onChange={(v) => setModels({ ...models, scan: v })}
          />
        </div>
      </div>
      <div className="user-config">
        <button
          role="switch"
          aria-checked={s.userConfig}
          className={`switch ${s.userConfig ? 'is-on' : ''}`}
          onClick={() => void saveSettings({ userConfig: !s.userConfig })}
        >
          <i />
          <span>Мои настройки агентов</span>
        </button>
        <p>
          {s.userConfig
            ? 'Агенты работают с вашими настройками из ~/.claude и ~/.codex: MCP-серверы, скиллы, плагины, CLAUDE.md — как в обычном claude и codex. Хуки claude в прогонах выключены. Файлы настроек PurpleFlow не меняет.'
            : 'Агенты запускаются изолированно: только настройки самого проекта, без ваших MCP-серверов, скиллов, плагинов и хуков. Прогоны повторяемее, но, например, задачу из трекера через MCP агент не прочитает.'}
        </p>
      </div>
      <div className="grid-2 narrow">
        <Field
          label="Агент молчит дольше, мин"
          hint="Столько без вывода — агент считается зависшим и останавливается. Долгую работу не обрывает: после этого времени покажем предупреждение, предел — ×4."
        >
          <NumberInput min={1} fallback={30} value={agentTimeout} onValue={setAgentTimeout} />
        </Field>
        <Field label="Таймаут тестов, мин">
          <NumberInput min={1} fallback={10} value={testTimeout} onValue={setTestTimeout} />
        </Field>
        <Field label="Одновременно прогонов" hint="Остальные ждут в очереди. Ожидание вашего решения место не занимает.">
          <NumberInput min={1} max={8} fallback={2} value={parallel} onValue={setParallel} />
        </Field>
      </div>
    </section>
  );
}

/** Плашка пробного режима: какие модели доступны, перевод ролей на них и ссылка на тарифы. */
function TrialNotice({ trial, draft }: { trial: NonNullable<ReturnType<typeof useTrialLock>>; draft: SettingsDraft }) {
  const { state, saveSettings } = useStore();
  const s = state.settings!;
  const [busy, setBusy] = useState(false);
  const plan = trialSetup(draft.enabled, s.agents, trial);
  const onTrial = isTrialSetup(s.models, trial);
  const apply = async () => {
    if (!plan) return;
    setBusy(true);
    try {
      draft.setAgents(plan.agents);
      draft.setModels(plan.models);
      await saveSettings({ agents: plan.agents, models: plan.models });
      draft.flashSaved();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="trial-lock" role="status">
      <div className="trial-lock-text">
        <span className="trial-banner-kicker">Пробный режим</span>
        <strong>Все роли — на {trial.map((m) => m.displayName).join(' и ')}</strong>
        <span>
          На стартовом балансе прокси PurpleSchool пускает только эти модели, поэтому пресеты и выбор моделей закрыты. Оформите подписку или
          купите пакет — откроются все.
        </span>
      </div>
      <div className="trial-lock-actions">
        {!onTrial && plan && (
          <Button tone="primary" busy={busy} onClick={() => void apply()}>
            Перевести роли на пробные модели
          </Button>
        )}
        <a className="btn btn-ghost" href={PLANS_URL} target="_blank" rel="noreferrer">
          <ExternalLink size={14} />
          <span>Тарифы</span>
        </a>
      </div>
    </div>
  );
}
