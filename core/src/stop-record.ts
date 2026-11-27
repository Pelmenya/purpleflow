import crypto from 'node:crypto';
import type { FinishReason, StopRecord } from './types.js';

export function stopRecord(reason: FinishReason): StopRecord {
  return { reason, at: new Date().toISOString(), id: crypto.randomUUID() };
}
