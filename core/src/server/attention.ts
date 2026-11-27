import type { FinishReason, RunFile } from '../types.js';

export type AttentionIntent = { key: string; runId: string; kind: 'wait' | 'stopped'; reasonCode: string };

export const NOTIFY_STOP_REASONS: FinishReason[] = ['stage_failed', 'start_failed', 'plan_invalid', 'no_checks', 'checks_red'];

export function attentionIntent(run: RunFile): AttentionIntent | null {
  if (run.autopilot) return null;
  if (run.status === 'waiting') {
    if (!run.waitId || run.waitDecided || !['gate0', 'gate1', 'gate2', 'limit'].includes(run.next)) return null;
    const reasonCode = run.next === 'limit' ? (run.stuck ? 'limit_loop' : 'limit_attempts') : run.next;
    return { key: `wait:${run.id}:${run.waitId}`, runId: run.id, kind: 'wait', reasonCode };
  }
  if (run.status === 'stopped' && run.stop && NOTIFY_STOP_REASONS.includes(run.stop.reason)) {
    return { key: `stopped:${run.id}:${run.stop.id}`, runId: run.id, kind: 'stopped', reasonCode: run.stop.reason };
  }
  return null;
}
