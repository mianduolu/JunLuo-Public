/** Necessary continuation data in the existing tool execution record. */
export type UserRoutineKind = 'wake' | 'breakfast' | 'lunch' | 'nap' | 'dinner' | 'sleep';
export type UserRoutinePatch = { date: string } & Partial<Record<UserRoutineKind, { time?: string; minutes?: number; enabled?: boolean }>>;
export type UserRoutineSaveState = {
  version: 1; operationId: string; dataEpoch: number; attempts: number;
  stage: 'pending' | 'complete' | 'failed' | 'unknown'; updatedAt: number;
  expectedVersion: string; patch: UserRoutinePatch; globalEnabled?: boolean; timeZone: string;
  /** Existing settings-page fields (including breaks), not a second routine store. */
  fullTemplate?: Record<string, unknown>;
  source?: { sessionId: string; messageId: string; revision: string };
};

/** Field order in JSON transport is not part of a saved operation's identity. */
export function userRoutineIdentity(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item) ?? 'undefined';
}

function validPageTemplate(value: Record<string, unknown>) {
  const allowed = ['version', 'enabled', 'wakeTime', 'sleepTime', 'wakeEnabled', 'sleepEnabled', 'operationId',
    'breakfast', 'lunch', 'dinner', 'nap', 'autoBreaks', 'focusBreakMinutes', 'physicalBreakMinutes'];
  const clock = (input: unknown) => typeof input === 'string' && (input === '' || /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input));
  if (Object.keys(value).some(key => !allowed.includes(key)) || value.version !== 1 || typeof value.enabled !== 'boolean'
    || !clock(value.wakeTime) || !clock(value.sleepTime) || typeof value.autoBreaks !== 'boolean'
    || [value.focusBreakMinutes, value.physicalBreakMinutes].some(minutes => !Number.isSafeInteger(minutes) || Number(minutes) < 0 || Number(minutes) > 60)
    || ['wakeEnabled', 'sleepEnabled'].some(key => value[key] !== undefined && typeof value[key] !== 'boolean')
    || value.operationId !== undefined && (typeof value.operationId !== 'string' || !value.operationId)) return false;
  for (const kind of ['breakfast', 'lunch', 'dinner', 'nap']) {
    const item = value[kind] as Record<string, unknown> | undefined;
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key =>
      !['enabled', 'startTime', 'durationMinutes', ...(kind === 'nap' ? ['endTime'] : [])].includes(key))
      || typeof item.enabled !== 'boolean' || !clock(item.startTime) || kind === 'nap' && !clock(item.endTime)
      || item.durationMinutes !== undefined && (!Number.isSafeInteger(item.durationMinutes) || Number(item.durationMinutes) <= 0)) return false;
  }
  return true;
}

export function normalizeUserRoutineSave(value: unknown): UserRoutineSaveState | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const state = value as UserRoutineSaveState;
  if (state.version !== 1 || typeof state.operationId !== 'string' || !state.operationId || !Number.isSafeInteger(state.dataEpoch)
    || !Number.isInteger(state.attempts) || state.attempts < 0 || state.attempts > 4
    || !['pending', 'complete', 'failed', 'unknown'].includes(state.stage) || !Number.isFinite(state.updatedAt)
    || typeof state.expectedVersion !== 'string' || typeof state.timeZone !== 'string'
    || !state.patch || typeof state.patch !== 'object' || Array.isArray(state.patch)) return undefined;
  const validDate = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const at = new Date(`${value}T12:00:00Z`);
    return Number.isFinite(at.getTime()) && at.toISOString().slice(0, 10) === value;
  };
  if (state.patch.date !== 'usual' && !validDate(state.patch.date)) return undefined;
  if (state.globalEnabled !== undefined && (typeof state.globalEnabled !== 'boolean' || state.patch.date !== 'usual')) return undefined;
  const patch: UserRoutinePatch = { date: state.patch.date };
  const kinds = ['wake', 'breakfast', 'lunch', 'nap', 'dinner', 'sleep'] as const;
  if (Object.keys(state.patch).some(key => key !== 'date' && !kinds.includes(key as UserRoutineKind))) return undefined;
  for (const kind of kinds) {
    const item = state.patch[kind];
    if (item === undefined) continue;
    if (!item || typeof item !== 'object' || Array.isArray(item) || !Object.keys(item).length
      || Object.keys(item).some(key => !['time', 'minutes', 'enabled'].includes(key))
      || item.enabled !== undefined && typeof item.enabled !== 'boolean'
      || item.time !== undefined && (typeof item.time !== 'string' || !(state.patch.date === 'usual'
        ? /^(?:[01]\d|2[0-3]):[0-5]\d$/ : /^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d$/).test(item.time))
      || item.minutes !== undefined && (kind === 'wake' || kind === 'sleep' || !Number.isSafeInteger(item.minutes) || item.minutes <= 0)) return undefined;
    if (state.patch.date !== 'usual' && item.time && !validDate(item.time.slice(0, 10))) return undefined;
    patch[kind] = { ...item };
  }
  if (state.fullTemplate !== undefined && (!state.fullTemplate || typeof state.fullTemplate !== 'object'
    || Array.isArray(state.fullTemplate) || !validPageTemplate(state.fullTemplate)
    || state.patch.date !== 'usual' || state.globalEnabled !== undefined)) return undefined;
  if (Object.keys(patch).length === 1 && state.globalEnabled === undefined && state.fullTemplate === undefined) return undefined;
  if (state.source !== undefined && (!state.source || typeof state.source !== 'object' || Array.isArray(state.source)
    || Object.keys(state.source).some(key => !['sessionId', 'messageId', 'revision'].includes(key))
    || typeof state.source.sessionId !== 'string' || typeof state.source.messageId !== 'string' || typeof state.source.revision !== 'string')) return undefined;
  return { version: 1, operationId: state.operationId, dataEpoch: state.dataEpoch, attempts: state.attempts,
    stage: state.stage, updatedAt: state.updatedAt, expectedVersion: state.expectedVersion, patch, timeZone: state.timeZone,
    ...(state.globalEnabled !== undefined ? { globalEnabled: state.globalEnabled } : {}),
    ...(state.fullTemplate ? { fullTemplate: { ...state.fullTemplate } } : {}), ...(state.source ? { source: state.source } : {}) };
}

export function mergeUserRoutineSaves(left: UserRoutineSaveState | undefined, right: UserRoutineSaveState | undefined): UserRoutineSaveState | undefined {
  if (!left || !right) return left ?? right;
  if (left.operationId !== right.operationId || left.dataEpoch !== right.dataEpoch || left.expectedVersion !== right.expectedVersion
    || left.timeZone !== right.timeZone || left.globalEnabled !== right.globalEnabled
    || userRoutineIdentity(left.patch) !== userRoutineIdentity(right.patch) || userRoutineIdentity(left.fullTemplate) !== userRoutineIdentity(right.fullTemplate)
    || userRoutineIdentity(left.source) !== userRoutineIdentity(right.source)) {
    throw new Error('routine-save-identity-mismatch');
  }
  const selected = left.stage === 'complete' ? left : right.stage === 'complete' ? right
    : left.stage === 'failed' ? left : right.stage === 'failed' ? right : left.updatedAt >= right.updatedAt ? left : right;
  return { ...selected, attempts: Math.max(left.attempts, right.attempts), updatedAt: Math.max(left.updatedAt, right.updatedAt) };
}
