import {
  RelationshipAuthorizationBusinessApplier,
  RELATIONSHIP_AUTHORIZATION_BATCH_CAPTURE_POLICY,
} from './syncRelationshipAuthorizationApply';
import {
  relationshipAuthorizationAsyncStorageBusinessPort,
} from './syncRelationshipAuthorizationAsyncStoragePort';
import {
  ScheduleSemanticBusinessApplier,
  SCHEDULE_SEMANTIC_BATCH_CAPTURE_POLICY,
} from './syncScheduleSemanticApply';
import {
  scheduleSemanticBusinessPort,
} from './syncScheduleSemanticBusinessPort';
import {
  TodoSemanticBusinessApplier,
  TODO_SEMANTIC_BATCH_CAPTURE_POLICY,
} from './syncTodoSemanticApply';
import {
  todoSemanticSqliteBusinessPort,
} from './syncTodoSemanticSqliteApply';
import {
  FocusSemanticBusinessApplier,
  FOCUS_SEMANTIC_BATCH_CAPTURE_POLICY,
} from './syncFocusSemanticApply';
import {
  focusSemanticBusinessPort,
} from './syncFocusSemanticBusinessPort';
import {
  ReadingWorkspaceBusinessApplier,
  READING_WORKSPACE_BATCH_CAPTURE_POLICY,
} from './syncReadingWorkspaceApply';
import {
  readingWorkspaceAsyncStorageBusinessPort,
} from './syncReadingWorkspaceAsyncStoragePort';
import {
  ReadingObjectsBusinessApplier,
  READING_OBJECTS_BATCH_CAPTURE_POLICY,
} from './syncReadingObjectsApply';
import {
  readingObjectsAsyncStorageBusinessPort,
} from './syncReadingObjectsAsyncStoragePort';
import {
  LettersLifeBusinessApplier,
  LETTERS_LIFE_BATCH_CAPTURE_POLICY,
} from './syncLettersLifeApply';
import {
  lettersLifeAsyncStorageBusinessPort,
} from './syncLettersLifeAsyncStoragePort';
import {
  WishPoolLifeBusinessApplier,
  WISH_POOL_LIFE_BATCH_CAPTURE_POLICY,
} from './syncWishPoolLifeApply';
import {
  wishPoolLifeAsyncStorageBusinessPort,
} from './syncWishPoolLifeAsyncStoragePort';
import {
  TogetherWalkedLifeBusinessApplier,
  TOGETHER_WALKED_LIFE_BATCH_CAPTURE_POLICY,
} from './syncTogetherWalkedLifeApply';
import {
  togetherWalkedLifeAsyncStorageBusinessPort,
} from './syncTogetherWalkedLifeAsyncStoragePort';
import {
  TheaterIsolatedBusinessApplier,
  THEATER_ISOLATED_BATCH_CAPTURE_POLICY,
} from './syncTheaterIsolatedApply';
import {
  theaterIsolatedSqliteBusinessPort,
} from './syncTheaterIsolatedSqliteApply';
import {
  ExpenseLedgerBusinessApplier,
  EXPENSE_LEDGER_BATCH_CAPTURE_POLICY,
} from './syncExpenseLedgerApply';
import {
  expenseLedgerSqliteBusinessPort,
} from './syncExpenseLedgerSqliteApply';
import {
  WalletLedgerBusinessApplier,
  WALLET_LEDGER_BATCH_CAPTURE_POLICY,
} from './syncWalletLedgerApply';
import {
  walletLedgerSqliteBusinessPort,
} from './syncWalletLedgerSqliteApply';
import {
  PeriodHealthBusinessApplier,
  PERIOD_HEALTH_BATCH_CAPTURE_POLICY,
} from './syncPeriodHealthApply';
import {
  periodHealthSqliteBusinessPort,
} from './syncPeriodHealthSqliteApply';
import {
  BodySignalHealthBusinessApplier,
  BODY_SIGNAL_HEALTH_BATCH_CAPTURE_POLICY,
} from './syncBodySignalHealthApply';
import {
  bodySignalHealthSqliteBusinessPort,
} from './syncBodySignalHealthSqliteApply';
import {
  NearbyWorldHealthBusinessApplier,
  NEARBY_WORLD_HEALTH_BATCH_CAPTURE_POLICY,
} from './syncNearbyWorldHealthApply';
import {
  nearbyWorldHealthAsyncStorageBusinessPort,
} from './syncNearbyWorldHealthAsyncStoragePort';
import {
  CameraPreferencesBusinessApplier,
  CAMERA_PREFERENCES_BATCH_CAPTURE_POLICY,
} from './syncCameraPreferencesApply';
import {
  cameraPreferencesAsyncStorageBusinessPort,
} from './syncCameraPreferencesAsyncStoragePort';
import {
  ToolsAuditBusinessApplier,
  TOOLS_AUDIT_BATCH_CAPTURE_POLICY,
} from './syncToolsAuditApply';
import {
  toolsAuditAsyncStorageBusinessPort,
} from './syncToolsAuditAsyncStoragePort';
import {
  ToolsWorkspaceBusinessApplier,
  TOOLS_WORKSPACE_BATCH_CAPTURE_POLICY,
} from './syncToolsWorkspaceApply';
import {
  toolsWorkspaceAsyncStorageBusinessPort,
} from './syncToolsWorkspaceAsyncStoragePort';
import {
  VaultExportableSessionBusinessApplier,
  VAULT_EXPORTABLE_SESSIONS_BATCH_CAPTURE_POLICY,
} from './syncVaultExportableSessionsApply';
import {
  VaultSharedSecretBusinessApplier,
  VAULT_SHARED_SECRETS_BATCH_CAPTURE_POLICY,
} from './syncVaultSharedSecretsApply';
import {
  AiLogicalConfigBusinessApplier,
  AI_LOGICAL_CONFIG_BATCH_CAPTURE_POLICY,
  aiLogicalConfigAsyncStorageBusinessPort,
} from './syncAiLogicalConfigApply';
import {
  AppearanceFontBusinessApplier,
  APPEARANCE_FONTS_BATCH_CAPTURE_POLICY,
  appearanceFontAsyncStorageBusinessPort,
} from './syncAppearanceFontsApply';
import {
  AppearanceBackgroundBusinessApplier,
  APPEARANCE_BACKGROUND_BATCH_CAPTURE_POLICY,
} from './syncAppearanceBackgroundApply';
import {
  appearanceBackgroundAsyncStorageBusinessPort,
} from './syncAppearanceBackgroundAsyncStoragePort';
import {
  AppearanceWeatherBusinessApplier,
  APPEARANCE_WEATHER_BATCH_CAPTURE_POLICY,
} from './syncAppearanceWeatherApply';
import {
  appearanceWeatherAsyncStorageBusinessPort,
} from './syncAppearanceWeatherAsyncStoragePort';
import {
  ResearchMaterialsBusinessApplier,
  RESEARCH_MATERIALS_BATCH_CAPTURE_POLICY,
} from './syncResearchMaterialsApply';
import {
  researchMaterialsAsyncStorageBusinessPort,
} from './syncResearchMaterialsAsyncStoragePort';
import {
  SemanticReviewBudgetBusinessApplier,
  SEMANTIC_REVIEW_BUDGET_BATCH_CAPTURE_POLICY,
} from './syncSemanticReviewBudgetApply';
import {
  semanticReviewBudgetAsyncStorageBusinessPort,
} from './syncSemanticReviewBudgetAsyncStoragePort';
import {
  BehaviorRoutingBusinessApplier,
  BEHAVIOR_ROUTING_BATCH_CAPTURE_POLICY,
} from './syncBehaviorRoutingApply';
import {
  behaviorRoutingAsyncStorageBusinessPort,
} from './syncBehaviorRoutingAsyncStoragePort';
import {
  AssistantLifeStateBusinessApplier,
  ASSISTANT_LIFE_STATE_BATCH_CAPTURE_POLICY,
} from './syncAssistantLifeStateApply';
import {
  assistantLifeStateAsyncStorageBusinessPort,
} from './syncAssistantLifeStateAsyncStoragePort';
import {
  ChatCoreBusinessApplier,
  CHAT_CORE_BATCH_CAPTURE_POLICY,
} from './syncChatCoreApply';
import {
  chatCoreNonRecursingBusinessPort,
} from './syncChatCoreNonRecursingPort';
import {
  ChatRelationshipBusinessApplier,
  CHAT_RELATIONSHIP_BATCH_CAPTURE_POLICY,
} from './syncChatRelationshipApply';
import {
  chatRelationshipAsyncStorageBusinessPort,
} from './syncChatRelationshipAsyncStoragePort';
import {
  MemoryExperienceBusinessApplier,
  MEMORY_EXPERIENCE_BATCH_CAPTURE_POLICY,
} from './syncMemoryExperienceApply';
import {
  memoryExperienceAsyncStorageBusinessPort,
} from './syncMemoryExperienceAsyncStoragePort';
import {
  PersonaExpressionObjectsBusinessApplier,
  PERSONA_EXPRESSION_OBJECTS_BATCH_CAPTURE_POLICY,
} from './syncPersonaExpressionObjectsApply';
import {
  personaExpressionObjectsAsyncStorageBusinessPort,
} from './syncPersonaExpressionObjectsAsyncStoragePort';
import {
  ProactiveLedgerBusinessApplier,
  PROACTIVE_LEDGER_BATCH_CAPTURE_POLICY,
} from './syncProactiveLedgerApply';
import {
  proactiveLedgerAsyncStorageBusinessPort,
} from './syncProactiveLedgerAsyncStoragePort';
import {
  REMOTE_BUDGET_BATCH_CAPTURE_POLICY,
} from './syncRemoteBudgetApply';
import {
  recoverRemoteBudgetStorageCapture,
} from './syncRemoteBudgetStorageBridge';
import {
  recoverSyncMutationBatch,
  SYNC_MUTATION_BATCH_CAPTURE_KIND,
} from './syncMutationBatchCapture';
import {
  enqueueSyncMutationAndAdvanceHeads,
} from './syncMutationStateStore';
import {
  createSyncRecoveryDispatcher,
} from './syncRecoveryDispatcher';
import {
  advanceSyncDurableIntent,
  prepareSyncDurableIntent,
} from './syncStore';

const durableCapture = {
  prepareSyncDurableIntent,
  advanceSyncDurableIntent,
  enqueueSyncMutation: enqueueSyncMutationAndAdvanceHeads,
};

const chatCoreBusinessApplier = new ChatCoreBusinessApplier(
  chatCoreNonRecursingBusinessPort,
);

const chatRelationshipBusinessApplier = new ChatRelationshipBusinessApplier(
  chatRelationshipAsyncStorageBusinessPort,
);

const memoryExperienceBusinessApplier = new MemoryExperienceBusinessApplier(
  memoryExperienceAsyncStorageBusinessPort,
);

const assistantLifeStateBusinessApplier = new AssistantLifeStateBusinessApplier(
  assistantLifeStateAsyncStorageBusinessPort,
);


const personaExpressionObjectsBusinessApplier =
  new PersonaExpressionObjectsBusinessApplier(
    personaExpressionObjectsAsyncStorageBusinessPort,
  );

const proactiveLedgerBusinessApplier = new ProactiveLedgerBusinessApplier(
  proactiveLedgerAsyncStorageBusinessPort,
);
const behaviorRoutingBusinessApplier = new BehaviorRoutingBusinessApplier(
  behaviorRoutingAsyncStorageBusinessPort,
);
const semanticReviewBudgetBusinessApplier = new SemanticReviewBudgetBusinessApplier(
  semanticReviewBudgetAsyncStorageBusinessPort,
);
const relationshipAuthorizationBusinessApplier =
  new RelationshipAuthorizationBusinessApplier(
    relationshipAuthorizationAsyncStorageBusinessPort,
  );
const scheduleSemanticBusinessApplier =
  new ScheduleSemanticBusinessApplier(
    scheduleSemanticBusinessPort,
  );
const todoSemanticBusinessApplier =
  new TodoSemanticBusinessApplier(
    todoSemanticSqliteBusinessPort,
  );
const focusSemanticBusinessApplier =
  new FocusSemanticBusinessApplier(
    focusSemanticBusinessPort,
  );
const readingWorkspaceBusinessApplier =
  new ReadingWorkspaceBusinessApplier(
    readingWorkspaceAsyncStorageBusinessPort,
  );
const readingObjectsBusinessApplier =
  new ReadingObjectsBusinessApplier(
    readingObjectsAsyncStorageBusinessPort,
  );

const lettersLifeBusinessApplier =
  new LettersLifeBusinessApplier(
    lettersLifeAsyncStorageBusinessPort,
  );

const wishPoolLifeBusinessApplier =
  new WishPoolLifeBusinessApplier(
    wishPoolLifeAsyncStorageBusinessPort,
  );

const togetherWalkedLifeBusinessApplier =
  new TogetherWalkedLifeBusinessApplier(
    togetherWalkedLifeAsyncStorageBusinessPort,
  );

const theaterIsolatedBusinessApplier =
  new TheaterIsolatedBusinessApplier(
    theaterIsolatedSqliteBusinessPort,
  );

const expenseLedgerBusinessApplier =
  new ExpenseLedgerBusinessApplier(
    expenseLedgerSqliteBusinessPort,
  );

const walletLedgerBusinessApplier =
  new WalletLedgerBusinessApplier(
    walletLedgerSqliteBusinessPort,
  );

const periodHealthBusinessApplier =
  new PeriodHealthBusinessApplier(
    periodHealthSqliteBusinessPort,
  );

const bodySignalHealthBusinessApplier =
  new BodySignalHealthBusinessApplier(
    bodySignalHealthSqliteBusinessPort,
  );

const nearbyWorldHealthBusinessApplier =
  new NearbyWorldHealthBusinessApplier(
    nearbyWorldHealthAsyncStorageBusinessPort,
  );

const cameraPreferencesBusinessApplier =
  new CameraPreferencesBusinessApplier(
    cameraPreferencesAsyncStorageBusinessPort,
  );

const toolsAuditBusinessApplier =
  new ToolsAuditBusinessApplier(
    toolsAuditAsyncStorageBusinessPort,
  );

const toolsWorkspaceBusinessApplier =
  new ToolsWorkspaceBusinessApplier(
    toolsWorkspaceAsyncStorageBusinessPort,
  );

const vaultExportableSessionBusinessApplier =
  new VaultExportableSessionBusinessApplier({
    upsert: async (input) => {
      const {
        vaultExportableSessionSecretStoreBusinessPort,
      } = await import(
        './syncVaultExportableSessionsSecretStorePort'
      );
      await vaultExportableSessionSecretStoreBusinessPort.upsert(input);
    },
    revoke: async (input) => {
      const {
        vaultExportableSessionSecretStoreBusinessPort,
      } = await import(
        './syncVaultExportableSessionsSecretStorePort'
      );
      await vaultExportableSessionSecretStoreBusinessPort.revoke(input);
    },
  });

const vaultSharedSecretBusinessApplier =
  new VaultSharedSecretBusinessApplier({
    upsert: async (input) => {
      const {
        vaultSharedSecretStoreBusinessPort,
      } = await import(
        './syncVaultSharedSecretsSecretStorePort'
      );
      await vaultSharedSecretStoreBusinessPort.upsert(input);
    },
    revoke: async (input) => {
      const {
        vaultSharedSecretStoreBusinessPort,
      } = await import(
        './syncVaultSharedSecretsSecretStorePort'
      );
      await vaultSharedSecretStoreBusinessPort.revoke(input);
    },
  });

const aiLogicalConfigBusinessApplier =
  new AiLogicalConfigBusinessApplier(
    aiLogicalConfigAsyncStorageBusinessPort,
  );

const appearanceFontBusinessApplier =
  new AppearanceFontBusinessApplier(
    appearanceFontAsyncStorageBusinessPort,
  );

const appearanceBackgroundBusinessApplier =
  new AppearanceBackgroundBusinessApplier(
    appearanceBackgroundAsyncStorageBusinessPort,
  );

const appearanceWeatherBusinessApplier =
  new AppearanceWeatherBusinessApplier(
    appearanceWeatherAsyncStorageBusinessPort,
  );

const researchMaterialsBusinessApplier =
  new ResearchMaterialsBusinessApplier(
    researchMaterialsAsyncStorageBusinessPort,
  );

export const recoverKnownSyncDurableIntents = createSyncRecoveryDispatcher([
  {
    adapterId: CHAT_CORE_BATCH_CAPTURE_POLICY.adapterId,
    kind: SYNC_MUTATION_BATCH_CAPTURE_KIND,
    recover: async (durableIntent) => {
      await recoverSyncMutationBatch({
        policy: CHAT_CORE_BATCH_CAPTURE_POLICY,
        durableCapture,
        businessApplier: chatCoreBusinessApplier,
        durableIntent,
      });
    },
  },
  {
    adapterId: CHAT_RELATIONSHIP_BATCH_CAPTURE_POLICY.adapterId,
    kind: SYNC_MUTATION_BATCH_CAPTURE_KIND,
    recover: async (durableIntent) => {
      await recoverSyncMutationBatch({
        policy: CHAT_RELATIONSHIP_BATCH_CAPTURE_POLICY,
        durableCapture,
        businessApplier: chatRelationshipBusinessApplier,
        durableIntent,
      });
    },
  },
  {
    adapterId: MEMORY_EXPERIENCE_BATCH_CAPTURE_POLICY.adapterId,
    kind: SYNC_MUTATION_BATCH_CAPTURE_KIND,
    recover: async (durableIntent) => {
      await recoverSyncMutationBatch({
        policy: MEMORY_EXPERIENCE_BATCH_CAPTURE_POLICY,
        durableCapture,
        businessApplier: memoryExperienceBusinessApplier,
        durableIntent,
      });
    },
  },
  {
    adapterId: ASSISTANT_LIFE_STATE_BATCH_CAPTURE_POLICY.adapterId,
    kind: SYNC_MUTATION_BATCH_CAPTURE_KIND,
    recover: async (durableIntent) => {
      await recoverSyncMutationBatch({
        policy: ASSISTANT_LIFE_STATE_BATCH_CAPTURE_POLICY,
        durableCapture,
        businessApplier: assistantLifeStateBusinessApplier,
        durableIntent,
      });
    },
  },
  {
    adapterId: PERSONA_EXPRESSION_OBJECTS_BATCH_CAPTURE_POLICY.adapterId,
    kind: SYNC_MUTATION_BATCH_CAPTURE_KIND,
    recover: async (durableIntent) => {
      await recoverSyncMutationBatch({
        policy: PERSONA_EXPRESSION_OBJECTS_BATCH_CAPTURE_POLICY,
        durableCapture,
        businessApplier: personaExpressionObjectsBusinessApplier,
        durableIntent,
      });
    },
  },
  {
    adapterId: PROACTIVE_LEDGER_BATCH_CAPTURE_POLICY.adapterId,
    kind: SYNC_MUTATION_BATCH_CAPTURE_KIND,
    recover: async (durableIntent) => {
      await recoverSyncMutationBatch({
        policy: PROACTIVE_LEDGER_BATCH_CAPTURE_POLICY,
        durableCapture,
        businessApplier: proactiveLedgerBusinessApplier,
        durableIntent,
      });
    },
  },
  {
    adapterId: REMOTE_BUDGET_BATCH_CAPTURE_POLICY.adapterId,
    kind: SYNC_MUTATION_BATCH_CAPTURE_KIND,
    recover: recoverRemoteBudgetStorageCapture,
  },
  {
    adapterId: BEHAVIOR_ROUTING_BATCH_CAPTURE_POLICY.adapterId,
    kind: SYNC_MUTATION_BATCH_CAPTURE_KIND,
    recover: async (durableIntent) => {
      await recoverSyncMutationBatch({
        policy: BEHAVIOR_ROUTING_BATCH_CAPTURE_POLICY,
        durableCapture,
        businessApplier: behaviorRoutingBusinessApplier,
        durableIntent,
      });
    },
  },
  {
    adapterId: SEMANTIC_REVIEW_BUDGET_BATCH_CAPTURE_POLICY.adapterId,
    kind: SYNC_MUTATION_BATCH_CAPTURE_KIND,
    recover: async (durableIntent) => {
      await recoverSyncMutationBatch({
        policy: SEMANTIC_REVIEW_BUDGET_BATCH_CAPTURE_POLICY,
        durableCapture,
        businessApplier: semanticReviewBudgetBusinessApplier,
        durableIntent,
      });
    },
  },
  {
    adapterId: RELATIONSHIP_AUTHORIZATION_BATCH_CAPTURE_POLICY.adapterId,
    kind: SYNC_MUTATION_BATCH_CAPTURE_KIND,
    recover: async (durableIntent) => {
      await recoverSyncMutationBatch({
        policy: RELATIONSHIP_AUTHORIZATION_BATCH_CAPTURE_POLICY,
        durableCapture,
        businessApplier: relationshipAuthorizationBusinessApplier,
        durableIntent,
      });
    },
  },
  {
    adapterId: SCHEDULE_SEMANTIC_BATCH_CAPTURE_POLICY.adapterId,
    kind: SYNC_MUTATION_BATCH_CAPTURE_KIND,
    recover: async (durableIntent) => {
      await recoverSyncMutationBatch({
        policy: SCHEDULE_SEMANTIC_BATCH_CAPTURE_POLICY,
        durableCapture,
        businessApplier: scheduleSemanticBusinessApplier,
        durableIntent,
      });
    },
  },
  {
    adapterId: TODO_SEMANTIC_BATCH_CAPTURE_POLICY.adapterId,
    kind: SYNC_MUTATION_BATCH_CAPTURE_KIND,
    recover: async (durableIntent) => {
      await recoverSyncMutationBatch({
        policy: TODO_SEMANTIC_BATCH_CAPTURE_POLICY,
        durableCapture,
        businessApplier: todoSemanticBusinessApplier,
        durableIntent,
      });
    },
  },
  {
    adapterId: FOCUS_SEMANTIC_BATCH_CAPTURE_POLICY.adapterId,
    kind: SYNC_MUTATION_BATCH_CAPTURE_KIND,
    recover: async (durableIntent) => {
      await recoverSyncMutationBatch({
        policy: FOCUS_SEMANTIC_BATCH_CAPTURE_POLICY,
        durableCapture,
        businessApplier: focusSemanticBusinessApplier,
        durableIntent,
      });
    },
  },
  {
    adapterId: READING_WORKSPACE_BATCH_CAPTURE_POLICY.adapterId,
    kind: SYNC_MUTATION_BATCH_CAPTURE_KIND,
    recover: async (durableIntent) => {
      await recoverSyncMutationBatch({
        policy: READING_WORKSPACE_BATCH_CAPTURE_POLICY,
        durableCapture,
        businessApplier: readingWorkspaceBusinessApplier,
        durableIntent,
      });
    },
  },
  {
    adapterId: READING_OBJECTS_BATCH_CAPTURE_POLICY.adapterId,
    kind: SYNC_MUTATION_BATCH_CAPTURE_KIND,
    recover: async (durableIntent) => {
      await recoverSyncMutationBatch({
        policy: READING_OBJECTS_BATCH_CAPTURE_POLICY,
        durableCapture,
        businessApplier: readingObjectsBusinessApplier,
        durableIntent,
      });
    },
  },
  {
    adapterId: LETTERS_LIFE_BATCH_CAPTURE_POLICY.adapterId,
    kind: SYNC_MUTATION_BATCH_CAPTURE_KIND,
    recover: async (durableIntent) => {
      await recoverSyncMutationBatch({
        policy: LETTERS_LIFE_BATCH_CAPTURE_POLICY,
        durableCapture,
        businessApplier: lettersLifeBusinessApplier,
        durableIntent,
      });
    },
  },
  {
    adapterId: WISH_POOL_LIFE_BATCH_CAPTURE_POLICY.adapterId,
    kind: SYNC_MUTATION_BATCH_CAPTURE_KIND,
    recover: async (durableIntent) => {
      await recoverSyncMutationBatch({
        policy: WISH_POOL_LIFE_BATCH_CAPTURE_POLICY,
        durableCapture,
        businessApplier: wishPoolLifeBusinessApplier,
        durableIntent,
      });
    },
  },
  {
    adapterId:
      TOGETHER_WALKED_LIFE_BATCH_CAPTURE_POLICY.adapterId,
    kind: SYNC_MUTATION_BATCH_CAPTURE_KIND,
    recover: async (durableIntent) => {
      await recoverSyncMutationBatch({
        policy: TOGETHER_WALKED_LIFE_BATCH_CAPTURE_POLICY,
        durableCapture,
        businessApplier: togetherWalkedLifeBusinessApplier,
        durableIntent,
      });
    },
  },
  {
    adapterId:
      THEATER_ISOLATED_BATCH_CAPTURE_POLICY.adapterId,
    kind: SYNC_MUTATION_BATCH_CAPTURE_KIND,
    recover: async (durableIntent) => {
      await recoverSyncMutationBatch({
        policy: THEATER_ISOLATED_BATCH_CAPTURE_POLICY,
        durableCapture,
        businessApplier: theaterIsolatedBusinessApplier,
        durableIntent,
      });
    },
  },
  {
    adapterId:
      EXPENSE_LEDGER_BATCH_CAPTURE_POLICY.adapterId,
    kind: SYNC_MUTATION_BATCH_CAPTURE_KIND,
    recover: async (durableIntent) => {
      await recoverSyncMutationBatch({
        policy: EXPENSE_LEDGER_BATCH_CAPTURE_POLICY,
        durableCapture,
        businessApplier: expenseLedgerBusinessApplier,
        durableIntent,
      });
    },
  },
  {
    adapterId:
      WALLET_LEDGER_BATCH_CAPTURE_POLICY.adapterId,
    kind: SYNC_MUTATION_BATCH_CAPTURE_KIND,
    recover: async (durableIntent) => {
      await recoverSyncMutationBatch({
        policy: WALLET_LEDGER_BATCH_CAPTURE_POLICY,
        durableCapture,
        businessApplier: walletLedgerBusinessApplier,
        durableIntent,
      });
    },
  },
  {
    adapterId:
      PERIOD_HEALTH_BATCH_CAPTURE_POLICY.adapterId,
    kind: SYNC_MUTATION_BATCH_CAPTURE_KIND,
    recover: async (durableIntent) => {
      await recoverSyncMutationBatch({
        policy: PERIOD_HEALTH_BATCH_CAPTURE_POLICY,
        durableCapture,
        businessApplier: periodHealthBusinessApplier,
        durableIntent,
      });
    },
  },
  {
    adapterId:
      BODY_SIGNAL_HEALTH_BATCH_CAPTURE_POLICY.adapterId,
    kind: SYNC_MUTATION_BATCH_CAPTURE_KIND,
    recover: async (durableIntent) => {
      await recoverSyncMutationBatch({
        policy:
          BODY_SIGNAL_HEALTH_BATCH_CAPTURE_POLICY,
        durableCapture,
        businessApplier:
          bodySignalHealthBusinessApplier,
        durableIntent,
      });
    },
  },
  {
    adapterId:
      NEARBY_WORLD_HEALTH_BATCH_CAPTURE_POLICY.adapterId,
    kind: SYNC_MUTATION_BATCH_CAPTURE_KIND,
    recover: async (durableIntent) => {
      await recoverSyncMutationBatch({
        policy: NEARBY_WORLD_HEALTH_BATCH_CAPTURE_POLICY,
        durableCapture,
        businessApplier: nearbyWorldHealthBusinessApplier,
        durableIntent,
      });
    },
  },
  {
    adapterId:
      CAMERA_PREFERENCES_BATCH_CAPTURE_POLICY.adapterId,
    kind: SYNC_MUTATION_BATCH_CAPTURE_KIND,
    recover: async (durableIntent) => {
      await recoverSyncMutationBatch({
        policy: CAMERA_PREFERENCES_BATCH_CAPTURE_POLICY,
        durableCapture,
        businessApplier: cameraPreferencesBusinessApplier,
        durableIntent,
      });
    },
  },
  {
    adapterId:
      TOOLS_AUDIT_BATCH_CAPTURE_POLICY.adapterId,
    kind: SYNC_MUTATION_BATCH_CAPTURE_KIND,
    recover: async (durableIntent) => {
      await recoverSyncMutationBatch({
        policy: TOOLS_AUDIT_BATCH_CAPTURE_POLICY,
        durableCapture,
        businessApplier: toolsAuditBusinessApplier,
        durableIntent,
      });
    },
  },
  {
    adapterId:
      TOOLS_WORKSPACE_BATCH_CAPTURE_POLICY.adapterId,
    kind: SYNC_MUTATION_BATCH_CAPTURE_KIND,
    recover: async (durableIntent) => {
      await recoverSyncMutationBatch({
        policy: TOOLS_WORKSPACE_BATCH_CAPTURE_POLICY,
        durableCapture,
        businessApplier: toolsWorkspaceBusinessApplier,
        durableIntent,
      });
    },
  },
  {
    adapterId:
      VAULT_EXPORTABLE_SESSIONS_BATCH_CAPTURE_POLICY.adapterId,
    kind: SYNC_MUTATION_BATCH_CAPTURE_KIND,
    recover: async (durableIntent) => {
      await recoverSyncMutationBatch({
        policy: VAULT_EXPORTABLE_SESSIONS_BATCH_CAPTURE_POLICY,
        durableCapture,
        businessApplier:
          vaultExportableSessionBusinessApplier,
        durableIntent,
      });
    },
  },
  {
    adapterId:
      VAULT_SHARED_SECRETS_BATCH_CAPTURE_POLICY.adapterId,
    kind: SYNC_MUTATION_BATCH_CAPTURE_KIND,
    recover: async (durableIntent) => {
      await recoverSyncMutationBatch({
        policy: VAULT_SHARED_SECRETS_BATCH_CAPTURE_POLICY,
        durableCapture,
        businessApplier:
          vaultSharedSecretBusinessApplier,
        durableIntent,
      });
    },
  },
  {
    adapterId:
      AI_LOGICAL_CONFIG_BATCH_CAPTURE_POLICY.adapterId,
    kind: SYNC_MUTATION_BATCH_CAPTURE_KIND,
    recover: async (durableIntent) => {
      await recoverSyncMutationBatch({
        policy: AI_LOGICAL_CONFIG_BATCH_CAPTURE_POLICY,
        durableCapture,
        businessApplier: aiLogicalConfigBusinessApplier,
        durableIntent,
      });
    },
  },
  {
    adapterId:
      APPEARANCE_FONTS_BATCH_CAPTURE_POLICY.adapterId,
    kind: SYNC_MUTATION_BATCH_CAPTURE_KIND,
    recover: async (durableIntent) => {
      await recoverSyncMutationBatch({
        policy: APPEARANCE_FONTS_BATCH_CAPTURE_POLICY,
        durableCapture,
        businessApplier: appearanceFontBusinessApplier,
        durableIntent,
      });
    },
  },
  {
    adapterId:
      APPEARANCE_BACKGROUND_BATCH_CAPTURE_POLICY.adapterId,
    kind: SYNC_MUTATION_BATCH_CAPTURE_KIND,
    recover: async (durableIntent) => {
      await recoverSyncMutationBatch({
        policy: APPEARANCE_BACKGROUND_BATCH_CAPTURE_POLICY,
        durableCapture,
        businessApplier: appearanceBackgroundBusinessApplier,
        durableIntent,
      });
    },
  },
  {
    adapterId:
      APPEARANCE_WEATHER_BATCH_CAPTURE_POLICY.adapterId,
    kind: SYNC_MUTATION_BATCH_CAPTURE_KIND,
    recover: async (durableIntent) => {
      await recoverSyncMutationBatch({
        policy: APPEARANCE_WEATHER_BATCH_CAPTURE_POLICY,
        durableCapture,
        businessApplier: appearanceWeatherBusinessApplier,
        durableIntent,
      });
    },
  },
  {
    adapterId:
      RESEARCH_MATERIALS_BATCH_CAPTURE_POLICY.adapterId,
    kind: SYNC_MUTATION_BATCH_CAPTURE_KIND,
    recover: async (durableIntent) => {
      await recoverSyncMutationBatch({
        policy: RESEARCH_MATERIALS_BATCH_CAPTURE_POLICY,
        durableCapture,
        businessApplier: researchMaterialsBusinessApplier,
        durableIntent,
      });
    },
  },
]);
