import { FRESH_LOCATION_MS, isFreshLocation, locationDistance, type LocationEvidence } from './nearbyLocationPolicy';

export type NearbyOutingChatSource = {
  sessionId: string; messageId: string; createdAt: number; revision: string; quote: string;
};
export type NearbyOutingSegment = {
  id: string; outingId: string; firstRecordedAt: number; occurredAt: number;
  kind: 'movement' | 'home-location' | 'home-report'; evidenceVersion: string;
  nearbyReference?: string; chatSource?: NearbyOutingChatSource;
};
type OutingPoint = LocationEvidence & { accuracy: number };
export type NearbyOutingState = {
  segments: NearbyOutingSegment[];
  samples: OutingPoint[];
  lastProcessedAt?: number;
  current?: { id: string; firstRecordedAt: number; lastMovementAt: number; lastOutsideAt?: number; homeSince?: number;
    homeCenter?: { latitude: number; longitude: number } };
};
export const NEARBY_OUTING_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const NEARBY_OUTING_LIMIT = 1024;
const WINDOW_MS = 10 * 60_000;
const MOVEMENT_INTERVAL_MS = 15 * 60_000;
const HOME_RADIUS = 220;

// Same source fingerprint as InnerMaterialRef; keep this domain free of storage/runtime imports.
export function nearbyOutingEvidenceKey(value: unknown) {
  const text = JSON.stringify(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function positive(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value > 0; }
function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }

/** A malformed saved source is unavailable, never an empty history. */
export function normalizeNearbyOutingState(value: unknown): NearbyOutingState {
  if (value === undefined) return { segments: [], samples: [] };
  if (!value || typeof value !== 'object') throw new Error('invalid-nearby-outing');
  const state = value as NearbyOutingState;
  if (!Array.isArray(state.segments) || !Array.isArray(state.samples)) throw new Error('invalid-nearby-outing');
  for (const segment of state.segments) {
    if (!segment || !text(segment.id) || !text(segment.outingId) || !positive(segment.firstRecordedAt)
      || !positive(segment.occurredAt) || segment.occurredAt < segment.firstRecordedAt || !text(segment.evidenceVersion)
      || !['movement', 'home-location', 'home-report'].includes(segment.kind)
      || (segment.nearbyReference !== undefined && !text(segment.nearbyReference))) throw new Error('invalid-nearby-outing-segment');
    const source = segment.chatSource;
    if (segment.kind === 'home-report' ? !source : source !== undefined) {
      throw new Error('invalid-nearby-outing-chat-source');
    }
    if (source && (!text(source.sessionId) || !text(source.messageId) || !positive(source.createdAt)
      || source.createdAt !== segment.occurredAt || !text(source.revision) || !text(source.quote))) {
      throw new Error('invalid-nearby-outing-chat-source');
    }
  }
  if (new Set(state.segments.map(segment => segment.id)).size !== state.segments.length) throw new Error('duplicate-nearby-outing-segment');
  if (state.samples.some(point => !isFreshLocation(point, point.timestamp, 50))) throw new Error('invalid-nearby-outing-sample');
  const current = state.current;
  if (current && (!text(current.id) || !positive(current.firstRecordedAt) || !positive(current.lastMovementAt)
    || (current.lastOutsideAt !== undefined && !positive(current.lastOutsideAt))
    || (current.homeSince !== undefined && !positive(current.homeSince)))) throw new Error('invalid-nearby-outing-current');
  if (state.lastProcessedAt !== undefined && !positive(state.lastProcessedAt)) throw new Error('invalid-nearby-outing-cursor');
  return state;
}

export function pruneNearbyOutingState(state: NearbyOutingState, now: number): NearbyOutingState {
  const segments = state.segments.filter(segment => segment.occurredAt >= now - NEARBY_OUTING_RETENTION_MS
    && segment.occurredAt <= now).slice(-NEARBY_OUTING_LIMIT);
  // A retained middle fragment must not reconstruct a lost trip's origin.
  const current = state.current && segments.some(segment => segment.outingId === state.current!.id
    && segment.occurredAt === state.current!.firstRecordedAt) ? state.current : undefined;
  return { ...state, segments, current, samples: state.samples.filter(point => now - point.timestamp <= WINDOW_MS) };
}

function append(state: NearbyOutingState, kind: NearbyOutingSegment['kind'], at: number,
  evidence: unknown, nearbyReference?: string, chatSource?: NearbyOutingChatSource): NearbyOutingState {
  const current = state.current!;
  const segment: NearbyOutingSegment = {
    id: `${current.id}:${kind}:${at}`, outingId: current.id, firstRecordedAt: current.firstRecordedAt,
    occurredAt: at, kind, evidenceVersion: nearbyOutingEvidenceKey([kind, at, evidence, nearbyReference ?? null, chatSource ?? null]),
    ...(nearbyReference ? { nearbyReference } : {}), ...(chatSource ? { chatSource } : {}),
  };
  return { ...state, segments: [...state.segments, segment].slice(-NEARBY_OUTING_LIMIT) };
}

/** Called only for a fix accepted by the existing location collector. No location/map IO. */
export function recordNearbyOutingPoint(state: NearbyOutingState, input: LocationEvidence, options: {
  now: number; home?: { latitude: number; longitude: number }; nearbyReference?: string;
  homeReportAt?: number;
}): NearbyOutingState {
  const { now, home } = options;
  if (!isFreshLocation(input, now, 50) || input.timestamp <= (state.lastProcessedAt ?? 0)) return state;
  const point = input as OutingPoint;
  const retained = pruneNearbyOutingState(state, now);
  const previous = retained.samples.at(-1);
  const continuous = !!previous && point.timestamp - previous.timestamp <= FRESH_LOCATION_MS;
  // Keep the production unreasonable-jump bound, including both accuracy margins.
  if (previous && continuous && (locationDistance(previous, point) - previous.accuracy - point.accuracy)
    / ((point.timestamp - previous.timestamp) / 1000) > 120) return state;
  const samples = [...(continuous ? retained.samples.filter(sample => point.timestamp - sample.timestamp <= WINDOW_MS) : []), point].slice(-128);
  const away = !!home && locationDistance(home, point) - point.accuracy > HOME_RADIUS;
  const atHome = !!home && locationDistance(home, point) + point.accuracy <= HOME_RADIUS;
  const sameHome = retained.current?.homeCenter?.latitude === home?.latitude
    && retained.current?.homeCenter?.longitude === home?.longitude;
  let next: NearbyOutingState = { ...retained, samples, lastProcessedAt: point.timestamp,
    current: retained.current ? { ...retained.current,
      lastOutsideAt: away ? point.timestamp : retained.current.lastOutsideAt,
      homeSince: atHome ? (continuous && sameHome ? retained.current.homeSince : undefined) ?? point.timestamp : undefined,
      homeCenter: atHome ? home : undefined,
    } : undefined };
  if (next.current?.homeSince && point.timestamp - next.current.homeSince >= WINDOW_MS) {
    next = append(next, 'home-location', point.timestamp, [home, next.current.homeSince, point], options.nearbyReference);
    return { ...next, current: undefined, samples: [] };
  }
  const movementStart = samples.find(sample => sample.timestamp < point.timestamp
    && sample.timestamp >= (next.current?.lastMovementAt ?? 0)
    && locationDistance(sample, point) - sample.accuracy - point.accuracy >= 50);
  if (!movementStart || atHome) return next;
  if (next.current && !home) next.current = { ...next.current, lastOutsideAt: point.timestamp };
  if (next.current && point.timestamp - next.current.lastMovementAt < MOVEMENT_INTERVAL_MS) return next;
  if (!next.current) {
    if (home && !away) return next;
    if (options.homeReportAt && (!away || point.timestamp <= options.homeReportAt)) return next;
    next.current = { id: `nearby-outing:${point.timestamp}:${nearbyOutingEvidenceKey([movementStart, point])}`,
      firstRecordedAt: point.timestamp, lastMovementAt: point.timestamp,
      ...(away ? { lastOutsideAt: point.timestamp } : {}) };
  } else next.current = { ...next.current, lastMovementAt: point.timestamp };
  return append(next, 'movement', point.timestamp, [movementStart, point], options.nearbyReference);
}

/** The caller has checked the original saved you message and its existing presence decision. */
export function recordNearbyOutingHomeReport(state: NearbyOutingState, source: NearbyOutingChatSource, now: number): NearbyOutingState {
  const next = pruneNearbyOutingState(state, now);
  if (!next.current || source.createdAt > now || source.createdAt < next.current.firstRecordedAt
    || source.createdAt < Math.max(next.current.lastOutsideAt ?? 0, next.current.lastMovementAt)) return next;
  return { ...append(next, 'home-report', source.createdAt, source, undefined, source), current: undefined, samples: [] };
}
