import {
  isBaiyunRetiredActionIntentId,
  type BaiyunActionExecutionRecord,
} from './actionIntent';

const BAIYUN_LOW_BATTERY_SOURCE_ID_PREFIX = 'phone_low_battery:';

export function isBaiyunLowBatteryActionSourceId(sourceId: string) {
  return sourceId.startsWith(BAIYUN_LOW_BATTERY_SOURCE_ID_PREFIX);
}

function unique<T>(values: readonly T[]) {
  return [...new Set(values)];
}

const STATE_RANK: Record<BaiyunActionExecutionRecord['state'], number> = {
  planned: 0,
  remembered: 1,
  deferred: 1,
  blocked: 1,
  acted: 2,
  failed: 3,
  completed: 4,
};

export function mergeBaiyunActionExecutionRecord(
  left: BaiyunActionExecutionRecord,
  right: BaiyunActionExecutionRecord,
) {
  if (left.planId !== right.planId) return right;
  const later = right.updatedAt >= left.updatedAt ? right : left;
  const stronger = STATE_RANK[right.state] >= STATE_RANK[left.state] ? right : left;
  return {
    ...later,
    state: stronger.state,
    messageIds: unique([...left.messageIds, ...right.messageIds]),
    evidence: unique([...left.evidence, ...right.evidence]),
    continuityEventIds: unique([
      ...left.continuityEventIds,
      ...right.continuityEventIds,
    ]),
    actualPermissions: unique([
      ...left.actualPermissions,
      ...right.actualPermissions,
    ]),
    createdAt: Math.min(left.createdAt, right.createdAt),
    updatedAt: Math.max(left.updatedAt, right.updatedAt),
  } satisfies BaiyunActionExecutionRecord;
}

export function retainBaiyunActionExecutionRecords(
  records: readonly BaiyunActionExecutionRecord[],
  openContinuityEventIds: ReadonlySet<string> = new Set(),
) {
  const byPlanId = new Map<string, BaiyunActionExecutionRecord>();
  for (const record of records.filter((candidate) => (
    !isBaiyunRetiredActionIntentId(candidate.primaryIntent)
    && !isBaiyunRetiredActionIntentId(candidate.plan.primaryIntent)
  ))) {
    const existing = byPlanId.get(record.planId);
    byPlanId.set(
      record.planId,
      existing ? mergeBaiyunActionExecutionRecord(existing, record) : record,
    );
  }
  const all = [...byPlanId.values()];
  const unfinishedImportant = all.filter((record) => (
    record.obligationKind === 'continuity'
    && record.continuityEventIds.some((eventId) => openContinuityEventIds.has(eventId))
    && record.state !== 'completed'
    && record.state !== 'failed'
  ));
  const recentOthers = all
    .filter((record) => !unfinishedImportant.includes(record))
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, 24);
  return [...unfinishedImportant, ...recentOthers]
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

export function collectBaiyunPotentiallyOpenContinuityEventIds(
  records: readonly BaiyunActionExecutionRecord[],
  additionalEventIds: readonly string[] = [],
) {
  return new Set([
    ...additionalEventIds,
    ...records.flatMap((record) => (
      record.obligationKind === 'continuity'
      && record.state !== 'completed'
      && record.state !== 'failed'
        ? record.continuityEventIds
        : []
    )),
  ]);
}
