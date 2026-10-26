import { WISH_POOL_LIFE_STORAGE_KEY, parseWishPoolLifeSnapshotStorage } from '../sync/syncWishPoolLifeStorageDerivation';

// Restore replaces the conversation's data generation. Preserve facts, not old clickable consent.
export function prepareWishPoolBackupStorage(storage: Record<string, string>) {
  const raw = storage[WISH_POOL_LIFE_STORAGE_KEY];
  if (raw === undefined) return storage;
  const snapshot = parseWishPoolLifeSnapshotStorage(raw);
  if (!snapshot.collaboration) return storage;
  let changed = false;
  const discussions = snapshot.collaboration.discussions.map((item) => {
    if (item.closedAt !== undefined) return item;
    changed = true;
    const { reply: _reply, ...retained } = item;
    return { ...retained, lastDraftReply: item.reply ?? item.lastDraftReply, revision: item.revision + 1, decision: 'talking' as const };
  });
  if (!changed) return storage;
  return { ...storage, [WISH_POOL_LIFE_STORAGE_KEY]: JSON.stringify({
    ...snapshot, collaboration: { ...snapshot.collaboration, discussions },
  }) };
}
