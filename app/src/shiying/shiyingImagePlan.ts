import type { AiConnection } from '../ai/types';
import { estimateReadingTokens, READING_IMAGE_RESERVED_TOKENS } from '../reading/readingContent';
import { createShiyingRecordContentHash, parseShiyingRecordV1, type ShiyingRecordV1 } from './shiyingJournalContract';
import { parseShiyingModelJson } from './shiyingModelJson';
import { createShiyingImageUnitId } from './shiyingImageNoteContract';
export { concatenateShiyingImageNoteResults as joinShiyingImageResults } from './shiyingImageNoteContract';
import { buildShiyingImageUnitMaterial, type ShiyingImageMaterialRange } from './shiyingImagePrompt';

export const SHIYING_IMAGE_REQUEST_LIMIT = 2;
export const SHIYING_IMAGE_GROUP_LIMIT = 9;
export const SHIYING_IMAGE_TRANSPORT_LIMIT = 46 * 1024 * 1024;
export const SHIYING_IMAGE_OUTPUT_LIMIT = 8_192;
export const SHIYING_IMAGE_CAPACITY_MARGIN = 512;

export type ShiyingImagePlanUnitV1 = ShiyingImageMaterialRange & {
  id: string;
  ordinal: number;
  imageIds: string[];
  estimatedTokens: number;
};
export type ShiyingRecordImagePlanV1 = {
  kind: 'ready' | 'blocked';
  recordId: string;
  recordContentHash: string;
  units: ShiyingImagePlanUnitV1[];
  errorCode: 'capacity_blocked' | null;
};
export type ShiyingImageRequestUnit = { recordId: string; unit: ShiyingImagePlanUnitV1 };
export type ShiyingImageRequestPlan = {
  units: ShiyingImageRequestUnit[];
  estimatedInputTokens: number;
  outputTokens: number;
  estimatedTokens: number;
  transportBytes: number;
};
type CapacityInput = {
  stablePrompt: string;
  connection: Pick<AiConnection, 'contextWindowTokens' | 'modelParameters'>;
};

function configuredOutputLimit(connection: CapacityInput['connection']) {
  const configured = connection.modelParameters?.maxTokens;
  return configured?.enabled
    ? Math.min(SHIYING_IMAGE_OUTPUT_LIMIT, Math.floor(configured.value)) : SHIYING_IMAGE_OUTPUT_LIMIT;
}

function requestBudget(input: CapacityInput, values: readonly {
  record: ShiyingRecordV1; unit: ShiyingImageMaterialRange;
}[]) {
  let estimatedInputTokens = estimateReadingTokens(input.stablePrompt) + 10;
  let transportBytes = 0, imageCount = 0;
  for (const { record, unit } of values) {
    for (const part of buildShiyingImageUnitMaterial(record, unit)) {
      if (part.type === 'text') estimatedInputTokens += estimateReadingTokens(part.text) + 4;
      else {
        const image = record.images.find(candidate => candidate.id === part.imageId)!;
        estimatedInputTokens += READING_IMAGE_RESERVED_TOKENS;
        transportBytes += 4 * Math.ceil(image.byteLength / 3) + image.mimeType.length + 13;
        imageCount += 1;
      }
    }
  }
  const outputTokens = Math.min(configuredOutputLimit(input.connection), values.length * 800 + 256);
  const estimatedTokens = estimatedInputTokens + outputTokens + SHIYING_IMAGE_CAPACITY_MARGIN;
  const contextLimit = input.connection.contextWindowTokens ?? 65_536;
  return {
    estimatedInputTokens, outputTokens, estimatedTokens, transportBytes,
    fits: Number.isSafeInteger(contextLimit) && contextLimit > 0 && outputTokens > 0
      && estimatedTokens <= contextLimit && transportBytes <= SHIYING_IMAGE_TRANSPORT_LIMIT
      && imageCount <= SHIYING_IMAGE_GROUP_LIMIT,
  };
}

/** End offsets are UTF-16 positions but never split a Unicode surrogate pair. */
function unicodeEnds(text: string) {
  const ends: number[] = [];
  let offset = 0;
  for (const character of text) { offset += character.length; ends.push(offset); }
  return ends;
}

function boundaries(text: string, expression: RegExp) {
  return [...text.matchAll(expression)].map(match => match.index + match[0].length);
}

function splitCaption(text: string, fits: (start: number, end: number) => boolean, maximumParts = Infinity) {
  if (!text.length) return [{ start: 0, end: 0 }];
  const ends = unicodeEnds(text);
  const paragraphs = boundaries(text, /\r\n|\r|\n/gu);
  const sentences = boundaries(text, /[。！？!?；;.]+[”’"')）】]*\s*/gu);
  const ranges: Array<{ start: number; end: number }> = [];
  let cursor = 0, start = 0;
  while (cursor < ends.length) {
    let low = cursor, high = ends.length - 1, last = cursor - 1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (fits(start, ends[mid])) { last = mid; low = mid + 1; }
      else high = mid - 1;
    }
    if (last < cursor) return null;
    const maximum = ends[last];
    const paragraph = paragraphs.filter(end => end > start && end <= maximum).at(-1);
    const sentence = sentences.filter(end => end > start && end <= maximum).at(-1);
    const end = maximum === text.length ? maximum : paragraph ?? sentence ?? maximum;
    ranges.push({ start, end });
    if (ranges.length > maximumParts) return null;
    start = end;
    while (cursor < ends.length && ends[cursor] <= end) cursor += 1;
  }
  return ranges;
}

export function planShiyingRecordImages(input: CapacityInput & { record: ShiyingRecordV1 }): ShiyingRecordImagePlanV1 {
  const record = parseShiyingRecordV1(input.record);
  const recordContentHash = createShiyingRecordContentHash(record);
  const base = { recordId: record.id, recordContentHash };
  if (record.status !== 'finalized' || !record.images.length) {
    return { ...base, kind: 'ready', units: [], errorCode: null };
  }
  const blocked = (): ShiyingRecordImagePlanV1 => ({
    ...base, kind: 'blocked', units: [], errorCode: 'capacity_blocked',
  });
  const range = (imageIds: readonly string[], start = 0, end = record.body.length,
    captionIndex = 0, captionCount = 1): ShiyingImageMaterialRange => ({
    imageIds, captionStart: start, captionEnd: end, captionIndex, captionCount,
  });
  const fits = (unit: ShiyingImageMaterialRange) => requestBudget(input, [{ record, unit }]).fits;
  const allIds = record.images.map(image => image.id);
  let groups: string[][], captions: Array<{ start: number; end: number }>;
  if (fits(range(allIds))) {
    groups = [allIds]; captions = [{ start: 0, end: record.body.length }];
  } else {
    const smallestEnd = record.body.length ? String.fromCodePoint(record.body.codePointAt(0)!).length : 0;
    // Use a conservative segment label while planning; final labels can only be shorter.
    const countBound = Math.max(1, record.body.length);
    const minimal = (ids: string[]) => range(ids, 0, smallestEnd, countBound - 1, countBound);
    if (allIds.some(id => !fits(minimal([id])))) return blocked();
    let best: { groups: string[][]; captions: Array<{ start: number; end: number }> } | null = null;
    // Nine attachments make a small finite comparison worthwhile: do not fill a group
    // with images so tightly that it repeats them for hundreds of tiny caption pieces.
    for (let groupLimit = 1; groupLimit <= Math.min(allIds.length, SHIYING_IMAGE_GROUP_LIMIT); groupLimit += 1) {
      const candidateGroups: string[][] = [];
      let group: string[] = [];
      for (const imageId of allIds) {
        if (group.length && (group.length === groupLimit || !fits(minimal([...group, imageId])))) {
          candidateGroups.push(group); group = [];
        }
        group.push(imageId);
      }
      if (group.length) candidateGroups.push(group);
      const maximumParts: number = best ? Math.floor(best.groups.length * best.captions.length / candidateGroups.length) : Infinity;
      const fullCaptionFits = candidateGroups.every(ids => fits(range(ids)));
      const parts: Array<{ start: number; end: number }> | null = fullCaptionFits ? [{ start: 0, end: record.body.length }]
        : splitCaption(record.body, (start, end) => candidateGroups.every(ids => (
          fits(range(ids, start, end, countBound - 1, countBound))
        )), maximumParts);
      if (!parts) continue;
      const count = parts.length * candidateGroups.length;
      const previousCount = best ? best.captions.length * best.groups.length : Infinity;
      if (count < previousCount || (count === previousCount && parts.length < best!.captions.length)) {
        best = { groups: candidateGroups, captions: parts };
      }
    }
    if (!best) return blocked();
    groups = best.groups; captions = best.captions;
  }
  const units: ShiyingImagePlanUnitV1[] = [];
  captions.forEach((caption, captionIndex) => groups.forEach(imageIds => {
    const materialRange = range(imageIds, caption.start, caption.end, captionIndex, captions.length);
    const budget = requestBudget(input, [{ record, unit: materialRange }]);
    if (!budget.fits) throw new Error('shiying_image_plan_capacity_inconsistent');
    units.push({
      ...materialRange, imageIds,
      id: createShiyingImageUnitId({
        recordId: record.id, recordContentHash, contractVersion: 1,
        captionStart: caption.start, captionEnd: caption.end, imageIds,
      }),
      ordinal: units.length,
      estimatedTokens: budget.estimatedTokens,
    });
  }));
  return { ...base, kind: 'ready', units, errorCode: null };
}

/** Preserve frozen order; only combine units when record IDs, image and capacity limits permit. */
export function planShiyingImageRequests(input: CapacityInput & {
  records: readonly ShiyingRecordV1[];
  units: readonly ShiyingImageRequestUnit[];
}): ShiyingImageRequestPlan[] {
  const byId = new Map(input.records.map(record => [record.id, record]));
  const requests: ShiyingImageRequestPlan[] = [];
  let group: ShiyingImageRequestUnit[] = [];
  const budget = (units: ShiyingImageRequestUnit[]) => requestBudget(input, units.map(value => {
    const record = byId.get(value.recordId);
    if (!record) throw new Error('shiying_image_plan_source_missing');
    return { record, unit: value.unit };
  }));
  const finish = () => {
    if (!group.length) return;
    const { fits: _fits, ...capacity } = budget(group);
    requests.push({ units: group, ...capacity }); group = [];
  };
  for (const value of input.units) {
    if (!budget([value]).fits) throw new Error(`shiying_image_plan_capacity:${value.recordId}`);
    if (group.length && (group.some(unit => unit.recordId === value.recordId)
      || !budget([...group, value]).fits)) finish();
    group.push(value);
  }
  finish();
  return requests;
}

export function sortShiyingImageRecords(records: readonly ShiyingRecordV1[]) {
  const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
  return records.filter(record => record.status === 'finalized' && record.images.length)
    .slice().sort((left, right) => compare(left.recordDate, right.recordDate)
      || left.createdAt - right.createdAt || compare(left.id, right.id));
}

export type ShiyingProjectedImageOutput = {
  validItems: Array<{ recordId: string; text: string }>;
  invalidRecordIds: string[];
  hadInvalid: boolean;
};

function plain(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function exactFields(value: Record<string, unknown>, fields: readonly string[]) {
  return Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
}

export function projectShiyingImageOutput(raw: string, expectedRecordIds: readonly string[]): ShiyingProjectedImageOutput {
  if (new Set(expectedRecordIds).size !== expectedRecordIds.length) throw new Error('shiying_image_output_expected_duplicate');
  const failed = (): ShiyingProjectedImageOutput => ({ validItems: [], invalidRecordIds: [...expectedRecordIds], hadInvalid: true });
  let parsed: unknown;
  try { parsed = parseShiyingModelJson(raw); }
  catch { return failed(); }
  if (!plain(parsed) || !exactFields(parsed, ['imageNotes']) || !Array.isArray(parsed.imageNotes)) return failed();
  const items = parsed.imageNotes;
  const counts = new Map<string, number>();
  for (const item of items) if (plain(item) && typeof item.recordId === 'string') {
    counts.set(item.recordId, (counts.get(item.recordId) ?? 0) + 1);
  }
  const validItems: ShiyingProjectedImageOutput['validItems'] = [];
  let hadInvalid = items.length !== expectedRecordIds.length;
  const recognized = items.filter((item): item is Record<string, unknown> & { recordId: string } => (
    plain(item) && typeof item.recordId === 'string' && counts.get(item.recordId) === 1
      && expectedRecordIds.includes(item.recordId)
  ));
  const outOfOrder = new Set<string>();
  for (let left = 0; left < recognized.length; left += 1) for (let right = left + 1; right < recognized.length; right += 1) {
    if (expectedRecordIds.indexOf(recognized[left].recordId) > expectedRecordIds.indexOf(recognized[right].recordId)) {
      outOfOrder.add(recognized[left].recordId); outOfOrder.add(recognized[right].recordId);
    }
  }
  for (let index = 0; index < items.length; index += 1) {
    const item: unknown = items[index];
    if (!plain(item) || !exactFields(item, ['recordId', 'text'])
      || typeof item.recordId !== 'string' || counts.get(item.recordId) !== 1
      || !expectedRecordIds.includes(item.recordId) || outOfOrder.has(item.recordId)
      || typeof item.text !== 'string' || !item.text.trim()) {
      hadInvalid = true; continue;
    }
    validItems.push({ recordId: item.recordId, text: item.text });
  }
  const invalidRecordIds = expectedRecordIds.filter(id => !validItems.some(item => item.recordId === id));
  return { validItems, invalidRecordIds, hadInvalid: hadInvalid || invalidRecordIds.length > 0 };
}

