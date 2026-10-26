import * as Crypto from 'expo-crypto';
import * as SQLite from 'expo-sqlite';

import {
  openDatabaseImportSource,
  type DatabaseImportSource,
} from '../backup/sqliteBackupFiles';
import {
  validateCameraVisionStructuredResult,
  type CameraVisionStructuredResultV1,
} from './cameraVisionStructured';
import {
  CAMERA_OBSERVATION_DATABASE_NAME,
  CAMERA_OBSERVATION_SCHEMA_VERSION,
  CAMERA_OBSERVATION_TRIGGER_KINDS,
  type CameraObservationBackupInspection,
  type CameraObservationCursor,
  type CameraObservationDeleteReason,
  type CameraObservationHistoryPage,
  type CameraObservationHistorySummary,
  type CameraObservationPersistInput,
  type CameraObservationRecordV1,
  type CameraObservationReplyDraft,
  type CameraObservationResponse,
  type CameraObservationResponseBinding,
  type CameraObservationTimelineItem,
} from './cameraObservationTypes';

const PAGE_SIZE = 30;

type ObservationRow = {
  observation_id: string;
  action_id: string;
  request_id: string;
  session_id: string;
  trigger_kind: CameraObservationRecordV1['triggerKind'];
  source_kind: CameraObservationRecordV1['sourceKind'];
  captured_at: number;
  analyzed_at: number;
  persisted_at: number;
  width: number;
  height: number;
  rotation: number;
  mirrored: number;
  provider: string;
  model: string;
  latency_ms: number;
  attempt_count: number;
  repair_used: number;
  response_format_requested: number;
  result_json: string;
  idempotency_sha256: string;
};

type TimelineRow = Pick<
  ObservationRow,
  'observation_id' | 'captured_at' | 'source_kind' | 'trigger_kind' | 'result_json'
> & { response_status?: CameraObservationResponse['status'] | null };

type ResponseRow = {
  observation_id: string;
  delivery_status: string;
  target_session_id: string;
  origin: CameraObservationResponseBinding['origin'];
  source_turn_id: string;
  requested_at: number;
  draft_json: string | null;
  message_ids_json: string;
};

let databasePromise: Promise<SQLite.SQLiteDatabase> | undefined;
const savedObservationListeners = new Set<() => void>();

export function subscribeSavedCameraObservations(listener: () => void) {
  savedObservationListeners.add(listener);
  return () => { savedObservationListeners.delete(listener); };
}

function notifySavedObservation() {
  for (const listener of savedObservationListeners) {
    try { listener(); } catch { /* A UI observer cannot undo the committed record. */ }
  }
}

function observationError(code: string) {
  return new Error(code);
}

function throwIfObservationPersistCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw observationError('camera_vision_cancelled');
}

function assertResponseCanCommit(canCommit?: () => boolean) {
  if (canCommit && !canCommit()) throw observationError('camera_observation_response_cancelled');
}

function assertNonEmpty(value: unknown, code = 'camera_observation_persist_failed'): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw observationError(code);
}

function assertSafeInteger(value: unknown, code = 'camera_observation_persist_failed'): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw observationError(code);
  }
}

function assertCaptureDimension(value: unknown) {
  assertSafeInteger(value);
  if (value < 1 || value > 16_384) throw observationError('camera_observation_persist_failed');
}

function validateResponseBinding(binding: CameraObservationResponseBinding) {
  const code = 'camera_observation_response_invalid';
  assertNonEmpty(binding.targetSessionId, code);
  assertNonEmpty(binding.sourceTurnId, code);
  assertSafeInteger(binding.requestedAt, code);
  if (!['manual_share', 'chat_tool', 'proactive_tool'].includes(binding.origin)) throw observationError(code);
}

function validateReplyDraft(draft: CameraObservationReplyDraft) {
  const code = 'camera_observation_reply_draft_invalid';
  assertNonEmpty(draft.replyId, code);
  if (!Array.isArray(draft.messages) || draft.messages.length === 0) throw observationError(code);
  const ids = new Set<string>();
  for (const message of draft.messages) {
    if (!message || message.role !== 'I' || message.deliveryStatus === 'failed') throw observationError(code);
    assertNonEmpty(message.id, code);
    assertNonEmpty(message.content, code);
    assertSafeInteger(message.createdAt, code);
    if (ids.has(message.id)) throw observationError(code);
    ids.add(message.id);
    if ('reasoning' in message || 'reasoning_content' in message || 'reasoningContent' in message) {
      throw observationError(code);
    }
  }
  if (draft.adoptedReply !== undefined && typeof draft.adoptedReply !== 'string') throw observationError(code);
}

function responseFromRow(row: ResponseRow): CameraObservationResponse {
  const binding: CameraObservationResponseBinding = {
    targetSessionId: row.target_session_id,
    origin: row.origin,
    sourceTurnId: row.source_turn_id,
    requestedAt: row.requested_at,
  };
  validateResponseBinding(binding);
  if (!['pending', 'draft_ready', 'delivered', 'cancelled'].includes(row.delivery_status)) {
    throw observationError('camera_observation_response_invalid');
  }
  const messageIds: unknown = JSON.parse(row.message_ids_json);
  if (!Array.isArray(messageIds) || messageIds.some(id => typeof id !== 'string' || !id.trim())
    || new Set(messageIds).size !== messageIds.length) throw observationError('camera_observation_response_invalid');
  const draft: CameraObservationReplyDraft | undefined = row.draft_json ? JSON.parse(row.draft_json) : undefined;
  if (draft) validateReplyDraft(draft);
  if (row.delivery_status === 'draft_ready') {
    if (!draft || JSON.stringify(messageIds) !== JSON.stringify(draft.messages.map(message => message.id))) {
      throw observationError('camera_observation_response_invalid');
    }
  } else if (draft || (row.delivery_status !== 'delivered' && messageIds.length > 0)) {
    throw observationError('camera_observation_response_invalid');
  }
  if (row.delivery_status === 'delivered' && messageIds.length === 0) {
    throw observationError('camera_observation_response_invalid');
  }
  return {
    observationId: row.observation_id,
    binding,
    status: row.delivery_status as CameraObservationResponse['status'],
    draft,
    messageIds: messageIds as string[],
  };
}

async function loadResponse(database: SQLite.SQLiteDatabase, observationId: string) {
  const row = await database.getFirstAsync<ResponseRow>(
    'SELECT * FROM camera_observation_response_obligations WHERE observation_id = ?;', observationId,
  );
  return row ? responseFromRow(row) : undefined;
}

async function assertResponseBindingMatches(
  database: SQLite.SQLiteDatabase,
  observationId: string,
  binding?: CameraObservationResponseBinding,
) {
  const response = await loadResponse(database, observationId);
  if (Boolean(response) !== Boolean(binding) || (response && binding && (
    response.binding.targetSessionId !== binding.targetSessionId
    || response.binding.origin !== binding.origin
    || response.binding.sourceTurnId !== binding.sourceTurnId
    || response.binding.requestedAt !== binding.requestedAt
  ))) {
    throw observationError('camera_observation_idempotency_conflict');
  }
}

function parseResultJson(value: string): CameraVisionStructuredResultV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw observationError('camera_observation_store_unavailable');
  }
  const validated = validateCameraVisionStructuredResult(parsed);
  if (!validated.success) throw observationError('camera_observation_store_unavailable');
  return validated.result;
}

function validatePersistInput(input: CameraObservationPersistInput) {
  assertNonEmpty(input.actionId);
  assertNonEmpty(input.requestId);
  assertNonEmpty(input.sessionId);
  if (!CAMERA_OBSERVATION_TRIGGER_KINDS.includes(input.triggerKind)) {
    throw observationError('camera_observation_persist_failed');
  }
  if (input.sourceKind !== 'android_front' && input.sourceKind !== 'android_back' && input.sourceKind !== 'pc_webcam') {
    throw observationError('camera_observation_persist_failed');
  }
  assertSafeInteger(input.capturedAt);
  assertSafeInteger(input.analyzedAt);
  assertCaptureDimension(input.capture.width);
  assertCaptureDimension(input.capture.height);
  if (![0, 90, 180, 270].includes(input.capture.rotation)) {
    throw observationError('camera_observation_persist_failed');
  }
  if (typeof input.capture.mirrored !== 'boolean') throw observationError('camera_observation_persist_failed');
  assertNonEmpty(input.analysis.provider);
  assertNonEmpty(input.analysis.model);
  assertSafeInteger(input.analysis.latencyMs);
  if (input.analysis.attemptCount !== 1 && input.analysis.attemptCount !== 2) {
    throw observationError('camera_observation_persist_failed');
  }
  if (typeof input.analysis.repairUsed !== 'boolean' || typeof input.analysis.responseFormatRequested !== 'boolean') {
    throw observationError('camera_observation_persist_failed');
  }
  const validated = validateCameraVisionStructuredResult(input.result);
  if (!validated.success) throw observationError('camera_observation_persist_failed');
  if (
    input.cleanup.cleanupState !== 'verified_deleted'
    || input.cleanup.deletionVerified !== true
    || typeof input.cleanup.auditPersisted !== 'boolean'
  ) {
    throw observationError('camera_observation_persist_failed');
  }
  assertSafeInteger(input.cleanup.completedAt);
}

function idempotencyPayload(input: CameraObservationPersistInput) {
  return JSON.stringify({
    actionId: input.actionId,
    requestId: input.requestId,
    sessionId: input.sessionId,
    triggerKind: input.triggerKind,
    sourceKind: input.sourceKind,
    capturedAt: input.capturedAt,
    analyzedAt: input.analyzedAt,
    capture: input.capture,
    analysis: input.analysis,
    result: input.result,
    cleanup: input.cleanup,
  });
}

async function digestPayload(input: CameraObservationPersistInput) {
  return Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    idempotencyPayload(input),
  );
}

function fromRow(row: ObservationRow, cleanup: { completed_at: number; audit_persisted: number }): CameraObservationRecordV1 {
  if (![0, 90, 180, 270].includes(row.rotation)) throw observationError('camera_observation_store_unavailable');
  if (row.attempt_count !== 1 && row.attempt_count !== 2) throw observationError('camera_observation_store_unavailable');
  const result = parseResultJson(row.result_json);
  return {
    schemaVersion: 1,
    observationId: row.observation_id,
    actionId: row.action_id,
    requestId: row.request_id,
    sessionId: row.session_id,
    triggerKind: row.trigger_kind,
    sourceKind: row.source_kind,
    capturedAt: row.captured_at,
    analyzedAt: row.analyzed_at,
    persistedAt: row.persisted_at,
    capture: {
      width: row.width,
      height: row.height,
      rotation: row.rotation as 0 | 90 | 180 | 270,
      mirrored: row.mirrored === 1,
    },
    analysis: {
      provider: row.provider,
      model: row.model,
      latencyMs: row.latency_ms,
      attemptCount: row.attempt_count,
      repairUsed: row.repair_used === 1,
      responseFormatRequested: row.response_format_requested === 1,
    },
    result,
    cleanup: {
      cleanupState: 'verified_deleted',
      deletionVerified: true,
      completedAt: cleanup.completed_at,
      auditPersisted: cleanup.audit_persisted === 1,
    },
  };
}

function timelineFromRow(row: TimelineRow): CameraObservationTimelineItem {
  const result = parseResultJson(row.result_json);
  return {
    observationId: row.observation_id,
    capturedAt: row.captured_at,
    sourceKind: row.source_kind,
    triggerKind: row.trigger_kind,
    sceneSummary: result.sceneSummary,
    frameUsability: result.frameUsability,
    overallConfidence: result.overallConfidence,
    visibleCount: result.subjectVisibility.visibleCount,
    responseStatus: row.response_status ?? 'not_scheduled',
  };
}

async function repairOrphanObservationChildren(database: SQLite.SQLiteDatabase) {
  await database.withExclusiveTransactionAsync(async (transaction) => {
    await transaction.execAsync(`
      DELETE FROM camera_observation_response_obligations
      WHERE NOT EXISTS (
        SELECT 1 FROM camera_observations
        WHERE camera_observations.observation_id = camera_observation_response_obligations.observation_id
      );
      DELETE FROM camera_observation_cleanup_receipts
      WHERE NOT EXISTS (
        SELECT 1 FROM camera_observations
        WHERE camera_observations.observation_id = camera_observation_cleanup_receipts.observation_id
      );
      DELETE FROM camera_observation_trigger_receipts
      WHERE NOT EXISTS (
        SELECT 1 FROM camera_observations
        WHERE camera_observations.observation_id = camera_observation_trigger_receipts.observation_id
      );
    `);
  });
}

async function initializeDatabase(database: SQLite.SQLiteDatabase) {
  await database.execAsync('PRAGMA foreign_keys = ON;');
  const versionRow = await database.getFirstAsync<{ user_version: number }>('PRAGMA user_version;');
  const version = versionRow?.user_version ?? 0;
  if (version > CAMERA_OBSERVATION_SCHEMA_VERSION) {
    throw observationError('camera_observation_store_unavailable');
  }
  if (version < CAMERA_OBSERVATION_SCHEMA_VERSION) {
    await database.withExclusiveTransactionAsync(async (transaction) => {
      await transaction.execAsync(`
        CREATE TABLE IF NOT EXISTS camera_observation_schema_meta (
          schema_version INTEGER PRIMARY KEY NOT NULL,
          migrated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS camera_observations (
          observation_id TEXT PRIMARY KEY NOT NULL,
          action_id TEXT NOT NULL UNIQUE,
          request_id TEXT NOT NULL UNIQUE,
          session_id TEXT NOT NULL,
          trigger_kind TEXT NOT NULL,
          source_kind TEXT NOT NULL,
          captured_at INTEGER NOT NULL,
          analyzed_at INTEGER NOT NULL,
          persisted_at INTEGER NOT NULL,
          width INTEGER NOT NULL,
          height INTEGER NOT NULL,
          rotation INTEGER NOT NULL,
          mirrored INTEGER NOT NULL,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          latency_ms INTEGER NOT NULL,
          attempt_count INTEGER NOT NULL,
          repair_used INTEGER NOT NULL,
          response_format_requested INTEGER NOT NULL,
          result_json TEXT NOT NULL,
          idempotency_sha256 TEXT NOT NULL,
          memory_ingestion_eligible INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS camera_observation_trigger_receipts (
          observation_id TEXT PRIMARY KEY NOT NULL REFERENCES camera_observations(observation_id) ON DELETE CASCADE,
          trigger_kind TEXT NOT NULL,
          requested_at INTEGER NOT NULL,
          action_id TEXT NOT NULL UNIQUE,
          request_id TEXT NOT NULL UNIQUE
        );
        CREATE TABLE IF NOT EXISTS camera_observation_cleanup_receipts (
          observation_id TEXT PRIMARY KEY NOT NULL REFERENCES camera_observations(observation_id) ON DELETE CASCADE,
          cleanup_state TEXT NOT NULL CHECK(cleanup_state = 'verified_deleted'),
          deletion_verified INTEGER NOT NULL CHECK(deletion_verified = 1),
          completed_at INTEGER NOT NULL,
          audit_persisted INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS camera_observation_response_obligations (
          observation_id TEXT PRIMARY KEY NOT NULL REFERENCES camera_observations(observation_id) ON DELETE CASCADE,
          delivery_status TEXT NOT NULL,
          message_id TEXT
        );
        CREATE TABLE IF NOT EXISTS camera_observation_deletion_tombstones (
          observation_id TEXT PRIMARY KEY NOT NULL,
          deleted_at INTEGER NOT NULL,
          delete_reason TEXT NOT NULL,
          response_delivery_status TEXT,
          message_id TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_camera_observations_timeline
          ON camera_observations(captured_at DESC, observation_id DESC);
        CREATE INDEX IF NOT EXISTS idx_camera_observations_source
          ON camera_observations(source_kind);
        CREATE INDEX IF NOT EXISTS idx_camera_observations_trigger
          ON camera_observations(trigger_kind);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_camera_observations_request
          ON camera_observations(request_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_camera_observations_action
          ON camera_observations(action_id);
      `);
      const columns = await transaction.getAllAsync<{ name: string }>('PRAGMA table_info(camera_observations);');
      if (!columns.some(column => column.name === 'memory_ingestion_eligible')) {
        // Existing test observations stay readable without entering automatic extraction.
        await transaction.execAsync('ALTER TABLE camera_observations ADD COLUMN memory_ingestion_eligible INTEGER NOT NULL DEFAULT 0;');
      }
      const responseColumns = await transaction.getAllAsync<{ name: string }>(
        'PRAGMA table_info(camera_observation_response_obligations);',
      );
      for (const [name, type] of [
        ['target_session_id', 'TEXT'], ['origin', 'TEXT'], ['source_turn_id', 'TEXT'],
        ['requested_at', 'INTEGER'], ['draft_json', 'TEXT'], ['message_ids_json', "TEXT NOT NULL DEFAULT '[]'"],
      ]) {
        if (!responseColumns.some(column => column.name === name)) {
          await transaction.execAsync(`ALTER TABLE camera_observation_response_obligations ADD COLUMN ${name} ${type};`);
        }
      }
      await transaction.execAsync(`
        CREATE INDEX IF NOT EXISTS idx_camera_observations_memory_eligible
          ON camera_observations(memory_ingestion_eligible, captured_at, observation_id);
        DELETE FROM camera_observation_schema_meta;
        INSERT INTO camera_observation_schema_meta(schema_version, migrated_at)
          VALUES (${CAMERA_OBSERVATION_SCHEMA_VERSION}, ${Date.now()});
        PRAGMA user_version = ${CAMERA_OBSERVATION_SCHEMA_VERSION};
      `);
    });
  }
  await repairOrphanObservationChildren(database);
  const foreignKeyProblems = await database.getAllAsync<Record<string, unknown>>('PRAGMA foreign_key_check;');
  if (foreignKeyProblems.length > 0) throw observationError('camera_observation_store_unavailable');
}

async function getDatabase() {
  if (!databasePromise) {
    databasePromise = SQLite.openDatabaseAsync(CAMERA_OBSERVATION_DATABASE_NAME)
      .then(async (database) => {
        await initializeDatabase(database);
        return database;
      })
      .catch((error) => {
        databasePromise = undefined;
        throw error;
      });
  }
  return databasePromise;
}

async function loadRecordWithDatabase(database: SQLite.SQLiteDatabase, observationId: string) {
  const row = await database.getFirstAsync<ObservationRow>(
    'SELECT * FROM camera_observations WHERE observation_id = ? LIMIT 1;',
    observationId,
  );
  if (!row) return undefined;
  const trigger = await database.getFirstAsync<{ observation_id: string }>(
    `SELECT observation_id
     FROM camera_observation_trigger_receipts
     WHERE observation_id = ?
       AND action_id = ?
       AND request_id = ?
       AND trigger_kind = ?
     LIMIT 1;`,
    observationId,
    row.action_id,
    row.request_id,
    row.trigger_kind,
  );
  const cleanup = await database.getFirstAsync<{ completed_at: number; audit_persisted: number }>(
    `SELECT completed_at, audit_persisted
     FROM camera_observation_cleanup_receipts
     WHERE observation_id = ? AND cleanup_state = 'verified_deleted' AND deletion_verified = 1
     LIMIT 1;`,
    observationId,
  );
  if (!trigger || !cleanup) throw observationError('camera_observation_store_unavailable');
  return fromRow(row, cleanup);
}

async function loadIdempotentRecordWithDatabase(
  database: SQLite.SQLiteDatabase,
  input: Pick<CameraObservationPersistInput, 'actionId' | 'requestId'>,
  digest: string,
  responseBinding?: CameraObservationResponseBinding,
) {
  const existing = await database.getFirstAsync<Pick<ObservationRow, 'observation_id' | 'idempotency_sha256'>>(
    `SELECT observation_id, idempotency_sha256
     FROM camera_observations
     WHERE request_id = ? OR action_id = ?
     ORDER BY CASE WHEN request_id = ? THEN 0 ELSE 1 END
     LIMIT 1;`,
    input.requestId,
    input.actionId,
    input.requestId,
  );
  if (!existing) return undefined;
  if (existing.idempotency_sha256 !== digest) {
    throw observationError('camera_observation_idempotency_conflict');
  }
  await assertResponseBindingMatches(database, existing.observation_id, responseBinding);
  return loadRecordWithDatabase(database, existing.observation_id);
}

async function reconcileCommittedObservation(
  database: SQLite.SQLiteDatabase,
  input: Pick<CameraObservationPersistInput, 'actionId' | 'requestId'>,
  digest: string,
  responseBinding?: CameraObservationResponseBinding,
) {
  try {
    const record = await loadIdempotentRecordWithDatabase(database, input, digest, responseBinding);
    if (record) return record;
  } catch (error) {
    if (error instanceof Error && error.message === 'camera_observation_idempotency_conflict') throw error;
  }

  // Expo SQLite may surface a native execAsync rejection after COMMIT has
  // already reached disk. A fresh read connection distinguishes that bridge
  // settlement failure from a real rollback without replaying the insert.
  const verificationDatabase = await SQLite.openDatabaseAsync(
    CAMERA_OBSERVATION_DATABASE_NAME,
    { useNewConnection: true },
  );
  try {
    return await loadIdempotentRecordWithDatabase(verificationDatabase, input, digest, responseBinding);
  } finally {
    await verificationDatabase.closeAsync();
  }
}

export async function getCameraObservationDatabase() {
  return getDatabase();
}

export async function persistCameraObservation(
  input: CameraObservationPersistInput,
  options: { signal?: AbortSignal; responseBinding?: CameraObservationResponseBinding; canCommit?: () => boolean } = {},
) {
  const assertCurrent = () => {
    throwIfObservationPersistCancelled(options.signal);
    assertResponseCanCommit(options.canCommit);
  };
  assertCurrent();
  throwIfObservationPersistCancelled(options.signal);
  validatePersistInput(input);
  if (options.responseBinding) validateResponseBinding(options.responseBinding);
  const digest = await digestPayload(input);
  assertCurrent();
  throwIfObservationPersistCancelled(options.signal);
  const database = await getDatabase();
  assertCurrent();
  throwIfObservationPersistCancelled(options.signal);
  let observationId = '';
  try {
    await database.withExclusiveTransactionAsync(async (transaction) => {
      assertCurrent();
      throwIfObservationPersistCancelled(options.signal);
      const existing = await transaction.getFirstAsync<Pick<ObservationRow, 'observation_id' | 'idempotency_sha256'>>(
        `SELECT observation_id, idempotency_sha256
         FROM camera_observations
         WHERE request_id = ? OR action_id = ?
         ORDER BY CASE WHEN request_id = ? THEN 0 ELSE 1 END
         LIMIT 1;`,
        input.requestId,
        input.actionId,
        input.requestId,
      );
      throwIfObservationPersistCancelled(options.signal);
      assertCurrent();
      if (existing) {
        if (existing.idempotency_sha256 !== digest) {
          throw observationError('camera_observation_idempotency_conflict');
        }
        await assertResponseBindingMatches(transaction, existing.observation_id, options.responseBinding);
        assertCurrent();
        observationId = existing.observation_id;
        return;
      }
      observationId = `camera-observation-${Crypto.randomUUID()}`;
      const persistedAt = Date.now();
      throwIfObservationPersistCancelled(options.signal);
      await transaction.runAsync(
        `INSERT INTO camera_observations (
          observation_id, action_id, request_id, session_id, trigger_kind, source_kind,
          captured_at, analyzed_at, persisted_at, width, height, rotation, mirrored,
          provider, model, latency_ms, attempt_count, repair_used, response_format_requested,
          result_json, idempotency_sha256, memory_ingestion_eligible
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1);`,
        observationId,
        input.actionId,
        input.requestId,
        input.sessionId,
        input.triggerKind,
        input.sourceKind,
        input.capturedAt,
        input.analyzedAt,
        persistedAt,
        input.capture.width,
        input.capture.height,
        input.capture.rotation,
        input.capture.mirrored ? 1 : 0,
        input.analysis.provider,
        input.analysis.model,
        input.analysis.latencyMs,
        input.analysis.attemptCount,
        input.analysis.repairUsed ? 1 : 0,
        input.analysis.responseFormatRequested ? 1 : 0,
        JSON.stringify(input.result),
        digest,
      );
      assertCurrent();
      throwIfObservationPersistCancelled(options.signal);
      await transaction.runAsync(
        `INSERT INTO camera_observation_trigger_receipts (
          observation_id, trigger_kind, requested_at, action_id, request_id
        ) VALUES (?, ?, ?, ?, ?);`,
        observationId,
        input.triggerKind,
        input.capturedAt,
        input.actionId,
        input.requestId,
      );
      assertCurrent();
      throwIfObservationPersistCancelled(options.signal);
      await transaction.runAsync(
        `INSERT INTO camera_observation_cleanup_receipts (
          observation_id, cleanup_state, deletion_verified, completed_at, audit_persisted
        ) VALUES (?, 'verified_deleted', 1, ?, ?);`,
        observationId,
        input.cleanup.completedAt,
        input.cleanup.auditPersisted ? 1 : 0,
      );
      if (options.responseBinding) {
        assertCurrent();
        const binding = options.responseBinding;
        await transaction.runAsync(
          `INSERT INTO camera_observation_response_obligations (
            observation_id, delivery_status, target_session_id, origin, source_turn_id, requested_at, message_ids_json
          ) VALUES (?, 'pending', ?, ?, ?, ?, '[]');`,
          observationId, binding.targetSessionId, binding.origin, binding.sourceTurnId, binding.requestedAt,
        );
      }
      // Throwing inside the exclusive transaction rolls every observation row
      // back when a page/session cancellation arrives during SQLite work.
      throwIfObservationPersistCancelled(options.signal);
      assertCurrent();
    });
  } catch (error) {
    if (
      error instanceof Error
      && (error.message === 'camera_observation_idempotency_conflict' || error.message === 'camera_vision_cancelled'
        || error.message === 'camera_observation_response_cancelled')
    ) throw error;
    try {
      const committed = await reconcileCommittedObservation(database, input, digest, options.responseBinding);
      if (committed) { notifySavedObservation(); return committed; }
    } catch (reconciliationError) {
      if (
        reconciliationError instanceof Error
        && reconciliationError.message === 'camera_observation_idempotency_conflict'
      ) throw reconciliationError;
    }
    throw observationError('camera_observation_persist_failed');
  }
  const record = await loadRecordWithDatabase(database, observationId);
  if (!record) throw observationError('camera_observation_persist_failed');
  notifySavedObservation();
  return record;
}

export async function getCameraObservationRecord(observationId: string) {
  assertNonEmpty(observationId, 'camera_observation_not_found');
  const record = await loadRecordWithDatabase(await getDatabase(), observationId);
  if (!record) throw observationError('camera_observation_not_found');
  return record;
}

export async function getCameraObservationResponse(observationId: string) {
  assertNonEmpty(observationId, 'camera_observation_response_invalid');
  return loadResponse(await getDatabase(), observationId);
}

export async function listPendingCameraObservationResponses(targetSessionId: string) {
  assertNonEmpty(targetSessionId, 'camera_observation_response_invalid');
  const rows = await (await getDatabase()).getAllAsync<ResponseRow>(
    `SELECT response.* FROM camera_observation_response_obligations AS response
     JOIN camera_observations AS observation ON observation.observation_id = response.observation_id
     WHERE response.target_session_id = ? AND response.delivery_status IN ('pending', 'draft_ready')
     ORDER BY observation.captured_at ASC, observation.observation_id ASC;`, targetSessionId,
  );
  return rows.map(responseFromRow);
}

function validateResponseIds(ids: string[]) {
  if (!Array.isArray(ids) || ids.length === 0 || new Set(ids).size !== ids.length) {
    throw observationError('camera_observation_response_invalid');
  }
  ids.forEach(id => assertNonEmpty(id, 'camera_observation_response_invalid'));
}

export async function saveCameraObservationReplyDraft(
  observationIds: string[],
  draft: CameraObservationReplyDraft,
  canCommit?: () => boolean,
) {
  validateResponseIds(observationIds);
  validateReplyDraft(draft);
  const draftJson = JSON.stringify({ replyId: draft.replyId, messages: draft.messages,
    ...(draft.adoptedReply !== undefined ? { adoptedReply: draft.adoptedReply } : {}) });
  const messageIdsJson = JSON.stringify(draft.messages.map(message => message.id));
  assertResponseCanCommit(canCommit);
  const database = await getDatabase();
  await database.withExclusiveTransactionAsync(async transaction => {
    assertResponseCanCommit(canCommit);
    let targetSessionId: string | undefined;
    for (const id of observationIds) {
      const response = await loadResponse(transaction, id);
      assertResponseCanCommit(canCommit);
      if (!response || response.status === 'cancelled' || response.status === 'delivered') {
        throw observationError('camera_observation_response_cancelled');
      }
      if (targetSessionId && targetSessionId !== response.binding.targetSessionId) {
        throw observationError('camera_observation_response_invalid');
      }
      targetSessionId = response.binding.targetSessionId;
      if (response.draft) {
        if (JSON.stringify(response.draft) !== draftJson) throw observationError('camera_observation_reply_draft_conflict');
        continue;
      }
      await transaction.runAsync(
        `UPDATE camera_observation_response_obligations
         SET delivery_status = 'draft_ready', draft_json = ?, message_ids_json = ?, message_id = ?
         WHERE observation_id = ? AND delivery_status = 'pending';`,
        draftJson, messageIdsJson, draft.messages[0].id, id,
      );
      assertResponseCanCommit(canCommit);
    }
    assertResponseCanCommit(canCommit);
  });
  notifySavedObservation();
}

export async function completeCameraObservationResponses(
  observationIds: string[],
  messageIds: string[],
  canCommit?: () => boolean,
) {
  validateResponseIds(observationIds);
  validateResponseIds(messageIds);
  const messageIdsJson = JSON.stringify(messageIds);
  assertResponseCanCommit(canCommit);
  const database = await getDatabase();
  await database.withExclusiveTransactionAsync(async transaction => {
    assertResponseCanCommit(canCommit);
    for (const id of observationIds) {
      const response = await loadResponse(transaction, id);
      assertResponseCanCommit(canCommit);
      if (!response || response.status === 'cancelled') throw observationError('camera_observation_response_cancelled');
      if (response.status !== 'draft_ready' && response.status !== 'delivered') {
        throw observationError('camera_observation_reply_draft_required');
      }
      if (JSON.stringify(response.messageIds) !== messageIdsJson) {
        throw observationError('camera_observation_reply_draft_conflict');
      }
      if (response.status === 'delivered') continue;
      await transaction.runAsync(
        `UPDATE camera_observation_response_obligations
         SET delivery_status = 'delivered', draft_json = NULL
         WHERE observation_id = ? AND delivery_status = 'draft_ready';`, id,
      );
      assertResponseCanCommit(canCommit);
    }
    assertResponseCanCommit(canCommit);
  });
  notifySavedObservation();
}

export async function cancelCameraObservationResponse(observationId: string) {
  assertNonEmpty(observationId, 'camera_observation_response_invalid');
  await (await getDatabase()).withExclusiveTransactionAsync(async transaction => {
    await transaction.runAsync(
      `UPDATE camera_observation_response_obligations
       SET delivery_status = 'cancelled', draft_json = NULL, message_ids_json = '[]', message_id = NULL
       WHERE observation_id = ? AND delivery_status IN ('pending', 'draft_ready');`, observationId,
    );
  });
  notifySavedObservation();
}

export async function listDeliveredCameraObservationResponses(targetSessionId: string, messageIds: string[]) {
  assertNonEmpty(targetSessionId, 'camera_observation_response_invalid');
  if (!messageIds.length) return [];
  validateResponseIds(messageIds);
  const rows = await (await getDatabase()).getAllAsync<ResponseRow>(
    `SELECT response.* FROM camera_observation_response_obligations AS response
     JOIN camera_observations AS observation ON observation.observation_id = response.observation_id
     WHERE response.target_session_id = ? AND response.delivery_status = 'delivered'
     ORDER BY observation.captured_at DESC, observation.observation_id DESC;`, targetSessionId,
  );
  const relevantIds = new Set(messageIds);
  return rows.map(responseFromRow).filter(response => response.messageIds.some(id => relevantIds.has(id)));
}

/** Internal eligibility only; it is neither model material nor a synthetic chat message. */
export async function listCameraObservationMemorySources() {
  const rows = await (await getDatabase()).getAllAsync<{ observation_id: string; captured_at: number }>(
    `SELECT observation_id, captured_at FROM camera_observations
     WHERE memory_ingestion_eligible = 1 ORDER BY captured_at, observation_id;`,
  );
  return rows.map(row => ({ observationId: row.observation_id, capturedAt: row.captured_at }));
}

/** Exact local tool identity, also used to reconcile an uncertain commit. */
export async function getCameraObservationRecordByActionId(actionId: string) {
  assertNonEmpty(actionId, 'camera_observation_not_found');
  const database = await getDatabase();
  const row = await database.getFirstAsync<{ observation_id: string }>(
    'SELECT observation_id FROM camera_observations WHERE action_id = ? LIMIT 1;', actionId,
  );
  return row ? (await loadRecordWithDatabase(database, row.observation_id)) ?? null : null;
}

export async function getCameraObservationHistorySummary(): Promise<CameraObservationHistorySummary> {
  const database = await getDatabase();
  const row = await database.getFirstAsync<{ record_count: number; latest_captured_at: number | null }>(
    'SELECT COUNT(*) AS record_count, MAX(captured_at) AS latest_captured_at FROM camera_observations;',
  );
  return {
    recordCount: row?.record_count ?? 0,
    latestCapturedAt: row?.latest_captured_at ?? undefined,
  };
}

export async function listCameraObservations(options: {
  before?: number;
  cursor?: CameraObservationCursor;
  limit?: number;
} = {}): Promise<CameraObservationHistoryPage> {
  const limit = Math.max(1, Math.min(options.limit ?? PAGE_SIZE, 100));
  const database = await getDatabase();
  const rows = options.cursor
    ? await database.getAllAsync<TimelineRow>(
      `SELECT observation_id, captured_at, source_kind, trigger_kind, result_json
       FROM camera_observations
       WHERE captured_at < ? OR (captured_at = ? AND observation_id < ?)
       ORDER BY captured_at DESC, observation_id DESC
       LIMIT ?;`,
      options.cursor.capturedAt,
      options.cursor.capturedAt,
      options.cursor.observationId,
      limit + 1,
    )
    : options.before !== undefined ? await database.getAllAsync<TimelineRow>(
      `SELECT observation_id, captured_at, source_kind, trigger_kind, result_json
       FROM camera_observations WHERE captured_at < ?
       ORDER BY captured_at DESC, observation_id DESC LIMIT ?;`,
      options.before, limit + 1,
    ) : await database.getAllAsync<TimelineRow>(
      `SELECT observation_id, captured_at, source_kind, trigger_kind, result_json
       FROM camera_observations
       ORDER BY captured_at DESC, observation_id DESC
       LIMIT ?;`,
      limit + 1,
    );
  const hasMore = rows.length > limit;
  const visibleRows = hasMore ? rows.slice(0, limit) : rows;
  for (const row of visibleRows) {
    row.response_status = (await loadResponse(database, row.observation_id))?.status;
  }
  const records = visibleRows.map(timelineFromRow);
  const last = visibleRows.at(-1);
  return {
    records,
    nextCursor: hasMore && last
      ? { capturedAt: last.captured_at, observationId: last.observation_id }
      : undefined,
  };
}

export async function countCameraObservationsInRange(startInclusive: number, endExclusive: number) {
  assertSafeInteger(startInclusive, 'camera_observation_delete_failed');
  assertSafeInteger(endExclusive, 'camera_observation_delete_failed');
  if (endExclusive <= startInclusive) throw observationError('camera_observation_delete_failed');
  const row = await (await getDatabase()).getFirstAsync<{ count: number }>(
    'SELECT COUNT(*) AS count FROM camera_observations WHERE captured_at >= ? AND captured_at < ?;',
    startInclusive,
    endExclusive,
  );
  return row?.count ?? 0;
}

async function deleteMatching(
  reason: CameraObservationDeleteReason,
  whereSql: string,
  params: Array<string | number>,
) {
  const database = await getDatabase();
  let deletedCount = 0;
  try {
    await database.withExclusiveTransactionAsync(async (transaction) => {
      const rows = await transaction.getAllAsync<{ observation_id: string }>(
        `SELECT observation_id FROM camera_observations ${whereSql};`,
        ...params,
      );
      if (rows.length === 0) return;
      const deletedAt = Date.now();
      for (const row of rows) {
        const response = await loadResponse(transaction, row.observation_id);
        await transaction.runAsync(
          `INSERT INTO camera_observation_deletion_tombstones (
            observation_id, deleted_at, delete_reason, response_delivery_status, message_id
          ) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(observation_id) DO UPDATE SET
            deleted_at = excluded.deleted_at,
            delete_reason = excluded.delete_reason,
            response_delivery_status = excluded.response_delivery_status,
            message_id = excluded.message_id;`,
          row.observation_id,
          deletedAt,
          reason,
          response?.status ?? null,
          response?.messageIds[0] ?? null,
        );
      }
      const matchingObservationIds = `SELECT observation_id FROM camera_observations ${whereSql}`;
      for (const childTable of [
        'camera_observation_response_obligations',
        'camera_observation_cleanup_receipts',
        'camera_observation_trigger_receipts',
      ]) {
        await transaction.runAsync(
          `DELETE FROM ${childTable} WHERE observation_id IN (${matchingObservationIds});`,
          ...params,
        );
      }
      const result = await transaction.runAsync(
        `DELETE FROM camera_observations ${whereSql};`,
        ...params,
      );
      if (result.changes !== rows.length) {
        throw observationError('camera_observation_delete_failed');
      }
      const orphanCount = await transaction.getFirstAsync<{ count: number }>(`
        SELECT COUNT(*) AS count FROM (
          SELECT observation_id FROM camera_observation_response_obligations
          WHERE NOT EXISTS (
            SELECT 1 FROM camera_observations
            WHERE camera_observations.observation_id = camera_observation_response_obligations.observation_id
          )
          UNION ALL
          SELECT observation_id FROM camera_observation_cleanup_receipts
          WHERE NOT EXISTS (
            SELECT 1 FROM camera_observations
            WHERE camera_observations.observation_id = camera_observation_cleanup_receipts.observation_id
          )
          UNION ALL
          SELECT observation_id FROM camera_observation_trigger_receipts
          WHERE NOT EXISTS (
            SELECT 1 FROM camera_observations
            WHERE camera_observations.observation_id = camera_observation_trigger_receipts.observation_id
          )
        );
      `);
      if ((orphanCount?.count ?? 0) !== 0) {
        throw observationError('camera_observation_delete_failed');
      }
      deletedCount = result.changes;
    });
  } catch {
    throw observationError('camera_observation_delete_failed');
  }
  if (deletedCount > 0) notifySavedObservation();
  return deletedCount;
}

export async function deleteCameraObservation(observationId: string) {
  assertNonEmpty(observationId, 'camera_observation_delete_failed');
  const count = await deleteMatching('single', 'WHERE observation_id = ?', [observationId]);
  if (count === 0) throw observationError('camera_observation_not_found');
  return count;
}

export function deleteCameraObservationsInRange(startInclusive: number, endExclusive: number) {
  return deleteMatching(
    'date_range',
    'WHERE captured_at >= ? AND captured_at < ?',
    [startInclusive, endExclusive],
  );
}

export function deleteAllCameraObservations() {
  return deleteMatching('delete_all', '', []);
}

export async function exportCameraObservationDatabase(options: { includeResponsesForRollback?: boolean } = {}) {
  const bytes = await (await getDatabase()).serializeAsync();
  if (options.includeResponsesForRollback) return bytes;
  // The export copy owns its connection; clearing it never touches the live database.
  const copy = await SQLite.deserializeDatabaseAsync(bytes);
  try {
    // VACUUM removes deleted draft bytes from the serialized copy's unused pages as well.
    await copy.execAsync("DELETE FROM camera_observation_response_obligations WHERE delivery_status IN ('pending', 'draft_ready'); VACUUM;");
    return await copy.serializeAsync();
  } finally {
    await copy.closeAsync();
  }
}

export async function inspectCameraObservationDatabase(
  source: DatabaseImportSource,
): Promise<CameraObservationBackupInspection> {
  const database = await openDatabaseImportSource(source);
  try {
    const quickCheck = await database.getFirstAsync<{ quick_check?: string }>('PRAGMA quick_check;');
    if (quickCheck?.quick_check !== 'ok') throw observationError('camera_observation_backup_payload_invalid');
    const foreignKeyProblems = await database.getAllAsync<Record<string, unknown>>('PRAGMA foreign_key_check;');
    if (foreignKeyProblems.length > 0) {
      throw observationError('camera_observation_backup_payload_invalid');
    }
    const version = await database.getFirstAsync<{ user_version: number }>('PRAGMA user_version;');
    if (!version || version.user_version < 1 || version.user_version > CAMERA_OBSERVATION_SCHEMA_VERSION) {
      throw observationError('camera_observation_backup_payload_invalid');
    }
    if (version.user_version >= 2) {
      const columns = await database.getAllAsync<{ name: string }>('PRAGMA table_info(camera_observations);');
      if (!columns.some(column => column.name === 'memory_ingestion_eligible')) {
        throw observationError('camera_observation_backup_payload_invalid');
      }
      const invalid = await database.getFirstAsync(
        'SELECT 1 FROM camera_observations WHERE memory_ingestion_eligible IS NULL OR memory_ingestion_eligible NOT IN (0, 1) LIMIT 1;',
      );
      if (invalid) throw observationError('camera_observation_backup_payload_invalid');
    }
    const rows = await database.getAllAsync<ObservationRow>('SELECT * FROM camera_observations;');
    for (const row of rows) {
      parseResultJson(row.result_json);
      const cleanup = await database.getFirstAsync<{ completed_at: number; audit_persisted: number }>(
        `SELECT completed_at, audit_persisted
         FROM camera_observation_cleanup_receipts
         WHERE observation_id = ? AND cleanup_state = 'verified_deleted' AND deletion_verified = 1;`,
        row.observation_id,
      );
      if (!cleanup) throw observationError('camera_observation_backup_payload_invalid');
      fromRow(row, cleanup);
    }
    if (version.user_version >= 3) {
      const columns = await database.getAllAsync<{ name: string }>('PRAGMA table_info(camera_observation_response_obligations);');
      if (!['target_session_id', 'origin', 'source_turn_id', 'requested_at', 'draft_json', 'message_ids_json']
        .every(name => columns.some(column => column.name === name))) {
        throw observationError('camera_observation_backup_payload_invalid');
      }
      const obligations = await database.getAllAsync<ResponseRow>('SELECT * FROM camera_observation_response_obligations;');
      const observationIds = new Set(rows.map(row => row.observation_id));
      for (const obligation of obligations) {
        if (!observationIds.has(obligation.observation_id)) throw observationError('camera_observation_backup_payload_invalid');
        responseFromRow(obligation);
      }
    } else {
      const obligations = await database.getFirstAsync<{ count: number }>(
        'SELECT COUNT(*) AS count FROM camera_observation_response_obligations;',
      );
      if ((obligations?.count ?? 0) !== 0) throw observationError('camera_observation_backup_payload_invalid');
    }
    return { schemaVersion: version.user_version as 1 | 2 | 3, recordCount: rows.length };
  } catch (error) {
    if (error instanceof Error && error.message === 'camera_observation_backup_payload_invalid') throw error;
    throw observationError('camera_observation_backup_payload_invalid');
  } finally {
    await database.closeAsync();
  }
}

export async function importCameraObservationDatabase(source: DatabaseImportSource) {
  await inspectCameraObservationDatabase(source);
  if (databasePromise) {
    const database = await databasePromise;
    await database.closeAsync();
    databasePromise = undefined;
  }
  const sourceDatabase = await openDatabaseImportSource(source);
  const destination = await SQLite.openDatabaseAsync(
    CAMERA_OBSERVATION_DATABASE_NAME,
    { useNewConnection: true },
  );
  try {
    await SQLite.backupDatabaseAsync({ sourceDatabase, destDatabase: destination });
  } finally {
    await sourceDatabase.closeAsync();
    await destination.closeAsync();
  }
  databasePromise = undefined;
  await getDatabase();
  notifySavedObservation();
}

export async function clearCameraObservationDatabase() {
  const database = await getDatabase();
  await database.withExclusiveTransactionAsync(async (transaction) => {
    await transaction.execAsync(`
      DELETE FROM camera_observation_response_obligations;
      DELETE FROM camera_observation_cleanup_receipts;
      DELETE FROM camera_observation_trigger_receipts;
      DELETE FROM camera_observations;
      DELETE FROM camera_observation_deletion_tombstones;
    `);
  });
  notifySavedObservation();
}

export async function closeCameraObservationDatabaseForTests() {
  if (!databasePromise) return;
  const database = await databasePromise;
  databasePromise = undefined;
  await database.closeAsync();
}
