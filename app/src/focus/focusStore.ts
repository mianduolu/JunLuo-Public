import { openDatabaseImportSource, type DatabaseImportSource } from '../backup/sqliteBackupFiles';
import { Platform } from 'react-native';
import { focusSemanticStorageBridge as AsyncStorage } from '../sync/syncFocusSemanticStorageBridge';
import {
  closeFocusDatabase,
  getFocusDatabase as getDatabase,
} from './focusDatabase';
import { makeFocusSessionId } from './focusIdentity';
import { isFocusGenerationFailureResolved } from './focusChatDelivery';
import type { FocusNextActivityChoice } from './focusGenerationPolicy';
import { parseFocusReview, type FocusReviewEvidence, type FocusTagSnapshot } from './focusReviewData';
import type { FocusTimingEvidence } from './focusTiming';
import { captureBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import {
  FOCUS_ORGANIZATION_TRIGGER, FOCUS_SUMMARY_RECENT_MS, focusOrganizationLogId,
  isFocusOrganizationLog, parseFocusOrganizationRecord, type FocusOrganizationRecord,
} from './focusSummaryRecord';

export type FocusMode = 'support' | 'cowork';
export type FocusLogRole = 'system' | 'I' | 'you';
export type FocusTimerMode = 'stopwatch' | 'countdown' | 'pomodoro';

export type FocusSession = {
  id: string;
  mode: FocusMode;
  userActivity: string;
  baiyunActivity: string;
  startedAt: number;
  endedAt: number;
  durationSeconds: number;
  heartRateAvg: number;
  temperatureAvg: number;
  createdAt: number;
  review?: FocusReviewEvidence;
};

export type FocusLogEntry = {
  id: string;
  sessionId: string;
  role: FocusLogRole;
  content: string;
  createdAt: number;
  elapsedSeconds: number;
  trigger: string;
};

export type FocusSessionDraft = Omit<FocusSession, 'createdAt' | 'id'> & {
  logs: Omit<FocusLogEntry, 'sessionId'>[];
};

export type PendingFocusInvite = {
  baiyunActivity: string;
  createdAt: number;
  message: string;
  mode: FocusMode;
  readingId?: string | null;
  readingActivityId?: string;
};

export type FocusReadingBinding = {
  version: 1;
  bookId: string;
  sourceActivityId: string;
  sourceOperationId: string;
  originalRemainingMs: number | null;
  boundWorkMs: number;
  choice?: FocusNextActivityChoice & { savedAt: number };
  transition?: { operationId: string; at: number; activity: string; readingActivityId?: string };
  endedAt?: number;
};

export type ActiveFocusSession = {
  baiyunActivity: string;
  elapsedSeconds: number;
  logs: Array<Omit<FocusLogEntry, 'sessionId'>>;
  mode: FocusMode;
  paused: boolean;
  pausedAt?: number;
  pomodoroGoal?: number;
  pomodoroLongBreakSeconds?: number;
  pomodoroShortBreakSeconds?: number;
  pomodoroWorkSeconds?: number;
  startedAt: number;
  targetSeconds?: number;
  timerMode: FocusTimerMode;
  totalPausedMs: number;
  userActivity: string;
  reading?: FocusReadingBinding;
  timing?: FocusTimingEvidence;
  categoryId?: string;
  tag?: FocusTagSnapshot;
};

let focusWriteTail: Promise<unknown> = Promise.resolve();
let focusRecoveryCheck: {
  sessionId: string;
  epoch: number | null;
  history: Promise<FocusSession | null>;
  invalidated?: boolean;
} | undefined;
function invalidateFocusRecoveryCheck() {
  if (focusRecoveryCheck) focusRecoveryCheck.invalidated = true;
  focusRecoveryCheck = undefined;
}
function serializeFocusWrite<T>(write: () => Promise<T>): Promise<T> {
  const result = focusWriteTail.then(write, write);
  focusWriteTail = result.catch(() => undefined);
  return result;
}

async function writeFocusReadingRecord(session: ActiveFocusSession) {
  const value = JSON.stringify(session);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try { await AsyncStorage.setItem(ACTIVE_FOCUS_KEY, value); return; }
    catch (error) {
      if (await AsyncStorage.getItem(ACTIVE_FOCUS_KEY).catch(() => null) === value) return;
      if (attempt === 3) throw error;
    }
  }
}

export async function updateActiveFocusReadingState(
  sessionId: string,
  update: (session: ActiveFocusSession) => ActiveFocusSession,
  dataEpoch = captureBackupRestoreDataEpoch(),
) {
  return serializeFocusWrite(async () => {
    const result = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
      const current = await loadActiveFocusSession(true);
      if (!current || makeFocusSessionId(current) !== sessionId) return null;
      const next = update(current);
      await writeFocusReadingRecord(next);
      return next;
    });
    return result.committed ? result.value : null;
  });
}

type FocusSessionRow = {
  id: string;
  mode: FocusMode;
  user_activity: string;
  baiyun_activity: string;
  started_at: number;
  ended_at: number;
  duration_seconds: number;
  heart_rate_avg: number;
  temperature_avg: number;
  created_at: number;
  review_json?: string | null;
};

type FocusLogRow = {
  id: string;
  session_id: string;
  role: FocusLogRole;
  content: string;
  created_at: number;
  elapsed_seconds: number;
  trigger: string;
};

export const PENDING_INVITE_KEY = 'junluo.focus.pendingInvite';
export const LAST_INVITE_OFFERED_AT_KEY = 'junluo.focus.lastInviteOfferedAt';
export const ACTIVE_FOCUS_KEY = 'junluo.focus.activeSession';
const INVITE_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const POMODORO_WORK_SECONDS = 25 * 60;
const POMODORO_SHORT_BREAK_SECONDS = 5 * 60;
const POMODORO_LONG_BREAK_SECONDS = 15 * 60;

function fromSessionRow(row: FocusSessionRow): FocusSession {
  return {
    id: row.id,
    mode: row.mode,
    userActivity: row.user_activity,
    baiyunActivity: row.baiyun_activity,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationSeconds: row.duration_seconds,
    heartRateAvg: row.heart_rate_avg,
    temperatureAvg: row.temperature_avg,
    createdAt: row.created_at,
    review: parseFocusReview(row.review_json, row.started_at, row.ended_at),
  };
}

function fromLogRow(row: FocusLogRow): FocusLogEntry {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
    elapsedSeconds: row.elapsed_seconds,
    trigger: row.trigger,
  };
}

export function getActiveFocusElapsed(active: ActiveFocusSession, now = Date.now()) {
  if (active.paused) return active.elapsedSeconds;
  return Math.max(0, Math.floor((now - active.startedAt - active.totalPausedMs) / 1000));
}

export function getActiveFocusDisplaySeconds(active: ActiveFocusSession, now = Date.now()) {
  const elapsed = getActiveFocusElapsed(active, now);
  if (active.timerMode === 'countdown' && active.targetSeconds) {
    return Math.max(0, active.targetSeconds - elapsed);
  }
  if (active.timerMode === 'pomodoro') {
    const workSeconds = active.pomodoroWorkSeconds ?? POMODORO_WORK_SECONDS;
    const shortBreakSeconds = active.pomodoroShortBreakSeconds ?? POMODORO_SHORT_BREAK_SECONDS;
    const longBreakSeconds = active.pomodoroLongBreakSeconds ?? POMODORO_LONG_BREAK_SECONDS;
    let remainingElapsed = elapsed;
    let round = 1;
    while (true) {
      if (remainingElapsed < workSeconds) return workSeconds - remainingElapsed;
      remainingElapsed -= workSeconds;
      const breakSeconds = round % 4 === 0 ? longBreakSeconds : shortBreakSeconds;
      if (remainingElapsed < breakSeconds) return breakSeconds - remainingElapsed;
      remainingElapsed -= breakSeconds;
      round += 1;
    }
  }
  return elapsed;
}

export async function saveActiveFocusSession(session: ActiveFocusSession, replyGuard?: {
  expectedSessionId: string;
  canCommit: () => boolean;
  beforeSave?: () => Promise<boolean>;
}) {
  const { previous, saved, completed } = await serializeFocusWrite(async () => {
    // A delayed screen checkpoint must not resurrect a locally finished timer.
    if (await loadFocusSessionById(makeFocusSessionId(session))) {
      invalidateFocusRecoveryCheck();
      return { previous: session, saved: session, completed: true };
    }
    const previous = await loadActiveFocusSession(true);
    // Recheck inside the write slot: a waiting reply must not replace a newer active scene.
    if (replyGuard && (!replyGuard.canCommit() || !previous
      || makeFocusSessionId(previous) !== replyGuard.expectedSessionId)) {
      throw new Error('focus-chat-reply-source-changed');
    }
    if (replyGuard?.beforeSave && (!await replyGuard.beforeSave() || !replyGuard.canCommit())) {
      throw new Error('focus-chat-reply-source-changed');
    }
    const same = previous && makeFocusSessionId(previous) === makeFocusSessionId(session);
    // A reply only appends logs; pause/resume and other metadata may have changed while it waited.
    const metadata = replyGuard && previous ? previous : session;
    // Background activity transitions must survive an older screen snapshot.
    const saved = same ? { ...metadata, reading: previous.reading ?? metadata.reading,
      baiyunActivity: previous.reading?.endedAt !== undefined && previous.baiyunActivity === ''
        && previous.reading.sourceActivityId === metadata.reading?.sourceActivityId ? ''
        : previous.reading?.transition?.activity ?? metadata.baiyunActivity,
      logs: [...previous.logs, ...session.logs.filter(log => !previous.logs.some(item => item.id === log.id))],
    } : session;
    if (saved.reading) await writeFocusReadingRecord(saved);
    else await AsyncStorage.setItem(ACTIVE_FOCUS_KEY, JSON.stringify(saved));
    if (focusRecoveryCheck?.sessionId !== makeFocusSessionId(saved)) invalidateFocusRecoveryCheck();
    return { previous, saved, completed: false };
  });
  if (completed) return saved;
  const { noteJunluoActivityChange, noteJunluoYouMessage } = await import('../life/junluoDesireRuntime');
  const activitySession = replyGuard ? saved : session;
  if (!previous || previous.mode !== activitySession.mode || previous.paused !== activitySession.paused
    || previous.baiyunActivity !== activitySession.baiyunActivity) await noteJunluoActivityChange();
  const known = new Set(previous?.logs.map(log => log.id) ?? []);
  const fresh = session.logs.filter(log => log.role === 'you' && !known.has(log.id));
  if (fresh.length) {
    await noteJunluoYouMessage(Math.max(...fresh.map(log => log.createdAt)));
    const { observeContactYouMessage } = await import('../proactive/unifiedContactStore');
    for (const message of fresh) await observeContactYouMessage({ id: message.id, createdAt: message.createdAt });
  }
  if (saved.reading) {
    const { reconcileFocusReadingSession } = await import('./focusReadingRuntime');
    const reconciled = await reconcileFocusReadingSession(saved).catch(() => saved);
    if (Platform.OS === 'android') {
      // Persisted selection/resume is the trigger, not the next hourly life check.
      // This path only prepares selected source and settles time; no model request.
      await (await import('../life/readingActivityRuntime')).runReadingActivityTick(Date.now(), false).catch(() => undefined);
    }
    return reconciled;
  }
  return saved;
}

async function readStoredActiveFocusSession() {
  const raw = await AsyncStorage.getItem(ACTIVE_FOCUS_KEY);
  if (!raw) return null;
  try {
    const session = JSON.parse(raw) as ActiveFocusSession;
    return Array.isArray(session.logs) ? session : null;
  } catch {
    return null;
  }
}

export async function loadActiveFocusSession(readOnly = false): Promise<ActiveFocusSession | null> {
  const epoch = captureBackupRestoreDataEpoch();
  if (epoch === null) return null;
  const session = await readStoredActiveFocusSession();
  if (!session || epoch !== captureBackupRestoreDataEpoch()) return null;
  const sessionId = makeFocusSessionId(session);
  // The first reader after process/backup recovery can be a background consumer.
  // Share only an in-flight query: sync can write completed history directly.
  if (!focusRecoveryCheck || focusRecoveryCheck.sessionId !== sessionId || focusRecoveryCheck.epoch !== epoch) {
    invalidateFocusRecoveryCheck();
    focusRecoveryCheck = { sessionId, epoch, history: loadFocusSessionById(sessionId) };
  }
  const check = focusRecoveryCheck;
  let completed: FocusSession | null;
  try { completed = await check.history; }
  finally {
    if (focusRecoveryCheck === check) focusRecoveryCheck = undefined;
  }
  if (epoch !== captureBackupRestoreDataEpoch()) return null;
  if (check.invalidated) return loadActiveFocusSession(readOnly);
  if (completed || session.logs.some(log => log.trigger === 'finish')) {
    if (!readOnly) await runBackupRestoreDataEpochCommit(epoch, () => clearActiveFocusSession(sessionId));
    return null;
  }
  return session;
}

/** Only refresh an existing technical failure; leave the clock and concurrent journal entries intact. */
export async function updateActiveFocusFailureReason(sessionId: string, failureId: string, content: string,
  canCommit: () => boolean, dataEpoch = captureBackupRestoreDataEpoch()) {
  return serializeFocusWrite(async () => {
    const result = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
      if (!canCommit() || await loadFocusSessionById(sessionId)) return null;
      const current = await loadActiveFocusSession(true);
      if (!current || makeFocusSessionId(current) !== sessionId || !canCommit()) return null;
      const failure = current.logs.find(log => log.id === failureId);
      if (!failure || failure.role !== 'system'
        || !['focus-opening-failed', 'focus-sleep-opening-failed', 'focus-generation-failed',
          'focus-chat-failed', 'focus-chat-save-failed'].includes(failure.trigger)) return null;
      if (isFocusGenerationFailureResolved(failure, current.logs) || current.logs.some(log => log.role === 'I'
        && log.trigger === 'focus-sleep-opening' && log.content.trim() && log.id === `${failureId}:sleep-opening-retry`)) return null;
      const next = { ...current, logs: current.logs.map(log => log.id === failureId ? { ...log, content } : log) };
      await AsyncStorage.setItem(ACTIVE_FOCUS_KEY, JSON.stringify(next));
      return next;
    });
    return result.committed ? result.value : null;
  });
}

export async function clearActiveFocusSession(expectedSessionId?: string) {
  const epoch = captureBackupRestoreDataEpoch();
  if (epoch === null) return;
  const current = await readStoredActiveFocusSession();
  if (epoch !== captureBackupRestoreDataEpoch()) return;
  if (expectedSessionId && current && makeFocusSessionId(current) !== expectedSessionId) return;
  if (current?.reading) {
    const completed = await loadFocusSessionById(makeFocusSessionId(current));
    await (await import('./focusReadingRuntime')).reconcileFocusReadingSession(current, completed?.endedAt ?? Date.now(), true,
      completed ? { session: completed, dataEpoch: epoch } : undefined);
  }
  await serializeFocusWrite(async () => {
    const latest = await readStoredActiveFocusSession();
    if (epoch !== captureBackupRestoreDataEpoch()) return;
    if (expectedSessionId && latest && makeFocusSessionId(latest) !== expectedSessionId) return;
    await AsyncStorage.removeItem(ACTIVE_FOCUS_KEY);
  });
  if (epoch !== captureBackupRestoreDataEpoch()) return;
  await (await import('../life/junluoDesireRuntime')).noteJunluoActivityChange();
}

export async function saveFocusSession(draft: FocusSessionDraft) {
  const database = await getDatabase();
  const now = Date.now();
  const normalizedUserActivity = draft.userActivity.trim();
  const normalizedBaiyunActivity = draft.baiyunActivity.trim();
  const existing = await database.getFirstAsync<FocusSessionRow>(
    `SELECT * FROM focus_sessions
     WHERE started_at = ? AND mode = ? AND user_activity = ?
     ORDER BY created_at ASC
     LIMIT 1`,
    draft.startedAt,
    draft.mode,
    normalizedUserActivity,
  );
  if (existing) {
    invalidateFocusRecoveryCheck();
    return fromSessionRow(existing);
  }

  const id = makeFocusSessionId({
    startedAt: draft.startedAt,
    mode: draft.mode,
    userActivity: normalizedUserActivity,
  });
  const session: FocusSession = {
    ...draft,
    userActivity: normalizedUserActivity,
    baiyunActivity: normalizedBaiyunActivity,
    id,
    createdAt: now,
  };
  await database.withTransactionAsync(async () => {
    await database.runAsync(
      `INSERT INTO focus_sessions
        (id, mode, user_activity, baiyun_activity, started_at, ended_at, duration_seconds, quality, heart_rate_avg, temperature_avg, created_at, review_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      session.id,
      session.mode,
      session.userActivity,
      session.baiyunActivity,
      session.startedAt,
      session.endedAt,
      session.durationSeconds,
      '', // Retired rating: keep the legacy NOT NULL column compatible with backups and sync.
      session.heartRateAvg,
      session.temperatureAvg,
      session.createdAt,
      session.review ? JSON.stringify(session.review) : null,
    );
    for (const log of draft.logs) {
      await database.runAsync(
        `INSERT INTO focus_logs (id, session_id, role, content, created_at, elapsed_seconds, trigger)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           session_id = excluded.session_id,
           role = excluded.role,
           content = excluded.content,
           created_at = excluded.created_at,
           elapsed_seconds = excluded.elapsed_seconds,
           trigger = excluded.trigger`,
        log.id,
        session.id,
        log.role,
        log.content.trim(),
        log.createdAt,
        log.elapsedSeconds,
        log.trigger,
      );
    }
  });
  invalidateFocusRecoveryCheck();
  return session;
}

export async function loadRecentFocusSessions(limit = 12) {
  const database = await getDatabase();
  const rows = await database.getAllAsync<FocusSessionRow>(
    'SELECT * FROM focus_sessions ORDER BY started_at DESC, created_at ASC LIMIT ?',
    limit * 4,
  );
  const seen = new Set<string>();
  const sessions: FocusSession[] = [];
  for (const row of rows) {
    const key = `${row.started_at}:${row.mode}:${row.user_activity}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sessions.push(fromSessionRow(row));
    if (sessions.length >= limit) break;
  }
  return sessions;
}

export async function loadFocusSessionById(sessionId: string) {
  const database = await getDatabase();
  const row = await database.getFirstAsync<FocusSessionRow>(
    'SELECT * FROM focus_sessions WHERE id = ? LIMIT 1',
    sessionId,
  );
  return row ? fromSessionRow(row) : null;
}

/** Metadata only. Logs and summaries are loaded after a scene is opened. */
export async function loadFocusSessionsInRange(from: number, to: number) {
  const database = await getDatabase();
  const rows = await database.getAllAsync<FocusSessionRow>(
    `SELECT * FROM focus_sessions WHERE started_at < ? AND (ended_at > ? OR started_at >= ?)
     ORDER BY started_at ASC, created_at ASC`, to, from, from,
  );
  const seen = new Set<string>();
  return rows.filter(row => {
    const identity = `${row.started_at}:${row.mode}:${row.user_activity}`;
    if (seen.has(identity)) return false;
    seen.add(identity); return true;
  }).map(fromSessionRow);
}

/** One metadata row, not the full archive or its logs. Include empty years between records. */
export async function loadFocusHistoryYears() {
  const row = await (await getDatabase()).getFirstAsync<{ first_at: number | null; last_at: number | null }>(
    `SELECT MIN(started_at) AS first_at,
      MAX(CASE WHEN ended_at > started_at THEN ended_at - 1 ELSE started_at END) AS last_at
     FROM focus_sessions`,
  );
  if (row?.first_at == null || row.last_at == null) return [];
  const first = new Date(row.first_at).getFullYear(), last = new Date(row.last_at).getFullYear();
  if (!Number.isFinite(first) || !Number.isFinite(last) || last < first) return [];
  return Array.from({ length: last - first + 1 }, (_, index) => last - index);
}

export async function loadFocusLogs(sessionId: string) {
  const database = await getDatabase();
  const rows = await database.getAllAsync<FocusLogRow>(
    'SELECT * FROM focus_logs WHERE session_id = ? ORDER BY created_at ASC',
    sessionId,
  );
  return rows.map(fromLogRow);
}

export async function loadFocusOrganization(sessionId: string) {
  const row = await (await getDatabase()).getFirstAsync<FocusLogRow>(
    "SELECT * FROM focus_logs WHERE id = ? AND session_id = ? AND role = 'I' AND trigger = ? LIMIT 1",
    focusOrganizationLogId(sessionId), sessionId, FOCUS_ORGANIZATION_TRIGGER,
  );
  return row ? parseFocusOrganizationRecord(row.content) : null;
}

/** Review drafts do not expire with the 24-hour proactive material window. */
export async function loadFocusReviewRecords() {
  const rows = await (await getDatabase()).getAllAsync<FocusSessionRow & { organization_content: string }>(
    `SELECT s.*, l.content AS organization_content FROM focus_sessions s JOIN focus_logs l ON l.session_id = s.id
     WHERE l.id = s.id || ':organization' AND l.role = 'I' AND l.trigger = ?
     ORDER BY s.ended_at DESC, s.created_at ASC, s.id ASC`, FOCUS_ORGANIZATION_TRIGGER,
  );
  return rows.flatMap(row => {
    const record = parseFocusOrganizationRecord(row.organization_content);
    return record?.candidates?.length ? [{ session: fromSessionRow(row), record }] : [];
  });
}

/** One derived result per saved scene; retries may only complete a previously failed part. */
export async function saveFocusOrganization(
  sessionId: string, input: FocusOrganizationRecord, dataEpoch = captureBackupRestoreDataEpoch(),
) {
  const incoming = parseFocusOrganizationRecord(JSON.stringify(input));
  if (!incoming) throw new Error('Invalid focus organization result');
  return serializeFocusWrite(async () => {
    const result = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
      const database = await getDatabase();
      const session = await loadFocusSessionById(sessionId);
      if (!session) return null;
      const existing = await loadFocusOrganization(sessionId);
      const next: FocusOrganizationRecord = existing ? {
        version: 1, summary: existing.summary.trim() ? existing.summary : incoming.summary,
        candidates: existing.candidates ?? incoming.candidates, registered: existing.registered,
      } : { ...incoming, registered: false };
      const content = JSON.stringify(next);
      if (content.length > 40_000) throw new Error('Focus organization result exceeds sync limit');
      if (existing && content === JSON.stringify(existing)) return existing;
      await database.runAsync(
        `INSERT INTO focus_logs (id, session_id, role, content, created_at, elapsed_seconds, trigger)
         SELECT ?, id, 'I', ?, ?, duration_seconds, ? FROM focus_sessions WHERE id = ?
         ON CONFLICT(id) DO UPDATE SET content = excluded.content
         WHERE focus_logs.session_id = excluded.session_id AND focus_logs.role = 'I'
           AND focus_logs.trigger = excluded.trigger`,
        focusOrganizationLogId(sessionId), content, Date.now(), FOCUS_ORGANIZATION_TRIGGER, sessionId,
      );
      return loadFocusOrganization(sessionId);
    });
    return result.committed ? result.value : null;
  });
}

export async function markFocusOrganizationRegistered(sessionId: string, dataEpoch = captureBackupRestoreDataEpoch()) {
  return serializeFocusWrite(async () => {
    const result = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
      const record = await loadFocusOrganization(sessionId);
      if (!record || record.candidates === undefined || record.registered) return record;
      await (await getDatabase()).runAsync(
        "UPDATE focus_logs SET content = ? WHERE id = ? AND session_id = ? AND role = 'I' AND trigger = ?",
        JSON.stringify({ ...record, registered: true }), focusOrganizationLogId(sessionId), sessionId, FOCUS_ORGANIZATION_TRIGGER,
      );
      return loadFocusOrganization(sessionId);
    });
    return result.committed ? result.value : null;
  });
}

export async function loadFocusSummaryById(sessionId: string, now = Date.now()) {
  const session = await loadFocusSessionById(sessionId);
  if (!session || session.endedAt <= session.startedAt || session.endedAt > now
    || now - session.endedAt >= FOCUS_SUMMARY_RECENT_MS) return null;
  const record = await loadFocusOrganization(sessionId);
  return record?.summary.trim() ? { session, record } : null;
}

export async function loadLatestFocusSummary(now = Date.now()) {
  const row = await (await getDatabase()).getFirstAsync<FocusSessionRow>(
    `SELECT s.* FROM focus_sessions s JOIN focus_logs l ON l.session_id = s.id
     WHERE l.id = s.id || ':organization' AND l.role = 'I' AND l.trigger = ?
       AND s.ended_at > s.started_at AND s.ended_at <= ? AND s.ended_at > ?
       AND json_valid(l.content) AND json_extract(l.content, '$.version') = 1
       AND json_type(l.content, '$.summary') = 'text' AND length(trim(json_extract(l.content, '$.summary'))) > 0
       AND json_type(l.content, '$.registered') IN ('true', 'false')
     ORDER BY s.ended_at DESC, s.created_at ASC, s.id ASC LIMIT 1`,
    FOCUS_ORGANIZATION_TRIGGER, now, now - FOCUS_SUMMARY_RECENT_MS,
  );
  return row ? loadFocusSummaryById(row.id, now) : null;
}

/** Resolve an exact saved source in the active discussion or its completed history. */
export async function findFocusConversationContainingMessage(messageId: string, readOnly = false) {
  const active = await loadActiveFocusSession(readOnly);
  if (active?.logs.some((log) => log.id === messageId && !isFocusOrganizationLog(log) && (log.role === 'I' || log.role === 'you'))) {
    return { sessionId: makeFocusSessionId(active), logs: active.logs };
  }
  const database = await getDatabase();
  const row = await database.getFirstAsync<{ session_id: string }>(
    'SELECT session_id FROM focus_logs WHERE id = ? AND trigger != ? LIMIT 1', messageId, FOCUS_ORGANIZATION_TRIGGER,
  );
  if (!row || !await loadFocusSessionById(row.session_id)) return null;
  return { sessionId: row.session_id, logs: await loadFocusLogs(row.session_id) };
}

export async function deleteFocusSession(sessionId: string) {
  const database = await getDatabase();
  await database.withTransactionAsync(async () => {
    await database.runAsync('DELETE FROM focus_logs WHERE session_id = ?', sessionId);
    await database.runAsync('DELETE FROM focus_sessions WHERE id = ?', sessionId);
  });
}

export async function exportFocusDatabase() {
  const database = await getDatabase();
  return database.serializeAsync();
}

export async function importFocusDatabase(sourceFile: DatabaseImportSource) {
  await closeFocusDatabase();
  const source = await openDatabaseImportSource(sourceFile);
  const SQLite = await import('expo-sqlite');
  const destination = await SQLite.openDatabaseAsync('junluo-focus.db');
  try {
    await SQLite.backupDatabaseAsync({ sourceDatabase: source, destDatabase: destination });
  } finally {
    await source.closeAsync();
    await destination.closeAsync();
  }
}

export async function clearFocusDatabase() {
  const database = await getDatabase();
  await database.execAsync('DELETE FROM focus_logs; DELETE FROM focus_sessions;');
}

export async function savePendingFocusInvite(invite: PendingFocusInvite) {
  await serializeFocusWrite(() => AsyncStorage.setItem(PENDING_INVITE_KEY, JSON.stringify(invite)));
}

export async function loadPendingFocusInvite() {
  const raw = await AsyncStorage.getItem(PENDING_INVITE_KEY);
  if (!raw) return null;
  try {
    const invite = JSON.parse(raw) as PendingFocusInvite | null;
    return invite && (invite.mode === 'cowork' || invite.mode === 'support')
      && typeof invite.baiyunActivity === 'string' ? invite : null;
  } catch {
    return null;
  }
}

export async function takePendingFocusInvite(expected: PendingFocusInvite) {
  return serializeFocusWrite(async () => {
    const current = await loadPendingFocusInvite();
    if (!current || JSON.stringify(current) !== JSON.stringify(expected)) return false;
    await AsyncStorage.removeItem(PENDING_INVITE_KEY);
    return true;
  });
}

export async function canOfferFocusInvite(now = Date.now()) {
  const raw = await AsyncStorage.getItem(LAST_INVITE_OFFERED_AT_KEY);
  const last = raw ? Number(raw) : 0;
  return !Number.isFinite(last) || now - last >= INVITE_COOLDOWN_MS;
}

export async function markFocusInviteOffered(now = Date.now()) {
  await AsyncStorage.setItem(LAST_INVITE_OFFERED_AT_KEY, String(now));
}
