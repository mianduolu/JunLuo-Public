import {
  AndroidSyncObjectTransferRuntime,
} from './syncAndroidObjectTransferCore';
import {
  syncAndroidObjectExpoStore,
} from './syncAndroidObjectExpoStore';
import {
  listRunnableSyncObjectJobs,
  listCurrentSyncObjectReferences,
  loadSyncObjectJob,
  markSyncObjectJobFailed,
  markSyncObjectJobVerified,
  resolveSyncObjectSigningPublicKey,
  startSyncObjectDownloadJob,
  startSyncObjectUploadJob,
  updateSyncObjectJobProgress,
} from './syncObjectJobStore';
import {
  createAndroidSyncRelayClient,
  loadCurrentSyncRelayEnrollment,
} from './syncRelayClientExpo';
import {
  saveSyncDevicePublicIdentity,
} from './syncStore';
import {
  syncAndroidObjectMetadataStore,
} from './syncAndroidObjectMetadataStore';

export async function createAndroidSyncObjectTransferRuntime(input: {
  baseUrl: string;
  timeoutMs?: number;
}) {
  const enrollment = await loadCurrentSyncRelayEnrollment();
  if (!enrollment) {
    throw new Error('Android 尚未登记 active 同步设备。');
  }
  const relay = createAndroidSyncRelayClient(input);
  return new AndroidSyncObjectTransferRuntime(
    relay,
    {
      load: loadSyncObjectJob,
      listRunnable: listRunnableSyncObjectJobs,
      startUpload: startSyncObjectUploadJob,
      startDownload: startSyncObjectDownloadJob,
      updateProgress: updateSyncObjectJobProgress,
      markVerified: markSyncObjectJobVerified,
      markFailed: markSyncObjectJobFailed,
    },
    syncAndroidObjectExpoStore,
    {
      save: saveSyncDevicePublicIdentity,
      resolveSigningPublicKey:
        resolveSyncObjectSigningPublicKey,
    },
    enrollment,
    Date.now,
    {
      record: async (metadata) => {
        const references = await listCurrentSyncObjectReferences(
          metadata.objectId,
        );
        await syncAndroidObjectMetadataStore.record({
          ...metadata,
          domain: references[0]?.mutation.entity.domain ?? null,
        });
      },
    },
  );
}
