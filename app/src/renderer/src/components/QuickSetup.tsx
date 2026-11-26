import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Gauge, Leaf, Sparkles, X } from 'lucide-react';
import type { AgentKind, Models } from '@purpleflow/core';
import { useModelOptions } from '../lib/useModelOptions';
import { ModelInput } from './ModelInput';
import { Button } from './ui';
import {
  buildPreset,
  fillTiers,
  opencodeTiers,
  ROLE_TITLE,
  saveOpencodeTiers,
  TIER_ORDER,
  TIER_TITLE,
  type Agents,
  type PresetId,
  type Slot,
  type Tiers,
} from '../lib/presets';
import { useDialogClose } from '../lib/useDialogClose';

/** Пресеты в окне: уровни моделей по ролям — в PRESET_TIERS (lib/presets). */
const PRESETS: { id: PresetId; title: string; text: string; icon: ReactNode }[] = [
  {
    id: 'economy',
    title: 'Экономный',
    text: 'Рабочая модель планирует и проверяет, быстрая делает остальное. Для простых задач и правок.',
    icon: <Leaf size={18} />,
  },
  {
    id: 'optimal',
    title: 'Оптимальный',
    text: 'Сильная модель планирует и проверяет, рабочая пишет код. Баланс цены и качества.',
    icon: <Gauge size={18} />,
  },
  {
    id: 'max',
    title: 'Максимальное качество',
    text: 'Самая сильная модель планирует и проверяет, сильная пишет код. Дороже и медленнее.',
    icon: <Sparkles size={18} />,
  },
];

/** Поп-ап быстрой настройки: основной агент и пресет — роли и модели расставляются сами. */
export function QuickSetup({
  installed,
  enabled,
  proxy,
  initialMain,
  onApply,
  onClose: closeNow,
}: {
  installed: Record<AgentKind, boolean>;
  /** Включённые в настройках CLI: выключенный основным агентом не предлагаем. */
  enabled: AgentKind[];
  /** Включён AI-прокси: opencode получает модели прокси по ступеням. */
  proxy: boolean;
  initialMain: AgentKind;
  onApply: (v: { agents: Agents; models: Models }) => Promise<void>;
  onClose: () => void;
}) {
  const { closing, close: onClose } = useDialogClose(closeNow);
  const [main, setMain] = useState<AgentKind>(() => {
    const start = enabled.includes(initialMain) ? initialMain : enabled[0];
    // Основной агент по умолчанию — установленный: сначала тот, что у исполнителя, иначе первый найденный.
    return installed[start] ? start : (enabled.find((a) => installed[a]) ?? start);
  });
  const [preset, setPreset] = useState<PresetId>('optimal');
  const [busy, setBusy] = useState(false);
  const [tiers, setTiers] = useState<Tiers>(() => opencodeTiers(proxy));
  const modelOptions = useModelOptions();
  const plan = buildPreset(main, preset, proxy, tiers);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const apply = async () => {
    setBusy(true);
    try {
      if (main === 'opencode') saveOpencodeTiers(tiers);
      await onApply(plan);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className={`qs-scrim ${closing ? 'is-closing' : ''}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="qs" role="dialog" aria-modal aria-labelledby="qs-title">
        <header className="qs-head">
          <div>
            <h2 id="qs-title">Быстрая настройка</h2>
            <p>Выберите основного агента и уровень — роли и модели расставятся сами. Потом любую роль можно поправить вручную.</p>
          </div>
          <button className="qs-close" aria-label="Закрыть" onClick={onClose}>
            <X size={16} />
          </button>
        </header>

        <div className="qs-section">
          <span className="qs-label">Основной агент</span>
          <div className="segmented qs-agents" role="radiogroup" aria-label="Основной агент">
            {enabled.map((a) => (
              <button key={a} role="radio" aria-checked={main === a} className={main === a ? 'is-on' : ''} onClick={() => setMain(a)}>
                {a}
                {!installed[a] && <em> · не найден</em>}
              </button>
            ))}
          </div>
        </div>

        {main === 'opencode' && (
          <div className="qs-tiers">
            <span className="qs-label">Модели opencode по уровням</span>
            <p>
              {proxy
                ? 'По умолчанию — модели AI-прокси PurpleSchool. Можно выбрать и модели своих провайдеров, «провайдер/модель».'
                : 'Выберите модели своих провайдеров, «провайдер/модель». Хватит и одной: пустой уровень займёт ближайший заполненный.'}
            </p>
            <div className="qs-tiers-grid">
              {TIER_ORDER.map((t) => (
                <label key={t}>
                  <span>{TIER_TITLE[t]}</span>
                  <ModelInput
                    ariaLabel={`Модель opencode: ${TIER_TITLE[t]}`}
                    options={modelOptions.opencode}
                    placeholder={fillTiers(tiers)[t] || 'из настроек opencode'}
                    value={tiers[t]}
                    onChange={(v) => setTiers({ ...tiers, [t]: v })}
                  />
                </label>
              ))}
            </div>
          </div>
        )}

        <div className="qs-presets" role="radiogroup" aria-label="Пресет">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              role="radio"
              aria-checked={preset === p.id}
              className={`qs-preset ${preset === p.id ? 'is-on' : ''}`}
              onClick={() => setPreset(p.id)}
            >
              <span className="qs-preset-icon">{p.icon}</span>
              <strong>{p.title}</strong>
              <span>{p.text}</span>
            </button>
          ))}
        </div>

        <div className="qs-plan">
          {(Object.keys(ROLE_TITLE) as Slot[]).map((r) => (
            <div key={r} className="qs-row">
              <span>{ROLE_TITLE[r]}</span>
              <span className="grow" />
              <span className={`qs-agent qs-agent-${plan.agents[r] ?? main}`}>{plan.agents[r] ?? main}</span>
              <code>{plan.models[r] || 'по умолчанию'}</code>
            </div>
          ))}
          <p className="qs-note">
            Все роли — на {main}
            {main === 'claude' ? ', модели Anthropic' : main === 'codex' ? ', модели OpenAI' : ', модели по уровням выше'}. Самые сильные
            модели — у планировщика и ревьюера: от плана и проверки зависит качество. Ревьюер работает на другой модели, чем исполнитель:
            так он находит больше ошибок.
          </p>
        </div>

        <footer className="qs-foot">
          <Button tone="quiet" onClick={onClose}>
            Отмена
          </Button>
          <Button tone="primary" busy={busy} onClick={() => void apply()}>
            Применить
          </Button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
