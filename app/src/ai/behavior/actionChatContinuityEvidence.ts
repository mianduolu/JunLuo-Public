import type { BaiyunActionIntentId } from './actionIntent';
import type {
  BaiyunContinuityEvent,
  BaiyunContinuityEventKind,
} from './continuityEvent';
import type { BaiyunContinuityResolutionState } from './continuityLedger';
import type { BaiyunSituationMessage } from './actionSituation';

// Historical answer decoding only. Current answers use chatCareUpdates and cannot write through this module.
export type BaiyunContinuityResolutionPromptItem = {
  eventId: string;
  kind: BaiyunContinuityEventKind;
  stage: BaiyunContinuityEvent['stage'];
  primaryIntent?: BaiyunActionIntentId;
  occurredAt: number;
  sourceSubject: 'I' | 'you';
  sourceExcerpt: string;
};

export type BaiyunFixedContinuityPromptItem = {
  eventId: string;
  kind: BaiyunContinuityEventKind;
  time: string;
  sourceSubject: 'I' | 'you';
  sourceExcerpt: string;
};

export type BaiyunFixedContinuityEventUpdateState = 'followed_up' | 'cancelled';

export type BaiyunFixedContinuityEventUpdate = {
  eventId: string;
  state: BaiyunFixedContinuityEventUpdateState;
};

export type BaiyunFixedContinuityEventUpdateRejectionCode =
  | 'invalid_shape'
  | 'invalid_fields'
  | 'invalid_state'
  | 'unknown_event'
  | 'duplicate_event'
  | 'overflow';

export type BaiyunFixedContinuityEventUpdateDiagnostic = {
  pendingCount: number;
  returnedCount: number;
  acceptedCount: number;
  discardedCount: number;
  duplicateCount: number;
  overflowCount: number;
  rejectionCodes: BaiyunFixedContinuityEventUpdateRejectionCode[];
};

export type BaiyunFixedContinuityEventUpdateParseResult =
  | {
      status: 'valid' | 'partial';
      updates: BaiyunFixedContinuityEventUpdate[];
      diagnostic: BaiyunFixedContinuityEventUpdateDiagnostic;
    }
  | {
      status: 'unresolved';
      reason: 'event_updates_not_array' | 'no_valid_event_updates';
      updates: [];
      diagnostic: BaiyunFixedContinuityEventUpdateDiagnostic;
    };

export type BaiyunAppliedFixedContinuityEventUpdate = {
  eventId: string;
  state: Extract<BaiyunContinuityEvent['status'], 'completed' | 'cancelled'>;
};

export type BaiyunValidatedContinuityResolution = {
  eventId: string;
  state: BaiyunContinuityResolutionState;
  confidence: number;
  evidence: string;
};

export type BaiyunContinuityResolutionRejectionCode =
  | 'model_omitted'
  | 'invalid_shape'
  | 'unknown_event'
  | 'duplicate_event'
  | 'invalid_confidence'
  | 'invalid_evidence';

export type BaiyunContinuityResolutionDiagnostic = {
  pendingCount: number;
  returnedCount: number;
  acceptedCount: number;
  rejectionCodes: BaiyunContinuityResolutionRejectionCode[];
};

export type ParsedBaiyunContinuityResolutions = {
  resolutions: BaiyunValidatedContinuityResolution[];
  diagnostic: BaiyunContinuityResolutionDiagnostic;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => key in value);
}



export function parseBaiyunFixedContinuityEventUpdates(input: {
  value: unknown;
  openContinuityEvents: readonly BaiyunFixedContinuityPromptItem[];
}): BaiyunFixedContinuityEventUpdateParseResult {
  const rejectionCodes = new Set<BaiyunFixedContinuityEventUpdateRejectionCode>();
  const returnedCount = Array.isArray(input.value) ? input.value.length : 0;
  let duplicateCount = 0;
  let overflowCount = 0;
  const diagnostic = (acceptedCount: number): BaiyunFixedContinuityEventUpdateDiagnostic => ({
    pendingCount: input.openContinuityEvents.length,
    returnedCount,
    acceptedCount,
    discardedCount: returnedCount - acceptedCount,
    duplicateCount,
    overflowCount,
    rejectionCodes: [...rejectionCodes],
  });
  if (!Array.isArray(input.value)) {
    return {
      status: 'unresolved',
      reason: 'event_updates_not_array',
      updates: [],
      diagnostic: diagnostic(0),
    };
  }

  const allowedIds = new Set(input.openContinuityEvents.map((event) => event.eventId));
  const seen = new Set<string>();
  const updates: BaiyunFixedContinuityEventUpdate[] = [];
  for (const item of input.value) {
    if (!isPlainObject(item)) {
      rejectionCodes.add('invalid_shape');
      continue;
    }
    if (!hasExactKeys(item, ['eventId', 'state'])) {
      rejectionCodes.add('invalid_fields');
      continue;
    }
    if (typeof item.eventId !== 'string') {
      rejectionCodes.add('invalid_shape');
      continue;
    }
    if (item.state !== 'followed_up' && item.state !== 'cancelled') {
      rejectionCodes.add('invalid_state');
      continue;
    }
    if (!allowedIds.has(item.eventId)) {
      rejectionCodes.add('unknown_event');
      continue;
    }
    if (seen.has(item.eventId)) {
      duplicateCount += 1;
      rejectionCodes.add('duplicate_event');
      continue;
    }
    seen.add(item.eventId);
    if (updates.length >= 3) {
      overflowCount += 1;
      rejectionCodes.add('overflow');
      continue;
    }
    updates.push({ eventId: item.eventId, state: item.state });
  }

  if (input.value.length > 0 && updates.length === 0) {
    return {
      status: 'unresolved',
      reason: 'no_valid_event_updates',
      updates: [],
      diagnostic: diagnostic(0),
    };
  }
  return {
    status: updates.length === input.value.length ? 'valid' : 'partial',
    updates,
    diagnostic: diagnostic(updates.length),
  };
}


export function parseBaiyunContinuityResolutions(input: {
  value: unknown;
  currentMessage: BaiyunSituationMessage;
  openContinuityEvents: readonly BaiyunContinuityResolutionPromptItem[];
}): ParsedBaiyunContinuityResolutions {
  const rejectionCodes = new Set<BaiyunContinuityResolutionRejectionCode>();
  const returnedCount = Array.isArray(input.value) ? input.value.length : 0;
  const result = (
    resolutions: BaiyunValidatedContinuityResolution[],
  ): ParsedBaiyunContinuityResolutions => ({
    resolutions,
    diagnostic: {
      pendingCount: input.openContinuityEvents.length,
      returnedCount,
      acceptedCount: resolutions.length,
      rejectionCodes: [...rejectionCodes],
    },
  });
  if (!Array.isArray(input.value)) {
    if (input.openContinuityEvents.length) {
      rejectionCodes.add(input.value == null ? 'model_omitted' : 'invalid_shape');
    }
    return result([]);
  }
  if (input.value.length > 4) {
    rejectionCodes.add('invalid_shape');
    return result([]);
  }
  const allowedIds = new Set(input.openContinuityEvents.map((event) => event.eventId));
  const seen = new Set<string>();
  const resolutions: BaiyunValidatedContinuityResolution[] = [];
  for (const item of input.value) {
    if (
      !isPlainObject(item)
      || !hasExactKeys(item, ['eventId', 'state', 'confidence', 'evidence'])
      || typeof item.eventId !== 'string'
      || (
        item.state !== 'progressed'
        && item.state !== 'completed'
        && item.state !== 'cancelled'
      )
      || typeof item.confidence !== 'number'
      || !Number.isFinite(item.confidence)
      || typeof item.evidence !== 'string'
    ) {
      rejectionCodes.add('invalid_shape');
      continue;
    }
    if (!allowedIds.has(item.eventId)) {
      rejectionCodes.add('unknown_event');
      continue;
    }
    if (seen.has(item.eventId)) {
      rejectionCodes.add('duplicate_event');
      continue;
    }
    if (item.confidence < 0 || item.confidence > 1) {
      rejectionCodes.add('invalid_confidence');
      continue;
    }
    if (
      !item.evidence
      || Array.from(item.evidence).length > 60
      || !input.currentMessage.text.includes(item.evidence)
    ) {
      rejectionCodes.add('invalid_evidence');
      continue;
    }
    seen.add(item.eventId);
    resolutions.push({
      eventId: item.eventId,
      state: item.state,
      confidence: item.confidence,
      evidence: item.evidence,
    });
  }
  return result(resolutions);
}
