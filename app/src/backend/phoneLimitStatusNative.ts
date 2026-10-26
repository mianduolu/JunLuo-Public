import AsyncStorage from '@react-native-async-storage/async-storage';
import { NativeModules, Platform } from 'react-native';
import { readOwnAppPhoneUsage } from './phoneActivityNative';
import { canCommitBackupRestoreDataEpoch, captureBackupRestoreDataEpoch,
  runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import { PHONE_ACTIVITY_PROACTIVE_SETTINGS_KEY } from '../proactive/phoneRestrictionSettings';
import { parsePhoneLimitQuery, phoneLimitObject, projectPhoneLimitStatus,
  type PhoneLimitStatusReceipt, type PhoneLimitStatusSources } from '../tools/phoneLimitStatus';

type QueryNative = {
  getPhoneRestrictionQuery?: () => Promise<string>;
  getPhoneRestrictionUsageLogs?: (since: number, limit: number) => Promise<string>;
  getInstalledApps?: () => Promise<unknown>;
};
const parsed = (value: unknown) => typeof value === 'string' ? JSON.parse(value) : value;
async function read<T>(work: () => Promise<T>): Promise<T | null> {
  try { return await work(); } catch { return null; }
}

// Optional new native methods are checked independently. An older APK is unknown,
// never an empty snapshot from the old getter (which reconciles/saves state).
export async function readPhoneLimitStatus(): Promise<PhoneLimitStatusReceipt> {
  const empty: PhoneLimitStatusSources = { query: null, names: null, logs: null, ownUsage: null, settings: null };
  const epoch = captureBackupRestoreDataEpoch();
  if (!canCommitBackupRestoreDataEpoch(epoch)) return projectPhoneLimitStatus(empty);
  const commit = await runBackupRestoreDataEpochCommit(epoch, async () => {
    const native = Platform.OS === 'android' ? NativeModules.JunLuoPhoneActivity as QueryNative | undefined : undefined;
    if (typeof native?.getPhoneRestrictionQuery !== 'function') return projectPhoneLimitStatus(empty);
    const query = await read(async () => parsePhoneLimitQuery(parsed(await native.getPhoneRestrictionQuery!())));
    if (!query || !canCommitBackupRestoreDataEpoch(epoch)) return projectPhoneLimitStatus(empty);
    const [names, logs, ownUsage, settings] = await Promise.all([
      read(async () => {
        if (typeof native.getInstalledApps !== 'function') return null;
        const apps = parsed(await native.getInstalledApps());
        if (!Array.isArray(apps) || !apps.every(app => app && typeof app.source === 'string' && app.source.trim()
          && typeof app.title === 'string' && app.title.trim())
          || new Set(apps.map(app => app.source)).size !== apps.length) return null;
        return Object.fromEntries(apps.map(app => [app.source, app.title])) as Record<string, string>;
      }),
      read(async () => {
        if (typeof native.getPhoneRestrictionUsageLogs !== 'function') return null;
        const body = phoneLimitObject(parsed(await native.getPhoneRestrictionUsageLogs(query.dayStart, 5000)));
        return body?.available === true && typeof body.truncated === 'boolean' && Array.isArray(body.logs)
          ? { available: true, truncated: body.truncated, logs: body.logs } : null;
      }),
      read(() => readOwnAppPhoneUsage(1)),
      read(async () => {
        const raw = await AsyncStorage.getItem(PHONE_ACTIVITY_PROACTIVE_SETTINGS_KEY);
        return raw === null ? null : phoneLimitObject(JSON.parse(raw));
      }),
    ]);
    return canCommitBackupRestoreDataEpoch(epoch)
      ? projectPhoneLimitStatus({ query, names, logs, ownUsage, settings }) : projectPhoneLimitStatus(empty);
  });
  return commit.committed && canCommitBackupRestoreDataEpoch(epoch) ? commit.value : projectPhoneLimitStatus(empty);
}
