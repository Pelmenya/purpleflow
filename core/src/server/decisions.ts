import { decide } from '../gates.js';
import { ShuttingDownError, type Kernel } from '../kernel.js';
import { isGate } from '../stage-info.js';
import { answer } from '../stages/plan.js';

export type ExpectedCommand =
  | { action: 'answer'; answers: { q: string; a: string }[] }
  | { action: 'skip' }
  | { action: 'approve'; comment?: string }
  | { action: 'reject'; comment: string }
  | { action: 'cancel' };

export type ExpectedDecision = ExpectedCommand & { expectedWaitId: string };

export async function decideExpected(
  k: Kernel,
  runId: string,
  expectedWaitId: string,
  command: ExpectedCommand,
): Promise<{ ok: true } | { ok: false; conflict: true }> {
  return k.withRunLock(runId, async () => {
    if (k.closing) throw new ShuttingDownError();
    const run = k.store.load(runId);
    if (!run) throw new Error('Прогон не найден');
    if (!isGate(run.next) || (run.status !== 'waiting' && run.status !== 'stopped') || run.waitId !== expectedWaitId || run.waitDecided)
      return { ok: false, conflict: true };
    if (k.closing) throw new ShuttingDownError();
    if (command.action === 'answer') await answer(k, runId, command.answers);
    else if (command.action === 'skip') await decide(k, runId, 'approve');
    else await decide(k, runId, command.action, 'comment' in command ? command.comment : undefined);
    return { ok: true };
  });
}
