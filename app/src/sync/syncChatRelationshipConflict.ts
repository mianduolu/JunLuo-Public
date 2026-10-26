import {
  assertChatRelationshipMutationV1,
  type ChatRelationshipRecordKind,
} from './syncChatRelationship';
import {
  classifyConcurrentRevisions,
  type ConcurrentMergeDecision,
} from './syncMerge';
import type {
  JsonValue,
  PlainMutationV1,
} from './syncProtocol';

export type ChatRelationshipMergeMode =
  | 'append-set'
  | 'field-revision'
  | 'versioned-record'
  | 'state-machine';

export type ChatRelationshipConflictDescriptor = {
  mergeMode: ChatRelationshipMergeMode;
  changedFields: string[];
};

const APPEND_SET_KINDS = new Set<ChatRelationshipRecordKind>([
  'favorite',
  'liked-style-reference',
  'user-correction',
  'keyword-event',
  'keyword-insight',
]);

const FIELD_REVISION_KINDS = new Set<ChatRelationshipRecordKind>([
  'chat-preferences',
  'keyword-settings',
  'notebook-settings',
]);

const STATE_MACHINE_KINDS = new Set<ChatRelationshipRecordKind>([
  'keyword-task',
  'sleep-state',
]);

function isRecord(value: JsonValue): value is { [key: string]: JsonValue } {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function payloadRecord(mutation: PlainMutationV1) {
  if (!isRecord(mutation.payload)) {
    throw new Error('chat.relationship-state conflict payload 必须是对象。');
  }
  return mutation.payload;
}

function valueFields(value: JsonValue) {
  return isRecord(value) ? Object.keys(value).sort() : ['$value'];
}

export function describeChatRelationshipConflict(
  mutation: PlainMutationV1,
): ChatRelationshipConflictDescriptor {
  assertChatRelationshipMutationV1(mutation);
  if (mutation.revision.operation === 'delete') {
    return {
      mergeMode: mutation.entity.type === 'sleep-state' ? 'state-machine' : 'versioned-record',
      changedFields: [],
    };
  }
  const payload = payloadRecord(mutation);
  const kind = payload.kind as ChatRelationshipRecordKind;
  const value = payload.value as JsonValue;
  if (mutation.revision.operation === 'append' && APPEND_SET_KINDS.has(kind)) {
    return {
      mergeMode: 'append-set',
      changedFields: [],
    };
  }
  if (FIELD_REVISION_KINDS.has(kind)) {
    return {
      mergeMode: 'field-revision',
      changedFields: valueFields(value),
    };
  }
  if (STATE_MACHINE_KINDS.has(kind)) {
    return {
      mergeMode: 'state-machine',
      changedFields: ['$state'],
    };
  }
  return {
    mergeMode: 'versioned-record',
    changedFields: valueFields(value),
  };
}

function nonAutomaticDecision(input: {
  left: PlainMutationV1;
  right: PlainMutationV1;
  field: string;
}): ConcurrentMergeDecision {
  const revisionIds = [...new Set([
    input.left.revision.id,
    input.right.revision.id,
  ])].sort();
  return {
    kind: 'same-field',
    automatic: false,
    visibleRevisionIds: revisionIds,
    preservedRevisionIds: revisionIds,
    conflictingFields: [input.field],
  };
}

export function classifyChatRelationshipConcurrentMutations(
  left: PlainMutationV1,
  right: PlainMutationV1,
): ConcurrentMergeDecision {
  assertChatRelationshipMutationV1(left);
  assertChatRelationshipMutationV1(right);
  if (
    left.entity.domain !== right.entity.domain
    || left.entity.type !== right.entity.type
    || left.entity.id !== right.entity.id
  ) {
    throw new Error('只能比较同一个 chat.relationship-state 实体的并发 revision。');
  }
  const leftDescriptor = describeChatRelationshipConflict(left);
  const rightDescriptor = describeChatRelationshipConflict(right);
  const generic = classifyConcurrentRevisions(
    {
      revisionId: left.revision.id,
      operation: left.revision.operation,
      changedFields: leftDescriptor.changedFields,
    },
    {
      revisionId: right.revision.id,
      operation: right.revision.operation,
      changedFields: rightDescriptor.changedFields,
    },
  );
  if (
    generic.kind === 'identical'
    || generic.kind === 'both-deleted'
    || generic.kind === 'delete-edit'
  ) {
    return generic;
  }
  if (generic.kind === 'append-union') {
    if (
      leftDescriptor.mergeMode === 'append-set'
      && rightDescriptor.mergeMode === 'append-set'
    ) {
      return generic;
    }
    return nonAutomaticDecision({
      left,
      right,
      field: (
        leftDescriptor.mergeMode === 'state-machine'
        || rightDescriptor.mergeMode === 'state-machine'
      ) ? '$state' : '$record',
    });
  }
  if (
    leftDescriptor.mergeMode === 'state-machine'
    || rightDescriptor.mergeMode === 'state-machine'
  ) {
    return nonAutomaticDecision({
      left,
      right,
      field: '$state',
    });
  }
  if (leftDescriptor.mergeMode !== rightDescriptor.mergeMode) {
    return nonAutomaticDecision({
      left,
      right,
      field: '$record-kind',
    });
  }
  return generic;
}
