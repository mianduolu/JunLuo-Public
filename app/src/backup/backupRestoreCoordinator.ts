export type BackupRestoreRuntimeState =
  | { status: 'ready' }
  | { status: 'restoring'; detail: string }
  | { status: 'restart-required'; detail: string }
  | { status: 'recovery-blocked'; detail: string };

type RuntimeStateListener = (state: BackupRestoreRuntimeState) => void;

export type BackupRestoreDataEpochCommitResult<T> =
  | { committed: false }
  | { committed: true; value: T };

function errorDetail(error: unknown) {
  return error instanceof Error ? error.message : '无法恢复到导入前状态。';
}

export function createBackupRestoreCoordinator() {
  let activeShared = 0;
  let exclusiveActive = false;
  const scheduledQueue: Array<{
    kind: 'exclusive' | 'shared';
    start: () => void;
  }> = [];
  let recoveryFlight: Promise<boolean> | null = null;
  let runtimeState: BackupRestoreRuntimeState = { status: 'ready' };
  let dataEpoch = 0;
  const runtimeStateListeners = new Set<RuntimeStateListener>();

  const publishRuntimeState = (state: BackupRestoreRuntimeState) => {
    runtimeState = state;
    for (const listener of runtimeStateListeners) listener(state);
  };

  const pumpScheduledQueue = () => {
    if (exclusiveActive) return;
    if (activeShared > 0) {
      while (scheduledQueue[0]?.kind === 'shared') scheduledQueue.shift()?.start();
      return;
    }
    if (scheduledQueue[0]?.kind === 'exclusive') {
      scheduledQueue.shift()?.start();
      return;
    }
    while (scheduledQueue[0]?.kind === 'shared') scheduledQueue.shift()?.start();
  };

  const schedule = <T>(
    kind: 'exclusive' | 'shared',
    work: () => Promise<T>,
    joinActiveShared = false,
  ): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
      const scheduled = {
        kind,
        start: () => {
          if (kind === 'exclusive') exclusiveActive = true;
          else activeShared += 1;
          void (async () => {
            try {
              resolve(await work());
            } catch (error) {
              reject(error);
            } finally {
              if (kind === 'exclusive') exclusiveActive = false;
              else activeShared -= 1;
              pumpScheduledQueue();
            }
          })();
        },
      };
      if (joinActiveShared && kind === 'shared' && activeShared > 0 && !exclusiveActive) {
        scheduled.start();
        return;
      }
      scheduledQueue.push(scheduled);
      pumpScheduledQueue();
    });
  };

  const runExclusive = <T>(work: () => Promise<T>) => (
    schedule('exclusive', work)
  );

  const runShared = <T>(work: () => Promise<T>) => (
    schedule('shared', work)
  );

  const runRecoverySingleFlight = (work: () => Promise<boolean>) => {
    if (recoveryFlight) return recoveryFlight;
    const shared = runExclusive(async () => {
      try {
        const recovered = await work();
        if (recovered) {
          publishRuntimeState({
            status: 'restart-required',
            detail: '君落已恢复到导入前状态，需要重新打开后再继续。',
          });
        } else if (runtimeState.status === 'recovery-blocked') {
          publishRuntimeState({ status: 'ready' });
        }
        return recovered;
      } catch (error) {
        publishRuntimeState({ status: 'recovery-blocked', detail: errorDetail(error) });
        throw error;
      }
    }).finally(() => {
      if (recoveryFlight === shared) recoveryFlight = null;
    });
    recoveryFlight = shared;
    return shared;
  };

  const captureDataEpoch = () => runtimeState.status === 'ready' ? dataEpoch : null;
  const canCommitDataEpoch = (epoch: number | null) => (
    epoch !== null && runtimeState.status === 'ready' && epoch === dataEpoch
  );
  const runDataEpochCommit = <T>(
    epoch: number | null,
    work: () => Promise<T>,
  ): Promise<BackupRestoreDataEpochCommitResult<T>> => schedule('shared', async () => {
    if (!canCommitDataEpoch(epoch)) return { committed: false };
    return { committed: true, value: await work() };
  }, true);

  return {
    getRuntimeState: () => runtimeState,
    captureDataEpoch,
    canCommitDataEpoch,
    markRestoring: (detail = '正在安全切换备份数据，请稍候。') => {
      dataEpoch += 1;
      publishRuntimeState({ status: 'restoring', detail });
    },
    markRecoveryBlocked: (error: unknown) => {
      publishRuntimeState({ status: 'recovery-blocked', detail: errorDetail(error) });
    },
    markRestartRequired: (detail = '数据已经处理完成，需要重新打开君落。') => {
      publishRuntimeState({ status: 'restart-required', detail });
    },
    markRuntimeReady: () => {
      publishRuntimeState({ status: 'ready' });
    },
    runExclusive,
    runShared,
    runDataEpochCommit,
    runRecoverySingleFlight,
    subscribeRuntimeState: (listener: RuntimeStateListener) => {
      runtimeStateListeners.add(listener);
      return () => {
        runtimeStateListeners.delete(listener);
      };
    },
  };
}

const sharedCoordinator = createBackupRestoreCoordinator();

export const getBackupRestoreRuntimeState = sharedCoordinator.getRuntimeState;
export const captureBackupRestoreDataEpoch = sharedCoordinator.captureDataEpoch;
export const canCommitBackupRestoreDataEpoch = sharedCoordinator.canCommitDataEpoch;
export const markBackupRestoreRestoring = sharedCoordinator.markRestoring;
export const markBackupRestoreRecoveryBlocked = sharedCoordinator.markRecoveryBlocked;
export const markBackupRestoreRestartRequired = sharedCoordinator.markRestartRequired;
export const markBackupRestoreRuntimeReady = sharedCoordinator.markRuntimeReady;
export const runBackupRestoreExclusive = sharedCoordinator.runExclusive;
export const runBackupRestoreShared = sharedCoordinator.runShared;
export const runBackupRestoreDataEpochCommit = sharedCoordinator.runDataEpochCommit;
export const runBackupRestoreRecoverySingleFlight = sharedCoordinator.runRecoverySingleFlight;
export const subscribeBackupRestoreRuntimeState = sharedCoordinator.subscribeRuntimeState;
