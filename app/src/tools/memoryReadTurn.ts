import { loadMemoryReadSnapshot, loadCurrentStateReadSnapshot, loadShiyingReadSnapshot, loadPostReadSnapshot, type AnyMemoryReadSnapshot as MemoryReadSnapshot, type MemoryReadView } from '../memory/memoryReadMaterials';
import { isCurrentStateReference, isMemoryReference, isShiyingReference, isPostReference, referenceId, referenceKey, currentStateSearchRows, shiyingSearchRows, postSearchRows, type MemoryReadReference } from '../memory/memoryReadReference';
import { formatPostRecallMaterial, preferConfirmedPostMemories, selectPostRecall, type PostRecallSelection } from '../memory/memoryPostRecall';
import { currentStateVersion } from '../memory/memoryCurrentStateStore';
import { formatCurrentStateMaterial } from '../memory/memoryCurrentStateContext';
import { formatShiyingRecallMaterial, scoreShiyingText, SHIYING_TEXT_THRESHOLD } from '../memory/memoryShiyingRecall';
import { weeklyTargetHash, type WeeklyDatabase } from '../memory/memoryWeeklyBasis';
import type { JunLuoToolAgentInvocationPreparation } from './toolAgentLoop';
import type { JunLuoToolInvocation } from './toolCallProtocol';
import { createToolErrorResult, createToolSuccessResult } from './toolResult';
import type { JunLuoToolCall, JunLuoToolResult } from './toolTypes';
import type { OpenAiCompatibleContinuationMessage } from '../ai/openAiCompatibleProvider';
import { memorySourceStatusLabel } from '../memory/memorySourceStatus';
import type { PostMemoryReadOptions } from '../posts/baiyunPostMemorySource';
import { isObservationMemorySource } from '../memory/memorySourceReader';
import { getObservationMaterialLength, prepareObservationFragment } from '../memory/memoryObservationIngestion';
import { memorySourceTracePartContent, observationSourcePartsVersion, observationSourceTraceVersions } from '../memory/memorySourceTrace';

const PAGE_TEXT_LIMIT = 3000;
const PAGE_RESULT_LIMIT = 7000;
const SEARCH_RESULT_LIMIT = 12000;
type Range = { part: number; start: number; end: number };
type Cursor = { item: number; view: MemoryReadView; version: string; ranges: Range[] };
type VisibleRead = { item: number; snapshot: MemoryReadSnapshot; searchRow?: object; sourceRefreshed?: boolean; query?: string; postContents?: Set<string> };
type DeliveredSnapshot = MemoryReadSnapshot & { fromSearch: boolean };
type ResultMessage = { kind: string; callId?: string; toolId?: string; content?: string };

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function duplicatesSearchRows(context: unknown, rows: Record<string, unknown>[]) {
  if (typeof context !== 'string' || !rows.length) return false;
  const lines: string[] = [];
  for (const row of rows) {
    if (typeof row.content !== 'string' || row.contentTruncated || 'contentPreview' in row
      || typeof row.reason !== 'string' || !Array.isArray(row.tags) || !row.tags.every(tag => typeof tag === 'string')) return false;
    const comment = object(row.latestComment);
    if (row.latestComment != null && (!comment || typeof comment.content !== 'string'
      || typeof comment.createdAt !== 'number' || !Number.isFinite(comment.createdAt)
      || !['comment', 'feel', 'merge', 'daily_impression', 'correction', 'update', 'confirmation'].includes(String(comment.kind)))) return false;
    // Match the existing formatter exactly; unknown wrappers and dehydration explanations stay intact.
    lines.push(`- [${row.reason}] ${row.content}${row.tags.length ? ` [标签: ${row.tags.join('、')}]` : ''}`
      + (comment ? `\n  后来补记：${comment.content}` : ''));
  }
  return context === lines.join('\n');
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  const record = object(value);
  return record ? Object.fromEntries(Object.keys(record).sort().map(key => [key, canonical(record[key])])) : value;
}

function readCard(snapshot: MemoryReadSnapshot) {
  const reference = snapshot.reference;
  if (isPostReference(reference)) return { id: reference.post.postId, title: reference.post.material.post.title || '白云苍狗',
    sourceTraceMode: 'exact', understandingSubject: undefined, eventTime: undefined };
  if (isShiyingReference(reference)) return { id: reference.shiying.recordId, title: `拾荧纸条｜${reference.shiying.recordDate}`,
    sourceTraceMode: 'exact', understandingSubject: undefined, eventTime: undefined };
  return isCurrentStateReference(reference)
    ? { ...reference.currentState, title: `近况：${reference.currentState.title}`, sourceTraceMode: 'exact', understandingSubject: undefined, eventTime: undefined }
    : reference.memory;
}
function targetVersion(reference: MemoryReadReference) {
  return isCurrentStateReference(reference) ? currentStateVersion(reference.currentState)
    : isShiyingReference(reference) || isPostReference(reference) ? reference.version : weeklyTargetHash(reference.memory);
}
function readSnapshot(reference: MemoryReadReference, view: MemoryReadView, database?: WeeklyDatabase,
  postOptions: PostMemoryReadOptions = {}) {
  return isCurrentStateReference(reference) ? loadCurrentStateReadSnapshot(reference.currentState.id, view, database, undefined, { postOptions })
    : isShiyingReference(reference) ? loadShiyingReadSnapshot(reference.shiying.recordId, view)
    : isPostReference(reference) ? loadPostReadSnapshot(reference.post.postId, view, { ...postOptions, database }).then(snapshot =>
      typeof snapshot === 'string' ? snapshot : { ...snapshot, reference: { ...snapshot.reference,
        hits: snapshot.version === reference.version ? reference.hits : undefined,
        excludedRanges: snapshot.version === reference.version ? reference.excludedRanges : undefined } })
    : loadMemoryReadSnapshot(referenceId(reference), view, database, undefined, postOptions);
}
function sourceTraceMatches(detail: Record<string, unknown>, snapshot: MemoryReadSnapshot) {
  const observationVersion = observationSourceTraceVersions.get(detail);
  if (observationVersion !== observationSourcePartsVersion(snapshot.parts)) return false;
  return detail.mode === readCard(snapshot).sourceTraceMode && Array.isArray(detail.messages)
    && (detail.messages.length > 0 || snapshot.parts.length === 0)
    && detail.messages.every(value => {
      const message = object(value);
      const part = snapshot.parts.find(candidate => candidate.sessionId === message?.sessionId
        && candidate.messageId === message?.messageId && candidate.role === message?.role);
      return message && part && message.content === memorySourceTracePartContent(part)
        && message.context === part.context
        && ['createdAt', 'available', 'retainedExcerpt', 'sourceStatus', 'sourceLabel'].every(key => message[key] === part[key as keyof typeof part])
        && message.relation === part.relation;
    });
}

function wholeCharacterEnd(content: string, end: number) {
  return end > 0 && /[\uD800-\uDBFF]/.test(content[end - 1]) && /[\uDC00-\uDFFF]/.test(content[end] ?? '') ? end - 1 : end;
}

export function memoryReadResultSize(result: JunLuoToolResult) {
  return JSON.stringify({ ok: result.ok, status: result.status,
    summary: result.summary.slice(0, 1200), ...(result.data === undefined ? {} : { data: result.data }),
    ...(result.error ? { errorCode: result.error.code } : {}) }).length;
}

function failure(call: JunLuoToolCall, code: string) {
  return createToolErrorResult(call, { code: 'VALIDATION_FAILED', message: code === 'understanding_stale'
    ? '这条认识待核对，暂不提供正文；可以查找相关的原话和经历。'
    : code === 'weekly_stale' ? '这篇周回顾待更新，暂不提供旧正文；可以查找相关的原记忆。' : code }, '没有读取记忆详情');
}

function firstRanges(snapshot: MemoryReadSnapshot, focus: string): Range[] {
  const ranges = snapshot.parts.map((part, index) => ({ part: index, start: 0,
    end: part.observationRecord ? getObservationMaterialLength(part.observationRecord) : part.content.length }));
  const aroundPost = (index: number, start: number) => {
    const prior = index > 1 ? { ...ranges[index - 1],
      start: wholeCharacterEnd(snapshot.parts[index - 1].content, Math.max(0, ranges[index - 1].end - 160)) } : undefined;
    const parentEnd = index > 0 ? wholeCharacterEnd(snapshot.parts[0].content, Math.min(160, ranges[0].end)) : 0;
    return [...(index > 0 ? [{ ...ranges[0], end: parentEnd }] : []),
      ...(prior ? [prior] : []), { ...ranges[index], start }, ...ranges.slice(index + 1),
      ...ranges.slice(index > 0 ? 1 : 0, prior ? index - 1 : index),
      ...(index > 0 && ranges[0].end > parentEnd ? [{ ...ranges[0], start: parentEnd }] : []),
      ...(prior?.start ? [{ ...ranges[index - 1], end: prior.start }] : []),
      ...(start ? [{ ...ranges[index], end: start }] : [])];
  };
  const terms = [...new Set([focus.trim(), ...focus.split(/[\s，。；！？,.;!?]+/u)].filter(Boolean))].slice(0, 12);
  for (const term of terms) {
    const pattern = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu');
    for (let index = 0; index < ranges.length; index++) {
      if (isObservationMemorySource(snapshot.parts[index].sessionId ?? '')) continue;
      const hit = pattern.exec(snapshot.parts[index].content);
      if (!hit) continue;
      const start = wholeCharacterEnd(snapshot.parts[index].content, Math.max(0, hit.index - 160));
      if (isPostReference(snapshot.reference)) return aroundPost(index, start);
      return [{ ...ranges[index], start }, ...ranges.slice(index + 1), ...ranges.slice(0, index),
        ...(start ? [{ ...ranges[index], end: start }] : [])];
    }
  }
  if (isPostReference(snapshot.reference)) {
    const hit = snapshot.reference.hits?.find(hit => snapshot.parts.some(part => part.messageId === hit.sourceId && part.sourceHash === hit.sourceHash));
    const index = hit ? snapshot.parts.findIndex(part => part.messageId === hit.sourceId) : -1;
    if (hit && index >= 0) {
      const start = wholeCharacterEnd(snapshot.parts[index].content, Math.max(0, hit.start - 160));
      return aroundPost(index, start);
    }
  }
  return ranges;
}

function pageResult(call: JunLuoToolCall, snapshot: MemoryReadSnapshot, item: number, ranges: Range[], cursor: string, modelCallId: string) {
  const memory = readCard(snapshot);
  const remaining = ranges.map(range => ({ ...range }));
  const parts: Array<Omit<MemoryReadSnapshot['parts'][number], 'sourceHash' | 'observationRecord' | 'observationBinding'>
    & { start?: number; end?: number; totalLength?: number }> = [];
  const result = () => createToolSuccessResult(call, `已读取记忆：${memory.title.slice(0, 120)}`, {
    item, id: memory.id, title: memory.title.slice(0, 240), view: snapshot.view,
    ...(memory.understandingSubject ? { understandingSubject: memory.understandingSubject } : {}),
    eventTime: memory.eventTime, sourceTraceMode: memory.sourceTraceMode,
    ...(snapshot.view === 'source' && !snapshot.parts.length
      ? { sourceStatus: 'missing' as const, sourceLabel: memorySourceStatusLabel.missing } : {}),
    parts: isPostReference(snapshot.reference) ? [...parts].sort((left, right) =>
      snapshot.parts.findIndex(part => part.messageId === left.messageId) - snapshot.parts.findIndex(part => part.messageId === right.messageId)
        || (left.start ?? 0) - (right.start ?? 0)) : parts,
    hasMore: remaining.length > 0, nextCursor: remaining.length ? cursor : null,
  });
  const sizeOfResult = () => memoryReadResultSize({ ...result(), callId: modelCallId });
  let textLeft = PAGE_TEXT_LIMIT;
  while (remaining.length && textLeft > 0) {
    const range = remaining[0], part = snapshot.parts[range.part];
    const { sourceHash: _sourceHash, observationRecord: _observationRecord,
      observationBinding: _observationBinding, ...publicPart } = part;
    if (isObservationMemorySource(part.sessionId ?? '')) {
      let budget = textLeft;
      let observation = part.observationRecord ? prepareObservationFragment(part.observationRecord, range.start, budget) : undefined;
      let content = observation?.content ?? (part.observationRecord ? '' : part.content);
      if ((!content && part.observationRecord) || content.length > textLeft) break;
      parts.push({ ...publicPart, content });
      while (sizeOfResult() > PAGE_RESULT_LIMIT && observation) {
        budget -= Math.max(1, sizeOfResult() - PAGE_RESULT_LIMIT);
        observation = prepareObservationFragment(part.observationRecord!, range.start, budget) ?? undefined;
        if (!observation) break;
        content = observation.content;
        parts[parts.length - 1] = { ...publicPart, content };
      }
      if (sizeOfResult() > PAGE_RESULT_LIMIT || part.observationRecord && !observation) { parts.pop(); break; }
      textLeft -= content.length;
      range.start = observation?.binding.end ?? range.end;
      if (range.start === range.end) remaining.shift(); else break;
      continue;
    }
    let size = Math.min(textLeft, range.end - range.start);
    const makePart = (length: number) => ({ ...publicPart, content: part.content.slice(range.start, range.start + length),
      start: range.start, end: range.start + length, totalLength: part.content.length });
    parts.push(makePart(size));
    if (sizeOfResult() > PAGE_RESULT_LIMIT) {
      let low = 0, high = size;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        parts[parts.length - 1] = makePart(middle);
        if (sizeOfResult() <= PAGE_RESULT_LIMIT) low = middle; else high = middle - 1;
      }
      size = low;
      parts[parts.length - 1] = makePart(size);
      if ((size === 0 && range.end > range.start) || sizeOfResult() > PAGE_RESULT_LIMIT) {
        parts.pop();
        break;
      }
    }
    size = wholeCharacterEnd(part.content, range.start + size) - range.start;
    parts[parts.length - 1] = makePart(size);
    if (!size && range.end > range.start) { parts.pop(); break; }
    textLeft -= size;
    range.start += size;
    if (range.start === range.end) remaining.shift(); else break;
  }
  if (remaining.length && !parts.length) return undefined;
  return { result: result(), remaining };
}

/** One ordinary reply owns this binding. Nothing here is persisted or shared with another turn. */
export function createMemoryReadTurn(input: { references?: readonly MemoryReadReference[]; canRead: () => boolean }) {
  const references = [...(input.references ?? [])];
  const numbers = new Map(references.map((reference, index) => [referenceKey(reference), index + 1]));
  const visibleMemoryIds = new Set(references.map(reference => referenceKey(reference)));
  const delivered = new Map<number, Map<MemoryReadView, DeliveredSnapshot>>();
  const readsByCall = new Map<string, VisibleRead[]>();
  const observedCalls = new Set<string>();
  const cursors = new Map<string, Cursor>();
  const scope = Math.random().toString(36).slice(2);
  let cursorSequence = 0;

  function register(snapshot: MemoryReadSnapshot) {
    const id = referenceKey(snapshot.reference);
    const existing = numbers.get(id);
    if (existing) return existing;
    references.push(snapshot.reference);
    numbers.set(id, references.length);
    return references.length;
  }

  async function withPostLinks(snapshot: MemoryReadSnapshot): Promise<MemoryReadSnapshot> {
    if (snapshot.view !== 'source' || !isMemoryReference(snapshot.reference)) return snapshot;
    const links = new Map<string, string>();
    const parts = [];
    for (const part of snapshot.parts) {
      if (part.available && part.sourceStatus === 'exact' && part.sessionId?.startsWith('post-source:')) {
        const postId = part.sessionId.slice('post-source:'.length);
        if (!links.has(postId)) {
          const post = await loadPostReadSnapshot(postId, 'memory');
          links.set(postId, typeof post === 'string' ? '' : `[记忆 ${register(post)}]【I 想起的一条动态】`);
        }
        const link = links.get(postId);
        parts.push(link ? { ...part, context: [part.context, link].filter(Boolean).join('\n') } : part);
      } else parts.push(part);
    }
    return { ...snapshot, parts };
  }

  return {
    references, visibleMemoryIds,
    async refreshModelResults(messages: readonly OpenAiCompatibleContinuationMessage[]) {
      const output: OpenAiCompatibleContinuationMessage[] = [];
      for (const message of messages) {
        if (message.kind !== 'tool_result' || !['memory.get', 'memory.search'].includes(message.toolId)) {
          output.push(message); continue;
        }
        let payload: Record<string, unknown> | undefined;
        try { payload = object(JSON.parse(message.content)); } catch { /* Preserve non-success receipts. */ }
        if (payload?.ok !== true || payload.dataOmitted) { output.push(message); continue; }
        const reads = readsByCall.get(message.callId) ?? [];
        let current = input.canRead() && reads.length > 0;
        let sourceRefreshed = false;
        let readFailed = false;
        for (const read of reads) {
          let snapshot: Awaited<ReturnType<typeof readSnapshot>>;
          try { snapshot = await readSnapshot(read.snapshot.reference, read.snapshot.view); }
          catch (error) {
            if (!isShiyingReference(read.snapshot.reference) && !isPostReference(read.snapshot.reference)) throw error;
            current = false; readFailed = true; continue;
          }
          if (message.toolId === 'memory.search' && typeof snapshot !== 'string' && isShiyingReference(snapshot.reference)
            && snapshot.view === 'memory' && snapshot.version !== read.snapshot.version) {
            const rows = object(payload.data)?.results;
            const row = Array.isArray(rows) ? object(rows.find(value => object(value)?.item === read.item)) : undefined;
            const preview = row && typeof row.contentPreview === 'string';
            const content = !read.sourceRefreshed && scoreShiyingText(snapshot.reference.shiying, read.query ?? '') >= SHIYING_TEXT_THRESHOLD
              ? formatShiyingRecallMaterial(snapshot.reference.shiying, read.item, preview ? 180 : 2000, read.query) : '';
            if (row && content && (typeof row.content === 'string' || preview)) {
              if (preview) row.contentPreview = content; else row.content = content;
              if (JSON.stringify(payload).length > SEARCH_RESULT_LIMIT) {
                delete row.content;
                row.contentPreview = formatShiyingRecallMaterial(snapshot.reference.shiying, read.item, 180, read.query);
                row.contentTruncated = true;
                if (JSON.stringify(payload).length > SEARCH_RESULT_LIMIT) { current = false; continue; }
              }
              read.snapshot = snapshot; read.sourceRefreshed = true; sourceRefreshed = true;
              continue;
            }
            current = false;
            continue;
          }
          if (message.toolId === 'memory.search' && typeof snapshot !== 'string' && isPostReference(snapshot.reference)
            && snapshot.version !== read.snapshot.version) {
            const rows = object(payload.data)?.results;
            const row = Array.isArray(rows) ? object(rows.find(value => object(value)?.item === read.item)) : undefined;
            const selected: PostRecallSelection = { items: [] };
            if (!read.sourceRefreshed) selectPostRecall(selected, [snapshot.reference.post], read.query ?? '');
            await preferConfirmedPostMemories(selected, [...(input.references ?? []), ...reads.map(read => read.snapshot.reference)]
              .flatMap(reference => isMemoryReference(reference) ? [reference.memory] : []));
            const candidate = selected.items[0];
            const content = candidate ? formatPostRecallMaterial(candidate.snapshot, read.item,
              typeof row?.contentPreview === 'string' ? 180 : 2000, read.query, candidate.hits, candidate.excludedRanges) : '';
            if (row && content && candidate) {
              if (typeof row.contentPreview === 'string') row.contentPreview = content; else row.content = content;
              if (JSON.stringify(payload).length > SEARCH_RESULT_LIMIT) { current = false; continue; }
              read.snapshot = { ...snapshot, reference: { ...snapshot.reference, hits: candidate.hits, excludedRanges: candidate.excludedRanges } };
              read.postContents = new Set([content]);
              read.sourceRefreshed = true; sourceRefreshed = true; continue;
            }
            current = false; continue;
          }
          if (message.toolId === 'memory.search' && typeof snapshot !== 'string'
            && isCurrentStateReference(snapshot.reference) && snapshot.view === 'source'
            && targetVersion(snapshot.reference) === targetVersion(read.snapshot.reference)
            && snapshot.version !== read.snapshot.version) {
            const rows = object(payload.data)?.results;
            const row = Array.isArray(rows) ? object(rows.find(value => object(value)?.item === read.item)) : undefined;
            if (row && typeof row.content === 'string') {
              if (read.sourceRefreshed) { current = false; continue; }
              row.content = formatCurrentStateMaterial({ state: snapshot.reference.currentState,
                version: snapshot.reference.version, sourceVersion: snapshot.version, sourceParts: snapshot.parts, context: '' },
              { maxChars: 2000, sourceChars: 400 });
              read.snapshot = snapshot;
              read.sourceRefreshed = true;
              sourceRefreshed = true;
              continue;
            }
          }
          if (typeof snapshot === 'string' || isMemoryReference(snapshot.reference) && snapshot.reference.memory.type === 'archived'
            || snapshot.version !== read.snapshot.version) current = false;
        }
        if (sourceRefreshed) observedCalls.delete(message.callId);
        output.push(current && input.canRead() ? sourceRefreshed ? { ...message, content: JSON.stringify(payload) } : message : { ...message, content: JSON.stringify({
          ok: false, status: 'failed', summary: '', errorCode: readFailed ? 'MEMORY_READ_FAILED' : 'MEMORY_READ_CHANGED',
        }) });
      }
      return output;
    },
    syncInitialReferences(current: readonly MemoryReadReference[], visible?: ReadonlySet<string>) {
      for (let index = 0; index < (input.references?.length ?? 0); index++) {
        const reference = current[index];
        if (!reference || !references[index] || referenceKey(references[index]) !== referenceKey(reference)) continue;
        // Keep reserved slots; a missing item number must never point at another card.
        if (!delivered.has(index + 1)) references[index] = reference;
        if (visible?.has(referenceKey(reference)) ?? true) visibleMemoryIds.add(referenceKey(reference));
        else if (!delivered.has(index + 1)) visibleMemoryIds.delete(referenceKey(reference));
      }
    },
    searchedMemory(item: unknown) {
      if (!input.canRead() || typeof item !== 'number' || !Number.isSafeInteger(item) || item < 1) return undefined;
      const snapshot = delivered.get(item)?.get('memory');
      return snapshot?.fromSearch && isMemoryReference(snapshot.reference) ? snapshot.reference.memory : undefined;
    },
    prepare(invocation: JunLuoToolInvocation): JunLuoToolAgentInvocationPreparation {
      const args = invocation.input;
      const call = { ...invocation, requestedBy: 'chat' as const, createdAt: Date.now() };
      const reject = () => ({ kind: 'rejected' as const, result: failure(call, 'MEMORY_READ_INPUT_INVALID') });
      if (!input.canRead() || Object.keys(args).some(key => !['item', 'view', 'focus', 'cursor'].includes(key))
        || !Number.isInteger(args.item) || Number(args.item) < 1 || !references[Number(args.item) - 1]
        || args.focus != null && typeof args.focus !== 'string'
        || args.cursor != null && typeof args.cursor !== 'string') return reject();
      const cursor = args.cursor ? cursors.get(String(args.cursor)) : undefined;
      const view = args.view ?? cursor?.view ?? 'memory';
      if (view !== 'memory' && view !== 'source'
        || args.cursor && (!cursor || cursor.item !== args.item || cursor.view !== view)) return reject();
      return { kind: 'ready', input: { item: args.item, memoryId: referenceId(references[Number(args.item) - 1]),
        view, focus: args.focus ?? '', cursor: args.cursor ?? '' } };
    },
    async execute(call: JunLuoToolCall, providerCallId: string) {
      if (!input.canRead()) return failure(call, 'STALE_DATA_EPOCH');
      const item = Number(call.input.item), view = call.input.view as MemoryReadView;
      const reference = references[item - 1];
      if (!reference || referenceId(reference) !== call.input.memoryId) return failure(call, 'MEMORY_READ_INPUT_INVALID');
      const loaded = await readSnapshot(reference, view);
      if (typeof loaded === 'string') return failure(call, loaded);
      const snapshot = await withPostLinks(loaded);
      const previous = call.input.cursor ? cursors.get(String(call.input.cursor)) : undefined;
      if (call.input.cursor && (!previous || previous.item !== item || previous.view !== view || previous.version !== snapshot.version)) {
        return failure(call, 'MEMORY_READ_CHANGED');
      }
      const nextCursor = `read:${scope}:${++cursorSequence}`;
      const page = pageResult(call, snapshot, item, previous?.ranges ?? firstRanges(snapshot, String(call.input.focus ?? '')), nextCursor, providerCallId);
      if (!page) return failure(call, 'MEMORY_READ_RESULT_TOO_LARGE');
      const current = await readSnapshot(reference, view);
      if (!input.canRead()) return failure(call, 'STALE_DATA_EPOCH');
      if (typeof current === 'string') return failure(call, current);
      if (current.version !== snapshot.version) return failure(call, 'MEMORY_READ_CHANGED');
      if (page.remaining.length) cursors.set(nextCursor, { item, view, version: snapshot.version, ranges: page.remaining });
      readsByCall.set(providerCallId, [{ item, snapshot }]);
      return page.result;
    },
    async rememberSearch(result: JunLuoToolResult) {
      if (!input.canRead() || result.toolId !== 'memory.search' || !result.ok) return;
      const resultData = object(result.data), rows = resultData?.results;
      if (!Array.isArray(rows)) return;
      const traceDetails = object(resultData?.sourceTrace)?.details;
      const reads: VisibleRead[] = [];
      for (const row of rows) {
        const data = object(row);
        if (typeof data?.id !== 'string') continue;
        const postReference = postSearchRows.get(data);
        if (postReference) {
          const snapshot = await readSnapshot(postReference, 'memory');
          if (typeof snapshot === 'string' || !isPostReference(snapshot.reference) || snapshot.version !== postReference.version) continue;
          const item = register(snapshot);
          data.content = formatPostRecallMaterial(snapshot.reference.post, item, 2000, String(resultData?.query ?? ''), postReference.hits, postReference.excludedRanges);
          if (typeof data.content === 'string' && data.content) reads.push({ item, snapshot, searchRow: data, query: String(resultData?.query ?? ''), postContents: new Set([data.content]) });
          continue;
        }
        const paperReference = shiyingSearchRows.get(data);
        if (paperReference) {
          const snapshot = await loadShiyingReadSnapshot(paperReference.shiying.recordId, 'memory');
          if (typeof snapshot === 'string' || snapshot.reference.version !== paperReference.version) continue;
          const item = register(snapshot);
          data.content = formatShiyingRecallMaterial(snapshot.reference.shiying, item, 2000, String(resultData?.query ?? ''));
          reads.push({ item, snapshot, searchRow: data, query: String(resultData?.query ?? '') });
          continue;
        }
        const stateReference = currentStateSearchRows.get(data);
        if (stateReference) {
          const snapshot = await loadCurrentStateReadSnapshot(stateReference.currentState.id, 'memory');
          const source = await loadCurrentStateReadSnapshot(stateReference.currentState.id, 'source');
          if (typeof snapshot === 'string' || typeof source === 'string'
            || snapshot.reference.version !== stateReference.version || source.version !== stateReference.sourceVersion) continue;
          const item = register(snapshot);
          reads.push({ item, snapshot, searchRow: data }, { item, snapshot: source, searchRow: data });
          continue;
        }
        const snapshot = await loadMemoryReadSnapshot(data.id, 'memory');
        if (typeof snapshot === 'string') continue;
        const memory = snapshot.reference.memory;
        // The tool returned these fields before this local read. Do not credit a newer, unseen version.
        if (['title', 'content', 'domain', 'tags', 'recallCues', 'rememberedReason', 'eventTime',
          'importance', 'semanticType', 'understandingSubject', 'anchor', 'anchorKind', 'pinned', 'confirmationLevel',
          'createdAt', 'source', 'sourceType', 'sourceStartAt', 'sourceEndAt', 'sourceTraceMode'].some(key =>
          key in data && JSON.stringify(canonical(data[key] ?? null)) !== JSON.stringify(canonical(memory[key as keyof typeof memory] ?? null)))) continue;
        const latest = snapshot.reference.latestComment, returned = object(data.latestComment);
        // The existing archived-search fallback returns the card without loading comments.
        if (returned ? !latest || ['content', 'kind', 'createdAt'].some(key => returned[key] !== latest[key as keyof typeof latest])
          : latest && memory.type !== 'archived') continue;
        const detail = Array.isArray(traceDetails) ? object(traceDetails.find(value => object(value)?.memoryId === data.id)) : undefined;
        const source = detail && Array.isArray(detail.messages)
          ? await loadMemoryReadSnapshot(data.id, 'source') : undefined;
        if (source && (typeof source === 'string' || !sourceTraceMatches(detail!, source)
          || weeklyTargetHash(source.reference.memory) !== weeklyTargetHash(memory))) continue;
        const item = register(snapshot);
        reads.push({ item, snapshot, searchRow: data });
        if (source && typeof source !== 'string') reads.push({ item, snapshot: source, searchRow: data });
      }
      if (input.canRead()) readsByCall.set(result.callId, reads);
    },
    project(result: JunLuoToolResult): JunLuoToolResult {
      if (result.toolId !== 'memory.search' || !result.ok) return result;
      const data = object(result.data), rows = data?.results;
      if (!data || !Array.isArray(rows)) return result;
      const reads = readsByCall.get(result.callId) ?? [];
      const numbered: Array<Record<string, unknown> & { item: number }> = rows.flatMap(row => {
        const value = object(row);
        const candidates = reads.filter(entry => entry.snapshot.view === 'memory'
          && referenceId(entry.snapshot.reference) === value?.id);
        const matching = candidates.filter(entry => value?.item === entry.item || (value?.item === undefined
          && object(entry.searchRow)?.title === value?.title && object(entry.searchRow)?.content === value?.content));
        const read = candidates.find(entry => entry.searchRow === value) ?? (matching.length === 1 ? matching[0] : undefined);
        if (!value || !read) return [];
        const { score: _score, sources: _sources, updatedAt: _updatedAt,
          importance: _importance, pinned: _pinned, ...visible } = value;
        return [{ ...visible, item: read.item }];
      });
      const { context: _context, ...withoutContext } = data;
      const { sourceTrace: _sourceTrace, ...compact } = withoutContext;
      const full = duplicatesSearchRows(data.context, numbered) ? withoutContext : data;
      // A rejected row may still be quoted in these duplicated contexts.
      let projected = { ...result, data: { ...(numbered.length === rows.length ? full : compact), results: numbered } };
      if (memoryReadResultSize(projected) <= SEARCH_RESULT_LIMIT) return projected;
      projected = { ...result, data: { ...compact, results: numbered } };
      if (memoryReadResultSize(projected) <= SEARCH_RESULT_LIMIT) return projected;
      // Raw results remain untouched for the existing correction binding and confirmation card.
      let limit = 180;
      const preview = () => ({ ...result, data: { results: numbered.flatMap(row => {
        const postRead = reads.find(read => read.item === row.item && isPostReference(read.snapshot.reference));
        let content = String(row.content ?? '').slice(0, limit);
        if (postRead && isPostReference(postRead.snapshot.reference)) {
          const reference = postRead.snapshot.reference;
          content = formatPostRecallMaterial(reference.post, row.item, limit, postRead.query, reference.hits, reference.excludedRanges);
          if (!content) return [];
          postRead.postContents?.add(content);
        }
        return [{ item: row.item, id: row.id, title: String(row.title ?? '').slice(0, Math.min(120, limit)),
          contentPreview: content, contentTruncated: true }];
      }) } });
      let small = preview();
      while (limit && memoryReadResultSize(small) > SEARCH_RESULT_LIMIT) {
        limit = Math.floor(limit / 2);
        small = preview();
      }
      while (small.data.results.length && memoryReadResultSize(small) > SEARCH_RESULT_LIMIT) small.data.results.pop();
      return small;
    },
    observeMessages(messages: readonly ResultMessage[]) {
      if (!input.canRead()) return;
      for (const message of messages) {
        if (message.kind !== 'tool_result' || !message.callId || observedCalls.has(message.callId)) continue;
        let envelope: Record<string, unknown> | undefined;
        try { envelope = object(JSON.parse(message.content ?? '')); } catch { continue; }
        const data = object(envelope?.data);
        if (envelope?.ok !== true || envelope.dataOmitted || !data) continue;
        if (message.toolId === 'memory.get' && (!Array.isArray(data.parts) || !data.parts.some(part => object(part)?.content))) continue;
        for (const read of readsByCall.get(message.callId) ?? []) {
          const rows = Array.isArray(data.results) ? data.results : [data];
          if (!rows.some(row => object(row)?.item === read.item && object(row)?.id === referenceId(read.snapshot.reference))) continue;
          if (message.toolId === 'memory.search' && isPostReference(read.snapshot.reference)) {
            const row = object(rows.find(row => object(row)?.item === read.item && object(row)?.id === referenceId(read.snapshot.reference)));
            const content = row?.content ?? row?.contentPreview;
            if (typeof content !== 'string' || !read.postContents?.has(content)) continue;
          }
          if (message.toolId === 'memory.search' && read.snapshot.view === 'source' && isCurrentStateReference(read.snapshot.reference)
            && !rows.some(row => object(row)?.item === read.item && typeof object(row)?.content === 'string'
              && String(object(row)?.content).includes('\n依据：'))) continue;
          if (message.toolId === 'memory.search' && read.snapshot.view === 'source' && isMemoryReference(read.snapshot.reference)) {
            const details = object(data.sourceTrace)?.details;
            if (!Array.isArray(details) || !details.some(value => object(value)?.memoryId === referenceId(read.snapshot.reference))) continue;
          }
          const prior = delivered.get(read.item);
          const views = prior && [...prior.values()].every(snapshot => targetVersion(snapshot.reference) === targetVersion(read.snapshot.reference))
            ? prior : new Map<MemoryReadView, DeliveredSnapshot>();
          const previous = views.get(read.snapshot.view);
          views.set(read.snapshot.view, { ...read.snapshot, fromSearch: message.toolId === 'memory.search'
            || previous?.version === read.snapshot.version && previous.fromSearch });
          delivered.set(read.item, views);
          const previousReference = references[read.item - 1];
          const nextReference = read.snapshot.reference;
          references[read.item - 1] = isCurrentStateReference(nextReference) ? { ...nextReference,
            sourceVersion: read.snapshot.view === 'source' ? read.snapshot.version
              : previousReference && isCurrentStateReference(previousReference) && previousReference.version === nextReference.version
                ? previousReference.sourceVersion : undefined } : nextReference;
          visibleMemoryIds.add(referenceKey(read.snapshot.reference));
        }
        observedCalls.add(message.callId);
      }
    },
    async validateReference(reference: MemoryReadReference, database: WeeklyDatabase, postOptions: PostMemoryReadOptions = {}) {
      if (!input.canRead()) return false;
      for (const snapshot of delivered.get(numbers.get(referenceKey(reference))!)?.values() ?? []) {
        const current = await readSnapshot(reference, snapshot.view, database, postOptions);
        if (typeof current === 'string' || current.version !== snapshot.version) return false;
      }
      return input.canRead();
    },
  };
}

export type MemoryReadTurn = ReturnType<typeof createMemoryReadTurn>;
