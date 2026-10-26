import {
  captureBackupRestoreDataEpoch,
  runBackupRestoreDataEpochCommit,
} from '../backup/backupRestoreCoordinator';
import { loadCurrentSyncDevice } from '../sync/syncCurrentDevice';
import { assistantLifeStateStorageBridge } from '../sync/syncAssistantLifeStateStorageBridge';
import {
  JUNLUO_DESIRE_IDS,
  JUNLUO_INNER_STATE_KEYS,
  isJunluoAffectStateLegacyV1,
  isJunluoAffectStateV1,
  isJunluoDesireState,
  isJunluoThoughtStateV1,
  isJunluoThoughtStateV2,
} from './junluoInnerState';
import { retractJunluoRelationshipChoiceEvidence } from './junluoInnerStateGeneration';
import {
  calculateRelationshipChoiceDailyUse,
  selectLatestUnretractedRelationshipChoiceEvidence,
} from './junluoInnerStateMaintenanceCore';
import {
  loadJunluoAffectState,
  updateJunluoAffectState,
} from './junluoInnerStateStore';

async function retryOnce<T>(work: () => Promise<T>) {
  try {
    return await work();
  } catch {
    return work();
  }
}

export type JunluoInnerStateMaintenanceResult =
  | { status: 'blocked' }
  | { status: 'no-evidence' }
  | { evidenceId: string; status: 'retracted' };

export async function retractLatestJunluoRelationshipChoiceEvidence(
  now = Date.now(),
): Promise<JunluoInnerStateMaintenanceResult> {
  const dataEpoch = captureBackupRestoreDataEpoch();
  if (dataEpoch === null) return { status: 'blocked' };
  let evidenceId: string | undefined;
  const saved = await updateJunluoAffectState(state => {
    evidenceId ??= selectLatestUnretractedRelationshipChoiceEvidence(state)?.evidenceId;
    if (!evidenceId) return state;
    return retractJunluoRelationshipChoiceEvidence({
      evidenceId,
      now,
      operationId: `manual-relationship-choice-retraction:${evidenceId}`,
      state,
    });
  }, { dataEpoch });
  if (!saved) return { status: 'blocked' };
  return evidenceId ? { evidenceId, status: 'retracted' } : { status: 'no-evidence' };
}

export async function resetJunluoInnerState(): Promise<'reset' | 'blocked'> {
  const dataEpoch = captureBackupRestoreDataEpoch();
  if (dataEpoch === null) return 'blocked';
  const committed = await runBackupRestoreDataEpochCommit(dataEpoch, () => retryOnce(
    () => assistantLifeStateStorageBridge.multiRemove([
      JUNLUO_INNER_STATE_KEYS.desire,
      JUNLUO_INNER_STATE_KEYS.affect,
      JUNLUO_INNER_STATE_KEYS.thought,
    ]),
  ));
  return committed.committed ? 'reset' : 'blocked';
}

type RawStateDiagnostic = {
  exists: boolean;
  legal: boolean;
  schemaVersion: number | null;
};

export type JunluoInnerStateTechnicalDiagnostic = {
  affect: RawStateDiagnostic;
  desire: RawStateDiagnostic;
  latestAffectOperationIds: string[];
  latestDesireChangeIds: Array<{ desireId: string; operationId: string }>;
  relationshipChoiceDailyLimit: {
    negativeUsed: number;
    positiveUsed: number;
  };
  relationshipChoiceValueInBounds: boolean;
  relationshipFeelingValueInBounds: boolean;
  strainValueInBounds: boolean;
  syncEnabled: boolean;
  thought: RawStateDiagnostic;
  thoughtStateCounts: Record<string, number>;
};

function parseRaw(
  raw: string | null,
  validators: {
    legacy?: (value: unknown) => boolean;
    current: (value: unknown) => boolean;
  },
): RawStateDiagnostic {
  if (raw === null) return { exists: false, legal: true, schemaVersion: null };
  try {
    const parsed = JSON.parse(raw) as { schemaVersion?: unknown };
    return {
      exists: true,
      legal: validators.current(parsed) || validators.legacy?.(parsed) === true,
      schemaVersion: typeof parsed?.schemaVersion === 'number' ? parsed.schemaVersion : null,
    };
  } catch {
    return { exists: true, legal: false, schemaVersion: null };
  }
}

export async function loadJunluoInnerStateTechnicalDiagnostic(
  now = Date.now(),
): Promise<JunluoInnerStateTechnicalDiagnostic> {
  const [entries, affect, syncDevice] = await Promise.all([
    assistantLifeStateStorageBridge.multiGet([
      JUNLUO_INNER_STATE_KEYS.desire,
      JUNLUO_INNER_STATE_KEYS.affect,
      JUNLUO_INNER_STATE_KEYS.thought,
    ]),
    loadJunluoAffectState(),
    loadCurrentSyncDevice().catch(() => null),
  ]);
  const rawByKey = new Map(entries);
  const desireRaw = rawByKey.get(JUNLUO_INNER_STATE_KEYS.desire) ?? null;
  const affectRaw = rawByKey.get(JUNLUO_INNER_STATE_KEYS.affect) ?? null;
  const thoughtRaw = rawByKey.get(JUNLUO_INNER_STATE_KEYS.thought) ?? null;
  let parsedDesire: unknown = null;
  let parsedThought: unknown = null;
  try { parsedDesire = desireRaw ? JSON.parse(desireRaw) : null; } catch { parsedDesire = null; }
  try { parsedThought = thoughtRaw ? JSON.parse(thoughtRaw) : null; } catch { parsedThought = null; }
  const latestDesireChangeIds = isJunluoDesireState(parsedDesire)
    ? JUNLUO_DESIRE_IDS.flatMap((desireId) => {
        const change = parsedDesire.desires[desireId].lastValueChange;
        return change ? [{ desireId, operationId: change.operationId }] : [];
      })
    : [];
  const thoughtStateCounts: Record<string, number> = {};
  if (isJunluoThoughtStateV2(parsedThought)) {
    for (const thought of parsedThought.thoughts) {
      thoughtStateCounts[thought.state] = (thoughtStateCounts[thought.state] ?? 0) + 1;
    }
  }
  return {
    affect: parseRaw(affectRaw, {
      legacy: isJunluoAffectStateLegacyV1,
      current: isJunluoAffectStateV1,
    }),
    desire: parseRaw(desireRaw, {
      current: isJunluoDesireState,
    }),
    latestAffectOperationIds: [
      affect.emotionsLastOperation?.operationId,
      affect.lifeStateLastOperation?.operationId,
      affect.relationshipFeeling.lastOperation?.operationId,
      affect.relationshipChoice.lastOperation?.operationId,
      affect.strain.lastOperation?.operationId,
    ].filter((entry): entry is string => Boolean(entry)),
    latestDesireChangeIds,
    relationshipChoiceDailyLimit: calculateRelationshipChoiceDailyUse(affect, now),
    relationshipChoiceValueInBounds: affect.relationshipChoice.value >= 0 && affect.relationshipChoice.value <= 1,
    relationshipFeelingValueInBounds: affect.relationshipFeeling.value >= -1 && affect.relationshipFeeling.value <= 1,
    strainValueInBounds: affect.strain.value >= 0 && affect.strain.value <= 1,
    syncEnabled: Boolean(syncDevice),
    thought: parseRaw(thoughtRaw, {
      legacy: isJunluoThoughtStateV1,
      current: isJunluoThoughtStateV2,
    }),
    thoughtStateCounts,
  };
}
