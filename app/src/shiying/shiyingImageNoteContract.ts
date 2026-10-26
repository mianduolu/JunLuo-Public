import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  assertShiyingHash, assertShiyingLifeDate, assertShiyingUuidV4, canonicalJsonV1,
} from './shiyingContract';

export const SHIYING_IMAGE_NOTE_CONTRACT_VERSION = 1 as const;

export type ShiyingImageIdentityV1 = { id: string; ordinal: number; contentHash: string };
export type ShiyingImageModelSourceV1 = { baseUrl: string; model: string };
export type ShiyingRecordImageNoteV1 = {
  payloadVersion: 1;
  id: string;
  recordId: string;
  recordDate: string;
  recordContentHash: string;
  images: ShiyingImageIdentityV1[];
  inputHash: string;
  contractVersion: 1;
  promptHash: string;
  modelSource: ShiyingImageModelSourceV1;
  status: 'ready' | 'skipped';
  body: string | null;
  editedAt: number | null;
  skippedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

// Local task state, never a model response schema or synchronization entity.
export type ShiyingImageJobUnitV1 = {
  id: string;
  ordinal: number;
  captionStart: number;
  captionEnd: number;
  captionIndex: number;
  captionCount: number;
  imageIds: string[];
  estimatedTokens: number;
  status: 'pending' | 'in_flight' | 'completed';
  attemptCount: number;
  resultText: string | null;
  errorCode: string | null;
  startedAt: number | null;
  completedAt: number | null;
};

export type ShiyingRecordImageJobV1 = {
  payloadVersion: 1;
  recordId: string;
  recordDate: string;
  recordContentHash: string;
  images: ShiyingImageIdentityV1[];
  inputHash: string;
  contractVersion: 1;
  promptHash: string;
  frozenConfigHash: string;
  modelSource: ShiyingImageModelSourceV1;
  status: 'pending' | 'blocked' | 'skipped';
  errorCode: string | null;
  createdAt: number;
  updatedAt: number;
  units: ShiyingImageJobUnitV1[];
};

function fail(code: string): never { throw new Error(`shiying_image_contract_${code}`); }
function object(value: unknown, keys: readonly string[], code: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(`${code}_fields`);
  return record;
}
function integer(value: unknown, code: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) fail(code);
  return value as number;
}
function nullableTime(value: unknown, code: string) { return value === null ? null : integer(value, code); }
function text(value: unknown, code: string): string {
  if (typeof value !== 'string' || !value.trim()) fail(code);
  return value;
}
function hash(value: unknown, code: string): string { assertShiyingHash(value, code); return value; }
function uuid(value: unknown, code: string): string { assertShiyingUuidV4(value, code); return value; }
function errorCode(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,119}$/u.test(value)) fail('error_code');
  return value;
}
function member<T extends string>(value: unknown, values: readonly T[], code: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) fail(code);
  return value as T;
}
function unique(values: readonly string[], code: string) {
  if (new Set(values).size !== values.length) fail(code);
}

export function hashShiyingJson(value: unknown) {
  return `sha256:${bytesToHex(sha256(new TextEncoder().encode(canonicalJsonV1(value))))}`;
}
export function createShiyingImageNoteId(recordId: string) {
  assertShiyingUuidV4(recordId, 'image_note_record_id');
  return `shiying-image-note-v1-${hashShiyingJson({ context: 'junluo.shiying.v1/image-note', recordId }).slice(7)}`;
}
export function createShiyingImageUnitId(input: {
  recordId: string; recordContentHash: string; contractVersion: number;
  captionStart: number; captionEnd: number; imageIds: readonly string[];
}) {
  assertShiyingUuidV4(input.recordId, 'unit_record_id');
  assertShiyingHash(input.recordContentHash, 'unit_record_hash');
  if (input.contractVersion !== 1) fail('unit_contract_version');
  integer(input.captionStart, 'unit_caption_start'); integer(input.captionEnd, 'unit_caption_end');
  if (input.captionEnd < input.captionStart || input.imageIds.length < 1 || input.imageIds.length > 9) fail('unit_range');
  input.imageIds.forEach((id) => assertShiyingUuidV4(id, 'unit_image_id'));
  unique(input.imageIds, 'unit_image_duplicate');
  return `shiying-image-unit-v1-${hashShiyingJson({ context: 'junluo.shiying.v1/image-unit', recordId: input.recordId,
    recordContentHash: input.recordContentHash, contractVersion: input.contractVersion,
    captionStart: input.captionStart, captionEnd: input.captionEnd, imageIds: input.imageIds }).slice(7)}`;
}

function parseImages(value: unknown): ShiyingImageIdentityV1[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 9) fail('images');
  const images = value.map((item, index) => {
    const image = object(item, ['id', 'ordinal', 'contentHash'], 'image');
    if (image.ordinal !== index) fail('image_order');
    return { id: uuid(image.id, 'image_id'), ordinal: index, contentHash: hash(image.contentHash, 'image_hash') };
  });
  unique(images.map((image) => image.id), 'image_duplicate');
  return images;
}
function parseModelSource(value: unknown): ShiyingImageModelSourceV1 {
  const model = object(value, ['baseUrl', 'model'], 'model_source');
  const baseUrl = text(model.baseUrl, 'model_base_url');
  const modelName = text(model.model, 'model_name');
  if (baseUrl !== baseUrl.trim() || modelName !== modelName.trim()) fail('model_source_whitespace');
  let url: URL;
  try { url = new URL(baseUrl); } catch { return fail('model_base_url'); }
  // A transport endpoint is provenance, not a place to persist credentials.
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail('model_base_url');
  return { baseUrl, model: modelName };
}
function shared(record: Record<string, unknown>) {
  if (record.payloadVersion !== 1 || record.contractVersion !== 1) fail('version');
  const recordId = uuid(record.recordId, 'record_id');
  assertShiyingLifeDate(record.recordDate, 'image_record_date');
  const createdAt = integer(record.createdAt, 'created_at');
  const updatedAt = integer(record.updatedAt, 'updated_at');
  if (updatedAt < createdAt) fail('time_regression');
  const result = {
    payloadVersion: 1 as const, recordId, recordDate: record.recordDate,
    recordContentHash: hash(record.recordContentHash, 'record_hash'), images: parseImages(record.images),
    inputHash: hash(record.inputHash, 'input_hash'), contractVersion: 1 as const,
    promptHash: hash(record.promptHash, 'prompt_hash'), modelSource: parseModelSource(record.modelSource),
    createdAt, updatedAt,
  };
  if (result.inputHash !== createShiyingImageNoteInputHash(result)) fail('input_hash_mismatch');
  return result;
}
export function parseShiyingRecordImageNoteV1(value: unknown): ShiyingRecordImageNoteV1 {
  const record = object(value, ['payloadVersion', 'id', 'recordId', 'recordDate', 'recordContentHash', 'images',
    'inputHash', 'contractVersion', 'promptHash', 'modelSource', 'status', 'body', 'editedAt', 'skippedAt',
    'createdAt', 'updatedAt'], 'note');
  const base = shared(record);
  const id = createShiyingImageNoteId(base.recordId);
  if (record.id !== id) fail('note_id');
  const status = member(record.status, ['ready', 'skipped'] as const, 'note_status');
  const body = record.body === null ? null : text(record.body, 'note_body');
  const editedAt = nullableTime(record.editedAt, 'edited_at');
  const skippedAt = nullableTime(record.skippedAt, 'skipped_at');
  if ((status === 'ready' && (body === null || skippedAt !== null))
    || (status === 'skipped' && (body !== null || editedAt !== null || skippedAt === null))) fail('note_state');
  if ([editedAt, skippedAt].some((at) => at !== null && (at < base.createdAt || at > base.updatedAt))) fail('note_time');
  return { ...base, id, status, body, editedAt, skippedAt };
}

export function parseShiyingRecordImageJobV1(value: unknown): ShiyingRecordImageJobV1 {
  const record = object(value, ['payloadVersion', 'recordId', 'recordDate', 'recordContentHash', 'images',
    'inputHash', 'contractVersion', 'promptHash', 'modelSource', 'frozenConfigHash', 'status', 'errorCode',
    'createdAt', 'updatedAt', 'units'], 'job');
  const base = shared(record);
  const status = member(record.status, ['pending', 'blocked', 'skipped'] as const, 'job_status');
  const code = errorCode(record.errorCode);
  if ((status === 'pending' && code !== null) || (status !== 'pending' && code === null)) fail('job_state');
  if (!Array.isArray(record.units)) fail('job_units');
  if (!record.units.length && status === 'pending') fail('job_units_empty');
  const units = record.units.map((value, ordinal): ShiyingImageJobUnitV1 => {
    const unit = object(value, ['id', 'ordinal', 'captionStart', 'captionEnd', 'captionIndex', 'captionCount',
      'imageIds', 'estimatedTokens', 'status', 'attemptCount', 'resultText', 'errorCode', 'startedAt', 'completedAt'], 'unit');
    if (unit.ordinal !== ordinal) fail('unit_order');
    const captionStart = integer(unit.captionStart, 'caption_start');
    const captionEnd = integer(unit.captionEnd, 'caption_end');
    const captionIndex = integer(unit.captionIndex, 'caption_index');
    const captionCount = integer(unit.captionCount, 'caption_count', 1);
    if (captionEnd < captionStart || captionIndex >= captionCount) fail('caption_range');
    if (!Array.isArray(unit.imageIds) || !unit.imageIds.length || unit.imageIds.length > 9) fail('unit_images');
    const imageIds = unit.imageIds.map((id) => uuid(id, 'unit_image_id'));
    const positions = imageIds.map((id) => base.images.findIndex((image) => image.id === id));
    if (positions.some((position, index) => position < 0 || (index > 0 && position <= positions[index - 1]))) fail('unit_image_order');
    const id = createShiyingImageUnitId({ recordId: base.recordId, recordContentHash: base.recordContentHash,
      contractVersion: base.contractVersion, captionStart, captionEnd, imageIds });
    if (unit.id !== id) fail('unit_id');
    const unitStatus = member(unit.status, ['pending', 'in_flight', 'completed'] as const, 'unit_status');
    const resultText = unit.resultText === null ? null : text(unit.resultText, 'unit_result');
    const startedAt = nullableTime(unit.startedAt, 'unit_started_at');
    const completedAt = nullableTime(unit.completedAt, 'unit_completed_at');
    const attemptCount = integer(unit.attemptCount, 'unit_attempt_count');
    const unitCode = errorCode(unit.errorCode);
    if ((unitStatus === 'pending' && (resultText !== null || completedAt !== null))
      || (unitStatus === 'in_flight' && (resultText !== null || completedAt !== null || startedAt === null || attemptCount < 1))
      || (unitStatus === 'completed' && (resultText === null || startedAt === null || completedAt === null || unitCode !== null || attemptCount < 1))) fail('unit_state');
    if ([startedAt, completedAt].some((at) => at !== null && (at < base.createdAt || at > base.updatedAt))
      || (startedAt !== null && completedAt !== null && startedAt > completedAt)) fail('unit_time');
    return { id, ordinal, captionStart, captionEnd, captionIndex, captionCount, imageIds,
      estimatedTokens: integer(unit.estimatedTokens, 'unit_estimate'), status: unitStatus,
      attemptCount, resultText, errorCode: unitCode, startedAt, completedAt };
  });
  unique(units.map((unit) => unit.id), 'unit_duplicate');
  return { ...base, frozenConfigHash: hash(record.frozenConfigHash, 'config_hash'), status, errorCode: code, units };
}

export function createShiyingImageNoteInputHash(input: {
  recordId: string; recordContentHash: string; images: readonly ShiyingImageIdentityV1[];
  contractVersion: number; promptHash: string;
}) {
  uuid(input.recordId, 'input_record_id'); hash(input.recordContentHash, 'input_record_hash');
  parseImages(input.images); hash(input.promptHash, 'input_prompt_hash');
  if (input.contractVersion !== 1) fail('input_contract_version');
  return hashShiyingJson({ context: 'junluo.shiying.v1/image-note-input', recordId: input.recordId,
    recordContentHash: input.recordContentHash, images: input.images,
    contractVersion: input.contractVersion, promptHash: input.promptHash });
}
export function createShiyingImageNoteResultHash(value: ShiyingRecordImageNoteV1) {
  const note = parseShiyingRecordImageNoteV1(value);
  return hashShiyingJson({ context: 'junluo.shiying.v1/image-note-current', recordId: note.recordId,
    recordContentHash: note.recordContentHash, images: note.images, inputHash: note.inputHash,
    contractVersion: note.contractVersion, status: note.status, body: note.body, editedAt: note.editedAt,
    skippedAt: note.skippedAt });
}
function parseJson(raw: string) { try { return JSON.parse(raw) as unknown; } catch { return fail('json_invalid'); } }
export function serializeShiyingRecordImageNoteV1(value: ShiyingRecordImageNoteV1) { return canonicalJsonV1(parseShiyingRecordImageNoteV1(value)); }
export function deserializeShiyingRecordImageNoteV1(raw: string) { return parseShiyingRecordImageNoteV1(parseJson(raw)); }
export function serializeShiyingRecordImageJobV1(value: ShiyingRecordImageJobV1) { return canonicalJsonV1(parseShiyingRecordImageJobV1(value)); }
export function deserializeShiyingRecordImageJobV1(raw: string) { return parseShiyingRecordImageJobV1(parseJson(raw)); }

export function concatenateShiyingImageNoteResults(results: readonly string[]) {
  const seen = new Set<string>();
  const paragraphs: string[] = [];
  for (const result of results) for (const paragraph of result.split(/\r?\n[\t ]*\r?\n/u)) {
    if (paragraph.trim() && !seen.has(paragraph)) { seen.add(paragraph); paragraphs.push(paragraph); }
  }
  return paragraphs.join('\n\n');
}
