import type { PlainMutationV1 } from './syncProtocol';

export type SyncApplyResult = {
  status: 'applied' | 'already-applied' | 'conflict';
  revisionIds: string[];
};

export interface SyncDomainAdapter {
  readonly domain: string;
  readonly entityType: string;
  readonly schemaVersions: readonly number[];
  apply(mutation: PlainMutationV1): Promise<SyncApplyResult>;
}

export type SyncAdapterResolutionErrorCode = 'unknown_adapter' | 'unsupported_schema';

export class SyncAdapterResolutionError extends Error {
  constructor(
    readonly code: SyncAdapterResolutionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SyncAdapterResolutionError';
  }
}

function adapterKey(domain: string, entityType: string) {
  return `${domain}\u0000${entityType}`;
}

export class SyncAdapterRegistry {
  private readonly adapters = new Map<string, SyncDomainAdapter>();

  register(adapter: SyncDomainAdapter) {
    const key = adapterKey(adapter.domain, adapter.entityType);
    if (this.adapters.has(key)) {
      throw new Error(`同步适配器重复登记：${adapter.domain}/${adapter.entityType}。`);
    }
    if (adapter.schemaVersions.length === 0) {
      throw new Error(`同步适配器没有声明 schema 版本：${adapter.domain}/${adapter.entityType}。`);
    }
    this.adapters.set(key, adapter);
  }

  resolve(mutation: PlainMutationV1) {
    const adapter = this.adapters.get(adapterKey(mutation.entity.domain, mutation.entity.type));
    if (!adapter) {
      throw new SyncAdapterResolutionError(
        'unknown_adapter',
        `没有 ${mutation.entity.domain}/${mutation.entity.type} 的同步适配器。`,
      );
    }
    if (!adapter.schemaVersions.includes(mutation.revision.schemaVersion)) {
      throw new SyncAdapterResolutionError(
        'unsupported_schema',
        `${mutation.entity.domain}/${mutation.entity.type} 不支持 schema ${mutation.revision.schemaVersion}。`,
      );
    }
    return adapter;
  }
}

