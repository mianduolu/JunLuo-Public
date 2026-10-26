import {
  assertReadingWorkspaceMutationV1,
  retainReadingDailyState,
  readingResultProof,
  retainReadingRequest,
  retainReadingWorkspaceExtensions,
  retainReadingChapterContent,
} from './syncReadingWorkspace';
import type {
  JsonValue,
  PlainMutationV1,
} from './syncProtocol';

export type ReadingWorkspaceRevisionValue = {
  revisionId: string;
  parentRevisionIds: string[];
  operation: PlainMutationV1['revision']['operation'];
  createdAt: number;
  entityType: string;
  entityId: string;
  payload: JsonValue;
};

export type ReadingWorkspaceConflictKind =
  | 'reading-book-metadata-divergence'
  | 'reading-delete-modify'
  | 'reading-progress-divergence'
  | 'reading-record-divergence'
  | 'reading-result-link-divergence'
  | 'reading-session-divergence';

export type ReadingWorkspaceMergeDecision = {
  kind:
    | 'already-current'
    | 'apply-incoming'
    | 'ignore-incoming'
    | 'keep-current'
    | 'merged'
    | 'conflict';
  payload: JsonValue;
  operation: PlainMutationV1['revision']['operation'];
  resultingHeadRevisionIds: string[];
  conflictKind?: ReadingWorkspaceConflictKind;
  conflictingFields?: string[];
  requiresMergeRevision?: boolean;
  mergeParentRevisionIds?: string[];
};

function mutationOf(
  revision: ReadingWorkspaceRevisionValue,
): PlainMutationV1 {
  return {
    protocolVersion: 1,
    mutationId: '40000000-0000-4000-8000-000000000001',
    vaultId: '10000000-0000-4000-8000-000000000001',
    sourceDeviceId: '20000000-0000-4000-8000-000000000002',
    sourceSequence: 1,
    createdAt: revision.createdAt,
    entity: {
      domain: 'reading',
      type: revision.entityType,
      id: revision.entityId,
    },
    revision: {
      id: revision.revisionId,
      parents: [...revision.parentRevisionIds],
      operation: revision.operation,
      schemaVersion: 1,
    },
    sensitivity: 'high',
    payload: revision.payload,
    objectRefs: [],
    retentionClass: 'reading-workspace',
  };
}

function objectOf(value: JsonValue, label: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象。`);
  }
  return value as Record<string, JsonValue>;
}

function sameValue(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sortedHeads(...ids: string[]) {
  return [...new Set(ids)].sort();
}

function payloadKind(revision: ReadingWorkspaceRevisionValue) {
  const payload = objectOf(revision.payload, 'reading payload');
  return typeof payload.kind === 'string' ? payload.kind : null;
}

function payloadValue(revision: ReadingWorkspaceRevisionValue) {
  const payload = objectOf(revision.payload, 'reading payload');
  return objectOf(payload.value, 'reading record value');
}

function recordPayload(
  kind: string,
  value: Record<string, JsonValue>,
): JsonValue {
  return { schemaVersion: 1, kind, value };
}

function changedFields(
  left: Record<string, JsonValue>,
  right: Record<string, JsonValue>,
) {
  return [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .filter((field) => !sameValue(left[field], right[field]))
    .sort();
}

function mergedDecision(input: {
  current: ReadingWorkspaceRevisionValue;
  incoming: ReadingWorkspaceRevisionValue;
  payload: JsonValue;
  operation: PlainMutationV1['revision']['operation'];
  kind?: 'keep-current' | 'merged';
}): ReadingWorkspaceMergeDecision {
  const heads = sortedHeads(
    input.current.revisionId,
    input.incoming.revisionId,
  );
  return {
    kind: input.kind ?? 'merged',
    payload: input.payload,
    operation: input.operation,
    resultingHeadRevisionIds: heads,
    requiresMergeRevision: true,
    mergeParentRevisionIds: heads,
  };
}

function conflictDecision(input: {
  current: ReadingWorkspaceRevisionValue;
  incoming: ReadingWorkspaceRevisionValue;
  conflictKind: ReadingWorkspaceConflictKind;
  conflictingFields?: string[];
}): ReadingWorkspaceMergeDecision {
  return {
    kind: 'conflict',
    payload: input.current.payload,
    operation: input.current.operation,
    resultingHeadRevisionIds: sortedHeads(
      input.current.revisionId,
      input.incoming.revisionId,
    ),
    conflictKind: input.conflictKind,
    conflictingFields: input.conflictingFields ?? [],
  };
}

function mergeBook(input: {
  current: ReadingWorkspaceRevisionValue;
  incoming: ReadingWorkspaceRevisionValue;
}) {
  const current = payloadValue(input.current);
  const incoming = payloadValue(input.incoming);
  const metadataFields = [
    'bookId',
    'title',
    'author',
    'language',
    'fileType',
    'totalChapters',
    'importedAt',
  ];
  const metadataDifferences = metadataFields.filter(
    (field) => !sameValue(current[field], incoming[field]),
  );
  const currentProgramme = current.programme as Record<string, JsonValue> | undefined;
  const incomingProgramme = incoming.programme as Record<string, JsonValue> | undefined;
  if (currentProgramme && incomingProgramme && currentProgramme.sourceUrl !== incomingProgramme.sourceUrl) metadataDifferences.push('programme.sourceUrl');
  if (metadataDifferences.length) {
    return conflictDecision({
      ...input,
      conflictKind: 'reading-book-metadata-divergence',
      conflictingFields: metadataDifferences,
    });
  }
  const currentOpened = Number(current.lastOpenedAt ?? -1);
  const incomingOpened = Number(incoming.lastOpenedAt ?? -1);
  const progressFields = [
    'currentChapter',
    'currentParagraph',
    'progressFraction',
  ];
  if (
    currentOpened === incomingOpened
    && progressFields.some(
      (field) => !sameValue(current[field], incoming[field]),
    )
  ) {
    return conflictDecision({
      ...input,
      conflictKind: 'reading-progress-divergence',
      conflictingFields: progressFields.filter(
        (field) => !sameValue(current[field], incoming[field]),
      ),
    });
  }
  const carrier = incomingOpened > currentOpened ? incoming : current;
  const iReading = retainReadingDailyState(current.iReading, incoming.iReading);
  return mergedDecision({
    ...input,
    payload: recordPayload('book', {
      ...retainReadingWorkspaceExtensions('book', incoming, current) as Record<string, JsonValue>,
      ...(iReading ? { iReading: iReading as unknown as JsonValue } : {}),
      currentChapter: carrier.currentChapter,
      currentParagraph: carrier.currentParagraph,
      progressFraction: carrier.progressFraction,
      ...(Math.max(currentOpened, incomingOpened) >= 0
        ? { lastOpenedAt: Math.max(currentOpened, incomingOpened) }
        : {}),
    }),
    operation: 'upsert',
  });
}

function mergeChapter(input: {
  current: ReadingWorkspaceRevisionValue;
  incoming: ReadingWorkspaceRevisionValue;
}) {
  const current = payloadValue(input.current);
  const incoming = payloadValue(input.incoming);
  if ((current.sourceRevision === undefined) !== (incoming.sourceRevision === undefined)) {
    return mergedDecision({ ...input, payload: recordPayload('chapter',
      current.sourceRevision !== undefined ? current : incoming), operation: 'upsert' });
  }
  const staticFields = [
    'bookId',
    'chapterIndex',
    'title',
    'charCount',
    'paragraphCount',
  ];
  const staticDifferences = staticFields.filter(
    (field) => !sameValue(current[field], incoming[field]),
  );
  for (const field of ['contentBlocks', 'images', 'programmeCues', 'sourceRevision']) {
    if (current[field] !== undefined && incoming[field] !== undefined && !sameValue(current[field], incoming[field])) staticDifferences.push(field);
  }
  const currentSegments = current.segments;
  const incomingSegments = incoming.segments;
  if (
    staticDifferences.length
    || !Array.isArray(currentSegments)
    || !Array.isArray(incomingSegments)
    || currentSegments.length !== incomingSegments.length
  ) {
    return conflictDecision({
      ...input,
      conflictKind: 'reading-record-divergence',
      conflictingFields: [
        ...staticDifferences,
        ...(!sameValue(currentSegments, incomingSegments)
          ? ['segments']
          : []),
      ],
    });
  }
  const mergedSegments: JsonValue[] = [];
  for (let index = 0; index < currentSegments.length; index += 1) {
    const left = objectOf(currentSegments[index], 'reading segment');
    const right = objectOf(incomingSegments[index], 'reading segment');
    const staticSegmentFields = [
      'segmentIndex',
      'startP',
      'endP',
      'charCount',
    ];
    if (staticSegmentFields.some(
      (field) => !sameValue(left[field], right[field]),
    )) {
      return conflictDecision({
        ...input,
        conflictKind: 'reading-record-divergence',
        conflictingFields: ['segments'],
      });
    }
    if (left.contentRange !== undefined && right.contentRange !== undefined && !sameValue(left.contentRange, right.contentRange)) {
      return conflictDecision({ ...input, conflictKind: 'reading-record-divergence', conflictingFields: ['segments.contentRange'] });
    }
    if (!!left.contentRange !== !!right.contentRange) {
      mergedSegments.push(left.contentRange ? left : right);
      continue;
    }
    if (left.programmeRange !== undefined && right.programmeRange !== undefined && !sameValue(left.programmeRange, right.programmeRange)) {
      return conflictDecision({ ...input, conflictKind: 'reading-record-divergence', conflictingFields: ['segments.programmeRange'] });
    }
    if (!!left.programmeRange !== !!right.programmeRange) {
      mergedSegments.push(left.programmeRange ? left : right);
      continue;
    }
    const status = left.status === 'done' || right.status === 'done'
      ? 'done'
      : 'pending';
    const updatedAt = Math.max(
      Number(left.updatedAt ?? -1),
      Number(right.updatedAt ?? -1),
    );
    const proofSource = right.sourceVersion && (!left.sourceVersion || Number(right.updatedAt ?? -1) > Number(left.updatedAt ?? -1)) ? right : left;
    const request = retainReadingRequest(left.request, right.request);
    mergedSegments.push({
      segmentIndex: left.segmentIndex,
      startP: left.startP,
      endP: left.endP,
      charCount: left.charCount,
      status,
      ...(left.contentRange !== undefined ? { contentRange: left.contentRange } : {}),
      ...(left.programmeRange !== undefined ? { programmeRange: left.programmeRange } : {}),
      ...readingResultProof(proofSource, proofSource === left ? right : left),
      ...(request ? { request } : {}),
      ...(updatedAt >= 0 ? { updatedAt } : {}),
    });
  }
  return mergedDecision({
    ...input,
    payload: recordPayload('chapter', {
      ...retainReadingChapterContent(current, incoming) as Record<string, JsonValue>,
      segments: mergedSegments,
    }),
    operation: 'upsert',
  });
}

function mergeSession(input: {
  current: ReadingWorkspaceRevisionValue;
  incoming: ReadingWorkspaceRevisionValue;
}) {
  const current = payloadValue(input.current);
  const incoming = payloadValue(input.incoming);
  const startFields = [
    'sessionId',
    'bookId',
    'startedAt',
    'startChapterIndex',
    'startParagraphIndex',
  ];
  const startDifferences = startFields.filter(
    (field) => !sameValue(current[field], incoming[field]),
  );
  if (startDifferences.length) {
    return conflictDecision({
      ...input,
      conflictKind: 'reading-session-divergence',
      conflictingFields: startDifferences,
    });
  }
  const currentEnded = Number(current.endedAt ?? -1);
  const incomingEnded = Number(incoming.endedAt ?? -1);
  if (
    currentEnded === incomingEnded
    && currentEnded >= 0
    && (
      !sameValue(current.endChapterIndex, incoming.endChapterIndex)
      || !sameValue(current.endParagraphIndex, incoming.endParagraphIndex)
    )
  ) {
    return conflictDecision({
      ...input,
      conflictKind: 'reading-session-divergence',
      conflictingFields: ['endChapterIndex', 'endParagraphIndex'],
    });
  }
  const carrier = incomingEnded > currentEnded ? incoming : current;
  const endedAt = Math.max(currentEnded, incomingEnded);
  const activeSeconds = Math.max(
    Number(current.activeSeconds ?? -1),
    Number(incoming.activeSeconds ?? -1),
  );
  return mergedDecision({
    ...input,
    payload: recordPayload('session', {
      ...current,
      ...(endedAt >= 0
        ? {
            endedAt,
            ...(carrier.endChapterIndex !== undefined
              && carrier.endParagraphIndex !== undefined
              ? {
                  endChapterIndex: carrier.endChapterIndex,
                  endParagraphIndex: carrier.endParagraphIndex,
                }
              : {}),
          }
        : {}),
      ...(activeSeconds >= 0 ? { activeSeconds } : {}),
    }),
    operation: 'upsert',
  });
}

function mergeResultAction(input: {
  current: ReadingWorkspaceRevisionValue;
  incoming: ReadingWorkspaceRevisionValue;
}) {
  const current = payloadValue(input.current);
  const incoming = payloadValue(input.incoming);
  const identityFields = ['bookId', 'resultId'];
  const linkFields = ['notebookEntryId', 'memoryId'];
  const conflicts = [...identityFields, ...linkFields].filter(
    (field) => (
      current[field] !== undefined
      && incoming[field] !== undefined
      && !sameValue(current[field], incoming[field])
    ),
  );
  if (conflicts.length) {
    return conflictDecision({
      ...input,
      conflictKind: 'reading-result-link-divergence',
      conflictingFields: conflicts,
    });
  }
  const merged = {
    bookId: current.bookId,
    resultId: current.resultId,
    ...(current.notebookEntryId ?? incoming.notebookEntryId
      ? {
          notebookEntryId:
            current.notebookEntryId ?? incoming.notebookEntryId,
        }
      : {}),
    ...(Math.max(
      Number(current.notebookSavedAt ?? -1),
      Number(incoming.notebookSavedAt ?? -1),
    ) >= 0
      ? {
          notebookSavedAt: Math.max(
            Number(current.notebookSavedAt ?? -1),
            Number(incoming.notebookSavedAt ?? -1),
          ),
        }
      : {}),
    ...(current.memoryId ?? incoming.memoryId
      ? { memoryId: current.memoryId ?? incoming.memoryId }
      : {}),
    ...(Math.max(
      Number(current.memorySavedAt ?? -1),
      Number(incoming.memorySavedAt ?? -1),
    ) >= 0
      ? {
          memorySavedAt: Math.max(
            Number(current.memorySavedAt ?? -1),
            Number(incoming.memorySavedAt ?? -1),
          ),
        }
      : {}),
    updatedAt: Math.max(
      Number(current.updatedAt),
      Number(incoming.updatedAt),
    ),
  } as Record<string, JsonValue>;
  return mergedDecision({
    ...input,
    payload: recordPayload('result-action', merged),
    operation: 'upsert',
  });
}

export function resolveReadingWorkspaceRevisions(input: {
  current: ReadingWorkspaceRevisionValue | null;
  incoming: ReadingWorkspaceRevisionValue;
}): ReadingWorkspaceMergeDecision {
  assertReadingWorkspaceMutationV1(mutationOf(input.incoming));
  if (input.current === null) {
    return {
      kind: 'apply-incoming',
      payload: input.incoming.payload,
      operation: input.incoming.operation,
      resultingHeadRevisionIds: [input.incoming.revisionId],
    };
  }
  assertReadingWorkspaceMutationV1(mutationOf(input.current));
  if (
    input.current.entityType !== input.incoming.entityType
    || input.current.entityId !== input.incoming.entityId
  ) {
    throw new Error('reading.workspace 不能跨实体合并 revision。');
  }
  if (input.current.revisionId === input.incoming.revisionId) {
    return {
      kind: 'already-current',
      payload: input.current.payload,
      operation: input.current.operation,
      resultingHeadRevisionIds: [input.current.revisionId],
    };
  }
  if (input.current.parentRevisionIds.includes(input.incoming.revisionId)) {
    return {
      kind: 'ignore-incoming',
      payload: input.current.payload,
      operation: input.current.operation,
      resultingHeadRevisionIds: [input.current.revisionId],
    };
  }
  if (input.incoming.parentRevisionIds.includes(input.current.revisionId)) {
    if (
      input.current.operation === 'delete'
      && input.incoming.operation !== 'restore'
    ) {
      return mergedDecision({
        current: input.current,
        incoming: input.incoming,
        payload: input.current.payload,
        operation: 'delete',
        kind: 'keep-current',
      });
    }
    const kind = payloadKind(input.incoming);
    if (input.current.operation !== 'delete' && input.incoming.operation !== 'delete'
      && kind && kind === payloadKind(input.current)) {
      const retained = retainReadingWorkspaceExtensions(kind, payloadValue(input.current), payloadValue(input.incoming)) as Record<string, JsonValue>;
      if (!sameValue(retained, payloadValue(input.incoming))) {
        return mergedDecision({ current: input.current, incoming: input.incoming,
          payload: recordPayload(kind, retained), operation: input.incoming.operation });
      }
    }
    return {
      kind: 'apply-incoming',
      payload: input.incoming.payload,
      operation: input.incoming.operation,
      resultingHeadRevisionIds: [input.incoming.revisionId],
    };
  }
  if (sameValue(input.current.payload, input.incoming.payload)) {
    return mergedDecision({
      current: input.current,
      incoming: input.incoming,
      payload: input.current.payload,
      operation: input.current.operation,
    });
  }
  const currentDeleted = input.current.operation === 'delete';
  const incomingDeleted = input.incoming.operation === 'delete';
  if (currentDeleted && incomingDeleted) {
    const left = objectOf(input.current.payload, 'reading delete');
    const right = objectOf(input.incoming.payload, 'reading delete');
    return mergedDecision({
      current: input.current,
      incoming: input.incoming,
      payload: {
        schemaVersion: 1,
        deletedAt: Math.max(
          Number(left.deletedAt),
          Number(right.deletedAt),
        ),
      },
      operation: 'delete',
    });
  }
  if (currentDeleted || incomingDeleted) {
    return conflictDecision({
      current: input.current,
      incoming: input.incoming,
      conflictKind: 'reading-delete-modify',
    });
  }
  const currentKind = payloadKind(input.current);
  const incomingKind = payloadKind(input.incoming);
  if (!currentKind || currentKind !== incomingKind) {
    return conflictDecision({
      current: input.current,
      incoming: input.incoming,
      conflictKind: 'reading-record-divergence',
      conflictingFields: ['kind'],
    });
  }
  if (currentKind === 'book') return mergeBook(input as {
    current: ReadingWorkspaceRevisionValue;
    incoming: ReadingWorkspaceRevisionValue;
  });
  if (currentKind === 'chapter') return mergeChapter(input as {
    current: ReadingWorkspaceRevisionValue;
    incoming: ReadingWorkspaceRevisionValue;
  });
  if (currentKind === 'session') return mergeSession(input as {
    current: ReadingWorkspaceRevisionValue;
    incoming: ReadingWorkspaceRevisionValue;
  });
  if (currentKind === 'result-action') {
    return mergeResultAction(input as {
      current: ReadingWorkspaceRevisionValue;
      incoming: ReadingWorkspaceRevisionValue;
    });
  }
  const currentValue = payloadValue(input.current);
  const incomingValue = payloadValue(input.incoming);
  if (currentKind === 'annotation' || currentKind === 'segment-summary' || currentKind === 'paragraph' || currentKind === 'note') {
    const left = retainReadingWorkspaceExtensions(currentKind, incomingValue, currentValue);
    const right = retainReadingWorkspaceExtensions(currentKind, currentValue, incomingValue);
    if (sameValue(left, right)) return mergedDecision({
      current: input.current, incoming: input.incoming,
      payload: recordPayload(currentKind, left as Record<string, JsonValue>), operation: 'upsert',
    });
  }
  return conflictDecision({
    current: input.current,
    incoming: input.incoming,
    conflictKind: 'reading-record-divergence',
    conflictingFields: changedFields(currentValue, incomingValue),
  });
}
