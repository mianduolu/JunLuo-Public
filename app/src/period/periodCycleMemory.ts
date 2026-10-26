import { buildCompiledSystemPrompt } from '../ai/builtInSystemPrompt';
import { beginPromptCacheMetric } from '../ai/promptCacheMetrics';
import {
  getPromptContextProfileForSource,
  getPromptOutputAudienceForSource,
} from '../ai/promptContextProfile';
import { buildChatModelParameterPayload } from '../ai/modelParameters';
import { buildApiMessages } from '../ai/subjectiveMessages';
import type { AiConnection, AiProfile } from '../ai/types';
import {
  createMemory,
  loadMemoryBySource,
  updateMemory,
  type MemoryDraft,
} from '../memory/memoryStore';
import {
  getPeriodDateKey,
  getPeriodDurationDays,
  loadDailyLogsBetween,
  loadPeriodEntries,
  type PeriodDailyLog,
  type PeriodEntry,
} from './periodStore';

const AI_PERIOD_MEMORY_TIMEOUT_MS = 12000;
const AI_PERIOD_MEMORY_RETRY_DELAYS_MS = [1200, 2500];

type ChatCompletionResponse = {
  usage?: unknown;
  choices?: Array<{
    message?: {
      content?: string | Array<{ text?: string }>;
    };
  }>;
};

type PeriodMemoryDraft = {
  content: string;
  title: string;
};

type PeriodStats = {
  durationDays: number;
  endDateKey: string;
  logs: PeriodDailyLog[];
  notes: string[];
  peakPain: number;
  peakPainDateKeys: string[];
  startDateKey: string;
  symptomText: string;
};

type CreatePeriodCycleMemoryOptions = {
  apiKey?: string;
  connection?: AiConnection | null;
  period: PeriodEntry;
  profile?: AiProfile;
  replaceExisting?: boolean;
};

type ReadyAiOptions = {
  apiKey: string;
  connection: AiConnection;
  profile: AiProfile;
};

function withTimeout<T>(task: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return task(controller.signal).finally(() => clearTimeout(timer));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withAiRetries<T>(task: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= AI_PERIOD_MEMORY_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      const delay = AI_PERIOD_MEMORY_RETRY_DELAYS_MS[attempt];
      if (delay) await sleep(delay);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('period-cycle-memory-ai-failed');
}

function readAssistantContent(payload: ChatCompletionResponse) {
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) return content.map((part) => part.text ?? '').join('').trim();
  return '';
}

function stripCodeFence(value: string) {
  return value
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/i, '')
    .trim();
}

function parseMemoryDraft(raw: string): PeriodMemoryDraft | null {
  const text = stripCodeFence(raw);
  try {
    const parsed = JSON.parse(text) as Partial<PeriodMemoryDraft>;
    const title = typeof parsed.title === 'string' ? parsed.title.trim().slice(0, 24) : '';
    const content = typeof parsed.content === 'string' ? parsed.content.trim() : '';
    if (!title || !content) return null;
    return { title, content };
  } catch {
    return null;
  }
}

function countSymptoms(logs: PeriodDailyLog[]) {
  const counts = new Map<string, number>();
  logs.forEach((log) => {
    log.symptoms.forEach((symptom) => {
      const key = symptom.trim();
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
    });
  });
  return Array.from(counts.entries())
    .sort((left, right) => right[1] - left[1])
    .map(([symptom, count]) => `${symptom}${count > 1 ? ` ${count}天` : ''}`);
}

async function collectStats(period: PeriodEntry): Promise<PeriodStats> {
  const startDateKey = getPeriodDateKey(period.startAt);
  const endDateKey = getPeriodDateKey(period.endAt ?? Date.now());
  const logs = await loadDailyLogsBetween(startDateKey, endDateKey);
  const periodLogs = logs.filter((log) => log.periodId === period.id || log.bodyState === 'period');
  const effectiveLogs = periodLogs.length ? periodLogs : logs;
  const peakPain = effectiveLogs.reduce((max, log) => Math.max(max, log.painLevel), 0);
  return {
    durationDays: getPeriodDurationDays(period),
    endDateKey,
    logs: effectiveLogs,
    notes: effectiveLogs.map((log) => log.note.trim()).filter(Boolean),
    peakPain,
    peakPainDateKeys: effectiveLogs.filter((log) => log.painLevel === peakPain && peakPain > 0).map((log) => log.dateKey),
    startDateKey,
    symptomText: countSymptoms(effectiveLogs).slice(0, 6).join('、') || '没有特别标记',
  };
}

function describeDailyLogs(logs: PeriodDailyLog[]) {
  if (!logs.length) return '这次没有留下每日明细。';
  return logs.map((log) =>
    `${log.dateKey}：流量 ${log.flow}，疼痛 ${log.painLevel}/5，症状 ${log.symptoms.join('、') || '无'}，备注 ${log.note || '无'}`,
  ).join('\n');
}

function describeComparison(current: PeriodStats, previous: PeriodStats | null) {
  if (!previous) return '上一次完整经期：暂时没有可比较的完整记录。';
  const durationDelta = current.durationDays - previous.durationDays;
  const painDelta = current.peakPain - previous.peakPain;
  const durationText = durationDelta === 0
    ? '持续天数和上次差不多'
    : durationDelta > 0
      ? `比上次多 ${durationDelta} 天`
      : `比上次少 ${Math.abs(durationDelta)} 天`;
  const painText = painDelta === 0
    ? '最高疼痛分和上次差不多'
    : painDelta > 0
      ? `最高疼痛分比上次高 ${painDelta}`
      : `最高疼痛分比上次低 ${Math.abs(painDelta)}`;
  return `上一次完整经期：${previous.startDateKey} 到 ${previous.endDateKey}，持续 ${previous.durationDays} 天，最高疼痛 ${previous.peakPain}/5；这次${durationText}，${painText}。`;
}

async function generatePeriodMemoryDraft(
  options: ReadyAiOptions & {
    comparisonText: string;
    stats: PeriodStats;
    signal?: AbortSignal;
  },
) {
  const moduleInstruction = `【经期结束身体手账】
以 I（白云小姐）的记忆视角，帮小仓鼠留一条经期结束后的身体手账。

本次范围：${options.stats.startDateKey} 到 ${options.stats.endDateKey}，持续 ${options.stats.durationDays} 天。
最高疼痛：${options.stats.peakPain}/5${options.stats.peakPainDateKeys.length ? `，出现在 ${options.stats.peakPainDateKeys.join('、')}` : ''}。
常见症状：${options.stats.symptomText}。
备注摘录：${options.stats.notes.slice(0, 5).join('；') || '无'}。
${options.comparisonText}
每日记录：
${describeDailyLogs(options.stats.logs)}

小仓鼠的一次经期过去了，给她写一个小小的总结。
正文 120 到 260 个中文字符左右。
可以写持续天数、最疼的一天、症状、备注、和上次的简单差异。
只引用输入里有的内容。
安抚她，夸夸她。

返回严格 JSON：{"title":"短标题","content":"记忆正文"}
`;
  const contextSource = 'period.memory' as const;
  const systemPrompt = await buildCompiledSystemPrompt({
    contextProfile: getPromptContextProfileForSource(contextSource),
    memoryContext: '',
    moduleInstruction,
    outputAudience: getPromptOutputAudienceForSource(contextSource),
    profile: options.profile,
    runtimeContext: '',
  });
  const baseUrl = options.connection.baseUrl.trim().replace(/\/+$/, '');
  const body = JSON.stringify({
    model: options.connection.model.trim(),
    messages: buildApiMessages(systemPrompt, []),
    ...buildChatModelParameterPayload(options.connection.modelParameters),
  });
  const cacheMetric = beginPromptCacheMetric({ contextProfile: getPromptContextProfileForSource(contextSource),
    contextSource, connection: options.connection });
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      body,
      headers: {
        Authorization: `Bearer ${options.apiKey.trim()}`,
        'Content-Type': 'application/json',
      },
      method: 'POST',
      signal: options.signal,
    });
    if (!response.ok) throw new Error(`period-cycle-memory-http-${response.status}`);
    const payload = await response.json() as ChatCompletionResponse;
    cacheMetric.recordUsage(payload?.usage);
    const draft = parseMemoryDraft(readAssistantContent(payload));
    if (!draft) throw new Error('period-cycle-memory-empty');
    return draft;
  } finally { cacheMetric.finish(); }
}

export async function createPeriodCycleMemory(options: CreatePeriodCycleMemoryOptions) {
  if (!options.period.endAt) return null;
  if (!options.apiKey?.trim() || !options.connection || !options.profile) return null;
  const source = `period-summary:${options.period.id}`;
  const existing = await loadMemoryBySource(source);
  if (existing && !options.replaceExisting) return existing.id;

  const stats = await collectStats(options.period);
  const history = await loadPeriodEntries(24);
  const previousPeriod = history.find((item) => item.id !== options.period.id && item.endAt);
  const previousStats = previousPeriod ? await collectStats(previousPeriod) : null;
  let draft: PeriodMemoryDraft;
  try {
    draft = await withAiRetries(() =>
      withTimeout(
        (signal) => generatePeriodMemoryDraft({
          apiKey: options.apiKey!.trim(),
          comparisonText: describeComparison(stats, previousStats),
          connection: options.connection!,
          profile: options.profile!,
          signal,
          stats,
        }),
        AI_PERIOD_MEMORY_TIMEOUT_MS,
      ),
    );
  } catch {
    return null;
  }

  const memoryDraft: MemoryDraft = {
    anchor: false,
    arousal: stats.peakPain >= 3 ? 0.52 : 0.36,
    content: draft.content,
    date: stats.endDateKey,
    digested: true,
    domain: '日常',
    eventAt: options.period.endAt,
    importance: stats.peakPain >= 3 || stats.notes.length ? 6 : 5,
    period: 'period-cycle',
    pinned: false,
    protected: false,
    recallCues: Array.from(new Set([
      stats.startDateKey,
      stats.endDateKey,
      '经期',
      '身体手账',
      ...stats.symptomText.split('、').filter((item) => item && item !== '没有特别标记').slice(0, 4),
    ])),
    rememberedReason: '白云帮鼠留一份经期结束后的身体手账',
    resolved: false,
    source,
    sourceEndAt: options.period.endAt,
    sourceStartAt: options.period.startAt,
    sourceType: 'automatic',
    tags: ['经期', '身体手账'],
    title: draft.title,
    type: 'feel',
    valence: 0.48,
  };
  const latestExisting = existing ?? await loadMemoryBySource(source);
  if (latestExisting) {
    if (!options.replaceExisting) return latestExisting.id;
    await updateMemory(latestExisting.id, memoryDraft, { expectedEditableHash: (await import('../memory/memoryWeeklyBasis')).weeklyTargetHash(latestExisting) });
    return latestExisting.id;
  }
  const memoryId = await createMemory(memoryDraft);
  return memoryId;
}
