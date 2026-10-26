import {
  SHIYING_CATEGORIES,
  SHIYING_EXTRACTION_CONTRACT_VERSION,
  assertShiyingDeterministicId,
  assertShiyingHash,
  assertShiyingLifeDate,
  createShiyingChunkId,
  createShiyingInputHash,
  createShiyingMessageContentHash,
  createShiyingOperationId,
  parseShiyingMessageCursorV1,
  type ShiyingCategory,
  type ShiyingCoverageSourceV1,
  type ShiyingMessageCursorV1,
} from './shiyingContract';
import type { ShiyingChatMaterialV1 } from './shiyingChatSource';

export type ShiyingRunCandidateV1 = {
  category: ShiyingCategory;
  body: string;
  sourceRefs: Array<{ sessionId: string; messageId: string }>;
};

export type ShiyingRunChunkV1 = {
  chunkIndex: number;
  chunkId: string;
  operationId: string;
  inputHash: string;
  overlapFromPrevious: number;
  estimatedTokens: number;
  status: 'pending' | 'in_flight' | 'completed';
  attemptCount: number;
  lastErrorCode: string | null;
  startedAt: number | null;
  completedAt: number | null;
  materials: ShiyingChatMaterialV1[];
  candidates: ShiyingRunCandidateV1[] | null;
};

export type ShiyingManualRunV1 = {
  batchId: string;
  lane: 'live';
  lifeDateStart: string;
  lifeDateEnd: string;
  windowStartCursor: ShiyingMessageCursorV1 | null;
  windowEndCursor: ShiyingMessageCursorV1;
  status: 'pending' | 'blocked';
  lastErrorCode: string | null;
  createdAt: number;
  updatedAt: number;
  chunks: ShiyingRunChunkV1[];
};

function runError(code: string): never {
  throw new Error(`shiying_run_${code}`);
}

function safeInteger(value: unknown, code: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 0) runError(code);
  return value as number;
}

function technicalErrorCode(value: unknown, code: string) {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^[a-z0-9_]{1,120}$/u.test(value)) runError(code);
  return value;
}

function coverageSources(materials: readonly ShiyingChatMaterialV1[]) {
  return materials.map((material, ordinal): ShiyingCoverageSourceV1 => ({
    ordinal,
    sessionId: material.sessionId,
    messageId: material.messageId,
    role: material.role,
    messageCreatedAt: material.messageCreatedAt,
    contentHash: material.contentHash,
  }));
}

function parseMaterial(value: unknown): ShiyingChatMaterialV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) runError('material');
  const material = value as Partial<ShiyingChatMaterialV1>;
  if (
    typeof material.sessionId !== 'string'
    || !material.sessionId
    || typeof material.messageId !== 'string'
    || !material.messageId
    || (material.role !== 'I' && material.role !== 'you')
    || typeof material.text !== 'string'
    || material.text.length > 20_000
    || (
      material.textKind !== 'message_text'
      && material.textKind !== 'voice_transcript'
      && material.textKind !== 'message_with_core_card_context'
    )
    || typeof material.textTruncated !== 'boolean'
    || typeof material.contentHash !== 'string'
  ) {
    runError('material_fields');
  }
  const messageCreatedAt = safeInteger(material.messageCreatedAt, 'material_time');
  assertShiyingHash(material.contentHash, 'run_material_hash');
  if (
    material.contentHash !== createShiyingMessageContentHash({
      role: material.role,
      content: material.text,
    })
  ) {
    runError('material_hash_mismatch');
  }
  return {
    sessionId: material.sessionId,
    messageId: material.messageId,
    role: material.role,
    messageCreatedAt,
    text: material.text,
    textKind: material.textKind,
    textTruncated: material.textTruncated,
    contentHash: material.contentHash,
  };
}

function parseCandidate(
  value: unknown,
  materials: readonly ShiyingChatMaterialV1[],
): ShiyingRunCandidateV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) runError('candidate');
  const candidate = value as Partial<ShiyingRunCandidateV1>;
  if (
    typeof candidate.category !== 'string'
    || !SHIYING_CATEGORIES.includes(candidate.category as ShiyingCategory)
    || typeof candidate.body !== 'string'
    || !candidate.body.trim()
    || candidate.body.length > 2_000
    || !Array.isArray(candidate.sourceRefs)
    || candidate.sourceRefs.length < 1
  ) {
    runError('candidate_fields');
  }
  const materialsByIdentity = new Map(materials.map((material) => [
    JSON.stringify([material.sessionId, material.messageId]),
    material,
  ]));
  const seen = new Set<string>();
  const sourceRefs = candidate.sourceRefs.map((source) => {
    if (
      !source
      || typeof source !== 'object'
      || Array.isArray(source)
      || typeof source.sessionId !== 'string'
      || !source.sessionId
      || typeof source.messageId !== 'string'
      || !source.messageId
    ) {
      runError('candidate_source');
    }
    const identity = JSON.stringify([source.sessionId, source.messageId]);
    if (seen.has(identity) || !materialsByIdentity.has(identity)) runError('candidate_source_identity');
    seen.add(identity);
    return { sessionId: source.sessionId, messageId: source.messageId };
  });
  if (!sourceRefs.some((source) => materialsByIdentity.get(
    JSON.stringify([source.sessionId, source.messageId]),
  )?.role === 'you')) {
    runError('candidate_primary_you');
  }
  return {
    category: candidate.category as ShiyingCategory,
    body: candidate.body,
    sourceRefs,
  };
}

function parseChunk(value: unknown, batchId: string, expectedIndex: number): ShiyingRunChunkV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) runError('chunk');
  const chunk = value as Partial<ShiyingRunChunkV1>;
  const chunkIndex = safeInteger(chunk.chunkIndex, 'chunk_index');
  if (chunkIndex !== expectedIndex) runError('chunk_order');
  if (!Array.isArray(chunk.materials) || chunk.materials.length < 1 || chunk.materials.length > 60) {
    runError('chunk_materials');
  }
  const materials = chunk.materials.map(parseMaterial);
  if (!materials.some((material) => material.role === 'you')) runError('chunk_primary_you');
  const sources = coverageSources(materials);
  const inputHash = createShiyingInputHash(sources);
  const expectedChunkId = createShiyingChunkId({ batchId, chunkIndex, sources });
  const expectedOperationId = createShiyingOperationId({
    lane: 'live',
    chunkId: expectedChunkId,
    contractVersion: SHIYING_EXTRACTION_CONTRACT_VERSION,
  });
  assertShiyingHash(chunk.inputHash, 'run_chunk_input_hash');
  assertShiyingDeterministicId(chunk.chunkId, 'chunk');
  assertShiyingDeterministicId(chunk.operationId, 'operation');
  if (
    chunk.inputHash !== inputHash
    || chunk.chunkId !== expectedChunkId
    || chunk.operationId !== expectedOperationId
  ) {
    runError('chunk_identity');
  }
  if (
    chunk.status !== 'pending'
    && chunk.status !== 'in_flight'
    && chunk.status !== 'completed'
  ) {
    runError('chunk_status');
  }
  const overlapFromPrevious = safeInteger(chunk.overlapFromPrevious, 'chunk_overlap');
  if (overlapFromPrevious > 2) runError('chunk_overlap');
  const estimatedTokens = safeInteger(chunk.estimatedTokens, 'chunk_estimated_tokens');
  const attemptCount = safeInteger(chunk.attemptCount, 'chunk_attempt_count');
  const lastErrorCode = technicalErrorCode(chunk.lastErrorCode, 'chunk_error');
  const startedAt = chunk.startedAt === null ? null : safeInteger(chunk.startedAt, 'chunk_started');
  const completedAt = chunk.completedAt === null ? null : safeInteger(chunk.completedAt, 'chunk_completed');
  const candidates = chunk.candidates === null
    ? null
    : Array.isArray(chunk.candidates)
      ? chunk.candidates.map((candidate) => parseCandidate(candidate, materials))
      : runError('chunk_candidates');
  if (
    (chunk.status === 'pending' && (candidates !== null || completedAt !== null))
    || (chunk.status === 'in_flight' && (candidates !== null || startedAt === null || completedAt !== null))
    || (chunk.status === 'completed' && (candidates === null || completedAt === null))
  ) {
    runError('chunk_state');
  }
  return {
    chunkIndex,
    chunkId: chunk.chunkId,
    operationId: chunk.operationId,
    inputHash,
    overlapFromPrevious,
    estimatedTokens,
    status: chunk.status,
    attemptCount,
    lastErrorCode,
    startedAt,
    completedAt,
    materials,
    candidates,
  };
}

export function parseShiyingManualRunV1(value: unknown): ShiyingManualRunV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) runError('invalid');
  const run = value as Partial<ShiyingManualRunV1>;
  const batchId = run.batchId;
  assertShiyingDeterministicId(batchId, 'batch');
  if (run.lane !== 'live') runError('lane');
  assertShiyingLifeDate(run.lifeDateStart, 'run_life_date_start');
  assertShiyingLifeDate(run.lifeDateEnd, 'run_life_date_end');
  if (run.lifeDateStart > run.lifeDateEnd) runError('life_date_range');
  const windowStartCursor = run.windowStartCursor === null
    ? null
    : parseShiyingMessageCursorV1(run.windowStartCursor);
  const windowEndCursor = parseShiyingMessageCursorV1(run.windowEndCursor);
  if (run.status !== 'pending' && run.status !== 'blocked') runError('status');
  const lastErrorCode = technicalErrorCode(run.lastErrorCode, 'error');
  if ((run.status === 'pending') !== (lastErrorCode === null)) runError('status_error');
  const createdAt = safeInteger(run.createdAt, 'created_at');
  const updatedAt = safeInteger(run.updatedAt, 'updated_at');
  if (updatedAt < createdAt) runError('time_order');
  if (!Array.isArray(run.chunks)) runError('chunks');
  if (
    run.chunks.length < 1
    && (run.status !== 'blocked' || lastErrorCode !== 'input_too_large')
  ) {
    runError('chunks');
  }
  const chunks = run.chunks.map((chunk, index) => parseChunk(chunk, batchId, index));
  return {
    batchId,
    lane: 'live',
    lifeDateStart: run.lifeDateStart,
    lifeDateEnd: run.lifeDateEnd,
    windowStartCursor,
    windowEndCursor,
    status: run.status,
    lastErrorCode,
    createdAt,
    updatedAt,
    chunks,
  };
}
