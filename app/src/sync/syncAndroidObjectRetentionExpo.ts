import {
  AndroidSyncObjectRetentionRuntime,
} from './syncAndroidObjectRetentionCore';
import {
  deleteSyncManagedObjectFile,
} from './syncObjectExpoFilePort';
import {
  loadSyncObjectRetentionCandidate,
  listUnreferencedVerifiedSyncObjects,
  markSyncObjectLocalEvicted,
  refreshSyncObjectRetentionClocks,
  setSyncObjectPinned,
} from './syncObjectJobStore';

export function createAndroidSyncObjectRetentionRuntime() {
  return new AndroidSyncObjectRetentionRuntime(
    {
      setPinned: setSyncObjectPinned,
      refreshClocks: refreshSyncObjectRetentionClocks,
      listCandidates: listUnreferencedVerifiedSyncObjects,
      loadCandidate: loadSyncObjectRetentionCandidate,
      markLocalEvicted: markSyncObjectLocalEvicted,
    },
    {
      deleteObject: deleteSyncManagedObjectFile,
    },
  );
}
