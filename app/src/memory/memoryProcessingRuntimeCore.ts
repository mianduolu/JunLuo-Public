import type { MemoryProcessingWakeReason } from './memoryProcessingSignals';

export type MemoryProcessingRuntimeWakeReason =
  | MemoryProcessingWakeReason
  | 'reconcile_pending';

export type MemoryProcessingBatchMode = 'jobs' | 'reconcile';

export type MemoryProcessingRunResult = {
  dueRemaining: number;
  nextReconcileDelayMs: number;
  processed: number;
  reconcilePending: boolean;
  nextWeeklyRefreshDelayMs?: number;
};

export const MEMORY_PROCESSING_JOB_COOLDOWN_MS = 30_000;

export function memoryProcessingBatchModeForReason(
  reason: MemoryProcessingRuntimeWakeReason,
): MemoryProcessingBatchMode {
  return reason === 'reconcile_pending' ? 'reconcile' : 'jobs';
}

export function shouldReplaceQueuedMemoryProcessingReason(
  current: MemoryProcessingRuntimeWakeReason | null,
  next: MemoryProcessingRuntimeWakeReason,
) {
  if (current === null) return true;
  if (next === 'configuration_changed' || next === 'manual_retry') return true;
  return current === 'reconcile_pending' && next !== 'reconcile_pending';
}

export function nextMemoryProcessingRun(result: MemoryProcessingRunResult): {
  delayMs: number;
  reason: MemoryProcessingRuntimeWakeReason;
} | null {
  if (result.dueRemaining > 0) {
    return { delayMs: MEMORY_PROCESSING_JOB_COOLDOWN_MS, reason: 'memory_changed' };
  }
  if (result.nextWeeklyRefreshDelayMs !== undefined && (!result.reconcilePending
    || result.nextWeeklyRefreshDelayMs <= result.nextReconcileDelayMs)) {
    return { delayMs: Math.max(MEMORY_PROCESSING_JOB_COOLDOWN_MS, result.nextWeeklyRefreshDelayMs), reason: 'memory_changed' };
  }
  if (!result.reconcilePending) return null;
  return {
    delayMs: result.processed > 0
      ? MEMORY_PROCESSING_JOB_COOLDOWN_MS
      : result.nextReconcileDelayMs,
    reason: 'reconcile_pending',
  };
}

export function deferQueuedMemoryProcessingAfterJob(
  queuedAt: number | null,
  now: number,
) {
  const notBefore = now + MEMORY_PROCESSING_JOB_COOLDOWN_MS;
  return queuedAt === null ? notBefore : Math.max(queuedAt, notBefore);
}
