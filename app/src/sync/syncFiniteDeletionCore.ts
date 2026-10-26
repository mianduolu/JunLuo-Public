import {
  CURRENT_SNAPSHOT_PLAN,
} from './syncCurrentSnapshot';
import type {
  FiniteDeletionCompactionV1,
} from './syncFiniteHistory';
import type { SyncOperation } from './syncProtocol';

export type FiniteDeletionCleanupPlanV1 = Readonly<{
  adapterId: string;
  action: 'central-ledger-only';
}>;

export const FINITE_DELETION_CLEANUP_PLAN:
readonly FiniteDeletionCleanupPlanV1[] = Object.freeze(
  CURRENT_SNAPSHOT_PLAN.map((entry) => Object.freeze({
    adapterId: entry.adapterId,
    action: 'central-ledger-only' as const,
  })),
);

if (
  FINITE_DELETION_CLEANUP_PLAN.length !== 41
  || new Set(FINITE_DELETION_CLEANUP_PLAN.map(
    (entry) => entry.adapterId,
  )).size !== 41
) {
  throw new Error('有限删除 cleanup plan 必须完整覆盖 41 个适配器。');
}

export function resolveFiniteDeletionCleanupPlan(adapterId: string) {
  const plan = FINITE_DELETION_CLEANUP_PLAN.find(
    (entry) => entry.adapterId === adapterId,
  );
  if (!plan) {
    throw new Error(`有限删除 cleanup plan 缺少 ${adapterId}。`);
  }
  return plan;
}

export function assertFiniteDeletionLocalCleanupSnapshot(input: {
  compaction: FiniteDeletionCompactionV1;
  heads: readonly { revisionId: string; operation: SyncOperation }[];
  pendingConflictCount: number;
  actualMutationIds: readonly string[];
}) {
  if (
    input.heads.length !== 1
    || input.heads[0]!.operation !== 'delete'
    || !input.compaction.targets.some((target) =>
      target.revisionId === input.heads[0]!.revisionId)
  ) {
    throw new Error('有限删除本机 current head 已变化，停止整理。');
  }
  if (input.pendingConflictCount > 0) {
    throw new Error('有限删除实体仍有冲突，停止整理。');
  }
  const expected = input.compaction.targets.map(
    (target) => target.mutationId,
  );
  if (
    JSON.stringify(input.actualMutationIds)
    !== JSON.stringify(expected)
  ) {
    throw new Error('有限删除本机目标集合已变化，停止整理。');
  }
}
