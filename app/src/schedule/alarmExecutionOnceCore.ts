import {
  createSyncExecutionOperationId,
} from '../sync/syncExecutionOperationId';
import type {
  SyncExecutionOutcomeV2,
} from '../sync/syncExecutionClaimV2Protocol';
import type {
  SyncExecutionOnceCoordinatorV2,
} from '../sync/syncExecutionOnceV2Controller';

export type AlarmExecutionState = {
  id: string;
  createdAt: number;
  updatedAt: number;
  status: 'pending' | 'delivered' | 'cancelled';
  soundMode: 'notification' | 'music' | 'strong';
  musicPlayStatus?: 'pending' | 'played' | 'failed' | 'skipped';
};

export type AlarmHandlingOnceResult = {
  outcome: SyncExecutionOutcomeV2;
  executedNow: boolean;
  completedAt: number;
};

export type AlarmHandlingOncePorts = {
  applyReceipt(
    alarmId: string,
    outcome: SyncExecutionOutcomeV2,
    completedAt: number,
  ): Promise<void>;
  createCoordinator(
    baseUrl: string,
  ): Promise<Pick<SyncExecutionOnceCoordinatorV2, 'execute'>>;
  executeLocally(): Promise<SyncExecutionOutcomeV2>;
  loadAlarm(alarmId: string): Promise<AlarmExecutionState | null>;
  loadRelayBaseUrl(): Promise<string>;
  syncEnrollmentReady: boolean;
};

export function alarmOutcomeFromState(
  alarm: AlarmExecutionState | null,
): SyncExecutionOutcomeV2 | null {
  if (!alarm || alarm.status === 'pending') return null;
  if (alarm.status === 'cancelled') return 'cancelled';
  if (
    alarm.soundMode === 'music'
    && alarm.musicPlayStatus === 'failed'
  ) {
    return 'failed';
  }
  return 'completed';
}

export async function runAlarmHandlingOnce(
  alarmId: string,
  ports: AlarmHandlingOncePorts,
): Promise<AlarmHandlingOnceResult> {
  const alarm = await ports.loadAlarm(alarmId);
  if (!alarm) throw new Error('alarm-not-found');
  const existingOutcome = alarmOutcomeFromState(alarm);
  if (existingOutcome) {
    await ports.applyReceipt(
      alarm.id,
      existingOutcome,
      alarm.updatedAt,
    );
    return {
      outcome: existingOutcome,
      executedNow: false,
      completedAt: alarm.updatedAt,
    };
  }

  if (!ports.syncEnrollmentReady) {
    const outcome = await ports.executeLocally();
    const current = await ports.loadAlarm(alarm.id);
    return {
      outcome,
      executedNow: true,
      completedAt: current?.updatedAt ?? alarm.updatedAt,
    };
  }

  const baseUrl = (await ports.loadRelayBaseUrl()).trim();
  if (!baseUrl) throw new Error('sync-relay-not-configured');
  const coordinator = await ports.createCoordinator(baseUrl);
  let executedNow = false;
  const result = await coordinator.execute({
    operationId: createSyncExecutionOperationId({
      category: 'alarm',
      scope: 'schedule.alarm',
      entityId: alarm.id,
      action: 'handle:v1',
    }),
    category: 'alarm',
    createdAt: alarm.createdAt,
    reconcile: async () => alarmOutcomeFromState(
      await ports.loadAlarm(alarm.id),
    ),
    execute: async () => {
      executedNow = true;
      return ports.executeLocally();
    },
  });

  if (result.state === 'deferred') {
    throw new Error('alarm-handling-owned-by-another-device');
  }
  if (result.state === 'reconciliation-required') {
    throw new Error('alarm-handling-needs-reconciliation');
  }
  await ports.applyReceipt(
    alarm.id,
    result.outcome,
    result.completedAt,
  );
  return {
    outcome: result.outcome,
    executedNow,
    completedAt: result.completedAt,
  };
}
