import * as FileSystem from 'expo-file-system/legacy';
import type { SQLiteDatabase } from 'expo-sqlite';
import { canCommitBackupRestoreDataEpoch, captureBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { deleteGiftRelationsWithDatabase } from '../gifts/giftDeletion';
import { emitGiftChanges } from '../gifts/giftEvents';
import { collectGiftOriginalFiles, giftOriginalUri } from '../gifts/giftFiles';
import { withGiftStoreWrite } from '../gifts/giftStore';
import { getMemoryDatabase } from '../memory/memoryStore';
import { copyFileSafely } from '../storage/safeFileWrite';
import { applyVerifiedAndroidSyncMutation } from './syncAndroidMutationLedger';
import type { AndroidSyncObjectMaterializer } from './syncAndroidObjectMaterializationCore';
import { ensureAndroidContentObjectUpload } from './syncAndroidContentObjectUpload';
import { captureSyncContentObject } from './syncContentObjectCapture';
import { base64UrlToBytes, canonicalizeJsonV1, deriveSyncVaultKeysV1 } from './syncCrypto';
import { expoSyncRandomUuidV1 } from './syncCryptoExpo';
import { assertMatchingSyncDeviceIdentity, getCurrentDeviceDatabase, loadCurrentSyncDevice } from './syncCurrentDevice';
import { enqueueSyncDatabaseOperation } from './syncDatabaseOperationQueue';
import { assertSyncDevicePublicIdentityV1, type SyncDevicePublicIdentityV1, type SyncDeviceSecretsV1 } from './syncDeviceContract';
import { assertGiftSyncFrozenOriginal, assertGiftsLifeMutationV1, buildGiftSyncMutation, giftSyncEntityId,
  giftSyncGiftId, giftSyncOriginalRecords, selectGiftSyncHead, type GiftSyncKind, type GiftSyncOriginal,
  type GiftSyncPayload, type GiftSyncRow } from './syncGiftsLife';
import { GIFT_SYNC_SPECS, type GiftSyncChange } from './syncGiftsSql';
import { allocateSyncSourceSequence } from './syncMutationStateStore';
import { loadSyncObjectJob, scheduleSyncObjectUpload } from './syncObjectJobStore';
import { loadSyncObjectExpoManifest, syncObjectExpoFilePort } from './syncObjectExpoFilePort';
import type { JsonValue, PlainMutationV1 } from './syncProtocol';
import { enqueueSyncMutation } from './syncStore';

type Upsert = Extract<GiftSyncPayload, { record: unknown }>;
type HeadGroup = { kind: GiftSyncKind; id: string; mutations: PlainMutationV1[] };
const json = (value: unknown) => canonicalizeJsonV1(value as JsonValue);
const childTables = {
  echo: { table: 'gift_echoes', keys: ['gift_id', 'id'] },
  activity: { table: 'gift_attachment_activity', keys: ['gift_id', 'attachment_id', 'viewer'] },
  understanding: { table: 'gift_understanding_receipts', keys: ['gift_id', 'gift_revision', 'attachment_id'] },
} as const;
function assertIdentity(identity: SyncDevicePublicIdentityV1) {
  assertSyncDevicePublicIdentityV1(identity);
  if (identity.state !== 'active' || identity.revokedAt !== null) throw Error('gift-sync-inactive-device');
}
function assertEpoch(epoch: number | null) {
  if (!canCommitBackupRestoreDataEpoch(epoch)) throw Error('gift-stale-data-epoch');
}
async function heads(vaultId?: string): Promise<HeadGroup[]> {
  const central = await getCurrentDeviceDatabase();
  const rows = await enqueueSyncDatabaseOperation(() => central.getAllAsync<{ mutation_json: string }>(
    `SELECT r.mutation_json FROM sync_entity_heads h JOIN sync_entity_revisions r ON r.revision_id=h.revision_id
     WHERE h.domain='gifts' ORDER BY h.entity_type,h.entity_id,h.revision_id`));
  const groups = new Map<string, HeadGroup>();
  for (const row of rows) {
    const mutation: PlainMutationV1 = JSON.parse(row.mutation_json); assertGiftsLifeMutationV1(mutation);
    if (vaultId !== undefined && mutation.vaultId !== vaultId) continue;
    const key = JSON.stringify([mutation.entity.type, mutation.entity.id]);
    const group = groups.get(key) ?? { kind: mutation.entity.type as GiftSyncKind, id: mutation.entity.id, mutations: [] };
    group.mutations.push(mutation); groups.set(key, group);
  }
  return [...groups.values()];
}
async function historicalDelete(giftId: string) {
  const central = await getCurrentDeviceDatabase();
  return enqueueSyncDatabaseOperation(async () => {
    const rows = await central.getAllAsync<{ mutation_json: string }>(
      "SELECT mutation_json FROM sync_entity_revisions WHERE domain='gifts' AND entity_type='gift' AND entity_id=? AND operation='delete'", giftId);
    const deleted = selectGiftSyncHead(rows.map(row => JSON.parse(row.mutation_json) as PlainMutationV1));
    if (deleted) return deleted;
    return await central.getFirstAsync(`SELECT 1 FROM sync_finite_deletion_compactions_v1
      WHERE json_extract(request_json,'$.domain')='gifts' AND json_extract(request_json,'$.entityType')='gift'
        AND json_extract(request_json,'$.entityId')=? LIMIT 1`, giftId) ? 'compacted' as const : null;
  });
}
async function nativeGift(database: SQLiteDatabase, id: string) {
  const row = await database.getFirstAsync<{ record_json: string }>('SELECT record_json FROM gift_records WHERE id=?', id);
  return row ? JSON.parse(row.record_json) as GiftSyncRow : null;
}
async function suppressed(database: SQLiteDatabase, work: (transaction: SQLiteDatabase) => Promise<void>) {
  const epoch = captureBackupRestoreDataEpoch();
  await database.withExclusiveTransactionAsync(async transaction => {
    assertEpoch(epoch);
    const previous = await transaction.getFirstAsync<{ suppressed: number }>('SELECT suppressed FROM gift_sync_runtime WHERE singleton=1');
    await transaction.runAsync('UPDATE gift_sync_runtime SET suppressed=1 WHERE singleton=1');
    try { await work(transaction); }
    finally { await transaction.runAsync('UPDATE gift_sync_runtime SET suppressed=? WHERE singleton=1', previous!.suppressed); }
    assertEpoch(epoch);
  });
}
async function collectOriginals(database: SQLiteDatabase) {
  const records = await database.getAllAsync<{ record_json: string }>('SELECT record_json FROM gift_records');
  return collectGiftOriginalFiles(new Set(records.flatMap(row => giftSyncOriginalRecords(JSON.parse(row.record_json)))
    .map(original => String(original.storageName))));
}
async function resolveSecrets(identity: SyncDevicePublicIdentityV1, secrets?: SyncDeviceSecretsV1) {
  const selected = secrets ?? (await loadCurrentSyncDevice())?.secrets;
  if (!selected) throw Error('gift-sync-secrets-required');
  assertMatchingSyncDeviceIdentity(identity, selected); return selected;
}

/** Capture the saved version, and reuse an already verified binding for an unchanged original. */
async function preparePayload(payload: GiftSyncPayload, identity: SyncDevicePublicIdentityV1, secrets?: SyncDeviceSecretsV1): Promise<GiftSyncPayload> {
  if (!('record' in payload) || payload.kind !== 'gift') return payload;
  const originals = [...new Map(giftSyncOriginalRecords(payload.record).map(original => [String(original.id), original])).values()];
  if (!originals.length) return { ...payload, originals: [] };
  const secret = await resolveSecrets(identity, secrets), keys = deriveSyncVaultKeysV1(base64UrlToBytes(secret.vaultRootSecret, 'gift sync root', 32));
  const known = (await heads(identity.vaultId)).find(group => group.kind === 'gift' && group.id === payload.record.id)?.mutations ?? [];
  const prepared: GiftSyncOriginal[] = [];
  for (const original of originals) {
    const bindings = known.flatMap(mutation => {
      const prior = mutation.payload as unknown as GiftSyncPayload;
      return 'record' in prior && prior.kind === 'gift'
        && giftSyncOriginalRecords(prior.record).some(item => json(item) === json(original))
        ? (prior.originals ?? []).filter(item => item.id === original.id) : [];
    });
    if (new Set(bindings.map(binding => binding.objectId)).size > 1) throw Error('gift-sync-original-binding-conflict');
    const prior = bindings[0];
    if (prior) {
      const manifest = await loadSyncObjectExpoManifest(prior.objectId);
      if (manifest) {
        if (manifest.plaintextBytes !== prior.plaintextBytes || manifest.chunks.length !== prior.chunkCount) throw Error('gift-sync-original-size-mismatch');
        await ensureAndroidContentObjectUpload({ objectId: prior.objectId, keyId: identity.keyId, totalChunks: prior.chunkCount,
          objectIdKey: keys.objectIdKey, now: Date.now() });
      }
      prepared.push(prior); continue;
    }
    const sourceUri = giftOriginalUri({ storageName: String(original.storageName) });
    const info = await FileSystem.getInfoAsync(sourceUri);
    if (!info.exists || info.isDirectory || info.size !== original.byteSize) throw Error('gift-sync-original-size-mismatch');
    const captured = await captureSyncContentObject({ sourceUri, stagingToken: expoSyncRandomUuidV1(), keyId: identity.keyId,
      objectIdKey: keys.objectIdKey, files: syncObjectExpoFilePort, jobs: { scheduleUpload: scheduleSyncObjectUpload }, now: Date.now() });
    if (captured.manifest.plaintextBytes !== original.byteSize) throw Error('gift-sync-original-size-mismatch');
    prepared.push({ id: String(original.id), storageName: String(original.storageName), objectId: captured.objectId,
      plaintextBytes: captured.manifest.plaintextBytes, chunkCount: captured.manifest.chunks.length, mediaType: String(original.mimeType) });
  }
  return { ...payload, originals: prepared };
}

export async function activateAndroidGiftSyncCapture(identity: SyncDevicePublicIdentityV1, _secrets?: SyncDeviceSecretsV1) {
  assertIdentity(identity);
  // Emergency rebuild already owns the exclusive coordinator lease. Only these
  // existing technical tables change; acquiring a shared business lease here deadlocks it.
  const database = await getMemoryDatabase(), currentHeads = await heads(identity.vaultId), world = JSON.stringify([identity.vaultId, identity.keyId]);
  let captured = 0;
  await database.withExclusiveTransactionAsync(async transaction => {
    const runtime = await transaction.getFirstAsync<{ world_id: string | null }>('SELECT world_id FROM gift_sync_runtime WHERE singleton=1');
    if (runtime!.world_id !== null && runtime!.world_id !== world) {
      await transaction.runAsync('DELETE FROM gift_sync_changes'); await transaction.runAsync('DELETE FROM gift_sync_heads');
    }
    const pending = await transaction.getAllAsync<GiftSyncChange>('SELECT * FROM gift_sync_changes ORDER BY seq');
    // Only identical raw snapshots are redundant. Offline edits/deletes keep their captured parents.
    for (const row of pending.filter(row => row.mutation_json === null)) {
      const raw = JSON.parse(row.payload_json) as GiftSyncPayload;
      const central = currentHeads.find(group => group.kind === row.kind && group.id === row.entity_id);
      if (central?.mutations.length !== 1) continue;
      const mutation = central.mutations[0], payload = mutation.payload as unknown as GiftSyncPayload;
      if (!('record' in raw) || !('record' in payload) || json(raw.record) !== json(payload.record)) continue;
      await transaction.runAsync('DELETE FROM gift_sync_changes WHERE seq=? AND mutation_json IS NULL', row.seq);
      await transaction.runAsync(`INSERT INTO gift_sync_heads(kind,entity_id,revision_id) VALUES(?,?,?)
        ON CONFLICT(kind,entity_id) DO UPDATE SET revision_id=excluded.revision_id`, row.kind, row.entity_id, mutation.revision.id);
    }
    for (const spec of GIFT_SYNC_SPECS) {
      const records = await transaction.getAllAsync<{ entity_id: string; record_json: string }>(
        `SELECT ${spec.id('r')} AS entity_id, ${spec.record('r')} AS record_json FROM ${spec.table} r ORDER BY entity_id`);
      for (const row of records) {
        if (await transaction.getFirstAsync('SELECT 1 FROM gift_sync_heads WHERE kind=? AND entity_id=?', spec.kind, row.entity_id)) continue;
        if (await transaction.getFirstAsync('SELECT 1 FROM gift_sync_changes WHERE kind=? AND entity_id=?', spec.kind, row.entity_id)) continue;
        const record = JSON.parse(row.record_json) as GiftSyncRow;
        const matching = currentHeads.find(group => group.kind === spec.kind && group.id === row.entity_id)?.mutations
          .filter(mutation => { const payload = mutation.payload as unknown as GiftSyncPayload; return 'record' in payload && json(payload.record) === json(record); }) ?? [];
        const revision = matching.length === 1 ? matching[0].revision.id : expoSyncRandomUuidV1();
        if (!matching.length) {
          await transaction.runAsync(`INSERT INTO gift_sync_changes(kind,entity_id,payload_json,mutation_id,revision_id,parent_ids_json)
            VALUES(?,?,?,?,?,'[]')`, spec.kind, row.entity_id, JSON.stringify({ schemaVersion: 1, kind: spec.kind, record }), expoSyncRandomUuidV1(), revision);
          captured++;
        }
        if (matching.length > 1) continue;
        await transaction.runAsync('INSERT INTO gift_sync_heads(kind,entity_id,revision_id) VALUES(?,?,?)', spec.kind, row.entity_id, revision);
      }
    }
    await transaction.runAsync('UPDATE gift_sync_runtime SET world_id=? WHERE singleton=1', world);
  });
  return { captured };
}

export async function promotePendingAndroidGiftSyncMutations(identity: SyncDevicePublicIdentityV1, secrets?: SyncDeviceSecretsV1, limit = 30) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw Error('gift-sync-invalid-limit');
  await activateAndroidGiftSyncCapture(identity, secrets);
  return withGiftStoreWrite(async () => {
    const epoch = captureBackupRestoreDataEpoch(), database = await getMemoryDatabase();
    const rows = await database.getAllAsync<GiftSyncChange>('SELECT * FROM gift_sync_changes ORDER BY seq LIMIT ?', limit);
    let promoted = 0;
    for (const row of rows) {
      let mutation: PlainMutationV1;
      if (row.mutation_json) { mutation = JSON.parse(row.mutation_json); assertGiftsLifeMutationV1(mutation); }
      else {
        const payload = await preparePayload(JSON.parse(row.payload_json) as GiftSyncPayload, identity, secrets); assertEpoch(epoch);
        mutation = buildGiftSyncMutation({ mutationId: row.mutation_id, revisionId: row.revision_id,
          parentRevisionIds: JSON.parse(row.parent_ids_json), vaultId: identity.vaultId, sourceDeviceId: identity.deviceId,
          sourceSequence: await allocateSyncSourceSequence(identity.deviceId, Date.now()), createdAt: Date.now() }, row.entity_id, payload);
        assertEpoch(epoch);
        await database.runAsync('UPDATE gift_sync_changes SET mutation_json=? WHERE seq=? AND mutation_json IS NULL', JSON.stringify(mutation), row.seq);
      }
      if (mutation.vaultId !== identity.vaultId) throw Error('gift-sync-world-changed');
      assertEpoch(epoch);
      await applyVerifiedAndroidSyncMutation(mutation, Date.now());
      assertEpoch(epoch);
      await enqueueSyncMutation(mutation); assertEpoch(epoch);
      await database.runAsync('DELETE FROM gift_sync_changes WHERE seq=? AND mutation_id=?', row.seq, row.mutation_id);
      promoted++;
    }
    // Re-project after promotion so a concurrent delete wins without replacing central heads.
    for (const row of rows) await projectEntity(database, row.kind, row.entity_id, false);
    const pending = await database.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM gift_sync_changes');
    return { promoted, pending: pending!.count };
  });
}

export async function hasPendingAndroidGiftSyncChanges(): Promise<boolean> {
  return !!await (await getMemoryDatabase()).getFirstAsync('SELECT 1 FROM gift_sync_changes LIMIT 1');
}

async function saveChild(transaction: SQLiteDatabase, kind: Exclude<GiftSyncKind, 'gift'>, incoming: GiftSyncRow) {
  const { table, keys } = childTables[kind], record = { ...incoming };
  const previous = await transaction.getFirstAsync<GiftSyncRow>(`SELECT * FROM ${table} WHERE ${keys.map(key => `${key}=?`).join(' AND ')}`,
    ...keys.map(key => record[key] as string | number | null));
  if (kind === 'echo') {
    const { sequence: _sequence, read_at: _readAt, ...body } = record;
    if (previous) {
      const { sequence: _oldSequence, read_at: _oldReadAt, ...oldBody } = previous;
      if (json(body) !== json(oldBody)) throw Error('gift-sync-echo-conflict');
      record.sequence = previous.sequence;
      record.read_at = previous.read_at === null && record.read_at === null ? null : Math.max(Number(previous.read_at ?? 0), Number(record.read_at ?? 0));
    } else {
      if (record.reply_to_id !== null && await transaction.getFirstAsync('SELECT 1 FROM gift_echoes WHERE gift_id=? AND reply_to_id=?', String(record.gift_id), String(record.reply_to_id))) throw Error('gift-sync-echo-reply-conflict');
      if (await transaction.getFirstAsync('SELECT 1 FROM gift_echoes WHERE gift_id=? AND sequence=?', String(record.gift_id), Number(record.sequence))) {
        record.sequence = (await transaction.getFirstAsync<{ value: number }>('SELECT COALESCE(MAX(sequence),0)+1 AS value FROM gift_echoes WHERE gift_id=?', String(record.gift_id)))!.value;
      }
    }
  } else if (kind === 'understanding' && previous && json(previous) !== json(record)) throw Error('gift-sync-understanding-conflict');
  const columns = Object.keys(record);
  await transaction.runAsync(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})
    ON CONFLICT(${keys.join(',')}) DO UPDATE SET ${columns.filter(column => !(keys as readonly string[]).includes(column)).map(column => `${column}=excluded.${column}`).join(',')}`,
  ...columns.map(column => record[column] as string | number | null));
}
async function projectEntity(database: SQLiteDatabase, kind: GiftSyncKind, id: string, strict: boolean) {
  const currentHeads = await heads(), group = currentHeads.find(group => group.kind === kind && group.id === id);
  let mutation = group ? selectGiftSyncHead(group.mutations) : null;
  if (!mutation) return { handled: true, ignored: true };
  let payload = mutation.payload as unknown as GiftSyncPayload;
  const giftId = giftSyncGiftId(payload), deleted = await historicalDelete(giftId);
  if (deleted) {
    if (kind !== 'gift') return { handled: true, ignored: true };
    if (deleted === 'compacted') {
      await suppressed(database, async transaction => {
        await deleteGiftRelationsWithDatabase(transaction, giftId, 'keep-memory');
        await transaction.runAsync('DELETE FROM gift_records WHERE id=?', giftId);
      });
      await collectOriginals(database); emitGiftChanges();
      return { handled: true, ignored: true };
    }
    mutation = deleted; payload = deleted.payload as unknown as GiftSyncPayload;
  }
  if (await database.getFirstAsync('SELECT 1 FROM gift_sync_changes WHERE kind=? AND entity_id=? LIMIT 1', kind, id)) {
    if (strict) throw Error('gift-sync-local-changes-pending');
    return { handled: true, ignored: true };
  }
  const previous = await nativeGift(database, giftId);
  if ('record' in payload && kind !== 'gift') {
    if (!previous) return { handled: true, ignored: true };
    const row = payload.record, attachments = previous.attachments as unknown as { id: string; kind: string; original?: { id: string } }[];
    if (kind !== 'activity' && (row.gift_revision !== previous.revision || previous.openedAt === null)) return { handled: true, ignored: true };
    if (row.attachment_id !== null && row.attachment_id !== undefined) {
      const attached = attachments.find(item => item.id === row.attachment_id);
      if (!attached || row.original_id != null && attached.original?.id !== row.original_id) return { handled: true, ignored: true };
    }
  }
  if ('record' in payload && kind === 'gift') assertGiftSyncFrozenOriginal(previous, payload.record);
  await suppressed(database, async transaction => {
    if (!('record' in payload)) {
      if (kind === 'gift') {
        await deleteGiftRelationsWithDatabase(transaction, giftId, payload.deleteRelatedMemory ? 'delete-related-memory' : 'keep-memory');
        await transaction.runAsync('DELETE FROM gift_records WHERE id=?', giftId);
      } else {
        const { table, keys } = childTables[kind];
        const rows = await transaction.getAllAsync<GiftSyncRow>(`SELECT * FROM ${table} WHERE gift_id=?`, giftId);
        for (const row of rows) if (giftSyncEntityId(kind, row) === id) await transaction.runAsync(`DELETE FROM ${table} WHERE ${keys.map(key => `${key}=?`).join(' AND ')}`,
          ...keys.map(key => row[key] as string | number | null));
      }
    } else if (kind === 'gift') {
      await transaction.runAsync(`INSERT INTO gift_records(id,revision,record_json) VALUES(?,?,?)
        ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,record_json=excluded.record_json`, giftId, Number(payload.record.revision), JSON.stringify(payload.record));
    } else await saveChild(transaction, kind, payload.record);
    await transaction.runAsync(`INSERT INTO gift_sync_heads(kind,entity_id,revision_id) VALUES(?,?,?)
      ON CONFLICT(kind,entity_id) DO UPDATE SET revision_id=excluded.revision_id`, kind, id, mutation!.revision.id);
  });
  if (kind === 'gift') {
    if ('record' in payload) {
      for (const child of currentHeads.filter(group => group.kind !== 'gift')) {
        const selected = selectGiftSyncHead(child.mutations);
        if (selected && giftSyncGiftId(selected.payload as unknown as GiftSyncPayload) === giftId) await projectEntity(database, child.kind, child.id, false);
      }
      await copyCurrentOriginals(database, mutation);
    }
    await collectOriginals(database);
  }
  emitGiftChanges(); return { handled: true };
}

export async function materializeAndroidGiftMutation(mutation: PlainMutationV1) {
  if (mutation.entity.domain !== 'gifts') return { handled: false };
  assertGiftsLifeMutationV1(mutation);
  return withGiftStoreWrite(async () => projectEntity(await getMemoryDatabase(), mutation.entity.type as GiftSyncKind, mutation.entity.id, true));
}

async function copyCurrentOriginals(database: SQLiteDatabase, mutation: PlainMutationV1, object?: { objectId: string; localUri: string }) {
  const epoch = captureBackupRestoreDataEpoch(); assertEpoch(epoch);
  const payload = mutation.payload as unknown as Upsert, giftId = giftSyncGiftId(payload);
  if (!('record' in payload) || payload.kind !== 'gift' || await historicalDelete(giftId)
    || json(await nativeGift(database, giftId)) !== json(payload.record)) return { handled: false, changed: false };
  const current = (await heads()).find(group => group.kind === 'gift' && group.id === giftId);
  if (!current || selectGiftSyncHead(current.mutations)?.revision.id !== mutation.revision.id) return { handled: false, changed: false };
  let changed = false, pending = false;
  for (const original of payload.originals ?? []) {
    if (object && object.objectId !== original.objectId) continue;
    const job = object ? null : await loadSyncObjectJob(original.objectId);
    const localUri = object?.localUri ?? (job?.state === 'verified' ? job.localUri : null);
    if (!localUri) { pending = true; continue; }
    const info = await FileSystem.getInfoAsync(localUri);
    assertEpoch(epoch);
    if (!info.exists || info.isDirectory || info.size !== original.plaintextBytes) throw Error('gift-sync-original-size-mismatch');
    if (await historicalDelete(giftId) || json(await nativeGift(database, giftId)) !== json(payload.record)) continue;
    const target = giftOriginalUri(original), existing = await FileSystem.getInfoAsync(target);
    if (existing.exists) {
      if (existing.isDirectory || existing.size !== original.plaintextBytes
        || await FileSystem.readAsStringAsync(target, { encoding: FileSystem.EncodingType.Base64 })
          !== await FileSystem.readAsStringAsync(localUri, { encoding: FileSystem.EncodingType.Base64 })) throw Error('gift-sync-original-binding-conflict');
    } else await copyFileSafely({ from: localUri, to: target, minimumBytes: original.plaintextBytes });
    assertEpoch(epoch);
    if (await historicalDelete(giftId)) { await projectEntity(database, 'gift', giftId, false); return { handled: false, changed: false }; }
    if (json(await nativeGift(database, giftId)) !== json(payload.record)) { await collectOriginals(database); continue; }
    changed ||= !existing.exists;
  }
  return { handled: !pending, pending, changed };
}
export const materializeAndroidGiftObject: AndroidSyncObjectMaterializer['materializeVerifiedObject'] = async input => {
  if (!/^file:\/\//.test(input.localUri)) throw Error('gift-sync-invalid-object-uri');
  return withGiftStoreWrite(async () => {
    const database = await getMemoryDatabase(); let handled = false, pending = false, changed = false;
    for (const group of (await heads()).filter(group => group.kind === 'gift')) {
      const mutation = selectGiftSyncHead(group.mutations);
      if (!mutation || mutation.revision.operation === 'delete' || !mutation.objectRefs.includes(input.objectId)) continue;
      const result = await copyCurrentOriginals(database, mutation, input);
      handled ||= result.handled; pending ||= result.pending === true; changed ||= result.changed;
    }
    if (changed) emitGiftChanges();
    return { handled, ...(pending ? { pending } : {}), changed };
  });
};

/** Snapshot only prepares objects and returns records; the baseline pipeline owns re-enveloping. */
export async function collectAndroidGiftCurrentSnapshotMutations(input: {
  identity?: SyncDevicePublicIdentityV1; secrets?: SyncDeviceSecretsV1; now?: number;
} = {}) {
  const current = input.identity ? { identity: input.identity, secrets: input.secrets } : await loadCurrentSyncDevice();
  const database = await getMemoryDatabase(), mutations: PlainMutationV1[] = [];
  const records: { kind: GiftSyncKind; entity_id: string; record_json: string }[] = [];
  // Read a coherent business snapshot without requesting a nested coordinator lease.
  await database.withExclusiveTransactionAsync(async transaction => {
    for (const spec of GIFT_SYNC_SPECS) {
      const rows = await transaction.getAllAsync<{ entity_id: string; record_json: string }>(
        `SELECT ${spec.id('r')} AS entity_id, ${spec.record('r')} AS record_json FROM ${spec.table} r ORDER BY entity_id`);
      records.push(...rows.map(row => ({ ...row, kind: spec.kind })));
    }
  });
  for (const row of records) {
    if (!current) throw Error('gift-sync-current-device-required'); assertIdentity(current.identity);
    const payload = await preparePayload({ schemaVersion: 1, kind: row.kind, record: JSON.parse(row.record_json) }, current.identity, current.secrets);
    mutations.push(buildGiftSyncMutation({ mutationId: expoSyncRandomUuidV1(), revisionId: expoSyncRandomUuidV1(), parentRevisionIds: [],
      vaultId: current.identity.vaultId, sourceDeviceId: current.identity.deviceId, sourceSequence: mutations.length + 1,
      createdAt: input.now ?? Date.now() }, row.entity_id, payload));
  }
  return mutations;
}
