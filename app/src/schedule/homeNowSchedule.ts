import { clockFromTimestamp, dateKeyFromTimestamp } from './dateTimeSelection';
import type { ScheduleOccurrence } from './scheduleStore';

export type HomeNowSchedule = {
  title: string;
  caption?: string;
};

export function selectHomeNowSchedule(
  items: ScheduleOccurrence[],
  owner: 'I' | 'you',
  now: number,
): HomeNowSchedule {
  const today = dateKeyFromTimestamp(now);
  const owned = items.filter(item => (
    ((item.owner ?? 'you') === owner || item.owner === 'I 和 you')
    && item.status !== 'cancelled'
    && dateKeyFromTimestamp(item.scheduledStartAt) === today
  )).sort((left, right) => left.scheduledStartAt - right.scheduledStartAt || left.id.localeCompare(right.id));
  if (!owned.length) return { title: '暂无安排' };

  const pending = owned.filter(item => item.status === 'pending'
    && item.execution?.status !== 'completed' && item.execution?.status !== 'ended');
  // A start-only appointment has no invented duration; it is current in its start minute.
  const current = pending.find(item => item.scheduledStartAt <= now && (
    item.endAt === undefined
      ? Math.floor(item.scheduledStartAt / 60_000) === Math.floor(now / 60_000)
      : now < item.endAt
  ));
  const next = current ?? pending.find(item => item.scheduledStartAt > now);
  if (!next) return { title: '今天没有后续安排' };
  const clock = clockFromTimestamp(next.scheduledStartAt);
  return { title: next.title, caption: current ? clock : `接下来 ${clock}` };
}
