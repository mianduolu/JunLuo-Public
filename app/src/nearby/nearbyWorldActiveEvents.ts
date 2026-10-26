import { nearbyWorldHealthStorageBridge as AsyncStorage } from
  '../sync/syncNearbyWorldHealthStorageBridge';

import { captureBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { runNearbyWorldDataEpochCommit } from './nearbyWorldEpochCoordinator';
import type { NearbyWorldGpsQuality, NearbyWorldPrecisionMode, NearbyWorldStatus } from './nearbyWorldStore';
import { isFreshNearbyStatus } from './nearbyLocationPolicy';
import { normalizeNearbyOutingState, pruneNearbyOutingState, recordNearbyOutingPoint, recordNearbyOutingHomeReport,
  type NearbyOutingState, type NearbyOutingChatSource } from './nearbyOuting';
import type { LocationEvidence } from './nearbyLocationPolicy';

export type NearbyWorldActiveEventKind =
  | 'arrived-home'
  | 'left-home'
  | 'location-unstable'
  | 'transit'
  | 'walking';

export type NearbyWorldActiveEvent = {
  id: string;
  kind: NearbyWorldActiveEventKind;
  at: number;
  placeLabel?: string;
  address?: string;
  nearbyReferences: string[];
  distanceFromHome?: number;
  gpsQuality?: NearbyWorldGpsQuality;
  precisionMode: NearbyWorldPrecisionMode;
  accuracy?: number | null;
};

type NearbyWorldActiveEventState = {
  outing?: NearbyOutingState;
  lastByKind: Partial<Record<NearbyWorldActiveEventKind, number>>;
  queue: NearbyWorldActiveEvent[];
};

const NEARBY_WORLD_ACTIVE_EVENTS_KEY = 'junluo.nearbyWorld.activeEvents.v1';
const MAX_QUEUE_ITEMS = 8;
const SAME_KIND_COOLDOWN_MS = 25 * 60 * 1000;
const LOCATION_UNSTABLE_COOLDOWN_MS = 45 * 60 * 1000;

let activeEventMutationTail: Promise<void> = Promise.resolve();

function normalizeKind(value: unknown): NearbyWorldActiveEventKind | null {
  return value === 'arrived-home' ||
    value === 'left-home' ||
    value === 'location-unstable' ||
    value === 'transit' ||
    value === 'walking'
    ? value
    : null;
}

function normalizePrecisionMode(value: unknown): NearbyWorldPrecisionMode {
  return value === 'walking' || value === 'transit' || value === 'off' ? value : 'off';
}

function normalizeGpsQuality(value: unknown): NearbyWorldGpsQuality | undefined {
  return value === 'excellent' || value === 'good' || value === 'fair' || value === 'poor' ? value : undefined;
}

function compact(value: unknown, limit = 120) {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function normalizeEvent(value: unknown): NearbyWorldActiveEvent | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<NearbyWorldActiveEvent>;
  const kind = normalizeKind(item.kind);
  const at = typeof item.at === 'number' && Number.isFinite(item.at) ? item.at : 0;
  if (!kind || !at) return null;
  return {
    id: compact(item.id, 80) || `nearby-${kind}-${at}`,
    kind,
    at,
    placeLabel: compact(item.placeLabel, 80) || undefined,
    address: compact(item.address, 160) || undefined,
    nearbyReferences: Array.isArray(item.nearbyReferences)
      ? item.nearbyReferences.map((entry) => compact(entry, 80)).filter(Boolean).slice(0, 4)
      : [],
    distanceFromHome: typeof item.distanceFromHome === 'number' && Number.isFinite(item.distanceFromHome)
      ? item.distanceFromHome
      : undefined,
    gpsQuality: normalizeGpsQuality(item.gpsQuality),
    precisionMode: normalizePrecisionMode(item.precisionMode),
    accuracy: typeof item.accuracy === 'number' && Number.isFinite(item.accuracy) ? item.accuracy : null,
  };
}

function normalizeState(value: unknown): NearbyWorldActiveEventState {
  if (!value || typeof value !== 'object') return { lastByKind: {}, queue: [] };
  const item = value as Partial<NearbyWorldActiveEventState>;
  const lastByKind: Partial<Record<NearbyWorldActiveEventKind, number>> = {};
  const rawLastByKind = item.lastByKind && typeof item.lastByKind === 'object'
    ? item.lastByKind as Partial<Record<NearbyWorldActiveEventKind, unknown>>
    : {};
  (['arrived-home', 'left-home', 'location-unstable', 'transit', 'walking'] as NearbyWorldActiveEventKind[]).forEach((kind) => {
    const value = rawLastByKind[kind];
    if (typeof value === 'number' && Number.isFinite(value)) lastByKind[kind] = value;
  });
  const queue = Array.isArray(item.queue)
    ? item.queue.map(normalizeEvent).filter((event): event is NearbyWorldActiveEvent => !!event).slice(-MAX_QUEUE_ITEMS)
    : [];
  return { lastByKind, queue, ...(item.outing !== undefined ? { outing: normalizeNearbyOutingState(item.outing) } : {}) };
}

async function loadState(): Promise<NearbyWorldActiveEventState> {
  const raw = await AsyncStorage.getItem(NEARBY_WORLD_ACTIVE_EVENTS_KEY);
  if (!raw) return { lastByKind: {}, queue: [] };
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid-nearby-world-events');
  return normalizeState(parsed);
}

async function saveState(state: NearbyWorldActiveEventState) {
  await AsyncStorage.setItem(NEARBY_WORLD_ACTIVE_EVENTS_KEY, JSON.stringify({
    ...(state.outing !== undefined ? { outing: state.outing } : {}),
    lastByKind: state.lastByKind,
    queue: state.queue.slice(-MAX_QUEUE_ITEMS),
  }));
}

function enqueueActiveEventMutation<T>(
  dataEpoch: number | null,
  mutation: (state: NearbyWorldActiveEventState) => Promise<T>,
) {
  const run = () => runNearbyWorldDataEpochCommit(dataEpoch, async () => mutation(await loadState()));
  const result = activeEventMutationTail.then(run, run);
  activeEventMutationTail = result.then(() => undefined, () => undefined);
  return result;
}

function buildNearbyReferences(status: NearbyWorldStatus) {
  return [
    status.nearbyAoi ? `附近区域：${status.nearbyAoi}` : '',
    status.nearbyPoi ? `附近参照点：${status.nearbyPoi}` : '',
    status.nearbyRoad ? `附近道路：${status.nearbyRoad}` : '',
  ].filter(Boolean);
}

export function createNearbyWorldActiveEvent(
  kind: NearbyWorldActiveEventKind,
  status: NearbyWorldStatus,
  now = Date.now(),
): NearbyWorldActiveEvent {
  const hasCurrentAddress = status.addressCenter?.latitude === status.latitude
    && status.addressCenter?.longitude === status.longitude && !!status.addressUpdatedAt
    && status.addressUpdatedAt >= (status.updatedAt ?? Number.POSITIVE_INFINITY);
  return {
    id: `nearby-world:${kind}:${now}`,
    kind,
    at: now,
    placeLabel: hasCurrentAddress ? status.placeLabel || [status.city, status.district].filter(Boolean).join(' · ') || undefined : undefined,
    address: hasCurrentAddress ? status.address : undefined,
    nearbyReferences: hasCurrentAddress ? buildNearbyReferences(status) : [],
    distanceFromHome: status.distanceFromHome,
    gpsQuality: status.gpsQuality,
    precisionMode: status.precisionMode,
    accuracy: status.accuracy,
  };
}

export async function enqueueNearbyWorldActiveEvent(
  event: NearbyWorldActiveEvent,
  dataEpoch: number | null = captureBackupRestoreDataEpoch(),
): Promise<boolean> {
  const normalized = normalizeEvent(event);
  if (!normalized) return false;
  const committed = await enqueueActiveEventMutation(dataEpoch, async (state) => {
    const cooldown = normalized.kind === 'location-unstable' ? LOCATION_UNSTABLE_COOLDOWN_MS : SAME_KIND_COOLDOWN_MS;
    const lastAt = state.lastByKind[normalized.kind] ?? 0;
    const queuedSameKind = state.queue.some((item) => item.kind === normalized.kind);
    if (queuedSameKind || normalized.at - lastAt < cooldown) return false;
    await saveState({
      ...state,
      lastByKind: { ...state.lastByKind, [normalized.kind]: normalized.at },
      queue: [...state.queue, normalized].slice(-MAX_QUEUE_ITEMS),
    });
    return true;
  });
  return committed.committed ? committed.value : false;
}

export async function loadPendingNearbyWorldActiveEvents(): Promise<NearbyWorldActiveEvent[]> {
  return (await loadState()).queue;
}

/** Read-only: history is independent from the proactive queue and unavailable reads throw. */
export async function loadNearbyOutingSegments(now = Date.now()) {
  return pruneNearbyOutingState((await loadState()).outing ?? { segments: [], samples: [] }, now).segments;
}

/** Caller owns the existing nearby data-epoch commit; never nest that lock. */
export async function recordNearbyOutingPointWithinCommit(point: LocationEvidence,
  options: Parameters<typeof recordNearbyOutingPoint>[2]) {
  const state = await loadState();
  const outing = recordNearbyOutingPoint(state.outing ?? { segments: [], samples: [] }, point, options);
  if (outing !== state.outing) await saveState({ ...state, outing });
}

/** Caller verified the saved message inside the existing nearby data-epoch commit. */
export async function recordNearbyOutingHomeReportWithinCommit(source: NearbyOutingChatSource, now = Date.now()) {
  const state = await loadState();
  if (!state.outing) return;
  await saveState({ ...state, outing: recordNearbyOutingHomeReport(state.outing, source, now) });
}

/** A successfully delivered opportunity considered this background; not a share receipt. */
export async function consumeNearbyWorldActiveEvent(
  event: NearbyWorldActiveEvent,
  dataEpoch: number | null = captureBackupRestoreDataEpoch(),
): Promise<boolean> {
  const normalized = normalizeEvent(event);
  if (!normalized) return false;
  const committed = await enqueueActiveEventMutation(dataEpoch, async (state) => {
    const current = state.queue.find(item => item.id === normalized.id);
    if (!current || JSON.stringify(current) !== JSON.stringify(normalized)) return false;
    await saveState({ ...state, queue: state.queue.filter(item => item.id !== normalized.id) });
    return true;
  });
  return committed.committed ? committed.value : false;
}

export function selectNearbyWorldActiveEventKind(
  previous: NearbyWorldStatus,
  next: NearbyWorldStatus,
): NearbyWorldActiveEventKind | null {
  if (previous.precisionMode !== 'transit' && next.precisionMode === 'transit') return 'transit';
  if (previous.precisionMode === 'off' && next.precisionMode === 'walking') return 'walking';
  if (isFreshNearbyStatus(next)) {
    if (previous.nearHome === false && next.nearHome === true) return 'arrived-home';
    if (previous.nearHome === true && next.presence === 'outside') return 'left-home';
  }
  const becameUnstable = (next.gpsQuality === 'fair' || next.gpsQuality === 'poor') &&
    previous.gpsQuality !== next.gpsQuality &&
    next.precisionMode !== 'off';
  return becameUnstable ? 'location-unstable' : null;
}
