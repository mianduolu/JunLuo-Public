import {
  syncAndroidObjectExpoStore,
} from './syncAndroidObjectExpoStore';
import {
  loadSyncObjectJob,
  scheduleSyncObjectUpload,
} from './syncObjectJobStore';

export async function ensureAndroidContentObjectUpload(input: {
  objectId: string;
  keyId: string;
  totalChunks: number;
  objectIdKey: Uint8Array;
  now: number;
}) {
  const job = await loadSyncObjectJob(input.objectId);
  if (job) {
    if (
      job.keyId !== input.keyId
      || job.totalChunks !== input.totalChunks
    ) {
      throw new Error('本机对象索引与 v2 传输任务不一致。');
    }
    if (
      job.direction === 'upload'
      || (job.state === 'verified' && job.localUri)
    ) {
      return true;
    }
  }
  const localUri = await syncAndroidObjectExpoStore.verifiedObjectUri(
    input.objectId,
    input.objectIdKey,
  );
  if (!localUri) return false;
  await scheduleSyncObjectUpload({
    objectId: input.objectId,
    keyId: input.keyId,
    totalChunks: input.totalChunks,
    localUri,
    now: input.now,
  });
  return true;
}
