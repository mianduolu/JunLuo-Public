import { useEffect } from 'react';

import {
  captureBackupRestoreDataEpoch,
  subscribeBackupRestoreRuntimeState,
} from '../backup/backupRestoreCoordinator';
import {
  markLocalToolExecutionAttemptsStale,
  scanLocalToolExecutionAttempts,
} from './toolExecutionAttemptStore';

export function useToolExecutionAttemptRecoveryRuntime(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return undefined;
    const dataEpoch = captureBackupRestoreDataEpoch();
    if (dataEpoch !== null) {
      void scanLocalToolExecutionAttempts(dataEpoch).catch(() => undefined);
    }
    return subscribeBackupRestoreRuntimeState((state) => {
      if (state.status === 'restoring') {
        void markLocalToolExecutionAttemptsStale().catch(() => undefined);
      }
    });
  }, [enabled]);
}
