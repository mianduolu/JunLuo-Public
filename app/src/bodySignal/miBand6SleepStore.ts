import type { SQLiteDatabase } from 'expo-sqlite';
import { validateMiBand6SleepStages } from './miBand6SleepStages';
import { sleepHeartRateSourceKey } from './bodySignalSleepHeartRate';
import { MI_BAND_6_SLEEP_STREAM, type MiBand6SavedSleep, type MiBand6SleepBatch,
  type MiBand6SleepDay, type MiBand6SleepDuration, type MiBand6SleepStages } from './miBand6SleepTypes';

const ALGORITHM_VERSION = 'mi-band-6-sleep-v2';
const READABLE_VERSIONS = [ALGORITHM_VERSION, 'mi-band-6-duration-v1'];
const MINUTE = 60_000;
const DAY = 86_400_000;
const OFFSET = 8 * 60 * MINUTE;
type CursorRow = { cursor: string | null; updated_at: number; synced_through_at: number | null };
type SavedRow = { id: string; device_profile_id: string; source_provider: string; algorithm_version: string;
  wake_date_key: string; started_at: number; ended_at: number; total_minutes: number; updated_at: number };
type StageRow = { session_id: string; sequence: number; stage: string; started_at: number; ended_at: number };

function requireValue(valid: unknown, code: string): asserts valid {
  if (!valid) throw new RangeError(`sleep_${code}`);
}
function timestamp(value: number, now: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= now && Number.isFinite(new Date(value).getTime());
}
function dateKey(at: number): string { return new Date(at + OFFSET).toISOString().slice(0, 10); }
function dayStart(key: string): number {
  requireValue(typeof key === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(key), 'invalid_date');
  const value = Date.parse(`${key}T00:00:00+08:00`);
  requireValue(Number.isFinite(value) && dateKey(value) === key, 'invalid_date');
  return value;
}
function bounds(now: number) {
  requireValue(timestamp(now, now), 'invalid_time');
  const today = dateKey(now);
  const cutoffAt = dayStart(today) - 6 * DAY;
  return { today, oldest: dateKey(cutoffAt), cutoffAt };
}
function normalizeDuration(value: MiBand6SleepDuration, wakeDate: string, observedAt: number): MiBand6SleepDuration {
  requireValue(value && timestamp(value.startedAt, observedAt) && timestamp(value.endedAt, observedAt)
    && value.startedAt % MINUTE === 0 && value.endedAt % MINUTE === 0
    && value.endedAt > value.startedAt && Number.isSafeInteger(value.totalMinutes)
    && value.totalMinutes > 0 && value.totalMinutes <= (value.endedAt - value.startedAt) / MINUTE,
  'invalid_duration');
  requireValue(dateKey(value.endedAt) === wakeDate, 'wake_date_mismatch');
  return { startedAt: value.startedAt, endedAt: value.endedAt, totalMinutes: value.totalMinutes };
}

// Rebuild known fields so raw packets or incidental input properties cannot enter the cursor.
function normalizeBatch(batch: MiBand6SleepBatch, now: number, includeStages = false): MiBand6SleepBatch {
  requireValue(batch && typeof batch.deviceProfileId === 'string' && batch.deviceProfileId.trim().length > 0,
    'profile_missing');
  requireValue(batch.sourceProvider === 'mi_band_6' && READABLE_VERSIONS.includes(batch.algorithmVersion),
    'unsupported_algorithm');
  const limit = bounds(batch.observedAt);
  requireValue(timestamp(batch.requestedAt, now) && timestamp(batch.observedAt, now)
    && batch.requestedAt <= batch.observedAt && timestamp(batch.coverageStartedAt, batch.observedAt)
    && timestamp(batch.coverageEndedAt, batch.observedAt)
    && batch.coverageStartedAt % MINUTE === 0 && batch.coverageEndedAt % MINUTE === 0
    && batch.coverageStartedAt <= batch.coverageEndedAt
    && batch.coverageEndedAt - batch.coverageStartedAt <= 7 * DAY, 'invalid_time');
  requireValue(Array.isArray(batch.days) && batch.days.length > 0 && batch.days.length <= 7, 'invalid_days');
  const seen = new Set<string>();
  const days = batch.days.map((day): MiBand6SleepDay => {
    requireValue(day && !seen.has(day.dateKey), 'duplicate_date');
    dayStart(day.dateKey);
    requireValue(day.dateKey >= limit.oldest && day.dateKey <= limit.today, 'invalid_date');
    seen.add(day.dateKey);
    requireValue(['recorded', 'pending', 'coverage_missing', 'not_detected', 'unsupported'].includes(day.status), 'invalid_status');
    requireValue(day.status !== 'recorded' || day.duration !== undefined, 'duration_missing');
    requireValue(day.duration === undefined || day.status === 'recorded' || day.status === 'pending', 'invalid_status');
    const duration = day.duration ? normalizeDuration(day.duration, day.dateKey, batch.observedAt) : undefined;
    if (duration) requireValue(duration.startedAt >= batch.coverageStartedAt && duration.endedAt <= batch.coverageEndedAt,
      'duration_outside_coverage');
    const stages = includeStages && duration ? validateMiBand6SleepStages(duration, day.stages) : undefined;
    return { dateKey: day.dateKey, status: day.status, ...(duration ? { duration } : {}), ...(stages ? { stages } : {}) };
  });
  return { deviceProfileId: batch.deviceProfileId, sourceProvider: 'mi_band_6', algorithmVersion: batch.algorithmVersion,
    requestedAt: batch.requestedAt, observedAt: batch.observedAt, coverageStartedAt: batch.coverageStartedAt,
    coverageEndedAt: batch.coverageEndedAt, days };
}
function parseBatch(raw: string | null, now: number): MiBand6SleepBatch | undefined {
  try { return raw ? normalizeBatch(JSON.parse(raw), now) : undefined; } catch { return undefined; }
}

async function prune(transaction: SQLiteDatabase, now: number): Promise<void> {
  const { oldest } = bounds(now);
  // Exclusive transactions use a fresh connection; do not rely on its foreign_keys PRAGMA.
  await transaction.runAsync(`DELETE FROM body_signal_sleep_stages WHERE session_id IN (
    SELECT id FROM body_signal_sleep_sessions
    WHERE source_provider = 'mi_band_6' AND algorithm_version IS NOT NULL AND algorithm_version <> ''
      AND wake_date_key < ?)`, oldest);
  await transaction.runAsync(`DELETE FROM body_signal_sleep_sessions
    WHERE source_provider = 'mi_band_6' AND algorithm_version IS NOT NULL AND algorithm_version <> ''
      AND wake_date_key < ?`, oldest);
  const cursors = await transaction.getAllAsync<CursorRow & { device_profile_id: string }>(
    `SELECT device_profile_id, cursor, updated_at, synced_through_at FROM body_signal_sync_cursors
      WHERE source_provider = 'mi_band_6' AND stream = ?`, MI_BAND_6_SLEEP_STREAM);
  for (const row of cursors) {
    // A malformed or older unrelated technical record is not proof it belongs to this algorithm.
    let version: unknown;
    try { version = row.cursor ? JSON.parse(row.cursor)?.algorithmVersion : undefined; } catch { continue; }
    if (typeof version !== 'string' || !READABLE_VERSIONS.includes(version)) continue;
    const batch = parseBatch(row.cursor, now);
    if (!batch || batch.deviceProfileId !== row.device_profile_id) continue;
    const days = batch.days.filter(day => day.dateKey >= oldest);
    if (days.length === batch.days.length) continue;
    if (days.length) {
      // The technical cursor also contains per-day results; expire those copies
      // without pretending a new successful device synchronization occurred.
      await transaction.runAsync(`UPDATE body_signal_sync_cursors SET cursor = ? WHERE device_profile_id = ?
        AND source_provider = 'mi_band_6' AND stream = ? AND updated_at = ?`,
      JSON.stringify({ ...batch, days }), row.device_profile_id, MI_BAND_6_SLEEP_STREAM, row.updated_at);
      continue;
    }
    await transaction.runAsync(`DELETE FROM body_signal_sync_cursors WHERE device_profile_id = ?
      AND source_provider = 'mi_band_6' AND stream = ? AND updated_at = ?`,
    row.device_profile_id, MI_BAND_6_SLEEP_STREAM, row.updated_at);
  }
}

export async function saveMiBand6SleepBatch(input: MiBand6SleepBatch, now = Date.now(), signal?: AbortSignal): Promise<void> {
  const active = () => { if (signal?.aborted) throw new Error('sleep_cancelled'); };
  active();
  requireValue(new Date(now).getTimezoneOffset() === -480, 'unsupported_timezone');
  requireValue(input?.algorithmVersion === ALGORITHM_VERSION, 'unsupported_algorithm');
  const batch = normalizeBatch(input, now, true);
  const { oldest, today } = bounds(now);
  const { getBodySignalDatabase } = await import('./bodySignalStore');
  const database = await getBodySignalDatabase();
  await database.withExclusiveTransactionAsync(async transaction => {
    active();
    const profile = await transaction.getFirstAsync<{ family: string; retired_at: number | null }>(
      'SELECT family, retired_at FROM body_signal_devices WHERE id = ?', batch.deviceProfileId);
    requireValue(profile?.family === 'mi_band_6' && profile.retired_at === null, 'profile_missing');
    const previous = await transaction.getFirstAsync<CursorRow>(`SELECT cursor, updated_at, synced_through_at
      FROM body_signal_sync_cursors WHERE device_profile_id = ? AND source_provider = 'mi_band_6' AND stream = ?`,
    batch.deviceProfileId, MI_BAND_6_SLEEP_STREAM);
    let priorBatch = parseBatch(previous?.cursor ?? null, now);
    if (priorBatch && (priorBatch.deviceProfileId !== batch.deviceProfileId
      || priorBatch.observedAt !== previous?.updated_at || priorBatch.coverageEndedAt !== previous?.synced_through_at)) priorBatch = undefined;
    const latestSaved = await transaction.getFirstAsync<{ updated_at: number | null }>(
      `SELECT MAX(updated_at) AS updated_at FROM body_signal_sleep_sessions WHERE device_profile_id = ?
        AND source_provider = 'mi_band_6' AND algorithm_version IS NOT NULL AND algorithm_version <> ''`, batch.deviceProfileId);
    // Completion time and request ordering both matter when an earlier transfer finishes late.
    if (dateKey(batch.observedAt) < oldest || (previous && (batch.observedAt <= previous.updated_at
      || batch.coverageEndedAt < (previous.synced_through_at ?? 0)))
      || batch.observedAt < (latestSaved?.updated_at ?? 0)
      || (priorBatch && batch.requestedAt < priorBatch.requestedAt)) return;
    for (const day of batch.days) {
      if (day.status !== 'recorded' || !day.duration || day.dateKey < oldest || day.dateKey > today) continue;
      const id = `sleep:${JSON.stringify([batch.deviceProfileId, 'mi_band_6', day.dateKey])}`;
      const existing = await transaction.getFirstAsync<{ updated_at: number; context_eligible: number;
        algorithm_version: string | null; device_profile_id: string; source_provider: string }>(
        'SELECT updated_at, context_eligible, algorithm_version, device_profile_id, source_provider FROM body_signal_sleep_sessions WHERE id = ?', id);
      if (existing) {
        requireValue(existing.device_profile_id === batch.deviceProfileId && existing.source_provider === 'mi_band_6'
          && Boolean(existing.algorithm_version) && existing.context_eligible === 0, 'session_id_conflict');
        if (existing.updated_at >= batch.observedAt) continue;
      }
      const sourceKey = sleepHeartRateSourceKey({ ...day.duration, dateKey: day.dateKey,
        deviceProfileId: batch.deviceProfileId, sourceProvider: 'mi_band_6',
        algorithmVersion: ALGORITHM_VERSION, updatedAt: batch.observedAt, stages: day.stages });
      // Invalidate derived attribution atomically, before replacing its sleep evidence.
      await transaction.runAsync(`DELETE FROM body_signal_sleep_heart_rate_buckets
        WHERE device_profile_id = ? AND wake_date_key = ? AND (? IS NULL OR source_key <> ?)`,
      batch.deviceProfileId, day.dateKey, sourceKey ?? null, sourceKey ?? null);
      await transaction.runAsync(`INSERT INTO body_signal_sleep_sessions (id, device_profile_id, source_provider,
        started_at, ended_at, total_minutes, confidence, created_at, updated_at, wake_date_key, algorithm_version, context_eligible)
        VALUES (?, ?, 'mi_band_6', ?, ?, ?, 'high', ?, ?, ?, ?, 0)
        ON CONFLICT(id) DO UPDATE SET started_at = excluded.started_at, ended_at = excluded.ended_at,
          total_minutes = excluded.total_minutes, updated_at = excluded.updated_at,
          wake_date_key = excluded.wake_date_key, algorithm_version = excluded.algorithm_version, context_eligible = 0`,
      id, batch.deviceProfileId, day.duration.startedAt, day.duration.endedAt, day.duration.totalMinutes,
      batch.observedAt, batch.observedAt, day.dateKey, ALGORITHM_VERSION);
      await transaction.runAsync('DELETE FROM body_signal_sleep_stages WHERE session_id = ?', id);
      for (const [sequence, segment] of (day.stages?.segments ?? []).entries()) {
        await transaction.runAsync(`INSERT INTO body_signal_sleep_stages
          (id, session_id, sequence, stage, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)`,
        `${id}:stage:${sequence}`, id, sequence, segment.stage, segment.startedAt, segment.endedAt);
      }
    }
    for (const day of batch.days) {
      await transaction.runAsync(`UPDATE body_signal_sleep_heart_rate_buckets SET unreviewed = ?
        WHERE device_profile_id = ? AND wake_date_key = ?`, Number(day.status !== 'recorded'), batch.deviceProfileId, day.dateKey);
    }
    await prune(transaction, now);
    await transaction.runAsync(`INSERT INTO body_signal_sync_cursors
      (device_profile_id, source_provider, stream, cursor, synced_through_at, updated_at)
      VALUES (?, 'mi_band_6', ?, ?, ?, ?)
      ON CONFLICT(device_profile_id, source_provider, stream) DO UPDATE SET cursor = excluded.cursor,
        synced_through_at = excluded.synced_through_at, updated_at = excluded.updated_at`,
    batch.deviceProfileId, MI_BAND_6_SLEEP_STREAM, JSON.stringify(normalizeBatch(batch, now)), batch.coverageEndedAt, batch.observedAt);
    // Throw inside the transaction: cancellation rolls back both rows and cursor.
    active();
  });
}

export async function loadMiBand6SleepHistory(deviceProfileId: string, now = Date.now(), databaseOverride?: SQLiteDatabase): Promise<{
  records: MiBand6SavedSleep[]; lastBatch?: MiBand6SleepBatch;
}> {
  const { oldest, today } = bounds(now);
  const { getBodySignalDatabase } = await import('./bodySignalStore');
  const database = databaseOverride ?? await getBodySignalDatabase();
  const rows = await database.getAllAsync<SavedRow>(`SELECT * FROM body_signal_sleep_sessions
    WHERE device_profile_id = ? AND source_provider = 'mi_band_6' AND algorithm_version IN (?, ?)
      AND context_eligible = 0 AND wake_date_key BETWEEN ? AND ? ORDER BY wake_date_key DESC`,
  deviceProfileId, ...READABLE_VERSIONS, oldest, today);
  const records: MiBand6SavedSleep[] = [];
  for (const row of rows) {
    try {
      requireValue(timestamp(row.updated_at, now), 'invalid_time');
      const duration = normalizeDuration({ startedAt: row.started_at, endedAt: row.ended_at,
        totalMinutes: row.total_minutes }, row.wake_date_key, row.updated_at);
      let stages: MiBand6SleepStages | undefined;
      if (row.algorithm_version === ALGORITHM_VERSION) {
        const children = await database.getAllAsync<StageRow>(`SELECT session_id, sequence, stage, started_at, ended_at
          FROM body_signal_sleep_stages WHERE session_id = ? ORDER BY sequence`, row.id);
        if (children.every((child, index) => child.session_id === row.id && child.sequence === index)) {
          const minutes = (stage: string) => children.filter(child => child.stage === stage)
            .reduce((total, child) => total + (child.ended_at - child.started_at) / MINUTE, 0);
          stages = validateMiBand6SleepStages(duration, { deepMinutes: minutes('deep'), lightMinutes: minutes('light'),
            segments: children.map(child => ({ stage: child.stage, startedAt: child.started_at, endedAt: child.ended_at })) });
        }
      }
      records.push({ ...duration, dateKey: row.wake_date_key, deviceProfileId, sourceProvider: 'mi_band_6',
        algorithmVersion: row.algorithm_version, updatedAt: row.updated_at, ...(stages ? { stages } : {}) });
    } catch { /* A damaged/restored row cannot crash the read-only page. */ }
  }
  const row = await database.getFirstAsync<CursorRow>(`SELECT cursor, updated_at, synced_through_at
    FROM body_signal_sync_cursors WHERE device_profile_id = ? AND source_provider = 'mi_band_6' AND stream = ?`,
  deviceProfileId, MI_BAND_6_SLEEP_STREAM);
  let lastBatch = parseBatch(row?.cursor ?? null, now);
  if (lastBatch && (lastBatch.deviceProfileId !== deviceProfileId || lastBatch.observedAt !== row?.updated_at
    || lastBatch.coverageEndedAt !== row?.synced_through_at || dateKey(lastBatch.observedAt) < oldest)) lastBatch = undefined;
  if (lastBatch) {
    const days = lastBatch.days.filter(day => day.dateKey >= oldest && day.dateKey <= today);
    lastBatch = days.length ? { ...lastBatch, days } : undefined;
  }
  return { records, ...(lastBatch ? { lastBatch } : {}) };
}

export async function pruneMiBand6SleepHistory(now = Date.now()): Promise<void> {
  const { getBodySignalDatabase } = await import('./bodySignalStore');
  const database = await getBodySignalDatabase();
  await database.withExclusiveTransactionAsync(transaction => prune(transaction, now));
}
