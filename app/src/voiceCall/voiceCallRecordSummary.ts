import { runScheduledAiCall } from '../ai/aiRuntimeScheduler';
import { beginPromptCacheMetric } from '../ai/promptCacheMetrics';
import {
  buildChatModelParameterPayload,
  buildOpenAiCompatibilityPayload,
} from '../ai/modelParameters';
import { isOfficialDeepSeekV4Connection } from '../ai/toolProviderCapabilities';
import type { AiConnection } from '../ai/types';
import { SUBJECTIVE_IDENTITY_PROTOCOL } from '../ai/subjectiveMessages';
import { buildConversationMemoryOrganizerPrompt, parseCandidates, type MemoryDraftWithSourceIds } from '../memory/memoryOrganizer';
import { validateUnderstandingCandidates, validateUnderstandingMaterials, type UnderstandingMaterials } from '../memory/memoryUnderstanding';
import { validateVoiceCallMaterialBindings } from './voiceCallMemorySource';
import { validateConversationMemoryCandidates } from '../memory/memoryEpisodeReview';
import { validateCurrentStateCandidates } from '../memory/memoryCurrentStateReview';
import { prepareVoiceCallMemoryBatch } from './voiceCallMemoryOrganization';
import type {
  VoiceCallIDelivery,
  VoiceCallMemoryCandidate,
  VoiceCallRecord,
} from './voiceCallRecord';

const VOICE_CALL_RECORD_SUMMARY_TIMEOUT_MS = 45_000;
const VOICE_CALL_RECORD_SUMMARY_MAX_TOKENS = 2048;

export const BAIYUN_VOICE_CALL_RECORD_PROMPT = `【刚刚的电话】

I 和 you 刚刚结束了一通电话。I 为这通电话留下一段小记，也挑出值得记住的内容。

【summary】

I 用一到三句话写下这通电话里真正谈到的事。

summary 采用 you 已经说清楚的话，以及 I 已经播放完成的回复。只显示在屏幕上的回复和播放时被打断的回复留在电话记录里，不写进 summary。

内容不足时，summary 返回空字符串。

【memoryCandidates】

I 从 you 已经说清楚的话里，挑出零到两件值得记住的事。

long_term：称呼、边界、约定、稳定偏好、重要经历，或以后仍然有用的事实。
small_note：最近的小事、日常、物品、食物、念头或在意点。
emotional_weather：近期会影响陪伴的状态或背景。

每条候选只写一件具体的事，并带上相关对象或原因。声音线索帮助 I 理解当时的情绪；候选的事实内容来自 you 已经说清楚的话。

最终只返回以下 JSON：

{
  "summary": "一到三句通话小记，或空字符串",
  "memoryCandidates": [
    {
      "title": "不超过24字",
      "content": "一句18到80字的完整短记忆",
      "domain": "相处/称呼/喜好/边界/经历/约定/日常/其他",
      "tags": ["标签"],
      "recallCues": ["2到6个具体想起词"],
      "importance": 1到10整数,
      "valence": 0到1,
      "arousal": 0到1,
      "suggestedAnchor": true或false,
      "suggestedAnchorKind": "name/boundary/relationship_rule/preference/promise/identity/other",
      "semanticType": "profile/preference/entity/event/pattern/other",
      "stability": 0到1,
      "confidence": 0到1,
      "atomicKind": "fact/preference/event/relationship_rule/relationship_change",
      "candidateKind": "long_term/small_note/emotional_weather",
      "rememberedReason": "12到60字，说明为什么值得留下"
    }
  ]
}`;

const directionLabels = {
  incoming: 'I 主动拨出',
  outgoing: 'you 主动拨入',
  test: '测试接通',
} as const;

const endReasonLabels = {
  'app-left': 'App 离开',
  'assistant-ended': 'I 结束',
  'duration-limit': '达到通话时长上限',
  'line-disconnected': '电话线断开',
  'user-hangup': 'you 挂断',
} as const;

const deliveryLabels: Record<VoiceCallIDelivery, '只显示' | '播放失败' | '播放完成' | '被打断'> = {
  completed: '播放完成',
  display_only: '只显示',
  failed: '播放失败',
  interrupted: '被打断',
  queued: '只显示',
  started: '被打断',
};

function formatDateTime(timestamp: number) {
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false });
}

function formatDuration(durationMs: number) {
  const seconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

export function buildVoiceCallRecordDynamicMaterial(record: VoiceCallRecord) {
  const turns = record.turns.map((turn) => turn.role === 'you'
    ? {
        role: 'you' as const,
        text: turn.text,
        emotionHint: turn.emotion?.hint ?? '暂无明显倾向',
      }
    : {
        role: 'I' as const,
        text: turn.text,
        delivery: deliveryLabels[turn.delivery],
      });
  return `【本次通话材料】

${JSON.stringify({
    direction: directionLabels[record.direction],
    startedAt: formatDateTime(record.startedAt),
    endedAt: formatDateTime(record.endedAt),
    duration: formatDuration(record.durationMs),
    endReason: endReasonLabels[record.endReason],
    unheardCount: record.unheardCount,
    turns,
  }, null, 2)}`;
}

type CompletionPayload = {
  usage?: unknown;
  choices?: Array<{ finish_reason?: string; message?: { content?: string | Array<{ text?: string }> | null } }>;
  error?: { message?: string };
};

function readCompletionText(payload: CompletionPayload) {
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => part.text ?? '').join('');
  return '';
}

function compactText(value: unknown, limit: number) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, limit);
}

function clamp(value: unknown, min: number, max: number, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.min(max, value))
    : fallback;
}

function stringList(value: unknown, limit: number, itemLimit = 24) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => compactText(item, itemLimit))
    .filter(Boolean)))
    .slice(0, limit);
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T) {
  return typeof value === 'string' && allowed.includes(value as T) ? value as T : fallback;
}

function normalizeSummary(value: unknown) {
  const text = compactText(value, 360);
  if (!text) return '';
  const sentences = text.match(/[^。！？!?]+[。！？!?]?/gu) ?? [text];
  return sentences.slice(0, 3).join('').trim();
}

function normalizeCandidate(value: unknown): VoiceCallMemoryCandidate | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const title = compactText(item.title, 24);
  const content = compactText(item.content, 80);
  const rememberedReason = compactText(item.rememberedReason, 60);
  const recallCues = stringList(item.recallCues, 6);
  const allowedAtomicKinds = ['fact', 'preference', 'event', 'relationship_rule', 'relationship_change'] as const;
  if (
    !title
    || content.length < 18
    || rememberedReason.length < 12
    || recallCues.length < 2
    || typeof item.atomicKind !== 'string'
    || !allowedAtomicKinds.includes(item.atomicKind as typeof allowedAtomicKinds[number])
  ) return null;
  return {
    arousal: clamp(item.arousal, 0, 1, 0.3),
    atomicKind: item.atomicKind as typeof allowedAtomicKinds[number],
    candidateKind: enumValue(item.candidateKind, ['long_term', 'small_note', 'emotional_weather'] as const, 'long_term'),
    confidence: clamp(item.confidence, 0, 1, 0.7),
    content,
    domain: enumValue(item.domain, ['相处', '称呼', '喜好', '边界', '经历', '约定', '日常', '其他'] as const, '其他'),
    importance: Math.round(clamp(item.importance, 1, 10, 5)),
    recallCues,
    rememberedReason,
    semanticType: enumValue(item.semanticType, ['profile', 'preference', 'entity', 'event', 'pattern', 'other'] as const, 'other'),
    stability: clamp(item.stability, 0, 1, 0.5),
    suggestedAnchor: item.suggestedAnchor === true,
    suggestedAnchorKind: enumValue(item.suggestedAnchorKind, ['name', 'boundary', 'relationship_rule', 'preference', 'promise', 'identity', 'other'] as const, 'other'),
    tags: stringList(item.tags, 8),
    title,
    valence: clamp(item.valence, 0, 1, 0.5),
  };
}

export function parseVoiceCallRecordSummary(text: string) {
  const cleaned = text.replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '').trim();
  const parsed = JSON.parse(cleaned) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Voice call record summary response must be a JSON object.');
  }
  const result = parsed as Record<string, unknown>;
  const candidates = Array.isArray(result.memoryCandidates)
    ? result.memoryCandidates.map(normalizeCandidate).filter((item): item is VoiceCallMemoryCandidate => !!item).slice(0, 2)
    : [];
  return {
    memoryCandidates: candidates,
    summary: normalizeSummary(result.summary),
  };
}

function requestSummaryWithXhr(input: {
  apiKey: string;
  connection: AiConnection;
  body: string;
  url: string;
  signal?: AbortSignal;
}) {
  let cacheMetric: ReturnType<typeof beginPromptCacheMetric> | undefined;
  return new Promise<CompletionPayload>((resolve, reject) => {
    const request = new XMLHttpRequest();
    if (input.signal?.aborted) { reject(new Error('summary_aborted')); return; }
    const abort = () => request.abort();
    input.signal?.addEventListener('abort', abort, { once: true });
    request.onloadend = () => input.signal?.removeEventListener('abort', abort);
    request.open('POST', input.url);
    request.timeout = VOICE_CALL_RECORD_SUMMARY_TIMEOUT_MS;
    request.setRequestHeader('Authorization', `Bearer ${input.apiKey.trim()}`);
    request.setRequestHeader('Content-Type', 'application/json');
    request.onload = () => {
      let payload: CompletionPayload = {};
      try {
        payload = request.responseText ? JSON.parse(request.responseText) as CompletionPayload : {};
        cacheMetric?.recordUsage(payload?.usage);
      } catch {
        reject(new Error('summary_response_invalid_json'));
        return;
      }
      if (request.status < 200 || request.status >= 300) {
        reject(new Error(payload.error?.message || `summary_http_${request.status}`));
        return;
      }
      resolve(payload);
    };
    request.onerror = () => reject(new Error('summary_network_failed'));
    request.ontimeout = () => reject(new Error('summary_timeout'));
    request.onabort = () => reject(new Error('summary_aborted'));
    cacheMetric = beginPromptCacheMetric({ contextProfile: 'memory-organizer', contextSource: 'voice.summary', connection: input.connection });
    request.send(input.body);
  }).finally(() => { void cacheMetric?.finish(); });
}

export async function summarizeVoiceCallRecord(input: {
  apiKey: string;
  connection: AiConnection;
  record: VoiceCallRecord;
  mode?: 'automatic' | 'manual';
  materials?: UnderstandingMaterials;
  batch?: ReturnType<typeof prepareVoiceCallMemoryBatch>;
  signal?: AbortSignal;
  canCommit?: () => boolean;
}) {
  const batch = input.batch ?? prepareVoiceCallMemoryBatch(input.record);
  const mode = input.mode ?? 'automatic';
  const modelParameters = buildChatModelParameterPayload(input.connection.modelParameters);
  const makeBody = () => JSON.stringify({
    model: input.connection.model.trim(),
    messages: [
      { content: buildVoiceCallJointPrompt(mode, input.materials), role: 'system' },
      ...(input.materials?.text ? [{ content: input.materials.text, role: 'system' }] : []),
      { content: batch.materialText, role: 'system' },
    ],
    ...(isOfficialDeepSeekV4Connection(input.connection) ? { thinking: { type: 'disabled' as const } } : {}),
    ...buildOpenAiCompatibilityPayload(input.connection),
    ...modelParameters,
    ...(mode === 'automatic' ? { max_tokens: Math.min(modelParameters.max_tokens ?? VOICE_CALL_RECORD_SUMMARY_MAX_TOKENS, VOICE_CALL_RECORD_SUMMARY_MAX_TOKENS) } : {}),
    ...(input.connection.chatJsonOutputEnabled === true ? { response_format: { type: 'json_object' as const } } : {}),
    stream: false,
  });
  const scheduled = await runScheduledAiCall('voiceCallRecordSummary', mode === 'manual' ? 'normal' : 'background', async () => {
    if (input.signal?.aborted || input.canCommit && !input.canCommit()) throw new Error('summary_aborted');
    await validateUnderstandingMaterials(input.materials);
    if (!(await validateVoiceCallMaterialBindings(batch.bindings))) throw new Error('MEMORY_SOURCE_CHANGED');
    if (input.signal?.aborted || input.canCommit && !input.canCommit()) throw new Error('summary_aborted');
    const payload = await requestSummaryWithXhr({
      apiKey: input.apiKey,
      connection: input.connection,
      body: makeBody(),
      signal: input.signal,
      url: `${input.connection.baseUrl.trim().replace(/\/+$/u, '')}/chat/completions`,
    });
    const text = readCompletionText(payload);
    if (['length', 'max_tokens'].includes(payload.choices?.[0]?.finish_reason ?? '')) throw new Error('summary_output_truncated');
    if (!text.trim()) throw new Error('summary_empty');
    return parseVoiceCallJointResult(text, batch, input.materials, mode);
  });
  if (scheduled.skipped) throw new Error('summary_scheduler_busy');
  return scheduled.value;
}

export function buildVoiceCallJointPrompt(mode: 'automatic' | 'manual', materials?: UnderstandingMaterials) {
  const shared = buildConversationMemoryOrganizerPrompt(materials)
    .replace(SUBJECTIVE_IDENTITY_PROTOCOL, '')
    .replace('I 把这些候选写成 JSON 数组；没有合适的内容时，就写 []。', '')
    .replace(mode === 'automatic' ? '本次最多整理 6 条候选。' : '\u0000', '');
  const summary = BAIYUN_VOICE_CALL_RECORD_PROMPT.split('【memoryCandidates】')[0];
  return `${SUBJECTIVE_IDENTITY_PROTOCOL}\n${summary}\n只读到部分电话原话时，I 的小记也只写这一部分。\n\n【memoryCandidates】\n${mode === 'automatic' ? 'I 从本批电话原话里整理零到两条记忆候选。\n' : ''}${shared}\n最终只返回以下 JSON：\n{\n  "summary": "一到三句通话小记，或空字符串",\n  "memoryCandidates": []\n}`;
}

export async function parseVoiceCallJointResult(text: string, batch: ReturnType<typeof prepareVoiceCallMemoryBatch>,
  materials: UnderstandingMaterials | undefined, mode: 'automatic' | 'manual') {
  const parsed = JSON.parse(text.replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '').trim());
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('summary_response_invalid_json');
  const summaryValid = typeof parsed.summary === 'string' && parsed.summary.length <= 360
    && (parsed.summary.trim().match(/[^。！？!?]+[。！？!?]?/gu)?.length ?? 0) <= 3;
  let candidates: MemoryDraftWithSourceIds[] | undefined;
  let candidateFailure: string | undefined;
  try {
    if (!Array.isArray(parsed.memoryCandidates)) throw new Error('memory-candidate-contract-invalid');
    candidates = await validateCurrentStateCandidates(await validateConversationMemoryCandidates(await validateUnderstandingCandidates(
      parseCandidates(JSON.stringify(parsed.memoryCandidates), { sourceMessages: batch.messages, understandingMaterials: materials,
        requireSourceMessageIds: true, maximumCandidates: mode === 'automatic' ? 2 : 6 }))));
  } catch (error) { candidateFailure = error instanceof Error ? error.message : 'memory-candidate-contract-invalid'; }
  return { summaryValid, summary: summaryValid ? parsed.summary.trim() as string : undefined,
    candidates, candidateFailure };
}
