import {
  SYNC_DATABASE_SCHEMA_V1,
  SYNC_DATABASE_VERSION,
} from './syncSchema';

export interface SyncDatabaseMigrationConnection {
  getFirstAsync<T>(source: string): Promise<T | null>;
  getAllAsync<T>(source: string): Promise<T[]>;
  execAsync(source: string): Promise<void>;
}

type VersionRow = {
  user_version: number;
};

export async function initializeSyncDatabaseSchema(
  database: SyncDatabaseMigrationConnection,
  newerVersionMessage: string,
) {
  const versionRow = await database.getFirstAsync<VersionRow>(
    'PRAGMA user_version',
  );
  const version = versionRow?.user_version ?? 0;
  if (version > SYNC_DATABASE_VERSION) {
    throw new Error(newerVersionMessage);
  }

  await database.execAsync(SYNC_DATABASE_SCHEMA_V1);
  await database.execAsync(`
    DELETE FROM sync_durable_intents WHERE adapter_id = 'behavior.current-action';
    DELETE FROM sync_cursors
      WHERE stream_id LIKE 'bootstrap-marker:v%:behavior.current-action:%';
    DELETE FROM sync_entity_heads WHERE domain = 'behavior' AND entity_type = 'current-action';
    DELETE FROM sync_entity_conflicts WHERE domain = 'behavior' AND entity_type = 'current-action'
      AND entity_id = 'current-action' AND state = 'pending';
    DELETE FROM sync_outbox WHERE state IN ('pending', 'leased') AND mutation_id IN (
      SELECT mutation_id FROM sync_entity_revisions WHERE domain = 'behavior' AND entity_type = 'current-action'
    );
    CREATE TRIGGER IF NOT EXISTS sync_retired_current_action_head
    AFTER INSERT ON sync_entity_heads
    WHEN NEW.domain = 'behavior' AND NEW.entity_type = 'current-action'
    BEGIN
      DELETE FROM sync_entity_heads WHERE domain = NEW.domain AND entity_type = NEW.entity_type AND entity_id = NEW.entity_id;
    END;
  `);
  await database.execAsync(
    `PRAGMA user_version = ${SYNC_DATABASE_VERSION}`,
  );
}
