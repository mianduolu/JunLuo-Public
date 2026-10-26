import type { SyncOperation } from './syncProtocol';

export type ConcurrentRevisionInput = {
  revisionId: string;
  operation: SyncOperation;
  changedFields: string[];
};

export type ConcurrentMergeDecision = {
  kind: 'identical' | 'append-union' | 'both-deleted' | 'delete-edit' | 'disjoint-fields' | 'same-field';
  automatic: boolean;
  visibleRevisionIds: string[];
  preservedRevisionIds: string[];
  conflictingFields: string[];
};

function sortedUnique(values: string[]) {
  return [...new Set(values)].sort();
}

function validateInput(input: ConcurrentRevisionInput, label: string) {
  if (!input.revisionId) throw new Error(`${label}.revisionId 不能为空。`);
  if (input.changedFields.some((field) => !field || field.length > 160)) {
    throw new Error(`${label}.changedFields 含无效字段名。`);
  }
  if (new Set(input.changedFields).size !== input.changedFields.length) {
    throw new Error(`${label}.changedFields 不能重复。`);
  }
}

export function classifyConcurrentRevisions(
  left: ConcurrentRevisionInput,
  right: ConcurrentRevisionInput,
): ConcurrentMergeDecision {
  validateInput(left, 'left');
  validateInput(right, 'right');
  const allRevisionIds = sortedUnique([left.revisionId, right.revisionId]);
  if (left.revisionId === right.revisionId) {
    return {
      kind: 'identical',
      automatic: true,
      visibleRevisionIds: allRevisionIds,
      preservedRevisionIds: [],
      conflictingFields: [],
    };
  }
  if (left.operation === 'append' && right.operation === 'append') {
    return {
      kind: 'append-union',
      automatic: true,
      visibleRevisionIds: allRevisionIds,
      preservedRevisionIds: [],
      conflictingFields: [],
    };
  }
  if (left.operation === 'delete' && right.operation === 'delete') {
    return {
      kind: 'both-deleted',
      automatic: true,
      visibleRevisionIds: allRevisionIds,
      preservedRevisionIds: [],
      conflictingFields: [],
    };
  }
  if (left.operation === 'delete' || right.operation === 'delete') {
    const deleted = left.operation === 'delete' ? left : right;
    const edited = left.operation === 'delete' ? right : left;
    return {
      kind: 'delete-edit',
      automatic: false,
      visibleRevisionIds: [deleted.revisionId],
      preservedRevisionIds: [edited.revisionId],
      conflictingFields: [],
    };
  }

  const rightFields = new Set(right.changedFields);
  const conflicts = sortedUnique(left.changedFields.filter((field) => rightFields.has(field)));
  if (conflicts.length === 0) {
    return {
      kind: 'disjoint-fields',
      automatic: true,
      visibleRevisionIds: allRevisionIds,
      preservedRevisionIds: [],
      conflictingFields: [],
    };
  }
  return {
    kind: 'same-field',
    automatic: false,
    visibleRevisionIds: allRevisionIds,
    preservedRevisionIds: allRevisionIds,
    conflictingFields: conflicts,
  };
}

