import type { ChatScheduleRepeat, DayPlanChange, DayPlanEntry } from './dayPlan';

export function parseChatScheduleRepeat(raw: unknown): ChatScheduleRepeat {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('INVALID_ARGUMENTS');
  const rule = raw as Record<string, unknown>;
  if (!['daily', 'weekly', 'interval'].includes(String(rule.frequency))) throw Object.assign(new Error('INVALID_ARGUMENTS'), {
    argumentIssue: { field: 'repeat.frequency', reason: 'frequency_value' },
  });
  const frequency = rule.frequency as ChatScheduleRepeat['frequency'];
  if (frequency === 'weekly') {
    if (!Array.isArray(rule.weekDays) || !rule.weekDays.length || rule.weekDays.some(v => !Number.isInteger(v) || v < 1 || v > 7)
      || new Set(rule.weekDays).size !== rule.weekDays.length) throw new Error('INVALID_ARGUMENTS');
    return { frequency, weekDays: [...rule.weekDays].sort((a, b) => a - b) as number[] };
  }
  if (frequency === 'interval') {
    if (!Number.isSafeInteger(rule.intervalDays) || Number(rule.intervalDays) <= 0) throw new Error('INVALID_ARGUMENTS');
    return { frequency, intervalDays: Number(rule.intervalDays) };
  }
  return { frequency };
}

export function applyChatScheduleTimeChange<T extends Partial<DayPlanEntry>>(entry: T, change: DayPlanChange): T {
  const result = { ...entry, ...change };
  if (change.repeat && !result.targetHabitId) result.targetHabitId = result.habitId ?? `habit:${entry.id}`;
  if (change.endAt !== undefined && change.durationMinutes !== undefined && result.startAt !== undefined
    && change.endAt - result.startAt !== change.durationMinutes * 60000) throw new Error('schedule-duration-conflict');
  if (Object.hasOwn(change, 'endAt')) {
    result.endMode = change.endAt === undefined ? undefined : 'fixed';
    result.durationMinutes = undefined;
    result.endSuggested = false;
  } else if (change.durationMinutes !== undefined) {
    if (!Number.isFinite(change.durationMinutes) || change.durationMinutes <= 0) throw new Error('invalid-day-plan-time');
    result.endMode = 'duration';
    result.endAt = result.startAt === undefined ? undefined : result.startAt + change.durationMinutes * 60_000;
  } else if (change.startAt !== undefined && entry.startAt !== undefined && entry.endAt !== undefined && entry.endMode !== 'fixed') {
    result.endAt = change.startAt + (entry.endAt - entry.startAt);
    result.durationMinutes = (entry.endAt - entry.startAt) / 60_000;
    result.endMode = 'duration';
  }
  if (change.startAt !== undefined) result.startSuggested = false;
  if (result.endAt === undefined) result.companionEnabled = false;
  if (result.endAt !== undefined && result.startAt !== undefined && result.endAt <= result.startAt) throw new Error('invalid-day-plan-time');
  return result;
}

/** Only a newly saved future start uses the shortened lead; old occurrences keep their clock. */
export function chatScheduleReminderAt(startAt: number, leadMinutes: number, savedAt: number) {
  const proposed = startAt - leadMinutes * 60_000;
  return startAt > savedAt && proposed <= savedAt ? startAt : proposed;
}
