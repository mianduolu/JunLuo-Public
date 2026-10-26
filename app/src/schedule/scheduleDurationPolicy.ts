import type { ScheduleExecution, ScheduleItem } from './scheduleStore';
import type { ScheduleDurationIntent } from './ownScheduleSaveState';
export type { ScheduleDurationIntent, ScheduleSaveConflict } from './ownScheduleSaveState';

/** Stored intent, never a model-provided end time. Legacy entries have no duration. */
export type ScheduleSaveContext = {
  now: number; executions: Record<string, ScheduleExecution>;
  activityReadingIds?: Record<string, string>;
  sleepIntervals: Array<{ start: number; end: number; title?: string }>;
  /** Pure clock projection over already-read facts; never reads storage under SQL's lock. */
  at?: (now: number) => ScheduleSaveContext;
};
export type ScheduleDurationReceipt = {
  operationId: string; effectiveAt: number; elapsedMs: number; remainingMs: number;
  startAt: number; endAt: number; execution: ScheduleExecution;
};
const validDate = (n: number) => Number.isSafeInteger(n) && n >= 0 && n <= 8.64e15;

export function resolveScheduleDuration(input: { id: string; startAt: number; duration: ScheduleDurationIntent },
  item: ScheduleItem | null, context: ScheduleSaveContext): ScheduleDurationReceipt {
  const { minutes, changeStart, planningStartAt, planningEndAt } = input.duration;
  if (minutes !== undefined && (!Number.isSafeInteger(minutes) || minutes <= 0)) throw new Error('invalid-day-plan-time');
  if (!item && minutes === undefined) throw new Error('invalid-day-plan-time');
  if (item?.status === 'cancelled') throw new Error('schedule-duration-cancelled');
  const prior = item ? context.executions[item.id] ?? item.execution : undefined;
  if (item?.status === 'completed' || item?.execution?.status === 'completed' || prior?.status === 'completed'
    || (item?.execution?.status === 'ended' || prior?.status === 'ended') && (minutes !== undefined || !changeStart)) throw new Error('schedule-duration-ended');
  if (item?.execution && context.executions[item.id] && ((item.execution.planRevision ?? 0) !== (prior?.planRevision ?? 0)
    || item.execution.activityId !== prior?.activityId)) throw new Error('schedule-target-changed');
  if (prior?.adjustment?.pending || prior?.durationChange?.pending) throw new Error('schedule-adjustment-pending');
  const elapsedMs = prior?.elapsedMs ?? 0;
  const remainingMs = minutes === undefined
    ? Math.max(0, (prior?.totalPlannedMs ?? ((item?.endAt ?? input.startAt) - (item?.startAt ?? input.startAt))) - elapsedMs)
    : minutes * 60_000;
  if (!Number.isSafeInteger(elapsedMs) || elapsedMs < 0 || !Number.isSafeInteger(remainingMs) || remainingMs <= 0
    || !Number.isSafeInteger(elapsedMs + remainingMs)) throw new Error('invalid-day-plan-time');
  const active = prior && prior.status !== 'planned';
  const unscheduledPause = !!active && prior.status === 'paused' && !changeStart;
  const startAt = active && !changeStart ? item!.startAt : input.startAt;
  const futureStart = active && !changeStart ? context.now : startAt;
  const endAt = unscheduledPause ? item!.endAt! : futureStart + remainingMs;
  if (!validDate(startAt) || !validDate(endAt) || !validDate(context.now) || endAt <= startAt
    || (!active || changeStart) && planningStartAt !== undefined && startAt < planningStartAt
    || !unscheduledPause && planningEndAt !== undefined && endAt > planningEndAt) throw new Error('invalid-day-plan-time');
  const planRevision = (prior?.planRevision ?? 0) + 1;
  let execution: ScheduleExecution;
  if (!active) execution = { status: 'planned', planRevision, totalPlannedMs: elapsedMs + remainingMs, updatedAt: context.now };
  else if (changeStart) execution = { ...prior, planRevision, activityPlanRevision: prior.activityPlanRevision ?? prior.planRevision ?? 0,
    totalPlannedMs: elapsedMs + remainingMs, elapsedMs, updatedAt: context.now,
    completionId: prior.completionId ?? prior.activityId, originOccurrenceId: prior.originOccurrenceId ?? `${item!.id}:${item!.startAt}`,
    adjustment: { operationId: input.id, changedAt: context.now, action: 'reschedule', pending: true } };
  else execution = { ...prior, planRevision, activityPlanRevision: planRevision, elapsedMs,
    totalPlannedMs: elapsedMs + remainingMs, updatedAt: context.now };
  execution.resumeUnscheduled = unscheduledPause;
  execution.estimatedEndAt = active && !changeStart && !unscheduledPause ? endAt : null;
  execution.durationChange = { operationId: input.id, effectiveAt: context.now, elapsedMs, remainingMs,
    pending: !!active && !changeStart };
  return { operationId: input.id, effectiveAt: context.now, elapsedMs, remainingMs, startAt, endAt, execution };
}

/** Actual running occupancy can outlast the original calendar window. Its
 * history stays in that window; only the future actual segment blocks another plan. */
export function scheduleOccupiedInterval(item: ScheduleItem, now: number): { start: number; end: number } | null {
  const execution = item.execution;
  if (execution?.resumeUnscheduled && execution.status === 'paused') return null;
  const estimate = execution?.status === 'running' ? execution.estimatedEndAt : null;
  const start = typeof estimate === 'number' ? Math.max(now, item.startAt, execution?.startedAt ?? item.startAt) : item.startAt;
  const end = typeof estimate === 'number' ? estimate : item.endAt ?? item.startAt + 30 * 60_000;
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? { start, end } : null;
}
