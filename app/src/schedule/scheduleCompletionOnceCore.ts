import type { PhonePrimaryInternalExecutor } from '../runtime/phonePrimaryInternalExecution';
import {
  createSyncExecutionOperationId,
} from '../sync/syncExecutionOperationId';
import type {
  SyncExecutionOnceCoordinatorV2,
} from '../sync/syncExecutionOnceV2Controller';

export type ScheduleOccurrenceCompletionResult = {
  changed: boolean;
  notificationIds: string[];
  executedNow: boolean;
};

type ScheduleOccurrenceCompletionState = {
  id: string;
  itemId: string;
  completionRound?: number;
  status: 'pending' | 'completed' | 'cancelled';
};

export type ScheduleOccurrenceCompletionOncePorts = {
  applyCompletionReceipt(
    occurrenceId: string,
    completedAt: number,
    expectedRound: number,
  ): Promise<{ changed: boolean; notificationIds: string[] }>;
  completeLocally(
    occurrenceId: string,
    expectedRound: number,
  ): Promise<{ changed: boolean; notificationIds: string[] }>;
  createCoordinator(
    baseUrl: string,
  ): Promise<Pick<SyncExecutionOnceCoordinatorV2, 'execute'>>;
  loadItemCreatedAt(itemId: string): Promise<number | null>;
  loadOccurrence(
    occurrenceId: string,
  ): Promise<ScheduleOccurrenceCompletionState | null>;
  loadRelayBaseUrl(): Promise<string>;
  syncEnrollmentReady: boolean;
  phonePrimaryExecute?: PhonePrimaryInternalExecutor;
};

export async function runScheduleOccurrenceCompletionOnce(
  occurrenceId: string,
  ports: ScheduleOccurrenceCompletionOncePorts,
): Promise<ScheduleOccurrenceCompletionResult> {
  const occurrence = await ports.loadOccurrence(occurrenceId);
  if (!occurrence) throw new Error('schedule-occurrence-not-found');
  if (occurrence.status === 'cancelled') {
    throw new Error('schedule-occurrence-cancelled');
  }
  if (occurrence.status === 'completed') {
    return { changed: false, notificationIds: [], executedNow: false };
  }
  const round = occurrence.completionRound ?? 0;
  const loadCurrent = async () => {
    const current = await ports.loadOccurrence(occurrenceId);
    if (!current || (current.completionRound ?? 0) !== round) {
      throw new Error('schedule-completion-source-changed');
    }
    return current;
  };

  if (!ports.syncEnrollmentReady && !ports.phonePrimaryExecute) {
    const local = await ports.completeLocally(occurrenceId, round);
    if ((await loadCurrent()).status !== 'completed') {
      throw new Error('schedule-completion-needs-reconciliation');
    }
    return { ...local, executedNow: local.changed };
  }

  const createdAt = await ports.loadItemCreatedAt(occurrence.itemId);
  if (createdAt === null) throw new Error('schedule-item-not-found');
  const executeOnce = ports.phonePrimaryExecute ?? (async (input) => {
    const baseUrl = (await ports.loadRelayBaseUrl()).trim();
    if (!baseUrl) throw new Error('sync-relay-not-configured');
    return (await ports.createCoordinator(baseUrl)).execute(input);
  });
  let localResult: { changed: boolean; notificationIds: string[] } | null = null;
  const result = await executeOnce({
    operationId: createSyncExecutionOperationId({
      category: 'reminder',
      scope: 'schedule.occurrence',
      entityId: occurrence.id,
      action: `complete:v2:${round}`,
    }),
    category: 'reminder',
    createdAt,
    reconcile: async () => {
      const current = await loadCurrent();
      if (current.status === 'completed') return 'completed';
      if (current.status === 'cancelled') return 'cancelled';
      return null;
    },
    execute: async () => {
      const current = await loadCurrent();
      if (current.status === 'cancelled') return 'cancelled';
      localResult = await ports.completeLocally(occurrence.id, round);
      return (await loadCurrent()).status === 'completed' ? 'completed' : 'failed';
    },
  });
  const current = await loadCurrent();

  if (result.state === 'deferred') {
    throw new Error('schedule-completion-owned-by-another-device');
  }
  if (result.state === 'reconciliation-required') {
    throw new Error('schedule-completion-needs-reconciliation');
  }
  if (result.outcome !== 'completed') {
    throw new Error('schedule-completion-failed');
  }
  const completedLocally = localResult as {
    changed: boolean;
    notificationIds: string[];
  } | null;
  if (completedLocally) {
    if (current.status !== 'completed') throw new Error('schedule-completion-needs-reconciliation');
    return { ...completedLocally, executedNow: completedLocally.changed };
  }
  const applied = await ports.applyCompletionReceipt(
    occurrence.id,
    result.completedAt,
    round,
  );
  if ((await loadCurrent()).status !== 'completed') {
    throw new Error('schedule-completion-needs-reconciliation');
  }
  return { ...applied, executedNow: false };
}
