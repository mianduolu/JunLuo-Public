import type {
  SyncApplyResult,
  SyncDomainAdapter,
} from './syncAdapterRegistry';
import {
  assertMemoryRecordsMutationV1,
  isRetiredStayMemoryRecordsMutation,
  MEMORY_RECORD_ENTITY_SPECS,
  MEMORY_RECORDS_SCHEMA_VERSION,
  type MemoryRecordEntityType,
} from './syncMemoryRecords';
import {
  resolveMemoryRecordRevisions,
  type MemoryRecordMergeDecision,
  type MemoryRecordRevisionValue,
} from './syncMemoryRecordsMerge';
import type {
  PlainMutationV1,
  JsonValue,
} from './syncProtocol';
import { planCurrentMemoryProjection } from './syncMemoryCurrentProjection';

export type MemoryRecordsEntityRef = {
  entityType: MemoryRecordEntityType;
  entityId: string;
};

export interface MemoryRecordsApplyPort {
  loadSelectedCurrentMemory?(entityId: string): Promise<PlainMutationV1 | null>;
  loadCurrentMemoryPayload?(entityId: string): Promise<JsonValue | null>;
  hasAppliedMutation(mutationId: string): Promise<boolean>;
  loadCurrentHeadRevisions(
    entity: MemoryRecordsEntityRef,
  ): Promise<MemoryRecordRevisionValue[]>;
  loadRevision(revisionId: string): Promise<MemoryRecordRevisionValue | null>;
  commitAppliedMutation(input: {
    mutation: PlainMutationV1;
    currentHeadRevisionIds: string[];
    selectedCurrentRevisionId: string | null;
    decision: MemoryRecordMergeDecision;
    reconcileCurrentMemory?: boolean;
  }): Promise<{
    conflict: boolean;
    resultingHeadRevisionIds: string[];
  }>;
}

function incomingRevision(mutation: PlainMutationV1): MemoryRecordRevisionValue {
  return {
    revisionId: mutation.revision.id,
    parentRevisionIds: [...mutation.revision.parents],
    operation: mutation.revision.operation,
    createdAt: mutation.createdAt,
    payload: mutation.payload,
  };
}

async function loadCommonBase(input: {
  port: MemoryRecordsApplyPort;
  current: MemoryRecordRevisionValue;
  incoming: MemoryRecordRevisionValue;
}) {
  const incomingParents = new Set(input.incoming.parentRevisionIds);
  const commonParents = input.current.parentRevisionIds
    .filter((revisionId) => incomingParents.has(revisionId))
    .sort();
  if (!commonParents.length) return null;
  return input.port.loadRevision(commonParents[0]);
}

export class MemoryRecordsBusinessApplier {
  constructor(private readonly port: MemoryRecordsApplyPort) {}

  async reconcileCurrentMemory(mutation: PlainMutationV1): Promise<SyncApplyResult | null> {
    if (mutation.entity.type !== 'memory' || mutation.revision.operation !== 'upsert'
      || !this.port.loadSelectedCurrentMemory || !this.port.loadCurrentMemoryPayload) return null;
    const selected = await this.port.loadSelectedCurrentMemory(mutation.entity.id);
    if (!selected || selected.revision.id !== mutation.revision.id) return null;
    assertMemoryRecordsMutationV1(selected);
    const heads = await this.port.loadCurrentHeadRevisions({ entityType: 'memory', entityId: mutation.entity.id });
    const plan = await planCurrentMemoryProjection({ incoming: incomingRevision(selected), heads,
      business: await this.port.loadCurrentMemoryPayload(mutation.entity.id),
      loadRevision: id => this.port.loadRevision(id) });
    if (!plan) return null;
    if (plan.aligned) return { status: 'already-applied', revisionIds: heads.map(head => head.revisionId) };
    const committed = await this.port.commitAppliedMutation({ mutation: selected,
      currentHeadRevisionIds: heads.map(head => head.revisionId), selectedCurrentRevisionId: null,
      decision: { kind: 'apply-incoming', operation: 'upsert', payload: plan.payload,
        resultingHeadRevisionIds: [selected.revision.id] }, reconcileCurrentMemory: true });
    return { status: committed.conflict ? 'conflict' : 'applied', revisionIds: committed.resultingHeadRevisionIds };
  }

  private async containsAncestor(revision: MemoryRecordRevisionValue, ancestorId: string) {
    const pending = [...revision.parentRevisionIds];
    const visited = new Set<string>();
    while (pending.length) {
      const id = pending.pop()!;
      if (id === ancestorId) return true;
      if (visited.has(id)) continue;
      visited.add(id);
      const parent = await this.port.loadRevision(id);
      if (parent) pending.push(...parent.parentRevisionIds);
    }
    return false;
  }

  async applySyncMutation(mutation: PlainMutationV1, selectedCentralPostHead = false): Promise<SyncApplyResult> {
    assertMemoryRecordsMutationV1(mutation);
    if (await this.port.hasAppliedMutation(mutation.mutationId)) {
      return {
        status: 'already-applied',
        revisionIds: [mutation.revision.id],
      };
    }
    const entity: MemoryRecordsEntityRef = {
      entityType: mutation.entity.type as MemoryRecordEntityType,
      entityId: mutation.entity.id,
    };
    const currentHeads = await this.port.loadCurrentHeadRevisions(entity);
    if (isRetiredStayMemoryRecordsMutation(mutation)) {
      const committed = await this.port.commitAppliedMutation({
        mutation,
        currentHeadRevisionIds: currentHeads.map((revision) => revision.revisionId),
        selectedCurrentRevisionId: null,
        decision: {
          kind: 'ignore-incoming',
          payload: mutation.payload,
          operation: mutation.revision.operation,
          resultingHeadRevisionIds: currentHeads.map((revision) => revision.revisionId),
        },
      });
      return {
        status: committed.conflict ? 'conflict' : 'applied',
        revisionIds: committed.resultingHeadRevisionIds,
      };
    }
    let selectedCurrent = currentHeads.length
      ? [...currentHeads].sort((left, right) => (
        left.revisionId.localeCompare(right.revisionId)
      ))[0]
      : null;
    let incoming = incomingRevision(mutation);
    if (selectedCurrent && ['post', 'post-comment', 'post-tag'].includes(entity.entityType)) {
      // Old grandparents are replay, not a concurrent edit which may beat deletion.
      if (await this.containsAncestor(selectedCurrent, incoming.revisionId)) {
        selectedCurrent = { ...selectedCurrent, parentRevisionIds: [...selectedCurrent.parentRevisionIds, incoming.revisionId] };
      } else if (await this.containsAncestor(incoming, selectedCurrent.revisionId)) {
        incoming = { ...incoming, parentRevisionIds: [...incoming.parentRevisionIds, selectedCurrent.revisionId] };
      }
    }
    const base = selectedCurrent
      ? await loadCommonBase({
        port: this.port,
        current: selectedCurrent,
        incoming,
      })
      : null;
    let resolvedCentralMerge = false;
    if (selectedCentralPostHead && selectedCurrent
      && ['post', 'post-comment', 'post-tag', 'memory'].includes(entity.entityType)) {
      const { loadSyncEntityHeadMutations, loadSyncRevisionMutation } = await import('./syncMutationStateStore');
      const heads = await loadSyncEntityHeadMutations(mutation.entity);
      if (heads.length === 1 && heads[0].revision.id === mutation.revision.id) {
        const { sameBaiyunPostPayloads } = await import('./syncBaiyunPostHeadReconciliation');
        resolvedCentralMerge = selectedCurrent.operation === incoming.operation
          && sameBaiyunPostPayloads(selectedCurrent.payload, incoming.payload);
        const pending = [...mutation.revision.parents], visited = new Set<string>();
        while (!resolvedCentralMerge && pending.length) {
          const id = pending.pop()!;
          if (id === selectedCurrent.revisionId) { resolvedCentralMerge = true; break; }
          if (visited.has(id)) continue;
          visited.add(id);
          const parent = await loadSyncRevisionMutation(id);
          if (parent) pending.push(...parent.revision.parents);
        }
      }
    }
    // A verified central multi-head merge already chose a whole version. Its
    // native ancestor can be a deletion, including a logical comment deletion.
    // A local edit not in that ancestry still uses the original native resolver.
    let decision = resolveMemoryRecordRevisions({
      entityType: entity.entityType,
      current: resolvedCentralMerge ? null : selectedCurrent,
      incoming,
      base,
    });
    if (['post-review', 'post-review-action'].includes(entity.entityType)) {
      const terminal = (revision: MemoryRecordRevisionValue) => {
        const record = (revision.payload as { record: { status?: string; state?: string } }).record;
        return entity.entityType === 'post-review-action' ? record.state !== 'pending'
          : ['saved', 'discarded', 'suppressed'].includes(record.status ?? '');
      };
      // The selected original owner receipt may be behind a stale native
      // pending successor. Terminal facts absorb it even when ordinary ancestry
      // would ignore this older signature. Do not create a receiver-owned merge.
      if (terminal(incoming) && currentHeads.length && currentHeads.every(head => !terminal(head))) {
        decision = { kind: 'apply-incoming', payload: mutation.payload, operation: 'upsert',
          resultingHeadRevisionIds: [...new Set([...currentHeads.map(head => head.revisionId), incoming.revisionId])].sort() };
      }
    }
    const committed = await this.port.commitAppliedMutation({
      mutation,
      currentHeadRevisionIds: currentHeads.map((revision) => revision.revisionId),
      selectedCurrentRevisionId: selectedCurrent?.revisionId ?? null,
      decision,
    });
    return {
      status: committed.conflict ? 'conflict' : 'applied',
      revisionIds: committed.resultingHeadRevisionIds,
    };
  }
}

export function createMemoryRecordsSyncAdapters(
  port: MemoryRecordsApplyPort,
): SyncDomainAdapter[] {
  const applier = new MemoryRecordsBusinessApplier(port);
  const entityTypes: MemoryRecordEntityType[] = MEMORY_RECORD_ENTITY_SPECS.map(
    (spec) => spec.entityType,
  );
  return entityTypes.map((entityType): SyncDomainAdapter => ({
    domain: 'memory',
    entityType,
    schemaVersions: entityType === 'memory' ? [1, 2, 3, 4, 5, 9, 10]
      : entityType === 'post' ? [5, 6, 9, 10] : entityType === 'post-comment' ? [5, 6]
      : entityType === 'post-tag' ? [5, 7]
        : ['post-review', 'post-review-action'].includes(entityType) ? [8]
          : entityType === 'post-confirmation' ? [5] : [1, 2, 3, 4, MEMORY_RECORDS_SCHEMA_VERSION],
    apply: (mutation) => applier.applySyncMutation(mutation),
  }));
}
