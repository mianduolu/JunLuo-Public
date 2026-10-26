import * as SQLite from 'expo-sqlite';

import type { PlainMutationV1 } from './syncProtocol';
import type { SyncDurableIntent } from './syncRecoveryIntent';
import { SYNC_DATABASE_NAME } from './syncSchema';
import {
  acknowledgeSyncOutbox,
  advanceSyncDurableIntent,
  claimSyncOutboxBatch,
  closeSyncDatabaseForTests,
  enqueueSyncMutation,
  initializeSyncStore,
  prepareSyncDurableIntent,
  type SyncStoreStartupRecovery,
} from './syncStore';

const PROBE_ID = 'redmi-sync-persistence-v1';
const PROBE_MUTATION_ID = 'f1000000-0000-4000-8000-000000000001';
const PROBE_OPERATION_ID = 'f1000000-0000-4000-8000-000000000002';
const PROBE_VAULT_ID = 'f1000000-0000-4000-8000-000000000003';
const PROBE_DEVICE_ID = 'f1000000-0000-4000-8000-000000000004';
const PROBE_REVISION_ID = 'f1000000-0000-4000-8000-000000000005';
const FIRST_LEASE_ID = 'redmi-sync-probe-before-restart';
const SECOND_LEASE_ID = 'redmi-sync-probe-after-restart';
const PROBE_LEASE_DURATION_MS = 1_000;

let persistenceProbePromise: Promise<void> | undefined;

type CountRow = { count: number };
type ProbePhaseRow = { phase: number; phase_at: number };
type StateRow = { state: string };

function expectProbe(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[sync-persistence-probe] ${message}`);
}

function createProbeMutation(createdAt: number): PlainMutationV1 {
  return {
    protocolVersion: 1,
    mutationId: PROBE_MUTATION_ID,
    vaultId: PROBE_VAULT_ID,
    sourceDeviceId: PROBE_DEVICE_ID,
    sourceSequence: 9_000_000_001,
    createdAt,
    entity: {
      domain: 'sync-probe',
      type: 'runtime-durability',
      id: PROBE_ID,
    },
    revision: {
      id: PROBE_REVISION_ID,
      parents: [],
      operation: 'upsert',
      schemaVersion: 1,
    },
    sensitivity: 'private',
    payload: {
      role: 'I',
      probe: 'redmi-persistence',
    },
    objectRefs: [],
    retentionClass: 'ordinary',
  };
}

function createProbeIntent(createdAt: number): SyncDurableIntent {
  return {
    operationId: PROBE_OPERATION_ID,
    adapterId: 'sync-probe.runtime-durability',
    intent: {
      role: 'I',
      probe: 'restart-recovery',
    },
    state: 'prepared',
    createdAt,
    updatedAt: createdAt,
  };
}

async function openProbeConnection() {
  return SQLite.openDatabaseAsync(SYNC_DATABASE_NAME, { useNewConnection: true });
}

async function prepareProbeMetadata() {
  const database = await openProbeConnection();
  try {
    await database.execAsync(`
      CREATE TABLE IF NOT EXISTS sync_persistence_probe_meta (
        probe_id TEXT PRIMARY KEY NOT NULL,
        phase INTEGER NOT NULL,
        phase_at INTEGER NOT NULL
      );
    `);
    return await database.getFirstAsync<ProbePhaseRow>(
      'SELECT phase, phase_at FROM sync_persistence_probe_meta WHERE probe_id = ?',
      PROBE_ID,
    );
  } finally {
    await database.closeAsync();
  }
}

async function assertProductionSyncTablesAreEmpty() {
  const database = await openProbeConnection();
  try {
    const outbox = await database.getFirstAsync<CountRow>(
      'SELECT COUNT(*) AS count FROM sync_outbox',
    );
    const intents = await database.getFirstAsync<CountRow>(
      'SELECT COUNT(*) AS count FROM sync_durable_intents',
    );
    expectProbe(
      (outbox?.count ?? -1) === 0 && (intents?.count ?? -1) === 0,
      '同步库已有正式队列或 durable intent，探针拒绝运行。',
    );
  } finally {
    await database.closeAsync();
  }
}

async function resetInterruptedProbeIfSafe() {
  const database = await openProbeConnection();
  let hasProbeResidue = false;
  try {
    const otherOutbox = await database.getFirstAsync<CountRow>(
      'SELECT COUNT(*) AS count FROM sync_outbox WHERE mutation_id != ?',
      PROBE_MUTATION_ID,
    );
    const otherIntents = await database.getFirstAsync<CountRow>(
      'SELECT COUNT(*) AS count FROM sync_durable_intents WHERE operation_id != ?',
      PROBE_OPERATION_ID,
    );
    expectProbe(
      (otherOutbox?.count ?? -1) === 0 && (otherIntents?.count ?? -1) === 0,
      '同步库存在非探针记录，拒绝自动清理。',
    );
    const probeOutbox = await database.getFirstAsync<CountRow>(
      'SELECT COUNT(*) AS count FROM sync_outbox WHERE mutation_id = ?',
      PROBE_MUTATION_ID,
    );
    const probeIntents = await database.getFirstAsync<CountRow>(
      'SELECT COUNT(*) AS count FROM sync_durable_intents WHERE operation_id = ?',
      PROBE_OPERATION_ID,
    );
    expectProbe(
      (probeOutbox?.count ?? -1) <= 1 && (probeIntents?.count ?? -1) <= 1,
      '固定探针 ID 出现重复记录，拒绝自动清理。',
    );
    hasProbeResidue = (probeOutbox?.count ?? 0) + (probeIntents?.count ?? 0) > 0;
  } finally {
    await database.closeAsync();
  }
  if (!hasProbeResidue) return;
  await cleanupProbeRows();
  await initializeSyncStore();
  await prepareProbeMetadata();
}

async function markPhaseOneComplete(phaseAt: number) {
  const database = await openProbeConnection();
  try {
    await database.runAsync(
      `INSERT INTO sync_persistence_probe_meta (probe_id, phase, phase_at)
       VALUES (?, 1, ?)`,
      PROBE_ID,
      phaseAt,
    );
  } finally {
    await database.closeAsync();
  }
}

async function runPhaseOne() {
  await assertProductionSyncTablesAreEmpty();
  const now = Date.now();
  await enqueueSyncMutation(createProbeMutation(now));
  const claimed = await claimSyncOutboxBatch({
    leaseId: FIRST_LEASE_ID,
    now,
    limit: 1,
    leaseDurationMs: PROBE_LEASE_DURATION_MS,
  });
  expectProbe(
    claimed.length === 1 && claimed[0]?.mutation.mutationId === PROBE_MUTATION_ID,
    '首次启动没有领取到探针 outbox。',
  );

  await prepareSyncDurableIntent(createProbeIntent(now));
  await advanceSyncDurableIntent({
    operationId: PROBE_OPERATION_ID,
    from: 'prepared',
    to: 'business_written',
    updatedAt: now + 1,
  });
  await closeSyncDatabaseForTests();
  await markPhaseOneComplete(now);
  console.info('[sync-persistence-probe] PHASE1_READY');
}

async function cleanupProbeRows() {
  await closeSyncDatabaseForTests();
  const database = await openProbeConnection();
  try {
    await database.withExclusiveTransactionAsync(async (transaction) => {
      await transaction.runAsync(
        'DELETE FROM sync_outbox WHERE mutation_id = ?',
        PROBE_MUTATION_ID,
      );
      await transaction.runAsync(
        'DELETE FROM sync_durable_intents WHERE operation_id = ?',
        PROBE_OPERATION_ID,
      );
      await transaction.runAsync(
        'DELETE FROM sync_persistence_probe_meta WHERE probe_id = ?',
        PROBE_ID,
      );
      await transaction.execAsync('DROP TABLE IF EXISTS sync_persistence_probe_meta');
    });
  } finally {
    await database.closeAsync();
  }
}

async function loadProbeOutboxState() {
  const database = await openProbeConnection();
  try {
    return await database.getFirstAsync<StateRow>(
      'SELECT state FROM sync_outbox WHERE mutation_id = ?',
      PROBE_MUTATION_ID,
    );
  } finally {
    await database.closeAsync();
  }
}

async function runPhaseTwo(
  phase: ProbePhaseRow,
  startupRecovery: SyncStoreStartupRecovery,
) {
  const now = Date.now();
  expectProbe(
    now >= phase.phase_at + PROBE_LEASE_DURATION_MS,
    '第二阶段启动得太早，旧租约尚未过期。',
  );
  if (startupRecovery.releasedOutboxLeaseCount === 0) {
    const outbox = await loadProbeOutboxState();
    if (outbox?.state === 'pending') {
      await cleanupProbeRows();
      await initializeSyncStore();
      await runPhaseOne();
      return;
    }
  }
  expectProbe(
    startupRecovery.releasedOutboxLeaseCount === 1,
    '进程重启后没有恰好释放一个过期 outbox 租约。',
  );
  expectProbe(
    startupRecovery.incompleteDurableIntents.some(
      (intent) => intent.operationId === PROBE_OPERATION_ID
        && intent.state === 'business_written',
    ),
    '进程重启后没有恢复 business_written durable intent。',
  );

  const claimed = await claimSyncOutboxBatch({
    leaseId: SECOND_LEASE_ID,
    now,
    limit: 1,
  });
  expectProbe(
    claimed.length === 1
      && claimed[0]?.mutation.mutationId === PROBE_MUTATION_ID
      && claimed[0]?.attemptCount === 0,
    '过期租约释放后没有重新领取到原 outbox。',
  );
  await acknowledgeSyncOutbox(SECOND_LEASE_ID, [PROBE_MUTATION_ID], now + 1);
  await advanceSyncDurableIntent({
    operationId: PROBE_OPERATION_ID,
    from: 'business_written',
    to: 'captured',
    updatedAt: now + 2,
  });

  const database = await openProbeConnection();
  try {
    const outbox = await database.getFirstAsync<StateRow>(
      'SELECT state FROM sync_outbox WHERE mutation_id = ?',
      PROBE_MUTATION_ID,
    );
    const intent = await database.getFirstAsync<StateRow>(
      'SELECT state FROM sync_durable_intents WHERE operation_id = ?',
      PROBE_OPERATION_ID,
    );
    expectProbe(outbox?.state === 'acked', '重启后的 outbox 未持久化为 acked。');
    expectProbe(intent?.state === 'captured', '重启后的 durable intent 未持久化为 captured。');
  } finally {
    await database.closeAsync();
  }

  await cleanupProbeRows();
  await initializeSyncStore();
  console.info('[sync-persistence-probe] PASS');
}

async function runSyncStorePersistenceProbeInternal(
  startupRecovery: SyncStoreStartupRecovery,
) {
  const phase = await prepareProbeMetadata();
  if (!phase) {
    await resetInterruptedProbeIfSafe();
    await runPhaseOne();
    return;
  }
  expectProbe(phase.phase === 1, `未知探针阶段 ${phase.phase}。`);
  await runPhaseTwo(phase, startupRecovery);
}

export function runSyncStorePersistenceProbe(
  startupRecovery: SyncStoreStartupRecovery,
) {
  if (!persistenceProbePromise) {
    persistenceProbePromise = runSyncStorePersistenceProbeInternal(startupRecovery);
  }
  return persistenceProbePromise;
}
