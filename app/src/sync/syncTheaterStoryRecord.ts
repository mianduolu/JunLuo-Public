// Wire/storage validation only; this is never a model prompt or model output schema.
export const THEATER_STORY_RECORD_KINDS = ['story', 'text-version', 'branch', 'checkpoint', 'anchor'] as const;
export type TheaterStoryRecordKind = typeof THEATER_STORY_RECORD_KINDS[number];
export function isTheaterStoryRecordKind(value: unknown): value is TheaterStoryRecordKind {
  return typeof value === 'string' && (THEATER_STORY_RECORD_KINDS as readonly string[]).includes(value);
}

type Row = Record<string, unknown>;
function invalid(): never { throw new Error('theater.isolated payload 版本或 kind 无效。'); }
function object(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Row;
}
function keys(value: unknown, expected: string[]): Row {
  const row = object(value);
  if (Object.keys(row).length !== expected.length || expected.some((key) => !(key in row))) invalid();
  return row;
}
function text(value: unknown, max = 200_000, nonempty = false) {
  if (typeof value !== 'string' || value.length > max || (nonempty && !value.length) || value.includes('\0')) invalid();
}
function id(value: unknown) { text(value, 240, true); if (/[\r\n]/.test(value as string)) invalid(); }
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) invalid();
}
function bool(value: unknown) { if (typeof value !== 'boolean') invalid(); }
function nullableId(value: unknown) { if (value !== null) id(value); }

export function assertTheaterStorySettings(value: unknown) {
  const row = keys(value, ['world', 'youIdentity', 'iIdentity', 'tone', 'openingPrompt', 'names', 'temperature', 'contextLimit', 'legacyPersona']);
  for (const key of ['world', 'youIdentity', 'iIdentity', 'tone', 'openingPrompt']) text(row[key]);
  const names = keys(row.names, ['I', 'you']);
  text(names.I, 500, true); text(names.you, 500, true);
  if (typeof row.temperature !== 'number' || !Number.isFinite(row.temperature) || row.temperature < 0 || row.temperature > 2) invalid();
  integer(row.contextLimit, 4, 80);
  if (row.legacyPersona !== null) text(row.legacyPersona);
}

export function assertTheaterStoryAdoptions(value: unknown) {
  if (!Array.isArray(value)) invalid();
  const positions = new Set();
  for (const item of value) {
    const row = keys(item, ['positionId', 'versionId']);
    id(row.positionId); id(row.versionId);
    if (positions.has(row.positionId)) invalid();
    positions.add(row.positionId);
  }
}

export function assertTheaterStoryRecord(kind: TheaterStoryRecordKind, entityId: string, value: unknown) {
  const row = object(value);
  id(row.id);
  if (entityId !== `${kind}:${row.id}`) invalid();
  integer(row.createdAt); integer(row.updatedAt);
  if (kind !== 'story') id(row.conversationId);
  const base = ['id', 'createdAt', 'updatedAt'];
  if (kind === 'story') {
    keys(row, [...base, 'title', 'settings', 'summaryInterval', 'isDraft', 'isPinned']);
    text(row.title, 500, true); assertTheaterStorySettings(row.settings);
    if (row.summaryInterval !== null) integer(row.summaryInterval, 3, 200);
    bool(row.isDraft); bool(row.isPinned);
  } else if (kind === 'text-version') {
    keys(row, [...base, 'conversationId', 'positionId', 'kind', 'subject', 'content', 'origin',
      ...('coCreation' in row ? ['coCreation'] : [])]);
    id(row.positionId); text(row.content);
    if ('coCreation' in row) {
      const fact = object(row.coCreation);
      keys(fact, ['branchId', 'completedAt', 'youVersionIds', ...('identities' in fact ? ['identities'] : [])]);
      id(fact.branchId); integer(fact.completedAt, row.createdAt as number);
      if (row.kind !== 'dialogue' || row.subject !== 'I' || row.origin !== 'generated') invalid();
      if (!Array.isArray(fact.youVersionIds) || new Set(fact.youVersionIds).size !== fact.youVersionIds.length) invalid();
      for (const versionId of fact.youVersionIds as unknown[]) id(versionId);
      if ('identities' in fact) {
        const identities = keys(fact.identities, ['I', 'you']);
        text(identities.I, 200_000, true); text(identities.you, 200_000, true);
      }
    }
    if (!['legacy', 'generated', 'edited'].includes(row.origin as string)) invalid();
    if (!(row.kind === 'dialogue' && (row.subject === 'I' || row.subject === 'you'))
      && !(row.kind === 'legacy-context-note' && row.subject === null && row.origin === 'legacy')) invalid();
  } else if (kind === 'branch') {
    keys(row, [...base, 'conversationId', 'name', 'adoptions', ...('forkBoundary' in row ? ['forkBoundary'] : [])]);
    if (row.forkBoundary !== undefined && row.forkBoundary !== null) integer(row.forkBoundary);
    text(row.name, 500, true); assertTheaterStoryAdoptions(row.adoptions);
  } else if (kind === 'checkpoint') {
    keys(row, [...base, 'conversationId', 'branchId', 'content', 'coveredPositionId', 'basis', 'status', 'active',
      ...('needsReview' in row ? ['needsReview'] : [])]);
    id(row.branchId); text(row.content); nullableId(row.coveredPositionId);
    assertTheaterStoryAdoptions(row.basis); bool(row.active);
    if (!['draft', 'saved', 'legacy-unverified'].includes(row.status as string)) invalid();
    const basis = row.basis as { positionId: string; versionId: string }[];
    if ((basis.at(-1)?.positionId ?? null) !== row.coveredPositionId) invalid();
    if (row.active && row.status !== 'saved') invalid();
    if ('needsReview' in row) bool(row.needsReview);
    if (row.needsReview && (row.active || row.status !== 'saved' || !(row.content as string).trim() || !basis.length)) invalid();
    if (row.status === 'legacy-unverified' && (basis.length || row.coveredPositionId !== null)) invalid();
  } else {
    keys(row, [...base, 'conversationId', 'branchId', 'positionId', 'sourceVersionId', 'source', 'content', 'confirmed']);
    id(row.branchId); id(row.positionId); nullableId(row.sourceVersionId); text(row.content); bool(row.confirmed);
    if (!['manual', 'message', 'summary'].includes(row.source as string)) invalid();
    if (row.source === 'message' && row.sourceVersionId === null) invalid();
  }
}
