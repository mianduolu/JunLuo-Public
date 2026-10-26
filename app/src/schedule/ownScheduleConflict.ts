import type { ScheduleItem } from './scheduleStore';
import { formatOwnDayPlanTime } from './ownDayPlanPolicy';
import { fingerprintPromptText } from '../ai/promptCacheMetrics';

type Sleep = { sleepAt: number; wakeAt: number };
type Activity = { id: string; title: string; status: string };
export type OwnScheduleConflict = { item: ScheduleItem; reason: 'elapsed' | 'sleep' | 'occupied' | 'saving'; sleep?: Sleep; activity?: Activity };
export type OwnScheduleConflictRef = { id: string; revision: string };

/** Derived from the original pending items; no queue and no opportunity timestamp. */
export function selectOwnScheduleConflicts(items: readonly ScheduleItem[], now: number, sleep: Sleep | null, activity: Activity | null) {
  const selected = new Map<string, OwnScheduleConflict>();
  for (const item of [...items].sort((a, b) => a.startAt - b.startAt || a.id.localeCompare(b.id))) {
    if (item.owner !== 'I' || item.recurrence !== 'none' || !item.endAt
      || item.execution?.status === 'completed') continue;
    if (item.execution?.adjustment?.pending || item.execution?.durationChange?.pending) { selected.set(item.id, { item, reason: 'saving' }); continue; }
    if (item.status !== 'pending') continue;
    const ownActivity = !!activity && activity.id === item.execution?.activityId && activity.status !== 'ended';
    const stillDoing = ownActivity && (activity!.status === 'reading' || activity!.status === '进行中');
    if (item.endAt <= now && !stillDoing) selected.set(item.id, { item, reason: 'elapsed' });
    else if (!item.execution?.resumeUnscheduled && sleep && item.startAt < sleep.wakeAt && item.endAt > sleep.sleepAt) selected.set(item.id, { item, reason: 'sleep', sleep });
    else if (!item.execution?.startedAt && item.startAt <= now && activity && !ownActivity
      && activity.status !== 'ended') selected.set(item.id, { item, reason: 'occupied', activity });
  }
  return [...selected.values()];
}

export function formatOwnScheduleConflict(conflict: OwnScheduleConflict, timeZone: string) {
  const { item } = conflict;
  const time = (at: number) => formatOwnDayPlanTime(at, timeZone);
  const elapsed = item.execution?.elapsedMs;
  const started = item.execution?.startedAt !== undefined || (elapsed ?? 0) > 0;
  const total = item.execution?.totalPlannedMs;
  const duration = typeof elapsed === 'number' && Number.isFinite(elapsed) && elapsed >= 0
    && typeof total === 'number' && Number.isFinite(total) && total >= elapsed;
  const minutes = (value: number) => Number((value / 60000).toFixed(2));
  const reason = conflict.reason === 'saving' ? '日程已保存，活动收尾尚未完成。' : conflict.reason === 'elapsed'
    ? started ? '原定时间已经过去了。' : '这项安排还没开始，原定时间已经过去了。'
    : conflict.reason === 'sleep'
      ? `这项安排与 I 已保存的睡眠时段重叠。\n这一觉的安排：${time(conflict.sleep!.sleepAt)}—${time(conflict.sleep!.wakeAt)}`
      : [conflict.activity?.status === 'reading' || conflict.activity?.status === '进行中'
        ? `I 现在还在进行：${conflict.activity.title}` : '',
        '这项安排已经到了开始时间，但还没开始。'].filter(Boolean).join('\n');
  return [`【I 待调整的安排】\n\n编号：${item.id}\n事情：${item.title}\n原定时间：${time(item.startAt)}—${time(item.endAt!)}`,
    [item.readingId ? `阅读编号：${item.readingId}` : '', item.habitId ? `习惯编号：${item.habitId}` : ''].filter(Boolean).join('\n'),
    reason, started && duration ? `I 已经进行了 ${minutes(elapsed!)} 分钟。\n按原计划，还剩 ${minutes(total! - elapsed!)} 分钟。` : '',
  ].filter(Boolean).join('\n\n');
}

export function ownScheduleConflictRef(conflict: OwnScheduleConflict): OwnScheduleConflictRef {
  return ownScheduleItemRef(conflict.item);
}

export function ownScheduleItemRef(item: ScheduleItem): OwnScheduleConflictRef {
  return { id: item.id, revision: fingerprintPromptText(JSON.stringify([item.id, item.owner, item.status,
    item.title, item.startAt, item.endAt, item.readingId, item.habitId, item.execution?.planRevision,
    item.execution?.status])) };
}

export async function collectOwnScheduleConflicts(now: number, limits = { maxItems: 8, maxCharacters: 1000 }) {
  const [{ loadPendingOwnScheduleItems, loadOwnScheduleAdjustments, schedulePlanVersion }, { readSleepSchedule }, { loadCurrentReadingActivity }, { loadFocusActivityFacts }] = await Promise.all([
    import('./scheduleStore'), import('../life/sleepPlanStore'), import('../reading/readingDailyRuntime'), import('../focus/focusReadingRuntime'),
  ]);
  const [pending, adjustments] = await Promise.all([
    loadPendingOwnScheduleItems(), loadOwnScheduleAdjustments(),
  ]);
  const items = [...new Map([...pending, ...adjustments].map(item => [item.id, item])).values()];
  if (!items.length) return { material: '', refs: [], versions: {}, items: [] };
  const [sleep, reading, focus] = await Promise.all([
    readSleepSchedule(now), loadCurrentReadingActivity(now), loadFocusActivityFacts(now),
  ]);
  const activity: Activity | null = reading && reading.status !== 'ended'
    ? { id: reading.activityId, title: reading.title, status: reading.status }
    : focus.current ? { id: focus.current.id, title: focus.current.activity, status: focus.current.status } : null;
  const conflicts = selectOwnScheduleConflicts(items, now, sleep ? { sleepAt: sleep.currentSleepAt, wakeAt: sleep.currentWakeAt } : null, activity);
  const selected: OwnScheduleConflict[] = [], lines: string[] = [];
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const receipts = await (await import('./ownScheduleSave')).loadOwnScheduleRelevantReceipts(items, timeZone);
  for (const conflict of conflicts) {
    if (selected.length >= limits.maxItems) break;
    const receipt = receipts.get(conflict.item.id)?.text ?? '';
    const line = [formatOwnScheduleConflict(conflict, timeZone), receipt].filter(Boolean).join('\n\n');
    if ([...lines, line].join('\n\n').length > limits.maxCharacters) break;
    selected.push(conflict); lines.push(line);
  }
  return { material: lines.join('\n\n'), refs: selected.map(ownScheduleConflictRef),
    versions: Object.fromEntries(selected.filter(item => item.reason !== 'saving').map(({ item }) => [item.id, schedulePlanVersion(item)])),
    items: selected.filter(item => item.reason !== 'saving').map(({ item }) => item) };
}

export async function ownScheduleConflictRefsMatch(refs: readonly OwnScheduleConflictRef[], now = Date.now()) {
  if (!refs.length) return true;
  const { loadScheduleItemById } = await import('./scheduleStore');
  for (const ref of refs) {
    const item = await loadScheduleItemById(ref.id);
    if (!item || ownScheduleItemRef(item).revision !== ref.revision) return false;
  }
  return true;
}
