import {
  READING_WORKSPACE_ADAPTER_ID,
} from './syncReadingWorkspace';
import {
  deriveReadingWorkspaceMutationsForStorageChanges,
  isReadingWorkspaceManagedStorageKey,
  parseReadingWorkspaceManagedKey,
  type ReadingWorkspaceEnvelopeFactory,
} from './syncReadingWorkspaceStorageDerivation';
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

export const READING_WORKSPACE_BOOTSTRAP_VERSION = 1 as const;

export type ReadingWorkspaceBootstrapStatePort = {
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

export type ReadingWorkspaceBootstrapStoragePort = {
  getAllKeys(): Promise<readonly string[]>;
  multiGet(
    keys: readonly string[],
  ): Promise<readonly (readonly [string, string | null])[]>;
};

export type ReadingWorkspaceBootstrapCapturePort = {
  capture(input: {
    operationId: string;
    mutations: PlainMutationV1[];
  }): Promise<void>;
};

export type ReadingWorkspaceBootstrapResult = {
  status: 'already-complete' | 'completed' | 'pending-recovery';
  operationId: string;
  mutationCount: number;
};

const emptyStorageReader = {
  getItem: async () => null,
};

function bootstrapKeyOrder(key: string) {
  const managed = parseReadingWorkspaceManagedKey(key);
  if (!managed) return 99;
  switch (managed.kind) {
    case 'library':
      return 0;
    case 'chapter':
      return 1;
    case 'annotations':
      return 2;
    case 'notes':
      return 3;
    case 'result-actions':
      return 4;
    case 'sessions':
      return 5;
    case 'web-clips':
      return 6;
  }
}

export async function runReadingWorkspaceBootstrap(input: {
  identity: SyncDevicePublicIdentityV1;
  state: ReadingWorkspaceBootstrapStatePort;
  storage: ReadingWorkspaceBootstrapStoragePort;
  capture: ReadingWorkspaceBootstrapCapturePort;
  envelopeFactory: ReadingWorkspaceEnvelopeFactory;
  now?: () => number;
}): Promise<ReadingWorkspaceBootstrapResult> {
  const adapterId = READING_WORKSPACE_ADAPTER_ID;
  const version = READING_WORKSPACE_BOOTSTRAP_VERSION;
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
    };
  }
  if (state.durableIntentState !== null) {
    return {
      status: 'pending-recovery',
      operationId,
      mutationCount: 0,
    };
  }
  const keys = [...new Set(await input.storage.getAllKeys())]
    .filter(isReadingWorkspaceManagedStorageKey)
    .sort((left, right) => (
      bootstrapKeyOrder(left) - bootstrapKeyOrder(right)
      || left.localeCompare(right)
    ));
  const entries = await input.storage.multiGet(keys);
  const expected = new Set(keys);
  const seen = new Set<string>();
  const changes = entries.flatMap(([key, value]) => {
    if (!expected.has(key)) {
      throw new Error(
        `reading.workspace bootstrap 返回未登记 key：${key}。`,
      );
    }
    if (seen.has(key)) {
      throw new Error(
        `reading.workspace bootstrap 重复返回 key：${key}。`,
      );
    }
    seen.add(key);
    return value === null
      ? []
      : [{ kind: 'set' as const, key, value }];
  });
  if (seen.size !== keys.length) {
    throw new Error('reading.workspace bootstrap 未返回全部登记 key。');
  }
  const capturedAt = (input.now ?? Date.now)();
  const mutations =
    await deriveReadingWorkspaceMutationsForStorageChanges({
      changes,
      reader: emptyStorageReader,
      capturedAt,
      envelopeFactory: input.envelopeFactory,
    });
  if (mutations.length) {
    await input.capture.capture({ operationId, mutations });
  }
  await input.state.markCompleted({
    ...stateInput,
    updatedAt: capturedAt,
  });
  return {
    status: 'completed',
    operationId,
    mutationCount: mutations.length,
  };
}
