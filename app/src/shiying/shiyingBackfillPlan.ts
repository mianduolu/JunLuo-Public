import {
  SHIYING_EXTRACTION_CONTRACT_VERSION,
  assertShiyingHash,
  assertShiyingLifeDate,
  createShiyingBatchId,
  createShiyingChunkId,
  createShiyingInputHash,
  createShiyingOperationId,
  type ShiyingCoverageSourceV1,
  type ShiyingMessageCursorV1,
} from './shiyingContract';
import type { ShiyingChatMaterialV1 } from './shiyingChatSource';
import { parseShiyingManualRunV1, type ShiyingRunChunkV1 } from './shiyingRunState';
import { planShiyingMaterialSegments } from './shiyingSegmentation';
import { addShiyingLifeDates, getShiyingLifeDate, getShiyingLifeDateStartAt } from './shiyingWindow';

export const SHIYING_BACKFILL_SELECTED_DATE_LIMIT = 31;

export type ShiyingBackfillDayReason = 'ready' | 'no_chat' | 'no_material' | 'covered' | 'blocked';
export type ShiyingBackfillReadDayV1 = {
  lifeDate: string;
  scanFloorAt: number;
  scanCeilingAt: number;
  windowEndCursor: ShiyingMessageCursorV1 | null;
  durableMessageCount: number;
  eligibleMessageCount: number;
  messages: ShiyingChatMaterialV1[];
};
export type ShiyingBackfillDayPlanV1 = {
  lifeDate: string;
  scanFloorAt: number;
  scanCeilingAt: number;
  windowStartCursor: null;
  windowEndCursor: ShiyingMessageCursorV1 | null;
  batchId: string | null;
  durableMessageCount: number;
  messageCount: number;
  reason: ShiyingBackfillDayReason;
  chunks: ShiyingRunChunkV1[];
};
export type ShiyingBackfillDayV1 = ShiyingBackfillDayPlanV1;
export type ShiyingBackfillPreviewV1 = {
  triggeredAt: number;
  configurationHash: string;
  tokenLimit: number;
  totalCalls: number;
  blocked: boolean;
  days: ShiyingBackfillDayPlanV1[];
};
export type ShiyingBackfillPlanInputV1 = {
  lifeDates: readonly string[];
  triggeredAt: number;
  configurationHash: string;
  contextWindowTokens: number;
  estimateTokens(messages: readonly ShiyingChatMaterialV1[]): number;
};

export function validateSelectedShiyingBackfillLifeDates(lifeDates: readonly string[], triggeredAt: number) {
  if (!Number.isSafeInteger(triggeredAt) || triggeredAt < 0) throw new Error('shiying_backfill_trigger_time');
  if (!Array.isArray(lifeDates) || lifeDates.length > SHIYING_BACKFILL_SELECTED_DATE_LIMIT) {
    throw new Error('shiying_backfill_selected_date_limit');
  }
  const currentLifeDate = getShiyingLifeDate(triggeredAt);
  const seen = new Set<string>();
  for (const lifeDate of lifeDates) {
    assertShiyingLifeDate(lifeDate, 'backfill_life_date');
    if (lifeDate >= currentLifeDate) throw new Error('shiying_backfill_life_date_not_ended');
    if (seen.has(lifeDate)) throw new Error('shiying_backfill_life_date_duplicate');
    seen.add(lifeDate);
  }
  return [...lifeDates].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

export function createShiyingBackfillCoverageSources(materials: readonly ShiyingChatMaterialV1[]) {
  return materials.map((material, ordinal): ShiyingCoverageSourceV1 => ({
    ordinal,
    sessionId: material.sessionId,
    messageId: material.messageId,
    role: material.role,
    messageCreatedAt: material.messageCreatedAt,
    contentHash: material.contentHash,
  }));
}

export function planShiyingBackfillDays(
  input: ShiyingBackfillPlanInputV1,
  readDays: readonly ShiyingBackfillReadDayV1[],
): ShiyingBackfillPreviewV1 {
  const lifeDates = validateSelectedShiyingBackfillLifeDates(input.lifeDates, input.triggeredAt);
  assertShiyingHash(input.configurationHash, 'backfill_configuration_hash');
  if (!Number.isSafeInteger(input.contextWindowTokens) || input.contextWindowTokens <= 2_048) {
    throw new Error('shiying_backfill_context_capacity');
  }
  if (readDays.length !== lifeDates.length) throw new Error('shiying_backfill_read_date_count');
  const tokenLimit = Math.min(30_000, input.contextWindowTokens - 2_048);
  const days = readDays.map((day, index): ShiyingBackfillDayPlanV1 => {
    const lifeDate = lifeDates[index];
    if (day.lifeDate !== lifeDate
      || day.scanFloorAt !== getShiyingLifeDateStartAt(lifeDate)
      || day.scanCeilingAt !== getShiyingLifeDateStartAt(addShiyingLifeDates(lifeDate, 1))) {
      throw new Error('shiying_backfill_read_date_boundary');
    }
    const base = {
      lifeDate, scanFloorAt: day.scanFloorAt, scanCeilingAt: day.scanCeilingAt,
      windowStartCursor: null, windowEndCursor: day.windowEndCursor,
      durableMessageCount: day.durableMessageCount, messageCount: day.messages.length,
    } as const;
    const batchId = day.windowEndCursor ? createShiyingBatchId({
      lane: 'backfill', lifeDateStart: lifeDate, lifeDateEnd: lifeDate,
      windowStartCursor: null, windowEndCursor: day.windowEndCursor,
    }) : null;
    if (!day.messages.some(message => message.role === 'you')) {
      return { ...base, batchId, chunks: [], reason: day.durableMessageCount === 0
        ? 'no_chat' : day.eligibleMessageCount > day.messages.length ? 'covered' : 'no_material' };
    }
    if (!batchId) throw new Error('shiying_backfill_cursor_missing');
    const plan = planShiyingMaterialSegments({ messages: day.messages, tokenLimit, estimateTokens: input.estimateTokens });
    const chunks = plan.chunks.map((chunk): ShiyingRunChunkV1 => {
      const sources = createShiyingBackfillCoverageSources(chunk.messages);
      const chunkId = createShiyingChunkId({ batchId, chunkIndex: chunk.chunkIndex, sources });
      return {
        chunkIndex: chunk.chunkIndex, chunkId,
        operationId: createShiyingOperationId({ lane: 'backfill', chunkId, contractVersion: SHIYING_EXTRACTION_CONTRACT_VERSION }),
        inputHash: createShiyingInputHash(sources), overlapFromPrevious: chunk.overlapFromPrevious,
        estimatedTokens: chunk.estimatedTokens, materials: chunk.messages,
        status: 'pending', attemptCount: 0, lastErrorCode: null, startedAt: null, completedAt: null, candidates: null,
      };
    });
    return { ...base, batchId, chunks, reason: plan.kind === 'blocked' ? 'blocked' : 'ready' };
  });
  return {
    triggeredAt: input.triggeredAt, configurationHash: input.configurationHash, tokenLimit,
    totalCalls: days.reduce((sum, day) => sum + day.chunks.length, 0),
    blocked: days.some(day => day.reason === 'blocked'), days,
  };
}

/** Validates the persisted frozen plan without recomputing its dates in a new timezone. */
export function parseShiyingBackfillPreviewV1(value: unknown): ShiyingBackfillPreviewV1 {
  const invalid = (): never => { throw new Error('shiying_backfill_preview_invalid'); };
  const count = (item: unknown) => Number.isSafeInteger(item) && (item as number) >= 0;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const preview = value as ShiyingBackfillPreviewV1;
  if (!count(preview.triggeredAt) || !count(preview.tokenLimit) || preview.tokenLimit < 1
    || preview.tokenLimit > 30_000 || !count(preview.totalCalls) || typeof preview.blocked !== 'boolean'
    || !Array.isArray(preview.days) || preview.days.length > SHIYING_BACKFILL_SELECTED_DATE_LIMIT) return invalid();
  assertShiyingHash(preview.configurationHash, 'backfill_configuration_hash');
  let previousLifeDate = '';
  const days = preview.days.map(day => {
    if (!day || typeof day !== 'object' || Array.isArray(day)) return invalid();
    assertShiyingLifeDate(day.lifeDate, 'backfill_frozen_life_date');
    if (day.lifeDate <= previousLifeDate) return invalid();
    previousLifeDate = day.lifeDate;
    if (!count(day.scanFloorAt) || !count(day.scanCeilingAt) || day.scanCeilingAt <= day.scanFloorAt
      || day.scanCeilingAt > preview.triggeredAt || day.windowStartCursor !== null
      || !count(day.durableMessageCount) || !count(day.messageCount) || day.messageCount > day.durableMessageCount
      || !['ready', 'no_chat', 'no_material', 'covered', 'blocked'].includes(day.reason)
      || !Array.isArray(day.chunks)) return invalid();
    if (day.reason === 'no_chat' && (day.durableMessageCount !== 0 || day.windowEndCursor !== null || day.batchId !== null)) return invalid();
    if (day.reason !== 'ready' && day.reason !== 'blocked' && day.chunks.length) return invalid();
    if (day.windowEndCursor === null) {
      if (day.batchId !== null || day.durableMessageCount !== 0 || day.chunks.length) return invalid();
      return { ...day, chunks: [] };
    }
    if (day.windowEndCursor.messageCreatedAt < day.scanFloorAt
      || day.windowEndCursor.messageCreatedAt >= day.scanCeilingAt) return invalid();
    const expectedBatch = createShiyingBatchId({ lane: 'backfill', lifeDateStart: day.lifeDate,
      lifeDateEnd: day.lifeDate, windowStartCursor: null, windowEndCursor: day.windowEndCursor });
    if (day.batchId !== expectedBatch) return invalid();
    // Reuse the existing chunk/material/candidate validator; only operation lane differs.
    for (const chunk of day.chunks) {
      if (!chunk || chunk.operationId !== createShiyingOperationId({ lane: 'backfill', chunkId: chunk.chunkId,
        contractVersion: SHIYING_EXTRACTION_CONTRACT_VERSION })) return invalid();
      if (chunk.estimatedTokens > preview.tokenLimit || chunk.materials.some(material =>
        material.messageCreatedAt < day.scanFloorAt || material.messageCreatedAt >= day.scanCeilingAt)) return invalid();
    }
    if (day.chunks.length) {
      const parsed = parseShiyingManualRunV1({ batchId: day.batchId, lane: 'live', lifeDateStart: day.lifeDate,
        lifeDateEnd: day.lifeDate, windowStartCursor: null, windowEndCursor: day.windowEndCursor,
        status: 'pending', lastErrorCode: null, createdAt: preview.triggeredAt, updatedAt: preview.triggeredAt,
        chunks: day.chunks.map(chunk => ({ ...chunk, operationId: createShiyingOperationId({ lane: 'live',
          chunkId: chunk.chunkId, contractVersion: SHIYING_EXTRACTION_CONTRACT_VERSION }) })) });
      return { ...day, chunks: parsed.chunks.map(chunk => ({ ...chunk,
        operationId: createShiyingOperationId({ lane: 'backfill', chunkId: chunk.chunkId,
          contractVersion: SHIYING_EXTRACTION_CONTRACT_VERSION }) })) };
    }
    if (day.reason === 'ready') return invalid();
    return { ...day, chunks: [] };
  });
  if (preview.totalCalls !== days.reduce((sum, day) => sum + day.chunks.length, 0)
    || preview.blocked !== days.some(day => day.reason === 'blocked')) return invalid();
  return { triggeredAt: preview.triggeredAt, configurationHash: preview.configurationHash,
    tokenLimit: preview.tokenLimit, totalCalls: preview.totalCalls, blocked: preview.blocked, days };
}
