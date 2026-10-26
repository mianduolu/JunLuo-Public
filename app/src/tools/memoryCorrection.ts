import type { JunLuoRegisteredToolDefinition, JunLuoToolResult } from './toolTypes';
import type { JunLuoToolInvocation } from './toolCallProtocol';
import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import { formatMemoryEventTimeLabel, normalizeModelMemoryEventTime, normalizeStoredMemoryEventTime, type MemoryEventTime } from '../memory/memoryAtomicity';
import { formatMemoryEventTimeInput, parseManualMemoryEventTime } from '../memory/memoryCalendarTime';
import { buildSingleMemorySourceRef, type MemorySourceRefInput } from '../memory/memorySourceRefs';
import { weeklyTargetHash } from '../memory/memoryWeeklyBasis';
import type { MemoryEntry } from '../memory/memoryStore';
import { shiyingSearchRows, currentStateSearchRows, postSearchRows } from '../memory/memoryReadReference';
import {
  amendToolAgentFrozenProposal,
  getToolAgentFrozenProposalInput,
  toolAgentFrozenProposalStore,
  type JunLuoToolAgentConfirmationPresentation,
} from './toolAgentFrozenProposal';

// Host-only input, populated from this turn's search result, never a model parameter.
export const MEMORY_CORRECTION_VERSION = '__memoryCorrectionExpectedUpdatedAt';
export const MEMORY_CORRECTION_EDITABLE_HASH = '__memoryCorrectionEditableHash';
export const MEMORY_CORRECTION_CONTEXT = '__memoryCorrectionContext';
export const MEMORY_CORRECTION_PRESENTER_ID = 'builtin.memory.update';

type MemoryCorrectionContext = { source: MemorySourceRefInput; manualTime?: boolean };
type MemoryCorrectionTime = Omit<MemoryEventTime, 'timeSourceMessageId'>;
const unknownTime: MemoryEventTime = { precision: 'unknown', basis: 'unknown' };

export type MemoryCorrectionOriginal = {
  id: string;
  title: string;
  content: string;
  tags: string[];
  recallCues: string[];
  rememberedReason?: string;
  updatedAt: number;
  eventTime?: MemoryEventTime;
};

function correctionOriginalMaterial(memory: MemoryCorrectionOriginal) {
  return JSON.stringify([memory.title, memory.content, memory.tags, memory.recallCues,
    memory.rememberedReason ?? '', memory.eventTime ? normalizeStoredMemoryEventTime(memory.eventTime) : null]);
}

export function chatMemoryCorrectionDefinition(tool: JunLuoRegisteredToolDefinition): JunLuoRegisteredToolDefinition {
  return {
    ...tool,
    description: `I 先查到 you 要改的那条记忆，再改标题、正文或发生时间。
改了发生时间，正文里的旧时间也一起改。
I 也核对标签、回想线索和记住它的理由，让它们和改好的记忆一致。
分不清要改哪条时，I 先问 you。先给出修改草稿。`,
    inputSchema: {
      type: 'object', required: ['item', 'tags', 'recallCues', 'rememberedReason'],
      properties: {
        item: { type: 'number', description: 'I 填本轮记忆搜索结果中的编号。' },
        title: { type: 'string', description: '修正后的标题。' },
        content: { type: 'string', description: '修正后的记忆内容。' },
        tags: { type: 'array', items: { type: 'string' }, description: '核对后的全部标签；没有则填空数组。' },
        recallCues: { type: 'array', items: { type: 'string' }, description: '核对后的全部回想线索；没有则填空数组。' },
        rememberedReason: { type: 'string', description: '核对后，I 为什么记住这件事；没有则填空字符串。' },
        eventTime: {
          type: 'object',
          description: '不改发生时间就不填。仍不确定时，precision 和 basis 填 unknown，日期不填，保留 you 的时间说法。相对时间按 you 这次发言的日期计算。',
          required: ['precision', 'basis'],
          properties: {
            precision: { type: 'string', enum: ['instant', 'day', 'range', 'unknown'] },
            basis: { type: 'string', enum: ['explicit', 'relative', 'source_message', 'unknown'] },
            startAt: { type: 'number', description: '发生时间的起点，Unix 毫秒；日期未定时省略。' },
            endAt: { type: 'number', description: '时间范围的终点，Unix 毫秒；不是范围时省略。' },
            timeExpression: { type: 'string', description: '本轮 you 原话中最终采用的时间说法，没有时留空。' },
          },
        },
      },
    },
  };
}

export function readMemoryCorrectionInput(input: Readonly<Record<string, unknown>>) {
  if (Object.keys(input).some((key) => !['memoryId', 'title', 'content', 'eventTime', 'tags', 'recallCues', 'rememberedReason'].includes(key))) return null;
  if (typeof input.memoryId !== 'string' || !input.memoryId.trim()) return null;
  if (!Array.isArray(input.tags) || !input.tags.every(value => typeof value === 'string')
    || !Array.isArray(input.recallCues) || !input.recallCues.every(value => typeof value === 'string')
    || typeof input.rememberedReason !== 'string') return null;
  const metadata = {
    tags: input.tags.map(value => value.trim()).filter(Boolean),
    recallCues: input.recallCues.map(value => value.trim()).filter(Boolean),
    rememberedReason: input.rememberedReason.trim(),
  };
  const patch: { title?: string; content?: string; eventTime?: MemoryCorrectionTime } = {};
  for (const field of ['title', 'content'] as const) {
    if (!(field in input) || input[field] == null) continue;
    if (typeof input[field] !== 'string' || !input[field].trim()) return null;
    patch[field] = input[field].trim();
  }
  if (input.eventTime != null) {
    if (!patch.content || typeof input.eventTime !== 'object' || Array.isArray(input.eventTime)) return null;
    const time = input.eventTime as Record<string, unknown>;
    if (Object.keys(time).some(key => !['precision', 'basis', 'startAt', 'endAt', 'timeExpression'].includes(key))) return null;
    if (!['instant', 'day', 'range', 'unknown'].includes(String(time.precision))
      || !['explicit', 'relative', 'source_message', 'unknown'].includes(String(time.basis))) return null;
    for (const key of ['startAt', 'endAt'] as const) {
      if (time[key] != null && (typeof time[key] !== 'number' || !Number.isFinite(new Date(time[key]).getTime()))) return null;
    }
    if (time.timeExpression != null && typeof time.timeExpression !== 'string') return null;
    patch.eventTime = {
      precision: time.precision as MemoryCorrectionTime['precision'], basis: time.basis as MemoryCorrectionTime['basis'],
      ...(typeof time.startAt === 'number' ? { startAt: time.startAt } : {}),
      ...(typeof time.endAt === 'number' ? { endAt: time.endAt } : {}),
      ...(typeof time.timeExpression === 'string' ? { timeExpression: time.timeExpression.trim() } : {}),
    };
  }
  return { memoryId: input.memoryId.trim(), ...patch, ...metadata };
}

export function readMemoryCorrectionContext(value: unknown): MemoryCorrectionContext | null {
  if (!value || typeof value !== 'object') return null;
  const context = value as MemoryCorrectionContext;
  const source = context.source;
  if (!source || typeof source.sessionId !== 'string' || !source.sessionId.trim()
    || typeof source.messageId !== 'string' || !source.messageId.trim() || source.role !== 'you'
    || source.relation !== 'direct' || typeof source.excerpt !== 'string'
    || !Number.isFinite(new Date(source.messageCreatedAt).getTime())) return null;
  return context;
}

export function resolveMemoryCorrectionTime(time: MemoryCorrectionTime, context: MemoryCorrectionContext): MemoryEventTime | null {
  if (context.manualTime) return normalizeStoredMemoryEventTime(time) ?? { ...unknownTime };
  const source = context.source;
  const normalized = normalizeModelMemoryEventTime({ ...time, timeSourceMessageId: source.messageId }, {
    sourceMessages: [{ id: source.messageId, createdAt: source.messageCreatedAt, content: source.excerpt! }],
  });
  if (normalized) return normalized;
  return (time.precision === 'unknown' || time.basis === 'unknown') && !time.timeExpression
    ? { ...unknownTime, timeSourceMessageId: source.messageId }
    : null;
}

export function memoryCorrectionFailure(invocation: JunLuoToolInvocation, reason: string): JunLuoToolResult {
  const now = Date.now();
  return {
    callId: invocation.callId, toolId: invocation.toolId,
    ok: false, status: 'error', summary: '没有更新记忆',
    error: { code: 'VALIDATION_FAILED', message: reason },
    startedAt: now, finishedAt: now,
  };
}

export function memoryCorrectionPresentation(
  original: MemoryCorrectionOriginal,
  input: Readonly<Record<string, unknown>>,
): JunLuoToolAgentConfirmationPresentation {
  const context = readMemoryCorrectionContext(input[MEMORY_CORRECTION_CONTEXT]);
  const editedTime = input.eventTime as MemoryCorrectionTime | undefined;
  const eventTime = editedTime && context ? resolveMemoryCorrectionTime(editedTime, context) : original.eventTime;
  return {
    title: '修正记忆',
    fields: [
      { label: '原标题', value: original.title },
      { label: '原正文', value: original.content },
      { label: '原发生时间', value: formatMemoryEventTimeLabel(original.eventTime) || '时间未确定' },
      { label: '原标签', value: original.tags.join('、') },
      { label: '原回想线索', value: original.recallCues.join('、') },
      { label: '原记住的理由', value: original.rememberedReason ?? '' },
      { label: '新标题', value: typeof input.title === 'string' ? input.title : original.title },
      { label: '新正文', value: typeof input.content === 'string' ? input.content : original.content },
      { label: '新发生时间', value: formatMemoryEventTimeInput(eventTime ?? undefined) },
      { label: '新标签', value: (input.tags as string[]).join('、') },
      { label: '新回想线索', value: (input.recallCues as string[]).join('、') },
      { label: '新记住的理由', value: input.rememberedReason as string },
      ...(context ? [{ label: '本次依据', value: `${new Date(context.source.messageCreatedAt).toLocaleString('zh-CN')} · ${context.source.excerpt}` }] : []),
    ],
  };
}

export function createMemoryCorrectionTurnBinding(source?: { sessionId: string; message?: SubjectiveMessage }) {
  const originals = new Map<string, MemoryCorrectionOriginal>();
  const sourceRef = source?.message?.role === 'you'
    ? buildSingleMemorySourceRef(source.sessionId, source.message)[0] : undefined;
  const context = readMemoryCorrectionContext({ source: sourceRef });
  return {
    remember(result: JunLuoToolResult) {
      if (result.toolId !== 'memory.search' || !result.ok) return;
      const data = result.data as { results?: unknown[] } | undefined;
      if (!Array.isArray(data?.results)) return;
      for (const value of data.results) {
        if (value && typeof value === 'object' && (shiyingSearchRows.has(value) || currentStateSearchRows.has(value) || postSearchRows.has(value))) continue;
        const item = value as Partial<MemoryCorrectionOriginal> | null;
        if (!item || typeof item.id !== 'string' || typeof item.title !== 'string'
          || typeof item.content !== 'string' || typeof item.updatedAt !== 'number'
          || !Number.isFinite(item.updatedAt) || !Array.isArray(item.tags) || !Array.isArray(item.recallCues)) continue;
        originals.set(item.id, { id: item.id, title: item.title, content: item.content, updatedAt: item.updatedAt,
          tags: [...item.tags], recallCues: [...item.recallCues], rememberedReason: item.rememberedReason,
          eventTime: item.eventTime ? normalizeStoredMemoryEventTime(item.eventTime) : undefined });
      }
    },
    original(id: unknown) { return typeof id === 'string' ? originals.get(id) : undefined; },
    replaceOriginal(memory: MemoryEntry) {
      originals.set(memory.id, { ...memory });
    },
    prepare(invocation: JunLuoToolInvocation, searchedMemory?: MemoryEntry) {
      const { item, ...fields } = invocation.input;
      const original = searchedMemory && originals.get(searchedMemory.id);
      // Only the host's actually delivered search binding can translate a model's short number.
      const input = original && correctionOriginalMaterial(original) === correctionOriginalMaterial(searchedMemory!)
        && typeof item === 'number' && Number.isSafeInteger(item) && item > 0 && !('memoryId' in fields)
        ? readMemoryCorrectionInput({ ...fields, memoryId: original.id }) : null;
      if (!input || !original || !context) {
        return { kind: 'rejected' as const, result: memoryCorrectionFailure(invocation, 'MEMORY_CORRECTION_TARGET_OR_FIELDS_INVALID') };
      }
      if (input.eventTime) {
        const normalized = resolveMemoryCorrectionTime(input.eventTime, context);
        if (!normalized) return { kind: 'rejected' as const, result: memoryCorrectionFailure(invocation, 'MEMORY_CORRECTION_TARGET_OR_FIELDS_INVALID') };
        const { timeSourceMessageId: _sourceId, ...time } = normalized;
        input.eventTime = time;
      }
      return { kind: 'ready' as const, input: {
        title: original.title, content: original.content, ...input,
        [MEMORY_CORRECTION_VERSION]: searchedMemory!.updatedAt,
        [MEMORY_CORRECTION_EDITABLE_HASH]: weeklyTargetHash(searchedMemory!),
        [MEMORY_CORRECTION_CONTEXT]: context,
      } };
    },
  };
}

export function amendMemoryCorrectionConfirmation(input: {
  proposalId: string; title: string; content: string; eventTimeText?: string;
  tagsText?: string; recallCuesText?: string; rememberedReason?: string;
}) {
  const current = getToolAgentFrozenProposalInput(input.proposalId);
  const proposal = toolAgentFrozenProposalStore.get(input.proposalId);
  if (!current || proposal?.toolId !== 'memory.update') return null;
  const context = readMemoryCorrectionContext(current[MEMORY_CORRECTION_CONTEXT]);
  const timePatch = input.eventTimeText !== undefined && context ? {
    eventTime: parseManualMemoryEventTime(input.eventTimeText) ?? { ...unknownTime },
    [MEMORY_CORRECTION_CONTEXT]: { ...context, manualTime: true },
  } : {};
  const splitTerms = (text: string) => text.split(/[，,、\s]+/).map(value => value.trim()).filter(Boolean);
  const metadataPatch = {
    ...(input.tagsText !== undefined ? { tags: splitTerms(input.tagsText) } : {}),
    ...(input.recallCuesText !== undefined ? { recallCues: splitTerms(input.recallCuesText) } : {}),
    ...(input.rememberedReason !== undefined ? { rememberedReason: input.rememberedReason } : {}),
  };
  return amendToolAgentFrozenProposal({
    proposalId: input.proposalId, toolId: 'memory.update',
    rawInput: { ...current, title: input.title, content: input.content, ...timePatch, ...metadataPatch },
    presentation: {
      ...proposal.presentation,
      fields: proposal.presentation.fields.map((field) => (
        field.label === '新标题' ? { ...field, value: input.title }
          : field.label === '新正文' ? { ...field, value: input.content }
            : field.label === '新发生时间' && input.eventTimeText !== undefined ? { ...field, value: input.eventTimeText }
              : field.label === '新标签' && input.tagsText !== undefined ? { ...field, value: input.tagsText }
                : field.label === '新回想线索' && input.recallCuesText !== undefined ? { ...field, value: input.recallCuesText }
                  : field.label === '新记住的理由' && input.rememberedReason !== undefined ? { ...field, value: input.rememberedReason } : field
      )),
    },
  });
}
