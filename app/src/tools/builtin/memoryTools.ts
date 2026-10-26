import { createToolSuccessResult } from '../toolResult';
import { isBaiyunPostMemory } from '../../posts/baiyunPostContract';
import { MEMORY_CORRECTION_CONTEXT, MEMORY_CORRECTION_EDITABLE_HASH, MEMORY_CORRECTION_VERSION, readMemoryCorrectionContext, readMemoryCorrectionInput, resolveMemoryCorrectionTime } from '../memoryCorrection';
import { weeklyTargetHash } from '../../memory/memoryWeeklyBasis';
import { normalizeStoredMemoryEventTime } from '../../memory/memoryAtomicity';
import { currentMemoryComments } from '../../memory/memoryCurrentMaterials';
import { currentStateSearchRows, shiyingSearchRows, postSearchRows } from '../../memory/memoryReadReference';
import { formatPostRecallMaterial, postReadReference, preferConfirmedPostMemories, type PostRecallSelection } from '../../memory/memoryPostRecall';
import { formatShiyingRecallMaterial, shiyingReadReference, type ShiyingRecallSelection } from '../../memory/memoryShiyingRecall';
import { loadCurrentStateMaterial, formatCurrentStateMaterial } from '../../memory/memoryCurrentStateContext';
import type { MemoryCurrentState } from '../../memory/memoryCurrentStateStore';
import type { JunLuoToolCall, JunLuoToolDefinition, JunLuoToolExecutorContext, JunLuoToolPackage, JunLuoToolResult } from '../toolTypes';
import {
  isOneOf,
  readBooleanInput,
  readNumberInput,
  readOptionalStringInput,
  readStringArrayInput,
  readStringInput,
  validationFailed,
} from './builtinToolValidation';
import type {
  MemoryAnchorKind,
  MemoryComment,
  MemoryConfirmationLevel,
  MemoryCreateOptions,
  MemoryDomain,
  MemoryEdge,
  MemoryEntry,
  MemoryRecallItem,
  MemoryRelationType,
  MemorySemanticType,
  MemorySourceType,
  MemorySourceTraceMode,
  MemorySourceRefInput,
} from '../../memory/memoryStore';

const MEMORY_DOMAINS = ['相处', '称呼', '喜好', '边界', '经历', '约定', '日常', '其他'] as const satisfies readonly MemoryDomain[];
const MEMORY_SOURCE_TYPES = ['manual', 'message', 'digest', 'automatic'] as const satisfies readonly MemorySourceType[];
const MEMORY_RELATION_TYPES = ['triggers', 'causes', 'updates', 'contradicts', 'supports', 'promises', 'blocks', 'belongs_to', 'emotional_echo', 'relates_to'] as const satisfies readonly MemoryRelationType[];
const MEMORY_PREFERENCE_KINDS = ['like', 'dislike', 'boundary', 'name', 'promise', 'identity', 'other'] as const;

type MemorySummary = {
  id: string;
  title: string;
  content: string;
  domain: MemoryDomain;
  tags: string[];
  recallCues: string[];
  importance: number;
  pinned: boolean;
  anchor: boolean;
  anchorKind?: MemoryAnchorKind;
  semanticType: MemorySemanticType;
  understandingSubject?: 'I' | 'you';
  source?: string;
  sourceType: MemorySourceType;
  sourceStartAt?: number;
  sourceEndAt?: number;
  rememberedReason?: string;
  createdAt: number;
  updatedAt: number;
  confirmationLevel: MemoryConfirmationLevel;
  sourceTraceMode: MemorySourceTraceMode;
};

type MemorySearchData = {
  query: string;
  context: string;
  results: Array<{ id: string; title: string; content: string } | MemorySummary & {
    latestComment?: Pick<MemoryComment, 'content' | 'kind' | 'createdAt'>;
    reason: string;
    recallReasons: string[];
    score?: number;
    sources: string[];
  }>;
  sourceTrace?: Awaited<ReturnType<typeof import('../../memory/memorySourceTrace').loadMemorySourceDetails>>;
};

type MemoryGetData = MemorySummary & {
  comments?: MemoryComment[];
  links?: MemoryLinkData[];
  sourceTrace?: Awaited<ReturnType<typeof import('../../memory/memorySourceTrace').loadMemorySourceDetails>>;
};

type MemoryLinkData = {
  direction: 'incoming' | 'outgoing';
  diagnosticTags: string[];
  edge: MemoryEdge;
  memory: MemorySummary;
  note?: string;
};

type MemoryCreateData = {
  content: string;
  domain: MemoryDomain;
  id: string;
  tags: string[];
  title: string;
};

type MemoryUpdateData = {
  id: string;
  title: string;
  domain: MemoryDomain;
  tags: string[];
  updatedFields: string[];
};

type MemoryPreferenceData = MemoryUpdateData & {
  preferenceKind: string;
  created: boolean;
};

function clamp(value: number | undefined, minimum: number, maximum: number, fallback: number) {
  return value === undefined || !Number.isFinite(value) ? fallback : Math.max(minimum, Math.min(maximum, value));
}

function readLimit(call: JunLuoToolCall, fallback: number, max: number) {
  return Math.max(1, Math.min(max, Math.round(readNumberInput(call.input, 'limit') ?? fallback)));
}

function compactMemory(memory: MemoryEntry): MemorySummary {
  return {
    anchor: memory.anchor,
    anchorKind: memory.anchorKind,
    content: memory.content,
    confirmationLevel: memory.confirmationLevel,
    createdAt: memory.createdAt,
    domain: memory.domain,
    id: memory.id,
    importance: memory.importance,
    pinned: memory.pinned,
    recallCues: memory.recallCues,
    rememberedReason: memory.rememberedReason,
    semanticType: memory.semanticType,
    understandingSubject: memory.understandingSubject,
    source: memory.source,
    sourceEndAt: memory.sourceEndAt,
    sourceStartAt: memory.sourceStartAt,
    sourceType: memory.sourceType,
    sourceTraceMode: memory.sourceTraceMode,
    tags: memory.tags,
    title: memory.title,
    updatedAt: memory.updatedAt,
  };
}

async function memoryTimeMaterial(memory: MemoryEntry | null, savedSources?: MemorySourceRefInput[]) {
  const eventTime = memory?.eventTime ? normalizeStoredMemoryEventTime(memory.eventTime) ?? null : null;
  const { loadMemorySourceRefs } = await import('../../memory/memoryStore');
  const sources = memory && eventTime?.timeSourceMessageId
    ? (savedSources ?? await loadMemorySourceRefs(memory.id)).filter(ref => ref.messageId === eventTime.timeSourceMessageId)
    : [];
  const source = sources.length === 1 ? sources[0] : undefined;
  return {
    eventTime,
    timeSource: source && Number.isFinite(new Date(source.messageCreatedAt).getTime()) ? {
      messageId: source.messageId, role: source.role, messageCreatedAt: source.messageCreatedAt,
    } : null,
  };
}

async function resolveToolSourceRef(sourceMessageId?: string) {
  const normalizedId = sourceMessageId?.trim();
  if (!normalizedId) return [];
  const [{ loadChatState }, { buildSingleMemorySourceRef }] = await Promise.all([
    import('../../chat/chatStorage'),
    import('../../memory/memorySourceRefs'),
  ]);
  const state = await loadChatState();
  for (const session of state.sessions) {
    const message = session.messages.find((item) => item.id === normalizedId);
    if (message) return buildSingleMemorySourceRef(session.id, message);
  }
  return null;
}

function linkData(link: { diagnostic: { note?: string; tags: string[] }; direction: 'incoming' | 'outgoing'; edge: MemoryEdge; memory: MemoryEntry }): MemoryLinkData {
  return {
    diagnosticTags: link.diagnostic.tags,
    direction: link.direction,
    edge: link.edge,
    memory: compactMemory(link.memory),
    note: link.diagnostic.note,
  };
}

function buildPatchFields(input: Record<string, unknown>) {
  const patch: Partial<MemoryEntry> = {};
  const updatedFields: string[] = [];
  const setString = (field: 'title' | 'content' | 'rememberedReason') => {
    if (!(field in input)) return;
    const value = readStringInput(input, field);
    if (!value) return;
    patch[field] = value;
    updatedFields.push(field);
  };
  const setNumber = (field: 'importance' | 'valence' | 'arousal', min: number, max: number) => {
    if (!(field in input)) return;
    patch[field] = clamp(readNumberInput(input, field), min, max, field === 'importance' ? 5 : 0.5);
    updatedFields.push(field);
  };
  const setBoolean = (field: 'pinned' | 'digested') => {
    const value = readBooleanInput(input, field);
    if (value === undefined) return;
    patch[field] = value;
    updatedFields.push(field);
  };

  setString('title');
  setString('content');
  setString('rememberedReason');
  if ('domain' in input && isOneOf(input.domain, MEMORY_DOMAINS)) {
    patch.domain = input.domain;
    updatedFields.push('domain');
  }
  if ('tags' in input) {
    patch.tags = readStringArrayInput(input, 'tags') ?? [];
    updatedFields.push('tags');
  }
  if ('recallCues' in input) {
    patch.recallCues = readStringArrayInput(input, 'recallCues') ?? [];
    updatedFields.push('recallCues');
  }
  setNumber('importance', 1, 10);
  setNumber('valence', 0, 1);
  setNumber('arousal', 0, 1);
  setBoolean('pinned');
  setBoolean('digested');
  return { patch, updatedFields };
}

function preferenceDefaults(kind: string): { anchorKind: MemoryAnchorKind; domain: MemoryDomain; semanticType: MemorySemanticType; tags: string[] } {
  if (kind === 'boundary') return { anchorKind: 'boundary', domain: '边界', semanticType: 'preference', tags: ['偏好', '边界'] };
  if (kind === 'name') return { anchorKind: 'name', domain: '称呼', semanticType: 'profile', tags: ['称呼', '偏好'] };
  if (kind === 'promise') return { anchorKind: 'promise', domain: '约定', semanticType: 'profile', tags: ['约定'] };
  if (kind === 'identity') return { anchorKind: 'identity', domain: '相处', semanticType: 'profile', tags: ['身份'] };
  if (kind === 'dislike') return { anchorKind: 'preference', domain: '边界', semanticType: 'preference', tags: ['不喜欢', '偏好'] };
  if (kind === 'like') return { anchorKind: 'preference', domain: '喜好', semanticType: 'preference', tags: ['喜欢', '偏好'] };
  return { anchorKind: 'preference', domain: '喜好', semanticType: 'preference', tags: ['偏好'] };
}

async function loadSourceTraceForItems(items: MemoryRecallItem[], query: string) {
  const { loadMemorySourceDetails } = await import('../../memory/memorySourceTrace');
  return loadMemorySourceDetails({ items, route: null, userText: query });
}

async function executeMemorySearch(call: JunLuoToolCall): Promise<JunLuoToolResult<MemorySearchData>> {
  const query = readStringInput(call.input, 'query');
  if (!query) return validationFailed(call, '缺少记忆搜索 query', '没有查找记忆');
  const limit = readLimit(call, 6, 12);
  const includeSourceTrace = call.input.includeSourceTrace === true;
  const includeArchived = call.input.includeArchived === true;
  const { buildMemoryRecall } = await import('../../memory/memoryRecall');
  const { loadMemories, searchMemoryTextCandidates, formatMemoryRecallItemsContext } = await import('../../memory/memoryStore');
  const currentStateSelection = call.requestedBy === 'chat' ? { items: [] as MemoryCurrentState[] } : undefined;
  const shiyingSelection: ShiyingRecallSelection | undefined = call.requestedBy === 'chat' ? { items: [] } : undefined;
  const postSelection: PostRecallSelection | undefined = call.requestedBy === 'chat' ? { items: [] } : undefined;
  const recall = await buildMemoryRecall(query, { maxResults: limit, touch: false, currentStateSelection, shiyingSelection, postSelection });
  const paperRows: Array<{ id: string; title: string; content: string }> = [];
  for (const { snapshot } of shiyingSelection?.items.slice(0, 1) ?? []) {
    const content = formatShiyingRecallMaterial(snapshot, 1, 2000, query);
    if (!content) continue;
    const row = { id: snapshot.recordId, title: `拾荧纸条｜${snapshot.recordDate}`, content };
    shiyingSearchRows.set(row, shiyingReadReference(snapshot));
    paperRows.push(row);
  }
  const stateRows: Array<{ id: string; title: string; content: string }> = [];
  for (const state of currentStateSelection?.items.slice(0, limit - paperRows.length) ?? []) {
    const material = await loadCurrentStateMaterial(state);
    if (!material) continue;
    const row = { id: state.id, title: state.title, content: formatCurrentStateMaterial(material, { maxChars: 2000, sourceChars: 400 }) };
    currentStateSearchRows.set(row, { targetKind: 'current_state', currentState: state,
      version: material.version, sourceVersion: material.sourceVersion });
    stateRows.push(row);
  }
  const formalLimit = limit - stateRows.length - paperRows.length;
  let items = recall.items.slice(0, formalLimit);
  if (includeArchived && items.length < formalLimit) {
    const scores = await searchMemoryTextCandidates(query, limit * 2);
    const memories = await loadMemories({ includeArchived: true, search: query, currentOnly: true });
    const known = new Set(items.map((item) => item.memory.id));
    items = [
      ...items,
      ...memories
        .filter((memory) => !known.has(memory.id) && !isBaiyunPostMemory(memory))
        .map((memory): MemoryRecallItem => ({
          memory,
          reason: 'text',
          score: Math.max(scores.get(memory.id)?.fts ?? 0, scores.get(memory.id)?.cjk ?? 0),
          sources: ['fts'],
          recallReasons: ['keyword_match'],
        })),
    ].slice(0, formalLimit);
  }
  const sourceTrace = includeSourceTrace ? await loadSourceTraceForItems(items, query) : undefined;
  const postRows: Array<{ id: string; title: string; content: string }> = [];
  if (postSelection && items.length + stateRows.length + paperRows.length < limit) {
    await preferConfirmedPostMemories(postSelection, items.map(item => item.memory));
    const candidate = postSelection.items[0];
    if (candidate) {
      const content = formatPostRecallMaterial(candidate.snapshot, 1, 2000, query, candidate.hits, candidate.excludedRanges);
      if (content) {
        const row = { id: candidate.snapshot.postId, title: candidate.snapshot.material.post.title || '白云苍狗', content };
        postSearchRows.set(row, postReadReference(candidate.snapshot, candidate.hits, candidate.excludedRanges));
        postRows.push(row);
      }
    }
  }
  const total = items.length + stateRows.length + paperRows.length + postRows.length;
  if (!total && shiyingSelection?.failure) throw new Error(`SHIYING_MEMORY_${shiyingSelection.failure.toUpperCase()}`);
  if (!total && postSelection?.failure) throw new Error('POST_MEMORY_READ_FAILED');
  return createToolSuccessResult<MemorySearchData>(call, total ? `查到 ${total} 条候选记忆` : '没有查到候选记忆', {
    context: stateRows.length || paperRows.length || postRows.length ? '' : formatMemoryRecallItemsContext(items),
    query,
    results: [...await Promise.all(items.map(async (item) => ({
      ...compactMemory(item.memory),
      ...(call.requestedBy === 'chat' ? await memoryTimeMaterial(item.memory) : {}),
      latestComment: item.latestComment ? {
        content: item.latestComment.content,
        createdAt: item.latestComment.createdAt,
        kind: item.latestComment.kind,
      } : undefined,
      reason: item.reason,
      recallReasons: item.recallReasons ?? [],
      score: item.score,
      sources: item.sources ?? [],
    }))), ...stateRows, ...paperRows, ...postRows],
    sourceTrace,
  });
}

async function executeMemoryGet(call: JunLuoToolCall, context?: JunLuoToolExecutorContext): Promise<JunLuoToolResult> {
  if (call.requestedBy === 'chat' && context?.memoryRead) return context.memoryRead(call);
  const memoryId = readStringInput(call.input, 'memoryId');
  if (!memoryId) return validationFailed(call, '缺少 memoryId', '没有读取记忆详情');
  const includeComments = call.input.includeComments === true;
  const includeLinks = call.input.includeLinks === true;
  const includeSourceTrace = call.input.includeSourceTrace === true;
  const { loadMemory, loadMemoryComments, loadMemoryGraphLinks, isCurrentMemory } = await import('../../memory/memoryStore');
  const memory = await loadMemory(memoryId);
  if (!memory) return validationFailed(call, `记忆不存在：${memoryId}`, '没有读取记忆详情');
  if (!(await isCurrentMemory(memory))) return validationFailed(call, memory.understandingSubject
    ? '这条认识待核对，暂不提供正文；可以查找相关的原话和经历。'
    : '这篇周回顾待更新，暂不提供旧正文；可以查找相关的原记忆。', '没有读取记忆详情');
  const comments = includeComments ? currentMemoryComments(memory, await loadMemoryComments(memoryId)) : undefined;
  const links = includeLinks ? (await loadMemoryGraphLinks(memoryId, { limit: readLimit(call, 8, 20), minConfidence: readNumberInput(call.input, 'minConfidence') ?? 0, currentOnly: true })).map(linkData) : undefined;
  const sourceTrace = includeSourceTrace ? await loadSourceTraceForItems([{ memory, reason: 'direct', score: 1 }], memory.content) : undefined;
  return createToolSuccessResult<MemoryGetData>(call, `已读取记忆：${memory.title}`, {
    ...compactMemory(memory),
    comments,
    links,
    sourceTrace,
  });
}

async function executeMemoryUpdate(call: JunLuoToolCall): Promise<JunLuoToolResult<MemoryUpdateData>> {
  const memoryId = readStringInput(call.input, 'memoryId');
  if (!memoryId) return validationFailed(call, '缺少 memoryId', '没有更新记忆');
  const { loadMemory, loadMemorySourceRefs, updateMemory } = await import('../../memory/memoryStore');
  const memory = await loadMemory(memoryId);
  if (!memory) return validationFailed(call, `记忆不存在：${memoryId}`, '没有更新记忆');
  const correctionVersion = call.input[MEMORY_CORRECTION_VERSION];
  const correctionHash = call.input[MEMORY_CORRECTION_EDITABLE_HASH];
  const isChatCorrection = call.requestedBy === 'chat' && correctionVersion !== undefined;
  let correctionTime: ReturnType<typeof resolveMemoryCorrectionTime> | undefined;
  let sourceRefs: MemorySourceRefInput[] | undefined;
  if (isChatCorrection) {
    const { [MEMORY_CORRECTION_VERSION]: _version, [MEMORY_CORRECTION_EDITABLE_HASH]: _hash, [MEMORY_CORRECTION_CONTEXT]: rawContext, ...editableInput } = call.input;
    const correctionInput = readMemoryCorrectionInput(editableInput);
    const context = readMemoryCorrectionContext(rawContext);
    if (!correctionInput || !context || context.source.messageId !== call.sourceMessageId) {
      return validationFailed(call, 'MEMORY_CORRECTION_FIELDS_INVALID', '没有更新记忆');
    }
    if (typeof correctionHash !== 'string' || weeklyTargetHash(memory) !== correctionHash || memory.type === 'archived') {
      return validationFailed(call, 'MEMORY_CORRECTION_STALE', '没有更新记忆');
    }
    if (correctionInput.eventTime) {
      correctionTime = resolveMemoryCorrectionTime(correctionInput.eventTime, context);
      if (!correctionTime) return validationFailed(call, 'MEMORY_CORRECTION_FIELDS_INVALID', '没有更新记忆');
    }
    sourceRefs = [...(await loadMemorySourceRefs(memory.id)).filter(ref =>
      ref.sessionId !== context.source.sessionId || ref.messageId !== context.source.messageId), context.source];
  }
  const { patch, updatedFields } = buildPatchFields(call.input);
  if (isChatCorrection && typeof call.input.rememberedReason === 'string') {
    patch.rememberedReason = call.input.rememberedReason.trim();
    if (!updatedFields.includes('rememberedReason')) updatedFields.push('rememberedReason');
  }
  if (correctionTime) {
    patch.eventTime = correctionTime;
    patch.eventAt = correctionTime.startAt;
    updatedFields.push('eventTime');
  }
  if (!updatedFields.length) return validationFailed(call, '没有提供可更新字段', '没有更新记忆');
  let next: MemoryEntry;
  try {
    next = await updateMemory(memory.id, { ...memory, ...patch }, {
      confirmationLevel: 'reviewed',
      expectedEditableHash: isChatCorrection ? correctionHash as string : weeklyTargetHash(memory),
      ...(isChatCorrection ? { writeIntent: 'correction' as const, sourceRefs } : {
        beforeUpdateComment: { content: `工具更新前记录：${memory.title}｜${memory.content.slice(0, 180)}`,
          sourceType: 'chat' as const, kind: 'update' as const, author: 'tool:memory.update' },
      }),
    });
  } catch (error) {
    if (error instanceof Error && ['MEMORY_CORRECTION_STALE', 'MEMORY_EDIT_CONFLICT', 'MEMORY_NOT_FOUND', 'MEMORY_ARCHIVED'].includes(error.message)) {
      return validationFailed(call, error.message, '没有更新记忆');
    }
    throw error;
  }
  return createToolSuccessResult<MemoryUpdateData>(call, `已更新记忆：${next.title}`, {
    domain: next.domain,
    id: memory.id,
    tags: next.tags,
    title: next.title,
    updatedFields,
    ...(isChatCorrection ? {
      content: next.content,
      recallCues: next.recallCues,
      rememberedReason: next.rememberedReason ?? '',
      ...await memoryTimeMaterial(next, sourceRefs),
    } : {}),
  });
}

async function executeMemoryLink(call: JunLuoToolCall): Promise<JunLuoToolResult<{ edge: MemoryEdge; source: MemorySummary; target: MemorySummary }>> {
  const sourceMemoryId = readStringInput(call.input, 'sourceMemoryId');
  const targetMemoryId = readStringInput(call.input, 'targetMemoryId');
  if (!sourceMemoryId || !targetMemoryId) return validationFailed(call, '缺少 sourceMemoryId 或 targetMemoryId', '没有创建记忆关系');
  if (sourceMemoryId === targetMemoryId) return validationFailed(call, '不能把同一条记忆连接到自己', '没有创建记忆关系');
  const { createMemoryEdge, loadMemory } = await import('../../memory/memoryStore');
  const [source, target] = await Promise.all([loadMemory(sourceMemoryId), loadMemory(targetMemoryId)]);
  if (!source || !target) return validationFailed(call, '源记忆或目标记忆不存在', '没有创建记忆关系');
  const edge = await createMemoryEdge({
    confidence: clamp(readNumberInput(call.input, 'confidence'), 0, 1, 0.7),
    reason: readOptionalStringInput(call.input, 'reason') ?? '由工具手动关联',
    relationType: isOneOf(call.input.relationType, MEMORY_RELATION_TYPES) ? call.input.relationType : 'relates_to',
    sourceId: sourceMemoryId,
    targetId: targetMemoryId,
  });
  if (!edge) return validationFailed(call, '记忆关系参数无效', '没有创建记忆关系');
  return createToolSuccessResult(call, `已连接记忆：${source.title} -> ${target.title}`, {
    edge,
    source: compactMemory(source),
    target: compactMemory(target),
  });
}

async function executeMemoryQueryLinks(call: JunLuoToolCall): Promise<JunLuoToolResult<{ memory: MemorySummary; links: MemoryLinkData[] }>> {
  const memoryId = readStringInput(call.input, 'memoryId');
  if (!memoryId) return validationFailed(call, '缺少 memoryId', '没有查询记忆关系');
  const { loadMemory, loadMemoryGraphLinks, isCurrentMemory } = await import('../../memory/memoryStore');
  const memory = await loadMemory(memoryId);
  if (!memory) return validationFailed(call, `记忆不存在：${memoryId}`, '没有查询记忆关系');
  if (!(await isCurrentMemory(memory))) return validationFailed(call, memory.understandingSubject
    ? '这条认识待核对，暂不提供正文；可以查找相关的原话和经历。'
    : '这篇周回顾待更新，暂不提供旧正文；可以查找相关的原记忆。', '没有读取记忆详情');
  const links = (await loadMemoryGraphLinks(memoryId, {
    currentOnly: true,
    limit: readLimit(call, 8, 20),
    minConfidence: readNumberInput(call.input, 'minConfidence') ?? 0,
  })).map(linkData);
  return createToolSuccessResult(call, links.length ? `查到 ${links.length} 条记忆关系` : '没有查到记忆关系', {
    links,
    memory: compactMemory(memory),
  });
}

async function executeMemoryUpdatePreference(call: JunLuoToolCall): Promise<JunLuoToolResult<MemoryPreferenceData>> {
  const content = readStringInput(call.input, 'content');
  if (!content) return validationFailed(call, '缺少偏好内容', '没有更新偏好记忆');
  const kind = isOneOf(call.input.preferenceKind, MEMORY_PREFERENCE_KINDS) ? call.input.preferenceKind : 'other';
  const defaults = preferenceDefaults(kind);
  const title = readOptionalStringInput(call.input, 'title') ?? (content.slice(0, 24) || '偏好记忆');
  const tags = Array.from(new Set([...defaults.tags, ...(readStringArrayInput(call.input, 'tags') ?? [])]));
  const reason = readOptionalStringInput(call.input, 'reason') ?? '用户明确要求更新偏好';
  const memoryId = readOptionalStringInput(call.input, 'memoryId');
  const { createMemory, loadMemory, updateMemory } = await import('../../memory/memoryStore');
  if (memoryId) {
    const memory = await loadMemory(memoryId);
    if (!memory) return validationFailed(call, `记忆不存在：${memoryId}`, '没有更新偏好记忆');
    const next = await updateMemory(memory.id, {
      ...memory,
      anchor: true,
      anchorKind: defaults.anchorKind,
      content,
      domain: defaults.domain,
      pinned: true,
      protected: true,
      recallCues: Array.from(new Set([...memory.recallCues, ...tags, title])),
      rememberedReason: reason,
      semanticType: defaults.semanticType,
      tags,
      title,
    }, { confirmationLevel: 'reviewed', expectedEditableHash: weeklyTargetHash(memory),
      beforeUpdateComment: { content: `偏好更新前记录：${memory.title}｜${memory.content.slice(0, 180)}`,
        sourceType: 'chat', kind: 'update', author: 'tool:memory.update_preference' } });
    return createToolSuccessResult<MemoryPreferenceData>(call, `已更新偏好记忆：${next.title}`, {
      created: false,
      domain: next.domain,
      id: memory.id,
      preferenceKind: kind,
      tags: next.tags,
      title: next.title,
      updatedFields: ['title', 'content', 'domain', 'tags', 'recallCues', 'anchor', 'rememberedReason'],
    });
  }
  const sourceRefs = await resolveToolSourceRef(call.sourceMessageId);
  if (call.sourceMessageId && !sourceRefs) {
    return validationFailed(call, '找不到触发这次更新的真实消息', '没有新增偏好记忆');
  }
  const id = await createMemory({
    anchor: true,
    anchorKind: defaults.anchorKind,
    arousal: clamp(readNumberInput(call.input, 'arousal'), 0, 1, 0.25),
    content,
    digested: false,
    domain: defaults.domain,
    importance: Math.round(clamp(readNumberInput(call.input, 'importance'), 1, 10, 9)),
    pinned: true,
    protected: true,
    recallCues: Array.from(new Set([title, ...tags, ...content.split(/[，。！？、\s]+/).filter((item) => item.length >= 2).slice(0, 4)])),
    rememberedReason: reason,
    resolved: false,
    semanticType: defaults.semanticType,
    source: 'tool:memory.update_preference',
    sourceType: 'automatic',
    stability: 1,
    tags,
    title,
    type: 'dynamic',
    valence: clamp(readNumberInput(call.input, 'valence'), 0, 1, 0.5),
  }, {
    confirmationLevel: 'reviewed',
    sourceRefs: sourceRefs ?? undefined,
    sourceTraceMode: sourceRefs?.length ? 'exact' : 'none',
  });
  return createToolSuccessResult<MemoryPreferenceData>(call, `已新增偏好记忆：${title}`, {
    created: true,
    domain: defaults.domain,
    id,
    preferenceKind: kind,
    tags,
    title,
    updatedFields: ['created'],
  });
}

async function executeMemoryCreate(call: JunLuoToolCall): Promise<JunLuoToolResult<MemoryCreateData>> {
  const content = readStringInput(call.input, 'content');
  if (!content) return validationFailed(call, '缺少记忆内容', '没有创建记忆');

  const domain = isOneOf(call.input.domain, MEMORY_DOMAINS) ? call.input.domain : '其他';
  const title = readOptionalStringInput(call.input, 'title') || content.slice(0, 24) || '未命名记忆';
  const tags = readStringArrayInput(call.input, 'tags') ?? [];
  const recallCues = readStringArrayInput(call.input, 'recallCues') ?? [];
  const sourceType = isOneOf(call.input.sourceType, MEMORY_SOURCE_TYPES) ? call.input.sourceType : 'automatic';
  const sourceStartAt = readNumberInput(call.input, 'sourceStartAt');
  const sourceEndAt = readNumberInput(call.input, 'sourceEndAt');
  const continuationAi = call.input.continuationAi && typeof call.input.continuationAi === 'object'
    ? (call.input.continuationAi as MemoryCreateOptions['continuationAi'])
    : undefined;
  const { createMemory } = await import('../../memory/memoryStore');
  const sourceRefs = await resolveToolSourceRef(call.sourceMessageId);
  if (call.sourceMessageId && !sourceRefs) {
    return validationFailed(call, '找不到要收进记忆本的真实消息', '没有创建记忆');
  }
  const id = await createMemory({
    title,
    content,
    domain,
    tags,
    recallCues,
    importance: Math.round(clamp(readNumberInput(call.input, 'importance'), 1, 10, 5)),
    valence: clamp(readNumberInput(call.input, 'valence'), 0, 1, 0.5),
    arousal: clamp(readNumberInput(call.input, 'arousal'), 0, 1, 0.3),
    pinned: call.input.pinned === true,
    anchor: false,
    type: 'dynamic',
    resolved: false,
    digested: false,
    protected: false,
    sourceType,
    source: readOptionalStringInput(call.input, 'source') ?? 'tool:memory.create',
    sourceStartAt,
    sourceEndAt,
    rememberedReason: readOptionalStringInput(call.input, 'rememberedReason'),
  }, {
    confirmationLevel: sourceRefs?.length ? 'manual' : 'automatic',
    continuationAi,
    sourceRefs: sourceRefs ?? undefined,
    sourceTraceMode: sourceRefs?.length ? 'exact' : 'none',
  });

  return createToolSuccessResult<MemoryCreateData>(call, `已创建记忆：${title}`, {
    content,
    domain,
    id,
    tags,
    title,
  });
}

const memorySearchTool: JunLuoToolDefinition<Record<string, unknown>, MemorySearchData> = {
  id: 'memory.search',
  chatExposure: 'explicit_only',
  proactiveEligible: false,
  packageId: 'memory',
  name: '搜索记忆',
  description: '按查询内容搜索君落本地记忆，返回候选记忆和召回原因。',
  inputSchema: {
    type: 'object',
    required: ['query'],
    properties: {
      query: { type: 'string', description: '要搜索的记忆问题或关键词' },
      limit: { type: 'number', description: '返回数量，1 到 12' },
      includeArchived: { type: 'boolean', description: '是否包含归档记忆' },
      includeSourceTrace: { type: 'boolean', description: '是否尝试返回原文追溯摘要' },
    },
  },
  permission: 'allow',
  riskLevel: 'read',
  readOnly: true,
  executor: executeMemorySearch,
};

const memoryGetTool: JunLuoToolDefinition = {
  id: 'memory.get',
  chatExposure: 'explicit_only',
  proactiveEligible: false,
  packageId: 'memory',
  name: '读取记忆详情',
  description: '读取指定记忆详情，可包含补记、关系线和来源追溯。',
  inputSchema: {
    type: 'object',
    required: ['memoryId'],
    properties: {
      memoryId: { type: 'string', description: '记忆 ID' },
      includeComments: { type: 'boolean', description: '是否包含补记' },
      includeLinks: { type: 'boolean', description: '是否包含记忆关系线' },
      includeSourceTrace: { type: 'boolean', description: '是否尝试返回原文追溯摘要' },
      limit: { type: 'number', description: '关系线返回数量' },
      minConfidence: { type: 'number', description: '关系线最小置信度' },
    },
  },
  permission: 'allow',
  riskLevel: 'read',
  readOnly: true,
  executor: executeMemoryGet,
};

const memoryUpdateTool: JunLuoToolDefinition<Record<string, unknown>, MemoryUpdateData> = {
  id: 'memory.update',
  agentEpochMode: 'bounded_local_commits',
  chatExposure: 'explicit_only',
  proactiveEligible: false,
  packageId: 'memory',
  name: '更新记忆',
  description: '按明确 memoryId 更新本地记忆，并留下更新前补记。',
  inputSchema: {
    type: 'object',
    required: ['memoryId'],
    properties: {
      memoryId: { type: 'string', description: '要更新的记忆 ID' },
      title: { type: 'string', description: '新标题' },
      content: { type: 'string', description: '新正文' },
      domain: { type: 'string', enum: [...MEMORY_DOMAINS], description: '记忆领域' },
      tags: { type: 'array', items: { type: 'string' }, description: '标签列表' },
      recallCues: { type: 'array', items: { type: 'string' }, description: '回忆线索' },
      importance: { type: 'number', description: '重要度，1 到 10' },
      valence: { type: 'number', description: '情绪效价，0 到 1' },
      arousal: { type: 'number', description: '情绪唤醒度，0 到 1' },
      pinned: { type: 'boolean', description: '是否置顶' },
      rememberedReason: { type: 'string', description: '记住原因' },
      digested: { type: 'boolean', description: '是否已消化' },
    },
  },
  permission: 'ask',
  riskLevel: 'write_local',
  readOnly: false,
  executor: executeMemoryUpdate,
};

const memoryLinkTool: JunLuoToolDefinition<Record<string, unknown>, { edge: MemoryEdge; source: MemorySummary; target: MemorySummary }> = {
  id: 'memory.link',
  chatExposure: 'explicit_only',
  proactiveEligible: false,
  packageId: 'memory',
  name: '连接记忆',
  description: '按明确 ID 创建两条记忆之间的关系线。',
  inputSchema: {
    type: 'object',
    required: ['sourceMemoryId', 'targetMemoryId'],
    properties: {
      sourceMemoryId: { type: 'string', description: '源记忆 ID' },
      targetMemoryId: { type: 'string', description: '目标记忆 ID' },
      relationType: { type: 'string', enum: [...MEMORY_RELATION_TYPES], description: '关系类型' },
      confidence: { type: 'number', description: '置信度，0 到 1' },
      reason: { type: 'string', description: '关系说明' },
    },
  },
  permission: 'ask',
  riskLevel: 'write_local',
  readOnly: false,
  executor: executeMemoryLink,
};

const memoryQueryLinksTool: JunLuoToolDefinition<Record<string, unknown>, { memory: MemorySummary; links: MemoryLinkData[] }> = {
  id: 'memory.query_links',
  chatExposure: 'explicit_only',
  proactiveEligible: false,
  packageId: 'memory',
  name: '查询记忆关系',
  description: '查询指定记忆的出入关系线和关联记忆摘要。',
  inputSchema: {
    type: 'object',
    required: ['memoryId'],
    properties: {
      memoryId: { type: 'string', description: '记忆 ID' },
      limit: { type: 'number', description: '返回数量' },
      minConfidence: { type: 'number', description: '最小置信度' },
    },
  },
  permission: 'allow',
  riskLevel: 'read',
  readOnly: true,
  executor: executeMemoryQueryLinks,
};

const memoryUpdatePreferenceTool: JunLuoToolDefinition<Record<string, unknown>, MemoryPreferenceData> = {
  id: 'memory.update_preference',
  chatExposure: 'explicit_only',
  proactiveEligible: false,
  packageId: 'memory',
  name: '更新稳定偏好',
  description: '新增或按明确 memoryId 更新稳定偏好、边界、称呼、约定类记忆。',
  inputSchema: {
    type: 'object',
    required: ['content'],
    properties: {
      content: { type: 'string', description: '偏好或边界正文' },
      title: { type: 'string', description: '偏好记忆标题' },
      preferenceKind: { type: 'string', enum: [...MEMORY_PREFERENCE_KINDS], description: '偏好类型' },
      memoryId: { type: 'string', description: '可选：明确要覆盖的记忆 ID' },
      tags: { type: 'array', items: { type: 'string' }, description: '标签列表' },
      reason: { type: 'string', description: '更新原因' },
      importance: { type: 'number', description: '重要度，1 到 10' },
      valence: { type: 'number', description: '情绪效价，0 到 1' },
      arousal: { type: 'number', description: '情绪唤醒度，0 到 1' },
    },
  },
  permission: 'ask',
  riskLevel: 'write_local',
  readOnly: false,
  executor: executeMemoryUpdatePreference,
};

export const memoryCreateTool: JunLuoToolDefinition<Record<string, unknown>, MemoryCreateData> = {
  id: 'memory.create',
  chatExposure: 'explicit_only',
  proactiveEligible: false,
  packageId: 'memory',
  name: '创建记忆',
  description: '创建一条本地记忆，并返回真实创建出的记忆 ID。',
  inputSchema: {
    type: 'object',
    required: ['content'],
    properties: {
      content: { type: 'string', description: '记忆正文' },
      title: { type: 'string', description: '记忆标题' },
      domain: { type: 'string', enum: [...MEMORY_DOMAINS], description: '记忆领域' },
      tags: { type: 'array', items: { type: 'string' }, description: '标签列表' },
      recallCues: { type: 'array', items: { type: 'string' }, description: '回忆线索' },
      importance: { type: 'number', description: '重要度，1 到 10' },
      valence: { type: 'number', description: '情绪效价，0 到 1' },
      arousal: { type: 'number', description: '情绪唤醒度，0 到 1' },
      pinned: { type: 'boolean', description: '是否置顶为重要记忆' },
      rememberedReason: { type: 'string', description: '记住原因' },
      sourceType: { type: 'string', enum: [...MEMORY_SOURCE_TYPES], description: '记忆来源类型' },
      source: { type: 'string', description: '记忆来源标识' },
      sourceStartAt: { type: 'number', description: '来源开始时间，毫秒时间戳' },
      sourceEndAt: { type: 'number', description: '来源结束时间，毫秒时间戳' },
    },
  },
  permission: 'ask',
  riskLevel: 'write_local',
  readOnly: false,
  executor: executeMemoryCreate,
};

export const memoryToolPackage: JunLuoToolPackage = {
  id: 'memory',
  name: '记忆',
  description: '创建、搜索、读取、更新和连接君落本地记忆。',
  category: 'local_write',
  tools: [
    memoryCreateTool,
    memorySearchTool,
    memoryGetTool,
    memoryUpdateTool,
    memoryLinkTool,
    memoryQueryLinksTool,
    memoryUpdatePreferenceTool,
  ],
  defaultEnabled: true,
  riskLevel: 'write_local',
  source: 'builtin',
};
