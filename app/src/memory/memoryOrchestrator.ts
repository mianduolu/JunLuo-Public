import { buildLocalMemoryRecallOnly, buildMemoryRecall, type StructuredMemoryQuery } from './memoryRecall';
import {
  buildMemoryContextPack,
  getMemoryCarePoolCandidates,
  getBackgroundMemoryCandidates,
  isBackgroundEligible, scoreBackgroundTopicMatch, normalizeBackgroundTerms, scoreSurfacingMemory,
  type MemorySurfacingCandidate,
} from './memorySurfacing';
import { getAnchorKindLabel, buildAnchorContext, isAnchorCoordinate, scoreAnchor } from './memoryAnchorContext';
import { CURRENT_STATE_TEXT_THRESHOLD, memoryLocalRecallQuery, scoreCurrentStateText } from './memoryRecall';
import { createMemoryMaterialPreparation, type MemoryMaterialPreparation, type MemoryUsageReference } from './memoryCurrentMaterials';
import { loadBaiyunPostRecall } from '../posts/baiyunPostStore';
import type { PostRecallReference } from '../posts/baiyunPostKnown';
import { isBaiyunPostMemory } from '../posts/baiyunPostContract';
import { buildMemoryContextSnippet } from './memoryContextTextBuilder';
import { getMemoryOccurrenceStart } from './memoryAtomicity';
import {
  finishMemoryRetrievalTrace,
  recordMemoryRetrievalStage,
  startMemoryRetrievalTrace,
  type MemoryRetrievalTrace,
} from './memoryRetrievalTrace';
import { buildSourceTraceContext, memorySourceDetailsFromSnapshots, memorySourceTraceItems } from './memorySourceTrace';
import { buildLowEnergyCompanionToneInstruction, getMemorySpeechPolicy } from './memorySpeechPolicy';
import { loadCurrentStateMaterial, formatCurrentStateMaterial, type CurrentStateMaterial } from './memoryCurrentStateContext';
import { currentStateVersion, loadMemoryCurrentState } from './memoryCurrentStateStore';
import { referenceKey, type MemoryReadReference } from './memoryReadReference';
import type { MemoryRecallRoute } from './memoryRecallRouter';
import type { MemoryRecallPreparationDiagnostic, MemoryRecallWorkReporter } from './memoryChatPreparation';
import { isMemoryRecallEligible, selectRefreshedMemoryRecallItems, loadMemories, loadMemory, type MemoryEntry, type MemoryRecallItem } from './memoryStore';
import type { MemoryCurrentState } from './memoryCurrentStateStore';
import { observeRuntimeWorkload } from '../runtime/runtimeWorkloadDiagnostics';
import { isMemoryDatabaseBusy } from './memoryDatabaseWrites';
import { weeklyTargetHash } from './memoryWeeklyBasis';
import { compareMemoryRecallRanks } from './memoryRecallScoring';
import { createShiyingRecallRefresh, formatShiyingRecallMaterial, shiyingReadReference, type ShiyingRecallSelection, type ShiyingRecallRefreshState } from './memoryShiyingRecall';
import { postReadReference, formatPostRecallMaterial, createPostRecallRefresh, preferConfirmedPostMemories, selectPostRecall, type PostRecallSelection, type PostRecallHit, type PostRecallRefreshState } from './memoryPostRecall';
import type { PostRecallSnapshot } from '../posts/baiyunPostRecallSource';

export type MemoryBundleSource = 'chat' | 'life' | 'focus' | 'schedule' | 'letter' | 'proactive';

export type MemoryBundleDebug = {
  /** Ephemeral UI-only projection of papers actually sent; no new persisted reference counters. */
  providedPapers?: Array<{ id: string; recordDate: string }>;
  providedPosts?: Array<{ id: string; title: string; createdAt: number }>;
  auxiliaryFailures?: Array<'post_database_busy' | 'post_read_failed' | 'focus_database_busy' | 'focus_read_failed' | 'shiying_source_unavailable' | 'shiying_read_failed'>;
  preparation?: MemoryRecallPreparationDiagnostic;
  sentCount?: number;
  dropped: Array<{ id: string; reason: string }>;
  counts: Record<string, number>;
  route?: MemoryRecallRoute;
  trace?: MemoryRetrievalTrace;
};

export type MemoryBundle = {
  memoryUsageReferences?: MemoryUsageReference[];
  refreshMemoryMaterials?: (additionalMemories?: readonly MemoryEntry[]) => Promise<void>;
  visibleMemoryIds?: Set<string>;
  context: string;
  memoryMentionItems: MemoryReadReference[];
  postContext?: string;
  postReference?: PostRecallReference;
  recallItems: MemoryRecallItem[];
  careItems: MemoryRecallItem[];
  anchorItems: MemoryEntry[];
  currentStateItems: MemoryCurrentState[];
  reflectionItems: MemoryEntry[];
  debug: MemoryBundleDebug;
};

export type MemoryBundleStage =
  | 'anchor_ready'
  | 'background_ready'
  | 'bundle_ready'
  | 'care_pool_ready'
  | 'current_state_ready'
  | 'recall_ready'
  | 'reflection_ready'
  | 'snapshot_ready'
  | 'source_trace_ready'
  | 'spoken_mentions_ready';

type MemoryBundleOptions = {
  memoryWorkReporter?: MemoryRecallWorkReporter;
  allowRerank?: boolean;
  includeCurrentStates?: boolean;
  throwOnError?: boolean;
  materialPreparation?: MemoryMaterialPreparation;
  diagnosticParentToken?: number;
  maxItems?: number;
  memoryRoute?: MemoryRecallRoute | null;
  numberMemories?: boolean;
  onStage?: (stage: MemoryBundleStage) => void;
  signal?: AbortSignal;
  source?: MemoryBundleSource;
  readOnly?: boolean;
  touch?: boolean;
  useSemanticMemory?: boolean;
};

function throwIfMemoryBundleAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  throw Object.assign(new Error('memory-bundle-cancelled'), { name: 'AbortError' });
}

const DAY_MS = 86400000;
const DEFAULT_RECALL_LIMIT = 5;
const MAX_QUIET_CONTEXT = 8;
const MAX_ANCHORS = 3;
const MAX_REFLECTIONS = 1;
const POST_CONTEXT_LIMIT = 1000;
const currentStatePreparations = new WeakMap<MemoryMaterialPreparation, Map<string, { version: string; sourceVersion: string; refreshed: boolean; omitted: boolean }>>();
const paperPreparations = new WeakMap<MemoryMaterialPreparation, Map<string, ShiyingRecallRefreshState>>();
const postPreparations = new WeakMap<MemoryMaterialPreparation, Map<string, PostRecallRefreshState>>();

type TemporalDateFormatters = { date?: Intl.DateTimeFormat; dateTime?: Intl.DateTimeFormat };

function formatDateKey(value: number, formatters: TemporalDateFormatters) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? date.toLocaleDateString('zh-CN')
    : (formatters.date ??= new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric' })).format(date);
}

function formatAbsoluteDateTime(value: number, formatters: TemporalDateFormatters) {
  const date = new Date(value);
  const options: Intl.DateTimeFormatOptions = {
    day: 'numeric',
    hour: '2-digit',
    hour12: false,
    minute: '2-digit',
    month: 'long',
    year: 'numeric',
  };
  return Number.isNaN(date.getTime()) ? date.toLocaleString('zh-CN', options)
    : (formatters.dateTime ??= new Intl.DateTimeFormat('zh-CN', options)).format(date);
}

function memoryTimeAnchor(item: MemoryRecallItem) {
  const memory = item.memory;
  const at = getMemoryOccurrenceStart(memory.eventTime);
  if (at !== undefined) return { at, kind: 'event' as const };
  return { at: memory.createdAt, kind: 'recorded' as const };
}

function cjkBigrams(text: string) {
  const normalized = text.toLowerCase().replace(/\s+/g, '');
  const grams = new Set<string>();
  for (let index = 0; index < normalized.length - 1; index += 1) {
    grams.add(normalized.slice(index, index + 2));
  }
  return grams;
}

function similarity(left: string, right: string) {
  const leftTerms = cjkBigrams(left);
  const rightTerms = cjkBigrams(right);
  if (!leftTerms.size || !rightTerms.size) return 0;
  let overlap = 0;
  leftTerms.forEach((term) => {
    if (rightTerms.has(term)) overlap += 1;
  });
  return overlap / Math.min(leftTerms.size, rightTerms.size);
}

function memoryText(memory: MemoryEntry) {
  return `${memory.title}\n${memory.content}\n${memory.tags.join(' ')}\n${memory.recallCues.join(' ')}`;
}

function isDuplicate(memory: MemoryEntry, selected: MemoryEntry[]) {
  return selected.some((item) => item.id === memory.id || item.understandingSubject === memory.understandingSubject
    && similarity(memoryText(item), memoryText(memory)) >= 0.86);
}

function isLongContextMemory(memory: MemoryEntry) {
  return memory.content.length >= 180
    || memory.semanticType === 'case'
    || memory.source === 'weekly-context'
    || memory.source === 'episode-memory'
    || memory.tags.includes('阶段记忆')
    || memory.tags.includes('周脉络');
}

function isCrowdedLongMemory(memory: MemoryEntry, selected: MemoryEntry[]) {
  if (!isLongContextMemory(memory)) return false;
  return selected.some((item) => item.understandingSubject === memory.understandingSubject
    && isLongContextMemory(item) && similarity(memoryText(item), memoryText(memory)) >= 0.72);
}

function compactContent(content: string, limit: number) {
  return content.length > limit ? `${content.slice(0, limit - 1).replace(/[，,；;、\s]+$/g, '')}…` : content;
}

export function buildTemporalMemoryLine(item: MemoryRecallItem, numbers: ReadonlyMap<string, number>, preparation: MemoryMaterialPreparation, formatters: TemporalDateFormatters, episodeFormat = false) {
  const now = Date.now();
  const todayKey = formatDateKey(now, formatters);
  const { latestComment, memory, reason } = item;
  if (memory.understandingSubject) {
    const label = memory.understandingSubject === 'you' ? 'I 对 you 的认识' : 'I 对自己的认识';
    const number = numbers.get(memory.id);
    const comment = latestComment && latestComment.kind !== 'dehydration'
      ? compactContent(latestComment.content, 100) : '';
    return `- ${number ? `[记忆 ${number}] ` : ''}[${label}] ${buildMemoryContextSnippet(memory, { latestComment, reason })}${
      memory.tags.length ? ` [标签: ${memory.tags.join('、')}]` : ''
    }${comment ? `\n  后来补记（不是事件发生时间）：${comment}` : ''}`;
  }
  const timeAnchor = memoryTimeAnchor(item);
  const anchorDateKey = formatDateKey(timeAnchor.at, formatters);
  const ageDays = Math.max(0, Math.floor((now - timeAnchor.at) / DAY_MS));
  const temporalStatus = timeAnchor.kind === 'recorded'
    ? '仅知道记忆保存时间，不知道事件发生日期'
    : anchorDateKey === todayKey
      ? '发生于今天，但不代表正在发生'
      : `历史记录，约 ${ageDays} 天前发生`;
  const sourceLabel = memory.source === 'focus' ? '历史专注记录' : '长期记忆';
  const timeLabel = timeAnchor.kind === 'event' ? '事件时间' : '保存时间';
  let timeContext = `${timeLabel} ${formatAbsoluteDateTime(timeAnchor.at, formatters)}｜${temporalStatus}`;
  const timeExpression = timeAnchor.kind === 'recorded' ? memory.eventTime?.timeExpression?.trim() : undefined;
  if (timeExpression) {
    const timeSourceMessageId = memory.eventTime?.timeSourceMessageId;
    const sources = timeSourceMessageId
      ? preparation.sourceRefsFor(memory.id)
        .filter(ref => ref.messageId === timeSourceMessageId)
      : [];
    const source = sources.length === 1 ? sources[0] : undefined;
    const sourceTime = source && Number.isFinite(new Date(source.messageCreatedAt).getTime())
      ? `原话 ${source.role}，${formatAbsoluteDateTime(source.messageCreatedAt, formatters)}`
      : '原话时间缺失';
    timeContext = `时间线索 ${timeExpression}｜${sourceTime}｜具体日期未定`;
  }
  const primaryContent = buildMemoryContextSnippet(memory, { latestComment, reason, episodeFormat });
  const compactComment = latestComment && latestComment.kind !== 'dehydration'
    ? compactContent(latestComment.content, 100)
    : '';
  const number = numbers.get(memory.id);
  return `- ${number ? `[记忆 ${number}] ` : ''}[${sourceLabel}｜${timeContext}] ${primaryContent}${
    memory.tags.length ? ` [标签: ${memory.tags.join('、')}]` : ''
  }${compactComment ? `\n  后来补记（不是事件发生时间）：${compactComment}` : ''}`;
}

function buildTemporalMemorySection(title: string, instruction: string, items: MemoryRecallItem[], numbers: ReadonlyMap<string, number>, preparation: MemoryMaterialPreparation, formatters: TemporalDateFormatters, episodeFormat = false) {
  if (!items.length) return '';
  return `【${title}】
${instruction}
${items.map(item => buildTemporalMemoryLine(item, numbers, preparation, formatters, episodeFormat)).join('\n')}`;
}

function buildTemporalMemoryContext(
  items: MemoryRecallItem[],
  careItems: MemoryRecallItem[] = [],
  companionToneInstruction = '',
  numbers: ReadonlyMap<string, number> = new Map(),
  preparation: MemoryMaterialPreparation,
  episodeFormat = false,
) {
  if (!items.length && !careItems.length) return '';
  const formatters: TemporalDateFormatters = {};
  const careIds = new Set(careItems.map((item) => item.memory.id));
  const recallById = new Map(items.map((item) => [item.memory.id, item]));
  const renderedCareItems = careItems.map((item) => ({
    ...item,
    latestComment: item.latestComment ?? recallById.get(item.memory.id)?.latestComment,
  }));
  const relatedItems = items.filter((item) => item.reason !== 'quiet_context' && item.reason !== 'suggested_mention');
  const backgroundItems = items.filter((item) => item.reason === 'quiet_context' && !careIds.has(item.memory.id));
  const spokenItems = items.filter((item) => item.reason === 'suggested_mention');
  const sections = [
    buildTemporalMemorySection(
      '相关记忆',
      getMemorySpeechPolicy('related').promptInstruction,
      relatedItems,
      numbers,
      preparation,
      formatters,
      episodeFormat,
    ),
    buildTemporalMemorySection(
      '背景记忆',
      getMemorySpeechPolicy('background').promptInstruction,
      backgroundItems,
      numbers,
      preparation,
      formatters,
      episodeFormat,
    ),
    buildTemporalMemorySection(
      '常常会惦记',
      getMemorySpeechPolicy('carePool').promptInstruction,
      renderedCareItems,
      numbers,
      preparation,
      formatters,
      episodeFormat,
    ),
    buildTemporalMemorySection(
      '本轮可以说出口',
      getMemorySpeechPolicy('spoken').promptInstruction,
      spokenItems,
      numbers,
      preparation,
      formatters,
      episodeFormat,
    ),
  ].filter(Boolean);
  if (!sections.length) return '';
  return `${[companionToneInstruction, ...sections].filter(Boolean).join('\n\n')}

【记忆时间使用规则】
- 上述日期是事件或记忆形成的时间锚点。
- 标为“保存时间”的条目只能说明那天存入记忆，不能推断事情也在那天发生。
- 记忆被召回、补记或更新，不代表事件重新发生；绝不能把旧记录说成“刚刚、刚才、正在、今天才发生”。
- 如果旧记忆正文自身含“刚刚、今天、上次”等相对词，它们只属于该条记录形成时的原始语境，必须按前面的绝对日期理解。
- 不确定事件是否仍在持续时，使用“以前有过这件事”，不要擅自改写成当前状态。`;
}

function buildAnchorSection(items: MemoryEntry[], numbers: ReadonlyMap<string, number>) {
  if (!items.length) return '';
  const lines = items.map((memory) => {
    const label = `${getAnchorKindLabel(memory.anchorKind)}坐标`;
    const reason = memory.rememberedReason?.trim() ? `；留下理由：${memory.rememberedReason.trim()}` : '';
    const number = numbers.get(memory.id);
    return `- ${number ? `[记忆 ${number}] ` : ''}[${label}] ${memory.content}${reason}`;
  });
  return [
    '【长期坐标】',
    getMemorySpeechPolicy('anchor').promptInstruction,
    ...lines,
  ].join('\n');
}

function getUserQueryText(input: string | StructuredMemoryQuery) {
  return typeof input === 'string' ? input : input.userText;
}

function selectRecallItems(items: MemoryRecallItem[], maxItems: number, maxQuietContext: number, debug: MemoryBundleDebug) {
  const selected: MemoryRecallItem[] = [];
  const selectedMemories: MemoryEntry[] = [];
  let quietCount = 0;
  const priority = (item: MemoryRecallItem) => {
    if (item.reason === 'suggested_mention') return 1;
    if (item.reason === 'quiet_context') return 3;
    return 0;
  };
  for (const item of [...items].sort((left, right) => priority(left) - priority(right))) {
    const isQuiet = item.reason === 'quiet_context';
    const isSuggested = item.reason === 'suggested_mention';
    if (isQuiet && quietCount >= maxQuietContext) {
      debug.dropped.push({ id: item.memory.id, reason: 'quiet_context_limit' });
      continue;
    }
    if (!isQuiet && !isSuggested && selected.filter((candidate) => candidate.reason !== 'quiet_context' && candidate.reason !== 'suggested_mention').length >= maxItems) {
      debug.dropped.push({ id: item.memory.id, reason: 'recall_limit' });
      continue;
    }
    if (isDuplicate(item.memory, selectedMemories)) {
      debug.dropped.push({ id: item.memory.id, reason: 'duplicate_recall' });
      continue;
    }
    if (isCrowdedLongMemory(item.memory, selectedMemories)) {
      debug.dropped.push({ id: item.memory.id, reason: 'diversity_long_memory' });
      continue;
    }
    selected.push(item);
    selectedMemories.push(item.memory);
    if (isQuiet) quietCount += 1;
  }
  return selected;
}

function selectMemories(items: MemoryEntry[], selected: MemoryEntry[], limit: number, reason: string, debug: MemoryBundleDebug) {
  const kept: MemoryEntry[] = [];
  for (const memory of items) {
    if (kept.length >= limit) {
      debug.dropped.push({ id: memory.id, reason: `${reason}_limit` });
      continue;
    }
    if (isDuplicate(memory, [...selected, ...kept])) {
      debug.dropped.push({ id: memory.id, reason: `duplicate_${reason}` });
      continue;
    }
    kept.push(memory);
  }
  return kept;
}

function surfacingCandidateToRecallItem(candidate: MemorySurfacingCandidate): MemoryRecallItem {
  return {
    ...candidate.recallEvidence,
    memory: candidate.memory,
    reason: candidate.mode,
    recallReasons: candidate.reasons,
    score: candidate.score,
    sources: candidate.recallEvidence?.sources ?? [],
  };
}

function getBackgroundPolicy(route?: MemoryRecallRoute) {
  if (route?.mode === 'recall' || route?.mode === 'detail_recall') {
    return { limit: 2, recentDays: 3 };
  }
  if (route?.careNeed === 'needs_being_remembered') {
    return { limit: 8, recentDays: 14 };
  }
  if (route?.careNeed === 'needs_companionship') {
    return { limit: 6, recentDays: 10 };
  }
  if (route?.careNeed === 'low_energy') {
    return { limit: 4, recentDays: 7 };
  }
  if (route?.mode === 'background_only') {
    return { limit: 3, recentDays: 3 };
  }
  return { limit: 4, recentDays: 3 };
}

function getCarePoolPolicy(route?: MemoryRecallRoute) {
  if ((route?.mode === 'recall' || route?.mode === 'detail_recall') && route.careNeed === 'ordinary') {
    return { poolLimit: 2, spokenLimit: route.allowGentleMention ? 1 : 0 };
  }
  if (route?.careNeed === 'needs_being_remembered') {
    return { poolLimit: 6, spokenLimit: 2 };
  }
  if (route?.careNeed === 'needs_companionship') {
    return { poolLimit: 5, spokenLimit: 1 };
  }
  if (route?.careNeed === 'low_energy') {
    return { poolLimit: 4, spokenLimit: 1 };
  }
  if (route?.careNeed === 'sensitive') {
    return { poolLimit: 3, spokenLimit: route.mode === 'recall' || route.mode === 'detail_recall' ? 1 : 0 };
  }
  if (route?.allowGentleMention) {
    return { poolLimit: 4, spokenLimit: 1 };
  }
  return { poolLimit: 3, spokenLimit: 0 };
}

function selectSpokenCareCandidates(candidates: MemorySurfacingCandidate[], route?: MemoryRecallRoute) {
  const { spokenLimit } = getCarePoolPolicy(route);
  if (spokenLimit <= 0) return [];
  return candidates
    .filter((candidate) => {
      if (route?.careNeed === 'sensitive') {
        return candidate.reasons.includes('high_arousal')
          || candidate.memory.tags.some((tag) => tag.includes('边界') || tag.includes('安全'));
      }
      return true;
    })
    .slice(0, spokenLimit);
}

export async function buildChatMemoryBundle(
  input: string | StructuredMemoryQuery,
  options: MemoryBundleOptions = {},
): Promise<MemoryBundle> {
  throwIfMemoryBundleAborted(options.signal);
  const source = options.source ?? 'chat';
  const baseMaxRecall = Math.max(1, Math.min(8, options.maxItems ?? DEFAULT_RECALL_LIMIT));
  const route = options.memoryRoute ?? undefined;
  const maxRecall = route?.mode === 'background_only'
    ? Math.min(baseMaxRecall, 3)
    : route?.mode === 'recall' || route?.mode === 'detail_recall'
      ? Math.max(baseMaxRecall, 6)
      : baseMaxRecall;
  const debug: MemoryBundleDebug = { dropped: [], counts: {}, route };
  const trace = startMemoryRetrievalTrace(input);
  const useSemanticMemory = options.useSemanticMemory !== false && (source !== 'chat' || route?.mode !== 'background_only');
  const touch = options.touch ?? source !== 'life';
  const includeSurfacing = source !== 'life';
  const queryText = typeof input === 'string' ? input : [input.userText, input.activeContext].filter(Boolean).join('\n');
  const sharedPreparation = options.materialPreparation ?? createMemoryMaterialPreparation({ signal: options.signal, includeSources: route?.mode === 'detail_recall' });
  // Chat supplies raw sources only for the selected detail view, never for every
  // ranking candidate or for a body-only local fallback.
  let chatSourceIds = new Set<string>();
  let statePreparation = currentStatePreparations.get(sharedPreparation);
  if (!statePreparation) { statePreparation = new Map(); currentStatePreparations.set(sharedPreparation, statePreparation); }
  const materialPreparation: MemoryMaterialPreparation = {
    ...sharedPreparation,
    refresh: (memories, eligible) => sharedPreparation.refresh(memories, eligible, options.signal,
      source === 'chat' ? chatSourceIds : undefined, options.memoryWorkReporter),
  };
  const backgroundPolicy = source === 'chat'
    ? { limit: route?.mode === 'recall' || route?.mode === 'detail_recall' ? 2 : route?.mode === 'background_only' ? 3 : 4, recentDays: 3 }
    : getBackgroundPolicy(route);
  const carePolicy = getCarePoolPolicy(route);
  const currentStateSelection = { items: [] as MemoryCurrentState[] };
  const shiyingSelection: ShiyingRecallSelection | undefined = source === 'chat' ? { items: [] } : undefined;
  const postSelection: PostRecallSelection | undefined = source === 'chat' ? { items: [] } : undefined;

  const memorySnapshot = !touch && (source === 'chat' || !useSemanticMemory)
    ? await observeRuntimeWorkload(
      'memory.snapshot',
      () => (source === 'chat' ? materialPreparation.loadCandidateSnapshot(options.signal, options.memoryWorkReporter)
        : loadMemories({ includeArchived: false, currentOnly: true }))
        .then(items => items.filter(item => !isBaiyunPostMemory(item))).catch((error) => { if (options.throwOnError) throw error; return undefined; }),
      (value) => ({ memoryCount: value?.length ?? 0 }),
      { parentToken: options.diagnosticParentToken },
    )
    : undefined;
  throwIfMemoryBundleAborted(options.signal);
  if (memorySnapshot) options.onStage?.('snapshot_ready');

  const recallStartedAt = Date.now();
  let recall = await observeRuntimeWorkload(
    'memory.recall',
    (span) => (
      useSemanticMemory
        ? buildMemoryContextPack(input, {
          allowRerank: options.allowRerank,
          currentStateSelection: options.includeCurrentStates === false ? undefined : currentStateSelection,
          shiyingSelection,
          postSelection,
          memories: memorySnapshot,
          throwOnError: options.throwOnError,
          materialPreparation,
          memoryWorkReporter: options.memoryWorkReporter,
          backgroundLimit: backgroundPolicy.limit,
          backgroundRecentDays: backgroundPolicy.recentDays,
          diagnosticParentToken: span?.token,
          includeSuggestedMentions: false,
          maxResults: maxRecall,
          signal: options.signal,
          touch,
          includeSurfacing,
          collectBackgroundCandidates: source === 'chat',
        })
        : buildLocalMemoryRecallOnly(input, {
          readOnly: options.readOnly,
          currentStateSelection: options.includeCurrentStates === false ? undefined : currentStateSelection,
          shiyingSelection,
          postSelection,
          throwOnError: options.throwOnError,
          materialPreparation,
          memoryWorkReporter: options.memoryWorkReporter,
          diagnosticParentToken: span?.token,
          maxResults: maxRecall,
          memories: memorySnapshot,
          signal: options.signal,
          touch,
          collectBackgroundCandidates: source === 'chat',
        })
    ).catch((error) => { if (options.throwOnError) throw error; return { context: '', items: [], backgroundCandidates: [] as MemoryRecallItem[] }; }),
    (value) => ({ memoryCount: value.items.length }),
    { parentToken: options.diagnosticParentToken },
  );
  throwIfMemoryBundleAborted(options.signal);
  options.onStage?.('recall_ready');
  if (shiyingSelection?.failure) debug.auxiliaryFailures = [...(debug.auxiliaryFailures ?? []),
    shiyingSelection.failure === 'source_unavailable' ? 'shiying_source_unavailable' : 'shiying_read_failed'];
  if (postSelection?.failure) debug.auxiliaryFailures = [...(debug.auxiliaryFailures ?? []), 'post_read_failed'];
  const backgroundStartedAt = Date.now();
  if (!useSemanticMemory && includeSurfacing) {
    const background = await observeRuntimeWorkload(
      'memory.background',
      () => getBackgroundMemoryCandidates({
        materialPreparation,
        excludeIds: recall.items.map(({ memory }) => memory.id),
        input,
        limit: backgroundPolicy.limit,
        memories: memorySnapshot,
        recentDays: backgroundPolicy.recentDays,
        relatedCandidates: source === 'chat' ? recall.backgroundCandidates ?? [] : undefined,
      }).catch((error) => { if (options.throwOnError) throw error; return []; }),
      (value) => ({ memoryCount: value.length }),
      { parentToken: options.diagnosticParentToken },
    );
    throwIfMemoryBundleAborted(options.signal);
    options.onStage?.('background_ready');
    recall = {
      ...recall,
      items: [
        ...recall.items,
        ...background.map(surfacingCandidateToRecallItem),
      ],
    };
  }
  const careStartedAt = Date.now();
  const careExcludeIds = recall.items
    .filter((item) => item.reason !== 'quiet_context' && item.reason !== 'suggested_mention')
    .map(({ memory }) => memory.id);
  const careCandidates = await observeRuntimeWorkload(
    'memory.care_pool',
    () => (includeSurfacing && source !== 'chat'
      ? getMemoryCarePoolCandidates({
        materialPreparation,
        excludeIds: careExcludeIds,
        memories: memorySnapshot,
        limit: carePolicy.poolLimit,
      }).catch((error) => { if (options.throwOnError) throw error; return []; })
      : Promise.resolve([])),
    (value) => ({ memoryCount: value.length }),
    { parentToken: options.diagnosticParentToken },
  );
  throwIfMemoryBundleAborted(options.signal);
  options.onStage?.('care_pool_ready');
  const spokenCandidates = selectSpokenCareCandidates(careCandidates, route);
  const spokenIds = new Set(spokenCandidates.map((candidate) => candidate.memory.id));
  let careItems = careCandidates
    .filter((candidate) => !spokenIds.has(candidate.memory.id))
    .map(surfacingCandidateToRecallItem);
  if (spokenCandidates.length) {
    const spokenMemoryIds = new Set(spokenCandidates.map((candidate) => candidate.memory.id));
    recall = {
      ...recall,
      items: [
        ...recall.items.filter((item) => !spokenMemoryIds.has(item.memory.id)),
        ...spokenCandidates.map(surfacingCandidateToRecallItem),
      ],
    };
  }
  options.onStage?.('spoken_mentions_ready');
  recordMemoryRetrievalStage(trace, {
    inputCount: 0,
    name: 'care_pool_candidates',
    note: includeSurfacing && source !== 'chat' ? 'emotion_importance' : 'surfacing_disabled',
    outputCount: careCandidates.length,
    startedAt: careStartedAt,
  });
  recordMemoryRetrievalStage(trace, {
    inputCount: careCandidates.length,
    name: 'spoken_mentions',
    outputCount: spokenCandidates.length,
  });
  const rawBackgroundCount = recall.items.filter((item) => item.reason === 'quiet_context').length;
  const rawRecallCount = recall.items.filter((item) => item.reason !== 'quiet_context' && item.reason !== 'suggested_mention').length;
  const rawSpokenCount = recall.items.filter((item) => item.reason === 'suggested_mention').length;
  recordMemoryRetrievalStage(trace, {
    inputCount: 0,
    name: 'recall_candidates',
    note: useSemanticMemory ? 'semantic_text_life' : 'text_only',
    outputCount: rawRecallCount,
    startedAt: recallStartedAt,
  });
  recordMemoryRetrievalStage(trace, {
    inputCount: 0,
    name: 'background_candidates',
    note: includeSurfacing ? 'topic_recent' : 'surfacing_disabled',
    outputCount: rawBackgroundCount,
    startedAt: backgroundStartedAt,
  });

  let currentStateMaterial: CurrentStateMaterial | null = currentStateSelection.items.length
    ? await loadCurrentStateMaterial(currentStateSelection.items[0]) : null;
  if (currentStateMaterial && !statePreparation.has(currentStateMaterial.state.id)) {
    statePreparation.set(currentStateMaterial.state.id, { version: currentStateMaterial.version, sourceVersion: currentStateMaterial.sourceVersion, refreshed: false, omitted: false });
  }
  let paper = shiyingSelection?.items[0]?.snapshot ?? null;
  // A paper occupies an existing recall slot and the same short-material allowance.
  if (paper && !formatShiyingRecallMaterial(paper, 1, 180, memoryLocalRecallQuery(input))) paper = null;
  if (paper && maxRecall === 1) currentStateMaterial = null;
  let paperStates = paperPreparations.get(sharedPreparation);
  if (!paperStates) { paperStates = new Map(); paperPreparations.set(sharedPreparation, paperStates); }
  if (paper && !paperStates.has(paper.recordId)) paperStates.set(paper.recordId, { current: paper, refreshed: false });
  const refreshPaper = paper ? createShiyingRecallRefresh(paper, memoryLocalRecallQuery(input), paperStates.get(paper.recordId)) : undefined;
  let recallItems = selectRecallItems(recall.items.filter(item => !isBaiyunPostMemory(item.memory)), maxRecall - (currentStateMaterial ? 1 : 0) - (paper ? 1 : 0), backgroundPolicy.limit, debug);
  const selectedBackgroundCount = recallItems.filter((item) => item.reason === 'quiet_context').length;
  const selectedRecallCount = recallItems.filter((item) => item.reason !== 'quiet_context' && item.reason !== 'suggested_mention').length;
  const selectedSpokenCount = recallItems.filter((item) => item.reason === 'suggested_mention').length;
  recordMemoryRetrievalStage(trace, {
    droppedIds: debug.dropped.map((item) => item.id),
    inputCount: rawRecallCount,
    name: 'recall_selected',
    outputCount: selectedRecallCount,
  });
  recordMemoryRetrievalStage(trace, {
    droppedIds: debug.dropped
      .filter((item) => item.reason === 'quiet_context_limit' || item.reason === 'duplicate_recall')
      .map((item) => item.id),
    inputCount: rawBackgroundCount,
    name: 'background_selected',
    outputCount: selectedBackgroundCount,
  });
  const selectedMemories = recallItems.map((item) => item.memory);

  const currentStateStartedAt = Date.now();
  const currentStateResult = await observeRuntimeWorkload(
    'memory.current_state',
    () => Promise.resolve({ items: currentStateMaterial ? [currentStateMaterial.state] : [] }),
    (value) => ({ itemCount: value.items.length }),
    { parentToken: options.diagnosticParentToken },
  );
  throwIfMemoryBundleAborted(options.signal);
  options.onStage?.('current_state_ready');
  recordMemoryRetrievalStage(trace, {
    inputCount: 0,
    name: 'current_state_selected',
    outputCount: currentStateResult.items.length,
    startedAt: currentStateStartedAt,
  });

  const anchorStartedAt = Date.now();
  const anchorResult = await observeRuntimeWorkload(
    'memory.anchor',
    () => buildAnchorContext(queryText, {
      materialPreparation,
      limit: MAX_ANCHORS * 3,
      memories: memorySnapshot?.filter(memory => !memory.surfaceMutedAt),
    }).catch((error) => { if (options.throwOnError) throw error; return { context: '', items: [] }; }),
    (value) => ({ memoryCount: value.items.length }),
    { parentToken: options.diagnosticParentToken },
  );
  throwIfMemoryBundleAborted(options.signal);
  options.onStage?.('anchor_ready');
  recordMemoryRetrievalStage(trace, {
    inputCount: 0,
    name: 'anchor_candidates',
    outputCount: anchorResult.items.length,
    startedAt: anchorStartedAt,
  });
  let anchorItems = selectMemories(anchorResult.items.filter(memory => !memory.surfaceMutedAt), selectedMemories, MAX_ANCHORS, 'anchor', debug);
  recordMemoryRetrievalStage(trace, {
    inputCount: anchorResult.items.length,
    name: 'anchor_selected',
    outputCount: anchorItems.length,
  });

  const reflectionStartedAt = Date.now();
  const postResult = await observeRuntimeWorkload(
    'memory.reflection',
    async () => {
      try {
        const recalled = source === 'chat' ? null : await loadBaiyunPostRecall(getUserQueryText(input), options.readOnly);
        const memory = recalled ? await loadMemory(recalled.post.id) : null;
        return { recalled, memory };
      } catch (error) {
        throwIfMemoryBundleAborted(options.signal);
        materialPreparation.assertCurrent(options.signal);
        if (error instanceof Error && error.name === 'AbortError') throw error;
        // Optional post material must not discard formal memories already read.
        debug.auxiliaryFailures = [isMemoryDatabaseBusy(error) ? 'post_database_busy' : 'post_read_failed'];
        return { recalled: null, memory: null };
      }
    },
    (value) => ({ memoryCount: value.memory ? 1 : 0 }),
    { parentToken: options.diagnosticParentToken },
  );
  const { recalled: recalledPost, memory: postMemory } = postResult;
  const reflections = postMemory ? [postMemory] : [];
  throwIfMemoryBundleAborted(options.signal);
  options.onStage?.('reflection_ready');
  recordMemoryRetrievalStage(trace, {
    inputCount: 0,
    name: 'reflection_candidates',
    outputCount: reflections.length,
    startedAt: reflectionStartedAt,
  });
  const reflectionItems = selectMemories(reflections, [...selectedMemories, ...anchorItems], MAX_REFLECTIONS, 'reflection', debug);
  if (postSelection) await preferConfirmedPostMemories(postSelection, [...recallItems.map(item => item.memory), ...anchorItems]);
  let postCandidate = postSelection?.items[0];
  let post = postCandidate?.snapshot ?? null;
  let postHits: PostRecallHit[] = postCandidate?.hits ?? [];
  if (post && !formatPostRecallMaterial(post, 1, POST_CONTEXT_LIMIT, memoryLocalRecallQuery(input), postHits, postCandidate?.excludedRanges)) post = null;
  let postStates = postPreparations.get(sharedPreparation);
  if (!postStates) { postStates = new Map(); postPreparations.set(sharedPreparation, postStates); }
  if (post && !postStates.has(post.postId)) postStates.set(post.postId, { current: post, refreshed: false });
  const refreshPost = post ? createPostRecallRefresh(post, memoryLocalRecallQuery(input), postStates.get(post.postId), options.readOnly) : undefined;
  recordMemoryRetrievalStage(trace, {
    inputCount: reflections.length,
    name: 'reflection_selected',
    outputCount: reflectionItems.length,
  });

  const sourceTraceStartedAt = Date.now();
  const sourceTrace = { context: '', details: [] as ReturnType<typeof memorySourceDetailsFromSnapshots>,
    debug: { candidates: 0, matched: 0, missingMessages: 0, missingRange: 0 } };
  const refreshSelected = async (additionalMemories: readonly MemoryEntry[] = []) => {
    if (post && refreshPost) {
      const previousId = post.postId;
      const oldVersion = post.materialHash;
      post = await refreshPost();
      if (postStates?.get(previousId)?.failure) {
        if (!debug.auxiliaryFailures?.includes('post_read_failed')) debug.auxiliaryFailures = [...(debug.auxiliaryFailures ?? []), 'post_read_failed'];
        if (!debug.dropped.some(item => item.id === previousId && item.reason === 'post_read_failed')) debug.dropped.push({ id: previousId, reason: 'post_read_failed' });
      }
      if (post && oldVersion !== post.materialHash) {
        const local: PostRecallSelection = { items: [] };
        selectPostRecall(local, [post], memoryLocalRecallQuery(input));
        postCandidate = local.items[0];
        post = postCandidate?.snapshot ?? null;
        postHits = postCandidate?.hits ?? [];
      }
    }
    if (paper && refreshPaper) {
      const previousId = paper.recordId;
      paper = await refreshPaper();
      if (paperStates?.get(previousId)?.failure) {
        if (!debug.auxiliaryFailures?.includes('shiying_read_failed')) debug.auxiliaryFailures = [...(debug.auxiliaryFailures ?? []), 'shiying_read_failed'];
        if (!debug.dropped.some(item => item.id === previousId && item.reason === 'shiying_read_failed')) debug.dropped.push({ id: previousId, reason: 'shiying_read_failed' });
      }
    }
    chatSourceIds = new Set(route?.mode === 'detail_recall' ? memorySourceTraceItems(recallItems).map(item => item.memory.id) : []);
    if (currentStateMaterial) {
      const current = await loadMemoryCurrentState(currentStateMaterial.state.id);
      const tracked = statePreparation!.get(currentStateMaterial.state.id)!;
      if (tracked.omitted || !current || current.status !== 'active') { tracked.omitted = true; currentStateMaterial = null; }
      else {
        const version = currentStateVersion(current);
        const material = await loadCurrentStateMaterial(current);
        if (!material) { tracked.omitted = true; currentStateMaterial = null; }
        else if (version !== tracked.version || material.sourceVersion !== tracked.sourceVersion) {
          if (tracked.refreshed) tracked.omitted = true;
          tracked.refreshed = true;
          tracked.version = version;
          tracked.sourceVersion = material.sourceVersion;
          if (scoreCurrentStateText(current, memoryLocalRecallQuery(input)) < CURRENT_STATE_TEXT_THRESHOLD) tracked.omitted = true;
        }
        currentStateMaterial = tracked.omitted ? null : material;
      }
    }
    currentStateResult.items = currentStateMaterial ? [currentStateMaterial.state] : [];
    const oldItems = [...recallItems, ...careItems];
    // Music cards share these reads; this bundle still selects only recall-eligible rows.
    const additionalIds = new Set(additionalMemories.map(memory => memory.id));
    const refreshed = (await materialPreparation.refresh(
      [...oldItems.map(item => item.memory), ...anchorItems, ...additionalMemories]
        .filter((memory, index, all) => all.findIndex(item => item.id === memory.id) === index),
      memory => isMemoryRecallEligible(memory) || additionalIds.has(memory.id) && memory.type !== 'archived',
    )).filter(isMemoryRecallEligible);
    const byId = new Map(refreshed.map(memory => [memory.id, memory]));
    const precise = selectRefreshedMemoryRecallItems(oldItems.filter(item => item.reason !== 'quiet_context'
      && item.reason !== 'suggested_mention'), memoryLocalRecallQuery(input), materialPreparation, refreshed);
    const preciseById = new Map(precise.map(item => [item.memory.id, item]));
    const quietById = source === 'chat' ? new Map(selectRefreshedMemoryRecallItems(
      oldItems.filter(item => item.reason === 'quiet_context'), memoryLocalRecallQuery(input), materialPreparation, refreshed,
      { requireRelevant: true },
    ).map(item => [item.memory.id, item])) : undefined;
    const update = (items: MemoryRecallItem[]) => items.flatMap(item => {
      const memory = byId.get(item.memory.id);
      if (!memory) return [];
      if (item.reason !== 'quiet_context' && item.reason !== 'suggested_mention') return preciseById.get(memory.id) ?? [];
      if (!isBackgroundEligible(memory, Date.now())) return [];
      const quiet = item.reason === 'quiet_context' && quietById ? quietById.get(memory.id) : undefined;
      if (item.reason === 'quiet_context' && quietById && !quiet) return [];
      let score = item.score;
      if (materialPreparation.wasRefreshed(memory.id)) {
        const scored = scoreSurfacingMemory(memory, Date.now());
        if (item.reason === 'suggested_mention') {
          if (!scored || scored.score < 1.05 || memory.lastSurfacedAt && Date.now() - memory.lastSurfacedAt < 7 * DAY_MS) return [];
          score = scored.score;
        } else {
          score = 2.4 + memory.importance / 10 + memory.arousal;
        }
      }
      const comments = materialPreparation.commentsFor(memory.id);
      return [{ ...item, ...quiet, reason: item.reason, recallReasons: item.recallReasons, memory, score, commentsChecked: true,
        latestComment: comments.find(comment => comment.kind === 'dehydration') ?? comments[0] }];
    });
    recallItems = update(recallItems);
    careItems = update(careItems);
    if (recallItems.some(item => materialPreparation.wasRefreshed(item.memory.id))) {
      const preciseSlots = recallItems.filter(item => item.reason !== 'quiet_context' && item.reason !== 'suggested_mention');
      if (!preciseSlots.some(item => item.modelRanked)) {
        preciseSlots.sort(compareMemoryRecallRanks);
        let index = 0;
        recallItems = recallItems.map(item => item.reason === 'quiet_context' || item.reason === 'suggested_mention' ? item : preciseSlots[index++]);
      }
    }
    anchorItems = anchorItems.flatMap(old => {
      const memory = byId.get(old.id);
      return memory && !memory.surfaceMutedAt && isAnchorCoordinate(memory) && scoreAnchor(memory, queryText) > 0.2 ? [memory] : [];
    });
    if (post && postCandidate) {
      const selected: PostRecallSelection = { items: [{ ...postCandidate, snapshot: post, hits: postHits }] };
      await preferConfirmedPostMemories(selected, [...recallItems.map(item => item.memory), ...anchorItems]);
      post = selected.items[0]?.snapshot ?? null;
      postHits = selected.items[0]?.hits ?? [];
      postCandidate = selected.items[0];
    }
    for (const [id, reason] of materialPreparation.reasons) {
      if (!debug.dropped.some(item => item.id === id && item.reason === reason)) debug.dropped.push({ id, reason });
    }
    sourceTrace.details = route?.mode === 'detail_recall' ? memorySourceDetailsFromSnapshots({
      items: recallItems, route, userText: getUserQueryText(input),
    }, new Map([...materialPreparation.sources].filter(([id, snapshot]) => {
      const current = byId.get(id);
      return chatSourceIds.has(id) && current && weeklyTargetHash(snapshot.reference.memory) === weeklyTargetHash(current);
    }))) : [];
    sourceTrace.context = buildSourceTraceContext(sourceTrace.details, currentStateMaterial ? 1200 : 1600);
    sourceTrace.debug.candidates = sourceTrace.details.length;
    sourceTrace.debug.matched = sourceTrace.details.filter(detail => detail.messages.some(message => message.available)).length;
    sourceTrace.debug.missingMessages = sourceTrace.details.reduce((sum, detail) => sum + detail.missingCount, 0);
    throwIfMemoryBundleAborted(options.signal);
  };
  await refreshSelected();
  options.onStage?.('source_trace_ready');
  recordMemoryRetrievalStage(trace, {
    inputCount: route?.mode === 'detail_recall' ? recallItems.length : 0,
    name: 'source_trace',
    outputCount: sourceTrace.details.length,
    startedAt: sourceTraceStartedAt,
  });

  debug.counts = {
    anchors: anchorItems.length,
    backgroundCandidates: rawBackgroundCount,
    backgroundLimit: backgroundPolicy.limit,
    backgroundYield: route?.mode === 'recall' || route?.mode === 'detail_recall'
      ? Math.max(0, rawBackgroundCount - selectedBackgroundCount)
      : 0,
    carePool: careCandidates.length,
    currentStates: currentStateResult.items.length,
    dropped: debug.dropped.length,
    heldCare: Math.max(0, careCandidates.length - selectedSpokenCount),
    preciseCandidates: route?.mode === 'recall' || route?.mode === 'detail_recall' ? rawRecallCount : 0,
    preciseRecall: route?.mode === 'recall' || route?.mode === 'detail_recall' ? selectedRecallCount : 0,
    quietContext: recallItems.filter((item) => item.reason === 'quiet_context').length,
    recall: recallItems.filter((item) => item.reason !== 'quiet_context' && item.reason !== 'suggested_mention').length,
    reflections: reflectionItems.length + (post ? 1 : 0),
    sourceMissingMessages: sourceTrace.debug.missingMessages,
    sourceMissingRange: sourceTrace.debug.missingRange,
    sourceTraceCandidates: sourceTrace.debug.candidates,
    sourceTraceMatched: sourceTrace.debug.matched,
    spokenMention: selectedSpokenCount,
    suggestedMention: selectedSpokenCount,
    suggestedMentionCandidates: rawSpokenCount,
  };

  const memoryMentionItems: MemoryReadReference[] = [];
  if (options.numberMemories) {
    const seen = new Set<string>();
    for (const item of [...recallItems, ...careItems, ...anchorItems.map(memory => ({ memory, reason: 'anchor' as const }))]) {
      if (seen.has(item.memory.id)) continue;
      seen.add(item.memory.id);
      memoryMentionItems.push(item);
    }
    if (currentStateMaterial) memoryMentionItems.push({ targetKind: 'current_state', currentState: currentStateMaterial.state,
      version: currentStateMaterial.version, sourceVersion: currentStateMaterial.sourceVersion });
    if (paper) memoryMentionItems.push(shiyingReadReference(paper));
    if (post) memoryMentionItems.push(postReadReference(post, postHits, postCandidate?.excludedRanges));
  }
  const memoryNumbers = new Map(memoryMentionItems.map((item, index) => [referenceKey(item), index + 1]));
  const renderContext = () => {
    const context = [
      paper ? formatShiyingRecallMaterial(paper, memoryNumbers.get(referenceKey(shiyingReadReference(paper))) ?? 1, 180, memoryLocalRecallQuery(input)) : '',
      currentStateMaterial ? formatCurrentStateMaterial(currentStateMaterial, { sourceChars: 400,
        number: memoryNumbers.get(JSON.stringify(['current_state', currentStateMaterial.state.id])) }) : '',
      buildTemporalMemoryContext(
        recallItems,
        careItems,
        source === 'chat' ? '' : buildLowEnergyCompanionToneInstruction(route?.careNeed),
        memoryNumbers,
        materialPreparation,
        source === 'chat',
      ),
      sourceTrace.context,
      buildAnchorSection(anchorItems, memoryNumbers),
      reflectionItems.length ? recalledPost?.prompt ?? '' : '',
      post ? formatPostRecallMaterial(post, memoryNumbers.get(referenceKey(postReadReference(post))) ?? 1,
        POST_CONTEXT_LIMIT, memoryLocalRecallQuery(input), postHits, postCandidate?.excludedRanges) : '',
    ].filter(Boolean).join('\n\n');
    return source === 'chat' && context
      ? `I 记清是谁做了什么，也分清想做的事和已经发生的事。\n\n${context}` : context;
  };
  throwIfMemoryBundleAborted(options.signal);
  recordMemoryRetrievalStage(trace, {
    inputCount: recall.items.length + currentStateResult.items.length + anchorResult.items.length + reflections.length,
    name: 'context_final',
    outputCount: recallItems.length + careItems.length + currentStateResult.items.length + anchorItems.length + reflectionItems.length + sourceTrace.details.length,
  });
  debug.trace = finishMemoryRetrievalTrace(trace, {
    finalCount: recallItems.length + careItems.length + currentStateResult.items.length + anchorItems.length + reflectionItems.length + sourceTrace.details.length,
    source,
  });
  options.onStage?.('bundle_ready');

  const visibleMemoryIds = new Set<string>();
  const usageReferences = () => {
    const sourceIds = new Set(sourceTrace.details.map(detail => detail.memoryId));
    const references = [...recallItems, ...careItems].flatMap(item => materialPreparation.usageReferences([item.memory], {
      comments: true, sources: sourceIds.has(item.memory.id),
    }));
    for (const reference of materialPreparation.usageReferences(anchorItems)) {
      if (!references.some(item => item.memoryId === reference.memoryId)) references.push(reference);
    }
    return [...new Map(references.map(reference => [reference.memoryId, reference])).values()];
  };
  materialPreparation.assertCurrent();
  const bundle: MemoryBundle = {
    memoryUsageReferences: [],
    context: '',
    visibleMemoryIds,
    memoryMentionItems,
    postContext: reflectionItems.length ? recalledPost?.prompt : undefined,
    postReference: reflectionItems.length ? recalledPost?.reference : undefined,
    recallItems,
    careItems,
    anchorItems,
    currentStateItems: currentStateResult.items,
    reflectionItems,
    debug,
  };
  const publishCurrentMaterials = () => {
    bundle.context = renderContext();
    bundle.recallItems = recallItems;
    bundle.careItems = careItems;
    bundle.anchorItems = anchorItems;
    bundle.currentStateItems = currentStateResult.items;
    bundle.memoryUsageReferences = usageReferences();
    Object.assign(debug.counts, {
      anchors: anchorItems.length,
      currentStates: currentStateResult.items.length,
      shiyingRecords: paper ? 1 : 0,
      reflections: reflectionItems.length + (post ? 1 : 0),
      dropped: debug.dropped.length,
      quietContext: recallItems.filter(item => item.reason === 'quiet_context').length,
      recall: recallItems.filter(item => item.reason !== 'quiet_context' && item.reason !== 'suggested_mention').length,
      preciseRecall: route?.mode === 'recall' || route?.mode === 'detail_recall'
        ? recallItems.filter(item => item.reason !== 'quiet_context' && item.reason !== 'suggested_mention').length : 0,
      sourceTraceCandidates: sourceTrace.debug.candidates, sourceTraceMatched: sourceTrace.debug.matched,
      sourceMissingMessages: sourceTrace.debug.missingMessages,
    });
    visibleMemoryIds.clear();
    if (post) {
      const reference = postReadReference(post, postHits, postCandidate?.excludedRanges), key = referenceKey(reference);
      if (formatPostRecallMaterial(post, memoryNumbers.get(key) ?? 1, POST_CONTEXT_LIMIT, memoryLocalRecallQuery(input), postHits, postCandidate?.excludedRanges)) {
        visibleMemoryIds.add(key);
        const number = memoryNumbers.get(key);
        if (number) memoryMentionItems[number - 1] = reference;
      }
    }
    if (paper) {
      const reference = shiyingReadReference(paper);
      const key = referenceKey(reference);
      if (formatShiyingRecallMaterial(paper, memoryNumbers.get(key) ?? 1, 180, memoryLocalRecallQuery(input))) {
        visibleMemoryIds.add(key);
        const number = memoryNumbers.get(key);
        if (number) memoryMentionItems[number - 1] = reference;
      }
    }
    if (currentStateMaterial) {
      const key = JSON.stringify(['current_state', currentStateMaterial.state.id]);
      visibleMemoryIds.add(key);
      const number = memoryNumbers.get(key);
      if (number) memoryMentionItems[number - 1] = { targetKind: 'current_state', currentState: currentStateMaterial.state,
        version: currentStateMaterial.version, sourceVersion: currentStateMaterial.sourceVersion };
    }
    for (const item of [...recallItems, ...careItems, ...anchorItems.map(memory => ({ memory, reason: 'anchor' as const }))]) {
      visibleMemoryIds.add(item.memory.id);
      const number = memoryNumbers.get(item.memory.id);
      if (number) memoryMentionItems[number - 1] = item;
    }
  };
  bundle.refreshMemoryMaterials = async additionalMemories => {
    // Before transport, the second pass catches changes across asynchronous reads.
    await refreshSelected(additionalMemories);
    await refreshSelected(additionalMemories);
    publishCurrentMaterials();
  };
  // The first pass above already read the selected sources. One further pass is
  // enough to catch changes during it; avoid a third identical preparation pass.
  await refreshSelected();
  publishCurrentMaterials();
  return bundle;
}
