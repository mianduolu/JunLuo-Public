import {
  SYNC_DOMAIN_CATALOG,
  type SyncDomainCatalogEntry,
} from './syncDomainCatalog';
import {
  assertPlainMutationV1,
  type PlainMutationV1,
  type SyncSensitivity,
} from './syncProtocol';

const sensitivityRank: Record<SyncSensitivity, number> = {
  private: 0,
  high: 1,
  highest: 2,
};

const schemaVersionsByAdapterId:
Readonly<Record<string, readonly number[]>> = {
  'memory.records': [1, 2, 3, 4, 5],
  'continuity.ledger': [1, 2, 3, 4, 5],
  'letters.life': [1, 2],
  'wish-pool.life': [1, 2],
  'theater.isolated': [1, 2],
  'expense.ledger': [1, 2],
};

const schemaVersionsByRoute:
Readonly<Record<string, readonly number[]>> = {
  'chat\u0000message-summary': [1, 2],
  'memory\u0000style-memory': [1, 2, 3, 4, 5],
  'memory\u0000memory': [1, 2, 3, 4, 5, 9, 10],
  'memory\u0000post': [5, 6, 9, 10],
  'memory\u0000post-comment': [5, 6],
  'memory\u0000post-tag': [5, 7],
  'memory\u0000post-confirmation': [5],
  'memory\u0000post-review': [8],
  'memory\u0000post-review-action': [8],
};

const byRoute = new Map<string, SyncDomainCatalogEntry>();

if (SYNC_DOMAIN_CATALOG.length !== 41) {
  throw new Error('Android 同步机器总账必须恰好包含 41 个适配器。');
}

for (const entry of SYNC_DOMAIN_CATALOG) {
  for (const entityType of entry.entityTypes) {
    const route = `${entry.domain}\u0000${entityType}`;
    if (byRoute.has(route)) {
      throw new Error(
        `Android 同步机器总账重复路由：${entry.domain}/${entityType}。`,
      );
    }
    byRoute.set(route, entry);
  }
}

export function resolveAndroidSyncDomain(
  mutation: PlainMutationV1,
) {
  assertPlainMutationV1(mutation);
  const route = `${mutation.entity.domain}\u0000${mutation.entity.type}`;
  const entry = byRoute.get(route);
  if (!entry) {
    throw new Error(
      `路由不属于 41 域机器总账：${mutation.entity.domain}/${mutation.entity.type}。`,
    );
  }
  const supportedSchemaVersions = schemaVersionsByRoute[route]
    ?? schemaVersionsByAdapterId[entry.adapterId]
    ?? [1];
  if (!supportedSchemaVersions.includes(
    mutation.revision.schemaVersion,
  )) {
    throw new Error(
      `${entry.adapterId} 不支持 schema ${mutation.revision.schemaVersion}。`,
    );
  }
  if (
    sensitivityRank[mutation.sensitivity]
    < sensitivityRank[entry.sensitivity]
  ) {
    throw new Error(
      `${entry.adapterId} mutation 敏感级别低于机器总账。`,
    );
  }
  if (
    mutation.revision.operation === 'delete'
    && entry.deleteModes.every((mode) => mode === 'append-only')
  ) {
    throw new Error(`${entry.adapterId} 是 append-only，不能接收 delete。`);
  }
  if (entry.adapterId === 'continuity.pending-operation') {
    throw new Error(
      'continuity.pending-operation 是设备本机崩溃恢复 journal，'
      + '不得作为跨设备 mutation 接收。',
    );
  }
  return entry;
}
