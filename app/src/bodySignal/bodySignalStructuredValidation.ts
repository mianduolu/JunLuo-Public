import type {
  BodySignalActivityDailySummary,
  BodySignalActivitySample,
  BodySignalCareEvent,
  BodySignalPersonalBaseline,
  BodySignalSleepSession,
  BodySignalWorkoutSession,
} from './bodySignalStructuredTypes';

function assertFiniteNumber(value: number | undefined, label: string): void {
  if (value !== undefined && !Number.isFinite(value)) {
    throw new RangeError(`${label} must be a finite number`);
  }
}

function assertNonNegative(value: number | undefined, label: string): void {
  assertFiniteNumber(value, label);
  if (value !== undefined && value < 0) {
    throw new RangeError(`${label} must be non-negative`);
  }
}

function assertNonEmpty(value: string, label: string): void {
  if (!value.trim()) throw new RangeError(`${label} must not be empty`);
}

function assertTimeRange(startedAt: number, endedAt: number, label: string): void {
  assertFiniteNumber(startedAt, `${label}.startedAt`);
  assertFiniteNumber(endedAt, `${label}.endedAt`);
  if (endedAt < startedAt) throw new RangeError(`${label} ends before it starts`);
}

export function assertBodySignalActivitySample(sample: BodySignalActivitySample): void {
  assertNonEmpty(sample.id, 'activity.id');
  assertNonEmpty(sample.deviceProfileId, 'activity.deviceProfileId');
  assertNonEmpty(sample.providerSampleKey, 'activity.providerSampleKey');
  assertTimeRange(sample.startedAt, sample.endedAt, 'activity');
  assertNonNegative(sample.steps, 'activity.steps');
  assertNonNegative(sample.distanceMeters, 'activity.distanceMeters');
  assertNonNegative(sample.caloriesKcal, 'activity.caloriesKcal');
  assertNonNegative(sample.intensity, 'activity.intensity');
  assertNonNegative(sample.heartRate, 'activity.heartRate');
}

export function assertBodySignalActivityDailySummary(
  summary: BodySignalActivityDailySummary,
): void {
  assertNonEmpty(summary.id, 'activitySummary.id');
  assertNonEmpty(summary.deviceProfileId, 'activitySummary.deviceProfileId');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(summary.dateKey)) {
    throw new RangeError('activitySummary.dateKey must be YYYY-MM-DD');
  }
  assertNonNegative(summary.steps, 'activitySummary.steps');
  assertNonNegative(summary.distanceMeters, 'activitySummary.distanceMeters');
  assertNonNegative(summary.caloriesKcal, 'activitySummary.caloriesKcal');
  assertNonNegative(summary.activeMinutes, 'activitySummary.activeMinutes');
  assertNonNegative(summary.sedentaryMinutes, 'activitySummary.sedentaryMinutes');
  assertNonNegative(summary.sampleCount, 'activitySummary.sampleCount');
}

export function assertBodySignalSleepSession(session: BodySignalSleepSession): void {
  assertNonEmpty(session.id, 'sleep.id');
  assertNonEmpty(session.deviceProfileId, 'sleep.deviceProfileId');
  assertTimeRange(session.startedAt, session.endedAt, 'sleep');
  assertNonNegative(session.totalMinutes, 'sleep.totalMinutes');
  let previousEnd = session.startedAt;
  session.stages.forEach((stage, index) => {
    if (stage.sessionId !== session.id) {
      throw new RangeError('sleep stage belongs to another session');
    }
    if (stage.sequence !== index) {
      throw new RangeError('sleep stages must have contiguous sequence numbers');
    }
    assertTimeRange(stage.startedAt, stage.endedAt, `sleep.stages[${index}]`);
    if (stage.startedAt < session.startedAt || stage.endedAt > session.endedAt) {
      throw new RangeError('sleep stage is outside its session');
    }
    if (stage.startedAt < previousEnd) {
      throw new RangeError('sleep stages overlap or are out of order');
    }
    previousEnd = stage.endedAt;
  });
}

export function assertBodySignalWorkoutSession(session: BodySignalWorkoutSession): void {
  assertNonEmpty(session.id, 'workout.id');
  assertNonEmpty(session.deviceProfileId, 'workout.deviceProfileId');
  assertNonEmpty(session.type, 'workout.type');
  if (session.endedAt !== undefined) {
    assertTimeRange(session.startedAt, session.endedAt, 'workout');
  }
  if (session.status === 'completed' && session.endedAt === undefined) {
    throw new RangeError('completed workout requires endedAt');
  }
  assertNonNegative(session.steps, 'workout.steps');
  assertNonNegative(session.distanceMeters, 'workout.distanceMeters');
  assertNonNegative(session.caloriesKcal, 'workout.caloriesKcal');
}

export function assertBodySignalPersonalBaseline(
  baseline: BodySignalPersonalBaseline,
): void {
  assertNonEmpty(baseline.id, 'baseline.id');
  assertNonEmpty(baseline.deviceProfileId, 'baseline.deviceProfileId');
  assertTimeRange(baseline.windowStartedAt, baseline.windowEndedAt, 'baseline.window');
  assertNonNegative(baseline.dateCount, 'baseline.dateCount');
  assertNonNegative(baseline.bucketCount, 'baseline.bucketCount');
  assertNonNegative(baseline.sampleCount, 'baseline.sampleCount');
  assertFiniteNumber(baseline.median, 'baseline.median');
  assertNonNegative(baseline.mad, 'baseline.mad');
  assertFiniteNumber(baseline.p10, 'baseline.p10');
  assertFiniteNumber(baseline.p90, 'baseline.p90');
  assertFiniteNumber(baseline.average, 'baseline.average');
  assertFiniteNumber(baseline.minimum, 'baseline.minimum');
  assertFiniteNumber(baseline.maximum, 'baseline.maximum');
  assertNonNegative(baseline.standardDeviation, 'baseline.standardDeviation');
  if (baseline.minimum > baseline.maximum) {
    throw new RangeError('baseline minimum exceeds maximum');
  }
  if (baseline.p10 > baseline.p90) {
    throw new RangeError('baseline p10 exceeds p90');
  }
}

export function assertBodySignalCareEvent(event: BodySignalCareEvent): void {
  assertNonEmpty(event.id, 'careEvent.id');
  assertNonEmpty(event.dedupeKey, 'careEvent.dedupeKey');
  assertFiniteNumber(event.observedAt, 'careEvent.observedAt');
  assertFiniteNumber(event.expiresAt, 'careEvent.expiresAt');
  assertFiniteNumber(event.contextConfidence, 'careEvent.contextConfidence');
  const evidenceIds = new Set<string>();
  event.evidence.forEach((evidence) => {
    assertNonEmpty(evidence.id, 'careEvent.evidence.id');
    if (evidence.eventId !== event.id) {
      throw new RangeError('care event evidence belongs to another event');
    }
    if (evidenceIds.has(evidence.id)) {
      throw new RangeError('care event evidence ids must be unique');
    }
    evidenceIds.add(evidence.id);
    assertFiniteNumber(evidence.measuredAt, 'careEvent.evidence.measuredAt');
    assertFiniteNumber(evidence.value, 'careEvent.evidence.value');
  });
}
