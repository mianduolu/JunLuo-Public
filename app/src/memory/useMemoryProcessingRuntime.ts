import { useEffect } from 'react';
import { AppState, InteractionManager } from 'react-native';

import { isChatReplyInFlight } from '../ai/aiRuntimeScheduler';
import {
  getBackupRestoreRuntimeState,
  subscribeBackupRestoreRuntimeState,
} from '../backup/backupRestoreCoordinator';
import { subscribeMemoryProcessingWorkAvailable } from './memoryProcessingSignals';
import {
  requestMemoryProcessingReconcile,
  resumeBlockedMemoryProcessingJobs,
  runMemoryProcessingBatch,
  setMemoryProcessingForegroundActive,
} from './memoryProcessingWorker';
import { MEMORY_RECONCILE_START_DELAY_MS } from './memoryProcessingReconcileCore';
import {
  deferQueuedMemoryProcessingAfterJob,
  MEMORY_PROCESSING_JOB_COOLDOWN_MS,
  memoryProcessingBatchModeForReason,
  nextMemoryProcessingRun,
  shouldReplaceQueuedMemoryProcessingReason,
  type MemoryProcessingRuntimeWakeReason,
} from './memoryProcessingRuntimeCore';

const RECONCILE_RETRY_DELAY_MS = 5_000;
type RuntimeWakeReason = MemoryProcessingRuntimeWakeReason;

export function useMemoryProcessingRuntime(enabled = true) {
  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    let running = false;
    let queuedReason: RuntimeWakeReason | null = null;
    let queuedAt: number | null = null;
    let scheduledAt: number | null = null;
    let restoreWasUnavailable = false;
    let restoreReady = getBackupRestoreRuntimeState().status === 'ready';
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let interaction: ReturnType<typeof InteractionManager.runAfterInteractions> | null = null;

    const clearScheduled = () => {
      if (timeout) clearTimeout(timeout);
      timeout = null;
      scheduledAt = null;
      interaction?.cancel();
      interaction = null;
    };

    const schedule = (reason: RuntimeWakeReason, delayMs = 0) => {
      if (!alive || !restoreReady || AppState.currentState !== 'active') return;
      const dueAt = Date.now() + Math.max(0, delayMs);
      if (shouldReplaceQueuedMemoryProcessingReason(queuedReason, reason)) {
        queuedReason = reason;
      }
      queuedAt = queuedAt === null ? dueAt : Math.min(queuedAt, dueAt);
      if (running || interaction) return;
      if (timeout && scheduledAt !== null && scheduledAt <= queuedAt) return;
      if (timeout) clearScheduled();
      const waitMs = Math.max(0, (queuedAt ?? dueAt) - Date.now());
      scheduledAt = Date.now() + waitMs;
      timeout = setTimeout(() => {
        timeout = null;
        scheduledAt = null;
        if (!alive || !restoreReady || AppState.currentState !== 'active') return;
        interaction = InteractionManager.runAfterInteractions(() => {
          interaction = null;
          if (!alive || !restoreReady || running || AppState.currentState !== 'active') return;
          if (isChatReplyInFlight()) {
            // Keep the wake reason, but advance its due time before schedule takes the minimum.
            queuedAt = Date.now() + RECONCILE_RETRY_DELAY_MS;
            schedule(queuedReason ?? reason, RECONCILE_RETRY_DELAY_MS);
            return;
          }
          const activeReason = queuedReason ?? reason;
          queuedReason = null;
          queuedAt = null;
          running = true;
          void (async () => {
            const batchMode = memoryProcessingBatchModeForReason(activeReason);
            try {
              if (activeReason === 'configuration_changed') {
                await resumeBlockedMemoryProcessingJobs();
                requestMemoryProcessingReconcile('configuration_changed');
              } else if (activeReason === 'manual_retry') {
                requestMemoryProcessingReconcile('manual_retry');
              }
              const result = await runMemoryProcessingBatch({
                mode: batchMode,
              });
              const nextRun = nextMemoryProcessingRun(result);
              if (nextRun) {
                schedule(nextRun.reason, nextRun.delayMs);
              }
              if (result.processed > 0 && queuedAt !== null) {
                queuedAt = deferQueuedMemoryProcessingAfterJob(queuedAt, Date.now());
              }
            } catch {
              if (batchMode === 'jobs') {
                schedule('memory_changed', MEMORY_PROCESSING_JOB_COOLDOWN_MS);
                if (queuedAt !== null) {
                  queuedAt = deferQueuedMemoryProcessingAfterJob(queuedAt, Date.now());
                }
              } else {
                schedule('reconcile_pending', RECONCILE_RETRY_DELAY_MS);
              }
            } finally {
              running = false;
              if (queuedReason) {
                schedule(queuedReason, Math.max(0, (queuedAt ?? Date.now()) - Date.now()));
              }
            }
          })();
        });
      }, waitMs);
    };

    const unsubscribeWork = subscribeMemoryProcessingWorkAvailable((reason) => {
      schedule(reason);
    });
    const unsubscribeRestore = subscribeBackupRestoreRuntimeState((state) => {
      if (state.status !== 'ready') {
        restoreReady = false;
        restoreWasUnavailable = true;
        setMemoryProcessingForegroundActive(false);
        clearScheduled();
        queuedReason = null;
        queuedAt = null;
        return;
      }
      restoreReady = true;
      setMemoryProcessingForegroundActive(AppState.currentState === 'active');
      if (restoreWasUnavailable) {
        restoreWasUnavailable = false;
        requestMemoryProcessingReconcile('restore_completed');
      }
      schedule('app_resumed');
    });
    const appStateSubscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        setMemoryProcessingForegroundActive(true);
        schedule('app_resumed');
      } else {
        setMemoryProcessingForegroundActive(false);
        clearScheduled();
        if (queuedReason !== 'configuration_changed' && queuedReason !== 'manual_retry') {
          queuedReason = null;
        }
        queuedAt = null;
      }
    });

    setMemoryProcessingForegroundActive(AppState.currentState === 'active');
    requestMemoryProcessingReconcile('app_started', {
      notBeforeMs: MEMORY_RECONCILE_START_DELAY_MS,
    });
    schedule('app_started');
    return () => {
      alive = false;
      setMemoryProcessingForegroundActive(false);
      clearScheduled();
      unsubscribeWork();
      unsubscribeRestore();
      appStateSubscription.remove();
    };
  }, [enabled]);
}
