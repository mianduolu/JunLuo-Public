import { Platform } from 'react-native';
import { runChatAuxiliaryOperation } from '../chat/chatAuxiliaryDiagnostics';
import { captureBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { loadAssistantState } from '../ai/assistantState';
import { loadActiveFocusSession } from '../focus/focusStore';
import { buildJunluoDesirePromptPaper, calculateJunluoDesireSnapshot, settleJunluoDesireTime, repairJunluoDesireClock,
  type JunluoDesireEffectiveSnapshot } from './junluoDesireMetabolism';
import { loadJunluoAffectState, loadJunluoDesireState, updateJunluoDesireState } from './junluoInnerStateStore';
import type { JunluoDesireState, JunluoDesireTimeContext } from './junluoInnerState';
import { loadJunluoRemindYouValue } from './junluoReminderDesire';
import { buildPhaseIntervals, loadRhythmState } from './lifeRhythm';

export const isWantsClockOwner = () => Platform.OS === 'android';

export async function isJunluoWantsAwake(now = Date.now()) {
  const [assistant, rhythm] = await Promise.all([loadAssistantState(), loadRhythmState(now)]);
  if (assistant.manualWakeUntil !== undefined && assistant.manualWakeUntil > now) return true;
  if (assistant.manualSleepUntil !== undefined && assistant.manualSleepUntil > now) return false;
  return rhythm.phase !== 'sleeping' && assistant.lifeMode !== 'sleeping';
}

// Use the existing sleep intervals, with context changes at their real saved times.
// All reads happen outside the desire writer; the writer merges its latest state.
export async function refreshJunluoDesireClock(now = Date.now(), readOnly = false) {
  // Live settlement may catch up to now, never to a future planning timestamp.
  now = Math.min(now, Date.now());
  if (!isWantsClockOwner()) return loadJunluoDesireState(readOnly);
  const dataEpoch = captureBackupRestoreDataEpoch();
  const [previous, assistant, affect, focus] = await Promise.all([
    loadJunluoDesireState(readOnly), loadAssistantState(), loadJunluoAffectState(readOnly),
    loadActiveFocusSession(true),
  ]);
  const intervals = previous.clock.context ? await buildPhaseIntervals(previous.clock.settledAt, now + 1, {
    manualWakeUntil: assistant.manualWakeUntil, manualSleepUntil: assistant.manualSleepUntil,
    manualOverrideStartedAt: assistant.manualWakeUntil !== undefined
      ? assistant.manualWakeUntil - 15 * 60_000 : assistant.updatedAt,
  }) : [];
  // The one-millisecond probe reads the exact boundary; settlement remains capped at now.
  const awake = intervals.length ? intervals.at(-1)!.phase !== 'sleeping' : await isJunluoWantsAwake(now);
  const busy = assistant.lifeMode === 'self-time' || Boolean(focus && focus.mode === 'cowork' && !focus.paused && focus.baiyunActivity.trim());
  const busyAt = Math.min(now, focus && focus.mode === 'cowork' && !focus.paused
    ? focus.startedAt : assistant.updatedAt);
  const project = (current: JunluoDesireState) => {
    const actualNow = Date.now();
    // An intentionally older read must not be mistaken for a polluted future clock.
    if (current.clock.settledAt > actualNow) return repairJunluoDesireClock(current, actualNow);
    if (JSON.stringify(current.clock) !== JSON.stringify(previous.clock)) return current;
    let next = current;
    const context: JunluoDesireTimeContext = current.clock.context ?? {
      awake, busy, relationshipChoice: affect.relationshipChoice.value, lastYouMessageAt: null,
    };
    if (!current.clock.context) return settleJunluoDesireTime({ state: current, now, nextContext: context });
    const changes: Array<{ at: number; patch: Partial<JunluoDesireTimeContext> }> = [];
    for (const interval of intervals) {
      if (interval.endAt <= current.clock.settledAt) continue;
      changes.push({ at: interval.startAt, patch: { awake: interval.phase !== 'sleeping' } });
    }
    if (context.relationshipChoice !== affect.relationshipChoice.value) changes.push({
      at: affect.relationshipChoice.updatedAt, patch: { relationshipChoice: affect.relationshipChoice.value },
    });
    if (context.busy !== busy) changes.push({ at: busyAt, patch: { busy } });
    changes.push({ at: now, patch: { awake, busy, relationshipChoice: affect.relationshipChoice.value } });
    changes.sort((a, b) => a.at - b.at);
    for (const change of changes) {
      const at = Math.max(next.clock.settledAt, Math.min(now, change.at));
      if (at > now) continue;
      next = settleJunluoDesireTime({ state: next, now: at,
        nextContext: { ...next.clock.context!, ...change.patch } });
    }
    return settleJunluoDesireTime({ state: next, now });
  };
  return readOnly ? project(previous) : updateJunluoDesireState(project, { dataEpoch });
}

async function noteContext(patch: Partial<JunluoDesireTimeContext>, occurredAt: number,
  dataEpoch = captureBackupRestoreDataEpoch()) {
  if (!isWantsClockOwner()) return;
  const [snapshot, assistant, rhythm, affect, focus] = await Promise.all([
    loadJunluoDesireState(), loadAssistantState(), loadRhythmState(), loadJunluoAffectState(), loadActiveFocusSession(true),
  ]);
  const now = Date.now();
  const intervals = snapshot.clock.context ? await buildPhaseIntervals(snapshot.clock.settledAt, Math.max(snapshot.clock.settledAt, Math.min(now, occurredAt)), {
    manualWakeUntil: assistant.manualWakeUntil, manualSleepUntil: assistant.manualSleepUntil,
    manualOverrideStartedAt: assistant.manualWakeUntil !== undefined
      ? assistant.manualWakeUntil - 15 * 60_000 : assistant.updatedAt,
  }) : [];
  if (patch.relationshipChoice !== undefined && patch.relationshipChoice !== affect.relationshipChoice.value) return;
  await updateJunluoDesireState(current => {
    if (patch.lastYouMessageAt === undefined && JSON.stringify(current.clock) !== JSON.stringify(snapshot.clock)) return current;
    current = repairJunluoDesireClock(current, Date.now());
    const previous = current.clock.context ?? { awake: rhythm.phase !== 'sleeping',
      busy: assistant.lifeMode === 'self-time' || Boolean(focus && focus.mode === 'cowork' && !focus.paused && focus.baiyunActivity.trim()),
      relationshipChoice: affect.relationshipChoice.value, lastYouMessageAt: null };
    // Late synchronized messages keep the sender's original time, never their receive time.
    if (patch.lastYouMessageAt !== undefined && previous.lastYouMessageAt !== null
      && patch.lastYouMessageAt! <= previous.lastYouMessageAt) return current;
    let next = current;
    if (next.clock.context) for (const interval of intervals) {
      if (interval.endAt <= next.clock.settledAt) continue;
      next = settleJunluoDesireTime({ state: next, now: Math.max(next.clock.settledAt, interval.startAt),
        nextContext: { ...next.clock.context!, awake: interval.phase !== 'sleeping' } });
      next = settleJunluoDesireTime({ state: next, now: interval.endAt });
    }
    const at = Math.max(next.clock.settledAt, Math.min(now, occurredAt));
    return settleJunluoDesireTime({ state: next, now: at, nextContext: { ...(next.clock.context ?? previous), ...patch } });
  }, { dataEpoch });
}

export function noteJunluoRelationshipChoice(value: number, occurredAt: number) {
  return noteContext({ relationshipChoice: value }, occurredAt);
}
export function noteJunluoSleepPhase(awake: boolean, occurredAt: number) {
  return noteContext({ awake }, occurredAt);
}

export async function settleJunluoSleepIntervals(intervals: readonly { startAt: number; endAt: number; phase: string }[],
  awake: boolean, now: number) {
  if (!isWantsClockOwner()) return;
  const dataEpoch = captureBackupRestoreDataEpoch();
  const actualNow = Date.now();
  now = Math.min(now, actualNow);
  await updateJunluoDesireState(current => {
    current = repairJunluoDesireClock(current, Date.now());
    if (!current.clock.context) return current;
    let next = current;
    for (const interval of intervals) {
      if (interval.startAt > now) continue;
      if (interval.endAt <= next.clock.settledAt) continue;
      next = settleJunluoDesireTime({ state: next, now: Math.max(next.clock.settledAt, interval.startAt),
        nextContext: { ...next.clock.context!, awake: interval.phase !== 'sleeping' } });
      next = settleJunluoDesireTime({ state: next, now: Math.min(now, interval.endAt) });
    }
    return settleJunluoDesireTime({ state: next, now: Math.max(next.clock.settledAt, now),
      nextContext: { ...next.clock.context!, awake } });
  }, { dataEpoch });
}
export function noteJunluoYouMessage(occurredAt: number, dataEpoch = captureBackupRestoreDataEpoch()) {
  if (!Number.isSafeInteger(occurredAt) || occurredAt < 0 || occurredAt > Date.now()) return Promise.resolve();
  return runChatAuxiliaryOperation({ phase: 'commit', stage: 'wants_clock', retryLocalSave: false },
    () => noteContext({ lastYouMessageAt: occurredAt }, occurredAt, dataEpoch)).then(() => undefined);
}

// Seed only the time reference from real saved messages; never replay old numeric changes.
// Called outside message/storage writers by the existing life check, even with auto calls off.
export async function initializeJunluoYouMessageClock() {
  if (!isWantsClockOwner()) return;
  const dataEpoch = captureBackupRestoreDataEpoch();
  const state = await loadJunluoDesireState();
  if (state.clock.context?.lastYouMessageAt != null) return;
  const { loadChatStateFast, loadChatSessionMessageOrder, loadChatSessionMessage } = await import('../chat/chatStorage');
  const { sessions } = await loadChatStateFast({ activeMessageLimit: 1 });
  let latest = -1;
  for (const session of [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)) {
    if (session.updatedAt <= latest) continue;
    const positions = (await loadChatSessionMessageOrder(session.id))
      .filter(position => position.createdAt > latest && position.createdAt <= Date.now())
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
    for (const position of positions) {
      const message = await loadChatSessionMessage(session.id, position.id);
      if (message?.role === 'you' && message.source !== 'letter') {
        latest = Math.max(latest, message.createdAt); break;
      }
    }
  }
  if (latest >= 0) await noteJunluoYouMessage(latest, dataEpoch);
}
export async function noteJunluoActivityChange(occurredAt = Date.now()) {
  const dataEpoch = captureBackupRestoreDataEpoch();
  const [assistant, focus] = await Promise.all([loadAssistantState(), loadActiveFocusSession(true)]);
  return noteContext({ busy: assistant.lifeMode === 'self-time'
    || Boolean(focus && focus.mode === 'cowork' && !focus.paused && focus.baiyunActivity.trim()) }, occurredAt, dataEpoch);
}

export async function loadJunluoDesireSnapshot(now = Date.now(), readOnly = false): Promise<JunluoDesireEffectiveSnapshot> {
  now = Math.min(now, Date.now());
  const [state, reminders, rhythm] = await Promise.all([
    refreshJunluoDesireClock(now, readOnly), loadJunluoRemindYouValue(now, readOnly).catch(() => 0), loadRhythmState(now),
  ]);
  return calculateJunluoDesireSnapshot({ now, state: state ?? await loadJunluoDesireState(readOnly), structural: {
    remindYouValue: reminders, sleepDebt: rhythm.sleepDebt, sleepPressure: rhythm.sleepPressure,
  } });
}
export async function loadJunluoDesirePromptPaper(now = Date.now(), readOnly = false) {
  return buildJunluoDesirePromptPaper(await loadJunluoDesireSnapshot(now, readOnly));
}
