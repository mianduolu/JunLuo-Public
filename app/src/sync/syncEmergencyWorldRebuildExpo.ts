import * as FileSystem from 'expo-file-system/legacy';
import * as SQLite from 'expo-sqlite';

import { runBackupRestoreExclusive } from '../backup/backupRestoreCoordinator';
import { unregisterAutomaticDataSyncBackgroundTask } from './automaticDataSyncBackgroundTask';
import { clearBackupRestoreSyncGate } from '../backup/backupRestoreSyncGate';
import { resetAutomaticDataSyncPolicy } from './automaticDataSyncPolicy';
import { AndroidDeviceManagementController } from './syncAndroidDeviceManagement';
import { createAndroidCurrentSnapshotSources, resetAndroidNewWorldTechnicalState } from './syncAndroidNewWorldController';
import { rebindPostReviewOwnerForNewWorld } from './syncBaiyunPostReviewCurrentSnapshot';
import { enqueueAndroidExplicitSyncOperation } from './syncAndroidExplicitOperationQueue';
import { rebindEmergencyAndroidLocalObjectReferences } from './syncEmergencyLocalObjectReferencesExpo';
import { activateAndroidNewWorldLiveCapture } from './syncAndroidNewWorldLiveCapture';
import {
  bytesToBase64Url,
  canonicalizeJsonBytesV1,
  sha256BytesV1,
} from './syncCrypto';
import { expoSyncRandomUuidV1 } from './syncCryptoExpo';
import { closeAllActiveSyncWorldDatabases } from './syncDatabaseRuntime';
import { openInitializedSyncDatabase } from './syncDatabaseOpen';
import {
  emergencyRebuildDatabaseName,
  EMERGENCY_WORLD_REBUILD_ADAPTER_TOTAL,
  emergencyRollbackDatabaseName,
  type EmergencySyncWorldCutoverJournalV1,
  type EmergencySyncWorldRebuildV1,
} from './syncEmergencyWorldRebuild';
import { resumeEmergencyWorldCutover } from './syncEmergencyWorldCutover';
import {
  EmergencyRebuildMissingObjectsError,
  createEmergencyObjectRekeySession,
} from './syncEmergencyObjectRekeyExpo';
import {
  clearEmergencySyncWorldCutoverJournal,
  createInitialEmergencySyncWorldRebuild,
  loadEmergencySyncWorldCutoverJournal,
  loadEmergencySyncWorldRebuild,
  saveEmergencySyncWorldCutoverJournal,
  saveEmergencySyncWorldRebuild,
  updateEmergencySyncWorldRebuild,
} from './syncEmergencyWorldRebuildStore';
import {
  CURRENT_SNAPSHOT_CAPTURE_ADAPTER_IDS,
  indexCurrentSnapshotMutationSources,
  readValidatedCurrentSnapshotMutationPage,
  runNextSyncWorldBaselineBatch,
} from './syncNewWorldBaseline';
import {
  closeDedicatedSyncWorldDatabase,
  createExpoSyncWorldBaselineStore,
} from './syncNewWorldBaselineExpoStore';
import {
  NEW_WORLD_CURRENT_SECRET_KEY,
  NEW_WORLD_REBUILD_PENDING_SECRET_KEY,
  NEW_WORLD_REBUILD_ROLLBACK_SECRET_KEY,
  deleteNewWorldAndroidSecretSlot,
  generateNewWorldAndroidSecret,
  loadNewWorldAndroidSecretSlot,
  loadNewWorldAndroidStagingSecret,
  saveNewWorldAndroidSecretSlot,
  type NewWorldAndroidStagingSecretV1,
} from './syncNewWorldSecretsExpo';
import {
  createAndroidSyncRelayClient,
  loadCurrentSyncRelayEnrollment,
} from './syncRelayClientExpo';
import { archiveNewWorldRelayLocalStateForEmergencyRebuild, deleteArchivedNewWorldRelayLocalState } from './syncNewWorldRelayExpo';
import { assertPlainMutationV1, type PlainMutationV1 } from './syncProtocol';
import { LEGACY_SYNC_DATABASE_NAME, SYNC_WORLD_V2_DATABASE_NAME } from './syncWorld';
import { SYNC_TECHNICAL_RESET_MANIFEST } from './syncTechnicalReset';

type HeadRow = {
  mutation_json: string;
};

type CountRow = { count: number };

class EmergencyRebuildSnapshotChangedError extends Error {
  readonly code = 'rebuild.current-state-changed' as const;

  constructor() {
    super('手机当前业务状态在重建期间发生了变化。');
    this.name = 'EmergencyRebuildSnapshotChangedError';
  }
}

let rebuildFlight: Promise<EmergencySyncWorldRebuildV1> | null = null;
let rebuildSources: {
  identityKey: string;
  prepared: Awaited<ReturnType<typeof createRekeyedSources>>;
} | null = null;

function runSingleFlight(
  task: () => Promise<EmergencySyncWorldRebuildV1>,
) {
  if (rebuildFlight) return rebuildFlight;
  const operation = task();
  rebuildFlight = operation;
  operation.finally(() => {
    if (rebuildFlight === operation) rebuildFlight = null;
  }).catch(() => undefined);
  return operation;
}

function databaseUri(databaseName: string) {
  const directory = SQLite.defaultDatabaseDirectory.replace(/\/+$/u, '');
  return `${directory.startsWith('file://') ? '' : 'file://'}${directory}/${databaseName}`;
}

function semanticMutationDigest(mutation: PlainMutationV1) {
  return bytesToBase64Url(sha256BytesV1(canonicalizeJsonBytesV1({
    entity: mutation.entity,
    operation: mutation.revision.operation,
    schemaVersion: mutation.revision.schemaVersion,
    payload: mutation.payload,
    objectRefs: [...mutation.objectRefs].sort(),
  })));
}

function entityKey(mutation: PlainMutationV1) {
  return [
    mutation.entity.domain,
    mutation.entity.type,
    mutation.entity.id,
  ].join('\u0000');
}

function errorCode(error: unknown) {
  if (error instanceof EmergencyRebuildMissingObjectsError) return error.code;
  return 'rebuild.failed';
}

async function stagedDatabaseCounts(databaseName: string) {
  const database = await openInitializedSyncDatabase(
    '紧急重建暂存数据库版本高于当前应用，已停止切换。',
    databaseName,
  );
  try {
    const [objects, heads] = await Promise.all([
      database.getFirstAsync<CountRow>('SELECT COUNT(*) AS count FROM sync_object_jobs'),
      database.getFirstAsync<CountRow>('SELECT COUNT(*) AS count FROM sync_entity_heads'),
    ]);
    return { objects: objects?.count ?? 0, heads: heads?.count ?? 0 };
  } finally {
    await database.closeAsync();
  }
}

async function bestEffortRevokeOldPeerDevices(baseUrl: string) {
  if (!baseUrl.trim()) return 'relay-unreachable' as const;
  try {
    const enrollment = await loadCurrentSyncRelayEnrollment();
    if (!enrollment) return 'relay-unreachable' as const;
    const controller = new AndroidDeviceManagementController(
      createAndroidSyncRelayClient({ baseUrl }),
      async () => enrollment,
    );
    const directory = await controller.refreshDirectory();
    const peers = directory.devices.filter(
      (device) => !device.isCurrent && device.state === 'active',
    );
    let failures = 0;
    for (const peer of peers) {
      try {
        await controller.revokePeerDevice(peer.deviceId);
      } catch {
        failures += 1;
      }
    }
    return failures === 0 ? 'complete' as const : 'partial' as const;
  } catch {
    return 'relay-unreachable' as const;
  }
}

async function loadOrCreatePendingSecret(input: {
  state: EmergencySyncWorldRebuildV1;
  displayName: string;
}) {
  const existing = await loadNewWorldAndroidSecretSlot(
    NEW_WORLD_REBUILD_PENDING_SECRET_KEY,
  );
  if (existing) {
    if (
      input.state.newVaultId !== null
      && (
        existing.identity.vaultId !== input.state.newVaultId
        || existing.identity.keyId !== input.state.newKeyId
      )
    ) {
      throw new Error('待切换秘密与重建会话不一致。');
    }
    return existing;
  }
  if (input.state.newVaultId !== null) {
    throw new Error('重建会话已经登记新世界，但待切换秘密缺失。');
  }
  const created = await generateNewWorldAndroidSecret({
    displayName: input.displayName,
  });
  await saveNewWorldAndroidSecretSlot(
    NEW_WORLD_REBUILD_PENDING_SECRET_KEY,
    created,
  );
  return created;
}

async function createRekeyedSources(input: {
  oldSecret: NewWorldAndroidStagingSecretV1;
  newSecret: NewWorldAndroidStagingSecretV1;
  stagedDatabaseName: string;
}) {
  const objectSession = createEmergencyObjectRekeySession(input);
  return {
    objectSession,
    sources: objectSession.wrapSources(
      createAndroidCurrentSnapshotSources(input.newSecret, {
        previousDeviceId: input.oldSecret.identity.deviceId,
        nextDeviceId: input.newSecret.identity.deviceId,
      }),
    ),
  };
}

async function verifyStagedWorld(input: {
  stagedDatabaseName: string;
  oldSecret: NewWorldAndroidStagingSecretV1;
  newSecret: NewWorldAndroidStagingSecretV1;
}) {
  const direct = new Map<string, string>();
  const prepared = await createRekeyedSources(input);
  try {
    const indexed = indexCurrentSnapshotMutationSources(prepared.sources);
    for (const adapterId of CURRENT_SNAPSHOT_CAPTURE_ADAPTER_IDS) {
      const source = indexed.get(adapterId);
      if (!source) throw new Error(`重建核对缺少 ${adapterId} 读取器。`);
      let pageToken: string | null = null;
      do {
        const page = await readValidatedCurrentSnapshotMutationPage({
          source,
          pageToken,
          limit: 50,
        });
        for (const mutation of page.mutations) {
          const key = entityKey(mutation);
          if (direct.has(key)) throw new Error('当前业务状态出现重复实体。');
          direct.set(key, semanticMutationDigest(mutation));
        }
        pageToken = page.nextPageToken;
      } while (pageToken !== null);
    }
  } finally {
    await prepared.objectSession.close();
  }

  const database = await openInitializedSyncDatabase(
    '紧急重建暂存数据库版本高于当前应用，已停止切换。',
    input.stagedDatabaseName,
  );
  try {
    const quick = await database.getFirstAsync<{ quick_check: string }>(
      'PRAGMA quick_check',
    );
    if (quick?.quick_check !== 'ok') {
      throw new Error('紧急重建暂存数据库 quick_check 未通过。');
    }
    const rows = await database.getAllAsync<HeadRow>(
      `SELECT revision.mutation_json
       FROM sync_entity_heads AS head
       INNER JOIN sync_entity_revisions AS revision
         ON revision.revision_id = head.revision_id
       ORDER BY revision.domain, revision.entity_type, revision.entity_id`,
    );
    const staged = new Map<string, string>();
    for (const row of rows) {
      const parsed: unknown = JSON.parse(row.mutation_json);
      assertPlainMutationV1(parsed);
      if (
        parsed.vaultId !== input.newSecret.identity.vaultId
        || parsed.sourceDeviceId !== input.newSecret.identity.deviceId
        || parsed.revision.parents.length !== 0
      ) {
        throw new Error('紧急重建暂存库继承了旧世界身份或历史父 revision。');
      }
      const key = entityKey(parsed);
      if (staged.has(key)) throw new Error('紧急重建暂存库含多个 current head。');
      staged.set(key, semanticMutationDigest(parsed));
    }
    if (
      staged.size !== direct.size
      || [...direct].some(([key, digest]) => staged.get(key) !== digest)
    ) {
      throw new EmergencyRebuildSnapshotChangedError();
    }
    const [oldVaultRows, oldKeyJobs, inbox, conflicts, quarantine] = await Promise.all([
      database.getFirstAsync<CountRow>(
        'SELECT COUNT(*) AS count FROM sync_outbox WHERE vault_id <> ?',
        input.newSecret.identity.vaultId,
      ),
      database.getFirstAsync<CountRow>(
        'SELECT COUNT(*) AS count FROM sync_object_jobs WHERE key_id <> ?',
        input.newSecret.identity.keyId,
      ),
      database.getFirstAsync<CountRow>('SELECT COUNT(*) AS count FROM sync_inbox'),
      database.getFirstAsync<CountRow>('SELECT COUNT(*) AS count FROM sync_entity_conflicts'),
      database.getFirstAsync<CountRow>('SELECT COUNT(*) AS count FROM sync_quarantine'),
    ]);
    if (
      (oldVaultRows?.count ?? 0) > 0
      || (oldKeyJobs?.count ?? 0) > 0
      || (inbox?.count ?? 0) > 0
      || (conflicts?.count ?? 0) > 0
      || (quarantine?.count ?? 0) > 0
    ) {
      throw new Error('紧急重建暂存库混入了旧世界或接收历史。');
    }
    await database.execAsync('PRAGMA wal_checkpoint(TRUNCATE);');
    return { entityCount: staged.size };
  } finally {
    await database.closeAsync();
  }
}

async function fileExists(uri: string) {
  return (await FileSystem.getInfoAsync(uri)).exists;
}

async function moveDatabaseBundle(source: string, destination: string) {
  for (const suffix of ['', '-wal', '-shm'] as const) {
    const from = `${source}${suffix}`;
    const to = `${destination}${suffix}`;
    const [fromExists, toExists] = await Promise.all([
      fileExists(from),
      fileExists(to),
    ]);
    if (fromExists && toExists) {
      throw new Error('紧急切换数据库源文件与目标文件同时存在，拒绝覆盖。');
    }
    if (fromExists) {
      await FileSystem.moveAsync({ from, to });
      if (!await fileExists(to) || await fileExists(from)) {
        throw new Error('紧急切换数据库移动没有完整落盘。');
      }
    } else if (!toExists && suffix === '') {
      throw new Error('紧急切换所需数据库文件不存在。');
    }
  }
}

async function deleteDatabaseBundle(databaseName: string) {
  const source = databaseUri(databaseName);
  for (const suffix of ['', '-wal', '-shm', '-journal'] as const) {
    await FileSystem.deleteAsync(`${source}${suffix}`, { idempotent: true });
  }
}

async function verifyActivatedWorld(
  journal: EmergencySyncWorldCutoverJournalV1,
) {
  const current = await loadNewWorldAndroidStagingSecret();
  if (
    !current
    || current.identity.vaultId !== journal.expectedNewVaultId
    || current.identity.keyId !== journal.expectedNewKeyId
  ) {
    throw new Error('新世界安全存储回读不一致。');
  }
  const database = await openInitializedSyncDatabase(
    '切换后的同步数据库版本高于当前应用，已停止启动。',
  );
  try {
    const identity = await database.getFirstAsync<{
      vault_id: string;
      key_id: string;
      state: string;
    }>(
      `SELECT vault_id, key_id, state FROM sync_device_state
       WHERE device_id = ?`,
      current.identity.deviceId,
    );
    if (
      !identity
      || identity.vault_id !== current.identity.vaultId
      || identity.key_id !== current.identity.keyId
      || identity.state !== 'active'
    ) {
      throw new Error('切换后的数据库与现役安全存储身份不一致。');
    }
  } finally {
    await database.closeAsync();
  }
  await rebindEmergencyAndroidLocalObjectReferences(current);
  await activateAndroidNewWorldLiveCapture({ identity: current.identity });
}

async function resumeCutover(
  initial: EmergencySyncWorldCutoverJournalV1,
) {
  const activeUri = databaseUri(initial.activeDatabaseName);
  const stagedUri = databaseUri(initial.stagedDatabaseName);
  const rollbackUri = databaseUri(initial.rollbackDatabaseName);
  await resumeEmergencyWorldCutover(initial, {
    closeConnections: async () => {
      await closeAllActiveSyncWorldDatabases();
      await closeDedicatedSyncWorldDatabase(initial.stagedDatabaseName);
    },
    moveOldDatabaseToRollback: () => moveDatabaseBundle(
      activeUri,
      rollbackUri,
    ),
    activateStagedDatabase: () => moveDatabaseBundle(
      stagedUri,
      activeUri,
    ),
    activatePendingSecret: async () => {
      const [current, pending, rollback] = await Promise.all([
        loadNewWorldAndroidSecretSlot(NEW_WORLD_CURRENT_SECRET_KEY),
        loadNewWorldAndroidSecretSlot(NEW_WORLD_REBUILD_PENDING_SECRET_KEY),
        loadNewWorldAndroidSecretSlot(NEW_WORLD_REBUILD_ROLLBACK_SECRET_KEY),
      ]);
      if (!pending) throw new Error('待切换新世界秘密缺失。');
      if (
        pending.identity.vaultId !== initial.expectedNewVaultId
        || pending.identity.keyId !== initial.expectedNewKeyId
      ) {
        throw new Error('待切换新世界秘密不属于切换日志。');
      }
      const previous = current?.identity.vaultId === initial.expectedNewVaultId
        ? rollback : current;
      if (!previous) throw new Error('旧世界现役秘密缺失，无法接回审核归属。');
      // Retain the immediately preceding identity in the existing rollback
      // slot, including a second rebuild or an interrupted secret activation.
      if (current?.identity.vaultId !== initial.expectedNewVaultId) {
        await saveNewWorldAndroidSecretSlot(NEW_WORLD_REBUILD_ROLLBACK_SECRET_KEY, previous);
      }
      const memoryDatabase = await SQLite.openDatabaseAsync('junluo-memory.db', { useNewConnection: true });
      try {
        await rebindPostReviewOwnerForNewWorld(memoryDatabase, {
          previousDeviceId: previous.identity.deviceId,
          nextDeviceId: pending.identity.deviceId,
        });
      } finally {
        await memoryDatabase.closeAsync();
      }
      // The verified baseline already owns the current business state. Retire
      // old-world domain packets and capture bindings before activating the
      // new identity; each existing reset transaction is safe to repeat.
      await resetAndroidNewWorldTechnicalState(
        SYNC_TECHNICAL_RESET_MANIFEST.map(entry => entry.databaseId),
      );
      await archiveNewWorldRelayLocalStateForEmergencyRebuild(
        initial.sessionId,
      );
      await saveNewWorldAndroidSecretSlot(NEW_WORLD_CURRENT_SECRET_KEY, pending);
    },
    verifyActivatedWorld: () => verifyActivatedWorld(initial),
    completeCutover: async () => {
      // This runs only after the verified journal checkpoint. Keep no retired
      // packet ledger once the current phone state has become the active world.
      await deleteDatabaseBundle(initial.rollbackDatabaseName);
      await deleteDatabaseBundle(LEGACY_SYNC_DATABASE_NAME);
      await deleteDatabaseBundle('junluo-sync-v2.retention-rollback-20260812.db');
      await deleteNewWorldAndroidSecretSlot(NEW_WORLD_REBUILD_ROLLBACK_SECRET_KEY);
      await deleteArchivedNewWorldRelayLocalState(initial.sessionId);
      await deleteNewWorldAndroidSecretSlot(
        NEW_WORLD_REBUILD_PENDING_SECRET_KEY,
      );
      await updateEmergencySyncWorldRebuild((state) => Object.freeze({
        ...state,
        phase: 'complete',
        completedAdapters: EMERGENCY_WORLD_REBUILD_ADAPTER_TOTAL,
        completedFiles: state.totalFiles,
        missingFiles: 0,
        lastErrorCode: null,
        updatedAt: Date.now(),
      }));
      await clearEmergencySyncWorldCutoverJournal();
    },
    saveJournal: async (journal) => {
      await saveEmergencySyncWorldCutoverJournal(journal);
    },
    now: Date.now,
  });
}

export async function recoverEmergencySyncWorldCutover() {
  const journal = await loadEmergencySyncWorldCutoverJournal();
  if (!journal) return false;
  await runBackupRestoreExclusive(() => enqueueAndroidExplicitSyncOperation(
    () => resumeCutover(journal),
  ));
  return true;
}

async function begin(input: {
  baseUrl: string;
  displayName: string;
}) {
  const existing = await loadEmergencySyncWorldRebuild();
  if (existing && existing.phase !== 'complete') {
    await clearBackupRestoreSyncGate();
    return existing;
  }
  const current = await loadNewWorldAndroidStagingSecret();
  if (!current) throw new Error('手机当前没有可重建的新世界身份。');
  const sessionId = await expoSyncRandomUuidV1();
  let state = createInitialEmergencySyncWorldRebuild({
    sessionId,
    oldVaultId: current.identity.vaultId,
    oldKeyId: current.identity.keyId,
    now: Date.now(),
  });
  await saveEmergencySyncWorldRebuild(state);
  await clearBackupRestoreSyncGate();
  await resetAutomaticDataSyncPolicy();
  await unregisterAutomaticDataSyncBackgroundTask().catch(() => undefined);
  const revocation = await bestEffortRevokeOldPeerDevices(input.baseUrl);
  state = await updateEmergencySyncWorldRebuild((value) => Object.freeze({
    ...value,
    phase: 'revoking-old-devices',
    oldDeviceRevocation: revocation,
    updatedAt: Date.now(),
  }));
  const pending = await loadOrCreatePendingSecret({
    state,
    displayName: input.displayName,
  });
  state = await updateEmergencySyncWorldRebuild((value) => Object.freeze({
    ...value,
    phase: 'preparing-current-state',
    newVaultId: pending.identity.vaultId,
    newKeyId: pending.identity.keyId,
    updatedAt: Date.now(),
  }));
  const databaseName = emergencyRebuildDatabaseName(sessionId);
  await createExpoSyncWorldBaselineStore({ databaseName }).initialize({
    world: pending.world,
    identity: pending.identity,
    createdAt: Date.now(),
  });
  return state;
}

async function continueRebuild(input: {
  displayName: string;
}) {
  const state = await loadEmergencySyncWorldRebuild();
  if (!state) throw new Error('紧急重建会话不存在。');
  if (state.phase === 'complete') return state;
  const journal = await loadEmergencySyncWorldCutoverJournal();
  if (journal) {
    await resumeCutover(journal);
    return (await loadEmergencySyncWorldRebuild())!;
  }
  const oldSecret = await loadNewWorldAndroidSecretSlot(
    NEW_WORLD_CURRENT_SECRET_KEY,
  );
  const newSecret = await loadOrCreatePendingSecret({ state, displayName: input.displayName });
  if (!oldSecret) throw new Error('旧世界现役秘密缺失，已停止重建。');
  const stagedDatabaseName = emergencyRebuildDatabaseName(state.sessionId);
  const baselineStore = createExpoSyncWorldBaselineStore({ databaseName: stagedDatabaseName });
  await baselineStore.initialize({
    world: newSecret.world,
    identity: newSecret.identity,
    createdAt: newSecret.createdAt,
  });
  const identityKey = [
    stagedDatabaseName,
    oldSecret.identity.deviceId,
    oldSecret.identity.keyId,
    newSecret.identity.deviceId,
    newSecret.identity.keyId,
  ].join(':');
  if (rebuildSources?.identityKey !== identityKey) {
    rebuildSources = {
      identityKey,
      prepared: await createRekeyedSources({ oldSecret, newSecret, stagedDatabaseName }),
    };
  }
  const prepared = rebuildSources.prepared;
  try {
    const checkpoint = await runNextSyncWorldBaselineBatch({
      sources: prepared.sources,
      store: baselineStore,
      identity: newSecret.identity,
      randomUuid: expoSyncRandomUuidV1,
      pageLimit: 50,
    });
    const counts = await stagedDatabaseCounts(stagedDatabaseName);
    let next = await updateEmergencySyncWorldRebuild((value) => Object.freeze({
      ...value,
      phase: checkpoint.state === 'complete'
        ? 'verifying-current-state'
        : 'preparing-current-state',
      completedAdapters: checkpoint.adapterIndex,
      completedFiles: counts.objects,
      totalFiles: Math.max(value.totalFiles, counts.objects),
      missingFiles: 0,
      lastErrorCode: null,
      updatedAt: Date.now(),
    }));
    if (checkpoint.state !== 'complete') return next;
    await prepared.objectSession.close();
    await closeDedicatedSyncWorldDatabase(stagedDatabaseName);
    await verifyStagedWorld({ stagedDatabaseName, oldSecret, newSecret });
    const finalCounts = await stagedDatabaseCounts(stagedDatabaseName);
    next = await updateEmergencySyncWorldRebuild((value) => Object.freeze({
      ...value,
      phase: 'cutting-over',
      completedAdapters: EMERGENCY_WORLD_REBUILD_ADAPTER_TOTAL,
      completedFiles: finalCounts.objects,
      totalFiles: finalCounts.objects,
      missingFiles: 0,
      updatedAt: Date.now(),
    }));
    const cutover: EmergencySyncWorldCutoverJournalV1 = Object.freeze({
      version: 1,
      sessionId: state.sessionId,
      stage: 'prepared',
      activeDatabaseName: SYNC_WORLD_V2_DATABASE_NAME,
      stagedDatabaseName,
      rollbackDatabaseName: emergencyRollbackDatabaseName(state.sessionId),
      expectedNewVaultId: newSecret.identity.vaultId,
      expectedNewKeyId: newSecret.identity.keyId,
      updatedAt: Date.now(),
    });
    await saveEmergencySyncWorldCutoverJournal(cutover);
    await resumeCutover(cutover);
    rebuildSources = null;
    return (await loadEmergencySyncWorldRebuild()) ?? next;
  } catch (error) {
    if (error instanceof EmergencyRebuildSnapshotChangedError) {
      rebuildSources = null;
      await closeDedicatedSyncWorldDatabase(stagedDatabaseName)
        .catch(() => undefined);
      await deleteDatabaseBundle(stagedDatabaseName);
      return updateEmergencySyncWorldRebuild((value) => Object.freeze({
        ...value,
        phase: 'preparing-current-state',
        completedAdapters: 0,
        completedFiles: 0,
        totalFiles: 0,
        missingFiles: 0,
        lastErrorCode: null,
        updatedAt: Date.now(),
      }));
    }
    const missing = error instanceof EmergencyRebuildMissingObjectsError
      ? error.missingCount
      : 0;
    rebuildSources = null;
    await updateEmergencySyncWorldRebuild((value) => Object.freeze({
      ...value,
      phase: 'blocked',
      missingFiles: missing,
      totalFiles: Math.max(value.totalFiles, value.completedFiles + missing),
      lastErrorCode: errorCode(error),
      updatedAt: Date.now(),
    }));
    throw error;
  } finally {
    await prepared.objectSession.close().catch(() => undefined);
  }
}

export function startEmergencySyncWorldRebuild(input: {
  baseUrl: string;
  displayName?: string;
}) {
  return runSingleFlight(() => runBackupRestoreExclusive(
    () => enqueueAndroidExplicitSyncOperation(
      async () => {
        await begin({
          baseUrl: input.baseUrl,
          displayName: input.displayName ?? '手机',
        });
        return continueRebuild({
          displayName: input.displayName ?? '手机',
        });
      },
    ),
  ));
}

export function continueEmergencySyncWorldRebuild(input: {
  displayName?: string;
} = {}) {
  return runSingleFlight(() => runBackupRestoreExclusive(
    () => enqueueAndroidExplicitSyncOperation(
      () => continueRebuild({
        displayName: input.displayName ?? '手机',
      }),
    ),
  ));
}
