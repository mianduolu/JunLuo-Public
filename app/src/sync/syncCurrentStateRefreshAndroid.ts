import { sha256 } from '@noble/hashes/sha2.js';

import {
  base64UrlToBytes,
  bytesToBase64Url,
  canonicalizeJsonBytesV1,
  canonicalizeJsonV1,
  deriveSyncVaultKeysV1,
  encryptXChaCha20Poly1305V1,
  sha256BytesV1,
} from './syncCrypto';
import {
  expoSyncRandomBytesV1,
} from './syncCryptoExpo';
import {
  createAndroidCurrentSnapshotSources,
} from './syncAndroidNewWorldController';
import {
  CURRENT_SNAPSHOT_PLAN,
} from './syncCurrentSnapshot';
import {
  CURRENT_SNAPSHOT_CAPTURE_ADAPTER_IDS,
  indexCurrentSnapshotMutationSources,
  readValidatedCurrentSnapshotMutationPage,
} from './syncNewWorldBaseline';
import {
  androidSyncLedgerSnapshot,
} from './syncAndroidMutationLedger';
import {
  openInitializedSyncDatabase,
} from './syncDatabaseOpen';
import {
  runSyncDatabaseTransaction,
} from './syncDatabaseOperationQueue';
import {
  createCurrentStateRefreshApprovalV1,
  createCurrentStateRefreshEntryV1,
  assertCurrentStateRefreshEntryV1,
  verifyCurrentStateRefreshEntryV1,
  type CurrentStateRefreshEntryV1,
  type CurrentStateRefreshStatusV1,
} from './syncFiniteHistory';
import {
  createAndroidSyncRelayClient,
  loadCurrentSyncRelayEnrollment,
} from './syncRelayClientExpo';
import {
  getAppliedRelayCursor,
} from './syncStore';
import {
  resolveAndroidSyncDomain,
} from './syncAndroidDomainCatalog';
import {
  assertPlainMutationV1,
  parsePlainMutationV1,
  type PlainMutationV1,
} from './syncProtocol';
import { assertOrdinarySyncAllowed } from './syncEmergencyWorldRebuildStore';

type CurrentHeadRow = {
  revision_id: string;
  mutation_json: string;
};

type PreparedRefreshEntryRow = {
  entry_index: number;
  entry_json: string;
  state: string;
};

let databasePromise: ReturnType<typeof openInitializedSyncDatabase> | undefined;

async function getDatabase() {
  if (!databasePromise) {
    const opening = openInitializedSyncDatabase(
      '同步数据库版本高于当前应用，已停止准备当前状态。',
    );
    const retryable = opening.catch((error) => {
      if (databasePromise === retryable) databasePromise = undefined;
      throw error;
    });
    databasePromise = retryable;
  }
  return databasePromise;
}

function entityKey(mutation: PlainMutationV1) {
  return [
    mutation.entity.domain,
    mutation.entity.type,
    mutation.entity.id,
  ].join('\u0000');
}

function semanticSnapshotDigest(mutation: PlainMutationV1) {
  return bytesToBase64Url(sha256BytesV1(canonicalizeJsonBytesV1({
    entity: mutation.entity,
    operation: mutation.revision.operation,
    schemaVersion: mutation.revision.schemaVersion,
    payload: mutation.payload,
    objectRefs: [...mutation.objectRefs].sort(),
  })));
}

async function collectPureCurrentSnapshot(
  onProgress?: (completedAdapters: number) => void,
) {
  const indexed = indexCurrentSnapshotMutationSources(
    createAndroidCurrentSnapshotSources(null),
  );
  const expected = new Map<string, {
    adapterId: string;
    digest: string;
  }>();
  let completedAdapters = 0;
  for (const adapterId of CURRENT_SNAPSHOT_CAPTURE_ADAPTER_IDS) {
    const source = indexed.get(adapterId);
    if (!source) throw new Error(`当前状态缺少 ${adapterId} 读取器。`);
    let token: string | null = null;
    do {
      const page = await readValidatedCurrentSnapshotMutationPage({
        source,
        pageToken: token,
        limit: 50,
      });
      for (const mutation of page.mutations) {
        const key = entityKey(mutation);
        if (expected.has(key)) {
          throw new Error('纯当前快照出现重复实体。');
        }
        expected.set(key, {
          adapterId,
          digest: semanticSnapshotDigest(mutation),
        });
      }
      token = page.nextPageToken;
    } while (token !== null);
    completedAdapters += 1;
    onProgress?.(completedAdapters);
  }
  return expected;
}

async function loadValidatedCurrentHeads(
  onProgress?: (completedAdapters: number) => void,
) {
  const ledger = await androidSyncLedgerSnapshot();
  if (
    ledger.pendingOutbox > 0
    || ledger.receivedInbox > 0
    || ledger.pendingConflicts > 0
    || ledger.quarantined > 0
  ) {
    throw new Error('准备当前状态前，需要先让普通数据与不同版本全部归零。');
  }
  const expected = await collectPureCurrentSnapshot(onProgress);
  const database = await getDatabase();
  const rows = await database.getAllAsync<CurrentHeadRow>(
    `SELECT revision.revision_id, revision.mutation_json
     FROM sync_entity_heads AS head
     INNER JOIN sync_entity_revisions AS revision
       ON revision.revision_id = head.revision_id
     ORDER BY revision.domain, revision.entity_type,
              revision.entity_id, revision.revision_id`,
  );
  const seenEntities = new Set<string>();
  const snapshot: PlainMutationV1[] = [];
  for (const row of rows) {
    const mutation = parsePlainMutationV1(row.mutation_json);
    const key = entityKey(mutation);
    if (seenEntities.has(key)) {
      throw new Error('中央 current heads 仍含多个版本，不能准备当前状态。');
    }
    seenEntities.add(key);
    const route = resolveAndroidSyncDomain(mutation);
    const plan = CURRENT_SNAPSHOT_PLAN.find(
      (entry) => entry.adapterId === route.adapterId,
    );
    if (!plan) throw new Error('当前状态缺少 41 域覆盖。');
    if (
      plan.disposition === 'skip-local-journal'
      || plan.disposition === 'exclude-from-ordinary-sync'
    ) {
      continue;
    }
    if (mutation.revision.operation !== 'delete') {
      const current = expected.get(key);
      if (plan.disposition === 'capture-current') {
        if (!current || current.digest !== semanticSnapshotDigest(mutation)) {
          throw new Error(
            `${route.adapterId} 业务现状与中央 current head 不一致。`,
          );
        }
        expected.delete(key);
      }
    }
    const refreshed: PlainMutationV1 = {
      ...mutation,
      revision: {
        ...mutation.revision,
        parents: [],
      },
    };
    assertPlainMutationV1(refreshed);
    snapshot.push(refreshed);
  }
  if (expected.size > 0) {
    const first = expected.values().next().value as {
      adapterId: string;
    } | undefined;
    throw new Error(
      `${first?.adapterId ?? '当前状态'} 尚未进入中央 current heads。`,
    );
  }
  if (CURRENT_SNAPSHOT_PLAN.length !== 41) {
    throw new Error('当前状态刷新必须覆盖完整 41 域计划。');
  }
  onProgress?.(CURRENT_SNAPSHOT_PLAN.length);
  return snapshot;
}

function entryAssociatedData(input: {
  sessionId: string;
  sourceDeviceId: string;
  entryIndex: number;
  revisionId: string;
  entityKeyDigest: string;
  keyId: string;
}) {
  return canonicalizeJsonBytesV1({
    context: 'junluo.sync.v1/current-state-refresh-ciphertext',
    ...input,
  });
}

async function prepareEntries(input: {
  session: CurrentStateRefreshStatusV1;
  mutations: PlainMutationV1[];
  vaultRootSecret: string;
  signingPrivateKey: string;
  keyId: string;
  sourceDeviceId: string;
  now: number;
}) {
  const keys = deriveSyncVaultKeysV1(base64UrlToBytes(
    input.vaultRootSecret,
    'vaultRootSecret',
    32,
  ));
  const entries: CurrentStateRefreshEntryV1[] = [];
  for (let index = 0; index < input.mutations.length; index += 1) {
    const mutation = input.mutations[index]!;
    const entryIndex = index + 1;
    const entityKeyDigest = bytesToBase64Url(sha256BytesV1(
      canonicalizeJsonBytesV1(mutation.entity),
    ));
    const header = {
      sessionId: input.session.sessionId,
      sourceDeviceId: input.sourceDeviceId,
      entryIndex,
      revisionId: mutation.revision.id,
      entityKeyDigest,
      keyId: input.keyId,
    };
    const nonceBytes = await expoSyncRandomBytesV1(24);
    const ciphertextBytes = encryptXChaCha20Poly1305V1(
      canonicalizeJsonBytesV1(mutation),
      keys.changeEncryptionKey,
      nonceBytes,
      entryAssociatedData(header),
    );
    entries.push(createCurrentStateRefreshEntryV1({
      version: 1,
      ...header,
      nonce: bytesToBase64Url(nonceBytes),
      ciphertext: bytesToBase64Url(ciphertextBytes),
      ciphertextSha256: bytesToBase64Url(
        sha256BytesV1(ciphertextBytes),
      ),
    }, input.signingPrivateKey));
  }
  const digest = sha256.create();
  for (const entry of entries) {
    digest.update(new TextEncoder().encode(
      `${canonicalizeJsonV1(entry)}\n`,
    ));
  }
  const snapshotDigest = bytesToBase64Url(digest.digest());
  const database = await getDatabase();
  await runSyncDatabaseTransaction(database, async (transaction) => {
    await transaction.runAsync(
      `INSERT INTO sync_current_refresh_sessions_v1 (
         session_id, role, state, requester_device_id, source_device_id,
         cutover_cursor, entry_count, next_entry_index, snapshot_digest,
         created_at, updated_at
       ) VALUES (?, 'source', 'preparing', ?, ?, ?, ?, 1, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         source_device_id = excluded.source_device_id,
         cutover_cursor = excluded.cutover_cursor,
         entry_count = excluded.entry_count,
         snapshot_digest = excluded.snapshot_digest,
         updated_at = excluded.updated_at`,
      input.session.sessionId,
      input.session.requesterDeviceId,
      input.sourceDeviceId,
      input.session.cutoverCursor ?? 0,
      entries.length,
      snapshotDigest,
      input.now,
      input.now,
    );
    await transaction.runAsync(
      `DELETE FROM sync_current_refresh_entries_v1 WHERE session_id = ?`,
      input.session.sessionId,
    );
    for (const entry of entries) {
      await transaction.runAsync(
        `INSERT INTO sync_current_refresh_entries_v1 (
           session_id, entry_index, revision_id, entity_key_digest,
           entry_json, state, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'prepared', ?)`,
        input.session.sessionId,
        entry.entryIndex,
        entry.revisionId,
        entry.entityKeyDigest,
        canonicalizeJsonV1(entry),
        input.now,
      );
    }
  });
  return { entries, snapshotDigest };
}

async function resumeApprovedUpload(input: {
  session: CurrentStateRefreshStatusV1;
  enrollment: NonNullable<Awaited<ReturnType<
    typeof loadCurrentSyncRelayEnrollment
  >>>;
  relay: ReturnType<typeof createAndroidSyncRelayClient>;
  now: () => number;
  onProgress?: (completedAdapters: number) => void;
}) {
  const database = await getDatabase();
  const localSession = await database.getFirstAsync<{
    requester_device_id: string;
    source_device_id: string | null;
    cutover_cursor: number | null;
    entry_count: number | null;
  }>(
    `SELECT requester_device_id, source_device_id, cutover_cursor, entry_count
     FROM sync_current_refresh_sessions_v1 WHERE session_id = ?`,
    input.session.sessionId,
  );
  if (
    !localSession
    || localSession.requester_device_id !== input.session.requesterDeviceId
    || localSession.source_device_id !== input.enrollment.publicIdentity.deviceId
    || localSession.cutover_cursor !== input.session.cutoverCursor
    || localSession.entry_count !== input.session.entryCount
  ) {
    throw new Error('本机缺少与电脑请求一致的当前状态临时快照。');
  }
  const rows = await database.getAllAsync<PreparedRefreshEntryRow>(
    `SELECT entry_index, entry_json, state
     FROM sync_current_refresh_entries_v1
     WHERE session_id = ? ORDER BY entry_index`,
    input.session.sessionId,
  );
  if (
    rows.length !== input.session.entryCount
    || rows.some((row, index) => row.entry_index !== index + 1)
  ) {
    throw new Error('本机当前状态临时快照不完整。');
  }
  input.onProgress?.(CURRENT_SNAPSHOT_PLAN.length);
  for (const row of rows) {
    if (row.state === 'uploaded') continue;
    const parsed: unknown = JSON.parse(row.entry_json);
    assertCurrentStateRefreshEntryV1(parsed);
    if (
      parsed.sessionId !== input.session.sessionId
      || parsed.entryIndex !== row.entry_index
      || !verifyCurrentStateRefreshEntryV1(
        parsed,
        input.enrollment.publicIdentity.signingPublicKey,
      )
    ) {
      throw new Error('本机当前状态临时快照签名或身份不一致。');
    }
    await input.relay.putCurrentStateRefreshEntry(input.enrollment, parsed);
    await database.runAsync(
      `UPDATE sync_current_refresh_entries_v1
       SET state = 'uploaded', updated_at = ?
       WHERE session_id = ? AND entry_index = ?`,
      input.now(),
      input.session.sessionId,
      row.entry_index,
    );
  }
  const finalized = await input.relay.finalizeCurrentStateRefresh(
    input.enrollment,
    input.session.sessionId,
  );
  await database.runAsync(
    `UPDATE sync_current_refresh_sessions_v1
     SET state = 'ready', updated_at = ? WHERE session_id = ?`,
    input.now(),
    input.session.sessionId,
  );
  return finalized;
}

export async function listPendingAndroidCurrentStateRefreshRequests(input: {
  baseUrl: string;
}) {
  const enrollment = await loadCurrentSyncRelayEnrollment();
  if (!enrollment) return [];
  return createAndroidSyncRelayClient({ baseUrl: input.baseUrl })
    .listPendingCurrentStateRefresh(enrollment);
}

export async function prepareAndroidCurrentStateRefresh(input: {
  baseUrl: string;
  sessionId: string;
  now?: () => number;
  onProgress?: (completedAdapters: number) => void;
}) {
  await assertOrdinarySyncAllowed();
  const now = input.now ?? Date.now;
  const enrollment = await loadCurrentSyncRelayEnrollment();
  if (!enrollment) throw new Error('手机没有 active 同步身份。');
  const relay = createAndroidSyncRelayClient({ baseUrl: input.baseUrl });
  const sessions = await relay.listPendingCurrentStateRefresh(enrollment);
  const session = sessions.find((item) => item.sessionId === input.sessionId);
  if (!session || !['waiting-android', 'uploading'].includes(session.state)) {
    throw new Error('电脑当前没有等待批准的现状刷新请求。');
  }
  if (session.state === 'uploading') {
    return resumeApprovedUpload({
      session,
      enrollment,
      relay,
      now,
      onProgress: input.onProgress,
    });
  }
  const cutoverCursor = await getAppliedRelayCursor();
  const mutations = await loadValidatedCurrentHeads(input.onProgress);
  const preparedSession: CurrentStateRefreshStatusV1 = {
    ...session,
    cutoverCursor,
  };
  const prepared = await prepareEntries({
    session: preparedSession,
    mutations,
    vaultRootSecret: enrollment.secrets.vaultRootSecret,
    signingPrivateKey: enrollment.secrets.signingPrivateKey,
    keyId: enrollment.publicIdentity.keyId,
    sourceDeviceId: enrollment.publicIdentity.deviceId,
    now: now(),
  });
  const finalLedger = await androidSyncLedgerSnapshot();
  const finalCursor = await getAppliedRelayCursor();
  if (
    finalLedger.pendingOutbox > 0
    || finalLedger.receivedInbox > 0
    || finalLedger.pendingConflicts > 0
    || finalLedger.quarantined > 0
    || finalCursor !== cutoverCursor
  ) {
    throw new Error(
      '准备期间同步现状发生变化，已保留临时快照，请先同步后再重试。',
    );
  }
  const approval = createCurrentStateRefreshApprovalV1({
    version: 1,
    sessionId: session.sessionId,
    vaultId: enrollment.publicIdentity.vaultId,
    sourceDeviceId: enrollment.publicIdentity.deviceId,
    requesterDeviceId: session.requesterDeviceId,
    keyId: enrollment.publicIdentity.keyId,
    cutoverCursor,
    entryCount: prepared.entries.length,
    snapshotDigest: prepared.snapshotDigest,
    approvedAt: now(),
  }, enrollment.secrets.signingPrivateKey);
  await relay.approveCurrentStateRefresh(enrollment, approval);
  const database = await getDatabase();
  await database.runAsync(
    `UPDATE sync_current_refresh_sessions_v1
     SET state = 'uploading', updated_at = ? WHERE session_id = ?`,
    now(),
    session.sessionId,
  );
  for (const entry of prepared.entries) {
    await relay.putCurrentStateRefreshEntry(enrollment, entry);
    await database.runAsync(
      `UPDATE sync_current_refresh_entries_v1
       SET state = 'uploaded', updated_at = ?
       WHERE session_id = ? AND entry_index = ?`,
      now(),
      session.sessionId,
      entry.entryIndex,
    );
  }
  const finalized = await relay.finalizeCurrentStateRefresh(
    enrollment,
    session.sessionId,
  );
  await database.runAsync(
    `UPDATE sync_current_refresh_sessions_v1
     SET state = 'ready', updated_at = ? WHERE session_id = ?`,
    now(),
    session.sessionId,
  );
  return finalized;
}

export async function closeAndroidCurrentStateRefreshDatabase() {
  if (!databasePromise) return;
  const database = await databasePromise;
  await database.closeAsync();
  databasePromise = undefined;
}
