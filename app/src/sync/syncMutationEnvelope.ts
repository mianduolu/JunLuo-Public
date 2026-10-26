import {
  assertSyncDevicePublicIdentityV1,
  assertSyncUuidV4,
  type SyncDevicePublicIdentityV1,
} from './syncDeviceContract';
import type { ChatCoreMutationEnvelope } from './syncChatCore';
import { getSyncEntityIdMaximumLength } from './syncProtocol';

export type SyncMutationEntityRef = {
  domain: string;
  type: string;
  id: string;
};

export interface SyncMutationStatePort {
  allocateSyncSourceSequence(sourceDeviceId: string, allocatedAt: number): Promise<number>;
  loadSyncEntityHeadRevisionIds(entity: SyncMutationEntityRef): Promise<string[]>;
}

export type SyncRandomUuidPort = () => string | Promise<string>;

const DOMAIN_TOKEN_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

function assertEntityRef(entity: SyncMutationEntityRef) {
  for (const [label, value] of [
    ['domain', entity.domain],
    ['type', entity.type],
  ] as const) {
    if (value.length < 1 || value.length > 80 || !DOMAIN_TOKEN_PATTERN.test(value)) {
      throw new Error(`sync entity ${label} 格式无效。`);
    }
  }
  const maximumLength = getSyncEntityIdMaximumLength(entity.domain, entity.type);
  if (!entity.id || entity.id.length > maximumLength) {
    throw new Error(`sync entity id 长度必须在 1–${maximumLength} 之间。`);
  }
}

function readTimestamp(now: (() => number) | undefined) {
  const value = (now ?? Date.now)();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('mutation createdAt 必须是非负 Unix 毫秒整数。');
  }
  return value;
}

async function readUuid(randomUuid: SyncRandomUuidPort, label: string) {
  const value = await randomUuid();
  assertSyncUuidV4(value, label);
  return value;
}

export async function createSyncMutationEnvelope(input: {
  identity: SyncDevicePublicIdentityV1;
  entity: SyncMutationEntityRef;
  state: SyncMutationStatePort;
  randomUuid: SyncRandomUuidPort;
  now?: () => number;
}): Promise<ChatCoreMutationEnvelope> {
  assertSyncDevicePublicIdentityV1(input.identity);
  if (input.identity.state !== 'active' || input.identity.revokedAt !== null) {
    throw new Error('只有 active 且未撤销的本机设备可以创建同步 mutation。');
  }
  assertEntityRef(input.entity);
  const createdAt = readTimestamp(input.now);
  const [mutationId, revisionId, parentRevisionIds, sourceSequence] = await Promise.all([
    readUuid(input.randomUuid, 'mutationId'),
    readUuid(input.randomUuid, 'revisionId'),
    input.state.loadSyncEntityHeadRevisionIds(input.entity),
    input.state.allocateSyncSourceSequence(input.identity.deviceId, createdAt),
  ]);
  if (mutationId === revisionId) {
    throw new Error('mutationId 与 revisionId 不能相同。');
  }
  parentRevisionIds.forEach((revision, index) => {
    assertSyncUuidV4(revision, `parentRevisionIds[${index}]`);
  });
  if (new Set(parentRevisionIds).size !== parentRevisionIds.length) {
    throw new Error('parentRevisionIds 不能重复。');
  }
  if (!Number.isSafeInteger(sourceSequence) || sourceSequence < 1) {
    throw new Error('sourceSequence 必须是正安全整数。');
  }
  return {
    mutationId,
    vaultId: input.identity.vaultId,
    sourceDeviceId: input.identity.deviceId,
    sourceSequence,
    revisionId,
    parentRevisionIds: [...parentRevisionIds].sort(),
    createdAt,
  };
}
