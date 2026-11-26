// Пробный режим PurpleSchool: пока на балансе только пробные токены, прокси пускает лишь модели программы.
import { useEffect, useState } from 'react';
import type { AgentKind } from '@purpleflow/core';
import type { TrialModel } from '../../../shared/ipc';
import type { DropOption } from '../components/Dropdown';
import { bridge } from './api';
import { useStore } from './store';

/** Ссылка на тарифы — как в сообщении прокси об отказе модели. */
export const PLANS_URL = 'https://purpleschool.ru/ai-for-code#ai-proxy-plans';

let cache: { key: string; p: Promise<TrialModel[] | null> } | null = null;
const listeners = new Set<() => void>();

/** Перечитать состояние баланса: после начисления бонуса, покупки, входа. */
export function refreshTrial() {
  cache = null;
  for (const f of listeners) f();
}

/**
 * Модели программы, если включена работа через PurpleSchool и на балансе только пробные токены; иначе null.
 * Один запрос на окно — общий для всех экранов.
 */
export function useTrialLock(): TrialModel[] | null {
  const { state } = useStore();
  const s = state.settings;
  const key = s?.account && s.proxy.enabled && s.proxy.hasKey ? s.account.email : '';
  const [models, setModels] = useState<TrialModel[] | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const f = () => setTick((t) => t + 1);
    listeners.add(f);
    return () => void listeners.delete(f);
  }, []);
  useEffect(() => {
    if (!key) return setModels(null);
    if (!cache || cache.key !== key)
      cache = {
        key,
        p: bridge.account
          .trialModels()
          .then((r) => (r.ok ? r.data : null))
          .catch(() => null),
      };
    let alive = true;
    void cache.p.then((m) => alive && setModels(m));
    return () => {
      alive = false;
    };
  }, [key, tick]);
  return key ? models : null;
}

/**
 * Пробная модель агента: claude — Anthropic, codex и opencode — OpenAI.
 * У agy пробной модели нет: пробный баланс даёт модели Anthropic и OpenAI, а agy работает с Gemini.
 */
export const trialModelOf = (agent: AgentKind, models: TrialModel[]) =>
  agent === 'agy' ? undefined : models.find((m) => m.provider === (agent === 'claude' ? 'ANTHROPIC' : 'OPENAI'));

/** Варианты выбора модели в пробном режиме: у каждого агента — только его пробная модель. */
export function trialOptions(agents: AgentKind[], models: TrialModel[]): Record<AgentKind, DropOption<string>[]> {
  const out = { claude: [], codex: [], opencode: [], agy: [] } as Record<AgentKind, DropOption<string>[]>;
  for (const a of agents) {
    const m = trialModelOf(a, models);
    if (m) out[a] = [{ value: m.modelName, label: m.modelName, hint: `${m.displayName} — пробный баланс` }];
  }
  return out;
}
