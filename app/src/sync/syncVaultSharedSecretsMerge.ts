import {
  assertVaultSharedSecretMutationV1,
} from './syncVaultSharedSecrets';
import {
  classifyConcurrentRevisions,
  type ConcurrentMergeDecision,
} from './syncMerge';
import type { PlainMutationV1 } from './syncProtocol';

function sortedRevisionIds(
  left: PlainMutationV1,
  right: PlainMutationV1,
) {
  return [...new Set([
    left.revision.id,
    right.revision.id,
  ])].sort();
}

function valueTag(mutation: PlainMutationV1) {
  if (mutation.revision.operation === 'delete') return null;
  const payload = mutation.payload as Record<string, unknown>;
  const secret = payload.secret as Record<string, unknown>;
  const wrappedSecret =
    secret.wrappedSecret as Record<string, unknown>;
  return wrappedSecret.valueTag as string;
}

export function classifyVaultSharedSecretConcurrentMutations(
  left: PlainMutationV1,
  right: PlainMutationV1,
): ConcurrentMergeDecision {
  assertVaultSharedSecretMutationV1(left);
  assertVaultSharedSecretMutationV1(right);
  if (
    left.entity.domain !== right.entity.domain
    || left.entity.type !== right.entity.type
    || left.entity.id !== right.entity.id
  ) {
    throw new Error(
      '只能比较同一个 vault.shared-secrets 实体的并发 revision。',
    );
  }
  const generic = classifyConcurrentRevisions(
    {
      revisionId: left.revision.id,
      operation: left.revision.operation,
      changedFields: ['$secret'],
    },
    {
      revisionId: right.revision.id,
      operation: right.revision.operation,
      changedFields: ['$secret'],
    },
  );
  if (
    generic.kind === 'identical'
    || generic.kind === 'both-deleted'
    || generic.kind === 'delete-edit'
  ) {
    return generic;
  }
  const revisionIds = sortedRevisionIds(left, right);
  if (valueTag(left) === valueTag(right)) {
    return {
      kind: 'identical',
      automatic: true,
      visibleRevisionIds: revisionIds,
      preservedRevisionIds: [],
      conflictingFields: [],
    };
  }
  return {
    kind: 'same-field',
    automatic: false,
    visibleRevisionIds: revisionIds,
    preservedRevisionIds: revisionIds,
    conflictingFields: ['$secret'],
  };
}
