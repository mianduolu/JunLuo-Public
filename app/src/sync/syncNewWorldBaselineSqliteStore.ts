import {
  assertSyncDevicePublicIdentityV1,
  assertSyncUuidV4,
  type SyncDevicePublicIdentityV1,
} from './syncDeviceContract';
import {
  CURRENT_SNAPSHOT_CAPTURE_ADAPTER_IDS,
  type SyncWorldBaselineCheckpointV1,
  type SyncWorldBaselineStoreV1,
} from './syncNewWorldBaseline';
import {
  CURRENT_SNAPSHOT_PLAN,
} from './syncCurrentSnapshot';
import {
  assertPlainMutationV1,
  type PlainMutationV1,
} from './syncProtocol';
import {
  assertSyncWorldDescriptorV2,
  type SyncWorldDescriptorV2,
} from './syncWorld';

export const NEW_WORLD_BASELINE_OPERATION_ID =
  'junluo.sync.v2.current-baseline' as const;

export interface SyncWorldBaselineSqliteQueryPort {
  getFirstAsync<T>(source: string, ...parameters: unknown[]): Promise<T | null>;
  runAsync(
    source: string,
    ...parameters: unknown[]
  ): Promise<{ changes: number }>;
}

export interface SyncWorldBaselineSqliteDatabasePort
extends SyncWorldBaselineSqliteQueryPort {
  withTransaction(
    task: (transaction: SyncWorldBaselineSqliteQueryPort) => Promise<void>,
  ): Promise<void>;
}

type DurableIntentRow = {
  intent_json: string;
  state: 'prepared' | 'business_written' | 'captured';
  updated_at: number;
};

type CountRow = { count: number };

function assertTimestamp(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} must be a non-negative timestamp`);
  }
}

export function parseSyncWorldBaselineCheckpoint(
  raw: string,
): SyncWorldBaselineCheckpointV1 {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('new-world baseline checkpoint is not valid JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('new-world baseline checkpoint must be an object');
  }
  const record = value as Record<string, unknown>;
  const expected = [
    'version',
    'world',
    'deviceId',
    'adapterIndex',
    'adapterId',
    'pageToken',
    'mutationCount',
    'state',
    'updatedAt',
  ];
  if (
    Object.keys(record).some((key) => !expected.includes(key))
    || expected.some((key) => !(key in record))
  ) {
    throw new Error('new-world baseline checkpoint fields do not match v1');
  }
  if (record.version !== 1) {
    throw new Error('new-world baseline checkpoint version is unsupported');
  }
  assertSyncWorldDescriptorV2(record.world);
  assertSyncUuidV4(record.deviceId, 'new-world baseline deviceId');
  const adapterIndex = Number(record.adapterIndex);
  if (
    !Number.isSafeInteger(record.adapterIndex)
    || adapterIndex < 0
    || adapterIndex > CURRENT_SNAPSHOT_PLAN.length
  ) {
    throw new Error('new-world baseline adapter index is invalid');
  }
  // The completed pre-gift catalog ended at 35; keep that marker unchanged.
  const isCurrentOrRetiredCatalogCompletion = record.state === 'complete'
    && (adapterIndex === 35 || adapterIndex >= CURRENT_SNAPSHOT_CAPTURE_ADAPTER_IDS.length)
    && record.adapterId === null
    && record.pageToken === null;
  const expectedAdapterId = CURRENT_SNAPSHOT_CAPTURE_ADAPTER_IDS[
    adapterIndex
  ] ?? null;
  if (!isCurrentOrRetiredCatalogCompletion && record.adapterId !== expectedAdapterId) {
    throw new Error('new-world baseline adapter checkpoint is inconsistent');
  }
  if (
    record.pageToken !== null
    && (
      typeof record.pageToken !== 'string'
      || record.pageToken.length < 1
      || record.pageToken.length > 2_048
    )
  ) {
    throw new Error('new-world baseline page token is invalid');
  }
  if (
    !Number.isSafeInteger(record.mutationCount)
    || Number(record.mutationCount) < 0
  ) {
    throw new Error('new-world baseline mutation count is invalid');
  }
  if (record.state !== 'staging' && record.state !== 'complete') {
    throw new Error('new-world baseline state is invalid');
  }
  const isCurrentCatalogStaging = record.state === 'staging'
    && adapterIndex < CURRENT_SNAPSHOT_CAPTURE_ADAPTER_IDS.length;
  if (!isCurrentOrRetiredCatalogCompletion && !isCurrentCatalogStaging) {
    throw new Error('new-world baseline completion marker is inconsistent');
  }
  assertTimestamp(record.updatedAt, 'new-world baseline updatedAt');
  return record as SyncWorldBaselineCheckpointV1;
}

function sameCheckpoint(
  left: SyncWorldBaselineCheckpointV1,
  right: SyncWorldBaselineCheckpointV1,
) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function loadCheckpointFrom(
  database: SyncWorldBaselineSqliteQueryPort,
) {
  const row = await database.getFirstAsync<DurableIntentRow>(
    `SELECT intent_json, state, updated_at
     FROM sync_durable_intents
     WHERE operation_id = ?`,
    NEW_WORLD_BASELINE_OPERATION_ID,
  );
  if (!row) return null;
  // Only the retired catalog's exact slot or stable following adapter can move.
  // Keep pages and the operation's stored phase; a normal commit writes the new position.
  const stored = JSON.parse(row.intent_json) as Record<string, unknown> | null;
  if (stored?.version === 1) {
    const oldIndex = stored.adapterIndex;
    if (stored.state === 'staging' && Number.isSafeInteger(oldIndex)) {
      if (oldIndex === 9 && stored.adapterId === 'behavior.current-action') {
        stored.adapterId = CURRENT_SNAPSHOT_CAPTURE_ADAPTER_IDS[9];
        stored.pageToken = null;
      } else if (
        Number(oldIndex) > 9 && Number(oldIndex) < 36
        && CURRENT_SNAPSHOT_CAPTURE_ADAPTER_IDS[Number(oldIndex)] !== stored.adapterId
        && CURRENT_SNAPSHOT_CAPTURE_ADAPTER_IDS[Number(oldIndex) - 1] === stored.adapterId
      ) {
        stored.adapterIndex = Number(oldIndex) - 1;
      }
    }
  }
  const checkpoint = parseSyncWorldBaselineCheckpoint(JSON.stringify(stored));
  const expectedIntentState = checkpoint.state === 'complete'
    ? 'captured'
    : 'prepared';
  if (
    row.state !== expectedIntentState
    || row.updated_at !== checkpoint.updatedAt
  ) {
    throw new Error('new-world baseline durable checkpoint is inconsistent');
  }
  return checkpoint;
}

function buildInitialCheckpoint(input: {
  world: SyncWorldDescriptorV2;
  identity: SyncDevicePublicIdentityV1;
  createdAt: number;
}): SyncWorldBaselineCheckpointV1 {
  return Object.freeze({
    version: 1,
    world: input.world,
    deviceId: input.identity.deviceId,
    adapterIndex: 0,
    adapterId: CURRENT_SNAPSHOT_CAPTURE_ADAPTER_IDS[0] ?? null,
    pageToken: null,
    mutationCount: 0,
    state: 'staging',
    updatedAt: input.createdAt,
  });
}

function assertIdentityMatchesWorld(input: {
  world: SyncWorldDescriptorV2;
  identity: SyncDevicePublicIdentityV1;
}) {
  assertSyncWorldDescriptorV2(input.world);
  assertSyncDevicePublicIdentityV1(input.identity);
  if (
    input.identity.state !== 'active'
    || input.identity.revokedAt !== null
    || input.identity.platform !== 'android'
    || input.identity.vaultId !== input.world.vaultId
    || input.identity.keyId !== input.world.keyId
  ) {
    throw new Error('new-world baseline requires its fresh active Android identity');
  }
}

function buildBaselineMutation(input: {
  template: PlainMutationV1;
  identity: SyncDevicePublicIdentityV1;
  sourceSequence: number;
  mutationId: string;
  revisionId: string;
  createdAt: number;
}) {
  const mutation: PlainMutationV1 = {
    ...input.template,
    mutationId: input.mutationId,
    vaultId: input.identity.vaultId,
    sourceDeviceId: input.identity.deviceId,
    sourceSequence: input.sourceSequence,
    createdAt: input.createdAt,
    revision: {
      ...input.template.revision,
      id: input.revisionId,
      parents: [],
    },
  };
  assertPlainMutationV1(mutation);
  return mutation;
}

async function insertBaselineMutation(
  transaction: SyncWorldBaselineSqliteQueryPort,
  mutation: PlainMutationV1,
  now: number,
) {
  const serialized = JSON.stringify(mutation);
  const existingHead = await transaction.getFirstAsync<{ revision_id: string }>(
    `SELECT revision_id FROM sync_entity_heads
     WHERE domain = ? AND entity_type = ? AND entity_id = ?
     LIMIT 1`,
    mutation.entity.domain,
    mutation.entity.type,
    mutation.entity.id,
  );
  if (existingHead) {
    throw new Error('new-world baseline emitted the same current entity twice');
  }
  await transaction.runAsync(
    `INSERT INTO sync_outbox (
       mutation_id, vault_id, source_device_id, source_sequence,
       mutation_json, state, attempt_count, available_at,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
    mutation.mutationId,
    mutation.vaultId,
    mutation.sourceDeviceId,
    mutation.sourceSequence,
    serialized,
    now,
    now,
    now,
  );
  await transaction.runAsync(
    `INSERT INTO sync_entity_revisions (
       revision_id, mutation_id, domain, entity_type, entity_id,
       parents_json, operation, schema_version, mutation_json,
       source_device_id, source_sequence, created_at
     ) VALUES (?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?)`,
    mutation.revision.id,
    mutation.mutationId,
    mutation.entity.domain,
    mutation.entity.type,
    mutation.entity.id,
    mutation.revision.operation,
    mutation.revision.schemaVersion,
    serialized,
    mutation.sourceDeviceId,
    mutation.sourceSequence,
    mutation.createdAt,
  );
  await transaction.runAsync(
    `INSERT INTO sync_entity_heads (
       domain, entity_type, entity_id, revision_id, updated_at
     ) VALUES (?, ?, ?, ?, ?)`,
    mutation.entity.domain,
    mutation.entity.type,
    mutation.entity.id,
    mutation.revision.id,
    now,
  );
  for (const objectId of mutation.objectRefs) {
    await transaction.runAsync(
      `INSERT INTO sync_revision_object_refs (revision_id, object_id)
       VALUES (?, ?)`,
      mutation.revision.id,
      objectId,
    );
  }
}

export function createSyncWorldBaselineSqliteStore(input: {
  getDatabase(): Promise<SyncWorldBaselineSqliteDatabasePort>;
}): SyncWorldBaselineStoreV1 {
  return {
    loadCheckpoint: async () => loadCheckpointFrom(await input.getDatabase()),
    initialize: async ({ world, identity, createdAt }) => {
      assertTimestamp(createdAt, 'new-world baseline createdAt');
      assertIdentityMatchesWorld({ world, identity });
      const database = await input.getDatabase();
      let result: SyncWorldBaselineCheckpointV1 | null = null;
      await database.withTransaction(async (transaction) => {
        const existing = await loadCheckpointFrom(transaction);
        if (existing) {
          if (
            existing.world.vaultId !== world.vaultId
            || existing.world.keyId !== world.keyId
            || existing.deviceId !== identity.deviceId
          ) {
            throw new Error('v2 database already belongs to another new world');
          }
          result = existing;
          return;
        }
        const occupied = await transaction.getFirstAsync<CountRow>(
          `SELECT (
             (SELECT COUNT(*) FROM sync_device_state)
             + (SELECT COUNT(*) FROM sync_outbox)
             + (SELECT COUNT(*) FROM sync_inbox)
             + (SELECT COUNT(*) FROM sync_applied_mutations)
             + (SELECT COUNT(*) FROM sync_cursors)
             + (SELECT COUNT(*) FROM sync_entity_heads)
             + (SELECT COUNT(*) FROM sync_entity_revisions)
             + (SELECT COUNT(*) FROM sync_revision_object_refs)
             + (SELECT COUNT(*) FROM sync_entity_conflicts)
             + (SELECT COUNT(*) FROM sync_quarantine)
             + (SELECT COUNT(*) FROM sync_durable_intents)
             + (SELECT COUNT(*) FROM sync_execution_fences)
             + (SELECT COUNT(*) FROM sync_object_jobs)
             + (SELECT COUNT(*) FROM sync_object_retention_state)
             + (SELECT COUNT(*) FROM sync_object_materializations)
           ) AS count`,
        );
        if (Number(occupied?.count ?? 0) !== 0) {
          throw new Error('v2 database is not a clean staging database');
        }
        await transaction.runAsync(
          `INSERT INTO sync_device_state (
             device_id, vault_id, key_id, platform, display_name,
             signing_public_key, exchange_public_key, state,
             created_at, revoked_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
          identity.deviceId,
          identity.vaultId,
          identity.keyId,
          identity.platform,
          identity.displayName,
          identity.signingPublicKey,
          identity.exchangePublicKey,
          identity.state,
          identity.createdAt,
        );
        const checkpoint = buildInitialCheckpoint({ world, identity, createdAt });
        await transaction.runAsync(
          `INSERT INTO sync_durable_intents (
             operation_id, adapter_id, intent_json, state,
             created_at, updated_at
           ) VALUES (?, ?, ?, 'prepared', ?, ?)`,
          NEW_WORLD_BASELINE_OPERATION_ID,
          'new-world.current-snapshot',
          JSON.stringify(checkpoint),
          createdAt,
          createdAt,
        );
        result = checkpoint;
      });
      if (!result) throw new Error('new-world baseline initialization did not run');
      return result;
    },
    commitPage: async (commit) => {
      assertTimestamp(commit.createdAt, 'new-world baseline page time');
      const database = await input.getDatabase();
      let result: SyncWorldBaselineCheckpointV1 | null = null;
      await database.withTransaction(async (transaction) => {
        const current = await loadCheckpointFrom(transaction);
        if (!current || !sameCheckpoint(current, commit.expected)) {
          throw new Error('new-world baseline checkpoint changed before commit');
        }
        if (current.state !== 'staging') {
          result = current;
          return;
        }
        const sequenceRow = await transaction.getFirstAsync<{
          value: number | null;
        }>(
          `SELECT MAX(source_sequence) AS value
           FROM sync_entity_revisions
           WHERE source_device_id = ?`,
          commit.identity.deviceId,
        );
        let sequence = Number(sequenceRow?.value ?? 0);
        for (const template of commit.mutations) {
          const mutationId = await commit.randomUuid();
          const revisionId = await commit.randomUuid();
          assertSyncUuidV4(mutationId, 'new-world baseline mutationId');
          assertSyncUuidV4(revisionId, 'new-world baseline revisionId');
          if (mutationId === revisionId) {
            throw new Error('new-world baseline mutation/revision IDs collided');
          }
          sequence += 1;
          await insertBaselineMutation(
            transaction,
            buildBaselineMutation({
              template,
              identity: commit.identity,
              sourceSequence: sequence,
              mutationId,
              revisionId,
              createdAt: commit.createdAt,
            }),
            commit.createdAt,
          );
        }
        const next: SyncWorldBaselineCheckpointV1 = Object.freeze({
          ...current,
          adapterIndex: commit.nextAdapterIndex,
          adapterId: CURRENT_SNAPSHOT_CAPTURE_ADAPTER_IDS[
            commit.nextAdapterIndex
          ] ?? null,
          pageToken: commit.nextPageToken,
          mutationCount: current.mutationCount + commit.mutations.length,
          state: commit.completed ? 'complete' : 'staging',
          updatedAt: commit.createdAt,
        });
        parseSyncWorldBaselineCheckpoint(JSON.stringify(next));
        const update = await transaction.runAsync(
          `UPDATE sync_durable_intents
           SET intent_json = ?, state = ?, updated_at = ?
           WHERE operation_id = ? AND state = 'prepared'`,
          JSON.stringify(next),
          commit.completed ? 'captured' : 'prepared',
          commit.createdAt,
          NEW_WORLD_BASELINE_OPERATION_ID,
        );
        if (update.changes !== 1) {
          throw new Error('new-world baseline checkpoint was not advanced');
        }
        result = next;
      });
      if (!result) throw new Error('new-world baseline page commit did not run');
      return result;
    },
  };
}
