import { POST_REVIEW_SCHEMA_SQL } from './syncBaiyunPostReviews';
import { assertSyncUuidV4 } from './syncDeviceContract';
import type { JsonValue } from './syncProtocol';

export type PostReviewOwnerRebind = Readonly<{
  previousDeviceId: string;
  nextDeviceId: string;
}>;

/** Snapshot headers are temporary; owner-signed records must still be valid. */
export function projectPostReviewCurrentSnapshot(
  entityType: string,
  record: Record<string, JsonValue>,
  rebind?: PostReviewOwnerRebind,
) {
  if (entityType !== 'post-review' && entityType !== 'post-review-action') {
    throw new Error('post review snapshot entity is invalid');
  }
  const owner = record.owner_device_id;
  assertSyncUuidV4(owner, 'post review snapshot owner');
  if (!rebind) return { record, sourceDeviceId: owner as string };
  assertSyncUuidV4(rebind.previousDeviceId, 'previous post review owner');
  assertSyncUuidV4(rebind.nextDeviceId, 'next post review owner');
  // Requests belong to their original world. Keep them locally, without
  // turning an old queued click into an action in the rebuilt world.
  if (entityType === 'post-review-action' && record.state === 'pending') return null;
  if (owner !== rebind.previousDeviceId && owner !== rebind.nextDeviceId) {
    throw new Error('post review snapshot belongs to another owner');
  }
  return {
    record: { ...record, owner_device_id: rebind.nextDeviceId },
    sourceDeviceId: rebind.nextDeviceId,
  };
}

type QueryPort = {
  getFirstAsync<T>(sql: string, ...params: (string | number | null)[]): Promise<T | null>;
  runAsync(sql: string, ...params: (string | number | null)[]): Promise<unknown>;
  execAsync(sql: string): Promise<unknown>;
};
type DatabasePort = {
  withExclusiveTransactionAsync(action: (transaction: QueryPort) => Promise<void>): Promise<void>;
};

/** Only the explicit world cutover may move this phone's review routing. */
export async function rebindPostReviewOwnerForNewWorld(
  database: DatabasePort,
  rebind: PostReviewOwnerRebind,
) {
  assertSyncUuidV4(rebind.previousDeviceId, 'previous post review owner');
  assertSyncUuidV4(rebind.nextDeviceId, 'next post review owner');
  if (rebind.previousDeviceId === rebind.nextDeviceId) return;
  await database.withExclusiveTransactionAsync(async transaction => {
    const runtime = await transaction.getFirstAsync<{ suppress_capture: number }>(
      'SELECT suppress_capture FROM memory_sync_runtime WHERE singleton_id=1',
    );
    if (!runtime) throw new Error('post review cutover requires memory sync runtime');
    await transaction.runAsync('UPDATE memory_sync_runtime SET suppress_capture=1 WHERE singleton_id=1');
    await transaction.execAsync(`
      DROP TRIGGER IF EXISTS memory_post_review_identity_immutable;
      DROP TRIGGER IF EXISTS baiyun_post_review_action_identity_immutable;
    `);
    await transaction.runAsync(`UPDATE memory_ingestion_items SET post_review_owner_device_id=?
      WHERE COALESCE(post_review_owner_device_id,(SELECT source_device_id FROM memory_sync_runtime WHERE singleton_id=1))=?
        AND post_review_id IS NOT NULL
        AND EXISTS(SELECT 1 FROM memory_ingestion_batches b WHERE b.id=memory_ingestion_items.batch_id AND b.stream='post')`,
    rebind.nextDeviceId, rebind.previousDeviceId);
    await transaction.runAsync(`UPDATE baiyun_post_review_actions SET owner_device_id=?
      WHERE owner_device_id=? AND state IN ('applied','rejected')`,
    rebind.nextDeviceId, rebind.previousDeviceId);
    await transaction.execAsync(POST_REVIEW_SCHEMA_SQL);
    await transaction.runAsync('UPDATE memory_sync_runtime SET suppress_capture=? WHERE singleton_id=1', runtime.suppress_capture);
  });
}
