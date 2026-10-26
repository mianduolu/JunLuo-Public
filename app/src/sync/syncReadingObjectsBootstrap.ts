import {
  READING_OBJECTS_ADAPTER_ID,
} from './syncReadingObjects';
import {
  syncBootstrapOperationId,
} from './syncBootstrapContract';
import type {
  SyncDevicePublicIdentityV1,
} from './syncDeviceContract';
import type {
  SyncDurableIntentState,
} from './syncRecoveryIntent';
import type {
  PlainMutationV1,
} from './syncProtocol';
import {
  deriveReadingObjectsMutations,
  emptyReadingObjectsLocalIndex,
  type ReadingObjectsEnvelopeFactory,
  type ReadingObjectsLocalIndex,
} from './syncReadingObjectsStorageDerivation';

export const READING_OBJECTS_BOOTSTRAP_VERSION = 1 as const;

export type ReadingObjectsBootstrapStatePort = {
  load(input: {
    adapterId: string;
    version: number;
    sourceDeviceId: string;
  }): Promise<{
    completed: boolean;
    durableIntentState: SyncDurableIntentState | null;
  }>;
  markCompleted(input: {
    adapterId: string;
    version: number;
    sourceDeviceId: string;
    updatedAt: number;
  }): Promise<void>;
};

export type ReadingObjectsBootstrapCapturePort = {
  capture(input: {
    operationId: string;
    mutations: PlainMutationV1[];
    index: ReadingObjectsLocalIndex;
  }): Promise<void>;
};

export type ReadingObjectsBootstrapResult = {
  status: 'already-complete' | 'completed' | 'pending-recovery';
  operationId: string;
  mutationCount: number;
  objectCount: number;
};

export async function runReadingObjectsBootstrap(input: {
  identity: SyncDevicePublicIdentityV1;
  state: ReadingObjectsBootstrapStatePort;
  buildIndex(): Promise<ReadingObjectsLocalIndex>;
  capture: ReadingObjectsBootstrapCapturePort;
  envelopeFactory: ReadingObjectsEnvelopeFactory;
  now?: () => number;
}): Promise<ReadingObjectsBootstrapResult> {
  const adapterId = READING_OBJECTS_ADAPTER_ID;
  const version = READING_OBJECTS_BOOTSTRAP_VERSION;
  const sourceDeviceId = input.identity.deviceId;
  const operationId = syncBootstrapOperationId({
    adapterId,
    version,
    sourceDeviceId,
  });
  const stateInput = { adapterId, version, sourceDeviceId };
  const state = await input.state.load(stateInput);
  if (state.completed) {
    return {
      status: 'already-complete',
      operationId,
      mutationCount: 0,
      objectCount: 0,
    };
  }
  if (state.durableIntentState === 'captured') {
    await input.state.markCompleted({
      ...stateInput,
      updatedAt: (input.now ?? Date.now)(),
    });
    return {
      status: 'completed',
      operationId,
      mutationCount: 0,
      objectCount: 0,
    };
  }
  if (state.durableIntentState !== null) {
    return {
      status: 'pending-recovery',
      operationId,
      mutationCount: 0,
      objectCount: 0,
    };
  }
  const capturedAt = (input.now ?? Date.now)();
  const index = await input.buildIndex();
  const mutations = await deriveReadingObjectsMutations({
    previous: emptyReadingObjectsLocalIndex(),
    next: index,
    capturedAt,
    envelopeFactory: input.envelopeFactory,
  });
  if (mutations.length || index.records.length) {
    await input.capture.capture({
      operationId,
      mutations,
      index,
    });
  }
  await input.state.markCompleted({
    ...stateInput,
    updatedAt: capturedAt,
  });
  return {
    status: 'completed',
    operationId,
    mutationCount: mutations.length,
    objectCount: index.records.length,
  };
}
