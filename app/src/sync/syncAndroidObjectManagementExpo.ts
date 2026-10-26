import { File } from 'expo-file-system';

import {
  AndroidSyncObjectManagementController,
} from './syncAndroidObjectManagementCore';
import {
  createAndroidSyncObjectMaterializationRuntime,
} from './syncAndroidObjectMaterializationExpo';
import {
  syncAndroidObjectMetadataStore,
} from './syncAndroidObjectMetadataStore';
import {
  createAndroidSyncObjectRetentionRuntime,
} from './syncAndroidObjectRetentionExpo';
import {
  enqueueAndroidExplicitSyncOperation,
} from './syncAndroidExplicitOperationQueue';
import {
  loadAndroidSyncNetworkClass,
} from './syncAndroidNetworkClass';
import {
  listSyncObjectManagementRecords,
} from './syncObjectJobStore';

export function createAndroidSyncObjectManagementController(input: {
  baseUrl: string;
  timeoutMs?: number;
}) {
  const retention = createAndroidSyncObjectRetentionRuntime();
  return new AndroidSyncObjectManagementController({
    store: {
      listRecords: listSyncObjectManagementRecords,
    },
    metadata: syncAndroidObjectMetadataStore,
    download: (objectId, downloadInput) => (
      enqueueAndroidExplicitSyncOperation(async () => (
        (await createAndroidSyncObjectMaterializationRuntime(input))
          .downloadObject(objectId, downloadInput)
      ))
    ),
    retention: {
      setPinned: (objectId, pinned) => (
        enqueueAndroidExplicitSyncOperation(() => (
          retention.setPinned(objectId, pinned)
        ))
      ),
      evictObject: (objectId) => (
        enqueueAndroidExplicitSyncOperation(() => (
          retention.evictObject(objectId)
        ))
      ),
    },
    localSize: async (localUri) => {
      try {
        const file = new File(localUri);
        return file.exists && typeof file.size === 'number'
          ? file.size
          : null;
      } catch {
        return null;
      }
    },
    networkClass: loadAndroidSyncNetworkClass,
  });
}
