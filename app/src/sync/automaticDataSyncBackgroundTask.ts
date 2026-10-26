import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';

import {
  loadMemoryDuplicateCleanupJournal,
  memoryDuplicateCleanupNeedsOneTimeDrain,
} from '../memory/memoryDuplicateCleanupState';
import { loadAutomaticDataSyncPolicy } from './automaticDataSyncPolicy';
import { runAndroidAutomaticDataSyncCheck } from './automaticDataSyncRuntime';

export const JUNLUO_DATA_SYNC_TASK_NAME = 'junluo-data-sync-v1';
const MINIMUM_BACKGROUND_INTERVAL_MINUTES = 15;

if (!TaskManager.isTaskDefined(JUNLUO_DATA_SYNC_TASK_NAME)) {
  TaskManager.defineTask(JUNLUO_DATA_SYNC_TASK_NAME, async () => {
    try {
      const [policy, cleanup] = await Promise.all([
        loadAutomaticDataSyncPolicy(),
        loadMemoryDuplicateCleanupJournal(),
      ]);
      if (!policy.enabled && !memoryDuplicateCleanupNeedsOneTimeDrain(cleanup)) {
        return BackgroundTask.BackgroundTaskResult.Success;
      }
      await runAndroidAutomaticDataSyncCheck({
        source: 'background',
        allowFullSync: true,
      });
      return BackgroundTask.BackgroundTaskResult.Success;
    } catch {
      return BackgroundTask.BackgroundTaskResult.Failed;
    }
  });
}

export async function registerAutomaticDataSyncBackgroundTask() {
  if (__DEV__) {
    await unregisterAutomaticDataSyncBackgroundTask();
    return false;
  }
  const [policy, cleanup] = await Promise.all([
    loadAutomaticDataSyncPolicy(),
    loadMemoryDuplicateCleanupJournal(),
  ]);
  if (!policy.enabled && !memoryDuplicateCleanupNeedsOneTimeDrain(cleanup)) {
    return false;
  }
  const available = await TaskManager.isAvailableAsync().catch(() => false);
  if (!available) return false;
  const status = await BackgroundTask.getStatusAsync().catch(() => null);
  if (status !== BackgroundTask.BackgroundTaskStatus.Available) return false;
  await BackgroundTask.registerTaskAsync(JUNLUO_DATA_SYNC_TASK_NAME, {
    minimumInterval: MINIMUM_BACKGROUND_INTERVAL_MINUTES,
  });
  return true;
}

export async function unregisterAutomaticDataSyncBackgroundTask() {
  const registered = await TaskManager.isTaskRegisteredAsync(
    JUNLUO_DATA_SYNC_TASK_NAME,
  ).catch(() => false);
  if (registered) {
    await BackgroundTask.unregisterTaskAsync(JUNLUO_DATA_SYNC_TASK_NAME);
  }
}
