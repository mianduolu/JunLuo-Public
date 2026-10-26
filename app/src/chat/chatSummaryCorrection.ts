export type ChatSummaryCorrectionRef = { sessionId: string; messageId: string; createdAt?: number };
export type MemoryChatSummaryCorrection = {
  version: 1; id: string; beforeRefs: ChatSummaryCorrectionRef[];
  afterRefs: ChatSummaryCorrectionRef[]; unknownSource: boolean;
};
export type ChatSummaryCorrectionReceipt = { memoryId: string; correctionId: string; materialHash: string };
export type ChatSummaryCorrectionPending = { memoryId: string; correctionId: string };
export type ChatSummaryCorrectionReview = {
  version: 1; accepted: ChatSummaryCorrectionReceipt[]; pending: ChatSummaryCorrectionPending[];
};
export type ChatSummaryCorrectionSnapshot = {
  memoryId: string; correction: MemoryChatSummaryCorrection; materialHash: string;
};
export type ChatSummaryCorrectionContext = {
  sessionId: string; messageOrder: readonly { id: string; createdAt?: number }[];
};
export type ChatSummaryCorrectionRange = ChatSummaryCorrectionContext & {
  startMessageId?: string | null; endMessageId?: string | null;
};
export type ChatSummaryCorrectionLog = {
  id: string; startMessageId: string; endMessageId: string; correctionReview?: ChatSummaryCorrectionReview;
};
/** Shared summary JSON needs no device-local compression metrics. */
export type ChatSummaryCorrectionState = {
  summary: string; summarizedThroughMessageId?: string | null;
  summarizedThroughAt?: number | null; lastCompressedAt?: number | null;
  correctionReview?: ChatSummaryCorrectionReview; shortLogs?: ChatSummaryCorrectionLog[];
};

function object(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('chat-summary-correction-invalid');
  const record = value as Record<string, unknown>;
  if (required.some(key => !(key in record)) || Object.keys(record).some(key => !required.includes(key) && !optional.includes(key))) {
    throw new Error('chat-summary-correction-invalid');
  }
  return record;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('chat-summary-correction-invalid');
  return value;
}
function refs(value: unknown): ChatSummaryCorrectionRef[] {
  if (!Array.isArray(value)) throw new Error('chat-summary-correction-invalid');
  return value.map(item => {
    const ref = object(item, ['sessionId', 'messageId'], ['createdAt']);
    if (ref.createdAt !== undefined && (!Number.isSafeInteger(ref.createdAt) || Number(ref.createdAt) < 0)) {
      throw new Error('chat-summary-correction-invalid');
    }
    return { sessionId: text(ref.sessionId), messageId: text(ref.messageId),
      ...(ref.createdAt === undefined ? {} : { createdAt: ref.createdAt as number }) };
  });
}
function refUnion(values: ChatSummaryCorrectionRef[]) {
  const result = new Map<string, ChatSummaryCorrectionRef>();
  for (const ref of values) {
    const key = JSON.stringify([ref.sessionId, ref.messageId]);
    result.set(key, { ...result.get(key), ...ref });
  }
  return [...result.values()];
}
function key(value: ChatSummaryCorrectionPending) { return JSON.stringify([value.memoryId, value.correctionId]); }
function pendingUnion(values: ChatSummaryCorrectionPending[]) {
  return [...new Map(values.map(item => [key(item), { memoryId: item.memoryId, correctionId: item.correctionId }])).values()];
}

/** Missing legacy data is allowed. Malformed data must not become an apparently current empty review. */
export function normalizeMemoryChatSummaryCorrection(value: unknown): MemoryChatSummaryCorrection | null {
  if (value === undefined || value === null) return null;
  const record = object(value, ['version', 'id', 'beforeRefs', 'afterRefs', 'unknownSource']);
  if (record.version !== 1 || typeof record.unknownSource !== 'boolean') throw new Error('chat-summary-correction-invalid');
  const beforeRefs = refUnion(refs(record.beforeRefs)); const afterRefs = refUnion(refs(record.afterRefs));
  if ((!beforeRefs.length || !afterRefs.length) && !record.unknownSource) throw new Error('chat-summary-correction-invalid');
  return { version: 1, id: text(record.id), beforeRefs, afterRefs, unknownSource: record.unknownSource };
}

export function normalizeChatSummaryCorrectionReview(value: unknown): ChatSummaryCorrectionReview | undefined {
  if (value === undefined || value === null) return undefined;
  const record = object(value, ['version', 'accepted', 'pending']);
  if (record.version !== 1 || !Array.isArray(record.accepted) || !Array.isArray(record.pending)) {
    throw new Error('chat-summary-correction-invalid');
  }
  const accepted = new Map<string, ChatSummaryCorrectionReceipt>();
  for (const value of record.accepted) {
    const item = object(value, ['memoryId', 'correctionId', 'materialHash']);
    const receipt = { memoryId: text(item.memoryId), correctionId: text(item.correctionId), materialHash: text(item.materialHash) };
    if (accepted.has(key(receipt)) && accepted.get(key(receipt))!.materialHash !== receipt.materialHash) {
      throw new Error('chat-summary-correction-invalid');
    }
    accepted.set(key(receipt), receipt);
  }
  const pending = record.pending.map(value => {
    const item = object(value, ['memoryId', 'correctionId']);
    return { memoryId: text(item.memoryId), correctionId: text(item.correctionId) };
  });
  return { version: 1, accepted: [...accepted.values()], pending: pendingUnion(pending) };
}

export function createMemoryChatSummaryCorrection(input: {
  id: string; beforeRefs: ChatSummaryCorrectionRef[]; afterRefs: ChatSummaryCorrectionRef[];
  previous?: MemoryChatSummaryCorrection | null; unknownSource?: boolean;
}): MemoryChatSummaryCorrection {
  const previous = normalizeMemoryChatSummaryCorrection(input.previous);
  const before = refs(input.beforeRefs); const after = refs(input.afterRefs);
  return { version: 1, id: text(input.id),
    beforeRefs: refUnion([...(previous?.beforeRefs ?? []), ...(previous?.afterRefs ?? []), ...before]),
    afterRefs: refUnion(after),
    unknownSource: input.unknownSource === true || previous?.unknownSource === true || !before.length || !after.length };
}

export function isChatSummaryCorrectionRelevant(correction: MemoryChatSummaryCorrection, range: ChatSummaryCorrectionRange) {
  if (correction.unknownSource) return true;
  const local = [...correction.beforeRefs, ...correction.afterRefs].filter(ref => ref.sessionId === range.sessionId);
  if (!local.length) return false;
  const end = range.messageOrder.findIndex(message => message.id === range.endMessageId);
  const start = range.startMessageId == null ? 0 : range.messageOrder.findIndex(message => message.id === range.startMessageId);
  if (start < 0 || end < start) return true;
  return local.some(ref => {
    const position = range.messageOrder.findIndex(message => message.id === ref.messageId);
    if (position < 0 || position >= start && position <= end) return true;
    // Desktop and mobile can order same-millisecond messages differently. A tied boundary is uncertain.
    const sourceAt = range.messageOrder[position].createdAt ?? ref.createdAt;
    const boundaryAt = range.messageOrder[position < start ? start : end].createdAt;
    return typeof sourceAt === 'number' && Number.isFinite(sourceAt) && sourceAt === boundaryAt;
  });
}

function snapshotsById(snapshots: readonly ChatSummaryCorrectionSnapshot[]) {
  const result = new Map<string, ChatSummaryCorrectionSnapshot>();
  for (const snapshot of snapshots) {
    text(snapshot.memoryId); text(snapshot.materialHash);
    if (!normalizeMemoryChatSummaryCorrection(snapshot.correction) || result.has(snapshot.memoryId)) {
      throw new Error('chat-summary-correction-invalid');
    }
    result.set(snapshot.memoryId, snapshot);
  }
  return result;
}

/** snapshots must contain the complete current correction set, including archived cards. */
export function applyChatSummaryCorrections<T extends ChatSummaryCorrectionState>(
  state: T, snapshots: readonly ChatSummaryCorrectionSnapshot[], context: ChatSummaryCorrectionContext,
): T {
  const current = snapshotsById(snapshots);
  const apply = (value: ChatSummaryCorrectionReview | undefined, range: ChatSummaryCorrectionRange) => {
    const review = normalizeChatSummaryCorrectionReview(value);
    const accepted = review?.accepted ?? [];
    let pending = [...(review?.pending ?? [])];
    for (const snapshot of current.values()) {
      const retained = accepted.some(item => item.memoryId === snapshot.memoryId) || pending.some(item => item.memoryId === snapshot.memoryId);
      if (!retained && !isChatSummaryCorrectionRelevant(snapshot.correction, range)) continue;
      const receipt = accepted.find(item => item.memoryId === snapshot.memoryId && item.correctionId === snapshot.correction.id);
      const wasPending = pending.some(item => item.memoryId === snapshot.memoryId);
      // A newer correction supersedes older pending tokens for the same card.
      pending = pending.filter(item => item.memoryId !== snapshot.memoryId);
      if (wasPending || !receipt || receipt.materialHash !== snapshot.materialHash) {
        pending.push({ memoryId: snapshot.memoryId, correctionId: snapshot.correction.id });
      }
    }
    for (const receipt of accepted) if (!current.has(receipt.memoryId)) pending.push(receipt);
    if (!review && !pending.length) return undefined;
    return { version: 1 as const, accepted, pending: pendingUnion(pending) };
  };
  return { ...state,
    ...(state.summary.trim() || state.correctionReview ? {
      correctionReview: apply(state.correctionReview, { ...context, endMessageId: state.summarizedThroughMessageId }),
    } : {}),
    ...(state.shortLogs ? { shortLogs: state.shortLogs.map(log => ({ ...log,
      correctionReview: apply(log.correctionReview, { ...context, startMessageId: log.startMessageId, endMessageId: log.endMessageId }),
    })) } : {}),
  };
}

/** Incoming receipts certify only their own prose; current material is checked again before use. */
export function mergeChatSummaryCorrectionReview(
  local: ChatSummaryCorrectionReview | undefined, incoming: ChatSummaryCorrectionReview | undefined,
): ChatSummaryCorrectionReview | undefined {
  const left = normalizeChatSummaryCorrectionReview(local); const right = normalizeChatSummaryCorrectionReview(incoming);
  if (!left) return right;
  if (!right) return left;
  // Receipts certify their own summary body. Never lend local receipts to incoming old prose.
  // When incoming is absent the caller must also retain the local body.
  const pending = pendingUnion([...left.pending, ...right.pending]).filter(item => (
    right.pending.some(candidate => key(candidate) === key(item))
      || !right.accepted.some(receipt => key(receipt) === key(item))
  ));
  return { version: 1, accepted: right.accepted, pending };
}

/** Merge correction metadata with the prose it certifies; synchronization clocks do not choose a winner here. */
export function mergeChatSummaryCorrectionState<T extends ChatSummaryCorrectionState>(existing: T | undefined, incoming: T): T {
  if (!existing) return incoming;
  const keepLocal = !!existing.correctionReview && !incoming.correctionReview;
  const next = { ...incoming,
    ...(keepLocal ? { summary: existing.summary, summarizedThroughMessageId: existing.summarizedThroughMessageId,
      summarizedThroughAt: existing.summarizedThroughAt, lastCompressedAt: existing.lastCompressedAt } : {}),
    correctionReview: mergeChatSummaryCorrectionReview(existing.correctionReview, incoming.correctionReview),
  };
  const localLogs = new Map((existing.shortLogs ?? []).map(log => [log.id, log]));
  const incomingIds = new Set<string>();
  const shortLogs = (incoming.shortLogs ?? []).map(log => {
    if (incomingIds.has(log.id)) throw new Error('chat-summary-correction-invalid');
    incomingIds.add(log.id);
    const local = localLogs.get(log.id);
    if (local?.correctionReview && !log.correctionReview) return local;
    return { ...log, correctionReview: mergeChatSummaryCorrectionReview(local?.correctionReview, log.correctionReview) };
  });
  for (const log of localLogs.values()) {
    if (!incomingIds.has(log.id) && normalizeChatSummaryCorrectionReview(log.correctionReview)?.pending.length) shortLogs.push(log);
  }
  return { ...next, ...(incoming.shortLogs || shortLogs.length ? { shortLogs } : {}) };
}

export function completeChatSummaryCorrectionReview(
  review: ChatSummaryCorrectionReview | undefined, receipts: readonly ChatSummaryCorrectionReceipt[],
  currentSnapshots: readonly ChatSummaryCorrectionSnapshot[],
): ChatSummaryCorrectionReview {
  const original = normalizeChatSummaryCorrectionReview(review) ?? { version: 1 as const, accepted: [], pending: [] };
  const normalized = normalizeChatSummaryCorrectionReview({ version: 1, accepted: receipts, pending: [] })!;
  const current = snapshotsById(currentSnapshots);
  for (const receipt of normalized.accepted) {
    const snapshot = current.get(receipt.memoryId);
    if (!snapshot || snapshot.correction.id !== receipt.correctionId || snapshot.materialHash !== receipt.materialHash) {
      throw new Error('chat-summary-correction-material-changed');
    }
  }
  const completed = normalized.accepted.filter(receipt => original.pending.some(item => key(item) === key(receipt)));
  return { version: 1,
    accepted: [...original.accepted.filter(item => !completed.some(receipt => receipt.memoryId === item.memoryId)), ...completed],
    pending: original.pending.filter(item => !completed.some(receipt => key(receipt) === key(item))),
  };
}

/** Persist this result before deleting its source; no matching old receipt may release the pre-delete pause. */
export function pauseChatSummaryCorrectionForDeletion<T extends ChatSummaryCorrectionState>(
  state: T, memoryId: string, marker: MemoryChatSummaryCorrection, context: ChatSummaryCorrectionContext,
): T {
  text(memoryId);
  const correction = normalizeMemoryChatSummaryCorrection(marker);
  if (!correction) throw new Error('chat-summary-correction-invalid');
  const pause = (review: ChatSummaryCorrectionReview | undefined, startMessageId?: string, endMessageId?: string | null) => {
    const current = normalizeChatSummaryCorrectionReview(review);
    if (!isChatSummaryCorrectionRelevant(correction, { ...context, startMessageId, endMessageId })
      && !current?.accepted.some(receipt => receipt.memoryId === memoryId)
      && !current?.pending.some(pending => pending.memoryId === memoryId)) return current;
    return { version: 1 as const,
      accepted: (current?.accepted ?? []).filter(receipt => receipt.memoryId !== memoryId),
      pending: [...(current?.pending ?? []).filter(pending => pending.memoryId !== memoryId),
        { memoryId, correctionId: correction.id }],
    };
  };
  return { ...state,
    correctionReview: pause(state.correctionReview, undefined, state.summarizedThroughMessageId),
    ...(state.shortLogs ? { shortLogs: state.shortLogs.map(log => ({ ...log,
      correctionReview: pause(log.correctionReview, log.startMessageId, log.endMessageId),
    })) } : {}),
  };
}

export const CHAT_SUMMARY_CORRECTION_INSTRUCTION = 'I 按已确认的更正改掉摘要里的旧说法，保留其他内容。';
/** UI autosaves cannot replace metadata already committed by an explicit rewrite. */
export function protectChatSummaryAutosave<T extends ChatSummaryCorrectionState>(existing: T | undefined, incoming: T | undefined): T | undefined {
  if (!existing) return incoming;
  if (!incoming) return existing;
  const merged = mergeChatSummaryCorrectionState(existing, incoming);
  const reviewKey = (state: T) => JSON.stringify([state.correctionReview,
    state.shortLogs?.map(log => [log.id, log.correctionReview])]);
  const protectedState = (incoming.lastCompressedAt ?? 0) < (existing.lastCompressedAt ?? 0)
    || reviewKey(existing) !== reviewKey(incoming)
      && (!!existing.correctionReview || existing.shortLogs?.some(log => !!log.correctionReview));
  return protectedState ? { ...incoming, ...mergeChatSummaryCorrectionState(merged, existing) } : merged;
}
export type ChatSummaryCorrectionMaterial = {
  title?: string; content?: string; timeLabel?: string; tags?: readonly string[];
  recallCues?: readonly string[]; rememberedReason?: string;
};
export function formatChatSummaryCorrections(materials: readonly ChatSummaryCorrectionMaterial[]) {
  return materials.map(material => {
    const fields: Array<[string, string | undefined]> = [
      ['标题', material.title], ['正文', material.content], ['发生时间', material.timeLabel],
      ['标签', material.tags?.filter(item => item.trim()).join('、')],
      ['回想线索', material.recallCues?.filter(item => item.trim()).join('、')], ['记住的理由', material.rememberedReason],
    ];
    const lines = fields.filter((entry): entry is [string, string] => !!entry[1]?.trim()).map(([label, value]) => `${label}：${value.trim()}`);
    return lines.length ? `【已确认的记忆更正】\n${lines.join('\n')}` : '';
  }).filter(Boolean).join('\n\n');
}
