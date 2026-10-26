import type { JunLuoToolInvocation } from './toolCallProtocol';
import type { JunLuoToolResult } from './toolTypes';
import type {
  WeatherMapNearbyAgentToolId,
  WeatherMapNearbyIntentEvidence,
} from './weatherMapNearbyAgentEvidence';

export type WeatherMapNearbyInvocationInputDecision =
  | {
      kind: 'ready';
      input: Record<string, unknown>;
    }
  | {
      kind: 'rejected';
      reason:
        | 'tool_out_of_scope'
        | 'location_scope_mismatch'
        | 'explicit_location_conflict';
    };

export function createWeatherMapNearbySingleInvocationGuard() {
  const acceptedToolIds = new Set<WeatherMapNearbyAgentToolId>();
  return (toolId: WeatherMapNearbyAgentToolId) => {
    if (acceptedToolIds.has(toolId)) return false;
    acceptedToolIds.add(toolId);
    return true;
  };
}

const LOCATION_INPUT_KEYS = [
  'place',
  'destination',
  'latitude',
  'longitude',
] as const;

export function constrainWeatherMapNearbyInvocationInput(
  evidence: WeatherMapNearbyIntentEvidence,
  invocation: Pick<JunLuoToolInvocation, 'toolId' | 'input'>,
): WeatherMapNearbyInvocationInputDecision {
  if (invocation.toolId !== evidence.primaryToolId) {
    return { kind: 'rejected', reason: 'tool_out_of_scope' };
  }

  if (evidence.locationScope === 'current' || evidence.locationScope === 'nearby_world') {
    if (LOCATION_INPUT_KEYS.some((key) => invocation.input[key] !== undefined)) {
      return { kind: 'rejected', reason: 'location_scope_mismatch' };
    }
  }

  if (
    (evidence.locationScope === 'explicit_place'
      || evidence.locationScope === 'explicit_coordinates')
    && hasExplicitLocationConflict(evidence.deterministicInput, invocation.input)
  ) {
    return { kind: 'rejected', reason: 'explicit_location_conflict' };
  }

  return {
    kind: 'ready',
    input: {
      ...invocation.input,
      ...evidence.deterministicInput,
    },
  };
}

export function mayRequestSystemLocation(
  evidence: WeatherMapNearbyIntentEvidence | undefined,
  toolId: WeatherMapNearbyAgentToolId,
) {
  return evidence?.strength === 'strong'
    && evidence.primaryToolId === toolId
    && evidence.requiresCurrentLocation
    && (evidence.locationScope === 'current' || evidence.locationScope === 'nearby_world');
}

export function createWeatherMapNearbyInputRequiredResult(
  invocation: Pick<JunLuoToolInvocation, 'callId' | 'toolId'>,
): JunLuoToolResult {
  const now = Date.now();
  return {
    callId: invocation.callId,
    toolId: invocation.toolId,
    ok: false,
    status: 'error',
    summary: '',
    error: {
      code: 'TOOL_INPUT_REQUIRED',
      message: 'TOOL_INPUT_REQUIRED',
    },
    startedAt: now,
    finishedAt: now,
  };
}

function hasExplicitLocationConflict(
  deterministicInput: Record<string, unknown>,
  modelInput: Record<string, unknown>,
) {
  return LOCATION_INPUT_KEYS.some((key) => {
    const expected = deterministicInput[key];
    const actual = modelInput[key];
    if (expected === undefined || actual === undefined) return false;
    if (typeof expected === 'number' && typeof actual === 'number') return expected !== actual;
    return String(expected).trim() !== String(actual).trim();
  });
}
