import type { BodySignalCareEvent, BodySignalPersonalBaseline } from './bodySignalStructuredTypes';
import type { BodySignalEvaluatedHeartRate } from './bodySignalCareEvents';
import { bodySignalBaselineThresholds } from './bodySignalBaseline';

export const HEART_CARE_FRESH_MS = 600_000;

export function buildHeartCareFacts(input: {
  currentTime: string; lifeModeText: string; recentHeartRateRecords: string;
  usualHeartRateRange: string; activityContext?: string;
}) {
  const activity = input.activityContext
    ? `记录时可确认的活动情况：${input.activityContext}`
    : '这些记录发生时，you 是否正在运动还不清楚。I 想先问问 you 当时在做什么、现在感觉怎么样。';
  return `【这次的心率记录】

现在：${input.currentTime}
I 当前的作息状态：${input.lifeModeText}

you 最近的心率记录：
${input.recentHeartRateRecords}

you 平时的心率参考范围：${input.usualHeartRateRange}
${activity}`;
}

export type HeartCareState = {
  schemaVersion: 2; revision: number; deviceProfileId: string; eligibleSince: number;
  lastReadingId: string; lastMeasuredAt: number; status: 'idle' | 'active';
  nextCheckAt: number; eventId?: string;
};
export type HeartCareObservation = {
  deviceProfileId: string; latest: BodySignalEvaluatedHeartRate;
  baseline?: BodySignalPersonalBaseline; candidate?: BodySignalCareEvent;
  context: BodySignalPersonalBaseline['context']; activityText?: string;
  latestNormal?: { id: string; measuredAt: number };
};
export type HeartCarePorts = {
  now(): number; current(): boolean;
  read(): Promise<HeartCareState | null>;
  write(previous: HeartCareState | null, next: HeartCareState): Promise<boolean>;
  observation(since: number): Promise<HeartCareObservation | null>;
  register(event: BodySignalCareEvent): Promise<void>;
};

// Discovery only. Sending, retrying and marking contact handled belong to the unified owner.
export async function observeHeartCareEpisode(p: HeartCarePorts): Promise<void> {
  let state = await p.read();
  const observed = await p.observation(state?.eligibleSince ?? p.now());
  if (!p.current() || !observed) return;
  const put = async (next: HeartCareState) => {
    if (!p.current() || !await p.write(state, next)) return false;
    state = next;
    return true;
  };
  if (!state || state.deviceProfileId !== observed.deviceProfileId) {
    await put({ schemaVersion: 2, revision: (state?.revision ?? 0) + 1,
      deviceProfileId: observed.deviceProfileId, eligibleSince: p.now(),
      lastReadingId: observed.latest.id, lastMeasuredAt: observed.latest.measuredAt,
      status: 'idle', nextCheckAt: 0 });
    return; // First enable, restore and device switches do not replay existing readings.
  }
  const fresh = observed.latest.measuredAt <= p.now()
    && p.now() - observed.latest.measuredAt <= HEART_CARE_FRESH_MS;
  const limits = observed.baseline?.readiness === 'mature' && observed.baseline.context === observed.context
    && observed.baseline.deviceProfileId === observed.deviceProfileId && observed.baseline.kind === 'heart_rate'
    && Number.isFinite(observed.baseline.median) && Number.isFinite(observed.baseline.mad)
    && observed.baseline.mad >= 0 ? bodySignalBaselineThresholds(observed.baseline) : undefined;
  const latestIsNormal = fresh && limits && observed.latest.value > limits.regularLow
    && observed.latest.value < limits.regularHigh;
  const normal = latestIsNormal ? observed.latest : observed.latestNormal;
  const newNormal = normal && normal.id !== state.lastReadingId && normal.measuredAt > state.lastMeasuredAt
    && normal.measuredAt <= p.now() && p.now() - normal.measuredAt <= HEART_CARE_FRESH_MS ? normal : undefined;
  const event = observed.candidate;
  let next: HeartCareState = { ...state, lastReadingId: observed.latest.id,
    lastMeasuredAt: Math.max(state.lastMeasuredAt, observed.latest.measuredAt),
    nextCheckAt: state.status === 'idle' && fresh ? (Math.floor(p.now() / 300_000) + 1) * 300_000 : 0 };
  if (state.status === 'active' && newNormal) {
    next = { ...next, status: 'idle', eligibleSince: newNormal.measuredAt };
  }
  const eligible = next.status === 'idle' && fresh && limits && event
    && event.observedAt > next.eligibleSince && event.observedAt <= p.now()
    && p.now() - event.observedAt <= HEART_CARE_FRESH_MS
    && event.baselineId === observed.baseline?.id && event.context === observed.context;
  if (eligible) {
    next = { ...next, status: 'active', eventId: event.id, nextCheckAt: 0 };
    // A later real normal reading ends the episode without pretending a message was sent.
    if (newNormal && newNormal.measuredAt > event.observedAt) {
      next = { ...next, status: 'idle', eligibleSince: newNormal.measuredAt };
    }
  }
  if (JSON.stringify(next) !== JSON.stringify(state)
    && !await put({ ...next, revision: state.revision + 1 })) return;
  // Repeat only idempotent registration after a local failure, never recreate a send task.
  if (event && state.eventId === event.id && p.current()) await p.register(event);
}
