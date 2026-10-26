import type { AmapGeocodeCandidate, AmapSearchCandidate } from '../nearby/amapNearbyProvider';
import { createToolError } from './toolErrors';
import { createToolErrorResult, createToolSuccessResult } from './toolResult';
import type { JunLuoToolCall, JunLuoToolResult } from './toolTypes';

export type MapSearchSpec = {
  kind: 'nearby' | 'destination';
  query: string;
  radiusKm: 3 | 5 | 10;
  destination?: string;
  city?: string;
  evidence?: { from: number; quote: string };
};
export type MapSearchHostContext = {
  conversationId: string;
  requestId: string;
  dataEpoch: number | null;
  sourceMessageIds: string[];
  isSourceCurrent: () => Promise<boolean>;
  authorize: (search: MapSearchSpec, continuation?: boolean) => Promise<{ allowed: boolean; explicitRetry?: boolean }>;
};
export type MapSearchCenter = {
  latitude: number;
  longitude: number;
  coordinateSystem: 'wgs84' | 'gcj02';
  accuracy?: number;
  timestamp?: number;
  source?: 'current' | 'explicit';
};
type SearchResolution = {
  center?: MapSearchCenter;
  destination?: AmapGeocodeCandidate;
  destinationCandidates?: AmapGeocodeCandidate[];
};
type SearchPage = { candidates: AmapSearchCandidate[]; hasMore: boolean };
type SearchSession = {
  host: MapSearchHostContext;
  spec: MapSearchSpec;
  lastUsedAt: number;
  center?: MapSearchCenter;
  destination?: AmapGeocodeCandidate;
  destinationCandidates?: AmapGeocodeCandidate[];
  destinationCandidateReceipt?: { callId: string; delivered: boolean };
  loadPage: (center: MapSearchCenter, page: number, host: MapSearchHostContext) => Promise<SearchPage>;
  page: number;
  hasMore: boolean;
  candidates: AmapSearchCandidate[];
  seen: Set<string>;
  offset: number;
  pending?: { end: number; callIds: Set<string> };
  results: Map<string, JunLuoToolResult>;
  onError?: (call: JunLuoToolCall, error: unknown) => JunLuoToolResult;
  inFlight?: Promise<JunLuoToolResult>;
  failed?: boolean;
  geocodeEmpty?: boolean;
};

const sessions = new Map<string, SearchSession>();
const SEARCH_IDLE_MS = 30 * 60 * 1000;

export function resetMapSearchSessions() { sessions.clear(); }

export function getMapSearchSessionReference(conversationId: string) {
  const session = sessions.get(conversationId);
  if (!session || Date.now() - session.lastUsedAt >= SEARCH_IDLE_MS) return undefined;
  return {
    spec: { ...session.spec }, requestId: session.host.requestId,
    sourceMessageIds: [...session.host.sourceMessageIds], dataEpoch: session.host.dataEpoch,
    isSourceCurrent: session.host.isSourceCurrent,
    destinationChoices: session.destinationCandidateReceipt?.delivered
      ? session.destinationCandidates?.map(candidate => [destinationReference(candidate), candidate.address, candidate.placeLabel].filter(Boolean)) : undefined,
  };
}

async function isCurrent(session: SearchSession, host = session.host) {
  const valid = sessions.get(host.conversationId) === session
    && host.dataEpoch === session.host.dataEpoch
    && Date.now() - session.lastUsedAt < SEARCH_IDLE_MS
    && await session.host.isSourceCurrent() && await host.isSourceCurrent();
  if (!valid && sessions.get(host.conversationId) === session) sessions.delete(host.conversationId);
  return valid;
}

export function mapSearchExpired(call: JunLuoToolCall) {
  return createToolErrorResult(call, createToolError('TOOL_INPUT_REQUIRED', 'map-search-expired'), '上次搜索已失效，需要重新搜索。');
}

/** Called only after the actual model request accepted these non-omitted tool receipts. */
export async function markMapSearchResultsDelivered(callIds: string[], conversationId?: string) {
  for (const session of sessions.values()) {
    if (conversationId && session.host.conversationId !== conversationId) continue;
    const pageDelivered = !!session.pending && callIds.some((id) => session.pending?.callIds.has(id));
    const destinationsDelivered = !!session.destinationCandidateReceipt && callIds.includes(session.destinationCandidateReceipt.callId);
    if (!pageDelivered && !destinationsDelivered) continue;
    if (!await isCurrent(session)) continue;
    if (destinationsDelivered) session.destinationCandidateReceipt!.delivered = true;
    if (pageDelivered) {
      session.offset = session.pending!.end;
      session.pending = undefined;
    }
    session.lastUsedAt = Date.now();
  }
}

export async function runMapSearch(options: {
  call: JunLuoToolCall;
  host: MapSearchHostContext;
  search: MapSearchSpec;
  resolveSearch: (previousCandidates: AmapGeocodeCandidate[] | undefined, isCurrent: () => Promise<boolean>, previousDestination?: AmapGeocodeCandidate,
    lookup?: { retryText: boolean; markGeocodeEmpty: () => void }) => Promise<SearchResolution>;
  fetchPage: (center: MapSearchCenter, page: number, host: MapSearchHostContext) => Promise<SearchPage>;
  onError?: (call: JunLuoToolCall, error: unknown) => JunLuoToolResult;
}): Promise<JunLuoToolResult> {
  const { call, host, search } = options;
  for (const [id, session] of sessions) {
    if (Date.now() - session.lastUsedAt >= SEARCH_IDLE_MS) sessions.delete(id);
  }
  const previous = sessions.get(host.conversationId);
  const previousValid = previous && await isCurrent(previous, host);
  const retryKey = `${host.requestId}:${call.callId}`;
  if (previousValid && previous.host.requestId === host.requestId) {
    if (previous.inFlight) await previous.inFlight;
    const retried = previous.results.get(retryKey);
    if (retried) return retried;
  }
  if (!await host.isSourceCurrent()) return mapSearchExpired(call);
  const reusable = previousValid && previous.spec.kind === search.kind
    && previous.spec.query === search.query && previous.spec.city === search.city
    && previous.spec.radiusKm === search.radiusKm && previous.destinationCandidateReceipt?.delivered
    ? previous.destinationCandidates : undefined;
  const session: SearchSession = {
    host, spec: search, lastUsedAt: Date.now(), loadPage: options.fetchPage,
    page: 0, hasMore: true, candidates: [], seen: new Set(), offset: 0, results: new Map(), onError: options.onError,
  };
  sessions.set(host.conversationId, session);
  const work = (async () => {
    const sameDestination = previousValid && previous.spec.kind === search.kind
      && previous.spec.city === search.city && previous.spec.destination === search.destination
      ? previous.destination : undefined;
    const retryText = !!(previousValid && previous.geocodeEmpty && previous.spec.kind === search.kind
      && previous.spec.city === search.city && previous.spec.destination === search.destination && previous.spec.query === search.query);
    const resolution = await options.resolveSearch(reusable,
      async () => await isCurrent(session) && (!retryText || await previous!.host.isSourceCurrent()), sameDestination,
      { retryText, markGeocodeEmpty: () => { session.geocodeEmpty = true; } });
    if (!await isCurrent(session)) return mapSearchExpired(call);
    const reusedDestination = !!resolution.destination && (resolution.destination === sameDestination
      || reusable?.includes(resolution.destination));
    const reusedCandidates = resolution.destinationCandidates?.some(candidate => reusable?.includes(candidate));
    if (previousValid && (reusedDestination || reusedCandidates || retryText)) {
      // The old session has been replaced, but its actual source messages still
      // support the reused coordinates. Keep only that source check, not its
      // session identity or old turn lifetime.
      const previousSourceCurrent = previous.host.isSourceCurrent;
      const currentSourceCurrent = host.isSourceCurrent;
      session.host = {
        ...host,
        sourceMessageIds: Array.from(new Set([...previous.host.sourceMessageIds, ...host.sourceMessageIds])),
        isSourceCurrent: async () => await currentSourceCurrent() && await previousSourceCurrent(),
      };
      if (!await isCurrent(session)) return mapSearchExpired(call);
    }
    Object.assign(session, resolution);
    if (!session.center) {
      const candidates = session.destinationCandidates ?? [];
      if (candidates.length) session.destinationCandidateReceipt = { callId: call.callId, delivered: false };
      const result = createToolSuccessResult(call, candidates.length
        ? '高德查到 ' + candidates.length + ' 个目的地候选。'
        : '本次查询没有找到匹配地点。', { candidates: candidates.map((candidate) => ({ ...candidate, name: destinationReference(candidate) })), provider: 'amap' });
      session.results.set(retryKey, result);
      return result;
    }
    return nextPage(session, call, host);
  })().catch((error) => cacheFailure(session, call, host, error));
  session.inFlight = work;
  try { return await work; } finally { session.inFlight = undefined; }
}

export async function continueMapSearch(call: JunLuoToolCall, host?: MapSearchHostContext): Promise<JunLuoToolResult> {
  if (!host) return mapSearchExpired(call);
  const session = sessions.get(host.conversationId);
  if (!session || !await isCurrent(session, host) || !session.center || session.failed) return mapSearchExpired(call);
  if (session.inFlight) await session.inFlight;
  if (session.failed || !await isCurrent(session, host)) return mapSearchExpired(call);
  const work = nextPage(session, call, host).catch((error) => cacheFailure(session, call, host, error));
  session.inFlight = work;
  try { return await work; } finally { if (session.inFlight === work) session.inFlight = undefined; }
}

async function nextPage(session: SearchSession, call: JunLuoToolCall, host: MapSearchHostContext) {
  const retryKey = `${host.requestId}:${call.callId}`;
  const retry = session.results.get(retryKey);
  if (retry) return retry;
  session.lastUsedAt = Date.now();
  if (session.offset >= session.candidates.length && session.hasMore) {
    const page = await session.loadPage(session.center!, session.page + 1, {
      ...host, isSourceCurrent: () => isCurrent(session, host),
    });
    if (!await isCurrent(session, host)) return mapSearchExpired(call);
    session.page += 1;
    session.hasMore = page.hasMore;
    const fresh = page.candidates.filter((candidate) => {
      const identity = candidate.id || `${candidate.name}:${candidate.latitude}:${candidate.longitude}`;
      if (session.seen.has(identity)) return false;
      session.seen.add(identity);
      return true;
    });
    session.candidates.push(...fresh);
    // One provider batch per invocation, even if it contains only duplicates.
    if (!fresh.length) return cacheResult(session, retryKey, createToolSuccessResult(call,
      '本次查询没有找到匹配地点。', { candidates: [], provider: 'amap' }));
  }
  const end = session.pending?.end ?? Math.min(session.offset + 5, session.candidates.length);
  const candidates = session.candidates.slice(session.offset, end);
  if (!candidates.length) return cacheResult(session, retryKey, createToolSuccessResult(call,
    '这次搜索可查看的结果已展示完。', { candidates: [], provider: 'amap' }));
  session.pending ??= { end, callIds: new Set() };
  session.pending.callIds.add(call.callId);
  const summary = session.spec.kind === 'nearby'
    ? `附近显示 ${candidates.length} 个地点候选。`
    : `远方目的地显示 ${candidates.length} 个地点候选。`;
  return cacheResult(session, retryKey, createToolSuccessResult(call, summary, {
    candidates, destination: session.destination, location: session.center, provider: 'amap', scope: session.spec.kind,
  }));
}

function cacheResult(session: SearchSession, key: string, result: JunLuoToolResult) {
  session.results.set(key, result);
  return result;
}

function cacheFailure(session: SearchSession, call: JunLuoToolCall, host: MapSearchHostContext, error: unknown) {
  session.failed = true;
  const result = session.onError?.(call, error) ?? createToolErrorResult(call,
    createToolError('EXECUTION_FAILED', error instanceof Error ? error.message : 'map-query-failed'), '本次地图查询未完成。');
  return cacheResult(session, `${host.requestId}:${call.callId}`, result);
}

export function destinationReference(candidate: AmapGeocodeCandidate) {
  return Array.from(new Set([candidate.city || candidate.province, candidate.district,
    candidate.address, candidate.placeLabel].filter(Boolean))).join(' · ');
}
