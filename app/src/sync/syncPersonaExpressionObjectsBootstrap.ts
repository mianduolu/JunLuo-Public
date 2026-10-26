import {
  PERSONA_EXPRESSION_OBJECTS_ADAPTER_ID,
} from './syncPersonaExpressionObjects';
import {
  PERSONA_EXPRESSION_OBJECT_BOOTSTRAP_KEYS,
  PERSONA_EXPRESSION_OBJECT_KEYS,
  derivePersonaExpressionObjectsMutationsForStorageChanges,
  parsePersonaExpressionLibraryStorage,
  serializePersonaExpressionLibraryStorage,
  type PersonaExpressionObjectsEnvelopeFactory,
  type PersonaExpressionObjectsStorageChange,
} from './syncPersonaExpressionObjectsStorageDerivation';
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

export const PERSONA_EXPRESSION_OBJECTS_BOOTSTRAP_VERSION = 1 as const;

export type PersonaExpressionObjectsBootstrapStatePort = {
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

export type PersonaExpressionObjectsBootstrapStoragePort = {
  multiGet(
    keys: readonly string[],
  ): Promise<readonly (readonly [string, string | null])[]>;
  removeItem(key: string): Promise<void>;
};

export type PersonaExpressionObjectsBootstrapCapturePort = {
  capture(input: {
    operationId: string;
    mutations: PlainMutationV1[];
    businessWrites: readonly (readonly [string, string])[];
  }): Promise<void>;
};

export type PersonaExpressionObjectsBootstrapResult = {
  status: 'already-complete' | 'completed' | 'pending-recovery';
  operationId: string;
  mutationCount: number;
  objectBackedStickerCount: number;
};

const emptyStorageReader = {
  getItem: async () => null,
};

function removeLegacyExpressionLibrary(
  storage: PersonaExpressionObjectsBootstrapStoragePort,
) {
  return storage.removeItem(
    PERSONA_EXPRESSION_OBJECT_KEYS.legacyExpressionLibrary,
  );
}

export function buildPersonaExpressionObjectsBootstrapChanges(
  values: ReadonlyMap<string, string | null>,
) {
  const changes: PersonaExpressionObjectsStorageChange[] = [];
  const currentExpression = values.get(
    PERSONA_EXPRESSION_OBJECT_KEYS.expressionLibrary,
  ) ?? null;
  const legacyExpression = values.get(
    PERSONA_EXPRESSION_OBJECT_KEYS.legacyExpressionLibrary,
  ) ?? null;
  if (currentExpression !== null) {
    changes.push({
      kind: 'set',
      key: PERSONA_EXPRESSION_OBJECT_KEYS.expressionLibrary,
      value: currentExpression,
    });
  } else if (legacyExpression !== null) {
    changes.push({
      kind: 'set',
      key: PERSONA_EXPRESSION_OBJECT_KEYS.expressionLibrary,
      value: serializePersonaExpressionLibraryStorage(
        parsePersonaExpressionLibraryStorage(
          legacyExpression,
          'legacy persona expression library',
        ),
      ),
    });
  }
  const stickerLibrary = values.get(
    PERSONA_EXPRESSION_OBJECT_KEYS.stickerLibrary,
  ) ?? null;
  if (stickerLibrary !== null) {
    changes.push({
      kind: 'set',
      key: PERSONA_EXPRESSION_OBJECT_KEYS.stickerLibrary,
      value: stickerLibrary,
    });
  }
  return changes;
}

export async function runPersonaExpressionObjectsBootstrap(input: {
  identity: SyncDevicePublicIdentityV1;
  state: PersonaExpressionObjectsBootstrapStatePort;
  storage: PersonaExpressionObjectsBootstrapStoragePort;
  prepareChanges(
    changes: readonly PersonaExpressionObjectsStorageChange[],
  ): Promise<PersonaExpressionObjectsStorageChange[]>;
  capture: PersonaExpressionObjectsBootstrapCapturePort;
  envelopeFactory: PersonaExpressionObjectsEnvelopeFactory;
  now?: () => number;
}): Promise<PersonaExpressionObjectsBootstrapResult> {
  const adapterId = PERSONA_EXPRESSION_OBJECTS_ADAPTER_ID;
  const version = PERSONA_EXPRESSION_OBJECTS_BOOTSTRAP_VERSION;
  const sourceDeviceId = input.identity.deviceId;
  const operationId = syncBootstrapOperationId({
    adapterId,
    version,
    sourceDeviceId,
  });
  const stateInput = { adapterId, version, sourceDeviceId };
  const state = await input.state.load(stateInput);
  if (state.completed) {
    await removeLegacyExpressionLibrary(input.storage);
    return {
      status: 'already-complete',
      operationId,
      mutationCount: 0,
      objectBackedStickerCount: 0,
    };
  }
  if (state.durableIntentState === 'captured') {
    await removeLegacyExpressionLibrary(input.storage);
    await input.state.markCompleted({
      ...stateInput,
      updatedAt: (input.now ?? Date.now)(),
    });
    return {
      status: 'completed',
      operationId,
      mutationCount: 0,
      objectBackedStickerCount: 0,
    };
  }
  if (state.durableIntentState !== null) {
    return {
      status: 'pending-recovery',
      operationId,
      mutationCount: 0,
      objectBackedStickerCount: 0,
    };
  }
  const entries = await input.storage.multiGet(
    PERSONA_EXPRESSION_OBJECT_BOOTSTRAP_KEYS,
  );
  const allowed = new Set<string>(
    PERSONA_EXPRESSION_OBJECT_BOOTSTRAP_KEYS,
  );
  const values = new Map<string, string | null>();
  for (const [key, value] of entries) {
    if (!allowed.has(key)) {
      throw new Error(
        `persona.expression-objects bootstrap 返回未登记 key：${key}。`,
      );
    }
    if (values.has(key)) {
      throw new Error(
        `persona.expression-objects bootstrap 重复返回 key：${key}。`,
      );
    }
    values.set(key, value);
  }
  const changes = await input.prepareChanges(
    buildPersonaExpressionObjectsBootstrapChanges(values),
  );
  const capturedAt = (input.now ?? Date.now)();
  const mutations =
    await derivePersonaExpressionObjectsMutationsForStorageChanges({
      changes,
      reader: emptyStorageReader,
      capturedAt,
      envelopeFactory: input.envelopeFactory,
    });
  const businessWrites = changes.flatMap((change) => (
    change.kind === 'set'
      ? [[change.key, change.value] as const]
      : []
  ));
  if (mutations.length || businessWrites.length) {
    await input.capture.capture({
      operationId,
      mutations,
      businessWrites,
    });
  }
  await removeLegacyExpressionLibrary(input.storage);
  await input.state.markCompleted({
    ...stateInput,
    updatedAt: capturedAt,
  });
  return {
    status: 'completed',
    operationId,
    mutationCount: mutations.length,
    objectBackedStickerCount: mutations.filter(
      (mutation) => mutation.entity.type === 'sticker',
    ).length,
  };
}
