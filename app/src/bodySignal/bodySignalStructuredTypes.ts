import type {
  BodySignalConfidence,
  BodySignalKind,
  BodySignalProvider,
} from './bodySignalTypes';

export type BodySignalActivitySample = {
  caloriesKcal?: number;
  createdAt: number;
  deviceProfileId: string;
  distanceMeters?: number;
  endedAt: number;
  heartRate?: number;
  id: string;
  intensity?: number;
  providerSampleKey: string;
  sourceProvider: BodySignalProvider;
  startedAt: number;
  steps?: number;
  updatedAt: number;
};

export type BodySignalActivityDailySummary = {
  summaryVersion?: number;
  dayStartedAt?: number;
  dayEndedAt?: number;
  timezoneId?: string;
  firstSampleAt?: number;
  lastSampleAt?: number;
  sealedThroughAt?: number;
  coverageUncertain?: boolean;
  activeMinutes: number;
  caloriesKcal?: number;
  dateKey: string;
  deviceProfileId: string;
  distanceMeters?: number;
  id: string;
  sampleCount: number;
  sedentaryMinutes: number;
  sourceProvider: BodySignalProvider;
  steps: number;
  updatedAt: number;
};

export type BodySignalSleepStageType =
  | 'awake'
  | 'deep'
  | 'light'
  | 'rem'
  | 'unknown';

export type BodySignalSleepStage = {
  endedAt: number;
  id: string;
  sequence: number;
  sessionId: string;
  stage: BodySignalSleepStageType;
  startedAt: number;
};

export type BodySignalSleepSession = {
  wakeDateKey?: string;
  algorithmVersion?: string;
  contextEligible?: boolean;
  confidence: BodySignalConfidence;
  createdAt: number;
  deviceProfileId: string;
  endedAt: number;
  id: string;
  sourceProvider: BodySignalProvider;
  stages: BodySignalSleepStage[];
  startedAt: number;
  totalMinutes: number;
  updatedAt: number;
};

export type BodySignalWorkoutStatus = 'active' | 'completed' | 'discarded';

export type BodySignalWorkoutSession = {
  caloriesKcal?: number;
  createdAt: number;
  deviceProfileId: string;
  distanceMeters?: number;
  endedAt?: number;
  id: string;
  sourceProvider: BodySignalProvider;
  startedAt: number;
  status: BodySignalWorkoutStatus;
  steps?: number;
  type: string;
  updatedAt: number;
};

export type BodySignalContextBucket =
  | 'active'
  | 'navigation'
  | 'resting'
  | 'sleeping'
  | 'unknown';

export type BodySignalActivityType =
  | 'in_vehicle'
  | 'on_bicycle'
  | 'running'
  | 'still'
  | 'unknown'
  | 'walking';

export type BodySignalActivityTransition = 'enter' | 'exit';

export type BodySignalContextObservation = {
  activity: BodySignalActivityType;
  bootSessionId?: string;
  confidence: number;
  context: BodySignalContextBucket;
  createdAt: number;
  endedAt?: number;
  expiresAt: number;
  id: string;
  source: 'activity_transition' | 'navigation_app' | 'sleep' | 'workout';
  startedAt: number;
  transition?: BodySignalActivityTransition;
};

export type BodySignalDiscomfortCategory =
  | 'breathing_discomfort'
  | 'chest_discomfort'
  | 'dizziness_or_fainting'
  | 'fever'
  | 'general_unwell'
  | 'heart_palpitations'
  | 'significant_pain';

export type BodySignalDiscomfortReport = {
  category: BodySignalDiscomfortCategory;
  confidence: number;
  createdAt: number;
  expiresAt: number;
  id: string;
  observedAt: number;
  sourceMessageId: string;
};

export type BodySignalBaselineReadiness = 'learning' | 'mature';

export type BodySignalPersonalBaseline = {
  average: number;
  algorithmVersion: number;
  bucketCount: number;
  context: BodySignalContextBucket;
  dateCount: number;
  deviceProfileId: string;
  id: string;
  kind: BodySignalKind;
  mad: number;
  maximum: number;
  median: number;
  minimum: number;
  p10: number;
  p90: number;
  readiness: BodySignalBaselineReadiness;
  sampleCount: number;
  standardDeviation?: number;
  updatedAt: number;
  windowEndedAt: number;
  windowStartedAt: number;
};

export type BodySignalCareEventSeverity = 'concern' | 'observe' | 'support';
export type BodySignalCareEventStatus = 'dismissed' | 'handled' | 'pending';
export type BodySignalCareDirection = 'high' | 'low';
export type BodySignalCareReason =
  | 'context_explained'
  | 'immature_resting_extreme'
  | 'immature_sleeping_extreme'
  | 'immature_unknown_with_discomfort'
  | 'mature_clear_deviation'
  | 'mature_clear_deviation_with_discomfort'
  | 'mature_repeated_deviation';

export type BodySignalCareEventEvidence = {
  confidence: BodySignalConfidence;
  eventId: string;
  id: string;
  kind: BodySignalKind;
  measuredAt: number;
  readingId?: string;
  sourceDeviceName?: string;
  sourceProvider: BodySignalProvider;
  unit: string;
  value: number;
};

export type BodySignalCareEvent = {
  baselineId?: string;
  context: BodySignalContextBucket;
  contextConfidence: number;
  createdAt: number;
  dedupeKey: string;
  direction: BodySignalCareDirection;
  dismissedAt?: number;
  evidence: BodySignalCareEventEvidence[];
  handledAt?: number;
  id: string;
  kind: BodySignalKind;
  observedAt: number;
  expiresAt: number;
  reason: BodySignalCareReason;
  severity: BodySignalCareEventSeverity;
  status: BodySignalCareEventStatus;
  updatedAt: number;
};

export type BodySignalSyncCursor = {
  cursor?: string;
  deviceProfileId: string;
  sourceProvider: BodySignalProvider;
  stream: string;
  syncedThroughAt?: number;
  updatedAt: number;
};
