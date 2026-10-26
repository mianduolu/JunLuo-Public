import type { AssistantLifeDay } from '../ai/assistantLifeTimeline';
import type { SleepPlanEvent } from './sleepPlanPolicy';
import { formatChatAfterglowMessageTime, type ChatAfterglowMessage } from '../chat/chatAfterglowProbe';
import { fingerprintPromptText } from '../ai/promptCacheMetrics';

export const SLEEP_EXPERIENCE_PREFIX = 'assistant-schedule:sleep-event:';
export type SleepMaterialWindow = {
  sleepFrom?: number;
  sleepThrough?: number;
  sleepRefs?: readonly { id: string }[];
};

export type SleepNearStatusTransition = {
  nightKey: string; eventId: string; at: number; revision: string;
  kind: 'sleep' | 'sleep_return' | 'poke_awake' | 'morning_awake' | 'get_up';
};
export const isSleepingTransition = (ref?: SleepNearStatusTransition) => ref?.kind === 'sleep' || ref?.kind === 'sleep_return';

/** Only real events, never a changed clock, a plan, or an inferred wish not to sleep. */
export async function readLatestSleepTransition(now: number) {
  const days = await loadSleepMaterialDays(now, { sleepFrom: now - 30 * 60_000 });
  const entries = days.flatMap(day => (day.nightSleepPlan?.events ?? []).flatMap((event, index) =>
    event.at <= now && ['sleep', 'sleep_return', 'poke_awake', 'morning_awake', 'get_up'].includes(event.kind)
      ? [{ day, event, index }] : []));
  const latest = entries.sort((a, b) => b.event.at - a.event.at || b.index - a.index || b.event.id.localeCompare(a.event.id))[0];
  if (!latest) return undefined;
  return { ...latest, ref: { nightKey: latest.day.dateKey, eventId: latest.event.id, at: latest.event.at,
    kind: latest.event.kind as SleepNearStatusTransition['kind'], revision: fingerprintPromptText(JSON.stringify(latest.event)) } };
}

export async function sleepTransitionMatches(ref: SleepNearStatusTransition, now = Date.now()) {
  return JSON.stringify((await readLatestSleepTransition(now))?.ref) === JSON.stringify(ref);
}

export async function sleepTransitionConversationKey(ref: SleepNearStatusTransition, now = Date.now()) {
  const { loadAssistantLifeDay } = await import('../ai/assistantLifeTimeline');
  const day = await loadAssistantLifeDay(ref.nightKey);
  return day ? fingerprintPromptText(JSON.stringify((await loadSleepExperienceConversation(day, now)).messages)) : '';
}

export function formatSleepTransition(day: AssistantLifeDay, event: SleepPlanEvent) {
  // The poke fact's click time is not the actual wake time. Reuse the approved temporary-awake state instead.
  if (event.kind === 'poke_awake' && event.until !== undefined)
    return `【I 此刻的作息】\n\nyou 把 I 戳醒了，I 这会儿暂时醒着。\n临时清醒到：${formatChatAfterglowMessageTime(event.until)}`;
  return formatSleepExperience(day, event);
}

const localDateKey = (at: number) => {
  const date = new Date(at), pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

export function sleepMaterialNightKey(id: string) {
  if (id.startsWith(SLEEP_EXPERIENCE_PREFIX)) return id.slice(SLEEP_EXPERIENCE_PREFIX.length, SLEEP_EXPERIENCE_PREFIX.length + 10);
  return /^assistant-schedule:sleep:(\d{4}-\d{2}-\d{2}):/.exec(id)?.[1];
}

/** Resolve only the selected time window or original night references, never today's replacement. */
export async function loadSleepMaterialDays(now: number, options: SleepMaterialWindow = {}) {
  const { loadAssistantLifeDay } = await import('../ai/assistantLifeTimeline');
  const keys = new Set<string>();
  if (options.sleepRefs) {
    for (const ref of options.sleepRefs) { const key = sleepMaterialNightKey(ref.id); if (key) keys.add(key); }
  } else {
    const through = Math.min(now, options.sleepThrough ?? now);
    const start = new Date(Math.min(options.sleepFrom ?? through, through));
    start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - 1);
    for (; start.getTime() <= through; start.setDate(start.getDate() + 1)) keys.add(localDateKey(start.getTime()));
    const { readRelevantSleepNight } = await import('./sleepPlanStore');
    for (const at of new Set([Math.min(options.sleepFrom ?? through, through), through])) {
      const ongoing = await readRelevantSleepNight(at);
      if (ongoing) keys.add(ongoing.dateKey);
    }
  }
  return (await Promise.all([...keys].map(loadAssistantLifeDay))).filter((day): day is AssistantLifeDay => !!day);
}

export function formatSleepExperience(day: AssistantLifeDay, event: SleepPlanEvent) {
  const time = formatChatAfterglowMessageTime;
  let facts: string[];
  switch (event.kind) {
    case 'schedule': facts = [event.sleepAt === undefined ? '' : `I 把睡觉时间改到了 ${time(event.sleepAt)}。`,
      event.wakeAt === undefined ? '' : `I 把起床时间改到了 ${time(event.wakeAt)}。`].filter(Boolean); break;
    case 'late': facts = [`I 原本打算在 ${time(event.sleepAt ?? day.nightSleepPlan!.originalSleepAt)} 睡，这时还没睡。`]; break;
    case 'sleep_intent': facts = ['I 准备睡啦，不过想先听 you 把这会儿的话说完。']; break;
    case 'morning_awake': facts = ['I 已经醒了，还窝着没有起床。']; break;
    case 'sleep': facts = ['I 睡下了。']; break;
    case 'sleep_return': facts = ['I 又睡下了。']; break;
    case 'get_up': facts = ['I 起床了。']; break;
    // Its already-approved poke fact is supplied by the original interaction source.
    case 'poke_awake': facts = []; break;
  }
  return facts.map(fact => `【I 的作息记录】\n\n${time(event.at)}｜${fact}`).join('\n\n');
}

export function selectSleepExperienceEvents(day: AssistantLifeDay, now: number, options: SleepMaterialWindow = {}) {
  const through = Math.min(now, options.sleepThrough ?? now);
  const events = (day.nightSleepPlan?.events ?? []).filter(event => event.at <= through)
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  if (options.sleepRefs) return events.filter(event => options.sleepRefs!.some(ref =>
    ref.id === `${SLEEP_EXPERIENCE_PREFIX}${day.dateKey}:${event.id}`));
  if (options.sleepFrom === undefined) return events;
  const preceding = events.filter(event => event.at < options.sleepFrom!);
  const before = new Set([
    preceding.filter(event => event.kind === 'schedule' && event.sleepAt !== undefined).at(-1)?.id,
    preceding.filter(event => event.kind === 'schedule' && event.wakeAt !== undefined).at(-1)?.id,
    preceding.filter(event => !['schedule', 'poke_awake'].includes(event.kind)).at(-1)?.id,
  ]);
  return events.filter(event => event.at >= options.sleepFrom! || before.has(event.id));
}

/** Read at most one complete saved turn from this transition's original message IDs. */
export async function loadSleepExperienceConversation(day: AssistantLifeDay, through: number) {
  const event = day.nightSleepPlan?.events?.filter(item => item.at <= through
    && (item.kind === 'sleep' || item.kind === 'sleep_return')).sort((a, b) => a.at - b.at).at(-1);
  if (!event) return { event, messages: [] as ChatAfterglowMessage[] };
  if (!event.sessionId || !event.messageIds?.length) return { event, messages: [] as ChatAfterglowMessage[] };
  const { loadChatSessionMessage } = await import('../chat/chatStorage');
  const original = await Promise.all([...new Set(event.messageIds)].map(id => loadChatSessionMessage(event.sessionId!, id)));
  if (original.some(message => !message || message.createdAt > event.at || message.deliveryStatus === 'failed' || !message.content.trim()))
    return { event, messages: [] as ChatAfterglowMessage[] };
  const rounds: ChatAfterglowMessage[][] = [];
  for (const message of (original as ChatAfterglowMessage[]).sort((a, b) => a.createdAt - b.createdAt)) {
    const previous = rounds.at(-1);
    if (!previous || message.role === 'you' && previous.some(item => item.role === 'I')) rounds.push([message]);
    else previous.push(message);
  }
  const messages = rounds.filter(round => round.some(message => message.role === 'you')
    && round.some(message => message.role === 'I')).at(-1) ?? [];
  return { event, messages: messages.map(({ id, role, content, createdAt, pokeInteraction, theaterBackstage }) => ({
    id, role, content, createdAt, ...(pokeInteraction ? { pokeInteraction } : {}),
    ...(role === 'I' && theaterBackstage ? { theaterBackstage } : {}),
  })) };
}
