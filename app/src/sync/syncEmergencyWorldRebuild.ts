import {
  assertSyncUuidV4,
} from './syncDeviceContract';

export const EMERGENCY_WORLD_REBUILD_ADAPTER_TOTAL = 41 as const;

export type EmergencySyncWorldRebuildPhaseV1 =
  | 'freezing-old-world'
  | 'revoking-old-devices'
  | 'preparing-current-state'
  | 'preparing-current-files'
  | 'verifying-current-state'
  | 'cutting-over'
  | 'complete'
  | 'blocked';

export type EmergencySyncWorldRebuildV1 = Readonly<{
  version: 1 | 2;
  sessionId: string;
  phase: EmergencySyncWorldRebuildPhaseV1;
  oldVaultId: string;
  oldKeyId: string;
  newVaultId: string | null;
  newKeyId: string | null;
  completedAdapters: number;
  totalAdapters: 40 | typeof EMERGENCY_WORLD_REBUILD_ADAPTER_TOTAL;
  completedFiles: number;
  totalFiles: number;
  missingFiles: number;
  oldDeviceRevocation:
    | 'not-attempted'
    | 'complete'
    | 'relay-unreachable'
    | 'partial';
  lastErrorCode: string | null;
  startedAt: number;
  updatedAt: number;
}>;

export type EmergencySyncWorldCutoverStageV1 =
  | 'prepared'
  | 'connections-closed'
  | 'old-database-moved'
  | 'new-database-activated'
  | 'new-secret-activated'
  | 'verified';

export type EmergencySyncWorldCutoverJournalV1 = Readonly<{
  version: 1;
  sessionId: string;
  stage: EmergencySyncWorldCutoverStageV1;
  activeDatabaseName: 'junluo-sync-v2.db';
  stagedDatabaseName: string;
  rollbackDatabaseName: string;
  expectedNewVaultId: string;
  expectedNewKeyId: string;
  updatedAt: number;
}>;

export type EmergencySyncWorldRebuildSnapshot = Readonly<{
  active: boolean;
  phase: EmergencySyncWorldRebuildPhaseV1 | 'idle';
  completedAdapters: number;
  totalAdapters: 40 | typeof EMERGENCY_WORLD_REBUILD_ADAPTER_TOTAL;
  completedFiles: number;
  totalFiles: number;
  missingFiles: number;
  oldDeviceRevocation: EmergencySyncWorldRebuildV1['oldDeviceRevocation'];
  canContinue: boolean;
  lastErrorCode: string | null;
}>;

const REBUILD_PHASES = Object.freeze<EmergencySyncWorldRebuildPhaseV1[]>([
  'freezing-old-world',
  'revoking-old-devices',
  'preparing-current-state',
  'preparing-current-files',
  'verifying-current-state',
  'cutting-over',
  'complete',
  'blocked',
]);

const CUTOVER_STAGES = Object.freeze<EmergencySyncWorldCutoverStageV1[]>([
  'prepared',
  'connections-closed',
  'old-database-moved',
  'new-database-activated',
  'new-secret-activated',
  'verified',
]);

const ERROR_CODE = /^[a-z0-9][a-z0-9._-]{0,79}$/u;
const REBUILD_DATABASE = /^junluo-sync-v2-rebuild-([0-9a-f-]{36})\.db$/u;
const ROLLBACK_DATABASE = /^junluo-sync-v2-pre-rebuild-([0-9a-f-]{36})\.db$/u;

function exactObject(
  value: unknown,
  fields: readonly string[],
  label: string,
) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(fields);
  if (
    Object.keys(record).some((field) => !allowed.has(field))
    || fields.some((field) => !(field in record))
  ) {
    throw new Error(`${label} fields do not match v1`);
  }
  return record;
}

function timestamp(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} must be a non-negative timestamp`);
  }
  return Number(value);
}

function count(value: unknown, label: string, maximum?: number) {
  if (
    !Number.isSafeInteger(value)
    || Number(value) < 0
    || (maximum !== undefined && Number(value) > maximum)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return Number(value);
}

export function emergencyRebuildDatabaseName(sessionId: string) {
  assertSyncUuidV4(sessionId, 'emergency rebuild sessionId');
  return `junluo-sync-v2-rebuild-${sessionId}.db` as const;
}

export function emergencyRollbackDatabaseName(sessionId: string) {
  assertSyncUuidV4(sessionId, 'emergency rebuild sessionId');
  return `junluo-sync-v2-pre-rebuild-${sessionId}.db` as const;
}

export function assertEmergencySyncWorldRebuildV1(
  value: unknown,
): asserts value is EmergencySyncWorldRebuildV1 {
  const record = exactObject(value, [
    'version',
    'sessionId',
    'phase',
    'oldVaultId',
    'oldKeyId',
    'newVaultId',
    'newKeyId',
    'completedAdapters',
    'totalAdapters',
    'completedFiles',
    'totalFiles',
    'missingFiles',
    'oldDeviceRevocation',
    'lastErrorCode',
    'startedAt',
    'updatedAt',
  ], 'emergency sync-world rebuild');
  if (record.version !== 1 && record.version !== 2) {
    throw new Error('emergency sync-world rebuild version is unsupported');
  }
  assertSyncUuidV4(record.sessionId, 'emergency rebuild sessionId');
  assertSyncUuidV4(record.oldVaultId, 'emergency rebuild oldVaultId');
  assertSyncUuidV4(record.oldKeyId, 'emergency rebuild oldKeyId');
  if (!REBUILD_PHASES.includes(record.phase as EmergencySyncWorldRebuildPhaseV1)) {
    throw new Error('emergency rebuild phase is invalid');
  }
  if ((record.newVaultId === null) !== (record.newKeyId === null)) {
    throw new Error('emergency rebuild new-world identity is incomplete');
  }
  if (record.newVaultId !== null) {
    assertSyncUuidV4(record.newVaultId, 'emergency rebuild newVaultId');
    assertSyncUuidV4(record.newKeyId, 'emergency rebuild newKeyId');
    if (
      record.newVaultId === record.oldVaultId
      || record.newKeyId === record.oldKeyId
    ) {
      throw new Error('emergency rebuild must create an independent world');
    }
  }
  const expectedTotal = record.version === 1 ? 40 : EMERGENCY_WORLD_REBUILD_ADAPTER_TOTAL;
  const completedAdapters = count(
    record.completedAdapters,
    'emergency rebuild completedAdapters',
    expectedTotal,
  );
  if (record.totalAdapters !== expectedTotal) {
    throw new Error('emergency rebuild adapter total does not match its catalog version');
  }
  const completedFiles = count(record.completedFiles, 'emergency rebuild completedFiles');
  const totalFiles = count(record.totalFiles, 'emergency rebuild totalFiles');
  const missingFiles = count(record.missingFiles, 'emergency rebuild missingFiles');
  if (completedFiles > totalFiles || missingFiles > totalFiles) {
    throw new Error('emergency rebuild file progress is inconsistent');
  }
  if (![
    'not-attempted',
    'complete',
    'relay-unreachable',
    'partial',
  ].includes(String(record.oldDeviceRevocation))) {
    throw new Error('emergency rebuild revocation result is invalid');
  }
  if (
    record.lastErrorCode !== null
    && (
      typeof record.lastErrorCode !== 'string'
      || !ERROR_CODE.test(record.lastErrorCode)
    )
  ) {
    throw new Error('emergency rebuild error code is invalid');
  }
  const startedAt = timestamp(record.startedAt, 'emergency rebuild startedAt');
  const updatedAt = timestamp(record.updatedAt, 'emergency rebuild updatedAt');
  if (updatedAt < startedAt) {
    throw new Error('emergency rebuild timestamps moved backwards');
  }
  if (
    record.phase === 'complete'
    && (
      record.newVaultId === null
      || completedAdapters !== expectedTotal
      || completedFiles !== totalFiles
      || missingFiles !== 0
      || record.lastErrorCode !== null
    )
  ) {
    throw new Error('completed emergency rebuild is incomplete');
  }
}

export function assertEmergencySyncWorldCutoverJournalV1(
  value: unknown,
): asserts value is EmergencySyncWorldCutoverJournalV1 {
  const record = exactObject(value, [
    'version',
    'sessionId',
    'stage',
    'activeDatabaseName',
    'stagedDatabaseName',
    'rollbackDatabaseName',
    'expectedNewVaultId',
    'expectedNewKeyId',
    'updatedAt',
  ], 'emergency sync-world cutover journal');
  if (record.version !== 1) {
    throw new Error('emergency cutover journal version is unsupported');
  }
  assertSyncUuidV4(record.sessionId, 'emergency cutover sessionId');
  if (!CUTOVER_STAGES.includes(record.stage as EmergencySyncWorldCutoverStageV1)) {
    throw new Error('emergency cutover stage is invalid');
  }
  if (record.activeDatabaseName !== 'junluo-sync-v2.db') {
    throw new Error('emergency cutover active database is invalid');
  }
  const staged = REBUILD_DATABASE.exec(String(record.stagedDatabaseName));
  const rollback = ROLLBACK_DATABASE.exec(String(record.rollbackDatabaseName));
  if (
    !staged
    || !rollback
    || staged[1] !== record.sessionId
    || rollback[1] !== record.sessionId
  ) {
    throw new Error('emergency cutover database names do not match session');
  }
  assertSyncUuidV4(record.expectedNewVaultId, 'emergency cutover newVaultId');
  assertSyncUuidV4(record.expectedNewKeyId, 'emergency cutover newKeyId');
  timestamp(record.updatedAt, 'emergency cutover updatedAt');
}

export function emergencySyncWorldRebuildSnapshot(
  value: EmergencySyncWorldRebuildV1 | null,
): EmergencySyncWorldRebuildSnapshot {
  if (!value) {
    return Object.freeze({
      active: false,
      phase: 'idle',
      completedAdapters: 0,
      totalAdapters: EMERGENCY_WORLD_REBUILD_ADAPTER_TOTAL,
      completedFiles: 0,
      totalFiles: 0,
      missingFiles: 0,
      oldDeviceRevocation: 'not-attempted',
      canContinue: false,
      lastErrorCode: null,
    });
  }
  assertEmergencySyncWorldRebuildV1(value);
  return Object.freeze({
    active: value.phase !== 'complete',
    phase: value.phase,
    completedAdapters: value.completedAdapters,
    totalAdapters: value.totalAdapters,
    completedFiles: value.completedFiles,
    totalFiles: value.totalFiles,
    missingFiles: value.missingFiles,
    oldDeviceRevocation: value.oldDeviceRevocation,
    canContinue: value.phase !== 'complete' && value.phase !== 'cutting-over',
    lastErrorCode: value.lastErrorCode,
  });
}

export function isEmergencySyncWorldFrozen(
  value: EmergencySyncWorldRebuildV1 | null,
) {
  return value !== null && value.phase !== 'complete';
}

export function advanceEmergencyCutoverJournal(
  journal: EmergencySyncWorldCutoverJournalV1,
  stage: EmergencySyncWorldCutoverStageV1,
  updatedAt: number,
) {
  assertEmergencySyncWorldCutoverJournalV1(journal);
  const currentIndex = CUTOVER_STAGES.indexOf(journal.stage);
  const nextIndex = CUTOVER_STAGES.indexOf(stage);
  if (nextIndex < currentIndex || nextIndex > currentIndex + 1) {
    throw new Error('emergency cutover journal cannot skip or move backwards');
  }
  const next = Object.freeze({ ...journal, stage, updatedAt });
  assertEmergencySyncWorldCutoverJournalV1(next);
  return next;
}
