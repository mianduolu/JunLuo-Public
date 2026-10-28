import type { AssistantLifeDay } from '../ai/assistantLifeTimeline';
import { sleepWakeTarget } from './sleepPlanPolicy';

type Row = { label: string; value: string; note?: string; amount?: number };
type SleepTimeCard = { planned: string; actual: Row[] };
export type TodaySleepPresentation = {
  date: string;
  wake: SleepTimeCard;
  sleep: SleepTimeCard;
  nextWake: string;
  previousSleep: string | null;
  timeline: Row[];
  changes: Row[];
  metrics: Row[];
  rhythmRecordedAt: string | null;
};

function dateKey(at: number) {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function sleepDisplayTime(at: unknown, missing = '未记录') {
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0 || !Number.isFinite(new Date(at).getTime())) return missing;
  const date = new Date(at);
  return `${dateKey(at)} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function sleepBriefTime(at: unknown, now: number, missing = '未记录') {
  const full = sleepDisplayTime(at, '');
  if (!full) return missing;
  const day = full.slice(0, 10), clock = full.slice(11);
  if (day === dateKey(now)) return clock;
  const tomorrow = new Date(now), yesterday = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  yesterday.setDate(yesterday.getDate() - 1);
  if (day === dateKey(tomorrow.getTime())) return `明天 ${clock}`;
  if (day === dateKey(yesterday.getTime())) return `昨天 ${clock}`;
  return `${day.slice(0, 4) === dateKey(now).slice(0, 4) ? day.slice(5).replace('-', '/') : day.replace(/-/g, '/')} ${clock}`;
}

/** Presentation only: never creates a day, advances sleep, or fills missing rhythm values. */
export function presentTodaySleep(input: {
  now: number;
  today: AssistantLifeDay | null;
  previous: AssistantLifeDay | null;
  relevant: AssistantLifeDay | null;
  rhythmRaw: string | null;
}): TodaySleepPresentation {
  const { now, today, previous } = input;
  const date = dateKey(now);
  const dayByKey = new Map([input.relevant, previous, today].filter((day): day is AssistantLifeDay => !!day)
    .map(day => [day.dateKey, day]));
  const days = [...dayByKey.values()];
  const relevant = input.relevant ? dayByKey.get(input.relevant.dateKey) ?? null : null;
  const wakeTarget = (day: AssistantLifeDay) => day.nightSleepPlan
    ? sleepWakeTarget(day.nightSleepPlan, day.nightSleepPlan.actualSleepAt ?? day.sleepTargetAt) : undefined;
  const morning = days.filter(day => {
    const at = wakeTarget(day);
    return at !== undefined && dateKey(at) === date;
  }).sort((a, b) => b.dateKey.localeCompare(a.dateKey))[0];
  const isTodayRecord = (at: number | undefined): at is number => typeof at === 'number'
    && Number.isFinite(at) && at > 0 && at <= now && dateKey(at) === date;
  const latestWakeNight = (field: 'morningAwakeAt' | 'actualWakeAt') => days
    .filter(day => isTodayRecord(day.nightSleepPlan?.[field]))
    .sort((a, b) => b.nightSleepPlan![field]! - a.nightSleepPlan![field]!)[0];
  const wakeRecord = (latestWakeNight('actualWakeAt') ?? latestWakeNight('morningAwakeAt'))?.nightSleepPlan;
  const recordedToday = (at: number | undefined) => isTodayRecord(at) ? at : undefined;
  const brief = (at: unknown, missing?: string) => sleepBriefTime(at, now, missing);
  const changes: Row[] = [];
  if (relevant?.nightSleepPlan) {
    const plan = relevant.nightSleepPlan;
    if (plan.originalSleepAt !== relevant.sleepTargetAt) changes.push({
      label: '入睡调整', value: `${brief(plan.originalSleepAt)} → ${brief(relevant.sleepTargetAt)}`,
    });
    const wakeAt = wakeTarget(relevant);
    if (plan.originalWakeAt !== wakeAt) changes.push({
      label: '起床调整', value: `${brief(plan.originalWakeAt)} → ${brief(wakeAt)}`,
    });
  }
  const facts = days.flatMap(day => {
    const plan = day.nightSleepPlan;
    if (!plan) return [];
    return [
      { label: '入睡', at: plan.actualSleepAt },
      { label: '醒来', at: plan.morningAwakeAt },
      { label: '正式起床', at: plan.actualWakeAt },
      ...(plan.events ?? []).filter(event => event.kind === 'poke_awake' || event.kind === 'sleep_return')
        .map(event => ({ label: event.kind === 'poke_awake' ? '临时醒来' : '睡回', at: event.at,
          note: event.kind === 'poke_awake' && event.until !== undefined ? `原临时醒截止 ${brief(event.until)}` : undefined })),
    ];
  }).filter((fact): fact is typeof fact & { at: number } => isTodayRecord(fact.at));
  const timeline = [...new Map(facts.map(fact => [`${fact.label}:${fact.at}`, fact])).values()]
    .sort((a, b) => a.at - b.at).slice(-12)
    .map(fact => ({ label: fact.label, value: brief(fact.at), note: 'note' in fact ? fact.note : undefined }));
  let rhythm: Record<string, unknown> | null = null;
  try {
    const value: unknown = input.rhythmRaw === null ? null : JSON.parse(input.rhythmRaw);
    if (value && typeof value === 'object' && !Array.isArray(value)) rhythm = value as Record<string, unknown>;
  } catch { /* Missing or unreadable records stay missing. */ }
  const stamp = rhythm?.updatedAt;
  const hasRecordedTime = typeof stamp === 'number' && Number.isFinite(stamp) && stamp > 0 && stamp <= now;
  const metrics = hasRecordedTime ? ([
    ['sleepPressure', '困意'], ['wakePressure', '醒意'], ['sleepDebt', '欠觉'],
    ['alertness', '清醒度'], ['restQuality', '休息质量'],
  ] as const).map(([key, label]) => {
    const value = rhythm?.[key];
    const amount = typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
      ? Math.round(value * 100) : undefined;
    return { label, value: amount === undefined ? '未记录' : `${amount} / 100`, amount };
  }) : [];
  const morningWake = morning ? wakeTarget(morning) : today?.wakeTargetAt;
  const unfinished = days.filter(day => day.nightSleepPlan?.actualWakeAt === undefined
    || day.nightSleepPlan.actualWakeAt > now);
  const nextWake = [...unfinished.map(wakeTarget), ...(!morning || unfinished.includes(morning) ? [morningWake] : [])]
    .filter((at): at is number => typeof at === 'number' && Number.isFinite(at) && at > now)
    .sort((a, b) => a - b)[0];
  const recentSleep = days.map(day => day.nightSleepPlan?.actualSleepAt)
    .filter((at): at is number => typeof at === 'number' && Number.isFinite(at) && at > 0 && at <= now)
    .sort((a, b) => b - a)[0];
  return {
    date,
    wake: {
      planned: brief(morningWake, '未定'),
      actual: [
        { label: '醒来', value: brief(recordedToday(wakeRecord?.morningAwakeAt)) },
        { label: '实际起床', value: brief(recordedToday(wakeRecord?.actualWakeAt)) },
      ],
    },
    sleep: { planned: brief(today?.sleepTargetAt, '未定'),
      actual: [{ label: '实际入睡', value: brief(recordedToday(today?.nightSleepPlan?.actualSleepAt)) }] },
    nextWake: brief(nextWake !== undefined && nextWake > now ? nextWake : undefined, '尚无后续计划'),
    previousSleep: recentSleep !== undefined && dateKey(recentSleep) !== date ? brief(recentSleep) : null,
    timeline, changes, metrics,
    rhythmRecordedAt: hasRecordedTime ? brief(stamp) : null,
  };
}
