import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import canonicalize from 'canonicalize';
import * as Crypto from 'expo-crypto';

export const SHIYING_PAYLOAD_VERSION = 1 as const;
export const SHIYING_EXTRACTION_CONTRACT_VERSION = 1 as const;

export const SHIYING_CATEGORIES = [
  'anticipation',
  'liking',
  'accomplishment',
  'comfort',
  'felt_seen',
  'creative_excitement',
] as const;

export const SHIYING_SUMMARY_KINDS = ['week', 'month', 'year'] as const;
export const SHIYING_LANES = ['live', 'backfill'] as const;

export type ShiyingCategory = typeof SHIYING_CATEGORIES[number];
export type ShiyingSummaryKind = typeof SHIYING_SUMMARY_KINDS[number];
export type ShiyingLane = typeof SHIYING_LANES[number];
export type ShiyingRole = 'I' | 'you';
export type ShiyingEntryStatus = 'active' | 'rejected';
export type ShiyingEvidenceKind = 'primary_you' | 'context_I';
export type ShiyingCoverageOutcome = 'zero' | 'entries';

export type ShiyingMessageCursorV1 = {
  sessionId: string;
  messageId: string;
  messageCreatedAt: number;
};

export type ShiyingEntrySourceV1 = ShiyingMessageCursorV1 & {
  ordinal: number;
  role: ShiyingRole;
  evidenceKind: ShiyingEvidenceKind;
  excerptSnapshot: string;
  evidenceQuote: string | null;
  contentHash: string;
};

export type ShiyingEntryV1 = {
  payloadVersion: 1;
  id: string;
  batchId: string;
  lifeDate: string;
  category: ShiyingCategory;
  body: string;
  eventStartedAt: number;
  eventEndedAt: number;
  status: ShiyingEntryStatus;
  editedAt: number | null;
  rejectedAt: number | null;
  presentedAt: number | null;
  createdAt: number;
  updatedAt: number;
  sources: ShiyingEntrySourceV1[];
};

export type ShiyingSummaryV1 = {
  payloadVersion: 1;
  id: string;
  kind: ShiyingSummaryKind;
  periodStartLifeDate: string;
  periodEndLifeDate: string;
  factSummary: string;
  baiyunNote: string;
  inputHash: string;
  contractVersion: number;
  status: ShiyingEntryStatus;
  dirty: boolean;
  rejectedAt: number | null;
  presentedAt: number | null;
  createdAt: number;
  updatedAt: number;
  sourceEntryIds: string[];
};

export type ShiyingCoverageSourceV1 = ShiyingMessageCursorV1 & {
  ordinal: number;
  role: ShiyingRole;
  contentHash: string;
};

export type ShiyingCoverageReceiptV1 = {
  payloadVersion: 1;
  id: string;
  lane: ShiyingLane;
  batchId: string;
  chunkId: string;
  chunkIndex: number;
  lifeDateStart: string;
  lifeDateEnd: string;
  windowStartCursor: ShiyingMessageCursorV1 | null;
  windowEndCursor: ShiyingMessageCursorV1;
  inputHash: string;
  contractVersion: number;
  outcome: ShiyingCoverageOutcome;
  executorDeviceId: string | null;
  completedAt: number;
  updatedAt: number;
  sources: ShiyingCoverageSourceV1[];
};

type PlainRecord = Record<string, unknown>;

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const DETERMINISTIC_ID_PATTERN = /^shiying-(summary|batch|chunk|coverage|operation)-v1-[0-9a-f]{64}$/u;
const LIFE_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;
const MAX_BODY_LENGTH = 2_000;
const MAX_SUMMARY_TEXT_LENGTH = 8_000;
const MAX_SOURCE_TEXT_LENGTH = 20_000;
const MAX_STABLE_ID_LENGTH = 512;

function contractError(code: string): never {
  throw new Error(`shiying_contract_${code}`);
}

function recordOf(value: unknown, code: string): PlainRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return contractError(code);
  }
  return value as PlainRecord;
}

function assertExactKeys(record: PlainRecord, expected: readonly string[], code: string) {
  const actual = Object.keys(record).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length
    || actual.some((key, index) => key !== sortedExpected[index])
  ) {
    contractError(code);
  }
}

function stringOf(
  value: unknown,
  code: string,
  maximumLength = MAX_STABLE_ID_LENGTH,
  allowEmpty = false,
) {
  if (
    typeof value !== 'string'
    || value.length > maximumLength
    || (!allowEmpty && (!value || value !== value.trim()))
  ) {
    return contractError(code);
  }
  return value;
}

function integerOf(value: unknown, code: string, minimum = 0) {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    return contractError(code);
  }
  return value as number;
}

function nullableTimestampOf(value: unknown, code: string) {
  return value === null ? null : integerOf(value, code);
}

function oneOf<T extends string>(value: unknown, values: readonly T[], code: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    return contractError(code);
  }
  return value as T;
}

export function assertShiyingUuidV4(value: unknown, code = 'uuid_invalid'): asserts value is string {
  if (typeof value !== 'string' || !UUID_V4_PATTERN.test(value)) contractError(code);
}

export function assertShiyingHash(value: unknown, code = 'hash_invalid'): asserts value is string {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) contractError(code);
}

export function assertShiyingDeterministicId(
  value: unknown,
  kind?: 'summary' | 'batch' | 'chunk' | 'coverage' | 'operation',
): asserts value is string {
  if (typeof value !== 'string' || !DETERMINISTIC_ID_PATTERN.test(value)) {
    contractError('deterministic_id_invalid');
  }
  if (kind && !value.startsWith(`shiying-${kind}-v1-`)) {
    contractError('deterministic_id_kind_invalid');
  }
}

export function assertShiyingLifeDate(value: unknown, code = 'life_date_invalid'): asserts value is string {
  if (typeof value !== 'string') contractError(code);
  const match = LIFE_DATE_PATTERN.exec(value);
  if (!match) contractError(code);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const normalized = new Date(Date.UTC(year, month - 1, day));
  if (
    normalized.getUTCFullYear() !== year
    || normalized.getUTCMonth() !== month - 1
    || normalized.getUTCDate() !== day
  ) {
    contractError(code);
  }
}

function parseCursor(value: unknown, code: string): ShiyingMessageCursorV1 {
  const record = recordOf(value, code);
  assertExactKeys(record, ['sessionId', 'messageId', 'messageCreatedAt'], `${code}_fields`);
  return {
    sessionId: stringOf(record.sessionId, `${code}_session_id`),
    messageId: stringOf(record.messageId, `${code}_message_id`),
    messageCreatedAt: integerOf(record.messageCreatedAt, `${code}_created_at`),
  };
}

export function parseShiyingMessageCursorV1(value: unknown) {
  return parseCursor(value, 'cursor_invalid');
}

function assertSequentialOrdinals(values: readonly { ordinal: number }[], code: string) {
  if (values.some((value, index) => value.ordinal !== index)) contractError(code);
}

function parseEntrySource(value: unknown): ShiyingEntrySourceV1 {
  const record = recordOf(value, 'entry_source_invalid');
  assertExactKeys(record, [
    'ordinal',
    'sessionId',
    'messageId',
    'messageCreatedAt',
    'role',
    'evidenceKind',
    'excerptSnapshot',
    'evidenceQuote',
    'contentHash',
  ], 'entry_source_fields');
  const role = oneOf(record.role, ['I', 'you'] as const, 'entry_source_role');
  const evidenceKind = oneOf(
    record.evidenceKind,
    ['primary_you', 'context_I'] as const,
    'entry_source_evidence_kind',
  );
  const excerptSnapshot = stringOf(
    record.excerptSnapshot,
    'entry_source_excerpt',
    MAX_SOURCE_TEXT_LENGTH,
    true,
  );
  let evidenceQuote: string | null = null;
  if (record.evidenceQuote !== null) {
    evidenceQuote = stringOf(
      record.evidenceQuote,
      'entry_source_quote',
      MAX_SOURCE_TEXT_LENGTH,
    );
  }
  if (
    (evidenceKind === 'primary_you'
      && (role !== 'you' || evidenceQuote === null || !excerptSnapshot.includes(evidenceQuote)))
    || (evidenceKind === 'context_I' && (role !== 'I' || evidenceQuote !== null))
  ) {
    contractError('entry_source_evidence_mismatch');
  }
  assertShiyingHash(record.contentHash, 'entry_source_hash');
  return {
    ordinal: integerOf(record.ordinal, 'entry_source_ordinal'),
    sessionId: stringOf(record.sessionId, 'entry_source_session_id'),
    messageId: stringOf(record.messageId, 'entry_source_message_id'),
    messageCreatedAt: integerOf(record.messageCreatedAt, 'entry_source_created_at'),
    role,
    evidenceKind,
    excerptSnapshot,
    evidenceQuote,
    contentHash: record.contentHash,
  };
}

function assertUniqueMessageSources(
  sources: readonly { sessionId: string; messageId: string }[],
  code: string,
) {
  const keys = new Set<string>();
  for (const source of sources) {
    const key = canonicalJsonV1([source.sessionId, source.messageId]);
    if (keys.has(key)) contractError(code);
    keys.add(key);
  }
}

function assertMutationTimes(value: {
  createdAt: number;
  updatedAt: number;
  editedAt?: number | null;
  rejectedAt: number | null;
  presentedAt: number | null;
}) {
  const mutations = [value.editedAt, value.rejectedAt, value.presentedAt]
    .filter((time): time is number => time !== null && time !== undefined);
  if (
    value.createdAt > value.updatedAt
    || mutations.some((time) => time < value.createdAt || time > value.updatedAt)
  ) {
    contractError('mutation_time_invalid');
  }
}

export function parseShiyingEntryV1(value: unknown): ShiyingEntryV1 {
  const record = recordOf(value, 'entry_invalid');
  assertExactKeys(record, [
    'payloadVersion',
    'id',
    'batchId',
    'lifeDate',
    'category',
    'body',
    'eventStartedAt',
    'eventEndedAt',
    'status',
    'editedAt',
    'rejectedAt',
    'presentedAt',
    'createdAt',
    'updatedAt',
    'sources',
  ], 'entry_fields');
  if (record.payloadVersion !== SHIYING_PAYLOAD_VERSION) contractError('entry_version');
  assertShiyingUuidV4(record.id, 'entry_id');
  assertShiyingDeterministicId(record.batchId, 'batch');
  assertShiyingLifeDate(record.lifeDate, 'entry_life_date');
  const category = oneOf(record.category, SHIYING_CATEGORIES, 'entry_category');
  const body = stringOf(record.body, 'entry_body', MAX_BODY_LENGTH);
  const eventStartedAt = integerOf(record.eventStartedAt, 'entry_started_at');
  const eventEndedAt = integerOf(record.eventEndedAt, 'entry_ended_at');
  if (eventEndedAt < eventStartedAt) contractError('entry_event_range');
  const status = oneOf(record.status, ['active', 'rejected'] as const, 'entry_status');
  const editedAt = nullableTimestampOf(record.editedAt, 'entry_edited_at');
  const rejectedAt = nullableTimestampOf(record.rejectedAt, 'entry_rejected_at');
  const presentedAt = nullableTimestampOf(record.presentedAt, 'entry_presented_at');
  const createdAt = integerOf(record.createdAt, 'entry_created_at');
  const updatedAt = integerOf(record.updatedAt, 'entry_updated_at');
  if (
    (status === 'active' && rejectedAt !== null)
    || (status === 'rejected' && rejectedAt === null)
  ) {
    contractError('entry_rejection_state');
  }
  assertMutationTimes({ createdAt, updatedAt, editedAt, rejectedAt, presentedAt });
  if (!Array.isArray(record.sources) || record.sources.length < 1) {
    contractError('entry_sources_empty');
  }
  const sources = record.sources.map(parseEntrySource);
  assertSequentialOrdinals(sources, 'entry_source_order');
  assertUniqueMessageSources(sources, 'entry_source_duplicate');
  if (!sources.some((source) => source.evidenceKind === 'primary_you')) {
    contractError('entry_primary_you_missing');
  }
  return {
    payloadVersion: SHIYING_PAYLOAD_VERSION,
    id: record.id,
    batchId: record.batchId,
    lifeDate: record.lifeDate,
    category,
    body,
    eventStartedAt,
    eventEndedAt,
    status,
    editedAt,
    rejectedAt,
    presentedAt,
    createdAt,
    updatedAt,
    sources,
  };
}

export function parseShiyingSummaryV1(value: unknown): ShiyingSummaryV1 {
  const record = recordOf(value, 'summary_invalid');
  assertExactKeys(record, [
    'payloadVersion',
    'id',
    'kind',
    'periodStartLifeDate',
    'periodEndLifeDate',
    'factSummary',
    'baiyunNote',
    'inputHash',
    'contractVersion',
    'status',
    'dirty',
    'rejectedAt',
    'presentedAt',
    'createdAt',
    'updatedAt',
    'sourceEntryIds',
  ], 'summary_fields');
  if (record.payloadVersion !== SHIYING_PAYLOAD_VERSION) contractError('summary_version');
  const kind = oneOf(record.kind, SHIYING_SUMMARY_KINDS, 'summary_kind');
  assertShiyingLifeDate(record.periodStartLifeDate, 'summary_period_start');
  assertShiyingLifeDate(record.periodEndLifeDate, 'summary_period_end');
  if (record.periodStartLifeDate > record.periodEndLifeDate) contractError('summary_period_range');
  const expectedId = createShiyingSummaryId({
    kind,
    periodStartLifeDate: record.periodStartLifeDate,
    periodEndLifeDate: record.periodEndLifeDate,
  });
  if (record.id !== expectedId) contractError('summary_id_mismatch');
  const factSummary = stringOf(
    record.factSummary,
    'summary_fact',
    MAX_SUMMARY_TEXT_LENGTH,
  );
  const baiyunNote = stringOf(
    record.baiyunNote,
    'summary_note',
    MAX_SUMMARY_TEXT_LENGTH,
  );
  assertShiyingHash(record.inputHash, 'summary_input_hash');
  const contractVersion = integerOf(record.contractVersion, 'summary_contract_version', 1);
  const status = oneOf(record.status, ['active', 'rejected'] as const, 'summary_status');
  if (typeof record.dirty !== 'boolean') contractError('summary_dirty');
  const rejectedAt = nullableTimestampOf(record.rejectedAt, 'summary_rejected_at');
  const presentedAt = nullableTimestampOf(record.presentedAt, 'summary_presented_at');
  const createdAt = integerOf(record.createdAt, 'summary_created_at');
  const updatedAt = integerOf(record.updatedAt, 'summary_updated_at');
  if (
    (status === 'active' && rejectedAt !== null)
    || (status === 'rejected' && rejectedAt === null)
  ) {
    contractError('summary_rejection_state');
  }
  assertMutationTimes({ createdAt, updatedAt, rejectedAt, presentedAt });
  if (!Array.isArray(record.sourceEntryIds) || record.sourceEntryIds.length < 2) {
    contractError('summary_sources_too_few');
  }
  const sourceEntryIds = record.sourceEntryIds.map((id) => {
    assertShiyingUuidV4(id, 'summary_source_id');
    return id;
  });
  if (new Set(sourceEntryIds).size !== sourceEntryIds.length) {
    contractError('summary_source_duplicate');
  }
  return {
    payloadVersion: SHIYING_PAYLOAD_VERSION,
    id: expectedId,
    kind,
    periodStartLifeDate: record.periodStartLifeDate,
    periodEndLifeDate: record.periodEndLifeDate,
    factSummary,
    baiyunNote,
    inputHash: record.inputHash,
    contractVersion,
    status,
    dirty: record.dirty,
    rejectedAt,
    presentedAt,
    createdAt,
    updatedAt,
    sourceEntryIds,
  };
}

function parseCoverageSource(value: unknown): ShiyingCoverageSourceV1 {
  const record = recordOf(value, 'coverage_source_invalid');
  assertExactKeys(record, [
    'ordinal',
    'sessionId',
    'messageId',
    'messageCreatedAt',
    'role',
    'contentHash',
  ], 'coverage_source_fields');
  assertShiyingHash(record.contentHash, 'coverage_source_hash');
  return {
    ordinal: integerOf(record.ordinal, 'coverage_source_ordinal'),
    sessionId: stringOf(record.sessionId, 'coverage_source_session_id'),
    messageId: stringOf(record.messageId, 'coverage_source_message_id'),
    messageCreatedAt: integerOf(record.messageCreatedAt, 'coverage_source_created_at'),
    role: oneOf(record.role, ['I', 'you'] as const, 'coverage_source_role'),
    contentHash: record.contentHash,
  };
}

export function parseShiyingCoverageReceiptV1(value: unknown): ShiyingCoverageReceiptV1 {
  const record = recordOf(value, 'coverage_invalid');
  assertExactKeys(record, [
    'payloadVersion',
    'id',
    'lane',
    'batchId',
    'chunkId',
    'chunkIndex',
    'lifeDateStart',
    'lifeDateEnd',
    'windowStartCursor',
    'windowEndCursor',
    'inputHash',
    'contractVersion',
    'outcome',
    'executorDeviceId',
    'completedAt',
    'updatedAt',
    'sources',
  ], 'coverage_fields');
  if (record.payloadVersion !== SHIYING_PAYLOAD_VERSION) contractError('coverage_version');
  const lane = oneOf(record.lane, SHIYING_LANES, 'coverage_lane');
  assertShiyingDeterministicId(record.batchId, 'batch');
  assertShiyingDeterministicId(record.chunkId, 'chunk');
  const chunkIndex = integerOf(record.chunkIndex, 'coverage_chunk_index');
  assertShiyingLifeDate(record.lifeDateStart, 'coverage_life_date_start');
  assertShiyingLifeDate(record.lifeDateEnd, 'coverage_life_date_end');
  if (record.lifeDateStart > record.lifeDateEnd) contractError('coverage_life_date_range');
  const windowStartCursor = record.windowStartCursor === null
    ? null
    : parseCursor(record.windowStartCursor, 'coverage_start_cursor');
  const windowEndCursor = parseCursor(record.windowEndCursor, 'coverage_end_cursor');
  if (!Array.isArray(record.sources) || record.sources.length < 1) {
    contractError('coverage_sources_empty');
  }
  const sources = record.sources.map(parseCoverageSource);
  assertSequentialOrdinals(sources, 'coverage_source_order');
  assertUniqueMessageSources(sources, 'coverage_source_duplicate');
  const inputHash = createShiyingInputHash(sources);
  if (record.inputHash !== inputHash) contractError('coverage_input_hash_mismatch');
  const expectedBatchId = createShiyingBatchId({
    lane,
    lifeDateStart: record.lifeDateStart,
    lifeDateEnd: record.lifeDateEnd,
    windowStartCursor,
    windowEndCursor,
  });
  if (record.batchId !== expectedBatchId) contractError('coverage_batch_id_mismatch');
  const expectedChunkId = createShiyingChunkId({
    batchId: expectedBatchId,
    chunkIndex,
    sources,
  });
  if (record.chunkId !== expectedChunkId) contractError('coverage_chunk_id_mismatch');
  const contractVersion = integerOf(record.contractVersion, 'coverage_contract_version', 1);
  const expectedId = createShiyingCoverageId({
    lane,
    chunkId: expectedChunkId,
    inputHash,
    contractVersion,
  });
  if (record.id !== expectedId) contractError('coverage_id_mismatch');
  const outcome = oneOf(
    record.outcome,
    ['zero', 'entries'] as const,
    'coverage_outcome',
  );
  let executorDeviceId: string | null = null;
  if (record.executorDeviceId !== null) {
    assertShiyingUuidV4(record.executorDeviceId, 'coverage_executor_device_id');
    executorDeviceId = record.executorDeviceId;
  }
  const completedAt = integerOf(record.completedAt, 'coverage_completed_at');
  const updatedAt = integerOf(record.updatedAt, 'coverage_updated_at');
  if (updatedAt !== completedAt) contractError('coverage_immutable_time');
  return {
    payloadVersion: SHIYING_PAYLOAD_VERSION,
    id: expectedId,
    lane,
    batchId: expectedBatchId,
    chunkId: expectedChunkId,
    chunkIndex,
    lifeDateStart: record.lifeDateStart,
    lifeDateEnd: record.lifeDateEnd,
    windowStartCursor,
    windowEndCursor,
    inputHash,
    contractVersion,
    outcome,
    executorDeviceId,
    completedAt,
    updatedAt,
    sources,
  };
}

export function canonicalJsonV1(value: unknown) {
  const result = canonicalize(value);
  if (result === undefined) contractError('canonical_json_invalid');
  return result;
}

function digestHex(value: unknown) {
  return bytesToHex(sha256(new TextEncoder().encode(canonicalJsonV1(value))));
}

function deterministicId(
  kind: 'summary' | 'batch' | 'chunk' | 'coverage' | 'operation',
  value: unknown,
) {
  return `shiying-${kind}-v1-${digestHex(value)}`;
}

export function createShiyingMessageContentHash(input: {
  role: ShiyingRole;
  content: string;
}) {
  const role = oneOf(input.role, ['I', 'you'] as const, 'message_hash_role');
  const content = stringOf(input.content, 'message_hash_content', MAX_SOURCE_TEXT_LENGTH, true);
  return `sha256:${digestHex({
    context: 'junluo.shiying.v1/message-content',
    role,
    content,
  })}`;
}

export function createShiyingInputHash(sources: readonly ShiyingCoverageSourceV1[]) {
  const parsed = sources.map(parseCoverageSource);
  assertSequentialOrdinals(parsed, 'input_hash_source_order');
  assertUniqueMessageSources(parsed, 'input_hash_source_duplicate');
  return `sha256:${digestHex({
    context: 'junluo.shiying.v1/input',
    sources: parsed,
  })}`;
}

export function createShiyingEntryId() {
  const id = Crypto.randomUUID().toLowerCase();
  assertShiyingUuidV4(id, 'generated_entry_id');
  return id;
}

export function createShiyingSummaryId(input: {
  kind: ShiyingSummaryKind;
  periodStartLifeDate: string;
  periodEndLifeDate: string;
}) {
  const kind = oneOf(input.kind, SHIYING_SUMMARY_KINDS, 'summary_id_kind');
  assertShiyingLifeDate(input.periodStartLifeDate, 'summary_id_period_start');
  assertShiyingLifeDate(input.periodEndLifeDate, 'summary_id_period_end');
  if (input.periodStartLifeDate > input.periodEndLifeDate) contractError('summary_id_period_range');
  return deterministicId('summary', {
    context: 'junluo.shiying.v1/summary-id',
    kind,
    periodStartLifeDate: input.periodStartLifeDate,
    periodEndLifeDate: input.periodEndLifeDate,
  });
}

export function createShiyingBatchId(input: {
  lane: ShiyingLane;
  lifeDateStart: string;
  lifeDateEnd: string;
  windowStartCursor: ShiyingMessageCursorV1 | null;
  windowEndCursor: ShiyingMessageCursorV1;
}) {
  const lane = oneOf(input.lane, SHIYING_LANES, 'batch_id_lane');
  assertShiyingLifeDate(input.lifeDateStart, 'batch_id_life_date_start');
  assertShiyingLifeDate(input.lifeDateEnd, 'batch_id_life_date_end');
  if (input.lifeDateStart > input.lifeDateEnd) contractError('batch_id_life_date_range');
  const windowStartCursor = input.windowStartCursor === null
    ? null
    : parseCursor(input.windowStartCursor, 'batch_id_start_cursor');
  const windowEndCursor = parseCursor(input.windowEndCursor, 'batch_id_end_cursor');
  return deterministicId('batch', {
    context: 'junluo.shiying.v1/batch-id',
    lane,
    lifeDateStart: input.lifeDateStart,
    lifeDateEnd: input.lifeDateEnd,
    windowStartCursor,
    windowEndCursor,
  });
}

export function createShiyingChunkId(input: {
  batchId: string;
  chunkIndex: number;
  sources: readonly ShiyingCoverageSourceV1[];
}) {
  assertShiyingDeterministicId(input.batchId, 'batch');
  const chunkIndex = integerOf(input.chunkIndex, 'chunk_id_index');
  const sources = input.sources.map(parseCoverageSource);
  assertSequentialOrdinals(sources, 'chunk_id_source_order');
  assertUniqueMessageSources(sources, 'chunk_id_source_duplicate');
  return deterministicId('chunk', {
    context: 'junluo.shiying.v1/chunk-id',
    batchId: input.batchId,
    chunkIndex,
    sources,
  });
}

export function createShiyingCoverageId(input: {
  lane: ShiyingLane;
  chunkId: string;
  inputHash: string;
  contractVersion: number;
}) {
  const lane = oneOf(input.lane, SHIYING_LANES, 'coverage_id_lane');
  assertShiyingDeterministicId(input.chunkId, 'chunk');
  assertShiyingHash(input.inputHash, 'coverage_id_input_hash');
  const contractVersion = integerOf(input.contractVersion, 'coverage_id_contract_version', 1);
  return deterministicId('coverage', {
    context: 'junluo.shiying.v1/coverage-id',
    lane,
    chunkId: input.chunkId,
    inputHash: input.inputHash,
    contractVersion,
  });
}

export function createShiyingOperationId(input: {
  lane: ShiyingLane;
  chunkId: string;
  contractVersion: number;
}) {
  const lane = oneOf(input.lane, SHIYING_LANES, 'operation_id_lane');
  assertShiyingDeterministicId(input.chunkId, 'chunk');
  const contractVersion = integerOf(input.contractVersion, 'operation_id_contract_version', 1);
  return deterministicId('operation', {
    context: 'junluo.shiying.v1/operation-id',
    lane,
    chunkId: input.chunkId,
    contractVersion,
  });
}

function parseJson(raw: string, code: string) {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return contractError(code);
  }
}

export function serializeShiyingEntryV1(value: ShiyingEntryV1) {
  return canonicalJsonV1(parseShiyingEntryV1(value));
}

export function deserializeShiyingEntryV1(raw: string) {
  return parseShiyingEntryV1(parseJson(raw, 'entry_json_invalid'));
}

export function serializeShiyingSummaryV1(value: ShiyingSummaryV1) {
  return canonicalJsonV1(parseShiyingSummaryV1(value));
}

export function deserializeShiyingSummaryV1(raw: string) {
  return parseShiyingSummaryV1(parseJson(raw, 'summary_json_invalid'));
}

export function serializeShiyingCoverageReceiptV1(value: ShiyingCoverageReceiptV1) {
  return canonicalJsonV1(parseShiyingCoverageReceiptV1(value));
}

export function deserializeShiyingCoverageReceiptV1(raw: string) {
  return parseShiyingCoverageReceiptV1(parseJson(raw, 'coverage_json_invalid'));
}
