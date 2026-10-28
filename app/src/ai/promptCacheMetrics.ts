import AsyncStorage from '@react-native-async-storage/async-storage';

import { estimateApiMessagesTokens, estimateTextTokens } from '../chat/contextCompression';
import type { PromptTokenBreakdown } from '../chat/chatStorage';
import { recordPromptRuntimeSnapshot } from './promptDiagnostics';
import type { OpenAiCompatibleRequestMessage } from './openAiCompatibleProvider';
import type { PromptContextProfile, PromptContextSource } from './promptContextProfile';

const PROMPT_CACHE_METRICS_KEY = 'junluo.promptCache.metrics';
const MAX_PROMPT_CACHE_METRIC_RECORDS = 300;
const PROMPT_CACHE_METRIC_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
let metricWrites: Promise<unknown> = Promise.resolve();

function writeMetrics<T>(work: () => Promise<T>): Promise<T> {
  const next = metricWrites.then(work, work);
  metricWrites = next.then(() => undefined, () => undefined);
  return next;
}

export type PromptCacheContextSource = PromptContextSource | (string & {});
export type PromptCacheChannel = 'deepseek' | 'siliconflow' | 'other' | 'unknown';

const CACHE_USAGE_SOURCES = ['prompt_cache_hit_tokens', 'prompt_tokens_details.cached_tokens',
  'cached_tokens', 'cached_input_tokens', 'unreported'] as const;
export type PromptCacheUsageSource = typeof CACHE_USAGE_SOURCES[number];
export type PromptRequestPrefixDiagnostic = {
  version: 1;
  scopeFingerprint: string;
  messageCount: number;
  toolCount: number;
  compared: boolean;
  toolsChanged: boolean | null;
  parametersChanged: boolean | null;
  commonMessageCount: number | null;
  firstDifferentMessageIndex: number | null;
};
// Observation only: retain hashes at the send boundary per scope, never request text.
const requestPrefixBaselines = new Map<string, { messages: string[]; tools: string; parameters: string }>();

function observeSerializedRequest(body: string, scope: readonly string[]): PromptRequestPrefixDiagnostic | undefined {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.messages)
      || parsed.tools !== undefined && !Array.isArray(parsed.tools)) return undefined;
    const { messages, tools, ...parameters } = parsed;
    const digest = (value: unknown) => {
      const text = JSON.stringify(value) ?? '';
      return `${text.length}:${fingerprintPromptText(text)}`;
    };
    const next = { messages: (messages as unknown[]).map(digest), tools: digest(tools), parameters: digest(parameters) };
    const scopeFingerprint = fingerprintPromptText(JSON.stringify(scope));
    const previous = requestPrefixBaselines.get(scopeFingerprint);
    let commonMessageCount = 0;
    if (previous) {
      while (commonMessageCount < Math.min(previous.messages.length, next.messages.length)
        && previous.messages[commonMessageCount] === next.messages[commonMessageCount]) commonMessageCount += 1;
    }
    requestPrefixBaselines.delete(scopeFingerprint);
    requestPrefixBaselines.set(scopeFingerprint, next);
    if (requestPrefixBaselines.size > 16) requestPrefixBaselines.delete(requestPrefixBaselines.keys().next().value!);
    return { version: 1, scopeFingerprint, messageCount: next.messages.length,
      toolCount: Array.isArray(tools) ? tools.length : 0, compared: !!previous,
      toolsChanged: previous ? previous.tools !== next.tools : null,
      parametersChanged: previous ? previous.parameters !== next.parameters : null,
      commonMessageCount: previous ? commonMessageCount : null,
      firstDifferentMessageIndex: previous
        && (commonMessageCount < next.messages.length || commonMessageCount < previous.messages.length)
        ? commonMessageCount : null };
  } catch { return undefined; } // Diagnostics must not affect sending or exception handling.
}

function readRequestPrefixDiagnostic(value: unknown): PromptRequestPrefixDiagnostic | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const d = value as PromptRequestPrefixDiagnostic;
  if (d.version !== 1 || typeof d.scopeFingerprint !== 'string' || !/^[0-9a-f]{8}$/.test(d.scopeFingerprint)
    || safeTokenCount(d.messageCount) === null || safeTokenCount(d.toolCount) === null
    || typeof d.compared !== 'boolean'
    || [d.toolsChanged, d.parametersChanged].some(item => item !== null && typeof item !== 'boolean')
    || [d.commonMessageCount, d.firstDifferentMessageIndex].some(item => item !== null && safeTokenCount(item) === null)) return undefined;
  return { version: 1, scopeFingerprint: d.scopeFingerprint, messageCount: d.messageCount,
    toolCount: d.toolCount, compared: d.compared, toolsChanged: d.toolsChanged,
    parametersChanged: d.parametersChanged, commonMessageCount: d.commonMessageCount,
    firstDifferentMessageIndex: d.firstDifferentMessageIndex };
}

function readCacheUsageSource(value: unknown): PromptCacheUsageSource | undefined {
  return CACHE_USAGE_SOURCES.includes(value as PromptCacheUsageSource) ? value as PromptCacheUsageSource : undefined;
}

function cacheUsageSource(usage?: PromptCacheUsageLike | null): PromptCacheUsageSource {
  if (usage?.prompt_cache_hit_tokens != null) return 'prompt_cache_hit_tokens';
  if (usage?.prompt_tokens_details?.cached_tokens != null) return 'prompt_tokens_details.cached_tokens';
  if (usage?.cached_tokens != null) return 'cached_tokens';
  if (usage?.cached_input_tokens != null) return 'cached_input_tokens';
  return 'unreported';
}

export type PromptCacheUsageLike = {
  cached_input_tokens?: number;
  cached_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
};

export type ScheduleRequestDiagnostic = {
  occurrenceId?: string;
  kind: 'upcoming' | 'timeUp' | 'followUp';
  referenceTime: number;
  preparationStartedAt: number;
  responseReceivedAt?: number;
  transport?: 'fetch' | 'xhr';
  headersReceivedAt?: number;
  firstContentAt?: number;
  responseCompletedAt?: number;
  responseChars?: number;
  finishedAt: number;
  httpStatus?: number;
  outcome: 'ready' | 'quiet' | 'empty-content' | 'invalid-json' | 'invalid-schema'
    | 'http-error' | 'network-error' | 'aborted';
};

export type PromptCacheMetricRecord = {
  breakdown?: PromptTokenBreakdown;
  contextProfile: PromptContextProfile | (string & {});
  contextSource: PromptCacheContextSource;
  createdAt: number;
  hitRate: number | null;
  hitTokens: number | null;
  id: string;
  missTokens: number | null;
  model?: string;
  channel?: PromptCacheChannel;
  completionTokens?: number | null;
  requestStartedAt?: number;
  cacheUsageSource?: PromptCacheUsageSource;
  requestPrefix?: PromptRequestPrefixDiagnostic;
  scheduleRequest?: ScheduleRequestDiagnostic;
  stablePrefixVersion?: 2;
  promptTokens: number;
  stablePrefixChanged: boolean;
  stablePrefixFingerprint?: string;
  stablePrefixTokens: number;
  tokenSource: 'api' | 'estimate' | 'unknown';
};

export type PromptCacheMetricInput = Omit<PromptCacheMetricRecord, 'createdAt' | 'id' | 'stablePrefixChanged'> & {
  createdAt?: number;
  id?: string;
  stablePrefixChanged?: boolean;
};

export type PromptCacheMetricsGroup = {
  latestRequestDiagnostic?: Pick<PromptCacheMetricRecord, 'createdAt' | 'cacheUsageSource' | 'requestPrefix'>;
  averageHitRate: number | null;
  contextProfile: string;
  contextSource: string;
  model?: string;
  channel: PromptCacheChannel;
  completionTokens: number;
  knownPromptRequestCount: number;
  knownOutputRequestCount: number;
  knownPrefixRequestCount: number;
  hitTokens: number;
  knownCacheRequestCount: number;
  missTokens: number;
  promptTokens: number;
  requestCount: number;
  stablePrefixChangedCount: number;
  stablePrefixTokens: number;
};

export type PromptCacheMetricsSummary = {
  averageHitRate: number | null;
  generatedAt: number;
  groups: PromptCacheMetricsGroup[];
  recentScheduleRequests?: PromptCacheMetricRecord[];
  completionTokens: number;
  knownPromptRequestCount: number;
  knownOutputRequestCount: number;
  knownPrefixRequestCount: number;
  hitTokens: number;
  knownCacheRequestCount: number;
  missTokens: number;
  promptTokens: number;
  requestCount: number;
  sinceMs: number;
  stablePrefixChangedCount: number;
};

function safeNumber(value: unknown, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function safeNullableNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function safeTokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function promptCacheChannelForBaseUrl(baseUrl?: string): PromptCacheChannel {
  if (!baseUrl) return 'unknown';
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    if (host === 'api.deepseek.com') return 'deepseek';
    if (host === 'api.siliconflow.cn' || host === 'api.siliconflow.com') return 'siliconflow';
    return 'other';
  } catch { return 'unknown'; }
}

export function fingerprintPromptText(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function formatPromptCacheHitRate(value: number | null | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) return '未知';
  if (value > 0 && value < 0.001) return '<0.1%';
  if (value < 1 && value > 0.999) return '>99.9%';
  return `${Math.round(value * 1000) / 10}%`;
}

export function extractPromptCacheUsageFromResponseUsage(
  usage: PromptCacheUsageLike | null | undefined,
  fallbackPromptTokens = 0,
) {
  const reportedPromptTokens = safeTokenCount(usage?.prompt_tokens);
  const promptTokens = reportedPromptTokens ?? fallbackPromptTokens;
  const rawHitTokens =
    usage?.prompt_cache_hit_tokens
    ?? usage?.prompt_tokens_details?.cached_tokens
    ?? usage?.cached_tokens
    ?? usage?.cached_input_tokens;
  let hitTokens = safeTokenCount(rawHitTokens);
  const rawMissTokens = usage?.prompt_cache_miss_tokens;
  let missTokens = safeTokenCount(rawMissTokens)
    ?? (hitTokens === null || reportedPromptTokens === null ? null : reportedPromptTokens - hitTokens);
  if (missTokens !== null && missTokens < 0 || reportedPromptTokens !== null
    && hitTokens !== null && missTokens !== null && hitTokens + missTokens !== reportedPromptTokens) {
    hitTokens = null; missTokens = null;
  }
  const cacheTotal = (hitTokens ?? 0) + (missTokens ?? 0);
  return {
    hitRate: cacheTotal > 0 && hitTokens !== null && missTokens !== null ? hitTokens / cacheTotal : null,
    hitTokens,
    missTokens,
    promptTokens,
  };
}

// Pick fixed fields on both write and read; never retain exception text or model material.
function readScheduleRequestDiagnostic(value: unknown): ScheduleRequestDiagnostic | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const diagnostic = value as ScheduleRequestDiagnostic;
  if (!['upcoming', 'timeUp', 'followUp'].includes(diagnostic.kind)
    || !['ready', 'quiet', 'empty-content', 'invalid-json', 'invalid-schema',
      'http-error', 'network-error', 'aborted'].includes(diagnostic.outcome)
    || [diagnostic.referenceTime, diagnostic.preparationStartedAt, diagnostic.finishedAt]
      .some(time => safeTokenCount(time) === null)) return undefined;
  return {
    ...(typeof diagnostic.occurrenceId === 'string' && /^[a-zA-Z0-9:._-]{1,200}$/.test(diagnostic.occurrenceId)
      ? { occurrenceId: diagnostic.occurrenceId } : {}),
    kind: diagnostic.kind, referenceTime: diagnostic.referenceTime,
    preparationStartedAt: diagnostic.preparationStartedAt, finishedAt: diagnostic.finishedAt,
    outcome: diagnostic.outcome,
    ...(safeTokenCount(diagnostic.responseReceivedAt) === null ? {} : { responseReceivedAt: diagnostic.responseReceivedAt }),
    ...(['fetch', 'xhr'].includes(diagnostic.transport ?? '') ? { transport: diagnostic.transport } : {}),
    ...(safeTokenCount(diagnostic.headersReceivedAt) === null ? {} : { headersReceivedAt: diagnostic.headersReceivedAt }),
    ...(safeTokenCount(diagnostic.firstContentAt) === null ? {} : { firstContentAt: diagnostic.firstContentAt }),
    ...(safeTokenCount(diagnostic.responseCompletedAt) === null ? {} : { responseCompletedAt: diagnostic.responseCompletedAt }),
    ...(safeTokenCount(diagnostic.responseChars) === null ? {} : { responseChars: diagnostic.responseChars }),
    ...(Number.isInteger(diagnostic.httpStatus) && diagnostic.httpStatus! >= 100 && diagnostic.httpStatus! <= 599
      ? { httpStatus: diagnostic.httpStatus } : {}),
  };
}

function readRecord(value: unknown): PromptCacheMetricRecord | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<PromptCacheMetricRecord>;
  if (typeof record.contextProfile !== 'string' || typeof record.contextSource !== 'string') return null;
  const promptTokens = safeNumber(record.promptTokens, -1);
  const createdAt = safeNumber(record.createdAt, -1);
  if (promptTokens < 0 || createdAt < 0) return null;
  return {
    breakdown: record.breakdown,
    contextProfile: record.contextProfile,
    contextSource: record.contextSource,
    createdAt,
    hitRate: safeNullableNumber(record.hitRate),
    hitTokens: safeNullableNumber(record.hitTokens),
    id: typeof record.id === 'string' ? record.id : `metric-${createdAt}`,
    missTokens: safeNullableNumber(record.missTokens),
    model: typeof record.model === 'string' ? record.model : undefined,
    ...(record.channel === undefined ? {} : { channel: ['deepseek', 'siliconflow', 'other', 'unknown'].includes(record.channel)
      ? record.channel : 'unknown' as const }),
    ...(record.completionTokens === undefined ? {} : { completionTokens: safeTokenCount(record.completionTokens) }),
    ...(safeTokenCount(record.requestStartedAt) === null ? {} : { requestStartedAt: record.requestStartedAt }),
    ...(readCacheUsageSource(record.cacheUsageSource) ? { cacheUsageSource: readCacheUsageSource(record.cacheUsageSource) } : {}),
    ...(readRequestPrefixDiagnostic(record.requestPrefix) ? { requestPrefix: readRequestPrefixDiagnostic(record.requestPrefix) } : {}),
    scheduleRequest: record.contextSource === 'schedule.companion' ? readScheduleRequestDiagnostic(record.scheduleRequest) : undefined,
    ...(record.stablePrefixVersion === 2 ? { stablePrefixVersion: 2 as const } : {}),
    promptTokens,
    stablePrefixChanged: record.stablePrefixChanged === true,
    stablePrefixFingerprint: typeof record.stablePrefixFingerprint === 'string' ? record.stablePrefixFingerprint : undefined,
    stablePrefixTokens: safeNumber(record.stablePrefixTokens, 0),
    tokenSource: record.tokenSource === 'api' ? 'api' : record.tokenSource === 'unknown' ? 'unknown' : 'estimate',
  };
}

async function loadPromptCacheMetricRecords() {
  const raw = await AsyncStorage.getItem(PROMPT_CACHE_METRICS_KEY);
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('模型用量统计格式无法读取。');
  const records = parsed.map(readRecord);
  if (records.some(record => record === null)) throw new Error('模型用量统计包含无法读取的记录。');
  return records as PromptCacheMetricRecord[];
}

async function savePromptCacheMetricRecords(records: PromptCacheMetricRecord[]) {
  await AsyncStorage.setItem(PROMPT_CACHE_METRICS_KEY, JSON.stringify(records));
}

function trimPromptCacheMetricRecords(records: PromptCacheMetricRecord[], now = Date.now()) {
  const cutoff = now - PROMPT_CACHE_METRIC_RETENTION_MS;
  return records
    .filter((record) => record.createdAt >= cutoff)
    .sort((left, right) => left.createdAt - right.createdAt)
    .slice(-MAX_PROMPT_CACHE_METRIC_RECORDS);
}

export function prunePromptCacheMetrics() {
  return writeMetrics(async () => {
    const records = trimPromptCacheMetricRecords(await loadPromptCacheMetricRecords());
    await savePromptCacheMetricRecords(records);
    return records.length;
  });
}

export async function clearPromptCacheMetricsForTests() {
  await writeMetrics(() => AsyncStorage.removeItem(PROMPT_CACHE_METRICS_KEY));
}

export function recordPromptCacheMetric(input: PromptCacheMetricInput) {
  const createdAt = input.createdAt ?? Date.now();
  return writeMetrics(() => appendPromptCacheMetric(input, createdAt));
}

async function appendPromptCacheMetric(input: PromptCacheMetricInput, createdAt: number) {
  const records = await loadPromptCacheMetricRecords();
  const previous = [...records]
    .reverse()
    .find((record) =>
      record.contextSource === input.contextSource
      && record.model === input.model
      && record.channel === input.channel
      && record.stablePrefixVersion === input.stablePrefixVersion
      && !!record.stablePrefixFingerprint
    );
  const stablePrefixChanged = input.stablePrefixChanged
    ?? Boolean(
      previous?.stablePrefixFingerprint
      && input.stablePrefixFingerprint
      && previous.stablePrefixFingerprint !== input.stablePrefixFingerprint,
    );
  const next: PromptCacheMetricRecord = {
    breakdown: input.breakdown,
    contextProfile: input.contextProfile,
    contextSource: input.contextSource,
    createdAt,
    hitRate: input.hitRate,
    hitTokens: input.hitTokens,
    id: input.id ?? `pcm-${createdAt}-${Math.random().toString(36).slice(2, 8)}`,
    missTokens: input.missTokens,
    model: input.model,
    ...(input.channel === undefined ? {} : { channel: input.channel }),
    ...(input.completionTokens === undefined ? {} : { completionTokens: input.completionTokens }),
    ...(input.requestStartedAt === undefined ? {} : { requestStartedAt: input.requestStartedAt }),
    ...(readCacheUsageSource(input.cacheUsageSource) ? { cacheUsageSource: readCacheUsageSource(input.cacheUsageSource) } : {}),
    ...(readRequestPrefixDiagnostic(input.requestPrefix) ? { requestPrefix: readRequestPrefixDiagnostic(input.requestPrefix) } : {}),
    scheduleRequest: input.contextSource === 'schedule.companion' ? readScheduleRequestDiagnostic(input.scheduleRequest) : undefined,
    ...(input.stablePrefixVersion === undefined ? {} : { stablePrefixVersion: input.stablePrefixVersion }),
    promptTokens: input.promptTokens,
    stablePrefixChanged,
    stablePrefixFingerprint: input.stablePrefixFingerprint,
    stablePrefixTokens: input.stablePrefixTokens,
    tokenSource: input.tokenSource,
  };
  await savePromptCacheMetricRecords(trimPromptCacheMetricRecords([...records.filter(record => record.id !== next.id), next], createdAt));
  return next;
}

export async function recordPromptCacheMetricFromResponseUsage(options: {
  breakdown?: PromptTokenBreakdown;
  contextProfile: PromptContextProfile | (string & {});
  contextSource: PromptCacheContextSource;
  messages?: OpenAiCompatibleRequestMessage[];
  model?: string;
  baseUrl?: string;
  requestStartedAt?: number;
  stablePrefixText?: string;
  usage?: PromptCacheUsageLike | null;
}) {
  const fallbackPromptTokens = options.messages ? estimateApiMessagesTokens(options.messages) : 0;
  const cacheUsage = extractPromptCacheUsageFromResponseUsage(options.usage, fallbackPromptTokens);
  const stablePrefixText = options.stablePrefixText
    ?? options.messages?.find((message) => message.role === 'system')?.content
    ?? '';
  if (options.messages?.length) {
    recordPromptRuntimeSnapshot({
      contextProfile: String(options.contextProfile),
      contextSource: String(options.contextSource),
      messages: options.messages,
      model: options.model,
    });
  }
  return recordPromptCacheMetric({
    ...cacheUsage,
    breakdown: options.breakdown,
    contextProfile: options.contextProfile,
    contextSource: options.contextSource,
    model: options.model,
    channel: promptCacheChannelForBaseUrl(options.baseUrl),
    completionTokens: safeTokenCount(options.usage?.completion_tokens),
    requestStartedAt: options.requestStartedAt,
    cacheUsageSource: cacheUsageSource(options.usage),
    stablePrefixVersion: 2,
    stablePrefixFingerprint: stablePrefixText ? fingerprintPromptText(`${options.model ?? ''}\n${stablePrefixText}`) : undefined,
    stablePrefixTokens: stablePrefixText ? estimateTextTokens(stablePrefixText) : 0,
    tokenSource: safeTokenCount(options.usage?.prompt_tokens) !== null ? 'api' : options.messages ? 'estimate' : 'unknown',
  });
}

/** Numeric observation of one actual fetch; it never controls admission or response parsing. */
export function beginPromptCacheMetric(options: {
  breakdown?: PromptTokenBreakdown;
  contextProfile: PromptContextProfile | (string & {});
  contextSource: PromptCacheContextSource;
  connection: { id?: string; model: string; baseUrl: string };
  requestKind?: string;
  stablePrefixText?: string;
  now?: number;
}) {
  const requestStartedAt = options.now ?? Date.now();
  let usage: PromptCacheUsageLike | undefined;
  let finished = false;
  let completion: Promise<PromptCacheMetricRecord | undefined> | undefined;
  let requestPrefix: PromptRequestPrefixDiagnostic | undefined;
  return {
    observeSerializedRequest(body: string) {
      if (finished || requestPrefix) return;
      requestPrefix = observeSerializedRequest(body, [options.connection.id ?? '',
        options.connection.baseUrl.trim().replace(/\/+$/u, ''), options.connection.model.trim(),
        String(options.contextSource), String(options.contextProfile), options.requestKind ?? 'unknown']);
    },
    recordUsage(value: unknown) {
      if (!finished && value && typeof value === 'object' && !Array.isArray(value)) {
        const next = value as PromptCacheUsageLike;
        usage = { ...usage };
        for (const key of ['prompt_tokens', 'completion_tokens', 'prompt_cache_hit_tokens', 'prompt_cache_miss_tokens',
          'cached_tokens', 'cached_input_tokens', 'prompt_tokens_details'] as const) {
          if (Object.prototype.hasOwnProperty.call(next, key)) Object.assign(usage, { [key]: next[key] });
        }
      }
    },
    finish(scheduleRequest?: ScheduleRequestDiagnostic) {
      if (finished) return completion!;
      finished = true;
      const prefix = options.stablePrefixText ?? '';
      completion = recordPromptCacheMetric({
        ...extractPromptCacheUsageFromResponseUsage(usage),
        breakdown: options.breakdown,
        contextProfile: options.contextProfile, contextSource: options.contextSource,
        channel: promptCacheChannelForBaseUrl(options.connection.baseUrl), model: options.connection.model.trim(),
        completionTokens: safeTokenCount(usage?.completion_tokens), requestStartedAt,
        cacheUsageSource: cacheUsageSource(usage), requestPrefix,
        scheduleRequest: readScheduleRequestDiagnostic(scheduleRequest),
        stablePrefixVersion: 2,
        stablePrefixTokens: prefix ? estimateTextTokens(prefix) : 0,
        stablePrefixFingerprint: prefix ? fingerprintPromptText(`${options.connection.model.trim()}\n${prefix}`) : undefined,
        tokenSource: safeTokenCount(usage?.prompt_tokens) === null ? 'unknown' : 'api',
      }).catch(() => undefined);
      return completion;
    },
  };
}

export async function loadPromptCacheMetricsSummary(options: { sinceMs?: number } = {}) {
  await metricWrites;
  const generatedAt = Date.now();
  const sinceMs = options.sinceMs ?? generatedAt - 24 * 60 * 60 * 1000;
  const records = (await loadPromptCacheMetricRecords()).filter((record) => record.createdAt >= sinceMs);
  const groupsByKey = new Map<string, PromptCacheMetricsGroup>();
  const summary: PromptCacheMetricsSummary = {
    averageHitRate: null,
    generatedAt,
    groups: [],
    recentScheduleRequests: records.filter(record => record.contextSource === 'schedule.companion')
      .sort((left, right) => right.createdAt - left.createdAt).slice(0, 5),
    completionTokens: 0,
    knownPromptRequestCount: 0,
    knownOutputRequestCount: 0,
    knownPrefixRequestCount: 0,
    hitTokens: 0,
    knownCacheRequestCount: 0,
    missTokens: 0,
    promptTokens: 0,
    requestCount: records.length,
    sinceMs,
    stablePrefixChangedCount: 0,
  };
  for (const record of records) {
    const knownCache = record.hitTokens !== null && record.missTokens !== null;
    const knownPrompt = record.tokenSource === 'api';
    const knownOutput = typeof record.completionTokens === 'number';
    const knownPrefix = record.stablePrefixVersion === 2 && !!record.stablePrefixFingerprint;
    summary.promptTokens += knownPrompt ? record.promptTokens : 0;
    summary.completionTokens += record.completionTokens ?? 0;
    summary.knownPromptRequestCount += knownPrompt ? 1 : 0;
    summary.knownOutputRequestCount += knownOutput ? 1 : 0;
    summary.knownPrefixRequestCount += knownPrefix ? 1 : 0;
    summary.hitTokens += knownCache ? record.hitTokens! : 0;
    summary.missTokens += knownCache ? record.missTokens! : 0;
    summary.knownCacheRequestCount += knownCache ? 1 : 0;
    summary.stablePrefixChangedCount += knownPrefix && record.stablePrefixChanged ? 1 : 0;
    const channel = record.channel ?? 'unknown';
    const key = JSON.stringify([channel, record.model ?? '', record.contextSource, record.contextProfile]);
    const group = groupsByKey.get(key) ?? {
      averageHitRate: null,
      contextProfile: String(record.contextProfile),
      contextSource: String(record.contextSource),
      channel,
      model: record.model,
      completionTokens: 0,
      knownPromptRequestCount: 0,
      knownOutputRequestCount: 0,
      knownPrefixRequestCount: 0,
      hitTokens: 0,
      knownCacheRequestCount: 0,
      missTokens: 0,
      promptTokens: 0,
      requestCount: 0,
      stablePrefixChangedCount: 0,
      stablePrefixTokens: 0,
    };
    group.promptTokens += knownPrompt ? record.promptTokens : 0;
    group.completionTokens += record.completionTokens ?? 0;
    group.knownPromptRequestCount += knownPrompt ? 1 : 0;
    group.knownOutputRequestCount += knownOutput ? 1 : 0;
    group.knownPrefixRequestCount += knownPrefix ? 1 : 0;
    group.hitTokens += knownCache ? record.hitTokens! : 0;
    group.missTokens += knownCache ? record.missTokens! : 0;
    group.knownCacheRequestCount += knownCache ? 1 : 0;
    group.requestCount += 1;
    if ((record.cacheUsageSource || record.requestPrefix)
      && (!group.latestRequestDiagnostic || record.createdAt >= group.latestRequestDiagnostic.createdAt)) {
      group.latestRequestDiagnostic = { createdAt: record.createdAt,
        cacheUsageSource: record.cacheUsageSource, requestPrefix: record.requestPrefix };
    }
    group.stablePrefixChangedCount += knownPrefix && record.stablePrefixChanged ? 1 : 0;
    group.stablePrefixTokens = Math.max(group.stablePrefixTokens, knownPrefix ? record.stablePrefixTokens : 0);
    groupsByKey.set(key, group);
  }
  const totalKnown = summary.hitTokens + summary.missTokens;
  summary.averageHitRate = totalKnown > 0 ? summary.hitTokens / totalKnown : null;
  summary.groups = [...groupsByKey.values()]
    .map((group) => {
      const known = group.hitTokens + group.missTokens;
      return {
        ...group,
        averageHitRate: known > 0 ? group.hitTokens / known : null,
      };
    })
    .sort((left, right) => right.missTokens - left.missTokens || right.promptTokens - left.promptTokens);
  return summary;
}

