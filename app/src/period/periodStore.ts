import * as SQLite from 'expo-sqlite';
import { captureBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { initializePeriodDatabase } from './periodDatabaseSchema';
import { openDatabaseImportSource, type DatabaseImportSource } from '../backup/sqliteBackupFiles';
import {
  PERIOD_HEALTH_RESET_TECHNICAL_STATE_SQL,
} from '../sync/syncPeriodHealthSql';

export type PeriodFlow = 'none' | 'spotting' | 'light' | 'medium' | 'heavy';
export type PeriodBodyState = 'normal' | 'uncertain' | 'period';

export type PeriodEntry = {
  createdAt: number;
  endAt: number | null;
  id: string;
  startAt: number;
  updatedAt: number;
};

export type PeriodDailyLog = {
  bodyState: PeriodBodyState;
  createdAt: number;
  dateKey: string;
  flow: PeriodFlow;
  id: string;
  note: string;
  painLevel: number;
  periodId: string | null;
  symptoms: string[];
  updatedAt: number;
};

export type PeriodPrediction = {
  averageCycleLength: number;
  averagePeriodDuration: number;
  daysUntilDue: number;
  estimatedEndAt: number;
  estimatedStartAt: number;
};

export type PeriodObservation = PeriodDailyLog & { timeText: string | null };

export type PeriodObservationSaveOptions = {
  observationId?: string;
  timeText?: string | null;
};

export type PeriodSummary = {
  currentPeriod: PeriodEntry | null;
  history: PeriodEntry[];
  prediction: PeriodPrediction | null;
  todayLog: PeriodDailyLog | null;
};

export type PeriodContextStatus = {
  bodyState: PeriodBodyState | null;
  currentDay: number | null;
  daysUntilDue: number | null;
  flow: PeriodFlow | null;
  isCurrent: boolean;
  isDueSoon: boolean;
  note: string;
  painLevel: number | null;
  predictedStartAt: number | null;
  symptoms: string[];
};

export type PeriodDailyLogDraft = {
  bodyState?: PeriodBodyState;
  dateKey: string;
  flow: PeriodFlow;
  note: string;
  painLevel: number;
  periodId?: string | null;
  symptoms: string[];
};

type PeriodEntryRow = {
  created_at: number;
  end_at: number | null;
  id: string;
  start_at: number;
  updated_at: number;
};

type PeriodDailyLogRow = {
  body_state?: PeriodBodyState | null;
  created_at: number;
  date_key: string;
  flow: PeriodFlow;
  id: string;
  note: string;
  pain_level: number;
  period_id: string | null;
  symptoms: string;
  updated_at: number;
};

export type PeriodReminderSettingsRecord = {
  careEnabled: boolean;
  careFrequency: 'standard';
  mutedDateKey: string | null;
  updatedAt: number;
};

type PeriodReminderSettingsRow = {
  care_enabled: number;
  care_frequency: 'standard';
  muted_date_key: string | null;
  updated_at: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_VALID_CYCLE_LENGTH = 10;
const MAX_VALID_CYCLE_LENGTH = 130;

let databasePromise: Promise<SQLite.SQLiteDatabase> | undefined;

function makeId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function startOfLocalDay(value: Date | number) {
  const date = typeof value === 'number' ? new Date(value) : value;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export function getPeriodDateKey(value: Date | number = new Date()) {
  const date = typeof value === 'number' ? new Date(value) : value;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function dateKeyToTime(key: string) {
  const match = key.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return startOfLocalDay(Date.now());
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
}

function inclusiveDays(startAt: number, endAt: number) {
  return Math.max(1, Math.round((startOfLocalDay(endAt) - startOfLocalDay(startAt)) / DAY_MS) + 1);
}

function fromPeriodRow(row: PeriodEntryRow): PeriodEntry {
  return {
    createdAt: row.created_at,
    endAt: row.end_at,
    id: row.id,
    startAt: row.start_at,
    updatedAt: row.updated_at,
  };
}

function fromDailyLogRow(row: PeriodDailyLogRow): PeriodDailyLog {
  let symptoms: string[] = [];
  try {
    const parsed = JSON.parse(row.symptoms) as unknown;
    if (Array.isArray(parsed)) symptoms = parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    symptoms = [];
  }
  return {
    bodyState: normalizeBodyState(row.body_state, row.period_id),
    createdAt: row.created_at,
    dateKey: row.date_key,
    flow: row.flow,
    id: row.id,
    note: row.note,
    painLevel: row.pain_level,
    periodId: row.period_id,
    symptoms,
    updatedAt: row.updated_at,
  };
}

function normalizeBodyState(value: unknown, periodId?: string | null): PeriodBodyState {
  if (value === 'uncertain' || value === 'period' || value === 'normal') return value;
  return periodId ? 'period' : 'normal';
}

async function getDatabase() {
  if (!databasePromise) {
    databasePromise = SQLite.openDatabaseAsync('junluo-period.db').then(async (database) => {
      await initializePeriodDatabase(database);
      return database;
    });
  }
  return databasePromise;
}

export async function getPeriodDatabase() {
  return getDatabase();
}

export async function exportPeriodDatabase() {
  const database = await getDatabase();
  return database.serializeAsync();
}

export async function importPeriodDatabase(sourceFile: DatabaseImportSource) {
  if (databasePromise) {
    const openDatabase = await databasePromise;
    await openDatabase.closeAsync();
    databasePromise = undefined;
  }
  const source = await openDatabaseImportSource(sourceFile);
  const destination = await SQLite.openDatabaseAsync('junluo-period.db');
  try {
    await SQLite.backupDatabaseAsync({ sourceDatabase: source, destDatabase: destination });
  } finally {
    await source.closeAsync();
    await destination.closeAsync();
  }
  databasePromise = undefined;
  const importedDatabase = await getDatabase();
  await importedDatabase.execAsync(
    PERIOD_HEALTH_RESET_TECHNICAL_STATE_SQL,
  );
}

export async function clearPeriodDatabase() {
  const database = await getDatabase();
  await database.withExclusiveTransactionAsync(async (transaction) => {
    await transaction.execAsync(`
      UPDATE period_sync_runtime
      SET capture_enabled = 0, suppress_capture = 0;
      DELETE FROM period_observations;
      DELETE FROM period_daily_logs;
      DELETE FROM period_entries;
      ${PERIOD_HEALTH_RESET_TECHNICAL_STATE_SQL}
    `);
  });
}

export async function loadCurrentPeriod() {
  const database = await getDatabase();
  const row = await database.getFirstAsync<PeriodEntryRow>(
    'SELECT * FROM period_entries WHERE end_at IS NULL ORDER BY start_at DESC LIMIT 1',
  );
  return row ? fromPeriodRow(row) : null;
}

export async function loadPeriodEntries(limit = 24) {
  const database = await getDatabase();
  const rows = await database.getAllAsync<PeriodEntryRow>(
    'SELECT * FROM period_entries ORDER BY start_at DESC LIMIT ?',
    limit,
  );
  return rows.map(fromPeriodRow);
}

export async function startCurrentPeriod(dateKey = getPeriodDateKey()) {
  const existing = await loadCurrentPeriod();
  const database = await getDatabase();
  const now = Date.now();
  if (existing) {
    const requestedStartAt = dateKeyToTime(dateKey);
    if (requestedStartAt < existing.startAt) {
      await database.runAsync(
        'UPDATE period_entries SET start_at = ?, updated_at = ? WHERE id = ?',
        requestedStartAt,
        now,
        existing.id,
      );
      return { ...existing, startAt: requestedStartAt, updatedAt: now };
    }
    return existing;
  }

  const entry: PeriodEntry = {
    createdAt: now,
    endAt: null,
    id: makeId('period'),
    startAt: dateKeyToTime(dateKey),
    updatedAt: now,
  };
  await database.runAsync(
    `INSERT INTO period_entries (id, start_at, end_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
    entry.id,
    entry.startAt,
    entry.endAt,
    entry.createdAt,
    entry.updatedAt,
  );
  return entry;
}

export async function endCurrentPeriod(dateKey = getPeriodDateKey()) {
  const current = await loadCurrentPeriod();
  if (!current) return null;

  return updatePeriodEndDate(current.id, dateKey);
}

export async function updatePeriodEndDate(periodId: string, dateKey: string) {
  const database = await getDatabase();
  const row = await database.getFirstAsync<PeriodEntryRow>(
    'SELECT * FROM period_entries WHERE id = ?',
    periodId,
  );
  if (!row) return null;

  const period = fromPeriodRow(row);
  const endAt = Math.max(period.startAt, dateKeyToTime(dateKey));
  const endDateKey = getPeriodDateKey(endAt);
  const now = Date.now();
  await database.withExclusiveTransactionAsync(async (transaction) => {
    await transaction.runAsync(
      'UPDATE period_entries SET end_at = ?, updated_at = ? WHERE id = ?',
      endAt,
      now,
      period.id,
    );
    await transaction.runAsync(
      `UPDATE period_daily_logs
         SET period_id = NULL,
             body_state = CASE WHEN body_state = 'period' THEN 'normal' ELSE body_state END,
             updated_at = ?
       WHERE period_id = ? AND date_key > ?`,
      now,
      period.id,
      endDateKey,
    );
    await transaction.runAsync(
      `UPDATE period_observations
         SET period_id = NULL,
             body_state = CASE WHEN body_state = 'period' THEN 'normal' ELSE body_state END,
             updated_at = ?
       WHERE period_id = ? AND date_key > ?`,
      now,
      period.id,
      endDateKey,
    );
  });
  return { ...period, endAt, updatedAt: now };
}

export async function loadDailyLog(dateKey = getPeriodDateKey()) {
  const database = await getDatabase();
  const row = await database.getFirstAsync<PeriodDailyLogRow>(
    'SELECT * FROM period_daily_logs WHERE date_key = ?',
    dateKey,
  );
  return row ? fromDailyLogRow(row) : null;
}

export async function loadDailyLogsBetween(startDateKey: string, endDateKey: string) {
  const database = await getDatabase();
  const rows = await database.getAllAsync<PeriodDailyLogRow>(
    'SELECT * FROM period_daily_logs WHERE date_key >= ? AND date_key <= ? ORDER BY date_key ASC',
    startDateKey,
    endDateKey,
  );
  return rows.map(fromDailyLogRow);
}

export async function loadLatestDailyLogBefore(dateKey: string) {
  const database = await getDatabase();
  const row = await database.getFirstAsync<PeriodDailyLogRow>(
    'SELECT * FROM period_daily_logs WHERE date_key < ? ORDER BY date_key DESC LIMIT 1',
    dateKey,
  );
  return row ? fromDailyLogRow(row) : null;
}

export async function loadPeriodObservations(dateKey: string): Promise<PeriodObservation[]> {
  const database = await getDatabase();
  const rows = await database.getAllAsync<PeriodDailyLogRow & { time_text: string | null }>(
    `SELECT * FROM period_observations WHERE date_key = ?
     ORDER BY COALESCE(time_text, '') ASC, created_at ASC, rowid ASC`,
    dateKey,
  );
  return rows.map((row) => ({ ...fromDailyLogRow(row), timeText: row.time_text }));
}

export async function loadPeriodObservation(id: string): Promise<PeriodObservation | null> {
  const database = await getDatabase();
  const row = await database.getFirstAsync<PeriodDailyLogRow & { time_text: string | null }>(
    'SELECT * FROM period_observations WHERE id = ?', id,
  );
  return row ? { ...fromDailyLogRow(row), timeText: row.time_text } : null;
}

export async function saveDailyLog(draft: PeriodDailyLogDraft, options: PeriodObservationSaveOptions = {}) {
  const database = await getDatabase();
  const now = Date.now();
  const timeText = options.timeText === undefined
    ? draft.dateKey === getPeriodDateKey(now)
      ? `${String(new Date(now).getHours()).padStart(2, '0')}:${String(new Date(now).getMinutes()).padStart(2, '0')}`
      : null
    : options.timeText;
  if (timeText !== null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(timeText)) {
    throw new Error('时间请填写为 HH:mm，例如 14:30。');
  }
  const dataEpoch = captureBackupRestoreDataEpoch();
  const observationId = options.observationId ?? makeId('period-observation');
  let observation: PeriodObservation | undefined;
  let previousObservation: PeriodObservation | null = null;
  let result: PeriodDailyLog | undefined;
  await database.withExclusiveTransactionAsync(async (transaction) => {
    const existing = await transaction.getFirstAsync<PeriodDailyLogRow>(
      'SELECT * FROM period_daily_logs WHERE date_key = ?', draft.dateKey,
    );
    const periodId = draft.periodId === undefined ? existing?.period_id ?? null : draft.periodId;
    const bodyState = normalizeBodyState(draft.bodyState, periodId);
    const previousRow = await transaction.getFirstAsync<PeriodDailyLogRow & { time_text: string | null }>(
      `SELECT * FROM period_observations WHERE period_id IS ? AND id <> ?
       ORDER BY date_key DESC, COALESCE(time_text, '') DESC, created_at DESC, rowid DESC LIMIT 1`,
      periodId, observationId,
    );
    previousObservation = previousRow ? { ...fromDailyLogRow(previousRow), timeText: previousRow.time_text } : null;
    const symptoms = JSON.stringify(Array.from(new Set(draft.symptoms)).filter(Boolean));
    const values = [periodId, bodyState, draft.flow,
      Math.max(0, Math.min(5, Math.round(draft.painLevel))), symptoms, draft.note.trim()];
    if (options.observationId) {
      const saved = await transaction.runAsync(
        `UPDATE period_observations SET time_text = ?, period_id = ?, body_state = ?,
           flow = ?, pain_level = ?, symptoms = ?, note = ?, updated_at = ?
         WHERE id = ? AND date_key = ?`,
        timeText, ...values, now, options.observationId, draft.dateKey,
      );
      if (!saved.changes) throw new Error('这条记录已不存在，请重新打开当天记录。');
    } else {
      await transaction.runAsync(
        `INSERT INTO period_observations
          (id, date_key, time_text, period_id, body_state, flow, pain_level, symptoms, note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        observationId, draft.dateKey, timeText, ...values, now, now,
      );
    }
    const written = await transaction.getFirstAsync<PeriodDailyLogRow & { time_text: string | null }>(
      'SELECT * FROM period_observations WHERE id = ?', observationId,
    );
    if (!written) throw new Error('period_observation_not_persisted');
    observation = { ...fromDailyLogRow(written), timeText: written.time_text };
    // Keep the existing daily contract as the latest reading, not the day's peak.
    const latest = await transaction.getFirstAsync<PeriodDailyLogRow>(
      `SELECT * FROM period_observations WHERE date_key = ?
       ORDER BY COALESCE(time_text, '') DESC, created_at DESC, rowid DESC LIMIT 1`,
      draft.dateKey,
    );
    if (!latest) throw new Error('身体记录保存失败。');
    const dailyId = existing?.id ?? makeId('period-log');
    await transaction.runAsync(
      `INSERT INTO period_daily_logs
        (id, date_key, period_id, body_state, flow, pain_level, symptoms, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(date_key) DO UPDATE SET period_id = excluded.period_id, body_state = excluded.body_state,
         flow = excluded.flow, pain_level = excluded.pain_level, symptoms = excluded.symptoms,
         note = excluded.note, updated_at = excluded.updated_at`,
      dailyId, draft.dateKey, latest.period_id, latest.body_state ?? 'normal',
      latest.flow, latest.pain_level, latest.symptoms, latest.note, existing?.created_at ?? now, now,
    );
    result = fromDailyLogRow({ ...latest, id: dailyId,
      created_at: existing?.created_at ?? now, updated_at: now });
  });
  // The daily projection is not evidence of a new observation. Explicit time
  // entries are backfills; only a new, current local save creates an opportunity.
  const { recordPeriodCareObservation } = await import('./periodCareEvents');
  await recordPeriodCareObservation({ observation: observation!, previous: previousObservation,
    live: !options.observationId && options.timeText === undefined && draft.dateKey === getPeriodDateKey(now), dataEpoch });
  return result!;
}

export function estimateNextPeriod(periods: PeriodEntry[], now = Date.now()): PeriodPrediction | null {
  const completed = periods
    .filter((period) => period.endAt !== null)
    .sort((left, right) => left.startAt - right.startAt);
  if (completed.length < 2) return null;

  const cycleLengths: number[] = [];
  for (let index = 0; index < completed.length - 1; index += 1) {
    const days = Math.round((startOfLocalDay(completed[index + 1].startAt) - startOfLocalDay(completed[index].startAt)) / DAY_MS);
    if (days >= MIN_VALID_CYCLE_LENGTH && days <= MAX_VALID_CYCLE_LENGTH) {
      cycleLengths.push(days);
    }
  }
  if (!cycleLengths.length) return null;

  const durations = completed.map((period) => inclusiveDays(period.startAt, period.endAt ?? period.startAt));
  const averageCycleLength = Math.round(cycleLengths.reduce((sum, days) => sum + days, 0) / cycleLengths.length);
  const averagePeriodDuration = Math.round(durations.reduce((sum, days) => sum + days, 0) / durations.length);
  const lastStartAt = completed[completed.length - 1].startAt;
  const estimatedStartAt = startOfLocalDay(lastStartAt) + averageCycleLength * DAY_MS;
  const estimatedEndAt = estimatedStartAt + Math.max(0, averagePeriodDuration - 1) * DAY_MS;
  const daysUntilDue = Math.round((startOfLocalDay(estimatedStartAt) - startOfLocalDay(now)) / DAY_MS);

  return {
    averageCycleLength,
    averagePeriodDuration,
    daysUntilDue,
    estimatedEndAt,
    estimatedStartAt,
  };
}

export async function loadPeriodSummary(): Promise<PeriodSummary> {
  const [currentPeriod, history, todayLog] = await Promise.all([
    loadCurrentPeriod(),
    loadPeriodEntries(24),
    loadDailyLog(),
  ]);
  return {
    currentPeriod,
    history,
    prediction: estimateNextPeriod(history),
    todayLog,
  };
}

export function getPeriodDurationDays(period: PeriodEntry) {
  return inclusiveDays(period.startAt, period.endAt ?? Date.now());
}

export async function loadPeriodStatusForContext(): Promise<PeriodContextStatus | null> {
  const summary = await loadPeriodSummary();
  const { currentPeriod, prediction, todayLog } = summary;
  const isDueSoon = !!prediction && prediction.daysUntilDue <= 7 && prediction.daysUntilDue >= -14;
  if (!currentPeriod && !isDueSoon && !todayLog) return null;
  return {
    currentDay: currentPeriod ? getPeriodDurationDays(currentPeriod) : null,
    bodyState: todayLog?.bodyState ?? null,
    daysUntilDue: prediction?.daysUntilDue ?? null,
    flow: todayLog?.flow ?? null,
    isCurrent: !!currentPeriod,
    isDueSoon,
    note: todayLog?.note ?? '',
    painLevel: todayLog?.painLevel ?? null,
    predictedStartAt: prediction?.estimatedStartAt ?? null,
    symptoms: todayLog?.symptoms ?? [],
  };
}
export async function loadPeriodReminderSettingsRecord():
Promise<PeriodReminderSettingsRecord | null> {
  const database = await getDatabase();
  const row = await database.getFirstAsync<PeriodReminderSettingsRow>(
    `SELECT care_enabled, care_frequency, muted_date_key, updated_at
     FROM period_reminder_settings WHERE id = 'global'`,
  );
  if (!row) return null;
  return {
    careEnabled: row.care_enabled === 1,
    careFrequency: 'standard',
    mutedDateKey: row.muted_date_key,
    updatedAt: row.updated_at,
  };
}

export async function savePeriodReminderSettingsRecord(
  settings: Omit<PeriodReminderSettingsRecord, 'updatedAt'>,
  updatedAt = Date.now(),
) {
  const database = await getDatabase();
  await database.runAsync(
    `INSERT INTO period_reminder_settings (
       id, care_enabled, care_frequency, muted_date_key,
       updated_at
     ) VALUES ('global', ?, 'standard', ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       care_enabled = excluded.care_enabled,
       care_frequency = excluded.care_frequency,
       muted_date_key = excluded.muted_date_key,
       updated_at = excluded.updated_at`,
    settings.careEnabled ? 1 : 0,
    settings.mutedDateKey,
    updatedAt,
  );
}

export async function loadPeriodPendingNotificationCancellationIds() {
  const database = await getDatabase();
  const rows = await database.getAllAsync<{
    notification_id: string;
  }>(
    `SELECT notification_id
     FROM period_sync_pending_notification_cancellations
     ORDER BY created_at ASC, notification_id ASC`,
  );
  return rows.map((row) => row.notification_id);
}

export async function acknowledgePeriodNotificationCancellations(
  notificationIds: string[],
) {
  if (!notificationIds.length) return;
  const database = await getDatabase();
  const placeholders = notificationIds.map(() => '?').join(',');
  await database.runAsync(
    `DELETE FROM period_sync_pending_notification_cancellations
     WHERE notification_id IN (${placeholders})`,
    ...notificationIds,
  );
}

export async function cancelRetiredPeriodNotifications() {
  const ids = await loadPeriodPendingNotificationCancellationIds();
  if (!ids.length) return;
  const Notifications = await import('expo-notifications');
  for (const id of ids) {
    await Notifications.cancelScheduledNotificationAsync(id);
    await acknowledgePeriodNotificationCancellations([id]);
  }
}
