import {
  promoteResearchMaterialsBackendObjects,
  promoteResearchMaterialsBackendOutbox,
} from './syncResearchMaterialsBackendOutbox';
import {
  ResearchMaterialsBackendRelayObjectPort,
  ResearchMaterialsBackendRelayOutboxPort,
} from './syncResearchMaterialsBackendRelayPort';
import {
  captureResearchMaterialsBackendObject,
} from './syncResearchMaterialsBackendObjectExpo';
import { expoSyncRandomUuidV1 } from './syncCryptoExpo';
import { createSyncMutationEnvelope } from './syncMutationEnvelope';
import {
  enqueueSyncMutationAndAdvanceHeads,
  syncMutationStatePort,
} from './syncMutationStateStore';
import {
  createAndroidSyncRelayClient,
  loadCurrentSyncRelayEnrollment,
} from './syncRelayClientExpo';

export async function runAndroidResearchMaterialsBackendBridge(input: {
  baseUrl: string;
  now?: () => number;
  limit?: number;
}) {
  const enrollment = await loadCurrentSyncRelayEnrollment();
  if (!enrollment) {
    throw new Error('Android 尚未登记 active 同步设备。');
  }
  const relay = createAndroidSyncRelayClient({ baseUrl: input.baseUrl });
  const inlinePort = new ResearchMaterialsBackendRelayOutboxPort(
    relay,
    enrollment,
  );
  const now = (input.now ?? Date.now)();
  const envelopeFactory = (entity: {
    domain: string;
    type: string;
    id: string;
  }, createdAt: number) => createSyncMutationEnvelope({
    identity: enrollment.publicIdentity,
    entity,
    state: syncMutationStatePort,
    randomUuid: expoSyncRandomUuidV1,
    now: () => createdAt,
  });
  const limit = Math.min(4, Math.max(1, input.limit ?? 4));
  const inline = await promoteResearchMaterialsBackendOutbox({
    port: inlinePort,
    envelopeFactory,
    enqueueCentralMutation: enqueueSyncMutationAndAdvanceHeads,
    leaseId: `research-${expoSyncRandomUuidV1()}`,
    now,
    leaseDurationMs: 60_000,
    retryDelayMs: 5_000,
    limit,
  });
  const objectPort = new ResearchMaterialsBackendRelayObjectPort(
    relay,
    enrollment,
  );
  const objects = await promoteResearchMaterialsBackendObjects({
    port: objectPort,
    envelopeFactory,
    enqueueCentralMutation: enqueueSyncMutationAndAdvanceHeads,
    captureObject: (entry, port) => (
      captureResearchMaterialsBackendObject({
        entry,
        port,
        enrollment,
        now,
      })
    ),
    leaseId: `research-object-${expoSyncRandomUuidV1()}`,
    now,
    leaseDurationMs: 60_000,
    limit,
  });
  return {
    inline,
    objects,
    deferredObjectCount: inlinePort.deferredObjectCount,
  };
}
