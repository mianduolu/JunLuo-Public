import type { OwnedDayPlanInputEntry, OwnedDayPlanBatch } from './ownedDayPlanStore';
import { mergeOwnScheduleSaves } from './ownScheduleSaveState';
import type { JunLuoToolResult } from '../tools/toolTypes';

export type OwnDayPlanBounds = { startAt: number; endAt: number; timeZone: string };
export type OwnDayPlanPaper = { entries: OwnedDayPlanInputEntry[]; cancelIds: string[]; prepareIds: string[] };
export type OwnDayPlanPaperCorrection = {
  content: string; checks: Array<{ path: string; code: string }>; requestId: string; attempted: boolean;
};
export const OWN_DAY_PLAN_NORMAL_REQUEST_LIMIT = 3;
export const OWN_DAY_PLAN_CORRECTION_REQUEST_LIMIT = 4;
export const OWN_DAY_PLAN_PAPER_MAX_LENGTH = 32000;
export type OwnDayPlanToolReceipt = {
  callId: string; toolId: string; input: Record<string, unknown>; result: JunLuoToolResult;
};
export type OwnDayPlanRun = {
  id: string;
  status: 'ready' | 'requesting' | 'waiting' | 'saving' | 'complete' | 'failed';
  createdAt: number; updatedAt: number;
  bounds: OwnDayPlanBounds;
  requestCount: number; saveAttempts: number;
  requestId?: string; retryAt?: number; reason?: string;
  errorDiagnostic?: { stage: string; errorName: string; code: string; httpStatus?: number; transportOutcome?: string };
  paperCorrection?: OwnDayPlanPaperCorrection;
  scheduleVersions: Record<string, number>;
  habitVersions: Record<string, number>;
  readingVersions: Record<string, number>;
  readingLabels?: Record<string, string>;
  expectedChoiceVersions?: Record<string, number>;
  sleepRevision: number;
  tools?: OwnDayPlanToolReceipt[];
  pendingTool?: { callId: string; toolId: string; input: Record<string, unknown>; createdAt: number };
  requests?: Array<{ id: string; startedAt: number; endedAt?: number; outcome: string; promptTokens?: number; completionTokens?: number }>;
  batch?: OwnedDayPlanBatch;
  prepareIds?: string[];
};
export function getOwnDayPlanRequestLimit(run: Pick<OwnDayPlanRun, 'paperCorrection'>) {
  return run.paperCorrection ? OWN_DAY_PLAN_CORRECTION_REQUEST_LIMIT : OWN_DAY_PLAN_NORMAL_REQUEST_LIMIT;
}
export function mergeOwnDayPlanNight(a: OwnDayPlanNight | undefined, b: OwnDayPlanNight | undefined): OwnDayPlanNight | undefined {
  if (!a || !b) return a ?? b;
  const result: OwnDayPlanNight = { ...(a.restoredAt || b.restoredAt ? { restoredAt: Math.max(a.restoredAt ?? 0, b.restoredAt ?? 0) } : {}) };
  for (const phase of ['prepare', 'wake'] as const) {
    const left = a[phase], right = b[phase];
    if (!left || !right) { result[phase] = left ?? right; continue; }
    const terminal = (run: OwnDayPlanRun) => run.status === 'complete' || run.status === 'failed';
    const selected = left.status === 'complete' ? left : right.status === 'complete' ? right
      : terminal(left) !== terminal(right) ? terminal(left) ? left : right : left.updatedAt >= right.updatedAt ? left : right;
    const requests = mergeOwnDayPlanRequests(left.requests, right.requests);
    const batch = left.batch && right.batch && left.batch.opId === right.batch.opId
      ? mergeOwnScheduleSaves({ version: 1, dataEpoch: 0, batch: left.batch, attempts: left.saveAttempts,
        stage: left.status === 'complete' ? 'complete' : left.status === 'failed' ? 'failed' : 'pending', updatedAt: left.updatedAt },
      { version: 1, dataEpoch: 0, batch: right.batch, attempts: right.saveAttempts,
        stage: right.status === 'complete' ? 'complete' : right.status === 'failed' ? 'failed' : 'pending', updatedAt: right.updatedAt })!.batch
      : selected.batch;
    result[phase] = { ...selected, ...(requests ? { requests } : {}),
      ...(batch ? { batch } : {}),
      requestCount: requests ? requests.filter(request => request.outcome !== 'not-started').length : Math.max(left.requestCount, right.requestCount),
      saveAttempts: Math.max(left.saveAttempts, right.saveAttempts) };
  }
  return result;
}
export type OwnDayPlanNight = { prepare?: OwnDayPlanRun; wake?: OwnDayPlanRun; restoredAt?: number };

export function mergeOwnDayPlanRequests(a: OwnDayPlanRun['requests'], b: OwnDayPlanRun['requests']) {
  if (!a && !b) return undefined;
  const result = new Map<string, NonNullable<OwnDayPlanRun['requests']>[number]>();
  for (const request of [...(a ?? []), ...(b ?? [])]) {
    const old = result.get(request.id);
    if (!old || (request.endedAt ?? 0) >= (old.endedAt ?? 0)) result.set(request.id, request);
  }
  return [...result.values()];
}

export function restoreOwnDayPlanProgress(current: Record<string, string>, incoming: Record<string, string>, now: number) {
  const next = { ...incoming };
  for (const [key, raw] of Object.entries(incoming)) {
    if (!key.startsWith('junluo.assistant.lifeDay.')) continue;
    const day = JSON.parse(raw);
    if (!day?.nightSleepPlan) continue;
    const old = current[key] ? JSON.parse(current[key]) : undefined;
    const state = mergeOwnDayPlanNight(old?.nightSleepPlan?.dayPlan, day.nightSleepPlan.dayPlan) ?? {};
    state.restoredAt = Math.max(state.restoredAt ?? 0, now);
    for (const phase of ['prepare', 'wake'] as const) {
      const run = state[phase];
      if (run?.paperCorrection) state[phase] = { ...run, paperCorrection: undefined };
      if (run && run.status !== 'complete' && run.status !== 'failed') state[phase] = { ...run,
        status: run.batch ? 'saving' : 'failed', updatedAt: Math.max(now, run.updatedAt + 1),
        pendingTool: undefined, paperCorrection: undefined, retryAt: undefined, reason: 'data-restored' };
    }
    day.nightSleepPlan.dayPlan = state;
    next[key] = JSON.stringify(day);
  }
  return next;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid-day-plan-object');
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('invalid-day-plan-field');
}
export function ownDayPlanIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !id.trim())) throw new Error('invalid-day-plan-ids');
  if (new Set(value).size !== value.length) throw new Error('duplicate-day-plan-id');
  return value;
}

/** Captured IANA zone, not the device's possibly changed zone when a response arrives. */
export function formatOwnDayPlanTime(at: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const get = (key: string) => parts.find(part => part.type === key)!.value;
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}
export function parseOwnDayPlanTime(value: unknown, timeZone: string): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(value)) throw new Error('invalid-day-plan-time');
  const [year, month, day, hour, minute] = value.split(/[- :]/).map(Number);
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const checked = new Date(wall);
  if (checked.getUTCFullYear() !== year || checked.getUTCMonth() !== month - 1 || checked.getUTCDate() !== day
    || hour > 23 || minute > 59) throw new Error('invalid-day-plan-time');
  let instant = wall;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const rendered = formatOwnDayPlanTime(instant, timeZone);
    if (rendered === value) return instant;
    const [y, m, d, h, min] = rendered.split(/[- :]/).map(Number);
    instant += wall - Date.UTC(y, m - 1, d, h, min);
  }
  // Nonexistent local times (a DST gap) must not silently shift an appointment.
  throw new Error('invalid-day-plan-local-time');
}

export function parseOwnScheduleEntries(value: unknown, bounds: OwnDayPlanBounds, withOwner = false): OwnedDayPlanInputEntry[] {
  if (!Array.isArray(value)) throw new Error('invalid-day-plan-entries');
  const labels = new Set<string>();
  return value.map(raw => {
    const item = object(raw);
    keys(item, ['id', 'title', 'startAt', 'minutes', 'readingId', 'habitId', 'localId', 'continueFrom', 'nextReadingId', ...(withOwner ? ['owner'] : [])]);
    const continuing = item.continueFrom !== undefined;
    // A new reading has no prior next choice to preserve. Omission selects nothing.
    const nextReadingId = !continuing && (!withOwner || item.owner === 'I') && item.id === null && typeof item.readingId === 'string'
      && item.nextReadingId === undefined ? null : item.nextReadingId;
    if (continuing && (Object.hasOwn(item, 'readingId') || Object.hasOwn(item, 'nextReadingId'))) {
      throw new Error('接着已有安排做和重新选择内容，只能填写一种。这次接续还没保存。');
    }
    for (const key of ['localId', 'continueFrom']) if (item[key] !== undefined
      && (typeof item[key] !== 'string' || !/^r[1-9]\d*$/.test(item[key] as string))) throw new Error('invalid-reading-label');
    if (typeof item.localId === 'string') {
      if (labels.has(item.localId)) throw new Error(`标签 ${item.localId} 对应了不止一项安排，无法确定要接着哪项做，这次接续还没保存。`);
      labels.add(item.localId);
    }
    if (!(item.id === null || typeof item.id === 'string' && item.id.trim())
      || typeof item.title !== 'string' || !item.title.trim()
      || !continuing && !(item.readingId === null || typeof item.readingId === 'string' && item.readingId.trim())
      || nextReadingId !== undefined && !(nextReadingId === null || typeof nextReadingId === 'string' && nextReadingId.trim())
      || item.id === null && (!withOwner || item.owner === 'I') && typeof item.readingId === 'string' && nextReadingId === undefined
      || item.readingId === null && (item.localId !== undefined || item.nextReadingId !== undefined)
      || item.habitId !== undefined && (typeof item.habitId !== 'string' || !item.habitId.trim())) throw new Error('invalid-day-plan-entry');
    const owner = withOwner ? item.owner : 'I';
    if (owner !== 'I' && owner !== 'I 和 you') throw new Error('schedule-owner-forbidden');
    if (owner !== 'I' && (continuing || item.localId !== undefined || item.nextReadingId !== undefined)) throw new Error('schedule-owner-forbidden');
    const startAt = item.startAt === undefined ? undefined : parseOwnDayPlanTime(item.startAt, bounds.timeZone);
    const minutes = item.minutes === undefined ? undefined : Number(item.minutes);
    if (item.minutes !== undefined && (typeof item.minutes !== 'number' || !Number.isSafeInteger(minutes)
      || minutes! <= 0 || !Number.isSafeInteger(minutes! * 60_000))) throw new Error('invalid-day-plan-minutes');
    if (item.id === null && (startAt === undefined || minutes === undefined)) throw new Error('invalid-day-plan-entry');
    // Existing entries are checked against their actual plan and freshly settled activity at save time.
    // An unchanged original start may legitimately precede this paper's planning window.
    if (item.id === null && (startAt! < bounds.startAt || startAt! + minutes! * 60_000 > bounds.endAt
      || !Number.isSafeInteger(startAt! + minutes! * 60_000))) throw new Error('day-plan-outside-range');
    return { id: item.id as string | null, title: item.title, owner,
      ...(startAt !== undefined ? { startAt } : {}), ...(minutes !== undefined ? { minutes } : {}),
      ...(continuing ? { continueFrom: item.continueFrom as string } : { readingId: item.readingId as string | null }),
      ...(item.localId !== undefined ? { localId: item.localId as string } : {}),
      ...(nextReadingId !== undefined ? { nextReadingId: nextReadingId as string | null } : {}),
      ...(item.habitId ? { habitId: item.habitId as string } : {}) };
  });
}
/** Copy only unambiguous format omissions; semantic validation remains in the strict parser. */
export function normalizeOwnDayPlanPaperFormat(value: unknown): unknown {
  const row = (item: unknown): item is Record<string, unknown> => item !== null && typeof item === 'object' && !Array.isArray(item);
  if (!row(value) || !Array.isArray(value.entries)) return value;
  const entries = value.entries.map(item => row(item) ? { ...item } : item);
  const hasContinuation = entries.some(item => row(item) && item.continueFrom != null);
  for (const item of entries) {
    if (!row(item)) continue;
    if (item.continueFrom === null) delete item.continueFrom;
    // On an existing item omission preserves its habit, so an explicit null stays invalid.
    if (item.id === null && item.habitId === null) delete item.habitId;
    if (item.readingId === null) {
      if (!hasContinuation && (item.localId === null
        || typeof item.localId === 'string' && /^r[1-9]\d*$/.test(item.localId))) delete item.localId;
      if (item.nextReadingId === null) delete item.nextReadingId;
    } else if (typeof item.readingId === 'string' && item.readingId.trim() && item.localId === null) {
      delete item.localId;
    }
  }
  return { ...value, entries };
}

export function parseOwnDayPlan(value: unknown, bounds: OwnDayPlanBounds): OwnDayPlanPaper {
  const record = object(value);
  keys(record, ['entries', 'cancelIds', 'prepareIds']);
  const entries = parseOwnScheduleEntries(record.entries, bounds);
  const cancelIds = ownDayPlanIds(record.cancelIds);
  const prepareIds = ownDayPlanIds(record.prepareIds);
  const targets = [...entries.flatMap(entry => entry.id ? [entry.id] : []), ...cancelIds];
  if (new Set(targets).size !== targets.length) throw new Error('duplicate-schedule-target');
  return { entries, cancelIds, prepareIds };
}

/** Reports rejected fields only; the original parser remains the acceptance boundary. */
export function collectOwnDayPlanPaperChecks(value: unknown, bounds: OwnDayPlanBounds, reason: string): OwnDayPlanPaperCorrection['checks'] {
  const checks: Array<{ path: string; code: string; category: string }> = [];
  const seen = new Set<string>(), labels = new Map<string, string>();
  const add = (path: string, code: string, category = code) => {
    const key = `${path}:${code}`;
    if (!seen.has(key)) { seen.add(key); checks.push({ path, code, category }); }
  };
  if (!['invalid-day-plan-entry', 'day-plan-outside-range', 'invalid-reading-label',
    'day-plan-mixed-reading-choice', 'day-plan-duplicate-reading-label'].includes(reason)) add('$', reason);
  const entries = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>).entries : undefined;
  if (Array.isArray(entries)) for (const [index, raw] of entries.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>, path = `entries[${index}]`;
    if (!Object.hasOwn(item, 'id')) add(`${path}.id`, 'missing-id');
    if (item.continueFrom === undefined && !Object.hasOwn(item, 'readingId')) add(`${path}.readingId`, 'missing-reading-id');
    if (item.continueFrom !== undefined && (Object.hasOwn(item, 'readingId') || Object.hasOwn(item, 'nextReadingId'))) {
      add(`${path}.continueFrom`, 'day-plan-mixed-reading-choice', 'mixed-continueFrom');
      for (const key of ['readingId', 'nextReadingId']) if (Object.hasOwn(item, key)) {
        add(`${path}.${key}`, 'day-plan-mixed-reading-choice', `mixed-${key}`);
      }
    }
    for (const key of ['localId', 'continueFrom']) if (item[key] !== undefined
      && (typeof item[key] !== 'string' || !/^r[1-9]\d*$/.test(item[key] as string))) {
      add(`${path}.${key}`, 'invalid-reading-label', `invalid-${key}`);
    }
    if (typeof item.localId === 'string' && /^r[1-9]\d*$/.test(item.localId)) {
      const first = labels.get(item.localId);
      if (first) {
        add(first, 'day-plan-duplicate-reading-label', 'duplicate-first');
        add(`${path}.localId`, 'day-plan-duplicate-reading-label', 'duplicate-later');
      } else labels.set(item.localId, `${path}.localId`);
    }
    if (item.localId !== undefined && item.continueFrom === undefined
      && !(typeof item.readingId === 'string' && item.readingId.trim())) add(`${path}.localId`, 'reading-label-requires-reading');
    if (item.readingId === null) for (const key of ['localId', 'nextReadingId']) if (item[key] !== undefined) {
      add(`${path}.${key}`, 'invalid-day-plan-entry', `non-reading-${key}`);
    }
    if (item.habitId !== undefined && (typeof item.habitId !== 'string' || !item.habitId.trim())) {
      add(`${path}.habitId`, 'invalid-day-plan-entry', 'invalid-habitId');
    }
    if ((item.id === null || !Object.hasOwn(item, 'id')) && typeof item.minutes === 'number' && Number.isSafeInteger(item.minutes)
      && item.minutes > 0 && Number.isSafeInteger(item.minutes * 60_000)) {
      let startAt: number | undefined;
      try { startAt = parseOwnDayPlanTime(item.startAt, bounds.timeZone); }
      catch (error) {
        if (!(error instanceof Error) || !['invalid-day-plan-time', 'invalid-day-plan-local-time'].includes(error.message)) throw error;
      }
      if (startAt !== undefined && (startAt < bounds.startAt || startAt + item.minutes * 60_000 > bounds.endAt
        || !Number.isSafeInteger(startAt + item.minutes * 60_000))) add(`${path}.startAt`, 'new-entry-outside-window');
    }
  }
  if (!checks.length) add('$', reason);
  const categories = new Set<string>();
  const selected = checks.length <= 16 ? checks : checks.filter(check => {
    if (categories.has(check.category)) return false;
    categories.add(check.category); return true;
  }).slice(0, 16);
  const chosen = new Set(selected);
  for (const check of checks) if (selected.length < 16 && !chosen.has(check)) selected.push(check);
  return selected.map(({ path, code }) => ({ path, code }));
}

export function selectOwnDayPlanOpportunity(input: {
  now: number; enabledAt: number; sleepAt: number; wakeAt: number; sleeping: boolean; actualWakeAt?: number;
  state?: { prepare?: Pick<OwnDayPlanRun, 'status' | 'batch'>; wake?: Pick<OwnDayPlanRun, 'status' | 'batch'> };
}): 'prepare' | 'wake' | undefined {
  if (input.sleeping || input.now < input.enabledAt) return undefined;
  // A legally parsed, pending save belongs to its original opportunity, even after waking.
  for (const phase of ['prepare', 'wake'] as const) if (input.state?.[phase]?.status === 'saving') return phase;
  if (input.state?.prepare?.batch || input.state?.wake?.batch) return undefined;
  if (input.state?.prepare?.status === 'complete' || input.state?.wake?.status === 'complete') return undefined;
  if (input.actualWakeAt !== undefined) {
    if (input.actualWakeAt < input.enabledAt || input.state?.wake?.status === 'failed') return undefined;
    return 'wake';
  }
  if (input.sleepAt < input.enabledAt || input.now < input.sleepAt - 30 * 60_000 || input.now >= input.sleepAt
    || input.state?.prepare?.status === 'failed') return undefined;
  return 'prepare';
}
