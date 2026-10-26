import { bodySignalBaselineThresholds, bucketBodySignalBaselineSamples } from './bodySignalBaseline';
import type { BodySignalConfidence, BodySignalProvider } from './bodySignalTypes';
import type {
  BodySignalCareDirection,
  BodySignalCareEvent,
  BodySignalCareReason,
  BodySignalContextBucket,
  BodySignalPersonalBaseline,
} from './bodySignalStructuredTypes';

export type BodySignalEvaluatedHeartRate = {
  confidence: BodySignalConfidence;
  context?: BodySignalContextBucket;
  deviceProfileId?: string;
  id: string;
  measuredAt: number;
  sourceDeviceName?: string;
  sourceProvider: BodySignalProvider;
  value: number;
};

export const BODY_SIGNAL_CARE_FRESHNESS_MS = 10 * 60_000;
const FIVE_MINUTES_MS = 5 * 60_000;

function directionFor(value: number, low: number, high: number): BodySignalCareDirection | undefined {
  if (value <= low) return 'low';
  if (value >= high) return 'high';
  return undefined;
}

function makeEvent(input: {
  baseline?: BodySignalPersonalBaseline;
  context: BodySignalContextBucket;
  contextConfidence: number;
  direction: BodySignalCareDirection;
  evidence: readonly BodySignalEvaluatedHeartRate[];
  now: number;
  reason: BodySignalCareReason;
  severity: BodySignalCareEvent['severity'];
  deviceProfileId: string;
}): BodySignalCareEvent {
  const observedAt = Math.max(...input.evidence.map((item) => item.measuredAt));
  const dedupeKey = [input.deviceProfileId, 'heart_rate', input.context, input.direction, input.reason].join(':');
  const latestReading = input.evidence[input.evidence.length - 1];
  const id = `care:${dedupeKey}:${latestReading.id}`;
  return {
    ...(input.baseline ? { baselineId: input.baseline.id } : {}),
    context: input.context,
    contextConfidence: input.contextConfidence,
    createdAt: input.now,
    dedupeKey,
    direction: input.direction,
    dismissedAt: undefined,
    evidence: input.evidence.map((reading, index) => ({
      confidence: reading.confidence,
      eventId: id,
      id: `${id}:evidence:${index}`,
      kind: 'heart_rate',
      measuredAt: reading.measuredAt,
      readingId: reading.id,
      sourceDeviceName: reading.sourceDeviceName,
      sourceProvider: reading.sourceProvider,
      unit: 'bpm',
      value: reading.value,
    })),
    expiresAt: observedAt + BODY_SIGNAL_CARE_FRESHNESS_MS,
    handledAt: undefined,
    id,
    kind: 'heart_rate',
    observedAt,
    reason: input.reason,
    severity: input.severity,
    status: 'pending',
    updatedAt: input.now,
  };
}

export function evaluateBodySignalHeartRateEvent(input: {
  baseline?: BodySignalPersonalBaseline;
  context: BodySignalContextBucket;
  contextConfidence: number;
  deviceProfileId: string;
  now?: number;
  readings: readonly BodySignalEvaluatedHeartRate[];
}): BodySignalCareEvent | undefined {
  const now = input.now ?? Date.now();
  const baseline = input.baseline;
  if (baseline?.readiness !== 'mature'
    || baseline.context !== input.context
    || baseline.deviceProfileId !== input.deviceProfileId
    || baseline.kind !== 'heart_rate'
    || !Number.isFinite(baseline.median)
    || !Number.isFinite(baseline.mad)
    || baseline.mad < 0) return undefined;
  const seenIds = new Set<string>();
  const readings = [...input.readings]
    .filter((reading) => Number.isFinite(reading.measuredAt)
      && Number.isFinite(reading.value) && reading.value > 0 && reading.measuredAt <= now)
    .sort((left, right) => left.measuredAt - right.measuredAt || left.id.localeCompare(right.id))
    .filter((reading) => {
      if (seenIds.has(reading.id)) return false;
      seenIds.add(reading.id);
      return true;
    });
  if (readings.length === 0) return undefined;
  const matchesContext = (reading: BodySignalEvaluatedHeartRate) =>
    (reading.context ?? input.context) === input.context
    && (reading.deviceProfileId ?? input.deviceProfileId) === input.deviceProfileId;
  const latest = readings[readings.length - 1];
  if (!matchesContext(latest) || now - latest.measuredAt > BODY_SIGNAL_CARE_FRESHNESS_MS) return undefined;
  const limits = bodySignalBaselineThresholds(baseline);
  // Several saved samples can arrive before JS wakes. Inspect each fresh raw
  // sample in the current context, not just the final value or bucket median.
  for (let index = readings.length - 1; index >= 0; index -= 1) {
    const reading = readings[index];
    if (!matchesContext(reading) || now - reading.measuredAt > BODY_SIGNAL_CARE_FRESHNESS_MS) break;
    const clearDirection = directionFor(reading.value, limits.clearLow, limits.clearHigh);
    if (clearDirection) {
      return makeEvent({ ...input, baseline, direction: clearDirection, evidence: [reading], now, reason: 'mature_clear_deviation', severity: 'concern' });
    }
  }

  const groups = new Map<number, BodySignalEvaluatedHeartRate[]>();
  for (const reading of readings) {
    const start = Math.floor(reading.measuredAt / FIVE_MINUTES_MS) * FIVE_MINUTES_MS;
    const group = groups.get(start) ?? [];
    group.push(reading);
    groups.set(start, group);
  }
  let streak: { start: number; reading: BodySignalEvaluatedHeartRate }[] = [];
  let streakDirection: BodySignalCareDirection | undefined;
  for (const [start, group] of groups) {
    const direction = directionFor(bucketBodySignalBaselineSamples(group)[0].value, limits.regularLow, limits.regularHigh);
    // A normal raw sample or context/direction switch breaks continuity even when
    // the median would hide it. Callers must pass the unfiltered context timeline.
    const uninterrupted = direction && group.every((reading) => matchesContext(reading)
      && directionFor(reading.value, limits.regularLow, limits.regularHigh) === direction);
    if (!uninterrupted) {
      streak = [];
      streakDirection = undefined;
      continue;
    }
    if (streakDirection !== direction || (streak.length > 0
      && start - streak[streak.length - 1].start > BODY_SIGNAL_CARE_FRESHNESS_MS)) streak = [];
    streakDirection = direction;
    // An open group may break an older streak but cannot count toward three.
    if (start + FIVE_MINUTES_MS <= now) streak.push({ start, reading: group[group.length - 1] });
  }
  const evidence = streak.slice(-3).map((group) => group.reading);
  if (evidence.length === 3 && streakDirection
    && now - evidence[2].measuredAt <= BODY_SIGNAL_CARE_FRESHNESS_MS) {
    return makeEvent({ ...input, baseline, direction: streakDirection, evidence, now, reason: 'mature_repeated_deviation', severity: 'support' });
  }
  return undefined;
}
