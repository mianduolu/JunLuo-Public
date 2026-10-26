import type { AssistantLifeDay } from '../ai/assistantLifeTimeline';
import type { SubjectiveMessage } from '../ai/subjectiveMessages';

export const SLEEP_REPLY_DRAFT_KEY = 'junluo.sleep.pendingReply.v1';
export type SleepReplyDraft = {
  version: 1;
  nightKey: string;
  phase: 'prepare' | 'wake';
  sessionId: string;
  activeSessionId: string | null;
  message: SubjectiveMessage;
  revision: number;
  requestCount: number;
  contextKey: string;
  eventsKey: string;
  sleepAt: number;
  wakeAt: number;
  originalSleepAt: number;
  originalWakeAt: number;
  manualWakeUntil: number;
  manualSleepUntil: number;
  hasDecision: boolean;
};

export function readSleepReplyDraft(raw: string | null): SleepReplyDraft | null {
  if (raw === null) return null;
  const draft = JSON.parse(raw) as SleepReplyDraft;
  if (!draft || draft.version !== 1 || !draft.nightKey || !draft.sessionId
    || !['prepare', 'wake'].includes(draft.phase) || typeof draft.contextKey !== 'string'
    || typeof draft.eventsKey !== 'string' || typeof draft.hasDecision !== 'boolean'
    || !draft.message?.id || draft.message.role !== 'I' || draft.message.source !== 'proactive-message'
    || typeof draft.message.content !== 'string' || !draft.message.content.trim()
    || !Number.isFinite(draft.message.createdAt)
    || ![draft.revision, draft.requestCount, draft.sleepAt, draft.wakeAt, draft.originalSleepAt,
      draft.originalWakeAt, draft.manualWakeUntil, draft.manualSleepUntil].every(Number.isFinite)) {
    throw new Error('sleep-reply-draft-invalid');
  }
  return draft;
}

export type NightSleepPlan = {
  originalSleepAt: number;
  originalWakeAt: number;
  revision: number;
  /** Last successfully saved time change, not opportunity or sleep-status bookkeeping. */
  scheduleChangedAt?: number;
  prepareStatus?: 'attempted' | 'complete' | 'failed' | 'skipped';
  attemptedAt?: number;
  actualSleepAt?: number;
  lastMessageId?: string;
  explicitWakeAt?: number;
  actualWakeAt?: number;
  /** Physically awake; actualWakeAt still means getting out of bed. */
  morningAwakeAt?: number;
  chatOpenedAt?: number;
  pendingSleep?: PendingChatSleep;
  events?: SleepPlanEvent[];
  prepare?: SleepOpportunity;
  wake?: SleepOpportunity;
  nearStatus?: import('./sleepNearStatusPolicy').SleepNearStatusState;
  dayPlan?: import('../schedule/ownDayPlanPolicy').OwnDayPlanNight;
  recovery?: { sleepStartedAt: number; eligible: boolean; estimatedAt?: number; checkedAt: number };
};

export type SleepPlanEvent = {
  id: string;
  kind: 'schedule' | 'sleep_intent' | 'sleep' | 'poke_awake' | 'sleep_return' | 'morning_awake' | 'get_up' | 'late';
  at: number;
  sleepAt?: number;
  wakeAt?: number;
  until?: number;
  sessionId?: string;
  turnId?: string;
  messageIds?: string[];
  toolCallId?: string;
};

export type PendingChatSleep = {
  id: string;
  kind: 'sleep' | 'return';
  decidedAt: number;
  hardDeadlineAt: number;
  round: 1 | 2;
  roundStartedAt: number;
  roundDeadlineAt: number;
  sessionId: string;
  turnId: string;
  sourceMessageIds?: string[];
  turnEndedAt?: number;
  dueAt?: number;
};

export type ChatSleepPlanContext = SleepPlanContext & {
  mode: 'bedtime' | 'morning' | 'poke';
  sessionId: string;
  turnId: string;
  sourceMessageIds?: string[];
  hardDeadlineAt?: number;
  turnStartedAt?: number;
};

export type SleepOpportunity = {
  // Terminal opportunity status is separate from actual message delivery.
  status: 'requesting' | 'retry' | 'complete' | 'failed' | 'skipped';
  requestCount: number;
  retryUsed?: boolean;
  retryAt?: number;
  sessionId?: string;
  messageId?: string;
  contextMessageId?: string;
  deliveredAt?: number;
  toolResult?: SleepScheduleResult;
  toolCall?: { callId: string; input: Record<string, unknown> };
};

export type SleepScheduleResult = {
  subject: 'I'; ok: boolean;
  status: 'applied' | 'unchanged' | 'pending_sleep' | 'invalid_time' | 'stale' | 'unavailable';
  sleepAt: string | null; wakeAt: string | null;
};

export type SleepPlanContext = {
  nightKey: string;
  revision: number;
  requestAt: number;
  originalSleepAt: number;
  originalWakeAt: number;
  currentSleepAt: number;
  currentWakeAt: number;
  manualWakeUntil?: number;
};

export type SleepScheduleSnapshot = SleepPlanContext & {
  actualPhase?: 'awake' | 'sleeping';
  pendingSleep?: Pick<PendingChatSleep, 'decidedAt' | 'hardDeadlineAt' | 'dueAt'>;
  actualSleepAt?: number;
  morningAwakeAt?: number;
  actualWakeAt?: number;
};

export const SLEEP_PREPARE_LEAD_MS = 30 * 60 * 1000;
export const CHAT_SLEEP_LEAD_MS = 60 * 60_000;
export const CHAT_SLEEP_QUIET_MS = 5 * 60_000;
export const CHAT_SLEEP_ROUND_MS = 5 * 60_000;
export const MIN_MAIN_SLEEP_MS = 7 * 60 * 60_000;
const NEAR_STATUS_SLEEP_CHANGE_INTERVAL_MS = 6 * 60 * 60_000;

/** Existing homepage schedule events carry the same operation ID in both refs, without a chat session. */
export function canNearStatusChangeSleepSchedule(day: AssistantLifeDay, now: number): boolean {
  const plan = day.nightSleepPlan;
  if (!plan || plan.actualSleepAt !== undefined || plan.actualWakeAt !== undefined || now >= day.sleepTargetAt) return false;
  const changes = new Map((plan.events ?? []).filter(event => event.kind === 'schedule'
    && event.sessionId === undefined && event.toolCallId !== undefined && event.turnId === event.toolCallId)
    .map(event => [event.id, event.at]));
  return changes.size < 2 && (changes.size === 0
    || now - Math.max(...changes.values()) >= NEAR_STATUS_SLEEP_CHANGE_INTERVAL_MS);
}

/** Upgrade only at the existing life-day read boundary; never grant an old turn new rounds. */
export function normalizeStoredSleepPlan(plan: NightSleepPlan | undefined): NightSleepPlan | undefined {
  const pending = plan?.pendingSleep;
  if (!pending || pending.round !== undefined) return plan;
  const roundDeadlineAt = pending.decidedAt + CHAT_SLEEP_ROUND_MS;
  const turnEndedAt = Math.max(pending.decidedAt, Math.min(pending.turnEndedAt ?? pending.hardDeadlineAt, roundDeadlineAt));
  const dueAt = Math.max(turnEndedAt, Math.min(pending.dueAt ?? pending.hardDeadlineAt, turnEndedAt + CHAT_SLEEP_QUIET_MS));
  return { ...plan!, pendingSleep: { ...pending, round: 2, roundStartedAt: pending.decidedAt, roundDeadlineAt, turnEndedAt, dueAt } };
}

export function pendingSleepDueAt(plan: NightSleepPlan) {
  const pending = plan.pendingSleep;
  return pending ? pending.dueAt ?? pending.roundDeadlineAt + CHAT_SLEEP_QUIET_MS : undefined;
}

/** The same native sleep alarm first closes a stuck turn, then settles its quiet period. */
export function pendingSleepTaskAt(plan: NightSleepPlan) {
  return plan.pendingSleep?.dueAt ?? plan.pendingSleep?.roundDeadlineAt;
}

/** Earliest saved recovery check that also has seven actual sleeping hours in the final hour. */
export function sleepWakeAlarmAt(day: AssistantLifeDay, now: number) {
  const plan = day.nightSleepPlan;
  if (!plan) return day.wakeTargetAt;
  const scheduled = sleepWakeTarget(plan, plan.actualSleepAt ?? day.sleepTargetAt);
  if (!plan.wake && plan.morningAwakeAt !== undefined) return plan.morningAwakeAt;
  if (now >= scheduled || plan.actualSleepAt === undefined || plan.actualWakeAt !== undefined
    || plan.wake || plan.pendingSleep || !plan.recovery?.eligible || !Number.isFinite(plan.recovery.estimatedAt)) return scheduled;
  const candidate = Math.max(scheduled - 60 * 60_000, plan.recovery.estimatedAt!);
  if (candidate >= scheduled) return scheduled;
  let remainingSleep = Math.max(0, MIN_MAIN_SLEEP_MS - actualSleepDurationMs(day, candidate));
  const boundaries = [...new Set([candidate, scheduled,
    ...sleepPhaseBoundaries(day).filter(at => at > candidate && at < scheduled)])].sort((a, b) => a - b);
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const start = boundaries[index], duration = boundaries[index + 1] - start;
    if (nightSleepPhaseAt(day, start) !== 'sleeping') continue;
    if (remainingSleep < duration) return start + remainingSleep;
    remainingSleep -= duration;
  }
  return scheduled;
}

/** Prediction only schedules a check; a reliable current recovery result decides the actual early wake. */
export function canNaturallyWakeEarly(day: AssistantLifeDay, now: number, recovery: { reliable?: boolean; recovered: boolean }) {
  const plan = day.nightSleepPlan;
  return !!plan && recovery.reliable === true && recovery.recovered && plan.actualSleepAt !== undefined
    && plan.actualWakeAt === undefined && plan.morningAwakeAt === undefined && !plan.wake && !plan.pendingSleep
    && now < sleepWakeTarget(plan, plan.actualSleepAt) && now >= sleepWakeAlarmAt(day, now)
    && nightSleepPhaseAt(day, now) === 'sleeping' && actualSleepDurationMs(day, now) >= MIN_MAIN_SLEEP_MS;
}

/** Actual phase only. Undefined leaves untouched historical/default segments in charge. */
export function nightSleepPhaseAt(day: AssistantLifeDay, now: number): 'awake' | 'sleeping' | undefined {
  const plan = day.nightSleepPlan;
  if (!plan) return undefined;
  if (plan.actualWakeAt !== undefined && now >= plan.actualWakeAt) return 'awake';
  if (plan.pendingSleep && now >= plan.pendingSleep.decidedAt) {
    return now < pendingSleepDueAt(plan)! ? 'awake' : 'sleeping';
  }
  if (plan.actualSleepAt === undefined || now < plan.actualSleepAt) {
    return now >= plan.originalSleepAt && plan.actualWakeAt === undefined ? 'awake' : undefined;
  }
  const events = [...(plan.events ?? [])];
  if (plan.morningAwakeAt !== undefined) events.push({ id: 'morning-phase', kind: 'morning_awake', at: plan.morningAwakeAt });
  const last = events.filter(event => event.at <= now
    && ['poke_awake', 'sleep_return', 'morning_awake', 'get_up', 'sleep'].includes(event.kind))
    .sort((a, b) => a.at - b.at || Number(a.kind === 'sleep_return') - Number(b.kind === 'sleep_return')).at(-1);
  if (last?.kind === 'morning_awake' || last?.kind === 'get_up') return 'awake';
  if (last?.kind === 'poke_awake' && (now < (last.until ?? last.at)
    || events.some(event => event.kind === 'sleep_return' && event.at > now))) return 'awake';
  return 'sleeping';
}

export function sleepPhaseBoundaries(day: AssistantLifeDay | null | undefined): number[] {
  const plan = day?.nightSleepPlan;
  return plan ? [plan.actualSleepAt, plan.morningAwakeAt, plan.actualWakeAt,
    plan.originalSleepAt, plan.pendingSleep?.decidedAt, pendingSleepDueAt(plan), ...((plan.events ?? []).flatMap(event =>
      event.kind === 'poke_awake' ? [event.at, event.until] : ['sleep_return', 'morning_awake', 'get_up', 'sleep'].includes(event.kind) ? [event.at] : []))]
    .filter((at): at is number => at !== undefined) : [];
}

export function actualSleepDurationMs(day: AssistantLifeDay, at: number) {
  const startedAt = day.nightSleepPlan?.actualSleepAt;
  if (startedAt === undefined || at <= startedAt) return 0;
  const end = Math.min(at, day.nightSleepPlan?.actualWakeAt ?? at);
  const points = [...new Set([startedAt, end, ...sleepPhaseBoundaries(day).filter(time => time > startedAt && time < end)])].sort((a, b) => a - b);
  return points.slice(0, -1).reduce((total, start, index) => total
    + (nightSleepPhaseAt(day, start) === 'sleeping' ? points[index + 1] - start : 0), 0);
}

export function formatSleepLocalTime(at: number) {
  const date = new Date(at);
  const offset = -date.getTimezoneOffset();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${offset >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}

export function localSleepNightKey(now: number) {
  const date = new Date(now);
  if (date.getHours() < 12) date.setDate(date.getDate() - 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function nextSleepDateKey(key: string) {
  const date = new Date(`${key}T12:00:00`);
  date.setDate(date.getDate() + 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function sleepWakeTarget(plan: NightSleepPlan, actualSleepAt: number) {
  return plan.explicitWakeAt ?? plan.originalWakeAt + Math.max(0, actualSleepAt - plan.originalSleepAt);
}

export function isNightWakeDecisionPending(day: AssistantLifeDay | null, now: number) {
  const plan = day?.nightSleepPlan;
  return !!plan && plan.actualSleepAt !== undefined && plan.actualWakeAt === undefined
    && (plan.morningAwakeAt !== undefined && now >= plan.morningAwakeAt
      || now >= sleepWakeTarget(plan, plan.actualSleepAt))
    && (!plan.wake || plan.wake.status === 'requesting');
}

export function formatSleepSchedule(context: SleepPlanContext | null) {
  const display = (at: number) => formatSleepLocalTime(at).replace('T', ' ').replace(/([+-]\d{2}:\d{2})$/, ' $1');
  return context ? `I 的睡醒安排：\n睡觉：${display(context.currentSleepAt)}\n起床：${display(context.currentWakeAt)}`
    : '暂时没有查到 I 的睡醒安排。';
}

export function parseSleepScheduleTime(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const calendar = Date.parse(`${value.slice(0, 19)}Z`);
  const parsed = Date.parse(value);
  return Number.isFinite(calendar) && new Date(calendar).toISOString().slice(0, 19) === value.slice(0, 19)
    && Number.isFinite(parsed) ? parsed : null;
}

// Adjust only segment boundaries. Existing local dialogue remains untouched.
export function changeNightSleepTime(day: AssistantLifeDay, sleepAt: number, sameDayWake = false): AssistantLifeDay {
  const sleeping = day.segments.find((segment) => segment.id === 'sleep-after-bed')
    ?? day.segments.find((segment) => segment.lifeMode === 'sleeping');
  const end = new Date(`${nextSleepDateKey(day.dateKey)}T00:00:00`).getTime();
  const bedtime = day.segments.find((segment) => segment.id === 'bedtime')
    ?? [...day.segments].reverse().find((segment) => segment.lifeMode !== 'sleeping');
  const segments = day.segments.filter((segment) => segment.id !== 'sleep-after-bed').map((segment) => {
    const endAt = sameDayWake && segment.lifeMode !== 'sleeping'
      ? segment.id === bedtime?.id ? end : segment.endAt
      : segment.id === bedtime?.id ? sleepAt : Math.min(segment.endAt, sleepAt);
    return endAt === segment.endAt ? segment : { ...segment, endAt, generatedDraft: undefined, generatedMaterialKey: undefined };
  });
  if (sleeping && sleepAt < end) segments.push({
    ...sleeping, id: 'sleep-after-bed', startAt: sleepAt, endAt: end,
    generatedDraft: undefined, generatedMaterialKey: undefined,
  });
  return { ...day, sleepTargetAt: sleepAt, segments: segments.filter((segment) => segment.endAt > segment.startAt) };
}

/** A same-day sleep stops at the actual wake; the saved awake fragments resume. */
export function changeNightWakeTime(day: AssistantLifeDay, wakeAt: number): AssistantLifeDay {
  const end = new Date(`${nextSleepDateKey(day.dateKey)}T00:00:00`).getTime();
  if (wakeAt >= end) return day;
  const segments = day.segments.map((segment) => segment.id === 'sleep-after-bed'
    ? { ...segment, endAt: wakeAt, generatedDraft: undefined, generatedMaterialKey: undefined } : segment);
  if (!segments.some((segment) => segment.lifeMode !== 'sleeping' && segment.endAt > wakeAt)) {
    const awake = [...segments].reverse().find((segment) => segment.lifeMode !== 'sleeping');
    if (awake) segments.push({ ...awake, id: 'awake-after-sleep', startAt: wakeAt, endAt: end,
      generatedDraft: undefined, generatedMaterialKey: undefined });
  }
  return { ...day, segments: segments.filter((segment) => segment.endAt > segment.startAt) };
}

export function changeMorningWakeTime(day: AssistantLifeDay, wakeAt: number, night?: AssistantLifeDay): AssistantLifeDay {
  const midnight = new Date(`${day.dateKey}T00:00:00`).getTime();
  const endOfDay = new Date(`${nextSleepDateKey(day.dateKey)}T00:00:00`).getTime();
  const bedtime = night?.segments.find((segment) => segment.id === 'bedtime');
  const firstAwake = day.segments.find((segment) => segment.lifeMode !== 'sleeping' && segment.id !== 'bedtime-before-sleep');
  const waiting = night && bedtime && night.sleepTargetAt > midnight ? [{
    ...bedtime, id: 'bedtime-before-sleep', startAt: midnight, endAt: Math.min(endOfDay, night.sleepTargetAt),
    generatedDraft: undefined, generatedMaterialKey: undefined,
  }] : [];
  const sleeping = night?.segments.find((segment) => segment.id === 'sleep-after-bed')
    ?? day.segments.find((segment) => segment.lifeMode === 'sleeping');
  const segments = !day.segments.some((segment) => segment.id === 'sleep-before-wake') && sleeping && wakeAt > midnight
    ? [{ ...sleeping, id: 'sleep-before-wake', startAt: midnight, endAt: wakeAt,
      generatedDraft: undefined, generatedMaterialKey: undefined }, ...day.segments] : day.segments;
  return {
    ...day, wakeTargetAt: wakeAt,
    segments: [...waiting, ...segments.filter((segment) => segment.id !== 'bedtime-before-sleep').map((segment) => {
      const startAt = segment.id === firstAwake?.id ? wakeAt : segment.lifeMode !== 'sleeping' ? Math.max(segment.startAt, wakeAt)
        : segment.id === 'sleep-before-wake' && night ? Math.max(midnight, night.sleepTargetAt) : segment.startAt;
      const endAt = segment.id === 'sleep-before-wake' ? wakeAt : segment.endAt;
      return startAt === segment.startAt && endAt === segment.endAt ? segment : {
        ...segment, startAt, endAt, generatedDraft: undefined, generatedMaterialKey: undefined,
      };
    }).filter((segment) => segment.endAt > segment.startAt)],
  };
}
