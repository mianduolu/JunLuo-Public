import { buildBodySignalSleepSummary } from './bodySignalSleepSummary';
import type { MiBand6SavedSleep, MiBand6SleepBatch } from './miBand6SleepTypes';

export type BodySignalSleepAiMaterial = {
  id: string;
  version: string;
  text: string;
  occurredAt: number;
  expiresAt: number;
};

const duration = (minutes: number) => {
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return `${hours ? `${hours}小时` : ''}${rest || !hours ? `${rest}分` : ''}`;
};

/** Only the saved, dated duration facts are model-visible; staging is not a consumer here. */
export function buildBodySignalSleepAiMaterial(
  history: { records: MiBand6SavedSleep[]; lastBatch?: MiBand6SleepBatch },
  deviceProfileId: string,
  now: number,
): BodySignalSleepAiMaterial | undefined {
  const summary = buildBodySignalSleepSummary(history, deviceProfileId, now);
  const recorded = summary.days.filter(day => day.totalMinutes !== undefined);
  const latest = recorded.at(-1);
  if (!latest || summary.averageMinutes === undefined) return undefined;
  const start = summary.days[0].dateKey, end = summary.days[6].dateKey;
  return {
    id: `body-signal:sleep:${deviceProfileId}`,
    version: JSON.stringify([deviceProfileId, 'mi_band_6', start, end,
      recorded.map(day => [day.dateKey, day.totalMinutes, Boolean(day.note)])]),
    occurredAt: Date.parse(`${latest.dateKey}T00:00:00+08:00`),
    expiresAt: Date.parse(`${end}T00:00:00+08:00`) + 86_400_000,
    text: [
      '【I看到的you的睡眠记录】',
      `最近已存：${latest.dateKey} ${duration(latest.totalMinutes!)}${latest.note ? '（尚未复核）' : ''}；近7天（${start}—${end}）：${summary.recordedNights}晚，平均${duration(summary.averageMinutes)}${summary.unreviewedNights ? '（含尚未复核记录）' : ''}。`,
      'I看到的是主要睡眠的估计，补觉没算进来。',
    ].join('\n'),
  };
}

/** Read errors propagate so delivery validation can distinguish an outage from removed evidence. */
export async function loadBodySignalSleepAiMaterial(now = Date.now()): Promise<BodySignalSleepAiMaterial | undefined> {
  const { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch } = await import('../backup/backupRestoreCoordinator');
  const epoch = captureBackupRestoreDataEpoch();
  if (epoch === null) throw new Error('sleep-material-restore-unavailable');
  const { loadPersistedPrimaryBodySignalDeviceProfile } = await import('./device/bodySignalDeviceRepository');
  const profile = await loadPersistedPrimaryBodySignalDeviceProfile();
  if (!profile || profile.family !== 'mi_band_6') return undefined;
  const { loadMiBand6SleepHistory } = await import('./miBand6SleepStore');
  const history = await loadMiBand6SleepHistory(profile.id, now);
  const current = await loadPersistedPrimaryBodySignalDeviceProfile();
  if (!canCommitBackupRestoreDataEpoch(epoch)) throw new Error('sleep-material-restore-changed');
  if (current?.id !== profile.id || current.family !== 'mi_band_6') return undefined;
  return buildBodySignalSleepAiMaterial(history, profile.id, now);
}
