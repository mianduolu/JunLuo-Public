import {
  aiLogicalConfigStorageBridge as AsyncStorage,
} from '../sync/syncAiLogicalConfigStorageBridge';
import {
  researchMaterialsStorageBridge,
} from '../sync/syncResearchMaterialsStorageBridge';

import {
  createMobileSearchDiagnostic,
  MOBILE_SEARCH_ENGINE_REGISTRY,
  searchMobileLifeResearch,
} from './lifeResearchMobileSearch';
import type { ScheduleItem } from '../schedule/scheduleStore';

const BACKEND_SETTINGS_KEY = 'junluo.backend.settings';

export type BackendSettings = {
  enabled: boolean;
  baseUrl: string;
};

export type BackendEvent = {
  id: string;
  type:
    | 'schedule_due'
    | 'proactive_due'
    | 'device_heartbeat'
    | 'life_message_due'
    | 'life_reflection_created'
    | 'life_persona_changed'
    | string;
  payload: Record<string, unknown>;
  created_at: number;
};

export type BackendRuntimeStatus = {
  websocket: 'disabled' | 'connecting' | 'connected' | 'disconnected' | 'error';
  detail: string;
  updatedAt: number;
};

export type BackendServerStatus = {
  status: string;
  now: number;
  pendingEvents: number;
  pendingSchedules: number;
  phoneActivityLogs?: number;
  connectedClients: number;
  registeredClients: string[];
  searchProviders?: Array<{
    engines: string[];
    id: string;
    label: string;
    lastFailure?: string;
    lastFailureAt?: number | null;
    skippedReason?: string;
    status: string;
  }>;
};

export type LifeAgentStatus = {
  enabled: boolean;
  lastSnapshotAt?: number | null;
  modelConfigured: boolean;
  personaHistory: Array<Record<string, unknown>>;
  recentActions: Array<Record<string, unknown>>;
  recentReflections: Array<Record<string, unknown>>;
  todayPlan?: Record<string, unknown> | null;
};

export type PhoneActivitySummary = {
  status: string;
  minutes: number;
  count: number;
  summary: string;
  updatedAt: number;
};

export type PhoneActivityLog = {
  id: string;
  device_id: string;
  kind: string;
  source: string;
  title: string;
  summary: string;
  started_at?: number | null;
  ended_at?: number | null;
  duration_ms: number;
  sensitive_level: string;
  created_at: number;
};

export type LifeResearchSearchResult = {
  engine?: string;
  foundVia?: string[];
  provider?: string;
  title: string;
  url: string;
  snippet: string;
};

export type LifeResearchSearchScope = 'phone' | 'backend';
export type LifeResearchSearchRole = 'primary' | 'enhancement' | 'fallback';

export type LifeResearchSearchDiagnostic = {
  attemptCount?: number;
  elapsedMs?: number;
  engine?: string;
  engines: string[];
  httpStatus?: number;
  id: string;
  label: string;
  lastFailure?: string;
  lastFailureAt?: number | null;
  resultCount?: number;
  role?: LifeResearchSearchRole;
  scope?: LifeResearchSearchScope;
  skippedReason?: string;
  status: string;
  triedAt?: number;
};

export type LifeResearchSearchResponse = {
  context?: LifeResearchSearchContext;
  diagnostics: LifeResearchSearchDiagnostic[];
  results: LifeResearchSearchResult[];
};

export type LifeResearchSearchContextSource = {
  foundVia: string[];
  rank: number;
  snippet: string;
  title: string;
  url: string;
};

export type LifeResearchSearchContext = {
  query: string;
  sourceCount: number;
  sources: LifeResearchSearchContextSource[];
  warnings: string[];
};

type LifeResearchSearchWithDiagnosticsOptions = {
  backendFetch?: typeof fetchWithTimeout;
  baseUrls?: string[];
  phoneSearch?: (query: string) => Promise<LifeResearchSearchResponse>;
};

export type LifeResearchEvidenceSource = {
  classification: string;
  evidenceStrength: number;
  sourceQualityTier: string;
  title: string;
  url: string;
};

export type LifeResearchEvidence = {
  confidence: string;
  sourceDigest: LifeResearchEvidenceSource[];
  status: 'completed' | 'skipped' | 'failed' | string;
  summary: string;
  verdict: string;
  warnings: string[];
};

export type LifeResearchPage = {
  cacheId: string;
  excerpt: string;
  fetchMode?: 'http' | 'browser';
  fetchedAt: number;
  title: string;
  url: string;
};

export type FundApiResponse<T> = {
  ok: boolean;
  data: T | null;
  source: 'akshare' | 'cache' | 'none';
  fetchedAt: string | null;
  stale: boolean;
  warnings: string[];
  cache?: FundCacheMeta | null;
};

export type FundCandidateType = 'money' | 'bond' | 'index' | 'etf';
export type FundSourceType = 'open_fund' | 'money_fund' | 'index_fund' | 'etf' | 'unknown';
export type FundPoolCategory = 'cash_parking' | 'stable' | 'broad_index' | 'watchlist';
export type FundPoolFilter = FundPoolCategory | 'all';
export type FundPoolStatus = 'eligible' | 'observe_only' | 'blocked';
export type FundThoughtSignalType = 'bullish' | 'neutral' | 'bearish' | 'blocked';

export type FundCacheMeta = {
  ageSeconds: number;
  expiresAt: string;
  fetchedAt: string;
  isExpired: boolean;
  key: string;
  staleAllowed: boolean;
  ttlRemainingSeconds: number;
};

export type FundCacheStatusItem = FundCacheMeta & {
  payloadBytes: number;
  source: string;
};

export type FundSearchItem = {
  code: string;
  name: string;
  type: string;
  pinyinShort: string;
  pinyinFull: string;
};

export type FundProfile = {
  code: string;
  name: string;
  type: string;
  sourceType: FundSourceType;
  manager: string | null;
  company: string | null;
  inceptionDate: string | null;
  latestScale: number | null;
  ratingAgency: string | null;
  rating: string | null;
  purchaseStatus: string;
  redeemStatus: string;
  minPurchaseAmount: number | null;
  dailyLimit: number | null;
  feeRate: number | null;
  latestValue: number | null;
  latestValueDate: string | null;
  trackingTarget: string | null;
  trackingMethod: string | null;
  ratingInfo: FundRatingInfo | null;
  managerInfo: FundManagerInfo | null;
  companyInfo: FundCompanyInfo | null;
  feeInfo: FundFeeInfo | null;
  scaleInfo: FundScaleInfo | null;
  extra: Record<string, unknown>;
};

export type FundNavPoint = {
  date: string;
  unitNav: number | null;
  accumulatedNav: number | null;
  dailyReturnPct: number | null;
  sevenDayAnnualizedPct: number | null;
  tenThousandIncome: number | null;
};

export type FundPurchaseStatus = {
  code: string;
  canBuy: boolean;
  canRedeem: boolean;
  nextOpenDate: string | null;
  minAmount: number | null;
  dailyLimit: number | null;
  feeRate: number | null;
  purchaseStatus: string;
  redeemStatus: string;
};

export type FundRatingInfo = {
  fiveStarCount: number | null;
  shanghaiSecurities: string | null;
  cmbSecurities: string | null;
  jianRating: string | null;
  morningstarRating: string | null;
  ratingSummary: string | null;
};

export type FundManagerInfo = {
  name: string | null;
  company: string | null;
  currentAssetScale: number | null;
  careerTime: string | null;
  bestReturnPct: number | null;
};

export type FundCompanyInfo = {
  name: string | null;
  foundedAt: string | null;
  totalAum: number | null;
  fundCount: number | null;
  managerCount: number | null;
};

export type FundFeeInfo = {
  tradeStatus: Array<Record<string, unknown>>;
  purchaseAmountRule: Array<Record<string, unknown>>;
  operationFees: Array<Record<string, unknown>>;
  frontPurchaseFees: Array<Record<string, unknown>>;
  redemptionFees: Array<Record<string, unknown>>;
  warnings: string[];
};

export type FundScaleInfo = {
  totalRaisedScale: number | null;
  inceptionDate: string | null;
  manager: string | null;
};

export type FundPerformance = {
  return1w: number | null;
  return1m: number | null;
  return3m: number | null;
  return6m: number | null;
  return1y: number | null;
  return2y: number | null;
  return3y: number | null;
  returnYtd: number | null;
  returnSinceInception: number | null;
  maxDrawdown1y: number | null;
  volatility1y: number | null;
  sharpeLikeScore: number | null;
};

export type FundCandidateScore = {
  qualityScore: number | null;
  riskScore: number | null;
  trendScore: number | null;
  costScore: number | null;
  liquidityScore: number | null;
  managerScore: number | null;
  finalScore: number | null;
  blockReasons: string[];
  warningReasons: string[];
};

export type FundPoolAssessment = {
  category: FundPoolCategory;
  status: FundPoolStatus;
  canAutoConsider: boolean;
  reasons: string[];
  warnings: string[];
  blockReasons: string[];
};

export type FundCandidate = {
  code: string;
  name: string;
  type: string;
  sourceType: FundSourceType;
  latestValue: number | null;
  return1w: number | null;
  return1m: number | null;
  return3m: number | null;
  return6m: number | null;
  return1y: number | null;
  feeRate: number | null;
  purchaseStatus: string;
  performance: FundPerformance;
  score: FundCandidateScore;
  poolAssessment: FundPoolAssessment;
  extra: Record<string, unknown>;
};

export type FundThoughtSignal = {
  thoughtId: string;
  label: string;
  signal: FundThoughtSignalType;
  confidence: number;
  score: number | null;
  reasoning: string;
  warnings: string[];
  blockReasons: string[];
  suggestedLimitNote: string;
};

export type FundThoughtAnalysis = {
  fundCode: string;
  fundName: string;
  overallSignal: FundThoughtSignalType;
  overallConfidence: number;
  summary: string;
  thoughtSignals: FundThoughtSignal[];
  warnings: string[];
  blockReasons: string[];
};

const defaultSettings: BackendSettings = {
  enabled: false,
  baseUrl: '',
};
const LIFE_RESEARCH_DEFAULT_BASE_URLS = ['http://127.0.0.1:8787'];
const LIFE_RESEARCH_REQUEST_TIMEOUT_MS = 12000;
const LIFE_RESEARCH_MOBILE_CACHE_PREFIX = 'junluo.lifeResearch.mobileCache.';
const LIFE_RESEARCH_EXCERPT_LIMIT = 2400;

export const LIFE_RESEARCH_SEARCH_BOUNDARY = {
  currentBackendRole: 'enhancement',
  currentPhoneFallbackEngine: 'DuckDuckGo',
  currentPhoneFallbackRole: 'fallback',
  targetPrimaryScope: 'phone',
} as const satisfies {
  currentBackendRole: LifeResearchSearchRole;
  currentPhoneFallbackEngine: string;
  currentPhoneFallbackRole: LifeResearchSearchRole;
  targetPrimaryScope: LifeResearchSearchScope;
};

let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let shouldReconnect = false;
let runtimeStatus: BackendRuntimeStatus = {
  websocket: 'disabled',
  detail: '后端小管家还没有启用。',
  updatedAt: Date.now(),
};
const statusListeners = new Set<(status: BackendRuntimeStatus) => void>();
const settingsListeners = new Set<(settings: BackendSettings) => void>();

function setRuntimeStatus(websocket: BackendRuntimeStatus['websocket'], detail: string) {
  runtimeStatus = { websocket, detail, updatedAt: Date.now() };
  statusListeners.forEach((listener) => listener(runtimeStatus));
}

export function getBackendRuntimeStatus() {
  return runtimeStatus;
}

export function subscribeBackendRuntimeStatus(listener: (status: BackendRuntimeStatus) => void) {
  statusListeners.add(listener);
  listener(runtimeStatus);
  return () => {
    statusListeners.delete(listener);
  };
}

export function subscribeBackendSettings(listener: (settings: BackendSettings) => void) {
  settingsListeners.add(listener);
  return () => {
    settingsListeners.delete(listener);
  };
}

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.trim().replace(/\/+$/, '');
}

function uniqueNormalizedBaseUrls(baseUrls: string[]) {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const baseUrl of baseUrls) {
    const next = normalizeBaseUrl(baseUrl);
    if (!next || seen.has(next)) continue;
    seen.add(next);
    normalized.push(next);
  }
  return normalized;
}

async function loadLifeResearchBaseUrls() {
  const settings = await loadBackendSettings();
  return uniqueNormalizedBaseUrls([
    settings.baseUrl,
    ...LIFE_RESEARCH_DEFAULT_BASE_URLS,
  ]);
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = LIFE_RESEARCH_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function decodeHtmlEntities(value: string) {
  return value
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function compactWebText(value: string, limit = LIFE_RESEARCH_EXCERPT_LIMIT) {
  return decodeHtmlEntities(value).replace(/\s+/g, ' ').trim().slice(0, limit);
}

function stripHtmlTags(value: string, limit = LIFE_RESEARCH_EXCERPT_LIMIT) {
  return compactWebText(value.replace(/<[^>]+>/g, ' '), limit);
}

function removeHtmlBlocks(raw: string, tagNames: string[]) {
  return tagNames.reduce(
    (current, tagName) => current.replace(new RegExp(`<${tagName}\\b[\\s\\S]*?<\\/${tagName}>`, 'gi'), ' '),
    raw,
  );
}

function removeNoisyHtmlContainers(raw: string) {
  return raw.replace(
    /<([a-z][a-z0-9-]*)\b[^>]*(?:class|id)=["'][^"']*(?:cookie|banner|sidebar|advert|ad-|comments?|share|popup|modal)[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi,
    ' ',
  );
}

function firstHtmlBlock(raw: string, tagName: string) {
  return raw.match(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i'))?.[1] ?? '';
}

function isPublicHttpUrl(url: string) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    if (!host || host === 'localhost' || host.endsWith('.local')) return false;
    if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.)/.test(host)) return false;
    const private172 = /^172\.(1[6-9]|2\d|3[0-1])\./.test(host);
    return !private172;
  } catch {
    return false;
  }
}

function extractReadableMobilePage(raw: string) {
  const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = stripHtmlTags(titleMatch?.[1] ?? '', 180);
  const readable = removeNoisyHtmlContainers(removeHtmlBlocks(raw, [
    'script',
    'style',
    'noscript',
    'svg',
    'nav',
    'footer',
    'header',
    'aside',
    'form',
    'button',
    'iframe',
  ]));
  const mainContent = firstHtmlBlock(readable, 'article') ||
    firstHtmlBlock(readable, 'main') ||
    firstHtmlBlock(readable, 'body') ||
    readable;
  let excerpt = stripHtmlTags(mainContent);
  if (!excerpt) excerpt = stripHtmlTags(readable);
  return { title, excerpt };
}

function mobileCacheIdForUrl(url: string) {
  let hash = 2166136261;
  for (let index = 0; index < url.length; index += 1) {
    hash ^= url.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `mobile-${(hash >>> 0).toString(16)}`;
}

async function saveMobileResearchPage(page: LifeResearchPage) {
  await researchMaterialsStorageBridge.setItem(
    `${LIFE_RESEARCH_MOBILE_CACHE_PREFIX}${page.cacheId}`,
    JSON.stringify(page),
  );
}

async function loadMobileResearchPage(cacheId: string) {
  const raw = await researchMaterialsStorageBridge.getItem(
    `${LIFE_RESEARCH_MOBILE_CACHE_PREFIX}${cacheId}`,
  );
  if (!raw) return null;
  try {
    const page = JSON.parse(raw) as LifeResearchPage;
    return page?.cacheId === cacheId ? page : null;
  } catch {
    return null;
  }
}

async function loadMobileResearchPageForUrl(url: string) {
  if (!isPublicHttpUrl(url)) return null;
  const page = await loadMobileResearchPage(mobileCacheIdForUrl(url));
  return page?.url === url ? page : null;
}

async function searchLifeResearchOnPhone(query: string) {
  return searchMobileLifeResearch(query);
}

function compactDiagnosticText(value: unknown, limit = 160) {
  const text = value instanceof Error ? value.message : typeof value === 'string' ? value : String(value ?? '');
  return text.replace(/\s+/g, ' ').trim().slice(0, limit);
}

export function createBackendSearchDiagnostic(baseUrl: string, lastFailure: string): LifeResearchSearchDiagnostic {
  return {
    engines: ['Brave', 'Bing', 'Startpage', 'Qwant', 'Yahoo', 'Yandex', 'DuckDuckGo'],
    id: `junluo_backend:${baseUrl}`,
    label: `君落后端多源搜索 ${baseUrl}`,
    lastFailure: compactDiagnosticText(lastFailure),
    role: 'enhancement',
    scope: 'backend',
    status: 'failed',
  };
}

export function createBackendSearchSuccessDiagnostic(
  baseUrl: string,
  resultCount: number,
  diagnostics: LifeResearchSearchDiagnostic[] = [],
): LifeResearchSearchDiagnostic {
  const engines = diagnostics.flatMap((diagnostic) => diagnostic.engines ?? []);
  return {
    engines: engines.length ? Array.from(new Set(engines)) : ['Brave', 'Bing', 'Startpage', 'Qwant', 'Yahoo', 'Yandex', 'DuckDuckGo'],
    id: `junluo_backend:${baseUrl}`,
    label: `君落后端多源搜索 ${baseUrl}`,
    resultCount,
    role: 'enhancement',
    scope: 'backend',
    status: 'success',
  };
}

export function createMobileDuckDuckGoDiagnostic(
  lastFailure = 'no parseable results',
  resultCount = 0,
): LifeResearchSearchDiagnostic {
  return createMobileSearchDiagnostic(
    MOBILE_SEARCH_ENGINE_REGISTRY.duckduckgo,
    resultCount ? 'success' : 'failed',
    resultCount,
    resultCount ? undefined : lastFailure,
  );
}

function normalizeSearchResultUrl(url: string) {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    parsed.hostname = parsed.hostname.toLowerCase();
    for (const key of Array.from(parsed.searchParams.keys())) {
      const lowered = key.toLowerCase();
      if (
        lowered.startsWith('utm_') ||
        lowered === 'fbclid' ||
        lowered === 'gclid' ||
        lowered === 'yclid' ||
        lowered === 'msclkid'
      ) {
        parsed.searchParams.delete(key);
      }
    }
    const normalizedPath = parsed.pathname.replace(/\/+$/, '') || '/';
    parsed.pathname = normalizedPath;
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return url.trim();
  }
}

function searchResultHost(url: string) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function uniqueStrings(values: string[]) {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const next = compactWebText(value, 80);
    if (!next || seen.has(next)) continue;
    seen.add(next);
    unique.push(next);
  }
  return unique;
}

function searchResultSourceLabels(result: LifeResearchSearchResult) {
  return uniqueStrings([
    ...(result.foundVia ?? []),
    result.engine ?? '',
    result.provider ?? '',
    searchResultHost(result.url),
  ]);
}

function diagnosticWarnings(diagnostics: LifeResearchSearchDiagnostic[]) {
  return uniqueStrings(
    diagnostics.flatMap((diagnostic) => {
      const reason = diagnostic.lastFailure || diagnostic.skippedReason || '';
      if (!reason) return [];
      return `${diagnostic.label}: ${reason}`;
    }),
  ).slice(0, 4);
}

function buildLifeResearchSearchContext(
  query: string,
  results: LifeResearchSearchResult[],
  diagnostics: LifeResearchSearchDiagnostic[],
): LifeResearchSearchContext {
  return {
    query,
    sourceCount: results.length,
    sources: results.slice(0, 6).map((result, index) => ({
      foundVia: result.foundVia ?? searchResultSourceLabels(result),
      rank: index + 1,
      snippet: compactWebText(result.snippet, 260),
      title: compactWebText(result.title, 160),
      url: result.url,
    })),
    warnings: diagnosticWarnings(diagnostics),
  };
}

function postProcessLifeResearchSearchResults(
  query: string,
  results: LifeResearchSearchResult[],
  diagnostics: LifeResearchSearchDiagnostic[],
): LifeResearchSearchResponse {
  const byUrl = new Map<string, LifeResearchSearchResult & { originalIndex: number }>();
  results.forEach((result, index) => {
    const key = normalizeSearchResultUrl(result.url);
    const foundVia = searchResultSourceLabels(result);
    const existing = byUrl.get(key);
    if (!existing) {
      byUrl.set(key, {
        ...result,
        foundVia,
        originalIndex: index,
        snippet: compactWebText(result.snippet, 360),
        title: compactWebText(result.title, 180),
      });
      return;
    }
    existing.foundVia = uniqueStrings([...(existing.foundVia ?? []), ...foundVia]);
    if ((result.snippet ?? '').length > (existing.snippet ?? '').length) {
      existing.snippet = compactWebText(result.snippet, 360);
    }
  });
  const mergedResults = Array.from(byUrl.values())
    .sort((left, right) => {
      const leftSources = left.foundVia?.length ?? 0;
      const rightSources = right.foundVia?.length ?? 0;
      if (leftSources !== rightSources) return rightSources - leftSources;
      if (left.snippet.length !== right.snippet.length) return right.snippet.length - left.snippet.length;
      return left.originalIndex - right.originalIndex;
    })
    .map(({ originalIndex, ...result }) => result);
  return {
    context: buildLifeResearchSearchContext(query, mergedResults, diagnostics),
    diagnostics,
    results: mergedResults,
  };
}

type LifeResearchPageFetchOptions = {
  runMobileCacheCommit?: <T>(work: () => Promise<T> | T) => Promise<T>;
};

async function fetchLifeResearchPageOnPhone(url: string, options?: LifeResearchPageFetchOptions) {
  if (!isPublicHttpUrl(url)) return null;
  try {
    const response = await fetchWithTimeout(url, {
      headers: { Accept: 'text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.5' },
    });
    if (!response.ok) return null;
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (contentType && !/text\/html|text\/plain|application\/xhtml\+xml|application\/xml|text\/xml/.test(contentType)) {
      return null;
    }
    const { title, excerpt } = extractReadableMobilePage(await response.text());
    if (excerpt.length < 80) return null;
    const parsed = new URL(url);
    const page: LifeResearchPage = {
      cacheId: mobileCacheIdForUrl(url),
      excerpt,
      fetchMode: 'http',
      fetchedAt: Date.now(),
      title: title || parsed.hostname || 'web page',
      url,
    };
    if (options?.runMobileCacheCommit) {
      await options.runMobileCacheCommit(() => saveMobileResearchPage(page));
    } else {
      await saveMobileResearchPage(page);
    }
    return page;
  } catch {
    return null;
  }
}

function toWebSocketUrl(baseUrl: string) {
  const normalized = normalizeBaseUrl(baseUrl);
  if (normalized.startsWith('https://')) return `wss://${normalized.slice('https://'.length)}/ws`;
  if (normalized.startsWith('http://')) return `ws://${normalized.slice('http://'.length)}/ws`;
  return '';
}

function safeSocketSend(message: Record<string, unknown>) {
  const current = socket;
  if (!current || current.readyState !== WebSocket.OPEN) return false;
  try {
    current.send(JSON.stringify(message));
    return true;
  } catch {
    setRuntimeStatus('error', '后端连接刚刚抖了一下，准备重新牵线。');
    return false;
  }
}

function safeSocketClose() {
  const current = socket;
  if (!current) return;
  try {
    current.close();
  } catch {
    // React Native may throw INVALID_STATE_ERR if the socket is already closing.
  }
}

function normalizeSettings(value: unknown): BackendSettings {
  if (!value || typeof value !== 'object') return defaultSettings;
  const candidate = value as Partial<BackendSettings>;
  return {
    enabled: candidate.enabled === true,
    baseUrl: typeof candidate.baseUrl === 'string' ? candidate.baseUrl : '',
  };
}

export async function loadBackendSettings() {
  const raw = await AsyncStorage.getItem(BACKEND_SETTINGS_KEY);
  if (!raw) return defaultSettings;
  try {
    return normalizeSettings(JSON.parse(raw) as unknown);
  } catch {
    return defaultSettings;
  }
}

export async function saveBackendSettings(settings: BackendSettings) {
  await AsyncStorage.setItem(BACKEND_SETTINGS_KEY, JSON.stringify(settings));
  settingsListeners.forEach((listener) => listener(settings));
}

export async function testBackendConnection(baseUrl: string) {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) return { ok: false, detail: '请先填写后端地址。' };
  try {
    const response = await fetch(`${normalized}/health`);
    if (!response.ok) return { ok: false, detail: `后端没有回应成功：${response.status}` };
    const payload = (await response.json()) as { status?: unknown };
    return payload.status === 'ok'
      ? { ok: true, detail: '小管家连上啦。' }
      : { ok: false, detail: '后端回应了，但不像君落后端。' };
  } catch {
    return { ok: false, detail: '连不上后端。检查电脑 IP、端口、防火墙和 WiFi。' };
  }
}

export async function fetchBackendStatus(baseUrl?: string) {
  const settings = baseUrl ? { enabled: true, baseUrl } : await loadBackendSettings();
  const normalized = normalizeBaseUrl(settings.baseUrl);
  if (!normalized) return null;
  try {
    const response = await fetch(`${normalized}/api/status`);
    if (!response.ok) return null;
    return (await response.json()) as BackendServerStatus;
  } catch {
    return null;
  }
}

function scheduleToPayload(item: ScheduleItem) {
  return {
    id: item.id,
    title: item.title,
    notes: item.notes,
    trigger_at: item.startAt - item.reminderMinutesBefore * 60 * 1000,
    scheduled_start_at: item.startAt,
    reminder_at: item.startAt - item.reminderMinutesBefore * 60 * 1000,
    reminder_minutes_before: item.reminderMinutesBefore,
    reminder_intensity: item.reminderIntensity,
    recurrence: item.recurrence,
    source: item.source,
  };
}

export async function syncBackendScheduleItem(item: ScheduleItem) {
  void item;
}

export async function deleteBackendScheduleItem(itemId: string) {
  void itemId;
}

export async function pullBackendEvents() {
  return [];
}

export async function fetchPhoneActivitySummary(minutes = 30) {
  void minutes;
  return null;
}

export async function fetchRecentPhoneActivityLogs(limit = 20) {
  void limit;
  return [];
}

export async function fetchTodayPhoneActivityLogs(limit = 100) {
  void limit;
  return [];
}

export async function searchLifeResearch(query: string) {
  return (await searchLifeResearchWithDiagnostics(query)).results;
}

export async function searchLifeResearchWithDiagnostics(
  query: string,
  options: LifeResearchSearchWithDiagnosticsOptions = {},
): Promise<LifeResearchSearchResponse> {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) return { diagnostics: [], results: [] };
  const phoneResponse = await (options.phoneSearch ?? searchLifeResearchOnPhone)(trimmedQuery);
  const phoneDiagnostics = phoneResponse.diagnostics.length
    ? phoneResponse.diagnostics
    : [createMobileDuckDuckGoDiagnostic()];
  if (phoneResponse.results.length) {
    return postProcessLifeResearchSearchResults(trimmedQuery, phoneResponse.results, phoneDiagnostics);
  }

  const baseUrls = options.baseUrls ?? await loadLifeResearchBaseUrls();
  const backendFetch = options.backendFetch ?? fetchWithTimeout;
  const backendDiagnostics: LifeResearchSearchDiagnostic[] = [];
  for (const baseUrl of baseUrls) {
    try {
      const response = await backendFetch(`${baseUrl}/api/life-research/search`, {
        body: JSON.stringify({ query: trimmedQuery }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      });
      if (!response.ok) {
        backendDiagnostics.push(createBackendSearchDiagnostic(baseUrl, `HTTP ${response.status}`));
        continue;
      }
      const payload = (await response.json()) as Partial<LifeResearchSearchResponse>;
      if (Array.isArray(payload.results)) {
        const payloadDiagnostics = Array.isArray(payload.diagnostics) ? payload.diagnostics : [];
        const processed = postProcessLifeResearchSearchResults(trimmedQuery, payload.results, [
          ...phoneDiagnostics,
          ...payloadDiagnostics,
        ]);
        const diagnostics = [
          ...processed.diagnostics,
          createBackendSearchSuccessDiagnostic(baseUrl, processed.results.length, payloadDiagnostics),
        ];
        return {
          ...processed,
          context: buildLifeResearchSearchContext(trimmedQuery, processed.results, diagnostics),
          diagnostics,
        };
      }
      backendDiagnostics.push(createBackendSearchDiagnostic(baseUrl, 'response JSON did not include results[]'));
    } catch (error) {
      backendDiagnostics.push(createBackendSearchDiagnostic(baseUrl, compactDiagnosticText(error)));
    }
  }
  return postProcessLifeResearchSearchResults(trimmedQuery, [], [
    ...phoneDiagnostics,
    ...backendDiagnostics,
  ]);
}

export async function verifyLifeResearchEvidence(query: string, claim: string): Promise<LifeResearchEvidence | null> {
  const trimmedQuery = query.trim();
  const trimmedClaim = claim.trim();
  if (!trimmedQuery || !trimmedClaim) return null;
  const baseUrls = await loadLifeResearchBaseUrls();
  for (const baseUrl of baseUrls) {
    try {
      const response = await fetchWithTimeout(`${baseUrl}/api/life-research/evidence`, {
        body: JSON.stringify({ claim: trimmedClaim, query: trimmedQuery }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      });
      if (!response.ok) continue;
      return (await response.json()) as LifeResearchEvidence;
    } catch {
      continue;
    }
  }
  return {
    confidence: 'unknown',
    sourceDigest: [],
    status: 'skipped',
    summary: '本地后端没有返回考证结果；这次见闻只作为看见过的材料，不当成定论。',
    verdict: 'not_checked',
    warnings: ['backend_unavailable'],
  };
}

export async function fetchLifeResearchPage(url: string, options?: LifeResearchPageFetchOptions) {
  const trimmedUrl = url.trim();
  if (!trimmedUrl) return null;
  const cachedPhonePage = await loadMobileResearchPageForUrl(trimmedUrl);
  if (cachedPhonePage) return cachedPhonePage;
  const phonePage = await fetchLifeResearchPageOnPhone(trimmedUrl, options);
  if (phonePage) return phonePage;
  const baseUrls = await loadLifeResearchBaseUrls();
  for (const baseUrl of baseUrls) {
    try {
      const response = await fetchWithTimeout(`${baseUrl}/api/life-research/fetch`, {
        body: JSON.stringify({ url: trimmedUrl }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      });
      if (!response.ok) continue;
      return (await response.json()) as LifeResearchPage;
    } catch {
      continue;
    }
  }
  return null;
}

export async function fetchLifeResearchCache(cacheId: string) {
  const trimmedCacheId = cacheId.trim();
  if (!trimmedCacheId) return null;
  const phonePage = await loadMobileResearchPage(trimmedCacheId);
  if (phonePage) return phonePage;
  const baseUrls = await loadLifeResearchBaseUrls();
  for (const baseUrl of baseUrls) {
    try {
      const response = await fetchWithTimeout(`${baseUrl}/api/life-research/cache/${encodeURIComponent(trimmedCacheId)}`);
      if (!response.ok) continue;
      return (await response.json()) as LifeResearchPage;
    } catch {
      continue;
    }
  }
  return null;
}

async function fetchFundApi<T>(path: string, init: RequestInit = {}): Promise<FundApiResponse<T>> {
  const baseUrls = await loadLifeResearchBaseUrls();
  for (const baseUrl of baseUrls) {
    try {
      const response = await fetchWithTimeout(`${baseUrl}${path}`, init);
      if (!response.ok) continue;
      return (await response.json()) as FundApiResponse<T>;
    } catch {
      continue;
    }
  }
  return {
    ok: false,
    data: null,
    source: 'none',
    fetchedAt: null,
    stale: false,
    cache: null,
    warnings: ['今天基金数据桥没连上，白云先不拿它做买入依据噢><'],
  };
}

export async function searchFunds(query: string, limit = 30) {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return {
      ok: true,
      data: [],
      source: 'none',
      fetchedAt: null,
      stale: false,
      cache: null,
      warnings: [],
    } satisfies FundApiResponse<FundSearchItem[]>;
  }
  const params = new URLSearchParams({ q: trimmedQuery, limit: String(limit) });
  return fetchFundApi<FundSearchItem[]>(`/api/funds/search?${params.toString()}`);
}

export async function fetchFundProfile(code: string) {
  return fetchFundApi<FundProfile>(`/api/funds/${encodeURIComponent(code.trim())}/profile`);
}

export async function fetchFundNavHistory(code: string, days = 180) {
  const params = new URLSearchParams({ days: String(days) });
  return fetchFundApi<FundNavPoint[]>(`/api/funds/${encodeURIComponent(code.trim())}/nav-history?${params.toString()}`);
}

export async function fetchFundPurchaseStatus(code: string) {
  return fetchFundApi<FundPurchaseStatus>(`/api/funds/${encodeURIComponent(code.trim())}/purchase-status`);
}

export async function fetchFundCandidates(candidateType: FundCandidateType, limit = 30, pool: FundPoolFilter = 'all') {
  const params = new URLSearchParams({ type: candidateType, limit: String(limit), pool });
  return fetchFundApi<FundCandidate[]>(`/api/funds/candidates?${params.toString()}`);
}

export async function fetchFundCandidate(code: string) {
  return fetchFundApi<FundCandidate>(`/api/funds/${encodeURIComponent(code.trim())}/candidate`);
}

export async function analyzeFundCandidate(candidate: FundCandidate) {
  return fetchFundApi<FundThoughtAnalysis>('/api/funds/analyze-candidate', {
    body: JSON.stringify({ candidate }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  });
}

export async function refreshFundCache({
  candidateType,
  fundCode,
  kind,
}: {
  kind: 'names' | 'purchase' | 'profile' | 'nav_history' | 'candidates' | 'enrichment';
  fundCode?: string;
  candidateType?: FundCandidateType;
}) {
  return fetchFundApi<unknown>('/api/funds/refresh-cache', {
    body: JSON.stringify({ candidateType, fundCode, kind }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  });
}

export async function fetchFundCacheStatus(prefix = 'fund:', limit = 200) {
  const params = new URLSearchParams({ limit: String(limit), prefix });
  return fetchFundApi<FundCacheStatusItem[]>(`/api/funds/cache/status?${params.toString()}`);
}

export async function transcribeVoiceRecording({
  durationMs,
  mimeType,
  uri,
}: {
  durationMs?: number;
  mimeType: string;
  uri: string;
}) {
  void durationMs;
  void mimeType;
  void uri;
  return { text: '', error: '电脑后端语音转写已停用。' };
}

export async function syncLifeSnapshot(payload: Record<string, unknown>) {
  void payload;
  return null;
}

export async function fetchLifeAgentStatus(baseUrl?: string) {
  void baseUrl;
  return null;
}

export async function triggerLifeAgentTick() {
  return null;
}

export async function rollbackLifePersona() {
  return null;
}

export async function startBackendWebSocket(onEvent: (event: BackendEvent) => void) {
  void onEvent;
  stopBackendWebSocket();
  setRuntimeStatus('disabled', '电脑后端事件线已停用，只保留查资料功能。');
  return () => {};
}

export function stopBackendWebSocket() {
  shouldReconnect = false;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  reconnectTimer = null;
  heartbeatTimer = null;
  safeSocketClose();
  socket = null;
}
