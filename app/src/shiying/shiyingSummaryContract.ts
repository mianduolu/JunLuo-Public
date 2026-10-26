import {
  assertShiyingDeterministicId, assertShiyingHash, assertShiyingLifeDate, assertShiyingUuidV4,
  canonicalJsonV1, createShiyingSummaryId, parseShiyingSummaryV1,
  type ShiyingSummaryKind, type ShiyingSummaryV1,
} from './shiyingContract';
import { parseShiyingSummaryV2, type ShiyingSummaryV2 } from './shiyingJournalContract';
import { hashShiyingJson } from './shiyingImageNoteContract';
import type { ShiyingTextRange } from './shiyingReviewContract';

export type ShiyingSummarySourceV3 = {
  kind: 'entry' | 'record'; id: string; contentHash: string | null; imageIds: string[];
  textRanges: ShiyingTextRange[] | null; imageNoteRanges: ShiyingTextRange[] | null; imageNoteHash: string | null;
};
export type ShiyingSummaryInputV1 = {
  kind: 'summary'; id: string; summaryKind: ShiyingSummaryKind;
  periodStartLifeDate: string; periodEndLifeDate: string; contentHash: string;
  textRanges: ShiyingTextRange[]; noteRanges: ShiyingTextRange[]; sources: ShiyingSummarySourceV3[];
} | {
  kind: 'event_node'; id: string; eventId: string; eventDate: string; title: string;
  contentHash: string; textRanges: ShiyingTextRange[]; sources: ShiyingSummarySourceV3[];
};
export type ShiyingSummaryImageCoverageV1 = {
  records: Array<{
    recordId: string; recordDate: string; recordContentHash: string;
    images: Array<{ id: string; ordinal: number; contentHash: string }>;
    state: 'ready' | 'unfinished' | 'skipped' | 'stale'; imageNoteHash: string | null;
    units: Array<{ id: string; captionStart: number; captionEnd: number; imageIds: string[]; completed: boolean }>;
  }>;
  legacyUnknownSummaryIds: string[];
};
export type ShiyingSummaryV3 = Omit<ShiyingSummaryV2, 'payloadVersion' | 'sources'> & {
  payloadVersion: 3; title: string; editedAt: number | null; sourceInvalidated: boolean;
  sources: ShiyingSummarySourceV3[]; inputSources: ShiyingSummaryInputV1[];
  imageCoverage: ShiyingSummaryImageCoverageV1;
};
export type ShiyingSummaryAnyV3 = ShiyingSummaryV1 | ShiyingSummaryV2 | ShiyingSummaryV3;
export const SHIYING_SUMMARY_TEXT_LIMITS = { week: 32_000, month: 64_000, year: 128_000 } as const;

function fail(code: string): never { throw new Error(`shiying_summary_contract_${code}`); }
function object(value: unknown, fields: string[], code: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  const result = value as Record<string, unknown>;
  if (Object.keys(result).length !== fields.length || fields.some(key => !Object.hasOwn(result, key))) fail(`${code}_fields`);
  return result;
}
function integer(value: unknown, code: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) fail(code);
  return value as number;
}
function text(value: unknown, code: string, maximum: number, blank = false) {
  if (typeof value !== 'string' || value.length > maximum || value !== value.trim() || !blank && !value.trim()) fail(code);
  return value;
}
function bool(value: unknown, code: string) { if (typeof value !== 'boolean') fail(code); return value; }
function member<T extends string>(value: unknown, options: readonly T[], code: string): T {
  if (typeof value !== 'string' || !options.includes(value as T)) fail(code);
  return value as T;
}
function nullableTime(value: unknown, code: string) { return value === null ? null : integer(value, code); }
function hash(value: unknown, code: string) { assertShiyingHash(value, code); return value; }
function uuid(value: unknown, code: string) { assertShiyingUuidV4(value, code); return value; }
function summaryId(value: unknown) { assertShiyingDeterministicId(value, 'summary'); return value; }
function date(value: unknown, code: string) { assertShiyingLifeDate(value, code); return value; }
function array<T>(value: unknown, parse: (item: unknown) => T, code: string, minimum = 0): T[] {
  if (!Array.isArray(value) || value.length < minimum) fail(code);
  return value.map(parse);
}
function unique<T>(values: T[], key: (item: T) => string, code: string) {
  if (new Set(values.map(key)).size !== values.length) fail(code);
  return values;
}
export function parseShiyingSummaryRanges(value: unknown): ShiyingTextRange[] {
  const ranges = array(value, item => {
    const range = object(item, ['start', 'end'], 'range');
    const start = integer(range.start, 'range_start'), end = integer(range.end, 'range_end');
    if (end <= start) fail('range_order');
    return { start, end };
  }, 'ranges');
  if (ranges.some((range, index) => index > 0 && range.start < ranges[index - 1].end)) fail('range_overlap_or_order');
  return ranges;
}
export function parseShiyingSummarySourceV3(value: unknown): ShiyingSummarySourceV3 {
  const source = object(value, ['kind', 'id', 'contentHash', 'imageIds', 'textRanges', 'imageNoteRanges', 'imageNoteHash'], 'source');
  const kind = member(source.kind, ['entry', 'record'] as const, 'source_kind');
  const imageIds = unique(array(source.imageIds, item => uuid(item, 'source_image_id'), 'source_images'), item => item, 'source_image_duplicate');
  const textRanges = source.textRanges === null ? null : parseShiyingSummaryRanges(source.textRanges);
  const imageNoteRanges = source.imageNoteRanges === null ? null : parseShiyingSummaryRanges(source.imageNoteRanges);
  const imageNoteHash = source.imageNoteHash === null ? null : hash(source.imageNoteHash, 'source_note_hash');
  if (kind === 'entry' && (imageIds.length || imageNoteHash !== null || imageNoteRanges?.length)) fail('entry_image_source');
  if (imageNoteRanges?.length && imageNoteHash === null) fail('source_note_hash_required');
  if (textRanges !== null && imageNoteRanges !== null && !textRanges.length && !imageNoteRanges.length) fail('source_empty_ranges');
  return { kind, id: uuid(source.id, 'source_id'), contentHash: source.contentHash === null ? null : hash(source.contentHash, 'source_content_hash'),
    imageIds, textRanges, imageNoteRanges, imageNoteHash };
}
function sources(value: unknown) {
  return unique(array(value, parseShiyingSummarySourceV3, 'sources', 1), item => `${item.kind}:${item.id}`, 'source_duplicate');
}
export function parseShiyingSummaryInputV1(value: unknown): ShiyingSummaryInputV1 {
  if (!value || typeof value !== 'object') fail('input');
  const kind = (value as { kind?: unknown }).kind;
  if (kind === 'summary') {
    const input = object(value, ['kind', 'id', 'summaryKind', 'periodStartLifeDate', 'periodEndLifeDate', 'contentHash', 'textRanges', 'noteRanges', 'sources'], 'summary_input');
    const summaryKind = member(input.summaryKind, ['week', 'month', 'year'] as const, 'input_summary_kind');
    const start = date(input.periodStartLifeDate, 'input_period_start'), end = date(input.periodEndLifeDate, 'input_period_end');
    const id = summaryId(input.id), textRanges = parseShiyingSummaryRanges(input.textRanges), noteRanges = parseShiyingSummaryRanges(input.noteRanges);
    if (end < start || id !== createShiyingSummaryId({ kind: summaryKind, periodStartLifeDate: start, periodEndLifeDate: end })) fail('input_summary_period');
    if (!textRanges.length && !noteRanges.length) fail('input_empty_ranges');
    return { kind, id, summaryKind, periodStartLifeDate: start, periodEndLifeDate: end, contentHash: hash(input.contentHash, 'input_hash'),
      textRanges, noteRanges, sources: sources(input.sources) };
  }
  const input = object(value, ['kind', 'id', 'eventId', 'eventDate', 'title', 'contentHash', 'textRanges', 'sources'], 'node_input');
  if (kind !== 'event_node') fail('input_kind');
  const textRanges = parseShiyingSummaryRanges(input.textRanges);
  if (!textRanges.length) fail('input_empty_ranges');
  return { kind, id: uuid(input.id, 'input_node_id'), eventId: uuid(input.eventId, 'input_event_id'), eventDate: date(input.eventDate, 'input_event_date'),
    title: text(input.title, 'input_event_title', 8_000), contentHash: hash(input.contentHash, 'input_hash'), textRanges, sources: sources(input.sources) };
}
export function parseShiyingSummaryImageCoverageV1(value: unknown): ShiyingSummaryImageCoverageV1 {
  const coverage = object(value, ['records', 'legacyUnknownSummaryIds'], 'coverage');
  const records = unique(array(coverage.records, item => {
    const record = object(item, ['recordId', 'recordDate', 'recordContentHash', 'images', 'state', 'imageNoteHash', 'units'], 'coverage_record');
    const images = unique(array(record.images, item => {
      const image = object(item, ['id', 'ordinal', 'contentHash'], 'coverage_image');
      return { id: uuid(image.id, 'coverage_image_id'), ordinal: integer(image.ordinal, 'coverage_image_ordinal'), contentHash: hash(image.contentHash, 'coverage_image_hash') };
    }, 'coverage_images', 1), item => item.id, 'coverage_image_duplicate');
    if (images.some((image, index) => index > 0 && image.ordinal <= images[index - 1].ordinal)) fail('coverage_image_order');
    const units = unique(array(record.units, item => {
      const unit = object(item, ['id', 'captionStart', 'captionEnd', 'imageIds', 'completed'], 'coverage_unit');
      const captionStart = integer(unit.captionStart, 'coverage_caption_start'), captionEnd = integer(unit.captionEnd, 'coverage_caption_end');
      if (captionEnd < captionStart) fail('coverage_caption_range');
      if (typeof unit.id !== 'string' || !/^[a-zA-Z0-9_.-]{1,200}$/u.test(unit.id)) fail('coverage_unit_id');
      const imageIds = unique(array(unit.imageIds, item => uuid(item, 'coverage_unit_image'), 'coverage_unit_images', 1), item => item, 'coverage_unit_image_duplicate');
      if (imageIds.some(id => !images.some(image => image.id === id))) fail('coverage_image_ownership');
      return { id: unit.id, captionStart, captionEnd, imageIds, completed: bool(unit.completed, 'coverage_completed') };
    }, 'coverage_units'), item => item.id, 'coverage_unit_duplicate');
    const state = member(record.state, ['ready', 'unfinished', 'skipped', 'stale'] as const, 'coverage_state');
    const imageNoteHash = record.imageNoteHash === null ? null : hash(record.imageNoteHash, 'coverage_note_hash');
    if (state === 'ready' && imageNoteHash === null) fail('coverage_ready_hash');
    return { recordId: uuid(record.recordId, 'coverage_record_id'), recordDate: date(record.recordDate, 'coverage_record_date'),
      recordContentHash: hash(record.recordContentHash, 'coverage_record_hash'), images, state, imageNoteHash, units };
  }, 'coverage_records'), item => item.recordId, 'coverage_record_duplicate');
  return { records, legacyUnknownSummaryIds: unique(array(coverage.legacyUnknownSummaryIds, summaryId, 'coverage_unknown'), item => item, 'coverage_unknown_duplicate') };
}
export function parseShiyingSummaryV3(value: unknown): ShiyingSummaryV3 {
  const record = object(value, ['payloadVersion', 'id', 'kind', 'periodStartLifeDate', 'periodEndLifeDate', 'title', 'factSummary', 'baiyunNote',
    'inputHash', 'contractVersion', 'status', 'dirty', 'rejectedAt', 'presentedAt', 'createdAt', 'updatedAt', 'editedAt', 'sourceInvalidated',
    'sources', 'inputSources', 'imageCoverage'], 'summary');
  if (record.payloadVersion !== 3) fail('summary_version');
  const kind = member(record.kind, ['week', 'month', 'year'] as const, 'summary_kind');
  const start = date(record.periodStartLifeDate, 'summary_start'), end = date(record.periodEndLifeDate, 'summary_end');
  const id = summaryId(record.id);
  if (end < start || id !== createShiyingSummaryId({ kind, periodStartLifeDate: start, periodEndLifeDate: end })) fail('summary_identity');
  const title = text(record.title, 'summary_title', 200);
  if (/\r|\n/u.test(title)) fail('summary_title_line');
  const createdAt = integer(record.createdAt, 'summary_created_at'), updatedAt = integer(record.updatedAt, 'summary_updated_at');
  const editedAt = nullableTime(record.editedAt, 'summary_edited_at'), rejectedAt = nullableTime(record.rejectedAt, 'summary_rejected_at'), presentedAt = nullableTime(record.presentedAt, 'summary_presented_at');
  if (updatedAt < createdAt || [editedAt, rejectedAt, presentedAt].some(at => at !== null && (at < createdAt || at > updatedAt))) fail('summary_time');
  const status = member(record.status, ['active', 'rejected'] as const, 'summary_status');
  if ((status === 'active') !== (rejectedAt === null)) fail('summary_rejection');
  const parsedSources = sources(record.sources);
  const inputSources = unique(array(record.inputSources, parseShiyingSummaryInputV1, 'summary_inputs'), item => `${item.kind}:${item.id}`, 'input_duplicate');
  for (const source of parsedSources) if (source.contentHash === null || source.textRanges === null || source.imageNoteRanges === null) {
    if (!inputSources.some(input => input.sources.some(root => canonicalJsonV1(root) === canonicalJsonV1(source)))) fail('unproven_legacy_source');
  }
  if (inputSources.some(input => input.kind === 'summary' && input.id === id
    && (editedAt === null || input.summaryKind !== kind || input.periodStartLifeDate !== start || input.periodEndLifeDate !== end))) fail('summary_self_input');
  return { payloadVersion: 3, id, kind, periodStartLifeDate: start, periodEndLifeDate: end, title,
    factSummary: text(record.factSummary, 'summary_fact', SHIYING_SUMMARY_TEXT_LIMITS[kind]),
    baiyunNote: text(record.baiyunNote, 'summary_note', SHIYING_SUMMARY_TEXT_LIMITS[kind], editedAt !== null),
    inputHash: hash(record.inputHash, 'summary_input_hash'), contractVersion: integer(record.contractVersion, 'summary_contract_version', 1),
    status, dirty: bool(record.dirty, 'summary_dirty'), rejectedAt, presentedAt, createdAt, updatedAt, editedAt,
    sourceInvalidated: bool(record.sourceInvalidated, 'summary_invalidated'), sources: parsedSources, inputSources,
    imageCoverage: parseShiyingSummaryImageCoverageV1(record.imageCoverage) };
}
export function parseShiyingSummaryAnyV3(value: unknown): ShiyingSummaryAnyV3 {
  const version = (value as { payloadVersion?: unknown })?.payloadVersion;
  return version === 1 ? parseShiyingSummaryV1(value) : version === 2 ? parseShiyingSummaryV2(value) : parseShiyingSummaryV3(value);
}
export const serializeShiyingSummaryV3 = (value: ShiyingSummaryV3) => canonicalJsonV1(parseShiyingSummaryV3(value));
export function deserializeShiyingSummaryV3(raw: string) {
  let value: unknown; try { value = JSON.parse(raw); } catch { return fail('summary_json_invalid'); }
  return parseShiyingSummaryV3(value);
}
export function createShiyingSummaryContentHash(value: ShiyingSummaryAnyV3) {
  const parsed = parseShiyingSummaryAnyV3(value);
  const common = { id: parsed.id, kind: parsed.kind, periodStartLifeDate: parsed.periodStartLifeDate,
    periodEndLifeDate: parsed.periodEndLifeDate, factSummary: parsed.factSummary, baiyunNote: parsed.baiyunNote };
  return hashShiyingJson(parsed.payloadVersion === 1 ? { ...common, sourceEntryIds: parsed.sourceEntryIds }
    : parsed.payloadVersion === 2 ? { ...common, sources: parsed.sources }
      : { ...common, title: parsed.title, sources: parsed.sources, inputSources: parsed.inputSources, imageCoverage: parsed.imageCoverage });
}
export function createShiyingSummaryStateHash(value: ShiyingSummaryAnyV3) {
  return hashShiyingJson({ contentHash: createShiyingSummaryContentHash(value), status: value.status,
    editedAt: value.payloadVersion === 3 ? value.editedAt : null });
}
export function projectShiyingSummarySources(summary: ShiyingSummaryAnyV3): ShiyingSummarySourceV3[] {
  if (summary.payloadVersion === 3) return summary.sources;
  if (summary.payloadVersion === 1) return summary.sourceEntryIds.map(id => ({ kind: 'entry', id, contentHash: null,
    imageIds: [], textRanges: null, imageNoteRanges: null, imageNoteHash: null }));
  return summary.sources.map(source => ({ ...source, textRanges: null, imageNoteRanges: null, imageNoteHash: null }));
}
export function createShiyingEventNodeInputHash(value: {
  id: string; eventId: string; eventDate: string; title: string; body: string; sources: ShiyingSummarySourceV3[];
}) {
  return hashShiyingJson({ id: value.id, eventId: value.eventId, eventDate: value.eventDate, title: value.title, body: value.body, sources: value.sources });
}
