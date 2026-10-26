import { closeAndroidSyncLedgerForTests } from './syncAndroidMutationLedger';
import { closeSyncBootstrapStateDatabaseForTests } from './syncBootstrapState';
import { closeCurrentSyncDeviceDatabaseForTests } from './syncCurrentDevice';
import { closeAndroidCurrentStateRefreshDatabase } from './syncCurrentStateRefreshAndroid';
import { closeAndroidFiniteDeletionDatabase } from './syncFiniteDeletionMaintenance';
import { closeSyncMutationStateDatabaseForTests } from './syncMutationStateStore';
import { closeExpoSyncWorldV2Database } from './syncNewWorldBaselineExpoStore';
import { closeSyncObjectJobDatabaseForTests } from './syncObjectJobStore';
import { closeAndroidSyncReceiveDatabaseForTests } from './syncReceiveStore';
import { closeSyncDatabaseForTests } from './syncStore';

export async function closeAllActiveSyncWorldDatabases() {
  const closers = [
    closeAndroidSyncLedgerForTests,
    closeSyncBootstrapStateDatabaseForTests,
    closeCurrentSyncDeviceDatabaseForTests,
    closeAndroidCurrentStateRefreshDatabase,
    closeAndroidFiniteDeletionDatabase,
    closeSyncMutationStateDatabaseForTests,
    closeExpoSyncWorldV2Database,
    closeSyncObjectJobDatabaseForTests,
    closeAndroidSyncReceiveDatabaseForTests,
    closeSyncDatabaseForTests,
  ];
  const errors: unknown[] = [];
  for (const close of closers) {
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new Error(
      `无法关闭全部同步数据库连接（${errors.length} 个连接失败）。`,
      { cause: errors[0] },
    );
  }
}
