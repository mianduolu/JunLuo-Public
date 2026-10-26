import type { BodySignalSyncCursor } from './bodySignalStructuredTypes';

export async function loadBodySignalSyncCursor(
  deviceProfileId: string,
  sourceProvider: BodySignalSyncCursor['sourceProvider'],
  stream: string,
): Promise<BodySignalSyncCursor | undefined> {
  const { getBodySignalDatabase } = await import('./bodySignalStore');
  const database = await getBodySignalDatabase();
  const row = await database.getFirstAsync<{
    cursor: string | null;
    synced_through_at: number | null;
    updated_at: number;
  }>(
    `SELECT cursor, synced_through_at, updated_at FROM body_signal_sync_cursors
      WHERE device_profile_id = ? AND source_provider = ? AND stream = ?`,
    deviceProfileId,
    sourceProvider,
    stream,
  );
  if (!row) return undefined;
  return {
    deviceProfileId,
    sourceProvider,
    stream,
    ...(row.cursor !== null ? { cursor: row.cursor } : {}),
    ...(row.synced_through_at !== null ? { syncedThroughAt: row.synced_through_at } : {}),
    updatedAt: row.updated_at,
  };
}

export async function saveBodySignalSyncCursor(cursor: BodySignalSyncCursor): Promise<void> {
  if (!cursor.deviceProfileId || !cursor.stream.trim()) {
    throw new RangeError('deviceProfileId and stream are required');
  }
  const { getBodySignalDatabase } = await import('./bodySignalStore');
  const database = await getBodySignalDatabase();
  await database.runAsync(
    `INSERT INTO body_signal_sync_cursors (
       device_profile_id, source_provider, stream, cursor,
       synced_through_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(device_profile_id, source_provider, stream) DO UPDATE SET
       cursor = excluded.cursor,
       synced_through_at = excluded.synced_through_at,
       updated_at = excluded.updated_at`,
    cursor.deviceProfileId,
    cursor.sourceProvider,
    cursor.stream,
    cursor.cursor ?? null,
    cursor.syncedThroughAt ?? null,
    cursor.updatedAt,
  );
}
