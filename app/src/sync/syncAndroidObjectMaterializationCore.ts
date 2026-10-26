import type {
  AndroidSyncObjectTransferRuntime,
} from './syncAndroidObjectTransferCore';
import {
  SYNC_DOMAIN_CATALOG,
  type SyncDomainCatalogEntry,
} from './syncDomainCatalog';
import type {
  SyncCurrentObjectReference,
  SyncObjectJob,
  SyncObjectMaterializationState,
} from './syncObjectJobStore';
import {
  assertBase64Url,
} from './syncProtocol';
import type {
  SyncObjectNetworkClass,
} from './syncObjectPolicy';

export type AndroidSyncObjectMaterializerResult = {
  handled: boolean;
  pending?: boolean;
  changed?: boolean;
};

export type AndroidSyncObjectMaterializer = {
  adapterId: string;
  materializeVerifiedObject(input: {
    objectId: string;
    localUri: string;
    references: readonly SyncCurrentObjectReference[];
  }): Promise<AndroidSyncObjectMaterializerResult>;
};

export type AndroidSyncObjectMaterializationRoute = {
  adapterId: string;
  referenceFingerprint: string;
  references: SyncCurrentObjectReference[];
};

export interface AndroidSyncObjectMaterializationStore {
  loadJob(objectId: string): Promise<SyncObjectJob | null>;
  listVerifiedJobs(input: {
    limit: number;
    afterObjectId: string | null;
  }): Promise<SyncObjectJob[]>;
  listCurrentReferences(
    objectId: string,
  ): Promise<SyncCurrentObjectReference[]>;
  loadState(input: {
    objectId: string;
    adapterId: string;
  }): Promise<SyncObjectMaterializationState | null>;
  saveState(input: {
    objectId: string;
    adapterId: string;
    referenceFingerprint: string;
    state: SyncObjectMaterializationState['state'];
    lastErrorCode?: string | null;
    updatedAt: number;
  }): Promise<void>;
}

const byRoute = new Map<string, SyncDomainCatalogEntry>();

if (SYNC_DOMAIN_CATALOG.length !== 41) {
  throw new Error('Android 同步机器总账必须恰好包含 41 个适配器。');
}

for (const entry of SYNC_DOMAIN_CATALOG) {
  for (const entityType of entry.entityTypes) {
    const route = `${entry.domain}\u0000${entityType}`;
    if (byRoute.has(route)) {
      throw new Error(
        `Android 同步机器总账重复路由：`
        + `${entry.domain}/${entityType}。`,
      );
    }
    byRoute.set(route, entry);
  }
}

export const REQUIRED_ANDROID_OBJECT_CONSUMER_ADAPTER_IDS =
  SYNC_DOMAIN_CATALOG
    .filter((entry) => (
      entry.storageKinds as readonly string[]
    ).includes('file-object'))
    .map((entry) => entry.adapterId);

const requiredObjectConsumers = new Set(
  REQUIRED_ANDROID_OBJECT_CONSUMER_ADAPTER_IDS,
);

function assertLocalUri(localUri: string) {
  if (!/^file:\/\//.test(localUri)) {
    throw new Error('verified object localUri 必须是 file URI。');
  }
}

function resolveObjectConsumerAdapterId(
  reference: SyncCurrentObjectReference,
) {
  const entry = byRoute.get(
    `${reference.domain}\u0000${reference.entityType}`,
  );
  if (!entry) {
    throw new Error(
      `对象引用路由不属于 41 域机器总账：`
      + `${reference.domain}/${reference.entityType}。`,
    );
  }
  if (
    entry.adapterId === 'chat.core'
    && (
      reference.entityType === 'subjective-message'
      || reference.entityType === 'attachment-metadata'
    )
  ) {
    return 'chat.objects';
  }
  if (!requiredObjectConsumers.has(entry.adapterId)) {
    throw new Error(
      `对象引用路由没有 file-object consumer：`
      + `${reference.domain}/${reference.entityType}。`,
    );
  }
  return entry.adapterId;
}

function referenceFingerprint(
  references: readonly SyncCurrentObjectReference[],
) {
  return JSON.stringify(
    references
      .map((reference) => [
        reference.domain,
        reference.entityType,
        reference.entityId,
        reference.mutation.revision.id,
      ])
      .sort((left, right) => (
        left.join('\u0000').localeCompare(right.join('\u0000'))
      )),
  );
}

function assertMaterializerResult(
  adapterId: string,
  result: AndroidSyncObjectMaterializerResult,
) {
  if (
    !result
    || typeof result.handled !== 'boolean'
    || (
      result.pending !== undefined
      && typeof result.pending !== 'boolean'
    )
    || (
      result.changed !== undefined
      && typeof result.changed !== 'boolean'
    )
    || (result.handled && result.pending)
  ) {
    throw new Error(
      `${adapterId} Android 对象 materializer 返回无效状态。`,
    );
  }
}

export class AndroidSyncObjectConsumerRegistry {
  private readonly byAdapterId =
    new Map<string, AndroidSyncObjectMaterializer>();

  constructor(
    materializers: readonly AndroidSyncObjectMaterializer[],
  ) {
    for (const materializer of materializers) {
      if (!requiredObjectConsumers.has(materializer.adapterId)) {
        throw new Error(
          `Android 对象 materializer 不属于 ${requiredObjectConsumers.size} 域总账：`
          + `${materializer.adapterId}。`,
        );
      }
      if (this.byAdapterId.has(materializer.adapterId)) {
        throw new Error(
          `Android 对象 materializer 重复注册：`
          + `${materializer.adapterId}。`,
        );
      }
      this.byAdapterId.set(materializer.adapterId, materializer);
    }
  }

  assertCompleteObjectCoverage() {
    const missing = REQUIRED_ANDROID_OBJECT_CONSUMER_ADAPTER_IDS
      .filter((adapterId) => !this.byAdapterId.has(adapterId));
    if (missing.length) {
      throw new Error(
        `Android 对象 consumer 未覆盖 ${requiredObjectConsumers.size} 域：`
        + `${missing.join(', ')}。`,
      );
    }
    return {
      requiredAdapterIds: [
        ...REQUIRED_ANDROID_OBJECT_CONSUMER_ADAPTER_IDS,
      ],
    };
  }

  routeCurrentReferences(
    references: readonly SyncCurrentObjectReference[],
  ) {
    const byAdapter = new Map<
      string,
      SyncCurrentObjectReference[]
    >();
    for (const reference of references) {
      const adapterId = resolveObjectConsumerAdapterId(reference);
      const current = byAdapter.get(adapterId) ?? [];
      current.push(reference);
      byAdapter.set(adapterId, current);
    }
    return REQUIRED_ANDROID_OBJECT_CONSUMER_ADAPTER_IDS
      .flatMap((adapterId): AndroidSyncObjectMaterializationRoute[] => {
        const routed = byAdapter.get(adapterId);
        return routed
          ? [{
            adapterId,
            referenceFingerprint: referenceFingerprint(routed),
            references: routed,
          }]
          : [];
      });
  }

  async materializeRoute(input: {
    objectId: string;
    localUri: string;
    route: AndroidSyncObjectMaterializationRoute;
  }) {
    const materializer = this.byAdapterId.get(input.route.adapterId);
    if (!materializer) {
      return {
        handled: false as const,
        pending: true as const,
      };
    }
    const result = await materializer.materializeVerifiedObject({
      objectId: input.objectId,
      localUri: input.localUri,
      references: input.route.references,
    });
    assertMaterializerResult(input.route.adapterId, result);
    return result;
  }
}

export class AndroidSyncObjectMaterializationRuntime {
  constructor(
    private readonly transfer: Pick<
      AndroidSyncObjectTransferRuntime,
      'downloadObject'
    >,
    private readonly store: AndroidSyncObjectMaterializationStore,
    private readonly consumers: AndroidSyncObjectConsumerRegistry,
    private readonly now: () => number = Date.now,
  ) {}

  async materializeVerifiedObject(objectId: string) {
    assertBase64Url(objectId, 'objectId', { exactBytes: 32 });
    const job = await this.store.loadJob(objectId);
    if (job?.state !== 'verified' || !job.localUri) {
      return {
        state: 'pending-object' as const,
        objectId,
        adapters: [],
      };
    }
    assertLocalUri(job.localUri);
    const references = await this.store.listCurrentReferences(objectId);
    const routes = this.consumers.routeCurrentReferences(references);
    const adapters = [];
    for (const route of routes) {
      const previous = await this.store.loadState({
        objectId,
        adapterId: route.adapterId,
      });
      if (
        previous?.state === 'materialized'
        && previous.referenceFingerprint === route.referenceFingerprint
      ) {
        adapters.push({
          adapterId: route.adapterId,
          state: 'materialized' as const,
          cached: true,
        });
        continue;
      }
      await this.store.saveState({
        objectId,
        adapterId: route.adapterId,
        referenceFingerprint: route.referenceFingerprint,
        state: 'pending',
        updatedAt: this.now(),
      });
      try {
        const result = await this.consumers.materializeRoute({
          objectId,
          localUri: job.localUri,
          route,
        });
        const state = result.handled ? 'materialized' : 'pending';
        await this.store.saveState({
          objectId,
          adapterId: route.adapterId,
          referenceFingerprint: route.referenceFingerprint,
          state,
          updatedAt: this.now(),
        });
        adapters.push({
          adapterId: route.adapterId,
          state: result.handled
            ? 'materialized' as const
            : result.pending
              ? 'pending-object' as const
              : 'pending-state' as const,
          cached: false,
        });
      } catch (error) {
        await this.store.saveState({
          objectId,
          adapterId: route.adapterId,
          referenceFingerprint: route.referenceFingerprint,
          state: 'failed',
          lastErrorCode: 'object.materialization-failed',
          updatedAt: this.now(),
        });
        throw error;
      }
    }
    return {
      state: routes.length === 0
        ? 'local-only' as const
        : adapters.every((entry) => entry.state === 'materialized')
          ? 'materialized' as const
          : 'pending' as const,
      objectId,
      adapters,
    };
  }

  async downloadObject(
    objectId: string,
    input: {
      network: SyncObjectNetworkClass;
      requestedByUser: boolean;
      maximumChunks?: number;
    },
  ) {
    const downloaded = await this.transfer.downloadObject(objectId, input);
    if (downloaded.state !== 'downloaded') return downloaded;
    return {
      ...downloaded,
      materialization: await this.materializeVerifiedObject(objectId),
    };
  }

  async resumeVerifiedObjects(input: {
    limit?: number;
    afterObjectId?: string | null;
  } = {}) {
    const limit = input.limit ?? 16;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
      throw new Error('对象物化恢复 limit 必须为 1..256。');
    }
    if (input.afterObjectId) {
      assertBase64Url(input.afterObjectId, 'afterObjectId', {
        exactBytes: 32,
      });
    }
    const jobs = await this.store.listVerifiedJobs({
      limit,
      afterObjectId: input.afterObjectId ?? null,
    });
    const results = [];
    for (const job of jobs) {
      results.push(await this.materializeVerifiedObject(job.objectId));
    }
    return {
      results,
      nextObjectId: jobs.length === limit
        ? jobs[jobs.length - 1]?.objectId ?? null
        : null,
    };
  }
}

export function createCompleteAndroidSyncObjectConsumerRegistry(
  materializers: readonly AndroidSyncObjectMaterializer[],
) {
  const registry = new AndroidSyncObjectConsumerRegistry(materializers);
  registry.assertCompleteObjectCoverage();
  return registry;
}
