import { ShuttingDownError } from '../kernel.js';
import { Orchestrator } from '../orchestrator.js';
import { killAll, spawnScope } from '../proc.js';
import type { CoreOptions } from '../runtime.js';
import { trace } from '../trace.js';
import { decideExpected, type ExpectedCommand } from './decisions.js';
import { stopActive } from './stop.js';

export const ACCEPTED_METHODS = [
  'dispatch',
  'startPreview',
  'askManager',
  'resolveManagerAction',
  'compactChat',
  'sendChat',
  'allowChatMcp',
  'grantChatFullAccess',
  'answerChatPermission',
  'chatToTask',
] as const;

export type ServerCore = Orchestrator & {
  shutdown(): Promise<void>;
  decideExpected(runId: string, expectedWaitId: string, command: ExpectedCommand): Promise<{ ok: true } | { ok: false; conflict: true }>;
  stopActive(runId: string): Promise<{ ok: true } | { ok: false; conflict: true }>;
};

export function createServerCore(opts: CoreOptions): ServerCore {
  const scope = { stopped: false };
  let pending = 0;
  let stopping: Promise<void> | undefined;
  const orchestrator = spawnScope.run(scope, () => new Orchestrator(opts));

  const accepted = <T>(fn: () => T | Promise<T>): Promise<T> =>
    spawnScope.run(scope, async () => {
      const k = orchestrator.kernel;
      if (k.closing) throw new ShuttingDownError();
      pending++;
      try {
        const result = await fn();
        if (k.closing) throw new ShuttingDownError();
        return result;
      } catch (error) {
        if (k.closing) throw new ShuttingDownError();
        throw error;
      } finally {
        pending--;
      }
    });

  const shutdown = (): Promise<void> => {
    if (stopping) return stopping;
    const k = orchestrator.kernel;
    k.closing = true;
    scope.stopped = true;
    for (const run of k.store.list()) k.cancelBackground(run.id);
    k.previewLaunches.clear();
    stopping = (async () => {
      await killAll();
      const busy = () => pending > 0 || k.driving.size > 0 || k.preparing.size > 0 || k.chatBusy.size > 0 || k.managerBusy.size > 0;
      let rounds = 0;
      while (busy() && rounds < 100) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        await killAll();
        rounds++;
      }
      if (busy()) trace('shutdown', new Error('Принятые вызовы не завершились за 100 кругов остановки'));
      await killAll();
    })();
    return stopping;
  };

  return new Proxy(orchestrator, {
    get(target, prop) {
      if (prop === 'shutdown') return shutdown;
      if (prop === 'decideExpected')
        return (runId: string, expectedWaitId: string, command: ExpectedCommand) =>
          accepted(() => decideExpected(orchestrator.kernel, runId, expectedWaitId, command));
      if (prop === 'stopActive') return (runId: string) => accepted(() => stopActive(orchestrator.kernel, runId));
      const value: unknown = Reflect.get(target, prop);
      if (typeof value !== 'function' || prop === 'constructor') return value;
      return (...args: unknown[]) => {
        const call = () => {
          const cmd = args[0] as { type?: string; runId?: string } | undefined;
          if (prop === 'dispatch' && cmd?.runId && /^gate\.(approve|reject|cancel|accept|fix|answer)$/.test(cmd.type ?? ''))
            return orchestrator.kernel.withRunLock(cmd.runId, async () => {
              if (orchestrator.kernel.closing) throw new ShuttingDownError();
              if (orchestrator.kernel.store.load(cmd.runId!)?.waitDecided) throw new Error('Решение по этому ожиданию уже принято');
              return value.apply(orchestrator, args) as unknown;
            });
          if (prop === 'dispatch' && cmd?.type === 'run.stop' && cmd.runId)
            return orchestrator.kernel.withRunLock(cmd.runId, async () => {
              if (orchestrator.kernel.closing) throw new ShuttingDownError();
              return value.apply(orchestrator, args) as unknown;
            });
          return value.apply(orchestrator, args) as unknown;
        };
        return (ACCEPTED_METHODS as readonly PropertyKey[]).includes(prop) ? accepted(call) : spawnScope.run(scope, call);
      };
    },
  }) as ServerCore;
}
