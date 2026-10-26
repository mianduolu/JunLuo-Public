import { formatOwnDayPlanTime } from './ownDayPlanPolicy';
import type { DayTemplateInstance } from './dayTemplateInstanceStore';

export function formatUserRoutineMaterial(items: DayTemplateInstance[], startAt: number, endAt: number, timeZone: string) {
  const unique = new Map(items.filter(item => item.enabled && item.startAt !== undefined
    && item.startAt >= startAt && item.startAt < endAt).map(item => [item.id, item]));
  const days = new Map<string, string[]>();
  for (const item of [...unique.values()].sort((a, b) => a.startAt! - b.startAt! || a.id.localeCompare(b.id))) {
    const time = formatOwnDayPlanTime(item.startAt!, timeZone);
    const date = time.slice(0, 10);
    const line = `${item.title}：${time}${item.endAt == null ? '' : `—${formatOwnDayPlanTime(item.endAt, timeZone)}`}（${item.source === 'day' ? '当天改过' : '平常安排'}）`;
    days.set(date, [...(days.get(date) ?? []), line]);
  }
  return [...days].map(([date, lines]) => `【you 的作息安排】\n\n${date}\n${lines.join('\n')}\n\n这些是安排，到点不等于已经做了。`).join('\n\n');
}

export async function buildUserRoutineMaterial(startAt: number, endAt: number, timeZone: string) {
  try { return formatUserRoutineMaterial(await (await import('./userRoutineStore')).readEffectiveUserRoutineRange(startAt, endAt, timeZone), startAt, endAt, timeZone); }
  catch { return ''; }
}

/** A point has no invented duration. Reporting an overlap never edits either plan. */
export async function loadUserRoutineOverlaps(startAt: number, endAt: number) {
  const { readEffectiveUserRoutineRange } = await import('./userRoutineStore');
  const { loadOwnedScheduleItems } = await import('./scheduleStore');
  const [routines, schedules] = await Promise.all([
    readEffectiveUserRoutineRange(startAt, endAt), loadOwnedScheduleItems(startAt, endAt),
  ]);
  return routines.flatMap(routine => routine.enabled && routine.startAt !== undefined && routine.endAt !== undefined
    ? schedules.filter(item => item.owner !== 'I' && item.endAt !== undefined
      && routine.startAt! < item.endAt && routine.endAt! > item.startAt)
      .map(item => ({ routineId: routine.id, scheduleId: item.id, title: item.title, startAt: item.startAt, endAt: item.endAt })) : []);
}
