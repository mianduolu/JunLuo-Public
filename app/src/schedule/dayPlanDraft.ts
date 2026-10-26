import type { DayPlanEntry } from './dayPlan';
import type { PendingSchedulePlan } from './dayScheduler';
import { clockFromTimestamp, combineDateTime, dateKeyFromTimestamp } from './dateTimeSelection';
import { parseChatScheduleRepeat } from './chatSchedulePlanPolicy';

export type DayPlanSubmission = {
  dateKey: string;
  planId?: string;
  entries: Array<Omit<Partial<DayPlanEntry>, 'action'> & { action: DayPlanEntry['action'] | 'remove' }>;
};

function parseDayPlanLocalTime(value: unknown): number | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new Error('INVALID_ARGUMENTS');
  }
  const [date, clock] = value.split('T');
  const timestamp = combineDateTime(date, clock);
  if (!Number.isFinite(timestamp) || timestamp < 0
    || dateKeyFromTimestamp(timestamp) !== date || clockFromTimestamp(timestamp) !== clock) {
    throw new Error('INVALID_ARGUMENTS');
  }
  return timestamp;
}

type DayPlanArgumentIssue = { entry: number; field: 'startAt' | 'endAt' | 'repeat.frequency' | 'steps'; reason: string };

function knownDayPlanArgumentIssues(input: Record<string, unknown>): DayPlanArgumentIssue[] {
  const issues: DayPlanArgumentIssue[] = [];
  if (!Array.isArray(input.entries)) return issues;
  for (const [index, raw] of input.entries.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    for (const [localKey, key, reason] of [
      ['startLocal', 'startAt', 'conflicts_with_startLocal'],
      ['endLocal', 'endAt', 'conflicts_with_endLocal'],
    ] as const) {
      if (typeof row[key] !== 'number' || !Number.isFinite(row[key]) || Number(row[key]) < 0) continue;
      try {
        const timestamp = parseDayPlanLocalTime(row[localKey]);
        if (timestamp !== undefined && row[key] !== timestamp) issues.push({ entry: index + 1, field: key, reason });
      } catch { /* This list only identifies valid local/numeric pairs which disagree. */ }
    }
    if (row.repeat !== undefined) {
      try { parseChatScheduleRepeat(row.repeat); }
      catch (error) {
        const issue = (error as { argumentIssue?: { field?: unknown; reason?: unknown } })?.argumentIssue;
        if (error instanceof Error && error.message === 'INVALID_ARGUMENTS'
          && issue?.field === 'repeat.frequency' && issue.reason === 'frequency_value') {
          issues.push({ entry: index + 1, field: 'repeat.frequency', reason: 'frequency_value' });
        }
      }
    }
    if (Array.isArray(row.steps) && row.steps.length === 0) issues.push({ entry: index + 1, field: 'steps', reason: 'empty_array' });
  }
  return issues;
}

function dayPlanArgumentError(input: Record<string, unknown>, reportRootIssues: boolean): Error {
  const error = new Error('INVALID_ARGUMENTS');
  if (!reportRootIssues) return error;
  const argumentIssues = knownDayPlanArgumentIssues(input);
  return argumentIssues.length ? Object.assign(error, { argumentIssues }) : error;
}

export function parseDayPlanSubmission(input: Record<string, unknown>): DayPlanSubmission {
  return parseDayPlanSubmissionValue(input, true);
}

function parseDayPlanSubmissionValue(input: Record<string, unknown>, reportRootIssues: boolean): DayPlanSubmission {
  const day = typeof input.dateKey === 'string' ? input.dateKey : '';
  const parsedDate = new Date(`${day}T12:00:00`);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(day) || !Number.isFinite(parsedDate.getTime()) || dateKeyFromTimestamp(parsedDate.getTime()) !== day) {
    throw new Error('INVALID_ARGUMENTS');
  }
  if (!Array.isArray(input.entries) || !input.entries.length) throw new Error('INVALID_ARGUMENTS');
  if (input.planId != null && typeof input.planId !== 'string') throw new Error('INVALID_ARGUMENTS');
  const entries = input.entries.map((raw): DayPlanSubmission['entries'][number] => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('INVALID_ARGUMENTS');
    const row = raw as Record<string, unknown>;
    if (!['schedule', 'inbox', 'cancel', 'remove'].includes(String(row.action))) throw new Error('INVALID_ARGUMENTS');
    const result: DayPlanSubmission['entries'][number] = { action: row.action as DayPlanSubmission['entries'][number]['action'] };
    for (const key of ['id', 'occurrenceId', 'todoId', 'habitId', 'title', 'notes'] as const) {
      if (row[key] != null) {
        if (typeof row[key] !== 'string') throw new Error('INVALID_ARGUMENTS');
        result[key] = row[key].trim();
      }
    }
    for (const key of ['startAt', 'endAt', 'durationMinutes', 'reminderMinutesBefore'] as const) {
      if (row[key] != null) {
        if (typeof row[key] !== 'number' || !Number.isFinite(row[key]) || row[key] < 0) throw new Error('INVALID_ARGUMENTS');
        result[key] = row[key];
      }
    }
    if (row.endAt === null) result.endAt = undefined;
    for (const [localKey, key] of [['startLocal', 'startAt'], ['endLocal', 'endAt']] as const) {
      const timestamp = parseDayPlanLocalTime(row[localKey]);
      if (timestamp !== undefined) {
        if (result[key] !== undefined && result[key] !== timestamp) throw dayPlanArgumentError(input, reportRootIssues);
        result[key] = timestamp;
      }
    }
    if (row.clearEndAt != null && typeof row.clearEndAt !== 'boolean') throw new Error('INVALID_ARGUMENTS');
    if (row.clearEndAt === true) {
      if (row.endAt != null || row.endLocal != null || row.durationMinutes != null) throw new Error('INVALID_ARGUMENTS');
      result.endAt = undefined;
    }
    if (row.durationMinutes === 0) throw new Error('INVALID_ARGUMENTS');
    if (row.repeat !== undefined) result.repeat = parseChatScheduleRepeat(row.repeat);
    if (row.scope !== undefined) {
      if (row.scope !== 'once' && row.scope !== 'future') throw new Error('INVALID_ARGUMENTS');
      result.scope = row.scope;
    }
    if (row.steps !== undefined) {
      if (!Array.isArray(row.steps) || !row.steps.length || row.steps.some(step => !step || typeof step !== 'object' || 'steps' in step || 'repeat' in step)) {
        throw Array.isArray(row.steps) && !row.steps.length ? dayPlanArgumentError(input, reportRootIssues) : new Error('INVALID_ARGUMENTS');
      }
      result.steps = parseDayPlanSubmissionValue({ dateKey: day, entries: row.steps.map(step => ({ ...step, action: 'schedule' })) }, false).entries as Array<Partial<DayPlanEntry>>;
    }
    for (const key of ['startSuggested', 'endSuggested', 'startReminderEnabled', 'companionEnabled'] as const) {
      if (row[key] != null) {
        if (typeof row[key] !== 'boolean') throw new Error('INVALID_ARGUMENTS');
        result[key] = row[key];
      }
    }
    return result;
  });
  return { dateKey: day, planId: typeof input.planId === 'string' ? input.planId.trim() || undefined : undefined, entries };
}

export async function buildDayPlanDraft(
  submission: DayPlanSubmission,
  originalText: string,
  previous?: PendingSchedulePlan,
): Promise<PendingSchedulePlan> {
  const { prepareDayPlanEntry } = await import('./dayPlanStore');
  if (submission.planId && (!previous?.dayPlan || previous.id !== submission.planId)) throw new Error('INVALID_ARGUMENTS');
  const entries = [...(previous?.dayPlan?.entries ?? [])];
  const touched = new Set<string>();
  for (const change of submission.entries) {
    const prior = change.id ? entries.find((row) => row.id === change.id)
      : change.occurrenceId ? entries.find((row) => row.occurrenceId === change.occurrenceId)
        : change.todoId ? entries.find((row) => row.todoId === change.todoId) : undefined;
    if (change.id && !prior || prior?.saved || prior?.scheduleSaved || prior && touched.has(prior.id)) throw new Error('INVALID_ARGUMENTS');
    if (prior) touched.add(prior.id);
    if (change.action === 'remove') {
      if (!prior || prior.occurrenceId || prior.scheduleSaved) throw new Error('INVALID_ARGUMENTS');
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        if (entries[index] === prior || entries[index].parentTodoId === prior.targetTodoId && !entries[index].saved && !entries[index].scheduleSaved) entries.splice(index, 1);
      }
      continue;
    }
    if (prior && ((change.occurrenceId && change.occurrenceId !== prior.occurrenceId)
      || (change.todoId && change.todoId !== prior.todoId))) throw new Error('INVALID_ARGUMENTS');
    const row = await prepareDayPlanEntry({ ...change, action: change.steps && change.action !== 'cancel' ? 'inbox' : change.action }, prior);
    if (row.action === 'cancel') delete row.steps;
    if (row.action === 'schedule' && (row.startAt == null
      || row.endAt != null && row.endAt <= row.startAt)) throw new Error('INVALID_ARGUMENTS');
    if (prior) entries[entries.indexOf(prior)] = row;
    else entries.push(row);
    if (row.action === 'cancel' && row.todoId && !row.parentTodoId) {
      const { loadTodoSteps } = await import('./todoStore');
      const { getScheduleDatabase } = await import('./scheduleDatabase');
      const { loadScheduleOccurrence, loadScheduleItemById } = await import('./scheduleStore');
      const database = await getScheduleDatabase();
      if (!row.occurrenceId) {
        const occurrences = await database.getAllAsync<{ id: string }>(
          "SELECT o.id FROM schedule_occurrences o JOIN schedule_items i ON i.id=o.item_id WHERE i.todo_id=? AND i.owner != 'I' AND o.status='pending' LIMIT 2", row.todoId);
        if (occurrences.length > 1) throw new Error('todo-occurrence-ambiguous');
        const occurrence = occurrences[0] ? await loadScheduleOccurrence(occurrences[0].id) : null;
        const item = occurrence ? await loadScheduleItemById(occurrence.itemId) : null;
        if (occurrence && item) {
          row.occurrenceId = occurrence.id;
          row.sourceUpdatedAt = item.updatedAt;
          row.startAt = occurrence.scheduledStartAt;
          row.endAt = occurrence.endAt;
          row.targetScheduleId = item.id;
        }
      }
      const parentOccurrenceId = row.parentOccurrenceId ?? row.occurrenceId;
      for (const step of await loadTodoSteps(row.todoId, parentOccurrenceId)) {
        if (['completed', 'cancelled', 'expired'].includes(step.status)) continue;
        const existing = entries.find(entry => entry.todoId === step.id);
        if (existing) {
          if (existing.action !== 'cancel') throw new Error('INVALID_ARGUMENTS');
          continue;
        }
        const occurrences = await database.getAllAsync<{ id: string }>(
          "SELECT o.id FROM schedule_occurrences o JOIN schedule_items i ON i.id=o.item_id WHERE i.todo_id=? AND i.owner != 'I' AND o.status='pending' LIMIT 2", step.id);
        if (occurrences.length > 1) throw new Error('todo-occurrence-ambiguous');
        const occurrence = occurrences[0] ? await loadScheduleOccurrence(occurrences[0].id) : null;
        const item = occurrence ? await loadScheduleItemById(occurrence.itemId) : null;
        const child = await prepareDayPlanEntry({ action: 'cancel', todoId: step.id,
          sourceTodoUpdatedAt: step.updatedAt, occurrenceId: occurrence?.id, sourceUpdatedAt: item?.updatedAt });
        entries.push(child);
        touched.add(child.id);
      }
    }
    for (const [index, step] of (row.action === 'cancel' ? [] : change.steps ?? []).entries()) {
      const priorStep = step.id ? entries.find(entry => entry.id === step.id && entry.parentTodoId === row.targetTodoId) : undefined;
      if (step.id && !priorStep) throw new Error('INVALID_ARGUMENTS');
      const child = await prepareDayPlanEntry({ ...step, action: 'schedule', parentTodoId: row.targetTodoId,
        parentOccurrenceId: row.occurrenceId, stepOrder: index + 1 }, priorStep);
      if (priorStep) entries[entries.indexOf(priorStep)] = child;
      else entries.push(child);
    }
  }
  return {
    ...(previous ?? {
      id: `day-plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      originalText, dateKey: submission.dateKey, tasks: [], constraints: [],
      scheduled: { dateKey: submission.dateKey, slots: [], unscheduled: [], floatingCommitments: [] },
      reviewSuggestions: [], memoryReferences: [], inhibitTasks: [],
    }),
    dayPlan: { entries },
  };
}

export function dayPlanModelContext(plan: PendingSchedulePlan) {
  const rows = plan.dayPlan?.entries ?? [];
  const project = ({ id, action, title, notes, occurrenceId, todoId, startAt, endAt,
    reminderMinutesBefore, startSuggested, endSuggested, durationMinutes, endMode, repeat, habitId, scope,
    startReminderEnabled, companionEnabled }: DayPlanEntry) => ({ id, action, title, notes, occurrenceId, todoId,
    startAt, endAt, reminderMinutesBefore, startSuggested, endSuggested, durationMinutes, endMode, repeat,
    habitId, scope, startReminderEnabled, companionEnabled });
  return JSON.stringify({ subject: 'you', planId: plan.id, dateKey: plan.dateKey,
    entries: rows.filter(row => !row.parentTodoId || !rows.some(parent => parent.targetTodoId === row.parentTodoId))
      .map(row => ({ ...project(row), steps: rows.filter(step => step.parentTodoId === row.targetTodoId).map(project) })) });
}
