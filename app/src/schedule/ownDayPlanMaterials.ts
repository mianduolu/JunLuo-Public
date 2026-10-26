import type { ReadingBook } from '../reading/readingTypes';
import type { AssistantLifeDay } from '../ai/assistantLifeTimeline';
import { buildFocusReadingCatalog, selectFocusReadingCatalogBooks } from '../focus/focusGenerationPolicy';
import { buildDailyReadingCurrentMaterial } from '../reading/readingDailyRuntime';
import { loadReadingLibraryStrict } from '../reading/readingStore';
import { loadOwnedScheduleItems, schedulePlanVersion } from './scheduleStore';
import { loadOwnActiveHabits, getOwnHabitPeriodProgress } from './habitStore';
import { sleepContext } from '../life/sleepPlanStore';
import { buildSleepFactsMaterial } from '../life/sleepPlanGeneration';
import { loadJunluoAffectState } from '../life/junluoInnerStateStore';
import { formatPreviousAffect } from '../ai/assistantAffectPaper';
import { buildOwnDayPlanTimeMaterial } from './ownDayPlanPrompt';
import { formatOwnDayPlanTime, parseOwnDayPlanTime, type OwnDayPlanBounds } from './ownDayPlanPolicy';
import { loadOwnScheduleRelevantReceipts } from './ownScheduleSave';
import { buildUserRoutineMaterial } from './userRoutineContext';
import { ownReadingAvailability, ownReadingLabels } from './ownReadingSelectionMaterial';
import { loadReadingTimeEstimate, readingTimeEstimateMaterial } from '../reading/readingTimeEstimate';

export function ownDayPlanReadingVersion(book: ReadingBook) {
  // Preparation/progress may grow while planning. Only the selected resource identity changes this reference.
  let hash = 2166136261;
  for (const character of JSON.stringify([book.id, book.title, book.author, book.importedAt,
    book.programme?.sourceUrl ?? book.fileUri, book.programme?.sourceVersion])) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return hash >>> 0;
}

export async function loadOwnDayPlanMaterials(day: AssistantLifeDay, now: number, bounds: OwnDayPlanBounds, previousLabels: Record<string, string> = {}) {
  const [schedules, habits, books, activity, sleep, affect] = await Promise.all([
    loadOwnedScheduleItems(bounds.startAt, bounds.endAt), loadOwnActiveHabits(), loadReadingLibraryStrict(),
    buildDailyReadingCurrentMaterial(now), buildSleepFactsMaterial(sleepContext(day, now)), loadJunluoAffectState(),
  ]);
  const time = (at: number) => formatOwnDayPlanTime(at, bounds.timeZone);
  const receipts = await loadOwnScheduleRelevantReceipts(schedules, bounds.timeZone);
  const routine = await buildUserRoutineMaterial(bounds.startAt, bounds.endAt, bounds.timeZone);
  const availability = await ownReadingAvailability(books);
  const selection = await ownReadingLabels(schedules, availability, previousLabels);
  const existing = schedules.length ? `【这一天已有的安排】\n\n${schedules.map(item => [
    `编号：${item.id}｜属于：${item.owner ?? 'you'}｜${item.title}｜${time(item.startAt)}${item.endAt === undefined ? '' : `—${time(item.endAt)}`}`,
    item.readingId ? `阅读编号：${selection.facts[item.id]?.currentReadingId ?? item.readingId}` : '', item.habitId ? `习惯编号：${item.habitId}` : '',
    selection.facts[item.id] ? `localId：${selection.facts[item.id].localId}\nreadingId：${selection.facts[item.id].currentReadingId}\nnextReadingId：${selection.facts[item.id].nextReadingId ?? 'null'}` : '',
    receipts.get(item.id)?.text ?? '',
  ].filter(Boolean).join('\n')).join('\n\n')}` : '';
  const habitLines: string[] = [];
  // The range can span two local dates/periods; don't reuse today's weekly tally for next week.
  const dates = [...new Set([time(bounds.startAt).slice(0, 10), time(bounds.endAt - 1).slice(0, 10)])];
  for (const habit of habits) {
    const periods = new Set<string>();
    const progress: string[] = [];
    let fullyScheduled = true;
    for (const date of dates) {
      const period = await getOwnHabitPeriodProgress(habit, date);
      if (!period.applies || periods.has(period.periodStart)) continue;
      periods.add(period.periodStart);
      const a = parseOwnDayPlanTime(`${period.periodStart} 00:00`, bounds.timeZone);
      const end = new Date(`${period.periodEnd}T12:00:00Z`); end.setUTCDate(end.getUTCDate() + 1);
      const b = parseOwnDayPlanTime(`${end.toISOString().slice(0, 10)} 00:00`, bounds.timeZone);
      const associated = await loadOwnedScheduleItems(a, b, { includeTerminal: true });
      const planned = new Set(associated.filter(item => item.owner === 'I' && item.habitId === habit.id
        && item.status !== 'cancelled' && item.status !== 'completed' && item.execution?.status !== 'completed'
        && !period.completionActivityIds.includes(item.execution?.activityId ?? '')).map(item => item.id)).size;
      progress.push(`${period.periodStart}${period.periodEnd === period.periodStart ? '' : `—${period.periodEnd}`}：已完成 ${period.completedCount} 次，另已安排 ${planned} 次。`);
      if (period.completedCount + planned < period.targetCount) fullyScheduled = false;
    }
    if (fullyScheduled) continue;
    const frequency = { frequency: habit.frequencyPeriod === 'week' ? 'weekly' : habit.frequencyPeriod === 'weekdays' ? 'weekdays' : 'daily',
      count: habit.targetCount, weekDays: habit.weekDays };
    habitLines.push([`编号：${habit.id}｜${habit.title}｜频率：${JSON.stringify(frequency)}`,
      habit.minutes == null ? '' : `每次：${habit.minutes} 分钟`, ...progress].filter(Boolean).join('\n'));
  }
  const candidates = selectFocusReadingCatalogBooks(books.filter(book => book.programme
    ? !book.iReading?.reachedEnd : !!book.iReading && !book.iReading.needsSourceConfirmation && !book.iReading.reachedEnd));
  const estimates = new Map(await Promise.all(candidates.map(async book => [book.id,
    readingTimeEstimateMaterial(await loadReadingTimeEstimate(book), !book.iReading?.needsSourceConfirmation
      && (!book.programme || book.programme.preparation === 'ready'))] as const)));
  const sharedIds = new Set(Object.values(selection.facts).flatMap(fact => [fact.currentReadingId, fact.nextReadingId]));
  return {
    readingLabels: selection.readingLabels,
    expectedChoiceVersions: selection.expectedChoiceVersions,
    availability,
    scheduleVersions: Object.fromEntries(schedules.map(item => [item.id, schedulePlanVersion(item)])),
    habitVersions: Object.fromEntries(habits.map(item => [item.id, item.updatedAt])),
    readingVersions: Object.fromEntries(books.filter(book => candidates.some(candidate => candidate.id === book.id)
      || sharedIds.has(book.id) || schedules.some(item => item.readingId === book.id) || book.iReading?.activity && book.iReading.activity.status !== 'ended')
      .map(book => [book.id, ownDayPlanReadingVersion(book)])),
    candidates,
    render: (selected: ReadingBook[] = candidates) => [buildOwnDayPlanTimeMaterial(now, bounds), sleep, existing, routine,
      habitLines.length ? `【I 的习惯】\n\n${habitLines.join('\n\n')}` : '', activity,
      selected.map(book => `${buildFocusReadingCatalog([book])}\n${estimates.get(book.id)}`).join('\n\n'),
      formatPreviousAffect(affect)].filter(Boolean).join('\n\n'),
  };
}
