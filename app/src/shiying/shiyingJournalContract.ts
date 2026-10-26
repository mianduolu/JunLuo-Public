import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  assertShiyingHash,
  assertShiyingLifeDate,
  assertShiyingUuidV4,
  canonicalJsonV1,
  createShiyingEntryId,
  createShiyingSummaryId,
  parseShiyingEntryV1,
  SHIYING_SUMMARY_KINDS,
  type ShiyingEntryV1,
  type ShiyingSummaryV1,
} from './shiyingContract';

export type ShiyingRecordImageV1 = {
  payloadVersion: 1;
  id: string;
  recordId: string;
  ordinal: number;
  contentHash: string;
  mimeType: string;
  byteLength: number;
  width: number | null;
  height: number | null;
};

export type ShiyingRecordV1 = {
  payloadVersion: 1;
  id: string;
  recordDate: string;
  author: 'you';
  body: string;
  status: 'draft' | 'finalized';
  nominalFinalizeAt: number;
  finalizedAt: number | null;
  createdAt: number;
  updatedAt: number;
  images: ShiyingRecordImageV1[];
};

export type ShiyingFactSourceV1 = {
  kind: 'entry' | 'record';
  id: string;
  contentHash: string;
  imageIds: string[];
};

export type ShiyingEventNodeV1 = {
  payloadVersion: 1;
  id: string;
  eventId: string;
  eventDate: string;
  ordinal: number;
  body: string;
  createdAt: number;
  updatedAt: number;
  sources: ShiyingFactSourceV1[];
};

export type ShiyingEventExclusionV1 = {
  kind: 'entry' | 'record';
  id: string;
  updatedAt: number;
};

export type ShiyingEventV1 = {
  payloadVersion: 1;
  id: string;
  title: string;
  overview: string;
  dirty: boolean;
  createdAt: number;
  updatedAt: number;
  nodes: ShiyingEventNodeV1[];
  exclusions: ShiyingEventExclusionV1[];
};

export type ShiyingSummaryV2 = Omit<ShiyingSummaryV1, 'payloadVersion' | 'sourceEntryIds'> & {
  payloadVersion: 2;
  sources: ShiyingFactSourceV1[];
};

type PlainRecord = Record<string, unknown>;

function contractError(code: string): never {
  throw new Error(`shiying_journal_contract_${code}`);
}

function recordOf(value: unknown, keys: readonly string[], code: string): PlainRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) contractError(`${code}_invalid`);
  const record = value as PlainRecord;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    contractError(`${code}_fields`);
  }
  return record;
}

function integerOf(value: unknown, code: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) contractError(code);
  return value as number;
}

function textOf(value: unknown, code: string, allowEmpty = false, maximumLength?: number): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())
    || (maximumLength !== undefined && value.length > maximumLength)) contractError(code);
  return value;
}

function oneOf<T extends string>(value: unknown, values: readonly T[], code: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) contractError(code);
  return value as T;
}

function booleanOf(value: unknown, code: string): boolean {
  if (typeof value !== 'boolean') contractError(code);
  return value;
}

function nullableIntegerOf(value: unknown, code: string, minimum = 0) {
  return value === null ? null : integerOf(value, code, minimum);
}

function arrayOf<T>(value: unknown, parse: (item: unknown) => T, code: string, minimum = 0): T[] {
  if (!Array.isArray(value) || value.length < minimum) contractError(code);
  return value.map(parse);
}

function uuidOf(value: unknown, code: string): string {
  assertShiyingUuidV4(value, code);
  return value;
}

function assertTimes(createdAt: number, updatedAt: number, code: string) {
  if (createdAt > updatedAt) contractError(code);
}

function assertUnique<T>(items: readonly T[], key: (item: T) => string, code: string) {
  if (new Set(items.map(key)).size !== items.length) contractError(code);
}

function factIdentity(value: { kind: 'entry' | 'record'; id: string }) {
  return `${value.kind}:${value.id}`;
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseSources(value: unknown, code: string) {
  const sources = arrayOf(value, parseShiyingFactSourceV1, `${code}_empty`, 1);
  assertUnique(sources, factIdentity, `${code}_duplicate`);
  return sources;
}

export function parseShiyingRecordImageV1(value: unknown): ShiyingRecordImageV1 {
  const record = recordOf(value, [
    'payloadVersion', 'id', 'recordId', 'ordinal', 'contentHash', 'mimeType', 'byteLength', 'width', 'height',
  ], 'image');
  if (record.payloadVersion !== 1) contractError('image_version');
  assertShiyingHash(record.contentHash, 'image_hash');
  const mimeType = textOf(record.mimeType, 'image_mime_type');
  if (!/^image\/[a-zA-Z0-9!#$&^_.+\-]+$/u.test(mimeType)) contractError('image_mime_type');
  return {
    payloadVersion: 1,
    id: uuidOf(record.id, 'image_id'),
    recordId: uuidOf(record.recordId, 'image_record_id'),
    ordinal: integerOf(record.ordinal, 'image_ordinal'),
    contentHash: record.contentHash,
    mimeType,
    byteLength: integerOf(record.byteLength, 'image_byte_length', 1),
    width: nullableIntegerOf(record.width, 'image_width', 1),
    height: nullableIntegerOf(record.height, 'image_height', 1),
  };
}

export function parseShiyingRecordV1(value: unknown): ShiyingRecordV1 {
  const record = recordOf(value, [
    'payloadVersion', 'id', 'recordDate', 'author', 'body', 'status', 'nominalFinalizeAt',
    'finalizedAt', 'createdAt', 'updatedAt', 'images',
  ], 'record');
  if (record.payloadVersion !== 1) contractError('record_version');
  const id = uuidOf(record.id, 'record_id');
  assertShiyingLifeDate(record.recordDate, 'record_date');
  const author = oneOf(record.author, ['you'] as const, 'record_author');
  const body = textOf(record.body, 'record_body', true);
  const status = oneOf(record.status, ['draft', 'finalized'] as const, 'record_status');
  const nominalFinalizeAt = integerOf(record.nominalFinalizeAt, 'record_nominal_finalize_at');
  const finalizedAt = nullableIntegerOf(record.finalizedAt, 'record_finalized_at');
  const createdAt = integerOf(record.createdAt, 'record_created_at');
  const updatedAt = integerOf(record.updatedAt, 'record_updated_at');
  assertTimes(createdAt, updatedAt, 'record_mutation_time');
  if (nominalFinalizeAt <= createdAt) contractError('record_deadline');
  const images = arrayOf(record.images, parseShiyingRecordImageV1, 'record_images');
  assertUnique(images, (image) => image.id, 'record_image_duplicate');
  if (images.some((image, index) => image.recordId !== id || image.ordinal !== index)) {
    contractError('record_image_order_or_parent');
  }
  if ((status === 'draft' && finalizedAt !== null)
    || (status === 'finalized' && (finalizedAt === null || finalizedAt < nominalFinalizeAt
      || finalizedAt > updatedAt || (!body.trim() && images.length === 0)))) {
    contractError('record_finalization_state');
  }
  return {
    payloadVersion: 1, id, recordDate: record.recordDate, author, body, status,
    nominalFinalizeAt, finalizedAt, createdAt, updatedAt, images,
  };
}

export function parseShiyingFactSourceV1(value: unknown): ShiyingFactSourceV1 {
  const record = recordOf(value, ['kind', 'id', 'contentHash', 'imageIds'], 'fact_source');
  const kind = oneOf(record.kind, ['entry', 'record'] as const, 'fact_source_kind');
  assertShiyingHash(record.contentHash, 'fact_source_hash');
  const imageIds = arrayOf(record.imageIds, (id) => uuidOf(id, 'fact_source_image_id'), 'fact_source_images');
  assertUnique(imageIds, (id) => id, 'fact_source_image_duplicate');
  if (kind === 'entry' && imageIds.length > 0) contractError('fact_source_entry_images');
  return { kind, id: uuidOf(record.id, 'fact_source_id'), contentHash: record.contentHash, imageIds };
}

export function parseShiyingEventNodeV1(value: unknown): ShiyingEventNodeV1 {
  const record = recordOf(value, [
    'payloadVersion', 'id', 'eventId', 'eventDate', 'ordinal', 'body', 'createdAt', 'updatedAt', 'sources',
  ], 'event_node');
  if (record.payloadVersion !== 1) contractError('event_node_version');
  assertShiyingLifeDate(record.eventDate, 'event_node_date');
  const createdAt = integerOf(record.createdAt, 'event_node_created_at');
  const updatedAt = integerOf(record.updatedAt, 'event_node_updated_at');
  assertTimes(createdAt, updatedAt, 'event_node_mutation_time');
  return {
    payloadVersion: 1,
    id: uuidOf(record.id, 'event_node_id'),
    eventId: uuidOf(record.eventId, 'event_node_event_id'),
    eventDate: record.eventDate,
    ordinal: integerOf(record.ordinal, 'event_node_ordinal'),
    body: textOf(record.body, 'event_node_body'),
    createdAt, updatedAt,
    sources: parseSources(record.sources, 'event_node_sources'),
  };
}

export function parseShiyingEventExclusionV1(value: unknown): ShiyingEventExclusionV1 {
  const record = recordOf(value, ['kind', 'id', 'updatedAt'], 'event_exclusion');
  return {
    kind: oneOf(record.kind, ['entry', 'record'] as const, 'event_exclusion_kind'),
    id: uuidOf(record.id, 'event_exclusion_id'),
    updatedAt: integerOf(record.updatedAt, 'event_exclusion_updated_at'),
  };
}

export function parseShiyingEventV1(value: unknown): ShiyingEventV1 {
  const record = recordOf(value, [
    'payloadVersion', 'id', 'title', 'overview', 'dirty', 'createdAt', 'updatedAt', 'nodes', 'exclusions',
  ], 'event');
  if (record.payloadVersion !== 1) contractError('event_version');
  const id = uuidOf(record.id, 'event_id');
  const createdAt = integerOf(record.createdAt, 'event_created_at');
  const updatedAt = integerOf(record.updatedAt, 'event_updated_at');
  assertTimes(createdAt, updatedAt, 'event_mutation_time');
  const nodes = arrayOf(record.nodes, parseShiyingEventNodeV1, 'event_nodes');
  assertUnique(nodes, (node) => node.id, 'event_node_duplicate');
  const nextOrdinals = new Map<string, number>();
  nodes.forEach((node, index) => {
    const previous = nodes[index - 1];
    const nextOrdinal = nextOrdinals.get(node.eventDate) ?? 0;
    if (node.eventId !== id || node.ordinal !== nextOrdinal
      || (previous && (compareText(previous.eventDate, node.eventDate)
        || previous.ordinal - node.ordinal || compareText(previous.id, node.id)) > 0)) {
      contractError('event_node_order_or_parent');
    }
    nextOrdinals.set(node.eventDate, nextOrdinal + 1);
  });
  const exclusions = arrayOf(record.exclusions, parseShiyingEventExclusionV1, 'event_exclusions');
  assertUnique(exclusions, factIdentity, 'event_exclusion_duplicate');
  if (exclusions.some((exclusion, index) => index > 0
    && (compareText(exclusions[index - 1].kind, exclusion.kind)
      || compareText(exclusions[index - 1].id, exclusion.id)) > 0)) {
    contractError('event_exclusion_order');
  }
  // Historical nodes remain readable after a fact is excluded or deleted.
  // The store validates exclusions against newly written node snapshots.
  return {
    payloadVersion: 1, id,
    title: textOf(record.title, 'event_title'),
    overview: textOf(record.overview, 'event_overview'),
    dirty: booleanOf(record.dirty, 'event_dirty'),
    createdAt, updatedAt, nodes, exclusions,
  };
}

export function parseShiyingSummaryV2(value: unknown): ShiyingSummaryV2 {
  const record = recordOf(value, [
    'payloadVersion', 'id', 'kind', 'periodStartLifeDate', 'periodEndLifeDate', 'factSummary',
    'baiyunNote', 'inputHash', 'contractVersion', 'status', 'dirty', 'rejectedAt',
    'presentedAt', 'createdAt', 'updatedAt', 'sources',
  ], 'summary');
  if (record.payloadVersion !== 2) contractError('summary_version');
  const kind = oneOf(record.kind, SHIYING_SUMMARY_KINDS, 'summary_kind');
  assertShiyingLifeDate(record.periodStartLifeDate, 'summary_period_start');
  assertShiyingLifeDate(record.periodEndLifeDate, 'summary_period_end');
  if (record.periodStartLifeDate > record.periodEndLifeDate) contractError('summary_period_range');
  const id = createShiyingSummaryId({
    kind,
    periodStartLifeDate: record.periodStartLifeDate,
    periodEndLifeDate: record.periodEndLifeDate,
  });
  if (record.id !== id) contractError('summary_id_mismatch');
  const factSummary = textOf(record.factSummary, 'summary_fact', false, 8_000);
  const baiyunNote = textOf(record.baiyunNote, 'summary_note', false, 8_000);
  if (factSummary !== factSummary.trim() || baiyunNote !== baiyunNote.trim()) {
    contractError('summary_text_whitespace');
  }
  assertShiyingHash(record.inputHash, 'summary_input_hash');
  const status = oneOf(record.status, ['active', 'rejected'] as const, 'summary_status');
  const rejectedAt = nullableIntegerOf(record.rejectedAt, 'summary_rejected_at');
  const presentedAt = nullableIntegerOf(record.presentedAt, 'summary_presented_at');
  const createdAt = integerOf(record.createdAt, 'summary_created_at');
  const updatedAt = integerOf(record.updatedAt, 'summary_updated_at');
  assertTimes(createdAt, updatedAt, 'summary_mutation_time');
  if ((status === 'active' && rejectedAt !== null) || (status === 'rejected' && rejectedAt === null)) {
    contractError('summary_rejection_state');
  }
  if ([rejectedAt, presentedAt].some((at) => at !== null && (at < createdAt || at > updatedAt))) {
    contractError('summary_mutation_time');
  }
  return {
    payloadVersion: 2, id, kind,
    periodStartLifeDate: record.periodStartLifeDate,
    periodEndLifeDate: record.periodEndLifeDate,
    factSummary, baiyunNote,
    inputHash: record.inputHash,
    contractVersion: integerOf(record.contractVersion, 'summary_contract_version', 1),
    status,
    dirty: booleanOf(record.dirty, 'summary_dirty'),
    rejectedAt, presentedAt, createdAt, updatedAt,
    sources: parseSources(record.sources, 'summary_sources'),
  };
}

export const createShiyingRecordId = createShiyingEntryId;
export const createShiyingRecordImageId = createShiyingEntryId;
export const createShiyingEventId = createShiyingEntryId;
export const createShiyingEventNodeId = createShiyingEntryId;

function contentHash(value: unknown) {
  return `sha256:${bytesToHex(sha256(new TextEncoder().encode(canonicalJsonV1(value))))}`;
}

export function createShiyingRecordContentHash(value: ShiyingRecordV1) {
  const record = parseShiyingRecordV1(value);
  return contentHash({
    context: 'junluo.shiying.v1/record-fact',
    recordDate: record.recordDate,
    body: record.body,
    images: record.images.map(({ id, contentHash: hash }) => ({ id, contentHash: hash })),
  });
}

export function createShiyingEntryFactContentHash(value: ShiyingEntryV1) {
  const entry = parseShiyingEntryV1(value);
  return contentHash({
    context: 'junluo.shiying.v1/entry-fact',
    lifeDate: entry.lifeDate,
    category: entry.category,
    body: entry.body,
    eventStartedAt: entry.eventStartedAt,
    eventEndedAt: entry.eventEndedAt,
    sources: entry.sources,
  });
}

export function getShiyingMediaRelativePath(hash: string) {
  assertShiyingHash(hash, 'media_hash');
  return `shiying-media/${hash.slice('sha256:'.length)}`;
}

export function createShiyingDraftRecord(input: {
  createdAt: number;
  body?: string;
  images?: ShiyingRecordImageV1[];
}): ShiyingRecordV1 {
  const createdAt = integerOf(input.createdAt, 'draft_created_at');
  const date = new Date(createdAt);
  const recordDate = [
    String(date.getFullYear()).padStart(4, '0'),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
  assertShiyingLifeDate(recordDate, 'draft_date');
  const nominalFinalizeAt = new Date(
    date.getFullYear(), date.getMonth(), date.getDate() + 1, 0, 0, 0, 0,
  ).getTime();
  const id = createShiyingRecordId();
  return parseShiyingRecordV1({
    payloadVersion: 1, id, recordDate, author: 'you', body: input.body ?? '', status: 'draft',
    nominalFinalizeAt, finalizedAt: null, createdAt, updatedAt: createdAt,
    images: (input.images ?? []).map((image) => ({ ...image, recordId: id })),
  });
}

function parseJson(raw: string, code: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return contractError(code);
  }
}

export function serializeShiyingRecordV1(value: ShiyingRecordV1) {
  return canonicalJsonV1(parseShiyingRecordV1(value));
}

export function deserializeShiyingRecordV1(raw: string) {
  return parseShiyingRecordV1(parseJson(raw, 'record_json_invalid'));
}

export function serializeShiyingEventV1(value: ShiyingEventV1) {
  return canonicalJsonV1(parseShiyingEventV1(value));
}

export function deserializeShiyingEventV1(raw: string) {
  return parseShiyingEventV1(parseJson(raw, 'event_json_invalid'));
}

export function serializeShiyingSummaryV2(value: ShiyingSummaryV2) {
  return canonicalJsonV1(parseShiyingSummaryV2(value));
}

export function deserializeShiyingSummaryV2(raw: string) {
  return parseShiyingSummaryV2(parseJson(raw, 'summary_json_invalid'));
}
