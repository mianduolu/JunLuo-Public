import type {
  SyncObjectRetentionCandidate,
} from './syncObjectJobStore';
import {
  canEvictLocalSyncObject,
} from './syncObjectPolicy';
import {
  assertBase64Url,
} from './syncProtocol';

export interface AndroidSyncObjectRetentionStore {
  setPinned(input: {
    objectId: string;
    pinned: boolean;
    updatedAt: number;
  }): Promise<{
    objectId: string;
    pinned: boolean;
    needsDownload: boolean;
  }>;
  refreshClocks(observedAt: number): Promise<void>;
  listCandidates(limit: number): Promise<SyncObjectRetentionCandidate[]>;
  loadCandidate(
    objectId: string,
  ): Promise<SyncObjectRetentionCandidate | null>;
  markLocalEvicted(input: {
    objectId: string;
    evictedAt: number;
  }): Promise<{
    objectId: string;
    evictedAt: number;
  }>;
}

export interface AndroidSyncManagedObjectFileStore {
  deleteObject(objectId: string): Promise<boolean>;
}

export class AndroidSyncObjectRetentionRuntime {
  constructor(
    private readonly store: AndroidSyncObjectRetentionStore,
    private readonly files: AndroidSyncManagedObjectFileStore,
    private readonly now: () => number = Date.now,
  ) {}

  setPinned(objectId: string, pinned: boolean) {
    assertBase64Url(objectId, 'objectId', { exactBytes: 32 });
    if (typeof pinned !== 'boolean') {
      throw new Error('object pinned 必须是 boolean。');
    }
    return this.store.setPinned({
      objectId,
      pinned,
      updatedAt: this.now(),
    });
  }

  async evictObject(objectId: string) {
    assertBase64Url(objectId, 'objectId', { exactBytes: 32 });
    const observedAt = this.now();
    await this.store.refreshClocks(observedAt);
    const candidate = await this.store.loadCandidate(objectId);
    if (
      !candidate
      || !canEvictLocalSyncObject({
        pinned: candidate.pinned,
        remoteVerified: candidate.remoteVerified,
        liveReferenceCount: candidate.liveReferenceCount,
        unreferencedAt: candidate.unreferencedAt,
        now: observedAt,
      })
    ) {
      throw new Error('object 不满足本机安全回收条件。');
    }
    const physicallyRemoved = await this.files.deleteObject(objectId);
    await this.store.markLocalEvicted({
      objectId,
      evictedAt: observedAt,
    });
    return {
      objectId,
      physicallyRemoved,
      evictedAt: observedAt,
    };
  }

  async cleanupUnreferencedObjects(limit = 16) {
    if (
      !Number.isSafeInteger(limit)
      || limit < 1
      || limit > 256
    ) {
      throw new Error('单次对象回收只能处理 1–256 项。');
    }
    const observedAt = this.now();
    await this.store.refreshClocks(observedAt);
    const evicted = [];
    for (const candidate of await this.store.listCandidates(limit)) {
      if (
        !canEvictLocalSyncObject({
          pinned: candidate.pinned,
          remoteVerified: candidate.remoteVerified,
          liveReferenceCount: candidate.liveReferenceCount,
          unreferencedAt: candidate.unreferencedAt,
          now: observedAt,
        })
      ) {
        continue;
      }
      const physicallyRemoved = await this.files.deleteObject(
        candidate.objectId,
      );
      await this.store.markLocalEvicted({
        objectId: candidate.objectId,
        evictedAt: observedAt,
      });
      evicted.push({
        objectId: candidate.objectId,
        physicallyRemoved,
        evictedAt: observedAt,
      });
    }
    return evicted;
  }
}
