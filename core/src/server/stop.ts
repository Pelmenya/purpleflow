import { stop } from '../engine.js';
import { ShuttingDownError, type Kernel } from '../kernel.js';
import { killGroup } from '../proc.js';
import type { FinishReason } from '../types.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function stopActive(k: Kernel, runId: string): Promise<{ ok: true } | { ok: false; conflict: true }> {
  return k.withRunLock(runId, async () => {
    if (k.closing) throw new ShuttingDownError();
    const initial = k.store.load(runId);
    if (!initial || (initial.status !== 'running' && initial.status !== 'queued')) return { ok: false, conflict: true };
    let reason: FinishReason | undefined;
    const off = k.on((event) => {
      if (event.type === 'run.finished' && event.runId === runId) reason = event.reason;
    });
    try {
      await stop(k, runId);
      for (let i = 0; i < 100 && (k.driving.has(runId) || k.preparing.has(runId)); i++) {
        if (k.preparing.has(runId)) await killGroup(runId);
        await sleep(100);
      }
      const current = k.store.load(runId);
      const expected = initial.status === 'queued' ? 'unqueued' : 'user_stop';
      return current?.status === 'stopped' && reason === expected ? { ok: true } : { ok: false, conflict: true };
    } finally {
      off();
    }
  });
}
