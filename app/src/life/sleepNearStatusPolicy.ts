import type { NightSleepPlan } from './sleepPlanPolicy';

export type SleepNearStatusPhase = 'sleeping' | 'deep' | 'pre-wake';
export type SleepNearStatusSlot = {
  phase: SleepNearStatusPhase;
  at: number;
  expiresAt: number;
  status: 'pending' | 'requesting' | 'complete' | 'failed' | 'skipped';
  attemptedAt?: number;
  sourceRevision?: number;
  sourceStateKey?: string;
  draft?: { title: string; activity: string };
};
export type SleepNearStatusState = {
  schemaVersion: 1;
  initializedAt: number;
  updatedAt: number;
  sleepAt: number;
  postCount: 2 | 3;
  wakeCount: 1 | 2 | 3;
  slots: Record<string, SleepNearStatusSlot>;
};
export type SleepNearStatusDisplay = {
  nightKey: string;
  slotId: string;
  phase: SleepNearStatusPhase;
  sleepAt: number;
  wakeAt: number;
  deepAt: number;
  preWakeAt: number;
  recordedAt: number;
};

const HALF_HOUR = 30 * 60_000;
const TEN_MINUTES = 10 * 60_000;

/** Only unused pre-wake slots move. Used slots keep their original identity and allowance. */
export function reconcileSleepNearStatusSlots(input: {
  plan: NightSleepPlan; wakeAt: number; now: number; random?: () => number;
}): SleepNearStatusState | undefined {
  const { plan, wakeAt, now } = input;
  const sleepAt = plan.actualSleepAt;
  if (sleepAt === undefined || sleepAt > now || plan.actualWakeAt !== undefined || now >= wakeAt) return plan.nearStatus;
  const random = input.random ?? Math.random;
  const existing = plan.nearStatus;
  const postCount = existing?.postCount ?? (random() < 0.5 ? 2 : 3);
  const wakeCount = existing?.wakeCount ?? Math.min(3, Math.floor(random() * 3) + 1) as 1 | 2 | 3;
  const slots = { ...existing?.slots };
  const preWakeAt = wakeAt - wakeCount * TEN_MINUTES;
  for (let index = 0; index < postCount; index += 1) {
    const id = `post:${index}`;
    const at = sleepAt + (index + 1) * HALF_HOUR;
    const expiresAt = Math.min(at + HALF_HOUR, wakeAt, preWakeAt);
    if (!slots[id]) slots[id] = { phase: index === postCount - 1 ? 'deep' : 'sleeping', at, expiresAt, status: 'pending' };
    if (slots[id].status === 'pending') slots[id] = { ...slots[id], expiresAt,
      status: now >= expiresAt || expiresAt <= at ? 'skipped' : 'pending' };
  }
  for (let index = 0; index < wakeCount; index += 1) {
    const id = `wake:${index}`;
    const at = wakeAt - (wakeCount - index) * TEN_MINUTES;
    if (!slots[id] || slots[id].status === 'pending') slots[id] = {
      phase: 'pre-wake', at, expiresAt: Math.min(at + TEN_MINUTES, wakeAt),
      status: now >= at + TEN_MINUTES || at < sleepAt ? 'skipped' : 'pending',
    };
  }
  const result: SleepNearStatusState = { schemaVersion: 1, initializedAt: existing?.initializedAt ?? now, updatedAt: existing?.updatedAt ?? now,
    sleepAt: existing?.sleepAt ?? sleepAt, postCount, wakeCount, slots };
  return JSON.stringify(result) === JSON.stringify(existing) ? existing : { ...result, updatedAt: now };
}

export function selectSleepNearStatusSlot(state: SleepNearStatusState, now: number) {
  return Object.entries(state.slots).filter(([, slot]) => slot.status === 'pending'
    && now >= slot.at && now < slot.expiresAt)
    .sort((a, b) => Number(b[1].phase === 'pre-wake') - Number(a[1].phase === 'pre-wake') || b[1].at - a[1].at)[0];
}

export function sleepNearStatusDisplay(nightKey: string, state: SleepNearStatusState, slotId: string, wakeAt: number, recordedAt = Date.now()): SleepNearStatusDisplay {
  return { nightKey, slotId, phase: state.slots[slotId].phase, sleepAt: state.sleepAt, wakeAt,
    deepAt: state.sleepAt + state.postCount * HALF_HOUR,
    preWakeAt: wakeAt - state.wakeCount * TEN_MINUTES, recordedAt };
}

export function isSleepNearStatusDisplayCurrent(value: SleepNearStatusDisplay, now: number) {
  if (now < value.sleepAt || now >= value.wakeAt) return false;
  if (value.slotId.startsWith('transition:')) return now >= value.recordedAt && now - value.recordedAt < HALF_HOUR;
  const phase = now >= value.preWakeAt ? 'pre-wake' : now >= value.deepAt ? 'deep' : 'sleeping';
  return value.phase === phase;
}
