import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import {
  canCommitBackupRestoreDataEpoch, captureBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit,
} from '../backup/backupRestoreCoordinator';
import { stableMemoryHash } from '../memory/memoryAtomicity';
import { runMemoryDuplicateCleanupBusinessWrite } from '../memory/memoryDuplicateCleanupState';
import {
  beginMemoryIngestionBatchWithDatabase, type MemoryIngestionBatchInput,
  loadMemoryIngestionBatchWithDatabase,
  type MemoryIngestionWorkMetadata,
} from '../memory/memoryIngestionLedger';
import { getMemoryDatabase } from '../memory/memoryStore';
import { loadReadingMemorySource, parseReadingMemorySourceIdentity } from './readingMemorySource';
import { loadReadingAnnotations, loadReadingLibraryStrict, scanReadingBookKeys } from './readingStore';
import type { ReadingBook } from './readingTypes';
import {
  loadReadingOrganizationSource, makeReadingOrganizationSource, parseReadingOrganizationSource,
  readingOrganizationSentHash, readingOrganizationSourceKey,
  type ReadingOrganizationBinding, type ReadingOrganizationSource,
} from './readingMemoryOrganizationSource';
import {
  prepareReadingOrganizationFragment, renderReadingOrganizationMaterial,
  READING_ORGANIZATION_CHARACTER_LIMIT,
} from './readingMemoryOrganizationProtocol';

export type ReadingActivityRegistration = {
  bookId: string; activityId: string; startedAt: number; updatedAt: number; endedAt?: number;
};
export type ReadingWorkSource = {
  bookId: string; activityId: string; sourceHash: string; availableAt: number;
  countAsNew: boolean; carry: boolean;
};
type ReadingMetadata = MemoryIngestionWorkMetadata & {
  readingRegistration?: ReadingActivityRegistration;
  readings?: ReadingOrganizationBinding[];
  readingWork?: ReadingWorkSource[];
};
type Progress = { id: string; status: string; sessionId?: string; work: ReadingMetadata };
type SourceProgress = {
  source: ReadingOrganizationSource; bookStart: number; contentStart: number;
  retry?: ReadingOrganizationBinding; correctionTargetIds: string[];
};
export type ReadingOrganizationWork = {
  sessionId: string; dataEpoch: number | null; eligibleSources: ReadingWorkSource[];
  eligibleCount: number; pendingSources: SourceProgress[];
  blockedActivities: Array<{ bookId: string; activityId: string; reason: 'pending_draft' }>;
  unavailableSources: Array<{ bookId: string; activityId: string; sourceKey: string;
    targetMemoryIds: string[]; reason: 'source_unavailable' | 'source_correspondence_unknown' | 'multiple_targets' | 'target_unavailable' }>;
};
export type PreparedReadingOrganizationMaterial = {
  source: ReadingOrganizationSource; binding: ReadingOrganizationBinding;
  message: SubjectiveMessage; content: string; batch: MemoryIngestionBatchInput;
  correctionTargetIds: string[];
};
const SCOPE = 'reading-activity';
const PREPARATION_REFERENCE = 'R999999';
const activityKey = (value: { bookId: string; activityId: string }) => JSON.stringify([value.bookId, value.activityId]);
const settled = (status: string) => status === 'resolved' || status === 'no_value';
function changed(): never { throw new Error('MEMORY_SOURCE_CHANGED'); }
function assertEpoch(epoch: number | null) { if (!canCommitBackupRestoreDataEpoch(epoch)) changed(); }

function parseWork(json: string): ReadingMetadata {
  const value = JSON.parse(json) as ReadingMetadata;
  if (value?.version !== 1 || !value.workId || !Array.isArray(value.messageIds)) {
    throw new Error('reading-memory-progress-invalid');
  }
  return value;
}

async function loadProgress(): Promise<Progress[]> {
  const rows = await (await getMemoryDatabase('ingestion')).getAllAsync<{
    id: string; status: string; session_id: string | null; work_metadata_json: string;
  }>(`SELECT id, status, session_id, work_metadata_json FROM memory_ingestion_batches
      WHERE json_type(work_metadata_json, '$.readingRegistration') IS NOT NULL
         OR json_type(work_metadata_json, '$.readings') IS NOT NULL
         OR json_type(work_metadata_json, '$.readingWork') IS NOT NULL
      ORDER BY created_at, id`);
  return rows.map(row => ({ id: row.id, status: row.status,
    sessionId: row.session_id ?? undefined, work: parseWork(row.work_metadata_json) }));
}

/** Only the chat-owned mixed batch is a retry; registrations and per-source ranges are not requests. */
export async function loadReadingOrganizationRetry(sessionId: string) {
  const database = await getMemoryDatabase('ingestion');
  const row = await database.getFirstAsync<{ id: string }>(
    `SELECT id FROM memory_ingestion_batches WHERE scope_key = ? AND session_id = ?
     AND stream IN ('manual_digest', 'proactive') AND json_array_length(work_metadata_json, '$.readings') > 0
     AND status IN ('pending', 'failed', 'waiting') AND item_count = 0 ORDER BY created_at, id LIMIT 1`, sessionId, sessionId);
  return row ? loadMemoryIngestionBatchWithDatabase(database, row.id) : null;
}

/** This can run inside the reading write lock. It uses only the supplied scalar snapshot. */
export async function registerReadingMemoryActivity(book: ReadingBook) {
  const activity = book.iReading?.activity as (NonNullable<ReadingBook['iReading']>['activity'] & {
    memoryIngestionVersion?: 1;
  });
  if (!activity || activity.memoryIngestionVersion !== 1 || !book.id || !activity.id
    || !Number.isFinite(activity.startedAt) || !Number.isFinite(activity.updatedAt)) return;
  const registration: ReadingActivityRegistration = { bookId: book.id, activityId: activity.id,
    startedAt: activity.startedAt, updatedAt: activity.updatedAt,
    ...(activity.status === 'ended' && Number.isFinite(activity.endedAt)
      ? { endedAt: activity.endedAt } : {}) };
  const id = `memory-reading-activity-${stableMemoryHash(activityKey(registration))}`;
  const epoch = captureBackupRestoreDataEpoch();
  assertEpoch(epoch);
  const result = await runBackupRestoreDataEpochCommit(epoch, () => runMemoryDuplicateCleanupBusinessWrite(async () => {
    const database = await getMemoryDatabase('ingestion');
    await database.withExclusiveTransactionAsync(async transaction => {
      assertEpoch(epoch);
      const row = await transaction.getFirstAsync<{ work_metadata_json: string }>(
        'SELECT work_metadata_json FROM memory_ingestion_batches WHERE id = ?', id);
      const previous = row ? parseWork(row.work_metadata_json).readingRegistration : undefined;
      // Only a newer real continuation can reopen this same activity.
      if (previous && (previous.startedAt !== registration.startedAt
        || previous.updatedAt > registration.updatedAt)) return;
      if (previous?.endedAt !== undefined && previous.updatedAt === registration.updatedAt
        && registration.endedAt === undefined) registration.endedAt = previous.endedAt;
      if (previous && JSON.stringify(previous) === JSON.stringify(registration)) return;
      const work: ReadingMetadata = { version: 1, workId: id, messageIds: [], readingRegistration: registration };
      await beginMemoryIngestionBatchWithDatabase(transaction, { id, stream: 'proactive', scopeKey: SCOPE,
        sourceHash: stableMemoryHash(JSON.stringify(registration)), advancesCursor: false, workMetadata: work });
      await transaction.runAsync(
        'UPDATE memory_ingestion_batches SET work_metadata_json = ?, source_hash = ? WHERE id = ?',
        JSON.stringify(work), stableMemoryHash(JSON.stringify(registration)), id);
      assertEpoch(epoch);
    });
  }));
  if (!result.committed) changed();
}

function matchesRange(source: ReadingOrganizationSource, binding: ReadingOrganizationBinding) {
  if (binding.sessionId !== source.sessionId || binding.messageId !== source.message.id
    || binding.sourceHash !== source.sourceHash || binding.version !== source.identity.version
    || readingOrganizationSourceKey(binding) !== readingOrganizationSourceKey(source.identity)) return false;
  const ranges = [
    { text: source.snapshot.bookText, range: binding.bookRange, start: binding.bookStart, next: binding.nextBookOffset },
    { text: source.message.content, range: binding.contentRange, start: binding.contentStart, next: binding.nextContentOffset },
  ];
  for (const { text, range, start, next } of ranges) {
    if (![range?.start, range?.end, start, next].every(Number.isSafeInteger)
      || start < 0 || start > text.length || next < start || next > text.length
      || range.start < 0 || range.end < range.start || range.end > text.length
      || (start < text.length ? range.start !== start || range.end !== next || next <= start : next !== start)) return false;
  }
  return binding.contentRange.end > binding.contentRange.start
    && readingOrganizationSentHash(source.snapshot.bookText.slice(binding.bookRange.start, binding.bookRange.end),
      source.message.content.slice(binding.contentRange.start, binding.contentRange.end)) === binding.sentHash;
}

function makeRangeBatch(binding: ReadingOrganizationBinding, sessionId: string): MemoryIngestionBatchInput {
  const id = `memory-reading-range-${stableMemoryHash(JSON.stringify([binding.sessionId, binding.sourceHash,
    binding.bookStart, binding.contentStart, binding.nextBookOffset, binding.nextContentOffset, binding.sentHash]))}`;
  const work: ReadingMetadata = { version: 1, workId: id, messageIds: [], readings: [binding] };
  return { id, stream: 'proactive', scopeKey: SCOPE, sessionId, sourceHash: binding.sourceHash,
    advancesCursor: false, workMetadata: work };
}

function material(source: ReadingOrganizationSource, binding: ReadingOrganizationBinding,
  sessionId: string, correctionTargetIds: string[] = []): PreparedReadingOrganizationMaterial {
  return { source, binding, message: { ...source.message,
    content: source.message.content.slice(binding.contentRange.start, binding.contentRange.end) },
    content: renderReadingOrganizationMaterial(source.snapshot, PREPARATION_REFERENCE, binding.bookRange, binding.contentRange),
    batch: makeRangeBatch(binding, sessionId), correctionTargetIds };
}

async function loadSavedReadingTargets() {
  return (await getMemoryDatabase('ingestion')).getAllAsync<{
    memory_id: string; session_id: string; message_id: string;
  }>(`SELECT refs.memory_id, refs.session_id, refs.message_id FROM memory_source_refs refs
     INNER JOIN memories ON memories.id = refs.memory_id
     WHERE memories.type != 'archived' AND refs.relation = 'direct'
       AND (refs.session_id LIKE 'reading-auto-v1:%' OR refs.session_id LIKE 'reading-v2:%')`);
}

function targetIdsForSource(source: ReadingOrganizationSource, rows: Awaited<ReturnType<typeof loadSavedReadingTargets>>) {
  const sourceKey = readingOrganizationSourceKey(source.identity);
  return [...new Set(rows.flatMap(row => {
    const identity = parseReadingOrganizationSource(row.session_id);
    if (identity) return readingOrganizationSourceKey(identity) === sourceKey
      && identity.version !== source.identity.version ? [row.memory_id] : [];
    const manual = parseReadingMemorySourceIdentity(row.session_id);
    return manual && !manual.legacy && manual.bookId === source.identity.bookId
      && manual.kind === source.identity.kind && manual.resultId === source.identity.resultId
      && manual.chapterIndex === source.identity.chapterIndex && manual.version === source.identity.version
      && row.message_id === source.snapshot.messages[0].id ? [row.memory_id] : [];
  }))];
}

export async function restoreReadingOrganizationMaterial(binding: ReadingOrganizationBinding, sessionId: string) {
  const epoch = captureBackupRestoreDataEpoch();
  assertEpoch(epoch);
  const source = await loadReadingOrganizationSource(binding.sessionId);
  if (!source || !matchesRange(source, binding)) changed();
  const correctionTargetIds = targetIdsForSource(source, await loadSavedReadingTargets());
  if (correctionTargetIds.length > 1) throw new Error('reading-memory-multiple-targets');
  assertEpoch(epoch);
  return material(source, binding, sessionId, correctionTargetIds);
}

async function loadActualSources(registrations: ReadingActivityRegistration[]) {
  const allowed = new Set(registrations.filter(value => value.endedAt !== undefined).map(activityKey));
  const books = new Set(registrations.map(value => value.bookId));
  const sources: ReadingOrganizationSource[] = [];
  for (const index of await scanReadingBookKeys()) {
    if (!books.has(index.bookId)) continue;
    for (const chapterIndex of index.annotationChapterIndexes) {
      const results = await loadReadingAnnotations(index.bookId, chapterIndex, true);
      const records = [
        ...results.annotations.map(record => ({ record, kind: 'annotation' as const, resultId: record.id })),
        ...results.summaries.map(record => ({ record, kind: 'summary' as const,
          resultId: `summary-${record.chapterIndex}-${record.segmentIndex}` })),
      ];
      for (const { record, kind, resultId } of records) {
        const qualified = record as typeof record & { memoryIngestionVersion?: 1; resultActivityId?: string | null };
        if (qualified.memoryIngestionVersion !== 1 || !qualified.resultActivityId
          || !allowed.has(activityKey({ bookId: index.bookId, activityId: qualified.resultActivityId }))) continue;
        const snapshot = await loadReadingMemorySource({ bookId: index.bookId, chapterIndex, kind, resultId });
        const source = snapshot && makeReadingOrganizationSource(snapshot);
        if (source && allowed.has(activityKey(source.identity))) sources.push(source);
      }
    }
  }
  return [...new Map(sources.map(source => [readingOrganizationSourceKey(source.identity), source])).values()]
    .sort((a, b) => a.message.createdAt - b.message.createdAt || a.message.id.localeCompare(b.message.id));
}

export async function nextReadingOrganizationWork(options: { sessionId: string }): Promise<ReadingOrganizationWork> {
  const epoch = captureBackupRestoreDataEpoch();
  assertEpoch(epoch);
  // Fallback only for the currently persisted, explicitly marked activity. Past starts come from the ledger.
  for (const book of await loadReadingLibraryStrict()) {
    assertEpoch(epoch);
    await registerReadingMemoryActivity(book);
  }
  const progress = await loadProgress();
  const registrations = progress.flatMap(row => row.work.readingRegistration ? [row.work.readingRegistration] : [])
    .sort((a, b) => (a.endedAt ?? Infinity) - (b.endedAt ?? Infinity) || activityKey(a).localeCompare(activityKey(b)));
  const sources = await loadActualSources(registrations);
  const ranges = progress.flatMap(row => (row.work.readings ?? []).map(binding => ({ binding, status: row.status })));
  const targetRows = await loadSavedReadingTargets();
  const targets = targetRows.flatMap(row => {
    const identity = parseReadingOrganizationSource(row.session_id);
    return identity ? [{ identity, memoryId: row.memory_id }] : [];
  });
  const actualKeys = new Set(sources.map(source => readingOrganizationSourceKey(source.identity)));
  const registeredKeys = new Set(registrations.filter(value => value.endedAt !== undefined).map(activityKey));
  const missing = new Map<string, ReadingOrganizationWork['unavailableSources'][number]>();
  // Existing saved receipts survive a deliberate card deletion. Do not recreate
  // that card merely because its reading original later receives a new version.
  const retired = await (await getMemoryDatabase('ingestion')).getAllAsync<{ memory_id: string | null; candidate_json: string }>(
    `SELECT i.memory_id,i.candidate_json FROM memory_ingestion_items i LEFT JOIN memories m ON m.id=i.memory_id
     WHERE i.status='saved' AND (m.id IS NULL OR m.type='archived') AND json_valid(i.candidate_json)
       AND json_type(i.candidate_json,'$.savedReviewId')='text'
       AND json_type(i.candidate_json,'$.savedCurrentStateId') IS NULL`);
  for (const receipt of retired) {
    const refs: Array<{ sessionId?: string }> = JSON.parse(receipt.candidate_json).reviewedSourceRefs ?? [];
    for (const ref of refs) {
      const identity = typeof ref.sessionId === 'string' ? parseReadingOrganizationSource(ref.sessionId) : null;
      if (!identity) continue;
      const sourceKey = readingOrganizationSourceKey(identity);
      missing.set(sourceKey, { bookId: identity.bookId, activityId: identity.activityId, sourceKey,
        targetMemoryIds: receipt.memory_id ? [receipt.memory_id] : [], reason: 'target_unavailable' });
    }
  }
  for (const target of targets) {
    const sourceKey = readingOrganizationSourceKey(target.identity);
    if (actualKeys.has(sourceKey) || !registeredKeys.has(activityKey(target.identity))) continue;
    const value = missing.get(sourceKey) ?? { bookId: target.identity.bookId, activityId: target.identity.activityId,
      sourceKey, targetMemoryIds: [], reason: 'source_unavailable' as const };
    if (!value.targetMemoryIds.includes(target.memoryId)) value.targetMemoryIds.push(target.memoryId);
    missing.set(sourceKey, value);
  }
  const blockedActivities: ReadingOrganizationWork['blockedActivities'] = [];
  const eligibleSources: ReadingWorkSource[] = [];
  const pendingSources: SourceProgress[] = [];
  for (const registration of registrations) {
    if (registration.endedAt === undefined) continue;
    const key = activityKey(registration);
    const activityRanges = ranges.filter(value => activityKey(value.binding) === key);
    if (activityRanges.some(value => value.status === 'ready' || value.status === 'waiting')) {
      blockedActivities.push({ bookId: registration.bookId, activityId: registration.activityId, reason: 'pending_draft' });
      continue;
    }
    const actual = sources.filter(source => activityKey(source.identity) === key);
    const pending: SourceProgress[] = [];
    for (const source of actual) {
      if (missing.get(readingOrganizationSourceKey(source.identity))?.reason === 'target_unavailable') continue;
      const own = activityRanges.filter(value => matchesRange(source, value.binding));
      let bookStart = 0; let contentStart = 0;
      // Each accepted range must begin at the two current offsets; gaps never consume later text.
      const remaining = own.filter(value => settled(value.status));
      while (true) {
        const index = remaining.findIndex(value => value.binding.bookStart === bookStart
          && value.binding.contentStart === contentStart);
        if (index < 0) break;
        const [next] = remaining.splice(index, 1);
        bookStart = next.binding.nextBookOffset; contentStart = next.binding.nextContentOffset;
      }
      if (bookStart >= source.snapshot.bookText.length && contentStart >= source.message.content.length) continue;
      const sourceKey = readingOrganizationSourceKey(source.identity);
      const sameSourceTargets = targets.filter(value => readingOrganizationSourceKey(value.identity) === sourceKey);
      const correctionTargetIds = targetIdsForSource(source, targetRows);
      if (correctionTargetIds.length > 1) {
        missing.set(sourceKey, { bookId: source.identity.bookId, activityId: source.identity.activityId,
          sourceKey, targetMemoryIds: correctionTargetIds, reason: 'multiple_targets' });
        continue;
      }
      const missingTargets = [...missing.values()].filter(value => activityKey(value) === key
        && value.reason === 'source_unavailable');
      // A replacement operation can produce a new annotation ID. Without a reliable
      // relation to the referenced old source it must not silently become another card.
      if (!sameSourceTargets.length && !correctionTargetIds.length && missingTargets.length) {
        missing.set(sourceKey, { bookId: source.identity.bookId, activityId: source.identity.activityId, sourceKey,
          targetMemoryIds: [...new Set(missingTargets.flatMap(value => value.targetMemoryIds))],
          reason: 'source_correspondence_unknown' });
        continue;
      }
      const retry = own.find(value => (value.status === 'pending' || value.status === 'failed')
        && value.binding.bookStart === bookStart && value.binding.contentStart === contentStart)?.binding;
      pending.push({ source, bookStart, contentStart, retry, correctionTargetIds });
    }
    if (!pending.length) continue;
    const carry = activityRanges.some(value => settled(value.status));
    const sourceHash = stableMemoryHash(JSON.stringify(actual.map(source => [
      readingOrganizationSourceKey(source.identity), source.sourceHash,
    ])));
    eligibleSources.push({ bookId: registration.bookId, activityId: registration.activityId, sourceHash,
      availableAt: registration.endedAt, countAsNew: !carry, carry });
    pendingSources.push(...pending);
  }
  assertEpoch(epoch);
  return { sessionId: options.sessionId, dataEpoch: epoch, eligibleSources,
    eligibleCount: eligibleSources.filter(value => value.countAsNew).length,
    pendingSources, blockedActivities, unavailableSources: [...missing.values()] };
}

export async function prepareReadingOrganizationMaterials(work: ReadingOrganizationWork,
  selectedActivityIds: readonly string[], limit = READING_ORGANIZATION_CHARACTER_LIMIT) {
  assertEpoch(work.dataEpoch);
  const selected = new Set(selectedActivityIds);
  const materials: PreparedReadingOrganizationMaterial[] = [];
  const blockedSources: Array<{ sessionId: string; reason: 'material_too_long' }> = [];
  let remaining = Math.min(READING_ORGANIZATION_CHARACTER_LIMIT, Math.max(0, Math.floor(limit)));
  for (const pending of work.pendingSources) {
    if (!selected.has(pending.source.identity.activityId)) continue;
    const current = await loadReadingOrganizationSource(pending.source.sessionId);
    if (!current || current.sourceHash !== pending.source.sourceHash) changed();
    const currentActivity = current.snapshot.book.iReading?.activity;
    if (currentActivity?.id === current.identity.activityId && currentActivity.status !== 'ended') continue;
    let prepared: PreparedReadingOrganizationMaterial;
    if (pending.retry) {
      if (!matchesRange(current, pending.retry)) changed();
      prepared = material(current, pending.retry, work.sessionId, pending.correctionTargetIds);
    } else {
      const complete = prepareReadingOrganizationFragment(current.snapshot, { messageId: current.message.id,
        reference: PREPARATION_REFERENCE, bookStart: pending.bookStart, contentStart: pending.contentStart });
      if (complete.status === 'blocked') {
        blockedSources.push({ sessionId: current.sessionId, reason: 'material_too_long' });
        continue;
      }
      const fragment = prepareReadingOrganizationFragment(current.snapshot, { messageId: current.message.id,
        reference: PREPARATION_REFERENCE, bookStart: pending.bookStart, contentStart: pending.contentStart }, remaining);
      if (fragment.status !== 'ready') continue;
      const binding: ReadingOrganizationBinding = { ...current.identity, sessionId: current.sessionId,
        messageId: current.message.id, sourceHash: current.sourceHash,
        bookRange: fragment.bookRange, contentRange: fragment.contentRange,
        bookStart: pending.bookStart, contentStart: pending.contentStart,
        nextBookOffset: fragment.nextBookOffset, nextContentOffset: fragment.nextContentOffset,
        sentHash: readingOrganizationSentHash(fragment.bookText, fragment.messageContent) };
      prepared = material(current, binding, work.sessionId, pending.correctionTargetIds);
    }
    const length = prepared.content.length + 2;
    if (length > remaining) continue;
    materials.push(prepared); remaining -= length;
  }
  assertEpoch(work.dataEpoch);
  return { materials, blockedSources, correctionTargetIds: [...new Set(materials.flatMap(value => value.correctionTargetIds))],
    characterCount: materials.reduce((sum, value) => sum + value.content.length + 2, 0) };
}
