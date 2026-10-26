import type * as SQLite from 'expo-sqlite';

import {
  createExpoSyncCryptoPortV1,
  expoSyncRandomUuidV1,
} from './syncCryptoExpo';
import {
  runSyncDatabaseTransaction,
} from './syncDatabaseOperationQueue';
import {
  getExpoSyncWorldV2Database,
} from './syncNewWorldBaselineExpoStore';
import {
  loadNewWorldAndroidStagingSecret,
} from './syncNewWorldSecretsExpo';
import {
  computeSyncRetryAt,
  parsePlainMutationV1,
  type PlainMutationV1,
} from './syncProtocol';
import {
  loadAndroidNewWorldRelaySnapshot,
} from './syncNewWorldRelayExpo';
import {
  createAndroidSyncRelayClient,
} from './syncRelayClientExpo';
import type {
  SyncRelayActiveEnrollmentV1,
} from './syncRelayClient';

const MAX_SEND_BATCHES = 16;
const MAX_RUNTIME_MS = 30_000;
const LEASE_DURATION_MS = 60_000;

type OutboxRow = {
  local_sequence: number;
  mutation_id: string;
  mutation_json: string;
  attempt_count: number;
};

export type AndroidNewWorldBaselinePublishResult = Readonly<{
  state: 'complete' | 'work-remaining';
  sentBatches: number;
  sentMutations: number;
  duplicateMutations: number;
  pendingMutations: number;
  acknowledgedMutations: number;
  automaticSyncEnabled: false;
}>;

function asEnrollment(
  staging: NonNullable<Awaited<ReturnType<
    typeof loadNewWorldAndroidStagingSecret
  >>>,
) {
  return {
    publicIdentity: staging.identity,
    secrets: staging.secrets,
  };
}

async function claimBaselineBatch(input: {
  database: SQLite.SQLiteDatabase;
  deviceId: string;
  vaultId: string;
  leaseId: string;
  now: number;
}) {
  const claimed: Array<{
    localSequence: number;
    mutation: PlainMutationV1;
    attemptCount: number;
  }> = [];
  await runSyncDatabaseTransaction(input.database, async (transaction) => {
    await transaction.runAsync(
      `UPDATE sync_outbox
       SET state = 'pending', lease_id = NULL,
           lease_expires_at = NULL, updated_at = ?
       WHERE state = 'leased'
         AND lease_expires_at IS NOT NULL
         AND lease_expires_at <= ?`,
      input.now,
      input.now,
    );
    const rows = await transaction.getAllAsync<OutboxRow>(
      `SELECT local_sequence, mutation_id, mutation_json, attempt_count
       FROM sync_outbox
       WHERE state = 'pending'
         AND available_at <= ?
         AND vault_id = ?
         AND source_device_id = ?
       ORDER BY local_sequence ASC
       LIMIT 16`,
      input.now,
      input.vaultId,
      input.deviceId,
    );
    for (const row of rows) {
      const mutation = parsePlainMutationV1(row.mutation_json);
      if (
        mutation.mutationId !== row.mutation_id
        || mutation.vaultId !== input.vaultId
        || mutation.sourceDeviceId !== input.deviceId
      ) {
        throw new Error('new-world baseline outbox identity does not match');
      }
      const result = await transaction.runAsync(
        `UPDATE sync_outbox
         SET state = 'leased', lease_id = ?,
             lease_expires_at = ?, updated_at = ?
         WHERE local_sequence = ? AND state = 'pending'`,
        input.leaseId,
        input.now + LEASE_DURATION_MS,
        input.now,
        row.local_sequence,
      );
      if (result.changes !== 1) {
        throw new Error('new-world baseline outbox lease changed');
      }
      claimed.push({
        localSequence: row.local_sequence,
        mutation,
        attemptCount: row.attempt_count,
      });
    }
  });
  return claimed;
}

async function acknowledgeBaselineBatch(input: {
  database: SQLite.SQLiteDatabase;
  leaseId: string;
  mutationIds: readonly string[];
  now: number;
}) {
  await runSyncDatabaseTransaction(input.database, async (transaction) => {
    for (const mutationId of input.mutationIds) {
      const result = await transaction.runAsync(
        `UPDATE sync_outbox
         SET state = 'acked', lease_id = NULL,
             lease_expires_at = NULL, last_error_code = NULL,
             updated_at = ?
         WHERE mutation_id = ? AND state = 'leased' AND lease_id = ?`,
        input.now,
        mutationId,
        input.leaseId,
      );
      if (result.changes !== 1) {
        throw new Error('new-world baseline acknowledgement lost its lease');
      }
    }
  });
}

async function releaseFailedBaselineBatch(input: {
  database: SQLite.SQLiteDatabase;
  leaseId: string;
  rows: readonly { mutation: PlainMutationV1; attemptCount: number }[];
  now: number;
}) {
  await runSyncDatabaseTransaction(input.database, async (transaction) => {
    for (const row of input.rows) {
      const nextAttempt = row.attemptCount + 1;
      await transaction.runAsync(
        `UPDATE sync_outbox
         SET state = 'pending', attempt_count = ?, available_at = ?,
             lease_id = NULL, lease_expires_at = NULL,
             last_error_code = 'relay.transport', updated_at = ?
         WHERE mutation_id = ? AND state = 'leased' AND lease_id = ?`,
        nextAttempt,
        computeSyncRetryAt(nextAttempt, input.now),
        input.now,
        row.mutation.mutationId,
        input.leaseId,
      );
    }
  });
}

async function baselineOutboxCounts(database: SQLite.SQLiteDatabase) {
  const row = await database.getFirstAsync<{
    pending_count: number;
    acknowledged_count: number;
    quarantined_count: number;
  }>(
    `SELECT
       SUM(CASE WHEN state IN ('pending', 'leased') THEN 1 ELSE 0 END)
         AS pending_count,
       SUM(CASE WHEN state = 'acked' THEN 1 ELSE 0 END)
         AS acknowledged_count,
       SUM(CASE WHEN state = 'quarantined' THEN 1 ELSE 0 END)
         AS quarantined_count
     FROM sync_outbox`,
  );
  return {
    pending: Number(row?.pending_count ?? 0),
    acknowledged: Number(row?.acknowledged_count ?? 0),
    quarantined: Number(row?.quarantined_count ?? 0),
  };
}

export async function inspectAndroidNewWorldBaselinePublishState() {
  const database = await getExpoSyncWorldV2Database();
  return baselineOutboxCounts(database);
}

export async function runBoundedAndroidNewWorldBaselineUpload(input: {
  database: SQLite.SQLiteDatabase;
  enrollment: SyncRelayActiveEnrollmentV1;
  crypto: ReturnType<typeof createExpoSyncCryptoPortV1>;
  relay: Pick<ReturnType<typeof createAndroidSyncRelayClient>, 'pushChanges'>;
  randomUuid?: typeof expoSyncRandomUuidV1;
  now?: () => number;
}): Promise<AndroidNewWorldBaselinePublishResult> {
  const now = input.now ?? Date.now;
  const randomUuid = input.randomUuid ?? expoSyncRandomUuidV1;
  const identity = input.enrollment.publicIdentity;
  const startedAt = now();
  let sentBatches = 0;
  let sentMutations = 0;
  let duplicateMutations = 0;

  while (
    sentBatches < MAX_SEND_BATCHES
    && now() - startedAt < MAX_RUNTIME_MS
  ) {
    const leaseId = await randomUuid();
    const claimedAt = now();
    const batch = await claimBaselineBatch({
      database: input.database,
      deviceId: identity.deviceId,
      vaultId: identity.vaultId,
      leaseId,
      now: claimedAt,
    });
    if (batch.length === 0) break;
    try {
      const changes = await Promise.all(batch.map(({ mutation }) => (
        input.crypto.sealChange(mutation, randomUuid())
      )));
      const response = await input.relay.pushChanges(
        input.enrollment,
        changes,
      );
      await acknowledgeBaselineBatch({
        database: input.database,
        leaseId,
        mutationIds: response.acknowledgements.map(
          (entry) => entry.mutationId,
        ),
        now: now(),
      });
      sentBatches += 1;
      sentMutations += changes.length;
      duplicateMutations += response.acknowledgements.filter(
        (entry) => entry.duplicate,
      ).length;
    } catch (error) {
      await releaseFailedBaselineBatch({
        database: input.database,
        leaseId,
        rows: batch,
        now: now(),
      });
      throw new Error(
        'new-world baseline upload stopped and can be resumed',
        { cause: error },
      );
    }
  }

  const counts = await baselineOutboxCounts(input.database);
  if (counts.quarantined > 0) {
    throw new Error('new-world baseline contains a quarantined mutation');
  }
  return Object.freeze({
    state: counts.pending === 0 ? 'complete' : 'work-remaining',
    sentBatches,
    sentMutations,
    duplicateMutations,
    pendingMutations: counts.pending,
    acknowledgedMutations: counts.acknowledged,
    automaticSyncEnabled: false,
  });
}

export async function publishNextAndroidNewWorldBaselineBatch(input: {
  baseUrl: string;
  now?: () => number;
}): Promise<AndroidNewWorldBaselinePublishResult> {
  const now = input.now ?? Date.now;
  const [staging, relayState] = await Promise.all([
    loadNewWorldAndroidStagingSecret(),
    loadAndroidNewWorldRelaySnapshot(),
  ]);
  if (!staging || relayState.state !== 'provisioned') {
    throw new Error('new-world relay space is not ready');
  }
  const database = await getExpoSyncWorldV2Database();
  const checkpoint = await database.getFirstAsync<{
    state: string;
  }>(
    `SELECT state FROM sync_durable_intents
     WHERE operation_id = 'junluo.sync.v2.current-baseline'`,
  );
  if (checkpoint?.state !== 'captured') {
    throw new Error('new-world current baseline is not complete');
  }

  const enrollment = asEnrollment(staging);
  const crypto = createExpoSyncCryptoPortV1({
    vaultId: staging.world.vaultId,
    deviceId: staging.identity.deviceId,
    keyId: staging.world.keyId,
    vaultRootSecret: staging.secrets.vaultRootSecret,
    signingPrivateKey: staging.secrets.signingPrivateKey,
    resolveSigningPublicKey: async () => {
      throw new Error('new-world baseline publisher does not read remote keys');
    },
  });
  const relay = createAndroidSyncRelayClient({ baseUrl: input.baseUrl });
  const result = await runBoundedAndroidNewWorldBaselineUpload({
    database,
    enrollment,
    crypto,
    relay,
    now,
  });
  if (result.state === 'complete') {
    await relay.commitCurrentBaseline(enrollment, {
      version: 1,
      vaultId: staging.world.vaultId,
      sourceDeviceId: staging.identity.deviceId,
      keyId: staging.world.keyId,
      completedAt: now(),
    });
  }
  return result;
}
