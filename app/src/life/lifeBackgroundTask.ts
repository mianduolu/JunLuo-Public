import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';

import { runBackupProtectedTask } from '../backup/backupService';
import { loadEmergencySyncWorldRebuildSnapshot } from '../sync/syncEmergencyWorldRebuildStore';
import { runLifeTickFromStoredConfig } from './lifeEngine';

export const JUNLUO_LIFE_TASK_NAME = 'junluo-life-tick';
const MINIMUM_BACKGROUND_INTERVAL_MINUTES = 60;

if (!TaskManager.isTaskDefined(JUNLUO_LIFE_TASK_NAME)) {
  TaskManager.defineTask(JUNLUO_LIFE_TASK_NAME, async () => {
    try {
      const rebuild = await loadEmergencySyncWorldRebuildSnapshot();
      if (rebuild.active) {
        return BackgroundTask.BackgroundTaskResult.Success;
      }
      await runBackupProtectedTask(
        () => runLifeTickFromStoredConfig({ backupRestoreLeaseHeld: true, source: 'background' }),
      );
      return BackgroundTask.BackgroundTaskResult.Success;
    } catch {
      return BackgroundTask.BackgroundTaskResult.Failed;
    }
  });
}

export async function registerJunluoLifeBackgroundTask() {
  if (__DEV__) {
    const registered = await TaskManager.isTaskRegisteredAsync(
      JUNLUO_LIFE_TASK_NAME,
    ).catch(() => false);
    if (registered) {
      await BackgroundTask.unregisterTaskAsync(JUNLUO_LIFE_TASK_NAME)
        .catch(() => undefined);
    }
    return false;
  }
  const available = await TaskManager.isAvailableAsync().catch(() => false);
  if (!available) return false;
  const status = await BackgroundTask.getStatusAsync().catch(() => null);
  if (status !== BackgroundTask.BackgroundTaskStatus.Available) return false;
  // 重复注册会刷新持久化参数；Expo 使用最后一次注册的最小间隔。
  await BackgroundTask.registerTaskAsync(JUNLUO_LIFE_TASK_NAME, {
    minimumInterval: MINIMUM_BACKGROUND_INTERVAL_MINUTES,
  });
  return true;
}
