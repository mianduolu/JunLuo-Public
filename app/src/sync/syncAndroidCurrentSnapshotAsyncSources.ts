import RawAsyncStorage from '@react-native-async-storage/async-storage';
import { collectAndroidGiftCurrentSnapshotMutations } from './syncGiftsRuntime';

import {
  loadAiConfigPreferencesSnapshot,
} from '../ai/AiConfigPreferences';
import {
  resolveAiCallBudgetScope,
} from '../ai/aiCallBudgetScope';
import {
  runAiLogicalConfigBootstrap,
} from './syncAiLogicalConfigBootstrap';
import {
  readAiLogicalConfigProjection,
} from './syncAiLogicalConfigDerivation';
import {
  runAppearanceBackgroundBootstrap,
} from './syncAppearanceBackgroundBootstrap';
import {
  APPEARANCE_BACKGROUND_INDEX_KEY,
  APPEARANCE_BACKGROUND_SETTINGS_KEY,
  parseAppearanceBackgroundLocalIndex,
  projectAppearanceBackground,
} from './syncAppearanceBackgroundStorageDerivation';
import {
  runAppearanceFontsBootstrap,
} from './syncAppearanceFontsBootstrap';
import {
  APPEARANCE_FONT_CHOICE_KEY,
  APPEARANCE_FONT_INDEX_KEY,
  parseAppearanceFontLocalIndex,
  projectAppearanceFonts,
} from './syncAppearanceFontsStorageDerivation';
import {
  runAppearanceWeatherBootstrap,
} from './syncAppearanceWeatherBootstrap';
import {
  APPEARANCE_WEATHER_ANIMATION_KEY,
  APPEARANCE_WEATHER_OBSERVATION_KEY,
  projectAppearanceWeather,
} from './syncAppearanceWeatherStorageDerivation';
import {
  runAssistantLifeStateBootstrap,
} from './syncAssistantLifeStateBootstrap';
import {
  runBehaviorRoutingBootstrap,
} from './syncBehaviorRoutingBootstrap';
import {
  runCameraPreferencesBootstrap,
} from './syncCameraPreferencesBootstrap';
import {
  runChatRelationshipBootstrap,
} from './syncChatRelationshipBootstrap';
import type {
  ChatCoreMutationEnvelope,
} from './syncChatCore';
import {
  createChatCoreCurrentSnapshotSource,
} from './syncChatCoreCurrentSnapshot';
import {
  runFocusSemanticStorageBootstrap,
} from './syncFocusSemanticBootstrap';
import {
  runLettersLifeBootstrap,
} from './syncLettersLifeBootstrap';
import {
  runMemoryExperienceBootstrap,
} from './syncMemoryExperienceBootstrap';
import {
  runNearbyWorldHealthBootstrap,
} from './syncNearbyWorldHealthBootstrap';
import {
  createCollectedCurrentSnapshotMutationSource,
  type CurrentSnapshotMutationSourceV1,
} from './syncNewWorldBaseline';
import type {
  NewWorldAndroidStagingSecretV1,
} from './syncNewWorldSecretsExpo';
import {
  buildPersonaExpressionObjectsBootstrapChanges,
} from './syncPersonaExpressionObjectsBootstrap';
import {
  derivePersonaExpressionObjectsMutationsForStorageChanges,
  PERSONA_EXPRESSION_OBJECT_BOOTSTRAP_KEYS,
} from './syncPersonaExpressionObjectsStorageDerivation';
import {
  runProactiveLedgerBootstrap,
} from './syncProactiveLedgerBootstrap';
import type {
  PlainMutationV1,
} from './syncProtocol';
import {
  runReadingObjectsBootstrap,
} from './syncReadingObjectsBootstrap';
import {
  deriveReadingObjectsMutations,
  parseReadingObjectsLocalIndex,
  READING_OBJECTS_INDEX_KEY,
  READING_OBJECTS_INDEX_VERSION,
} from './syncReadingObjectsStorageDerivation';
import {
  runReadingWorkspaceBootstrap,
} from './syncReadingWorkspaceBootstrap';
import {
  runRelationshipAuthorizationBootstrap,
} from './syncRelationshipAuthorizationBootstrap';
import {
  runRemoteBudgetBootstrap,
} from './syncRemoteBudgetBootstrap';
import {
  runResearchMaterialsBootstrap,
} from './syncResearchMaterialsBootstrap';
import {
  RESEARCH_MATERIALS_MOBILE_CACHE_PREFIX,
} from './syncResearchMaterialsStorageDerivation';
import {
  runScheduleSemanticStorageBootstrap,
} from './syncScheduleSemanticBootstrap';
import {
  runSemanticReviewBudgetBootstrap,
} from './syncSemanticReviewBudgetBootstrap';
import {
  runTogetherWalkedLifeBootstrap,
} from './syncTogetherWalkedLifeBootstrap';
import {
  deriveTogetherWalkedLifeMutations,
  emptyTogetherWalkedLifeLocalIndex,
  emptyTogetherWalkedLifeRawSnapshot,
  parseTogetherWalkedLifeLocalIndex,
  TOGETHER_WALKED_LIFE_GLOBAL_KEYS,
  TOGETHER_WALKED_LIFE_INDEX_KEY,
  type TogetherWalkedLifeRawSnapshot,
} from './syncTogetherWalkedLifeStorageDerivation';
import {
  runToolsAuditBootstrap,
} from './syncToolsAuditBootstrap';
import {
  runToolsWorkspaceBootstrap,
} from './syncToolsWorkspaceBootstrap';
import {
  readToolsWorkspaceProjection,
} from './syncToolsWorkspaceStorageDerivation';
import {
  runWishPoolLifeBootstrap,
} from './syncWishPoolLifeBootstrap';
import type {
  SyncDevicePublicIdentityV1,
} from './syncDeviceContract';

const TEMPLATE_TIME = 1_786_400_000_000;
const TEMPLATE_VAULT_ID = '00000000-0000-4000-8000-000000000001';
const TEMPLATE_DEVICE_ID = '00000000-0000-4000-8000-000000000002';
const TEMPLATE_KEY_ID = '00000000-0000-4000-8000-000000000003';

const templateIdentity = Object.freeze({
  version: 1 as const,
  vaultId: TEMPLATE_VAULT_ID,
  deviceId: TEMPLATE_DEVICE_ID,
  keyId: TEMPLATE_KEY_ID,
  platform: 'android' as const,
  displayName: 'snapshot-template',
  signingPublicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  exchangePublicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  state: 'active' as const,
  createdAt: TEMPLATE_TIME,
  revokedAt: null,
});

function templateUuid(value: number) {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
}

function createTemplateEnvelopeFactory(
  identity: SyncDevicePublicIdentityV1 = templateIdentity,
) {
  let sequence = 0;
  return async (_entity: {
    domain: string;
    type: string;
    id: string;
  }): Promise<ChatCoreMutationEnvelope> => {
    sequence += 1;
    return {
      mutationId: templateUuid(sequence * 2),
      vaultId: identity.vaultId,
      sourceDeviceId: identity.deviceId,
      sourceSequence: sequence,
      revisionId: templateUuid(sequence * 2 + 1),
      parentRevisionIds: [],
      createdAt: TEMPLATE_TIME,
    };
  };
}

const readOnlyBootstrapState = {
  load: async () => ({ completed: false, durableIntentState: null }),
  markCompleted: async () => undefined,
};

type StorageBootstrapRunner = (input: {
  identity: SyncDevicePublicIdentityV1;
  state: typeof readOnlyBootstrapState;
  storage: typeof RawAsyncStorage;
  capture: {
    capture(input: { mutations: PlainMutationV1[] }): Promise<void>;
  };
  envelopeFactory: ReturnType<typeof createTemplateEnvelopeFactory>;
  now: () => number;
}) => Promise<unknown>;

async function collectStorageBootstrap(
  runner: StorageBootstrapRunner,
  identity: SyncDevicePublicIdentityV1,
) {
  const mutations: PlainMutationV1[] = [];
  await runner({
    identity,
    state: readOnlyBootstrapState,
    storage: RawAsyncStorage,
    capture: {
      capture: async ({ mutations: batch }) => {
        mutations.push(...batch);
      },
    },
    envelopeFactory: createTemplateEnvelopeFactory(identity),
    now: () => TEMPLATE_TIME,
  });
  return mutations;
}

function storageSource(
  adapterId: string,
  runner: unknown,
  identity: SyncDevicePublicIdentityV1,
) {
  return createCollectedCurrentSnapshotMutationSource({
    adapterId,
    collect: () => collectStorageBootstrap(
      runner as StorageBootstrapRunner,
      identity,
    ),
  });
}

export type AndroidCurrentSnapshotAsyncSources = Readonly<{
  sources: readonly CurrentSnapshotMutationSourceV1[];
  scheduleStorage: CurrentSnapshotMutationSourceV1;
  focusStorage: CurrentSnapshotMutationSourceV1;
}>;

export function createAndroidCurrentSnapshotAsyncSources(input: {
  staging?: NewWorldAndroidStagingSecretV1 | null;
} = {}): AndroidCurrentSnapshotAsyncSources {
  const snapshotIdentity = input.staging?.identity ?? templateIdentity;
  const sources: CurrentSnapshotMutationSourceV1[] = [
    createCollectedCurrentSnapshotMutationSource({
      adapterId: 'gifts.life',
      collect: () => collectAndroidGiftCurrentSnapshotMutations({
        identity: input.staging?.identity, secrets: input.staging?.secrets, now: TEMPLATE_TIME,
      }),
    }),
    storageSource('assistant.life-state', runAssistantLifeStateBootstrap, snapshotIdentity),
    storageSource('behavior.routing', runBehaviorRoutingBootstrap, snapshotIdentity),
    storageSource('camera.preferences', runCameraPreferencesBootstrap, snapshotIdentity),
    storageSource('chat.relationship-state', runChatRelationshipBootstrap, snapshotIdentity),
    storageSource('letters.life', runLettersLifeBootstrap, snapshotIdentity),
    storageSource('memory.experience', runMemoryExperienceBootstrap, snapshotIdentity),
    storageSource('nearby-world.health', runNearbyWorldHealthBootstrap, snapshotIdentity),
    storageSource('proactive.ledger', runProactiveLedgerBootstrap, snapshotIdentity),
    storageSource('reading.workspace', runReadingWorkspaceBootstrap, snapshotIdentity),
    storageSource(
      'relationship.authorization',
      runRelationshipAuthorizationBootstrap,
      snapshotIdentity,
    ),
    storageSource('usage.remote-budget', runRemoteBudgetBootstrap, snapshotIdentity),
    storageSource('tools.audit', runToolsAuditBootstrap, snapshotIdentity),
    storageSource('wish-pool.life', runWishPoolLifeBootstrap, snapshotIdentity),
  ];

  sources.push(createChatCoreCurrentSnapshotSource({
    storage: RawAsyncStorage,
    capturedAt: TEMPLATE_TIME,
    createEnvelopeFactory: () => createTemplateEnvelopeFactory(),
  }));

  sources.push(createCollectedCurrentSnapshotMutationSource({
    adapterId: 'usage.semantic-review-budget',
    collect: async () => {
      const config = await loadAiConfigPreferencesSnapshot({ maxAgeMs: 0, readOnly: true });
      const byId = new Map(
        config.connections.map((connection) => [connection.id, connection]),
      );
      const mutations: PlainMutationV1[] = [];
      await runSemanticReviewBudgetBootstrap({
        identity: templateIdentity,
        state: readOnlyBootstrapState,
        storage: RawAsyncStorage,
        resolveRemoteAccountId: (connectionId) => {
          const scope = resolveAiCallBudgetScope(byId.get(connectionId));
          return scope.kind === 'remote-account'
            ? scope.remoteAccountId
            : null;
        },
        capture: {
          capture: async ({ mutations: batch }) => {
            mutations.push(...batch);
          },
        },
        envelopeFactory: createTemplateEnvelopeFactory(),
        now: () => TEMPLATE_TIME,
      });
      return mutations;
    },
  }));

  sources.push(createCollectedCurrentSnapshotMutationSource({
    adapterId: 'persona.expression-objects',
    collect: async () => {
      const values = new Map(
        await RawAsyncStorage.multiGet(
          PERSONA_EXPRESSION_OBJECT_BOOTSTRAP_KEYS,
        ),
      );
      const changes = buildPersonaExpressionObjectsBootstrapChanges(values);
      return derivePersonaExpressionObjectsMutationsForStorageChanges({
        changes,
        reader: { getItem: async () => null },
        capturedAt: TEMPLATE_TIME,
        envelopeFactory: createTemplateEnvelopeFactory(),
      });
    },
  }));

  sources.push(createCollectedCurrentSnapshotMutationSource({
    adapterId: 'reading.objects',
    collect: async () => {
      const next = parseReadingObjectsLocalIndex(
        await RawAsyncStorage.getItem(READING_OBJECTS_INDEX_KEY),
      );
      return deriveReadingObjectsMutations({
        previous: {
          version: READING_OBJECTS_INDEX_VERSION,
          records: [],
          updatedAt: 0,
        },
        next,
        capturedAt: TEMPLATE_TIME,
        envelopeFactory: createTemplateEnvelopeFactory(),
      });
    },
  }));

  sources.push(createCollectedCurrentSnapshotMutationSource({
    adapterId: 'together-walked.life',
    collect: async () => {
      const raw = Object.fromEntries(
        await RawAsyncStorage.multiGet(TOGETHER_WALKED_LIFE_GLOBAL_KEYS),
      ) as TogetherWalkedLifeRawSnapshot;
      const index = parseTogetherWalkedLifeLocalIndex(
        await RawAsyncStorage.getItem(TOGETHER_WALKED_LIFE_INDEX_KEY),
      );
      return deriveTogetherWalkedLifeMutations({
        previousRaw: emptyTogetherWalkedLifeRawSnapshot(),
        nextRaw: raw,
        previousIndex: emptyTogetherWalkedLifeLocalIndex(),
        nextIndex: index,
        capturedAt: TEMPLATE_TIME,
        envelopeFactory: createTemplateEnvelopeFactory(),
      });
    },
  }));

  sources.push(createCollectedCurrentSnapshotMutationSource({
    adapterId: 'ai.logical-config',
    collect: async () => {
      const mutations: PlainMutationV1[] = [];
      await runAiLogicalConfigBootstrap({
        identity: templateIdentity,
        state: readOnlyBootstrapState,
        buildProjection: () => readAiLogicalConfigProjection({
          reader: RawAsyncStorage,
        }),
        capture: {
          capture: async ({ mutations: batch }) => {
            mutations.push(...batch);
          },
        },
        envelopeFactory: createTemplateEnvelopeFactory(),
        now: () => TEMPLATE_TIME,
      });
      return mutations;
    },
  }));

  sources.push(createCollectedCurrentSnapshotMutationSource({
    adapterId: 'appearance.fonts',
    collect: async () => {
      const [choiceRaw, indexRaw] = await Promise.all([
        RawAsyncStorage.getItem(APPEARANCE_FONT_CHOICE_KEY),
        RawAsyncStorage.getItem(APPEARANCE_FONT_INDEX_KEY),
      ]);
      const mutations: PlainMutationV1[] = [];
      const envelopeFactory = createTemplateEnvelopeFactory();
      await runAppearanceFontsBootstrap({
        identity: templateIdentity,
        state: readOnlyBootstrapState,
        buildProjection: async () => projectAppearanceFonts({
          choiceRaw,
          index: parseAppearanceFontLocalIndex(indexRaw),
        }),
        capture: async ({ mutations: batch }) => {
          mutations.push(...batch);
        },
        envelopeFactory: async (entity) => ({
          ...await envelopeFactory(entity),
          parentOperations: [],
        }),
        now: () => TEMPLATE_TIME,
      });
      return mutations;
    },
  }));

  sources.push(createCollectedCurrentSnapshotMutationSource({
    adapterId: 'appearance.background',
    collect: async () => {
      const [settingsRaw, indexRaw] = await Promise.all([
        RawAsyncStorage.getItem(APPEARANCE_BACKGROUND_SETTINGS_KEY),
        RawAsyncStorage.getItem(APPEARANCE_BACKGROUND_INDEX_KEY),
      ]);
      const mutations: PlainMutationV1[] = [];
      await runAppearanceBackgroundBootstrap({
        identity: templateIdentity,
        state: readOnlyBootstrapState,
        buildProjection: async () => projectAppearanceBackground({
          settingsRaw,
          index: parseAppearanceBackgroundLocalIndex(indexRaw),
        }),
        capture: async ({ mutations: batch }) => {
          mutations.push(...batch);
        },
        envelopeFactory: createTemplateEnvelopeFactory(),
        now: () => TEMPLATE_TIME,
      });
      return mutations;
    },
  }));

  sources.push(createCollectedCurrentSnapshotMutationSource({
    adapterId: 'appearance.weather',
    collect: async () => {
      const [animationRaw, observationRaw] = await Promise.all([
        RawAsyncStorage.getItem(APPEARANCE_WEATHER_ANIMATION_KEY),
        RawAsyncStorage.getItem(APPEARANCE_WEATHER_OBSERVATION_KEY),
      ]);
      const mutations: PlainMutationV1[] = [];
      await runAppearanceWeatherBootstrap({
        identity: templateIdentity,
        state: readOnlyBootstrapState,
        buildProjection: async () => projectAppearanceWeather({
          animationRaw,
          observationRaw,
          now: TEMPLATE_TIME,
        }),
        capture: async ({ mutations: batch }) => {
          mutations.push(...batch);
        },
        envelopeFactory: createTemplateEnvelopeFactory(),
        now: () => TEMPLATE_TIME,
      });
      return mutations;
    },
  }));

  sources.push(createCollectedCurrentSnapshotMutationSource({
    adapterId: 'tools.workspace',
    collect: async () => {
      const mutations: PlainMutationV1[] = [];
      await runToolsWorkspaceBootstrap({
        identity: templateIdentity,
        state: readOnlyBootstrapState,
        buildProjection: () => readToolsWorkspaceProjection({
          reader: RawAsyncStorage,
          capturedAt: TEMPLATE_TIME,
        }),
        capture: {
          capture: async ({ mutations: batch }) => {
            mutations.push(...batch);
          },
        },
        envelopeFactory: createTemplateEnvelopeFactory(),
        now: () => TEMPLATE_TIME,
      });
      return mutations;
    },
  }));

  sources.push(createCollectedCurrentSnapshotMutationSource({
    adapterId: 'research.materials',
    collect: async () => {
      const mutations: PlainMutationV1[] = [];
      await runResearchMaterialsBootstrap({
        identity: templateIdentity,
        state: readOnlyBootstrapState,
        buildEntries: async () => {
          const keys = (await RawAsyncStorage.getAllKeys())
            .filter((key) => key.startsWith(
              RESEARCH_MATERIALS_MOBILE_CACHE_PREFIX,
            ));
          return RawAsyncStorage.multiGet(keys);
        },
        capture: async ({ mutations: batch }) => {
          mutations.push(...batch);
        },
        envelopeFactory: createTemplateEnvelopeFactory(),
        now: () => TEMPLATE_TIME,
      });
      return mutations;
    },
  }));

  const scheduleStorage = storageSource(
    'schedule.semantic',
    runScheduleSemanticStorageBootstrap,
    snapshotIdentity,
  );
  const focusStorage = storageSource(
    'focus.semantic',
    runFocusSemanticStorageBootstrap,
    snapshotIdentity,
  );
  return Object.freeze({
    sources: Object.freeze(sources),
    scheduleStorage,
    focusStorage,
  });
}
