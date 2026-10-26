import {
  advanceHabitLogProgress,
  archiveHabit,
  deleteHabit,
  loadHabitById,
  loadHabitLogForDate,
  loadHabits,
} from './habitStore';
import { cancelNotifications, syncScheduleNotifications } from './scheduleNotifications';
import {
  cancelScheduleItem,
  cancelScheduleOccurrence,
  createScheduleItem,
  dateKey,
  deleteScheduleItem,
  loadHabitOccurrencesForDate,
  loadScheduleItemsByHabitId,
  loadScheduleOccurrence,
  updateScheduleItem,
  type ScheduleDraft,
  type ScheduleOccurrence,
} from './scheduleStore';
import { settleChatHabitOccurrence, syncChatHabitScheduleInstances } from './chatHabitPlanStore';
export { saveChatHabitPlan, archiveChatHabitPlan, settleChatHabitOccurrence, settleChatHabitTodo, loadIntervalHabitIdsForDate } from './chatHabitPlanStore';
export type { ChatHabitPlanInput } from './chatHabitPlanStore';

const INSTANCE_DURATION_MINUTES = 15;

export async function deleteHabitWithScheduleInstances(habitId: string) {
  const habit = await loadHabitById(habitId);
  if (!habit) return;
  if (habit.owner === 'I' || habit.kind !== 'habit') throw new Error('habit-delete-owner-or-kind');
  // Stop regeneration first. A partial failure stays reachable under archived habits for retry.
  await archiveHabit(habitId);
  const instances = await loadScheduleItemsByHabitId(habitId);
  for (const item of instances) {
    if (item.source !== 'habit' || !item.habitAnchorKey || item.owner === 'I') continue;
    const notificationIds = await cancelScheduleItem(item.id);
    await cancelNotifications(notificationIds);
    await deleteScheduleItem(item.id);
  }
  await deleteHabit(habitId);
}

function parseTime(value: string) {
  const match = value.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  return match ? { hour: Number(match[1]), minute: Number(match[2]) } : null;
}

function nextDateForWeekDay(weekDay: number, time: { hour: number; minute: number }) {
  const now = new Date();
  const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), time.hour, time.minute, 0, 0);
  const currentWeekDay = candidate.getDay() || 7;
  let offset = (weekDay - currentWeekDay + 7) % 7;
  if (offset === 0 && candidate.getTime() < now.getTime() - 24 * 60 * 60 * 1000) offset = 7;
  candidate.setDate(candidate.getDate() + offset);
  return candidate.getTime();
}

function nextDailyDate(time: { hour: number; minute: number }) {
  const now = new Date();
  const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), time.hour, time.minute, 0, 0);
  if (candidate.getTime() < now.getTime() - 24 * 60 * 60 * 1000) candidate.setDate(candidate.getDate() + 1);
  return candidate.getTime();
}

function desiredDrafts(habit: NonNullable<Awaited<ReturnType<typeof loadHabitById>>>) {
  if (
    habit.status !== 'active'
    || habit.kind !== 'habit'
    || !habit.scheduleInstances.enabled
  ) return new Map<string, ScheduleDraft>();

  const drafts = new Map<string, ScheduleDraft>();
  for (const value of habit.reminderTimes) {
    const time = parseTime(value);
    if (!time) continue;
    const weekdays = habit.frequency === 'daily' ? [undefined] : habit.weekDays;
    for (const weekDay of weekdays) {
      if (weekDay !== undefined && (weekDay < 1 || weekDay > 7)) continue;
      const anchorKey = weekDay === undefined
        ? `${habit.id}:daily:${value}`
        : `${habit.id}:w${weekDay}:${value}`;
      const startAt = weekDay === undefined ? nextDailyDate(time) : nextDateForWeekDay(weekDay, time);
      drafts.set(anchorKey, {
        title: habit.title,
        notes: `习惯关联 · ${habit.category}`,
        startAt,
        endAt: startAt + INSTANCE_DURATION_MINUTES * 60 * 1000,
        reminderMinutesBefore: habit.scheduleInstances.reminderMinutesBefore,
        recurrence: weekDay === undefined ? 'daily' : 'weekly',
        reminderText: `${habit.title}的时间到啦，我们慢慢来。`,
        reminderIntensity: 'gentle',
        source: 'habit',
        habitId: habit.id,
        habitAnchorKey: anchorKey,
      });
    }
  }
  return drafts;
}

function draftMatchesItem(draft: ScheduleDraft, item: Awaited<ReturnType<typeof loadScheduleItemsByHabitId>>[number]) {
  const draftTime = new Date(draft.startAt);
  const itemTime = new Date(item.startAt);
  return item.status === 'pending'
    && item.title === draft.title
    && itemTime.getHours() === draftTime.getHours()
    && itemTime.getMinutes() === draftTime.getMinutes()
    && (item.endAt ?? item.startAt) - item.startAt === (draft.endAt ?? draft.startAt) - draft.startAt
    && item.reminderMinutesBefore === draft.reminderMinutesBefore
    && item.recurrence === draft.recurrence
    && item.notes === draft.notes
    && item.reminderText === draft.reminderText
    && item.habitAnchorKey === draft.habitAnchorKey;
}

export async function syncHabitScheduleInstances(habitId: string, syncNotifications = true) {
  const habit = await loadHabitById(habitId);
  if (!habit || habit.owner === 'I') return;
  if (habit.scheduleInstances.ruleUpdatedAt !== undefined) {
    await syncChatHabitScheduleInstances(habitId);
    if (syncNotifications) await syncScheduleNotifications();
    return;
  }
  const desired = desiredDrafts(habit);
  const existing = await loadScheduleItemsByHabitId(habitId);
  const existingByKey = new Map(existing.map((item) => [item.habitAnchorKey, item]));
  const notificationIds: string[] = [];

  for (const [anchorKey, draft] of desired) {
    const item = existingByKey.get(anchorKey);
    if (!item) {
      try {
        await createScheduleItem(draft);
      } catch (error) {
        const raced = (await loadScheduleItemsByHabitId(habitId)).find((candidate) => candidate.habitAnchorKey === anchorKey);
        if (!raced) throw error;
      }
    } else if (!draftMatchesItem(draft, item)) {
      const result = await updateScheduleItem(item.id, draft);
      notificationIds.push(...result.notificationIds);
    }
  }

  for (const item of existing) {
    if (!item.habitAnchorKey || desired.has(item.habitAnchorKey) || item.status === 'cancelled') continue;
    notificationIds.push(...await cancelScheduleItem(item.id));
  }

  if (notificationIds.length) await cancelNotifications(notificationIds);
  if (syncNotifications) await syncScheduleNotifications();
}

export async function syncAllHabitScheduleInstances() {
  const habits = await loadHabits(true, 'habit');
  for (const habit of habits) await syncHabitScheduleInstances(habit.id, false);
  await syncScheduleNotifications();
}

export async function completeHabitScheduleOccurrence(occurrenceId: string) {
  const occurrence = await loadScheduleOccurrence(occurrenceId);
  if (!occurrence || occurrence.source !== 'habit' || occurrence.status === 'cancelled') return;
  if (occurrence.habitId && (await loadHabitById(occurrence.habitId))?.owner === 'I') return;
  await settleChatHabitOccurrence(occurrenceId);
}

export async function skipHabitScheduleOccurrence(occurrenceId: string) {
  const occurrence = await loadScheduleOccurrence(occurrenceId);
  if (!occurrence || occurrence.source !== 'habit' || occurrence.status !== 'pending') return;
  const notificationIds = await cancelScheduleOccurrence(occurrenceId);
  if (notificationIds.length) await cancelNotifications(notificationIds);
}

function nearestOccurrence(occurrences: ScheduleOccurrence[], now: number) {
  return occurrences.reduce<ScheduleOccurrence | undefined>((nearest, occurrence) => {
    if (occurrence.status !== 'pending') return nearest;
    if (!nearest) return occurrence;
    return Math.abs(occurrence.scheduledStartAt - now) < Math.abs(nearest.scheduledStartAt - now)
      ? occurrence
      : nearest;
  }, undefined);
}

export async function completeNextHabitInstance(habitId: string, day: string, now = Date.now()) {
  const [habit, log] = await Promise.all([
    loadHabitById(habitId),
    loadHabitLogForDate(habitId, day),
  ]);
  if (!habit || habit.owner === 'I' || habit.status !== 'active') return log?.completedCount ?? 0;
  if ((log?.completedCount ?? 0) >= habit.targetCount) return habit.targetCount;

  if (habit.scheduleInstances.ruleUpdatedAt !== undefined) {
    const next = await syncChatHabitScheduleInstances(habit.id);
    if (!next) throw new Error('habit-occurrence-not-found');
    const occurrences = await loadHabitOccurrencesForDate(habitId, day);
    const target = nearestOccurrence(occurrences, now) ?? (habit.frequency === 'interval' ? next : undefined);
    if (!target) throw new Error('habit-occurrence-not-found');
    const result = await settleChatHabitOccurrence(target.id, now);
    return result.log.completedCount;
  }

  const occurrences = await loadHabitOccurrencesForDate(habitId, day);
  const nearest = nearestOccurrence(occurrences, now);
  if (nearest) await completeHabitScheduleOccurrence(nearest.id);
  else await advanceHabitLogProgress(habitId, day, 1);

  const updated = await loadHabitLogForDate(habitId, day);
  return updated?.completedCount ?? 0;
}
