import {
  assertShiyingHash, assertShiyingLifeDate, assertShiyingUuidV4, canonicalJsonV1,
  createShiyingEntryId, createShiyingSummaryId,
  type ShiyingSummaryKind,
} from './shiyingContract';
import {
  parseShiyingEventNodeV1, parseShiyingEventExclusionV1, parseShiyingFactSourceV1,
  type ShiyingEventNodeV1, type ShiyingEventExclusionV1, type ShiyingFactSourceV1,
} from './shiyingJournalContract';
import { hashShiyingJson } from './shiyingImageNoteContract';

export type ShiyingTextRange = { start: number; end: number };
export type ShiyingScopedSourceV1 = ShiyingFactSourceV1 & {
  textRanges: ShiyingTextRange[];
  imageNoteRanges: ShiyingTextRange[];
  imageNoteHash: string | null;
};
export type ShiyingEventNodeV2 = Omit<ShiyingEventNodeV1, 'payloadVersion' | 'sources'> & {
  payloadVersion: 2; sources: ShiyingScopedSourceV1[];
};
export type ShiyingEventAssociationFeedbackV1 = {
  nodeId: string; nodeBody: string; fromEventId: string; toEventId: string | null;
  sources: Array<ShiyingFactSourceV1 | ShiyingScopedSourceV1>; updatedAt: number;
};
export type ShiyingEventV2 = {
  payloadVersion: 2; id: string; title: string; overview: string; dirty: boolean;
  createdAt: number; updatedAt: number; nodes: Array<ShiyingEventNodeV1 | ShiyingEventNodeV2>;
  exclusions: ShiyingEventExclusionV1[]; associationFeedback: ShiyingEventAssociationFeedbackV1[];
};
export type ShiyingEventPatch = {
  id: string; title: string; overview: string; expectedUpdatedAt: number | null;
  nodes: ShiyingEventNodeV2[];
};
export type ShiyingTopicV1 = {
  payloadVersion: 1; id: string; summaryId: string; title: string; dirty: boolean;
  createdAt: number; updatedAt: number; sources: ShiyingScopedSourceV1[];
};
export type ShiyingReviewReceipt = {
  kind?: ShiyingSummaryKind; contractVersion?: 1 | 2; regenerationIntentId?: string | null;
  id: string; periodStart: string; periodEnd: string; inputHash: string; basisHash: string; promptHash: string;
  outcome: 'review' | 'empty' | 'sparse'; summaryId: string | null; completedAt: number;
};
export type ShiyingReviewChunk = {
  id: string; runId: string; index: number; stage: 'read' | 'final';
  status: 'pending' | 'in_flight' | 'completed'; payloadJson: string; resultJson: string | null;
  attempts: number; startedAt: number | null; completedAt: number | null; lastErrorCode: string | null;
};
export type ShiyingReviewRun = {
  kind?: ShiyingSummaryKind; contractVersion?: 1 | 2;
  id: string; periodStart: string; periodEnd: string; inputHash: string; promptHash: string;
  status: 'pending' | 'blocked'; lastErrorCode: string | null; planJson: string;
  createdAt: number; updatedAt: number; chunks: ShiyingReviewChunk[];
};

function fail(code: string): never { throw new Error(`shiying_review_contract_${code}`); }
function object(value: unknown, keys: readonly string[], code: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  const record = value as Record<string, unknown>, actual = Object.keys(record).sort(), expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(`${code}_fields`);
  return record;
}
function reviewObject(value: unknown, keys: readonly string[], optional: readonly string[], code: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  const record = value as Record<string, unknown>;
  if (keys.some(key => !Object.hasOwn(record, key)) || Object.keys(record).some(key => !keys.includes(key) && !optional.includes(key))) fail(`${code}_fields`);
  return record;
}
function reviewVersion(record: Record<string, unknown>) {
  const kind = record.kind === undefined ? 'week' : member(record.kind, ['week', 'month', 'year'] as const, 'review_kind');
  const contractVersion = record.contractVersion === undefined ? 1 : integer(record.contractVersion, 'review_version', 1);
  if (contractVersion > 2 || contractVersion === 1 && kind !== 'week') fail('review_version');
  return { kind, contractVersion: contractVersion as 1 | 2 };
}
function integer(value: unknown, code: string, minimum = 0) {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) fail(code);
  return value as number;
}
function text(value: unknown, code: string, maximum = 8_000) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) fail(code);
  return value;
}
function identity(value: unknown, code: string) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.-]{1,200}$/u.test(value)) fail(code);
  return value;
}
function uuid(value: unknown, code: string) { assertShiyingUuidV4(value, code); return value; }
function hash(value: unknown, code: string) { assertShiyingHash(value, code); return value; }
function nullableTime(value: unknown, code: string) { return value === null ? null : integer(value, code); }
function bool(value: unknown, code: string) { if (typeof value !== 'boolean') fail(code); return value; }
function member<T extends string>(value: unknown, choices: readonly T[], code: string): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) fail(code);
  return value as T;
}
function errorCode(value: unknown) {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,119}$/u.test(value)) fail('error_code');
  return value;
}
function jsonText(value: unknown, code: string) {
  if (typeof value !== 'string') fail(code);
  try { JSON.parse(value); } catch { fail(code); }
  return value;
}
function array<T>(value: unknown, parse: (item: unknown) => T, code: string, minimum = 0) {
  if (!Array.isArray(value) || value.length < minimum) fail(code);
  return value.map(parse);
}
function unique<T>(values: T[], key: (value: T) => string, code: string) {
  if (new Set(values.map(key)).size !== values.length) fail(code);
  return values;
}
function period(record: Record<string, unknown>) {
  assertShiyingLifeDate(record.periodStart, 'review_period_start');
  assertShiyingLifeDate(record.periodEnd, 'review_period_end');
  if (record.periodStart > record.periodEnd) fail('period_order');
  return { periodStart: record.periodStart, periodEnd: record.periodEnd };
}
export function parseShiyingScopedSourceV1(value: unknown): ShiyingScopedSourceV1 {
  const record = object(value, ['kind', 'id', 'contentHash', 'imageIds', 'textRanges', 'imageNoteRanges', 'imageNoteHash'], 'source');
  const source = parseShiyingFactSourceV1({ kind: record.kind, id: record.id, contentHash: record.contentHash, imageIds: record.imageIds });
  const parseRanges = (value: unknown) => { const ranges = array(value, item => {
    const range = object(item, ['start', 'end'], 'range');
    const start = integer(range.start, 'range_start'), end = integer(range.end, 'range_end');
    if (end <= start) fail('range_order');
    return { start, end };
  }, 'ranges');
  ranges.forEach((range, index) => { if (index > 0 && range.start < ranges[index - 1].end) fail('ranges_overlap'); });
  return ranges; };
  const textRanges = parseRanges(record.textRanges), imageNoteRanges = parseRanges(record.imageNoteRanges);
  const imageNoteHash = record.imageNoteHash === null ? null : hash(record.imageNoteHash, 'source_image_note_hash');
  if (source.kind === 'entry' && (imageNoteHash !== null || imageNoteRanges.length > 0)) fail('entry_image_note');
  if (!textRanges.length && !imageNoteRanges.length || imageNoteRanges.length > 0 && imageNoteHash === null) fail('source_empty_ranges');
  return { ...source, textRanges, imageNoteRanges, imageNoteHash };
}
function sources(value: unknown) {
  return unique(array(value, parseShiyingScopedSourceV1, 'sources_empty', 1), item => `${item.kind}:${item.id}`, 'source_duplicate');
}
export function parseShiyingEventNodeV2(value: unknown): ShiyingEventNodeV2 {
  const record = object(value, ['payloadVersion', 'id', 'eventId', 'eventDate', 'ordinal', 'body', 'createdAt', 'updatedAt', 'sources'], 'node');
  if (record.payloadVersion !== 2) fail('node_version');
  const parsedSources = sources(record.sources);
  const base = parseShiyingEventNodeV1({ ...record, payloadVersion: 1,
    sources: parsedSources.map(({ textRanges: _ranges, imageNoteRanges: _imageRanges, imageNoteHash: _note, ...source }) => source) });
  return { ...base, payloadVersion: 2, sources: parsedSources };
}
export function parseShiyingEventAssociationFeedbackV1(value: unknown): ShiyingEventAssociationFeedbackV1 {
  const record = object(value, ['nodeId', 'nodeBody', 'fromEventId', 'toEventId', 'sources', 'updatedAt'], 'feedback');
  const fromEventId = uuid(record.fromEventId, 'feedback_from_event');
  const toEventId = record.toEventId === null ? null : uuid(record.toEventId, 'feedback_to_event');
  if (fromEventId === toEventId) fail('feedback_same_event');
  return { nodeId: uuid(record.nodeId, 'feedback_node'), nodeBody: text(record.nodeBody, 'feedback_body'),
    fromEventId, toEventId, sources: unique(array(record.sources, item => item !== null && typeof item === 'object' && Object.hasOwn(item, 'textRanges')
      ? parseShiyingScopedSourceV1(item) : parseShiyingFactSourceV1(item), 'feedback_sources', 1),
    item => `${item.kind}:${item.id}`, 'feedback_source_duplicate'), updatedAt: integer(record.updatedAt, 'feedback_updated_at') };
}
export function parseShiyingEventV2(value: unknown): ShiyingEventV2 {
  const record = object(value, ['payloadVersion', 'id', 'title', 'overview', 'dirty', 'createdAt', 'updatedAt', 'nodes', 'exclusions', 'associationFeedback'], 'event');
  if (record.payloadVersion !== 2) fail('event_version');
  const id = uuid(record.id, 'event_id'), createdAt = integer(record.createdAt, 'event_created_at'), updatedAt = integer(record.updatedAt, 'event_updated_at');
  if (updatedAt < createdAt) fail('event_time');
  const nodes = unique(array(record.nodes, item => {
    const version = (item as { payloadVersion?: unknown })?.payloadVersion;
    return version === 1 ? parseShiyingEventNodeV1(item) : parseShiyingEventNodeV2(item);
  }, 'event_nodes'), node => node.id, 'node_duplicate');
  const next = new Map<string, number>();
  nodes.forEach((node, index) => {
    if (node.eventId !== id || node.ordinal !== (next.get(node.eventDate) ?? 0)
      || index > 0 && nodes[index - 1].eventDate > node.eventDate) fail('node_order_or_parent');
    next.set(node.eventDate, node.ordinal + 1);
  });
  const exclusions = unique(array(record.exclusions, parseShiyingEventExclusionV1, 'exclusions'), item => `${item.kind}:${item.id}`, 'exclusion_duplicate');
  const associationFeedback = unique(array(record.associationFeedback, parseShiyingEventAssociationFeedbackV1, 'feedback'), item => item.nodeId, 'feedback_duplicate');
  if (associationFeedback.some(item => item.fromEventId !== id || item.updatedAt > updatedAt)) fail('feedback_parent_or_time');
  return { payloadVersion: 2, id, title: text(record.title, 'event_title'), overview: text(record.overview, 'event_overview'),
    dirty: bool(record.dirty, 'event_dirty'), createdAt, updatedAt, nodes, exclusions, associationFeedback };
}
export function parseShiyingTopicV1(value: unknown): ShiyingTopicV1 {
  const record = object(value, ['payloadVersion', 'id', 'summaryId', 'title', 'dirty', 'createdAt', 'updatedAt', 'sources'], 'topic');
  if (record.payloadVersion !== 1) fail('topic_version');
  const createdAt = integer(record.createdAt, 'topic_created_at'), updatedAt = integer(record.updatedAt, 'topic_updated_at');
  if (updatedAt < createdAt) fail('topic_time');
  const summaryId = identity(record.summaryId, 'topic_summary_id');
  if (!/^shiying-summary-v1-[0-9a-f]{64}$/u.test(summaryId)) fail('topic_summary_id');
  return { payloadVersion: 1, id: uuid(record.id, 'topic_id'), summaryId, title: text(record.title, 'topic_title', 300),
    dirty: bool(record.dirty, 'topic_dirty'), createdAt, updatedAt, sources: sources(record.sources) };
}
export function parseShiyingReviewReceipt(value: unknown): ShiyingReviewReceipt {
  const record = reviewObject(value, ['id', 'periodStart', 'periodEnd', 'inputHash', 'basisHash', 'promptHash', 'outcome', 'summaryId', 'completedAt'], ['kind', 'contractVersion', 'regenerationIntentId'], 'receipt');
  const version = reviewVersion(record);
  const regenerationIntentId = record.regenerationIntentId === undefined || record.regenerationIntentId === null ? null : uuid(record.regenerationIntentId, 'regeneration_intent');
  if (version.contractVersion === 1 && regenerationIntentId !== null) fail('receipt_version');
  const dates = period(record), inputHash = hash(record.inputHash, 'receipt_input_hash'), promptHash = hash(record.promptHash, 'receipt_prompt_hash');
  const outcome = member(record.outcome, ['review', 'empty', 'sparse'] as const, 'receipt_outcome');
  const summaryId = record.summaryId === null ? null : identity(record.summaryId, 'receipt_summary_id');
  const expectedSummaryId = createShiyingSummaryId({ kind: version.kind, periodStartLifeDate: dates.periodStart, periodEndLifeDate: dates.periodEnd });
  if (outcome === 'review' ? summaryId !== expectedSummaryId : summaryId !== null) fail('receipt_summary');
  const id = identity(record.id, 'receipt_id');
  const expectedId = version.contractVersion === 1 ? createShiyingReviewOperationId({ ...dates, inputHash, promptHash })
    : createShiyingReviewOperationIdV2({ ...dates, kind: version.kind, contractVersion: 2, inputHash, promptHash, regenerationIntentId });
  if (id !== expectedId) fail('receipt_identity');
  return { id, ...dates, inputHash, basisHash: hash(record.basisHash, 'receipt_basis_hash'), promptHash, outcome, summaryId, completedAt: integer(record.completedAt, 'receipt_completed_at'),
    ...(version.contractVersion === 2 ? { kind: version.kind, contractVersion: 2 as const, regenerationIntentId } : {}) };
}
export function parseShiyingReviewChunk(value: unknown): ShiyingReviewChunk {
  const record = object(value, ['id', 'runId', 'index', 'stage', 'status', 'payloadJson', 'resultJson', 'attempts', 'startedAt', 'completedAt', 'lastErrorCode'], 'chunk');
  const status = member(record.status, ['pending', 'in_flight', 'completed'] as const, 'chunk_status');
  const attempts = integer(record.attempts, 'chunk_attempts'), startedAt = nullableTime(record.startedAt, 'chunk_started_at'), completedAt = nullableTime(record.completedAt, 'chunk_completed_at');
  const resultJson = record.resultJson === null ? null : jsonText(record.resultJson, 'chunk_result_json');
  if (status === 'completed' ? resultJson === null || completedAt === null || startedAt === null
    : resultJson !== null || completedAt !== null) fail('chunk_result_state');
  if (status === 'in_flight' && (startedAt === null || attempts < 1)
    || completedAt !== null && startedAt !== null && completedAt < startedAt) fail('chunk_attempt_state');
  return { id: identity(record.id, 'chunk_id'), runId: identity(record.runId, 'chunk_run_id'), index: integer(record.index, 'chunk_index'),
    stage: member(record.stage, ['read', 'final'] as const, 'chunk_stage'), status, payloadJson: jsonText(record.payloadJson, 'chunk_payload_json'),
    resultJson, attempts, startedAt, completedAt, lastErrorCode: errorCode(record.lastErrorCode) };
}
export function parseShiyingReviewRun(value: unknown): ShiyingReviewRun {
  const record = reviewObject(value, ['id', 'periodStart', 'periodEnd', 'inputHash', 'promptHash', 'status', 'lastErrorCode', 'planJson', 'createdAt', 'updatedAt', 'chunks'], ['kind', 'contractVersion'], 'run');
  const version = reviewVersion(record);
  const dates = period(record), createdAt = integer(record.createdAt, 'run_created_at'), updatedAt = integer(record.updatedAt, 'run_updated_at');
  if (updatedAt < createdAt) fail('run_time');
  const id = identity(record.id, 'run_id'), chunks = unique(array(record.chunks, parseShiyingReviewChunk, 'run_chunks', 1), chunk => chunk.id, 'chunk_duplicate');
  if (chunks.some((chunk, index) => chunk.runId !== id || chunk.index !== index)) fail('chunk_order_or_parent');
  return { id, ...dates, inputHash: hash(record.inputHash, 'run_input_hash'), promptHash: hash(record.promptHash, 'run_prompt_hash'),
    status: member(record.status, ['pending', 'blocked'] as const, 'run_status'), lastErrorCode: errorCode(record.lastErrorCode),
    planJson: jsonText(record.planJson, 'run_plan_json'), createdAt, updatedAt, chunks,
    ...(version.contractVersion === 2 ? { kind: version.kind, contractVersion: 2 as const } : {}) };
}
export function createShiyingReviewOperationId(input: { periodStart: string; periodEnd: string; inputHash: string; promptHash: string }) {
  const dates = period(input); hash(input.inputHash, 'operation_input_hash'); hash(input.promptHash, 'operation_prompt_hash');
  return `shiying-review-v1-${hashShiyingJson({ context: 'junluo.shiying.v1/review', contractVersion: 1, ...dates,
    inputHash: input.inputHash, promptHash: input.promptHash }).slice(7)}`;
}
export function createShiyingReviewOperationIdV2(input: {
  kind: ShiyingSummaryKind; periodStart: string; periodEnd: string; inputHash: string; promptHash: string;
  contractVersion?: 2; regenerationIntentId?: string | null;
}) {
  const dates = period(input), kind = member(input.kind, ['week', 'month', 'year'] as const, 'operation_kind');
  hash(input.inputHash, 'operation_input_hash'); hash(input.promptHash, 'operation_prompt_hash');
  const regenerationIntentId = input.regenerationIntentId ?? null;
  if (regenerationIntentId !== null) uuid(regenerationIntentId, 'operation_regeneration_intent');
  return `shiying-review-v2-${hashShiyingJson({ context: 'junluo.shiying.v2/review', contractVersion: 2, kind, ...dates,
    inputHash: input.inputHash, promptHash: input.promptHash, regenerationIntentId }).slice(7)}`;
}
export const createShiyingTopicId = createShiyingEntryId;
export const serializeShiyingEventV2 = (value: ShiyingEventV2) => canonicalJsonV1(parseShiyingEventV2(value));
export const serializeShiyingTopicV1 = (value: ShiyingTopicV1) => canonicalJsonV1(parseShiyingTopicV1(value));
export const serializeShiyingReviewReceipt = (value: ShiyingReviewReceipt) => canonicalJsonV1(parseShiyingReviewReceipt(value));
function parseJson(raw: string) { try { return JSON.parse(raw) as unknown; } catch { return fail('json_invalid'); } }
export const deserializeShiyingEventV2 = (raw: string) => parseShiyingEventV2(parseJson(raw));
export const deserializeShiyingTopicV1 = (raw: string) => parseShiyingTopicV1(parseJson(raw));
export const deserializeShiyingReviewReceipt = (raw: string) => parseShiyingReviewReceipt(parseJson(raw));
