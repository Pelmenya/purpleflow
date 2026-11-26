import { useEffect, useMemo, useState } from 'react';
import type { AgentKind } from '@purpleflow/core';
import type { DropOption } from '../components/Dropdown';
import type { ProxyModels } from '../../../shared/models';
import { bridge } from './api';
import { mergeModelOptions } from './models';
import { useStore } from './store';

/** Один запрос на всё окно: main кэширует ответ, здесь — только чтобы не дёргать IPC на каждый экран. */
let loaded: Promise<ProxyModels | null> | null = null;
let last: ProxyModels | null = null;
let opencodeLoaded: Promise<string[]> | null = null;
let opencodeLast: string[] = [];
let agyLast: string[] = [];

/**
 * Подсказки моделей: сразу встроенные, следом — с моделями AI-прокси, когда список придёт.
 * Модели, доступные только через прокси, видны всегда — с пометкой; выбор без подписки перехватывает ModelInput.
 */
/** dir — папка проекта: у opencode могут быть свои провайдеры в opencode.json проекта. */
export function useModelOptions(dir?: string): Record<AgentKind, DropOption<string>[]> {
  const [remote, setRemote] = useState(last);
  const [opencode, setOpencode] = useState(opencodeLast);
  const [agy, setAgy] = useState(agyLast);
  const { state } = useStore();
  const viaProxy = Boolean(state.settings?.proxy.enabled && state.settings.proxy.hasKey);
  useEffect(() => {
    let alive = true;
    loaded ??= bridge.proxyModels().catch(() => null);
    void loaded.then((m) => {
      last = m;
      if (alive) setRemote(m);
    });
    // Список провайдеров opencode меняется редко, но после `opencode auth login` должен подхватиться — спрашиваем при каждом открытии.
    opencodeLoaded = bridge.core.listOpencodeModels(dir).catch(() => []);
    void opencodeLoaded.then((m) => {
      opencodeLast = m;
      if (alive) setOpencode(m);
    });
    // Слаги agy зависят от тарифа Google-аккаунта, поэтому список тоже спрашиваем каждый раз, а не держим в памяти.
    const agyList = bridge.core.listAgyModels().catch(() => []);
    void agyList.then((m: string[]) => {
      agyLast = m;
      if (alive) setAgy(m);
    });
    return () => {
      alive = false;
    };
    // Прокси включили или выключили — список agy другой (с прокси ядро моделей аккаунта не спрашивает).
  }, [dir, viaProxy]);
  return useMemo(() => mergeModelOptions(remote, opencode, agy, viaProxy), [remote, opencode, agy, viaProxy]);
}
