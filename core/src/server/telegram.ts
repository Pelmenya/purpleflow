import fs from 'node:fs';
import path from 'node:path';
import { writeAtomic } from '../store.js';
import type { AttentionIntent } from './attention.js';
import { isReturnRoute } from './session.js';

export interface TelegramHost {
  intents(): AttentionIntent[];
  onIntentChange(fn: (runId: string, intent: AttentionIntent | null) => void): () => void;
}

export interface TelegramOptions {
  dataDir: string;
  token: string;
  chatId: string | number;
  apiBase?: string;
  publicOrigin: string;
  host: TelegramHost;
  now?: () => number;
}

export interface TelegramStatus {
  connected: true;
  lastError: string | null;
  lastDeliveredAt: number | null;
}

export interface TelegramProbeResult {
  ok: boolean;
  error: string | null;
}

export interface TelegramHandle {
  stop(): Promise<void>;
  probe(): Promise<TelegramProbeResult>;
  status(): TelegramStatus;
}

type QueueState = 'pending' | 'delivered' | 'dropped' | 'failed';

type QueueEntry = {
  key: string;
  runId: string;
  kind: AttentionIntent['kind'];
  reasonCode: string;
  state: QueueState;
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
};

type DeliveryOutcome = { kind: 'delivered' } | { kind: 'failed'; error: string } | { kind: 'retry'; error: string; retryAfterMs?: number };

const REASONS: Record<string, string> = {
  gate0: 'Требуется уточнение',
  gate1: 'Требуется утверждение плана',
  gate2: 'Требуется приёмка',
  limit_attempts: 'Исчерпаны попытки',
  limit_loop: 'Обнаружен круг ревью',
  stage_failed: 'Прогон остановлен с ошибкой',
  start_failed: 'Прогон остановлен с ошибкой запуска',
  plan_invalid: 'Прогон остановлен: план не прошёл проверку',
  no_checks: 'Прогон остановлен: не заданы проверки',
  checks_red: 'Прогон остановлен: проверки не прошли',
};

// Решение после проверки актуальности не отменяет уже начатую отправку. Bot API не принимает
// ключ идемпотентности, поэтому обрыв ответа или падение до записи delivered могут дать один дубль.
export function attentionLink(publicOrigin: string, intent: AttentionIntent): string {
  const route = `/runs/${encodeURIComponent(intent.runId)}${intent.kind === 'stopped' ? '/log' : ''}`;
  if (isReturnRoute(route) !== route) throw new Error('Ссылка на внимание не прошла проверку маршрута');
  return new URL(route, publicOrigin).toString();
}

function readQueue(file: string): QueueEntry[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Не удалось разобрать очередь Telegram ${file}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`Некорректная очередь Telegram ${file}`);
  return parsed.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Некорректная очередь Telegram ${file}`);
    const entry = value as Partial<QueueEntry>;
    if (
      typeof entry.key !== 'string' ||
      typeof entry.runId !== 'string' ||
      (entry.kind !== 'wait' && entry.kind !== 'stopped') ||
      typeof entry.reasonCode !== 'string' ||
      !['pending', 'delivered', 'dropped', 'failed'].includes(entry.state ?? '') ||
      typeof entry.attempts !== 'number' ||
      !Number.isInteger(entry.attempts) ||
      entry.attempts < 0 ||
      typeof entry.nextAttemptAt !== 'number' ||
      !Number.isFinite(entry.nextAttemptAt) ||
      (typeof entry.lastError !== 'string' && entry.lastError !== null)
    ) {
      throw new Error(`Некорректная очередь Telegram ${file}`);
    }
    return { ...entry } as QueueEntry;
  });
}

export function startTelegram(options: TelegramOptions): TelegramHandle {
  const now = options.now ?? Date.now;
  const apiBase = options.apiBase ?? 'https://api.telegram.org';
  const queueFile = path.join(options.dataDir, 'server', 'telegram-queue.json');
  const queue = new Map<string, QueueEntry>(readQueue(queueFile).map((entry) => [entry.key, entry]));
  let lastError: string | null = null;
  let lastDeliveredAt: number | null = null;
  let stopping = false;
  let stopPromise: Promise<void> | undefined;
  let workerController: AbortController | undefined;
  let workerTimer: NodeJS.Timeout | undefined;
  let wakeWorker: (() => void) | undefined;
  const probes = new Set<AbortController>();
  const probePromises = new Set<Promise<TelegramProbeResult>>();

  const sanitized = (value: string): string => (options.token ? value.split(options.token).join('***') : value);
  const errorReason = (error: unknown): string => {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (typeof code === 'string') return sanitized(code);
    return error instanceof Error ? sanitized(error.name) : 'Error';
  };
  const report = (error: unknown): void => {
    lastError = errorReason(error);
    console.error(`Telegram: ${lastError}`);
  };
  const save = (): void => {
    if (stopping) return;
    try {
      writeAtomic(queueFile, `${JSON.stringify([...queue.values()], null, 2)}\n`);
    } catch (error) {
      report(error);
    }
  };
  const wake = (): void => {
    if (workerTimer) clearTimeout(workerTimer);
    workerTimer = undefined;
    const notify = wakeWorker;
    wakeWorker = undefined;
    notify?.();
  };

  const applyIntent = (intent: AttentionIntent | null, runId: string, recoverFailed: boolean): boolean => {
    const existing = intent
      ? queue.get(intent.key)
      : [...queue.values()].find((entry) => entry.runId === runId && entry.state === 'pending');
    if (!intent) {
      if (!existing || existing.state !== 'pending') return false;
      existing.state = 'dropped';
      existing.lastError = null;
      return true;
    }
    if (!existing) {
      queue.set(intent.key, {
        ...intent,
        state: 'pending',
        attempts: 0,
        nextAttemptAt: now(),
        lastError: null,
      });
      return true;
    }
    if (existing.state === 'delivered') return false;
    if (existing.state === 'failed' && !recoverFailed) return false;
    if (existing.state === 'pending') return false;
    existing.state = 'pending';
    existing.nextAttemptAt = now();
    existing.lastError = null;
    return true;
  };

  const reconcile = (recoverFailed: boolean): void => {
    if (stopping) return;
    let active: AttentionIntent[];
    try {
      active = options.host.intents();
    } catch (error) {
      report(error);
      return;
    }
    const keys = new Set(active.map((intent) => intent.key));
    for (const intent of active) applyIntent(intent, intent.runId, recoverFailed);
    for (const entry of queue.values()) {
      if (keys.has(entry.key) || entry.state === 'delivered') continue;
      if (entry.state === 'pending' || (recoverFailed && entry.state === 'failed')) {
        entry.state = 'dropped';
        entry.lastError = null;
      }
    }
    save();
    wake();
  };

  const unsubscribe = options.host.onIntentChange((runId, intent) => {
    if (stopping) return;
    try {
      if (applyIntent(intent, runId, false)) save();
      wake();
    } catch (error) {
      report(error);
    }
  });

  const request = async (text: string, controller: AbortController): Promise<DeliveryOutcome> => {
    let response: Response;
    try {
      response = await fetch(`${apiBase}/bot${options.token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: options.chatId, text }),
        redirect: 'manual',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
      });
    } catch (error) {
      return { kind: 'retry', error: errorReason(error) };
    }

    let bodyText = '';
    let bodyError: unknown;
    try {
      bodyText = await response.text();
    } catch (error) {
      bodyError = error;
    }
    let body: unknown;
    try {
      body = bodyText ? JSON.parse(bodyText) : undefined;
    } catch {
      body = undefined;
    }
    const record = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
    const description = typeof record?.description === 'string' ? sanitized(record.description.slice(0, 200)) : '';
    const httpError = `HTTP ${response.status}${description ? `: ${description}` : ''}`;

    if (response.status >= 400 && response.status < 500 && response.status !== 429) {
      return { kind: 'failed', error: httpError };
    }
    if (response.status === 429 && !bodyError) {
      const parameters = record?.parameters;
      const retryAfter =
        parameters && typeof parameters === 'object' && !Array.isArray(parameters)
          ? (parameters as Record<string, unknown>).retry_after
          : undefined;
      if (typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter > 0) {
        return { kind: 'retry', error: httpError, retryAfterMs: Math.min(retryAfter, 86_400) * 1000 };
      }
    }
    if (response.status >= 200 && response.status < 300 && !bodyError && record?.ok === true) return { kind: 'delivered' };
    return { kind: 'retry', error: bodyError ? errorReason(bodyError) : httpError };
  };

  const retry = (entry: QueueEntry, outcome: Extract<DeliveryOutcome, { kind: 'retry' }>): void => {
    entry.state = 'pending';
    const exponential = Math.min(5_000 * 2 ** Math.max(0, entry.attempts - 1), 600_000);
    entry.nextAttemptAt = now() + (outcome.retryAfterMs ?? exponential);
    entry.lastError = outcome.error;
  };

  const deliver = async (entry: QueueEntry): Promise<void> => {
    if (stopping || entry.state !== 'pending') return;
    let current: boolean;
    try {
      current = options.host.intents().some((intent) => intent.key === entry.key);
    } catch (error) {
      entry.nextAttemptAt = now() + 5_000;
      entry.lastError = errorReason(error);
      save();
      return;
    }
    if (!current) {
      entry.state = 'dropped';
      entry.lastError = null;
      save();
      return;
    }

    entry.attempts += 1;
    entry.nextAttemptAt = now();
    entry.lastError = null;
    save();
    if (stopping) return;
    const controller = new AbortController();
    workerController = controller;
    let outcome: DeliveryOutcome;
    try {
      const text = `${REASONS[entry.reasonCode] ?? 'Требуется внимание к прогону'}\n${attentionLink(options.publicOrigin, entry)}`;
      outcome = await request(text, controller);
    } catch (error) {
      outcome = { kind: 'retry', error: errorReason(error) };
    } finally {
      if (workerController === controller) workerController = undefined;
    }
    if (stopping) return;
    const latest = queue.get(entry.key);
    if (!latest || latest !== entry) return;
    if (outcome.kind === 'delivered') {
      entry.state = 'delivered';
      entry.lastError = null;
      lastError = null;
      lastDeliveredAt = now();
    } else if (outcome.kind === 'failed') {
      entry.state = 'failed';
      entry.lastError = outcome.error;
      lastError = outcome.error;
    } else {
      retry(entry, outcome);
      lastError = outcome.error;
    }
    save();
  };

  const runWorker = async (): Promise<void> => {
    while (!stopping) {
      const pending = [...queue.values()].filter((entry) => entry.state === 'pending');
      const next = pending.reduce<QueueEntry | undefined>(
        (earliest, entry) => (!earliest || entry.nextAttemptAt < earliest.nextAttemptAt ? entry : earliest),
        undefined,
      );
      if (next && next.nextAttemptAt <= now()) {
        await deliver(next);
        continue;
      }
      const delay = next ? Math.max(0, next.nextAttemptAt - now()) : 60_000;
      await new Promise<void>((resolve) => {
        const finish = (): void => {
          if (workerTimer) clearTimeout(workerTimer);
          workerTimer = undefined;
          if (wakeWorker === finish) wakeWorker = undefined;
          resolve();
        };
        wakeWorker = finish;
        workerTimer = setTimeout(finish, Math.min(delay, 60_000));
      });
    }
  };

  reconcile(true);
  const reconciliation = setInterval(() => {
    try {
      reconcile(false);
    } catch (error) {
      report(error);
    }
  }, 60_000);
  const workerPromise = runWorker().catch(report);

  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopping = true;
    unsubscribe();
    clearInterval(reconciliation);
    wake();
    workerController?.abort();
    for (const controller of probes) controller.abort();
    stopPromise = (async () => {
      await workerPromise;
      await Promise.all([...probePromises]);
    })();
    return stopPromise;
  };

  const probe = (): Promise<TelegramProbeResult> => {
    if (stopping) return Promise.reject(new Error('Уведомления останавливаются'));
    const controller = new AbortController();
    probes.add(controller);
    const promise = (async (): Promise<TelegramProbeResult> => {
      const outcome = await request('Пробное уведомление PurpleFlow', controller);
      const result: TelegramProbeResult = outcome.kind === 'delivered' ? { ok: true, error: null } : { ok: false, error: outcome.error };
      if (!stopping) {
        lastError = result.error;
        if (result.ok) lastDeliveredAt = now();
      }
      return result;
    })().catch((error: unknown): TelegramProbeResult => {
      const result = { ok: false, error: errorReason(error) };
      if (!stopping) lastError = result.error;
      return result;
    });
    probePromises.add(promise);
    void promise.finally(() => {
      probes.delete(controller);
      probePromises.delete(promise);
    });
    return promise;
  };

  return {
    stop,
    probe,
    status() {
      return { connected: true, lastError, lastDeliveredAt };
    },
  };
}
