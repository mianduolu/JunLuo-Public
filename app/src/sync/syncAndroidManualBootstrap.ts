import {
  androidSyncLedgerSnapshot,
} from './syncAndroidMutationLedger';
import {
  enqueueAndroidExplicitSyncOperation,
} from './syncAndroidExplicitOperationQueue';
import {
  loadCurrentSyncRelayEnrollment,
} from './syncRelayClientExpo';
import {
  initializeSyncStore,
  type SyncStoreStartupRecovery,
} from './syncStore';
import {
  runWithTransientSqliteLockRetry,
} from './syncSqliteLockRetry';

export type AndroidManualBootstrapResult = {
  state: 'prepared';
  startedAt: number;
  completedAt: number;
  automaticSyncEnabled: false;
  startupRecovery: SyncStoreStartupRecovery;
  sync: Awaited<ReturnType<typeof androidSyncLedgerSnapshot>>;
};

export class AndroidManualBootstrapController {
  constructor(
    private readonly now: () => number = Date.now,
  ) {}

  runOnce() {
    return enqueueAndroidExplicitSyncOperation(
      async (): Promise<AndroidManualBootstrapResult> => {
        const enrollment = await loadCurrentSyncRelayEnrollment();
        if (!enrollment) {
          throw new Error(
            'Android 当前没有 active 设备身份，不能准备历史同步数据。',
          );
        }
        const startedAt = this.now();
        const startupRecovery = await runWithTransientSqliteLockRetry(
          () => initializeSyncStore(startedAt),
        );
        return {
          state: 'prepared',
          startedAt,
          completedAt: this.now(),
          automaticSyncEnabled: false,
          startupRecovery,
          sync: await runWithTransientSqliteLockRetry(
            () => androidSyncLedgerSnapshot(),
          ),
        };
      },
    );
  }
}

export function createAndroidManualBootstrapController(input?: {
  now?: () => number;
}) {
  return new AndroidManualBootstrapController(input?.now);
}
