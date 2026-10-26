import type * as SQLite from 'expo-sqlite';

import type {
  BodySignalHealthBusinessPort,
} from './syncBodySignalHealthApply';
import {
  assertBodySignalHealthRecord,
  bodySignalHealthLocalId,
  type BodySignalHealthCareSummaryRecord,
  type BodySignalHealthCollectionPolicyRecord,
  type BodySignalHealthReadingRecord,
  type BodySignalHealthRecord,
  type BodySignalHealthRecordKind,
} from './syncBodySignalHealth';

type SqlTransaction = Pick<
  SQLite.SQLiteDatabase,
  'runAsync' | 'getFirstAsync'
>;

type ReadingIdentityRow = {
  id: string;
  kind: string;
  value: number;
  unit: string;
  measured_at: number;
  received_at: number | null;
  origin_device_id: string | null;
  origin_platform: string | null;
  source_provider: string;
  source_device_name: string | null;
  confidence: string;
  clock_confidence: string | null;
  sampling_method: string | null;
  retention_until: number | null;
  created_at: number;
};

function sameReading(
  row: ReadingIdentityRow,
  record: BodySignalHealthReadingRecord,
) {
  return (
    row.id === record.id
    && row.kind === record.kind
    && row.value === record.value
    && row.unit === record.unit
    && row.measured_at === record.measuredAt
    && row.received_at === record.receivedAt
    && row.origin_device_id === record.originDeviceId
    && row.origin_platform === record.originPlatform
    && row.source_provider === record.sourceProvider
    && row.source_device_name === record.sourceDeviceAlias
    && row.confidence === record.confidence
    && row.clock_confidence === record.clockConfidence
    && row.sampling_method === record.samplingMethod
    && row.retention_until === record.retentionUntil
    && row.created_at === record.createdAt
  );
}

async function applyReading(
  transaction: SqlTransaction,
  record: BodySignalHealthReadingRecord,
) {
  const result = await transaction.runAsync(
    `INSERT OR IGNORE INTO body_signal_readings (
       id, kind, value, unit, measured_at,
       source_provider, source_device_name, confidence, created_at,
       received_at, origin_device_id, origin_platform,
       clock_confidence, sampling_method, retention_until
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    record.id,
    record.kind,
    record.value,
    record.unit,
    record.measuredAt,
    record.sourceProvider,
    record.sourceDeviceAlias,
    record.confidence,
    record.createdAt,
    record.receivedAt,
    record.originDeviceId,
    record.originPlatform,
    record.clockConfidence,
    record.samplingMethod,
    record.retentionUntil,
  );
  if (result.changes === 1) return;
  const existing = await transaction.getFirstAsync<ReadingIdentityRow>(
    `SELECT id, kind, value, unit, measured_at, received_at,
            origin_device_id, origin_platform, source_provider,
            source_device_name, confidence, clock_confidence,
            sampling_method, retention_until, created_at
     FROM body_signal_readings WHERE id = ?`,
    record.id,
  );
  if (!existing || !sameReading(existing, record)) {
    throw new Error(
      'body-signal.health reading append identity 冲突。',
    );
  }
}

async function applySummary(
  transaction: SqlTransaction,
  record: BodySignalHealthCareSummaryRecord,
) {
  await transaction.runAsync(
    `INSERT INTO body_signal_care_summaries (
       id, date_key, kind, origin_device_id, origin_platform,
       sample_count, average, minimum, maximum,
       first_measured_at, last_measured_at, generated_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       sample_count = excluded.sample_count,
       average = excluded.average,
       minimum = excluded.minimum,
       maximum = excluded.maximum,
       first_measured_at = excluded.first_measured_at,
       last_measured_at = excluded.last_measured_at,
       generated_at = excluded.generated_at,
       updated_at = excluded.updated_at`,
    record.id,
    record.dateKey,
    record.kind,
    record.originDeviceId,
    record.originPlatform,
    record.sampleCount,
    record.average,
    record.minimum,
    record.maximum,
    record.firstMeasuredAt,
    record.lastMeasuredAt,
    record.generatedAt,
    record.updatedAt,
  );
}

async function applyCollectionPolicy(
  transaction: SqlTransaction,
  record: BodySignalHealthCollectionPolicyRecord,
) {
  await transaction.runAsync(
    `INSERT INTO body_signal_collection_policy (
       id, auto_measure_after_reconnect, auto_reconnect_enabled,
       preferred_device_alias, raw_retention_days, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       auto_measure_after_reconnect =
         excluded.auto_measure_after_reconnect,
       auto_reconnect_enabled = excluded.auto_reconnect_enabled,
       preferred_device_alias = excluded.preferred_device_alias,
       raw_retention_days = excluded.raw_retention_days,
       updated_at = excluded.updated_at`,
    record.id,
    record.autoMeasureAfterReconnect ? 1 : 0,
    record.autoReconnectEnabled ? 1 : 0,
    record.preferredDeviceAlias,
    record.rawRetentionDays,
    record.updatedAt,
  );
}

export async function applyBodySignalHealthRecordToSqlite(input: {
  transaction: SqlTransaction;
  kind: BodySignalHealthRecordKind;
  entityId: string;
  record: BodySignalHealthRecord;
}) {
  assertBodySignalHealthRecord(
    input.kind,
    input.entityId,
    input.record,
  );
  if (input.kind === 'body-signal-reading') {
    await applyReading(
      input.transaction,
      input.record as BodySignalHealthReadingRecord,
    );
  } else if (input.kind === 'body-signal-care-summary') {
    await applySummary(
      input.transaction,
      input.record as BodySignalHealthCareSummaryRecord,
    );
  } else {
    await applyCollectionPolicy(
      input.transaction,
      input.record as BodySignalHealthCollectionPolicyRecord,
    );
  }
}

export async function deleteBodySignalHealthRecordFromSqlite(input: {
  transaction: SqlTransaction;
  kind: BodySignalHealthRecordKind;
  entityId: string;
}) {
  const localId = bodySignalHealthLocalId(
    input.kind,
    input.entityId,
  );
  if (input.kind === 'body-signal-reading') {
    await input.transaction.runAsync(
      'DELETE FROM body_signal_readings WHERE id = ?',
      localId,
    );
  } else if (input.kind === 'body-signal-care-summary') {
    await input.transaction.runAsync(
      'DELETE FROM body_signal_care_summaries WHERE id = ?',
      localId,
    );
  } else {
    await input.transaction.runAsync(
      'DELETE FROM body_signal_collection_policy WHERE id = ?',
      localId,
    );
  }
}

async function runSuppressed<T>(
  apply: (transaction: SQLite.SQLiteDatabase) => Promise<T>,
) {
  const { runWithBodySignalHealthCaptureSuppressed } =
    await import('./syncBodySignalHealthSqlitePort');
  return runWithBodySignalHealthCaptureSuppressed(apply);
}

export const bodySignalHealthSqliteBusinessPort:
BodySignalHealthBusinessPort = {
  upsertRecord: async (input) => {
    await runSuppressed(async (transaction) => {
      await applyBodySignalHealthRecordToSqlite({
        transaction,
        kind: input.kind,
        entityId: input.entityId,
        record: input.record,
      });
    });
    if (input.kind === 'body-signal-collection-policy') {
      const record = input.record as
        BodySignalHealthCollectionPolicyRecord;
      const { mirrorBodySignalRuntimeSettings } =
        await import('../bodySignal/bodySignalSettingsStore');
      await mirrorBodySignalRuntimeSettings({
        autoMeasureAfterReconnect:
          record.autoMeasureAfterReconnect,
        autoReconnectEnabled: record.autoReconnectEnabled,
      });
    }
  },
  deleteRecord: async (input) => {
    await runSuppressed(async (transaction) => {
      await deleteBodySignalHealthRecordFromSqlite({
        transaction,
        kind: input.kind,
        entityId: input.entityId,
      });
    });
    if (input.kind === 'body-signal-collection-policy') {
      const {
        DEFAULT_BODY_SIGNAL_RUNTIME_SETTINGS,
        mirrorBodySignalRuntimeSettings,
      } = await import('../bodySignal/bodySignalSettingsStore');
      await mirrorBodySignalRuntimeSettings(
        DEFAULT_BODY_SIGNAL_RUNTIME_SETTINGS,
      );
    }
  },
};
