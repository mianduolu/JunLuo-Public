export const MEMORY_DUPLICATE_CLEANUP_BATCH_SIZE = 25 as const;
export const MEMORY_DUPLICATE_CLEANUP_CHECKPOINT_INTERVAL = 250 as const;

export type MemoryDuplicateCleanupResumePhase =
  | 'backing-up'
  | 'cleaning'
  | 'compacting'
  | 'verifying';

export type MemoryDuplicateCleanupPauseReason =
  | 'manual'
  | 'checkpoint'
  | 'restart'
  | 'before-compaction';

export function shouldPauseMemoryDuplicateCleanupAfterBatch(input: {
  nextProcessedCandidates: number;
  previousProcessedCandidates: number;
  remainingCandidates: number;
}) {
  if (
    input.remainingCandidates <= 0
    || input.nextProcessedCandidates <= input.previousProcessedCandidates
  ) return false;
  if (input.previousProcessedCandidates === 0) return true;
  return Math.floor(
    input.previousProcessedCandidates / MEMORY_DUPLICATE_CLEANUP_CHECKPOINT_INTERVAL,
  ) < Math.floor(
    input.nextProcessedCandidates / MEMORY_DUPLICATE_CLEANUP_CHECKPOINT_INTERVAL,
  );
}

export function memoryDuplicateCleanupPauseReasonAfterBatch(input: {
  durablePauseReason: MemoryDuplicateCleanupPauseReason | null;
  nextProcessedCandidates: number;
  pauseRequested: boolean;
  previousProcessedCandidates: number;
  remainingCandidates: number;
}): MemoryDuplicateCleanupPauseReason | null {
  if (input.pauseRequested || input.durablePauseReason) {
    return input.durablePauseReason ?? 'manual';
  }
  return shouldPauseMemoryDuplicateCleanupAfterBatch(input)
    ? 'checkpoint'
    : null;
}

export type MemoryDuplicateCleanupRow = {
  id: string;
  title: string;
  content: string;
  createdAt: number;
  source: string | null;
  confirmationLevel: string;
  pinned: boolean;
  protected: boolean;
  anchor: boolean;
  tier: string;
  type: string;
  eventAt: number | null;
  eventStartAt: number | null;
  eventEndAt: number | null;
  eventTimeBasis: string;
  eventTimePrecision: string;
  relationCount: number;
  lifecycleCount: number;
  soleLifecycleId: string | null;
  soleLifecycleEventType: string | null;
  soleLifecycleActor: string | null;
  soleLifecycleOperationId: string | null;
  soleLifecycleRelatedMemoryId: string | null;
  soleLifecycleReasonCode: string | null;
  soleLifecycleCommentId: string | null;
};

export type MemoryDuplicateCleanupCandidateLifecycle = {
  memoryId: string;
  lifecycleEventId: string;
};

export type MemoryDuplicateCleanupSelection = {
  candidateIds: string[];
  candidateLifecycles: MemoryDuplicateCleanupCandidateLifecycle[];
  duplicateRows: number;
  groupCount: number;
  skippedProtected: number;
  skippedReliableEventTime: number;
  skippedRelationships: number;
  skippedLifecycle: number;
};

export function normalizeMemoryDuplicateCleanupText(value: string) {
  return value
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function memoryDuplicateCleanupKey(
  row: Pick<MemoryDuplicateCleanupRow, 'content' | 'title'>,
) {
  return JSON.stringify([
    normalizeMemoryDuplicateCleanupText(row.title),
    normalizeMemoryDuplicateCleanupText(row.content),
  ]);
}

export function hasReliableMemoryDuplicateCleanupEventTime(
  row: Pick<MemoryDuplicateCleanupRow,
    | 'eventAt'
    | 'eventEndAt'
    | 'eventStartAt'
    | 'eventTimeBasis'
    | 'eventTimePrecision'
  >,
) {
  const reliableBasis = row.eventTimeBasis === 'explicit'
    || row.eventTimeBasis === 'relative'
    || row.eventTimeBasis === 'derived_period';
  const reliablePrecision = row.eventTimePrecision === 'instant'
    || row.eventTimePrecision === 'day'
    || row.eventTimePrecision === 'range';
  return reliableBasis
    && reliablePrecision
    && (
      Number.isFinite(row.eventAt)
      || Number.isFinite(row.eventStartAt)
      || Number.isFinite(row.eventEndAt)
    );
}

export function isLegacyAutomaticLifeStateMemory(
  row: Pick<MemoryDuplicateCleanupRow,
    | 'anchor'
    | 'confirmationLevel'
    | 'pinned'
    | 'protected'
    | 'source'
    | 'tier'
    | 'type'
  >,
) {
  return row.source === 'assistant-life-state'
    && row.confirmationLevel === 'automatic'
    && !row.pinned
    && !row.protected
    && !row.anchor
    && row.tier !== 'core'
    && row.type !== 'archived';
}

export function deletableMemoryDuplicateCleanupLifecycleId(
  row: Pick<MemoryDuplicateCleanupRow,
    | 'id'
    | 'lifecycleCount'
    | 'soleLifecycleActor'
    | 'soleLifecycleCommentId'
    | 'soleLifecycleEventType'
    | 'soleLifecycleId'
    | 'soleLifecycleOperationId'
    | 'soleLifecycleReasonCode'
    | 'soleLifecycleRelatedMemoryId'
  >,
) {
  if (
    row.lifecycleCount !== 1
    || !row.soleLifecycleId
    || row.soleLifecycleRelatedMemoryId !== null
    || row.soleLifecycleCommentId !== null
  ) {
    return null;
  }
  if (row.soleLifecycleEventType === 'created') {
    return row.soleLifecycleId;
  }
  if (
    row.soleLifecycleEventType === 'baseline'
    && row.soleLifecycleActor === 'migration'
    && row.soleLifecycleReasonCode === 'pre_lifecycle_memory'
    && row.soleLifecycleOperationId === `baseline:${row.id}`
  ) {
    return row.soleLifecycleId;
  }
  return null;
}

export function selectMemoryDuplicateCleanupCandidates(
  rows: readonly MemoryDuplicateCleanupRow[],
): MemoryDuplicateCleanupSelection {
  const groups = new Map<string, MemoryDuplicateCleanupRow[]>();
  for (const row of rows) {
    if (row.source !== 'assistant-life-state') continue;
    const key = memoryDuplicateCleanupKey(row);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  const selection: MemoryDuplicateCleanupSelection = {
    candidateIds: [],
    candidateLifecycles: [],
    duplicateRows: 0,
    groupCount: 0,
    skippedProtected: 0,
    skippedReliableEventTime: 0,
    skippedRelationships: 0,
    skippedLifecycle: 0,
  };

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    selection.groupCount += 1;
    const ordered = [...group].sort((left, right) => (
      left.createdAt - right.createdAt || left.id.localeCompare(right.id)
    ));
    if (ordered.some(hasReliableMemoryDuplicateCleanupEventTime)) {
      const duplicateCount = ordered.length - 1;
      selection.duplicateRows += duplicateCount;
      selection.skippedReliableEventTime += duplicateCount;
      continue;
    }
    for (const row of ordered.slice(1)) {
      selection.duplicateRows += 1;
      if (!isLegacyAutomaticLifeStateMemory(row)) {
        selection.skippedProtected += 1;
        continue;
      }
      if (row.relationCount > 0) {
        selection.skippedRelationships += 1;
        continue;
      }
      const lifecycleEventId = deletableMemoryDuplicateCleanupLifecycleId(row);
      if (!lifecycleEventId) {
        selection.skippedLifecycle += 1;
        continue;
      }
      selection.candidateIds.push(row.id);
      selection.candidateLifecycles.push({
        memoryId: row.id,
        lifecycleEventId,
      });
    }
  }

  return selection;
}
