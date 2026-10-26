import { loadAssistantState } from '../ai/assistantState';
import { readRelevantSleepNight } from '../life/sleepPlanStore';
import { readLatestSleepTransition } from '../life/sleepExperienceMaterial';
import { nightSleepPhaseAt, type SleepOpportunity } from '../life/sleepPlanPolicy';
import { loadChatSessionMessage } from '../chat/chatStorage';
import {
  focusSleepLogTrigger,
  focusSleepMotionIntervalMs,
  type FocusSleepLogKind,
} from './focusSleepPolicy';
import type { ActiveFocusSession, FocusLogEntry } from './focusStore';

type RuntimeLog = Omit<FocusLogEntry, 'sessionId'>;
type Transition = { key: string; at: number; ready: boolean; content?: string };
export type FocusSleepSnapshot = {
  sleeping: boolean;
  sleepKey: string;
  lastSleepAt?: number;
  lastWakeAt?: number;
  awakeActivity?: string;
  preparing?: Transition;
  waking?: Transition;
};

async function readOpportunity(opportunity: SleepOpportunity | undefined) {
  if (opportunity?.sessionId && opportunity.messageId) {
    const message = await loadChatSessionMessage(opportunity.sessionId, opportunity.messageId).catch(error => {
      console.warn('[focus] saved sleep message unavailable', error);
      return undefined;
    });
    if (message === undefined) return { ready: false, unreadable: true };
    if (message?.role === 'I' && message.content.trim()) return { ready: true, content: message.content, at: message.createdAt };
  }
  // Complete can precede local delivery. A missing saved body is not permission for another HTTP.
  return { ready: opportunity?.status === 'failed' || opportunity?.status === 'skipped' };
}

/** Consume the same saved mode and sleep events as the life runtime; never settle or decide sleep. */
export async function readFocusSleepSnapshot(now = Date.now()): Promise<FocusSleepSnapshot> {
  const [state, day, latestTransition] = await Promise.all([
    loadAssistantState(), readRelevantSleepNight(now), readLatestSleepTransition(now),
  ]);
  const plan = day?.nightSleepPlan;
  // Getting up can make the relevant *next* night replace the just-woken night.
  const eventDay = latestTransition?.day ?? day;
  const eventPlan = eventDay?.nightSleepPlan;
  const events = eventPlan?.events?.filter(event => event.at <= now) ?? [];
  const lastSleep = events.filter(event => event.kind === 'sleep' || event.kind === 'sleep_return')
    .sort((a, b) => b.at - a.at)[0];
  const lastSleepAt = lastSleep?.at ?? eventPlan?.actualSleepAt;
  const lastWakeAt = Math.max(0, ...events.filter(event => ['morning_awake', 'get_up', 'poke_awake'].includes(event.kind))
    .map(event => event.at));
  const sleeping = state.lifeMode === 'sleeping';
  const snapshot: FocusSleepSnapshot = {
    sleeping,
    sleepKey: !sleeping && lastSleepAt === undefined ? 'none' : lastSleep ? `${eventDay!.dateKey}:${lastSleep.id}`
      : `sleep:${lastSleepAt ?? state.manualSleepUntil ?? state.sleepNearStatus?.sleepAt ?? state.scheduleSlot ?? 'current'}`,
    lastSleepAt,
    lastWakeAt,
    awakeActivity: !sleeping && (state.textUpdatedAt ?? 0) > 0
      && (state.textUpdatedAt ?? 0) >= Math.max(lastSleepAt ?? 0, lastWakeAt) && state.sourceType !== 'sleep'
      ? state.activity.trim() : undefined,
  };
  if (sleeping) return snapshot;
  const preparingAwake = day && plan && nightSleepPhaseAt(day, now) !== 'sleeping';
  const pending = preparingAwake ? plan.pendingSleep : undefined;
  if (pending?.kind === 'sleep' && pending.decidedAt <= now) {
    let content: string | undefined;
    let sourceReadable = true;
    if (pending.turnEndedAt !== undefined) {
      const messages = await Promise.all((pending.sourceMessageIds ?? []).map(id => (
        loadChatSessionMessage(pending.sessionId, id)
      ))).catch(error => {
        console.warn('[focus] saved sleep farewell unavailable', error);
        sourceReadable = false;
        return [];
      });
      content = messages.filter(message => message?.role === 'I' && message.content.trim())
        .map(message => message!.content).join('\n\n') || undefined;
    }
    snapshot.preparing = { key: `${day!.dateKey}:${pending.id}`, at: pending.decidedAt,
      ready: sourceReadable && pending.turnEndedAt !== undefined, content };
  } else if (preparingAwake && plan.prepare && plan.actualSleepAt === undefined) {
    const original = await readOpportunity(plan.prepare);
    const sourceAt = original.at ?? plan.attemptedAt ?? 0;
    const superseded = (plan.scheduleChangedAt ?? 0) > sourceAt
      && plan.lastMessageId !== plan.prepare.messageId;
    if (!superseded && (original.content || plan.prepare.toolResult?.ok)) {
      snapshot.preparing = { key: `${day.dateKey}:prepare:${plan.prepare.messageId ?? plan.attemptedAt}`,
        ...original, at: sourceAt };
    }
  }
  const naturalWake = events.filter(event => (event.kind === 'morning_awake'
    || event.kind === 'get_up' && eventPlan?.morningAwakeAt !== undefined)
    && event.at >= (lastSleepAt ?? Infinity)).sort((a, b) => b.at - a.at)[0];
  const laterPoke = naturalWake && events.some(event => event.kind === 'poke_awake'
    && event.at >= Math.max(lastSleepAt ?? 0, eventPlan?.morningAwakeAt ?? 0));
  if (naturalWake && !laterPoke && !(state.wakeSource === 'poke' && (state.manualWakeUntil ?? 0) > now)) {
    const original = await readOpportunity(eventPlan?.wake);
    const wakeBoundary = (eventPlan?.morningAwakeAt ?? 0) >= (lastSleepAt ?? Infinity)
      ? eventPlan!.morningAwakeAt! : naturalWake.at;
    const currentBody = original.content && (original.at ?? -Infinity) >= wakeBoundary ? original.content : undefined;
    const closed = eventPlan?.actualWakeAt !== undefined;
    // A closed night without a wake opportunity cannot start a later global wake request.
    snapshot.waking = { key: `${eventDay!.dateKey}:natural:${eventPlan?.morningAwakeAt}:${lastSleepAt}`,
      content: currentBody, at: naturalWake.at,
      ready: !original.unreadable && (!!currentBody || (!original.content && original.ready) || closed
        && (!eventPlan?.wake || eventPlan.wake.status === 'complete')) };
  }
  return snapshot;
}

type LiveSession = Pick<ActiveFocusSession, 'startedAt' | 'userActivity' | 'logs' | 'baiyunActivity'> & {
  elapsedSeconds: number;
};
type SleepRuntimeDependencies = {
  now?: () => number;
  read?: () => Promise<FocusSleepSnapshot>;
  isVisible: () => boolean;
  getSession: () => LiveSession | null;
  generate: (kind: FocusSleepLogKind, userActivity: string) => Promise<string>;
  captureEpoch: () => number | null;
  canCommit: (epoch: number) => boolean;
  save: (log: RuntimeLog, startedAt: number, epoch: number, canSave: () => Promise<boolean>) => Promise<boolean>;
  onState: (snapshot: FocusSleepSnapshot, hasSlept: boolean) => void;
};

/** One page-local rhythm. Saved log identities anchor restarts; missed invisible nodes are skipped. */
export function createFocusSleepRuntime(deps: SleepRuntimeDependencies) {
  const now = deps.now ?? Date.now;
  const read = deps.read ?? readFocusSleepSnapshot;
  let busy = false;
  let rerun = false;
  let visibilityRevision = 0;
  let baselineAt = 0;
  let observedAt = 0;
  let previous: FocusSleepSnapshot | undefined;
  let sessionStartedAt = 0;
  let hasSlept = false;
  let anchorId = '';
  let motionDueAt = 0;
  let wakingKey: string | undefined;
  let delivery: { log: RuntimeLog; kind: FocusSleepLogKind; key: string; startedAt: number; visibility: number; epoch: number } | undefined;
  const attempted = new Set<string>();

  const suspend = () => {
    visibilityRevision += 1;
    baselineAt = 0;
    observedAt = 0;
    previous = undefined;
    wakingKey = undefined;
    delivery = undefined;
  };
  const valid = (snapshot: FocusSleepSnapshot, kind: FocusSleepLogKind, key: string) => (
    kind === 'motion' ? snapshot.sleeping && snapshot.sleepKey === key
      : kind === 'preparing' ? !snapshot.sleeping && snapshot.preparing?.key === key
        : !snapshot.sleeping && snapshot.waking?.key === key
  );
  const tickOnce = async () => {
    if (!deps.isVisible()) return;
    const epoch = deps.captureEpoch();
    if (epoch === null) return;
    const visibility = visibilityRevision;
    const snapshot = await read();
    if (!deps.canCommit(epoch) || !deps.isVisible() || visibility !== visibilityRevision) return;
    const at = now();
    const session = deps.getSession();
    if (session && session.startedAt !== sessionStartedAt) hasSlept = false;
    hasSlept ||= snapshot.sleeping || !!session?.logs.some(log => log.trigger === focusSleepLogTrigger('opening')
      || log.trigger === focusSleepLogTrigger('motion') || log.trigger.startsWith(focusSleepLogTrigger('waking'))
      || log.trigger === 'focus-sleep-opening-failed')
      || !!session && (session.baiyunActivity === '休息：睡觉'
        || (snapshot.lastSleepAt ?? -Infinity) >= session.startedAt);
    deps.onState(snapshot, hasSlept);
    if (!session) { previous = snapshot; return; }
    const resumed = !baselineAt || session.startedAt !== sessionStartedAt || at - observedAt > 60_000;
    if (session.startedAt !== sessionStartedAt) {
      sessionStartedAt = session.startedAt;
      anchorId = '';
      motionDueAt = 0;
      attempted.clear();
      delivery = undefined;
    }
    const enteredSleep = snapshot.sleeping && previous && (!previous.sleeping || previous.sleepKey !== snapshot.sleepKey);
    if (enteredSleep) { anchorId = ''; motionDueAt = 0; }
    if (resumed) {
      baselineAt = at;
      wakingKey = undefined;
    } else if (previous?.sleeping && !snapshot.sleeping && snapshot.waking
      && snapshot.waking.at >= baselineAt) wakingKey = snapshot.waking.key;
    observedAt = at;
    previous = snapshot;

    const lastAnchor = [...session.logs].reverse().find(log => log.role === 'I'
      && log.createdAt > (snapshot.lastWakeAt ?? 0) && (
      log.trigger === focusSleepLogTrigger('opening') || log.trigger === focusSleepLogTrigger('motion')
      || log.trigger.startsWith(focusSleepLogTrigger('preparing'))
    ));
    if (lastAnchor && lastAnchor.id !== anchorId) {
      anchorId = lastAnchor.id;
      motionDueAt = lastAnchor.createdAt + focusSleepMotionIntervalMs(anchorId);
    }
    if (snapshot.sleeping && !motionDueAt) {
      anchorId = `${session.startedAt}:${snapshot.sleepKey}`;
      motionDueAt = at + focusSleepMotionIntervalMs(anchorId);
    }
    if (resumed && motionDueAt && motionDueAt <= at) {
      motionDueAt = at + focusSleepMotionIntervalMs(`${anchorId}:resume:${at}`);
    }

    if (delivery) {
      if (!valid(snapshot, delivery.kind, delivery.key) || delivery.startedAt !== session.startedAt
        || delivery.visibility !== visibility || !deps.canCommit(delivery.epoch)) delivery = undefined;
      else {
        const pending = delivery;
        if (await deps.save(pending.log, session.startedAt, pending.epoch, async () => (
          deps.canCommit(pending.epoch) && deps.isVisible() && pending.visibility === visibilityRevision
            && deps.getSession()?.startedAt === pending.startedAt && valid(await read(), pending.kind, pending.key)
        ))) delivery = undefined;
        return;
      }
    }
    let kind: FocusSleepLogKind | undefined;
    let transition: Transition | undefined;
    if (!resumed && snapshot.preparing && snapshot.preparing.at >= baselineAt) {
      kind = 'preparing'; transition = snapshot.preparing;
    } else if (wakingKey && snapshot.waking?.key === wakingKey) {
      kind = 'waking'; transition = snapshot.waking;
    }
    if (transition && (!transition.ready || attempted.has(focusSleepLogTrigger(kind!, transition.key))
      || session.logs.some(log => log.trigger === focusSleepLogTrigger(kind!, transition!.key)))) {
      kind = undefined;
    }
    if (!kind && snapshot.sleeping && !resumed && at >= motionDueAt) kind = 'motion';
    if (!kind) return;
    const key = kind === 'motion' ? snapshot.sleepKey : transition!.key;
    const trigger = focusSleepLogTrigger(kind, kind === 'motion' ? undefined : key);
    attempted.add(trigger);
    // Advance an attempted node even on model failure; do not retry remote generation every tick.
    if (kind === 'motion') motionDueAt = at + focusSleepMotionIntervalMs(`${anchorId}:attempt:${at}`);
    const content = transition?.content ?? await deps.generate(kind, session.userActivity);
    if (!content.trim() || !deps.canCommit(epoch) || !deps.isVisible() || visibility !== visibilityRevision) return;
    const latest = await read();
    if (!deps.canCommit(epoch) || !valid(latest, kind, key) || !deps.isVisible() || visibility !== visibilityRevision
      || deps.getSession()?.startedAt !== session.startedAt) return;
    const createdAt = now();
    const log: RuntimeLog = {
      id: `focus-sleep:${session.startedAt}:${kind}:${createdAt}`,
      role: 'I', content, createdAt,
      elapsedSeconds: deps.getSession()!.elapsedSeconds, trigger,
    };
    delivery = { log, kind, key, startedAt: session.startedAt, visibility, epoch };
    if (await deps.save(log, session.startedAt, epoch, async () => (
      deps.canCommit(epoch) && deps.isVisible() && visibility === visibilityRevision
        && deps.getSession()?.startedAt === session.startedAt && valid(await read(), kind!, key)
    ))) delivery = undefined;
  };
  const tick = async () => {
    if (busy) { rerun = true; return; }
    busy = true;
    try {
      do {
        rerun = false;
        await tickOnce();
      } while (rerun && deps.isVisible());
    } catch (error) {
      console.warn('[focus] sleep companion unavailable', error);
    } finally { busy = false; }
  };
  return { tick, suspend };
}
