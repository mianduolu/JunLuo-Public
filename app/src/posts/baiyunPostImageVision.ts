import type { SQLiteDatabase } from 'expo-sqlite';
import { captureBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import { getMemoryDatabase } from '../memory/memoryStore';
import { loadPostImageGroup, postImageGroupKey, postImageOwnerKey, type PostImageOwner, type PostImageReceipt } from './baiyunPostImageData';
import { readPostImagesForVision } from './baiyunPostImageFiles';

type VisionState = {
  group_key: string; description: string | null; failed_before: number; recovered_pending: number;
  opportunity_id: string; opportunity_at: number; attempts: number;
};
export type PostImageUnderstanding =
  | { status: 'seen'; description: string; recovered: boolean; receipt: PostImageReceipt }
  | { status: 'unavailable' | 'deferred' | 'stale' | 'busy' };
export type PostImageOpportunity = { id: string; startedAt: number };
type VisionImages = Awaited<ReturnType<typeof readPostImagesForVision>>;
const inFlight = new Map<string, { opportunity: string; promise: Promise<PostImageUnderstanding> }>();
const unsavedUnderstanding = new Map<string, { epoch: number | null; groupKey: string; description: string; recovered: number }>();
function notifyImageKnownChanged(postId: string) {
  void import('./baiyunPostRecallSource').then(module => module.notifyPostRecallSourceChanged(postId)).catch(() => undefined);
}

/** Read existing understanding for capacity planning without reserving a vision attempt. */
export async function loadPostImageUnderstanding(owner: PostImageOwner): Promise<PostImageUnderstanding | null> {
  const database = await getMemoryDatabase();
  const group = await loadPostImageGroup(database, owner);
  if (!group) return { status: 'stale' };
  const state = await database.getFirstAsync<VisionState>('SELECT * FROM baiyun_post_image_vision WHERE owner_key = ?', postImageOwnerKey(owner));
  return state?.group_key === postImageGroupKey(group) && state.description
    ? { status: 'seen', description: state.description, recovered: Boolean(state.recovered_pending), receipt: { owner, group } }
    : null;
}

/** Caller supplies a real interaction ID, never a timer/random retry ID. No scheduler is started here.
 * Chapter 5 supplies the approved provider wrapped in the existing call budget; null means skipped
 * before sending (budget/offline), so it is not a failed vision call. */
export function understandPostImageGroup(options: {
  owner: PostImageOwner; opportunity: PostImageOpportunity;
  request: (images: VisionImages) => Promise<string | null>; signal?: AbortSignal;
}): Promise<PostImageUnderstanding> {
  const { owner, opportunity } = options;
  if (!owner.postId.trim() || (owner.commentSource !== null && !owner.commentSource.trim())
    || !opportunity.id.trim() || !Number.isSafeInteger(opportunity.startedAt) || opportunity.startedAt < 0) {
    return Promise.reject(new Error('baiyun-post-image-invalid-opportunity'));
  }
  const key = postImageOwnerKey(owner);
  const active = inFlight.get(key);
  const opportunityKey = JSON.stringify([opportunity.id, opportunity.startedAt]);
  if (active) return active.opportunity === opportunityKey ? active.promise : Promise.resolve({ status: 'busy' });
  const promise = run(options).finally(() => { inFlight.delete(key); });
  inFlight.set(key, { opportunity: opportunityKey, promise });
  return promise;
}

async function run({ owner, opportunity, request, signal }: Parameters<typeof understandPostImageGroup>[0]): Promise<PostImageUnderstanding> {
  const epoch = captureBackupRestoreDataEpoch();
  const database = await getMemoryDatabase();
  const group = await loadPostImageGroup(database, owner);
  const ownerKey = postImageOwnerKey(owner);
  if (!group) { unsavedUnderstanding.delete(ownerKey); return { status: 'stale' }; }
  const groupKey = postImageGroupKey(group);
  const receipt = { owner, group };
  async function transaction<T>(work: (db: SQLiteDatabase) => Promise<T>): Promise<T | null> {
    const committed = await runBackupRestoreDataEpochCommit(epoch, async () => {
      let result: T | null = null;
      await database.withExclusiveTransactionAsync(async db => {
        const current = await loadPostImageGroup(db, owner);
        if (current && postImageGroupKey(current) === groupKey) result = await work(db);
      });
      return result;
    });
    return committed.committed ? committed.value : null;
  }
  const seen = (state: VisionState): PostImageUnderstanding => ({ status: 'seen', description: state.description!,
    recovered: Boolean(state.recovered_pending), receipt });
  const retained = unsavedUnderstanding.get(ownerKey);
  if (retained && (retained.epoch !== epoch || retained.groupKey !== groupKey)) unsavedUnderstanding.delete(ownerKey);
  else if (retained && !signal?.aborted) {
    const saved = await transaction(async db => {
      await db.runAsync('UPDATE baiyun_post_image_vision SET description = ?, recovered_pending = ? WHERE owner_key = ?',
        retained.description, retained.recovered, ownerKey);
      return true;
    });
    unsavedUnderstanding.delete(ownerKey);
    if (saved) notifyImageKnownChanged(owner.postId);
    return saved ? { status: 'seen', description: retained.description, recovered: Boolean(retained.recovered), receipt }
      : { status: 'stale' };
  }
  while (!signal?.aborted) {
    const reserved = await transaction(async db => {
      await db.runAsync(`INSERT OR IGNORE INTO baiyun_post_image_vision
        (owner_key, post_id, comment_source, group_key, opportunity_id, opportunity_at) VALUES (?, ?, ?, ?, ?, ?)`,
        ownerKey, owner.postId, owner.commentSource, groupKey, opportunity.id, opportunity.startedAt);
      const state = await db.getFirstAsync<VisionState>('SELECT * FROM baiyun_post_image_vision WHERE owner_key = ?', ownerKey);
      if (!state || state.group_key !== groupKey) throw new Error('baiyun-post-image-cache-version');
      if (state.description) return { state, call: false };
      if (state.opportunity_id !== opportunity.id) {
        if (opportunity.startedAt <= state.opportunity_at) return { state, call: false };
        state.attempts = 0;
        state.recovered_pending = state.failed_before ? 1 : 0;
      } else if (state.opportunity_at !== opportunity.startedAt) throw new Error('baiyun-post-image-opportunity-changed');
      if (state.attempts >= 2) return { state, call: false };
      await db.runAsync(`UPDATE baiyun_post_image_vision SET opportunity_id = ?, opportunity_at = ?, attempts = ?, recovered_pending = ? WHERE owner_key = ?`,
        opportunity.id, opportunity.startedAt, state.attempts + 1, state.recovered_pending, ownerKey);
      return { state, call: true };
    });
    if (!reserved) return { status: 'stale' };
    if (reserved.state.description) return seen(reserved.state);
    if (!reserved.call) return { status: 'unavailable' };
    let description: string | null;
    try {
      const images = await readPostImagesForVision(group.imageIds);
      if (signal?.aborted) return { status: 'deferred' };
      // Re-check after file IO, before a paid request; a deletion/edit may have happened.
      if (!await transaction(async () => true)) return { status: 'stale' };
      description = await request(images);
      if (description !== null && !description.trim()) throw new Error('baiyun-post-image-empty-understanding');
    } catch {
      if (signal?.aborted) return { status: 'deferred' };
      const failed = await transaction(db => db.runAsync(`UPDATE baiyun_post_image_vision SET failed_before = 1 WHERE owner_key = ?`, ownerKey));
      if (!failed) return { status: 'stale' };
      continue;
    }
    if (description === null) {
      await transaction(db => db.runAsync('UPDATE baiyun_post_image_vision SET attempts = MAX(0, attempts - 1) WHERE owner_key = ?', ownerKey));
      return { status: 'deferred' };
    }
    if (signal?.aborted) return { status: 'deferred' };
    unsavedUnderstanding.set(ownerKey, { epoch, groupKey, description: description.trim(), recovered: reserved.state.recovered_pending });
    const saved = await transaction(async db => {
      // A retry within the first viewing is not a later "this time" recovery.
      const recovered = reserved.state.recovered_pending;
      await db.runAsync(`UPDATE baiyun_post_image_vision SET description = ?, recovered_pending = ? WHERE owner_key = ?`,
        description!.trim(), recovered, ownerKey);
      return { ...reserved.state, description: description!.trim(), recovered_pending: recovered };
    });
    unsavedUnderstanding.delete(ownerKey);
    if (saved) notifyImageKnownChanged(owner.postId);
    return saved ? seen(saved) : { status: 'stale' };
  }
  return { status: 'deferred' };
}
