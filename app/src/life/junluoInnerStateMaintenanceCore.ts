import type { JunluoAffectStateV1 } from './junluoInnerState';

export function selectLatestUnretractedRelationshipChoiceEvidence(
  state: JunluoAffectStateV1,
) {
  const retracted = new Set(
    state.relationshipChoiceRetractions.map((entry) => entry.targetEvidenceId),
  );
  return state.relationshipChoiceEvidence
    .filter((entry) => !retracted.has(entry.evidenceId))
    .sort((left, right) => right.occurredAt - left.occurredAt)[0] ?? null;
}

function localDateKey(timestamp: number) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function calculateRelationshipChoiceDailyUse(
  state: JunluoAffectStateV1,
  now: number,
) {
  const today = localDateKey(now);
  let positiveUsed = 0;
  let negativeUsed = 0;
  for (const operation of state.recentProcessedOperations) {
    if (localDateKey(operation.occurredAt) !== today) continue;
    if (operation.operationId.endsWith(':relationship-choice:closer')) positiveUsed += 0.04;
    if (operation.operationId.endsWith(':relationship-choice:farther')) negativeUsed += 0.04;
    if (operation.operationId.endsWith(':relationship-choice:consider_leaving')) negativeUsed += 0.08;
  }
  return {
    negativeUsed: Math.min(0.08, negativeUsed),
    positiveUsed: Math.min(0.12, positiveUsed),
  };
}
