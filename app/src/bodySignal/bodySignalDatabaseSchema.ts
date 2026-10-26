import type * as SQLite from 'expo-sqlite';
import { BODY_SIGNAL_HEALTH_FULL_CAPTURE_SCHEMA_SQL } from '../sync/syncBodySignalHealthSql';
import { migrateBodySignalBusinessSchema } from './bodySignalSchema';
import type { BodySignalDeviceProfile } from './device/bodySignalDeviceTypes';

export async function initializeBodySignalDatabase(
  database: SQLite.SQLiteDatabase,
  legacyProfiles: readonly BodySignalDeviceProfile[],
) {
      await database.execAsync(`
        CREATE TABLE IF NOT EXISTS body_signal_readings (
          id TEXT PRIMARY KEY NOT NULL,
          kind TEXT NOT NULL,
          value REAL NOT NULL,
          unit TEXT NOT NULL,
          measured_at INTEGER NOT NULL,
          source_provider TEXT NOT NULL,
          source_device_name TEXT,
          confidence TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_body_signal_readings_kind_time
          ON body_signal_readings(kind, measured_at DESC);
      `);
      await database.execAsync(
        'ALTER TABLE body_signal_readings ADD COLUMN received_at INTEGER;',
      ).catch(() => undefined);
      await database.execAsync(
        'ALTER TABLE body_signal_readings ADD COLUMN origin_device_id TEXT;',
      ).catch(() => undefined);
      await database.execAsync(
        'ALTER TABLE body_signal_readings ADD COLUMN origin_platform TEXT;',
      ).catch(() => undefined);
      await database.execAsync(
        'ALTER TABLE body_signal_readings ADD COLUMN clock_confidence TEXT;',
      ).catch(() => undefined);
      await database.execAsync(
        'ALTER TABLE body_signal_readings ADD COLUMN sampling_method TEXT;',
      ).catch(() => undefined);
      await database.execAsync(
        'ALTER TABLE body_signal_readings ADD COLUMN retention_until INTEGER;',
      ).catch(() => undefined);
      await database.execAsync(
        BODY_SIGNAL_HEALTH_FULL_CAPTURE_SCHEMA_SQL,
      );
      await migrateBodySignalBusinessSchema(database, legacyProfiles);
}
