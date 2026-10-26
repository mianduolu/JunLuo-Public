import {
  aiLogicalConfigStorageBridge as AsyncStorage,
} from '../sync/syncAiLogicalConfigStorageBridge';

import { loadAiConfigPreferencesSnapshot } from '../ai/AiConfigPreferences';
import { buildChatModelParameterPayload, buildOpenAiCompatibilityPayload } from '../ai/modelParameters';
import type { AiConnection } from '../ai/types';
import { beginPromptCacheMetric } from '../ai/promptCacheMetrics';
import { stableMemoryHash } from './memoryAtomicity';
import type { MemoryRecallItem } from './memoryStore';

export type MemoryRerankerMode = 'manual' | 'conditional' | 'always';

export type MemoryRerankerSettings = {
  enabled: boolean;
  mode: MemoryRerankerMode;
  candidateLimit: number;
  timeoutMs: number;
  updatedAt: number;
};

export type MemoryRerankerStatus = {
  at: number;
  detail: string;
  kind: 'idle' | 'skipped' | 'reranked' | 'fallback' | 'missingConnection';
};

type RerankerCallOptions = {
  apiKey: string;
  connection: AiConnection;
  maxResults: number;
  query: string;
  timeoutMs: number;
  items: MemoryRecallItem[];
  signal?: AbortSignal;
};

type RerankerPayload = {
  selectedIds?: unknown;
  reasonById?: unknown;
};

type RerankerResult = {
  items: MemoryRecallItem[];
  used: boolean;
};

const SETTINGS_KEY = 'junluo.memoryReranker.settings';
const DEFAULT_CANDIDATE_LIMIT = 12;
const DEFAULT_TIMEOUT_MS = 2500;
const CACHE_TTL_MS = 10 * 60 * 1000;

export const defaultMemoryRerankerSettings: MemoryRerankerSettings = {
  enabled: false,
  mode: 'conditional',
  candidateLimit: DEFAULT_CANDIDATE_LIMIT,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  updatedAt: 0,
};

let lastStatus: MemoryRerankerStatus = {
  at: 0,
  detail: '未触发',
  kind: 'idle',
};

const rerankCache = new Map<string, { at: number; ids: string[] }>();

function normalizeSettings(settings?: Partial<MemoryRerankerSettings> | null): MemoryRerankerSettings {
  return {
    enabled: settings?.enabled === true,
    mode: settings?.mode === 'manual' || settings?.mode === 'always' ? settings.mode : 'conditional',
    candidateLimit: Math.max(8, Math.min(20, Math.round(settings?.candidateLimit ?? DEFAULT_CANDIDATE_LIMIT))),
    timeoutMs: Math.max(1200, Math.min(10000, Math.round(settings?.timeoutMs ?? DEFAULT_TIMEOUT_MS))),
    updatedAt: Number.isFinite(settings?.updatedAt) ? Number(settings?.updatedAt) : 0,
  };
}

function updateStatus(kind: MemoryRerankerStatus['kind'], detail: string) {
  lastStatus = { at: Date.now(), detail, kind };
}

export function getLastMemoryRerankerStatus() {
  return lastStatus;
}

export async function loadMemoryRerankerSettings(options: { strict?: boolean } = {}) {
  try {
    const saved = await AsyncStorage.getItem(SETTINGS_KEY);
    return normalizeSettings(saved !== null && (options.strict || saved)
      ? JSON.parse(saved) as Partial<MemoryRerankerSettings> : null);
  } catch (error) {
    if (options.strict) throw error;
    return defaultMemoryRerankerSettings;
  }
}

export async function saveMemoryRerankerSettings(settings: MemoryRerankerSettings) {
  const normalized = normalizeSettings({ ...settings, updatedAt: Date.now() });
  await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(normalized));
  return normalized;
}

function readAssistantContent(payload: {
  choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
}) {
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) return content.map((part) => part.text ?? '').join('').trim();
  return '';
}

function parseJsonPayload(content: string): RerankerPayload | null {
  const trimmed = content.trim();
  const jsonText = trimmed.startsWith('{') ? trimmed : trimmed.match(/\{[\s\S]*\}/)?.[0];
  if (!jsonText) return null;
  try {
    return JSON.parse(jsonText) as RerankerPayload;
  } catch {
    return null;
  }
}

function compactMemoryItem(item: MemoryRecallItem) {
  const { memory } = item;
  const compactContent = memory.content.length > 180 ? `${memory.content.slice(0, 180)}...` : memory.content;
  return {
    id: memory.id,
    title: memory.title,
    domain: memory.domain,
    reason: item.reason,
    score: typeof item.score === 'number' ? Number(item.score.toFixed(3)) : undefined,
    tags: memory.tags.slice(0, 6),
    recallCues: memory.recallCues.slice(0, 6),
    content: compactContent,
  };
}

function makeCacheKey(query: string, items: MemoryRecallItem[], connection: AiConnection, maxResults: number) {
  return [
    connection.id,
    connection.model,
    connection.baseUrl,
    maxResults,
    query.trim(),
    stableMemoryHash(JSON.stringify(items.map(compactMemoryItem))),
  ].join('\n');
}

function applySelectedIds(items: MemoryRecallItem[], ids: string[], maxResults: number): MemoryRecallItem[] | null {
  const byId = new Map(items.map((item) => [item.memory.id, item]));
  const selected = [...new Set(ids)]
    .map((id) => byId.get(id))
    .filter((item): item is MemoryRecallItem => Boolean(item));
  const minimum = Math.min(4, items.length, maxResults);
  if (selected.length < minimum) return null;
  return selected.slice(0, maxResults).map((item) => ({
    ...item,
    sources: item.sources?.includes('reranker') ? item.sources : [...(item.sources ?? []), 'reranker'],
  }));
}

async function callReranker({ apiKey, connection, items, maxResults, query, timeoutMs, signal }: RerankerCallOptions) {
  if (signal?.aborted) throw Object.assign(new Error('memory-reranker-cancelled'), { name: 'AbortError' });
  const baseUrl = connection.baseUrl.trim().replace(/\/+$/, '');
  const controller = new AbortController();
  let rejectStopped!: (error: Error) => void;
  const stopped = new Promise<never>((_, reject) => { rejectStopped = reject; });
  const stop = () => {
    rejectStopped(Object.assign(new Error('memory-reranker-stopped'), { name: 'AbortError' }));
    controller.abort();
  };
  signal?.addEventListener('abort', stop, { once: true });
  const timeoutId = setTimeout(stop, timeoutMs);
  const candidates = items.map(compactMemoryItem);
  const messages = [
    {
      role: 'system',
      content: [
        '【记忆召回重排】',
        '当前任务：从候选记忆里选出最适合本轮使用的记忆。',
        '这不是给小仓鼠的回复。',
        '只能从候选记忆中选择。',
        '选择标准：优先贴近小仓鼠本轮真正问到、提到或需要被记住的内容。',
        '事实纠错、原话追溯、步骤追问时，优先有证据价值的记忆。',
        '陪伴和低精力场景只挑最贴近的一条，不列清单。',
        '背景记忆可以影响语气，不一定要说出口。',
        '只返回严格 JSON，不输出解释、Markdown 或代码块。',
        `格式：{"selectedIds":["id1"],"reasonById":{"id1":"短理由"}}，selectedIds 数量 4 到 ${maxResults}，候选不足时可少于 4。`,
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        query,
        maxResults,
        candidates,
      }),
    },
  ];

  let cacheMetric: ReturnType<typeof beginPromptCacheMetric> | undefined;
  try {
    return await Promise.race([stopped, (async () => {
      const requestUrl = `${baseUrl}/chat/completions`;
      const request: RequestInit = {
        body: JSON.stringify({
          model: connection.model.trim(),
          ...buildOpenAiCompatibilityPayload(connection),
          messages,
          ...buildChatModelParameterPayload(connection.modelParameters),
          max_tokens: 260,
          temperature: 0.1,
        }),
        headers: {
          Authorization: `Bearer ${apiKey.trim()}`,
          'Content-Type': 'application/json',
        },
        method: 'POST',
        signal: controller.signal,
      };
      cacheMetric = beginPromptCacheMetric({ contextProfile: 'memory-organizer', contextSource: 'memory.rerank', connection });
      const response = await fetch(requestUrl, request);
      if (controller.signal.aborted) return [];
      const payload = await response.json().catch(() => ({}));
      cacheMetric.recordUsage(payload?.usage);
      if (controller.signal.aborted) return [];
      if (!response.ok) {
        throw new Error(payload?.error?.message || `服务返回错误状态 ${response.status}`);
      }
      const parsed = parseJsonPayload(readAssistantContent(payload));
      const selectedIds = Array.isArray(parsed?.selectedIds)
        ? parsed.selectedIds.filter((id): id is string => typeof id === 'string')
        : [];
      return selectedIds;
    })()]);
  } finally {
    cacheMetric?.finish();
    clearTimeout(timeoutId);
    signal?.removeEventListener('abort', stop);
  }
}

export async function testMemoryRerankerConnection(connection?: AiConnection, apiKey?: string) {
  if (!connection || !apiKey?.trim()) {
    return { ok: false, detail: '请先选择重排连接，并填写这个连接的 API Key。' };
  }
  const fakeItems: MemoryRecallItem[] = [
    {
      memory: {
        id: 'app-memory',
        title: 'APP 开发',
        content: '小仓鼠正在修 APP 的记忆召回功能。',
        domain: '经历',
        tags: ['APP', '开发'],
        recallCues: ['修功能'],
        importance: 6,
        valence: 0.6,
        arousal: 0.4,
        pinned: false,
        anchor: false,
        type: 'dynamic',
        tier: 'working',
        semanticType: 'event',
        stability: 0.5,
        resolved: false,
        digested: false,
        protected: false,
        activationCount: 0,
        lastActiveAt: Date.now(),
        sourceType: 'manual',
        confirmationLevel: 'automatic',
        sourceTraceMode: 'legacy_range',
        atomicKind: 'unknown',
        extractionBasis: 'unknown',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      reason: 'direct',
      score: 0.9,
      sources: ['fts'],
    },
    {
      memory: {
        id: 'drink-memory',
        title: '冰饮料偏好',
        content: '小仓鼠不喜欢冰饮料。',
        domain: '喜好',
        tags: ['饮料'],
        recallCues: ['冰饮料'],
        importance: 5,
        valence: 0.4,
        arousal: 0.2,
        pinned: false,
        anchor: false,
        type: 'dynamic',
        tier: 'working',
        semanticType: 'preference',
        stability: 0.5,
        resolved: false,
        digested: false,
        protected: false,
        activationCount: 0,
        lastActiveAt: Date.now(),
        sourceType: 'manual',
        confirmationLevel: 'automatic',
        sourceTraceMode: 'legacy_range',
        atomicKind: 'unknown',
        extractionBasis: 'unknown',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      reason: 'text',
      score: 0.2,
      sources: ['cjk'],
    },
  ];

  try {
    const ids = await callReranker({
      apiKey,
      connection,
      items: fakeItems,
      maxResults: 4,
      query: '我要修 APP 的记忆召回功能',
      timeoutMs: 8000,
    });
    if (!ids.includes('app-memory')) {
      return { ok: false, detail: '连接可访问，但重排返回格式不符合预期。' };
    }
    updateStatus('reranked', '连接测试成功。');
    return { ok: true, detail: '重排连接测试成功，模型能返回可用的记忆 ID。' };
  } catch (error) {
    const detail = error instanceof Error && error.name === 'AbortError'
      ? '重排连接测试超时，请检查网络或服务地址。'
      : '重排连接测试失败，请检查 API Key、Base URL 或模型名称。';
    updateStatus('fallback', detail);
    return { ok: false, detail };
  }
}

export function skipMemoryReranking(settings: MemoryRerankerSettings, itemCount: number) {
  if (!settings.enabled) {
    updateStatus('skipped', '重排未启用。');
    return true;
  }
  if (settings.mode === 'manual') {
    updateStatus('skipped', '重排处于手动模式，本轮未自动触发。');
    return true;
  }
  if (settings.mode === 'conditional' && itemCount <= 8) {
    updateStatus('skipped', '候选记忆不多，本轮使用本地排序。');
    return true;
  }
  return false;
}

export async function rerankMemoryCandidates(
  query: string,
  items: MemoryRecallItem[],
  maxResults: number,
  signal?: AbortSignal,
  suppliedSettings?: MemoryRerankerSettings,
): Promise<RerankerResult> {
  if (signal?.aborted) return { items, used: false };
  const settings = suppliedSettings ?? await loadMemoryRerankerSettings();
  if (signal?.aborted) return { items, used: false };
  if (skipMemoryReranking(settings, items.length)) return { items, used: false };

  const snapshot = await loadAiConfigPreferencesSnapshot();
  if (signal?.aborted) return { items, used: false };
  const connection = snapshot.memoryRerankerConnection;
  const apiKey = snapshot.memoryRerankerKey;
  if (!connection || !apiKey.trim()) {
    updateStatus('missingConnection', '未配置重排连接，本轮使用本地排序。');
    return { items, used: false };
  }

  const candidates = items.slice(0, settings.candidateLimit);
  const cacheKey = makeCacheKey(query, candidates, connection, maxResults);
  const cached = rerankCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    const applied = applySelectedIds(candidates, cached.ids, maxResults);
    if (applied) {
      updateStatus('reranked', '已使用短期缓存的重排结果。');
      return { items: applied, used: true };
    }
  }

  try {
    const selectedIds = await callReranker({
      apiKey,
      connection,
      items: candidates,
      maxResults,
      query,
      timeoutMs: settings.timeoutMs,
      signal,
    });
    if (signal?.aborted) return { items, used: false };
    const applied = applySelectedIds(candidates, selectedIds, maxResults);
    if (!applied) throw new Error('重排返回的有效记忆太少');
    rerankCache.set(cacheKey, { at: Date.now(), ids: selectedIds });
    updateStatus('reranked', `已重排 ${candidates.length} 条候选。`);
    return { items: applied, used: true };
  } catch {
    updateStatus('fallback', '重排失败或超时，本轮已回退本地排序。');
    return { items, used: false };
  }
}
