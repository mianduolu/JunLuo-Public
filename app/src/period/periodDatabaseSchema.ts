import type * as SQLite from 'expo-sqlite';
import { PERIOD_HEALTH_CAPTURE_TABLE_SCHEMA_SQL, PERIOD_HEALTH_FULL_CAPTURE_SCHEMA_SQL } from '../sync/syncPeriodHealthSql';

export async function initializePeriodDatabase(database: SQLite.SQLiteDatabase) {
      await database.execAsync(`
        CREATE TABLE IF NOT EXISTS period_entries (
          id TEXT PRIMARY KEY NOT NULL,
          start_at INTEGER NOT NULL,
          end_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_period_entries_start_at
          ON period_entries(start_at DESC);
        CREATE INDEX IF NOT EXISTS idx_period_entries_active
          ON period_entries(end_at);

        CREATE TABLE IF NOT EXISTS period_daily_logs (
          id TEXT PRIMARY KEY NOT NULL,
          date_key TEXT NOT NULL UNIQUE,
          period_id TEXT,
          body_state TEXT NOT NULL DEFAULT 'normal',
          flow TEXT NOT NULL DEFAULT 'none',
          pain_level INTEGER NOT NULL DEFAULT 0,
          symptoms TEXT NOT NULL DEFAULT '[]',
          note TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_period_daily_logs_date_key
          ON period_daily_logs(date_key DESC);
        CREATE INDEX IF NOT EXISTS idx_period_daily_logs_period_id
          ON period_daily_logs(period_id);

        CREATE TABLE IF NOT EXISTS period_reminder_settings (
          id TEXT PRIMARY KEY NOT NULL CHECK (id = 'global'),
          care_enabled INTEGER NOT NULL DEFAULT 1
            CHECK (care_enabled IN (0, 1)),
          care_frequency TEXT NOT NULL DEFAULT 'standard'
            CHECK (care_frequency = 'standard'),
          muted_date_key TEXT,
          updated_at INTEGER NOT NULL
        );
      `);
      await database.execAsync('ALTER TABLE period_daily_logs ADD COLUMN body_state TEXT NOT NULL DEFAULT \'normal\';').catch(() => undefined);
      await database.execAsync(`
        CREATE TABLE IF NOT EXISTS period_observations (
          id TEXT PRIMARY KEY NOT NULL,
          date_key TEXT NOT NULL,
          time_text TEXT,
          period_id TEXT,
          body_state TEXT NOT NULL,
          flow TEXT NOT NULL,
          pain_level INTEGER NOT NULL,
          symptoms TEXT NOT NULL,
          note TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_period_observations_date
          ON period_observations(date_key, time_text, created_at);
        INSERT INTO period_observations
          (id, date_key, time_text, period_id, body_state, flow, pain_level, symptoms, note, created_at, updated_at)
        SELECT 'legacy:' || d.id, d.date_key, NULL, d.period_id, d.body_state,
               d.flow, d.pain_level, d.symptoms, d.note, d.created_at, d.updated_at
        FROM period_daily_logs d
        WHERE NOT EXISTS (SELECT 1 FROM period_observations o WHERE o.date_key = d.date_key);
      `);
      await database.execAsync(PERIOD_HEALTH_CAPTURE_TABLE_SCHEMA_SQL);
      await retirePeriodNotificationStorage(database);
      await database.execAsync(`
        DROP TRIGGER IF EXISTS period_sync_capture_period_companion_delivery_insert;
        DROP TRIGGER IF EXISTS period_sync_capture_period_companion_delivery_update;
        DROP TRIGGER IF EXISTS period_sync_capture_period_companion_delivery_delete;
        DROP TRIGGER IF EXISTS period_sync_guard_period_companion_delivery_identity;
        DROP TRIGGER IF EXISTS period_sync_guard_companion_delivery_state;
        DROP TABLE IF EXISTS period_companion_deliveries;
        DELETE FROM period_sync_domain_outbox WHERE entity_id LIKE 'period-companion-delivery:%';
        DELETE FROM period_sync_entity_heads WHERE entity_id LIKE 'period-companion-delivery:%';
        DELETE FROM period_sync_conflicts WHERE entity_id LIKE 'period-companion-delivery:%';
      `);
      await database.execAsync(PERIOD_HEALTH_FULL_CAPTURE_SCHEMA_SQL);
}

// Upgrade/import boundary only. Keep just the existing notification IDs until
// the platform confirms cancellation; no retired title/body survives migration.
async function retirePeriodNotificationStorage(database: SQLite.SQLiteDatabase) {
  const oldTable = await database.getFirstAsync<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'period_reminder_notifications'",
  );
  await database.execAsync(`
    DROP TRIGGER IF EXISTS period_sync_capture_period_reminder_insert;
    DROP TRIGGER IF EXISTS period_sync_capture_period_reminder_update;
    DROP TRIGGER IF EXISTS period_sync_capture_period_reminder_delete;
    DROP TRIGGER IF EXISTS period_sync_guard_period_reminder_identity;
    DROP TRIGGER IF EXISTS period_sync_capture_period_reminder_settings_insert;
    DROP TRIGGER IF EXISTS period_sync_capture_period_reminder_settings_update;
    DROP TRIGGER IF EXISTS period_sync_capture_period_reminder_settings_delete;
  `);
  if (oldTable) {
    await database.execAsync(`
      INSERT OR IGNORE INTO period_sync_pending_notification_cancellations
        (notification_id, reminder_id, created_at)
      SELECT notification_id, id, created_at FROM period_reminder_notifications
      WHERE kind IN ('prediction', 'supplies') AND COALESCE(notification_id, '') != '';
      DROP TABLE period_reminder_notifications;
    `);
  }
  const columns = await database.getAllAsync<{ name: string }>('PRAGMA table_info(period_reminder_settings)');
  for (const column of ['prediction_enabled', 'supplies_enabled']) {
    if (columns.some((entry) => entry.name === column)) {
      await database.execAsync(`ALTER TABLE period_reminder_settings DROP COLUMN ${column}`);
    }
  }
  await database.execAsync(`
    DELETE FROM period_sync_domain_outbox WHERE entity_id LIKE 'period-reminder:%';
    DELETE FROM period_sync_entity_heads WHERE entity_id LIKE 'period-reminder:%';
    DELETE FROM period_sync_conflicts WHERE entity_id LIKE 'period-reminder:%';
    UPDATE period_sync_domain_outbox
      SET payload_json = json_remove(payload_json, '$.record.predictionEnabled', '$.record.suppliesEnabled')
      WHERE entity_id = 'period-reminder-settings:global' AND json_valid(payload_json);
  `);
}
