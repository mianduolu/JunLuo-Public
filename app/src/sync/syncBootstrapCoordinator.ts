import {
  runWithPatientTransientSqliteLockRetry,
} from './syncSqliteLockRetry';

import {
  runRelationshipAuthorizationBootstrapRuntime,
  type RelationshipAuthorizationBootstrapRuntimeResult,
} from './syncRelationshipAuthorizationBootstrapRuntime';
import {
  runScheduleSemanticBootstrapRuntime,
  runScheduleSemanticOutboxPromotionRuntime,
  type ScheduleSemanticBootstrapRuntimeResult,
  type ScheduleSemanticPromotionRuntimeResult,
} from './syncScheduleSemanticRuntime';
import {
  runTodoSemanticBootstrapRuntime,
  runTodoSemanticOutboxPromotionRuntime,
  type TodoSemanticBootstrapRuntimeResult,
  type TodoSemanticPromotionRuntimeResult,
} from './syncTodoSemanticRuntime';
import {
  runFocusSemanticBootstrapRuntime,
  runFocusSemanticOutboxPromotionRuntime,
  type FocusSemanticBootstrapRuntimeResult,
  type FocusSemanticPromotionRuntimeResult,
} from './syncFocusSemanticRuntime';
import {
  runReadingWorkspaceBootstrapRuntime,
  type ReadingWorkspaceBootstrapRuntimeResult,
} from './syncReadingWorkspaceBootstrapRuntime';
import {
  runReadingObjectsBootstrapRuntime,
  type ReadingObjectsBootstrapRuntimeResult,
} from './syncReadingObjectsBootstrapRuntime';
import {
  runLettersLifeBootstrapRuntime,
  type LettersLifeBootstrapRuntimeResult,
} from './syncLettersLifeBootstrapRuntime';
import {
  runWishPoolLifeBootstrapRuntime,
  type WishPoolLifeBootstrapRuntimeResult,
} from './syncWishPoolLifeBootstrapRuntime';
import {
  runTogetherWalkedLifeBootstrapRuntime,
  type TogetherWalkedLifeBootstrapRuntimeResult,
} from './syncTogetherWalkedLifeBootstrapRuntime';
import {
  runTheaterIsolatedBootstrapRuntime,
  runTheaterIsolatedOutboxPromotionRuntime,
  type TheaterIsolatedBootstrapRuntimeResult,
  type TheaterIsolatedPromotionRuntimeResult,
} from './syncTheaterIsolatedRuntime';
import {
  runExpenseLedgerBootstrapRuntime,
  runExpenseLedgerOutboxPromotionRuntime,
  type ExpenseLedgerBootstrapRuntimeResult,
  type ExpenseLedgerPromotionRuntimeResult,
} from './syncExpenseLedgerRuntime';
import {
  runWalletLedgerBootstrapRuntime,
  runWalletLedgerOutboxPromotionRuntime,
  type WalletLedgerBootstrapRuntimeResult,
  type WalletLedgerPromotionRuntimeResult,
} from './syncWalletLedgerRuntime';
import {
  runPeriodHealthBootstrapRuntime,
  runPeriodHealthOutboxPromotionRuntime,
  type PeriodHealthBootstrapRuntimeResult,
  type PeriodHealthPromotionRuntimeResult,
} from './syncPeriodHealthRuntime';
import {
  runBodySignalHealthBootstrapRuntime,
  runBodySignalHealthOutboxPromotionRuntime,
  type BodySignalHealthBootstrapRuntimeResult,
  type BodySignalHealthPromotionRuntimeResult,
} from './syncBodySignalHealthRuntime';
import {
  runActivityObservationsBootstrapRuntime,
  runActivityObservationsOutboxPromotionRuntime,
  type ActivityObservationsBootstrapRuntimeResult,
  type ActivityObservationsPromotionRuntimeResult,
} from './syncActivityObservationsRuntime';
import {
  runNearbyWorldHealthBootstrapRuntime,
  type NearbyWorldHealthBootstrapRuntimeResult,
} from './syncNearbyWorldHealthBootstrapRuntime';
import {
  runCameraPreferencesBootstrapRuntime,
  type CameraPreferencesBootstrapRuntimeResult,
} from './syncCameraPreferencesBootstrapRuntime';
import {
  runToolsAuditBootstrapRuntime,
  type ToolsAuditBootstrapRuntimeResult,
} from './syncToolsAuditBootstrapRuntime';
import {
  runToolsWorkspaceBootstrapRuntime,
  type ToolsWorkspaceBootstrapRuntimeResult,
} from './syncToolsWorkspaceBootstrapRuntime';
import {
  runVaultExportableSessionsBootstrapRuntime,
  type VaultExportableSessionsBootstrapRuntimeResult,
} from './syncVaultExportableSessionsBootstrapRuntime';
import {
  runVaultSharedSecretsBootstrapRuntime,
  type VaultSharedSecretsBootstrapRuntimeResult,
} from './syncVaultSharedSecretsBootstrapRuntime';
import {
  runAiLogicalConfigBootstrapRuntime,
  type AiLogicalConfigBootstrapRuntimeResult,
} from './syncAiLogicalConfigBootstrap';
import {
  runAppearanceFontsBootstrapRuntime,
  type AppearanceFontsBootstrapRuntimeResult,
} from './syncAppearanceFontsBootstrap';
import {
  runAppearanceBackgroundBootstrapRuntime,
  type AppearanceBackgroundBootstrapRuntimeResult,
} from './syncAppearanceBackgroundBootstrap';
import {
  runAppearanceWeatherBootstrapRuntime,
  type AppearanceWeatherBootstrapRuntimeResult,
} from './syncAppearanceWeatherBootstrap';
import {
  runResearchMaterialsBootstrapRuntime,
  type ResearchMaterialsBootstrapRuntimeResult,
} from './syncResearchMaterialsBootstrap';
import {
  runSemanticReviewBudgetBootstrapRuntime,
  type SemanticReviewBudgetBootstrapRuntimeResult,
} from './syncSemanticReviewBudgetBootstrapRuntime';
import {
  runBehaviorRoutingBootstrapRuntime,
  type BehaviorRoutingBootstrapRuntimeResult,
} from './syncBehaviorRoutingBootstrapRuntime';
import {
  runAssistantLifeStateBootstrapRuntime,
  type AssistantLifeStateBootstrapRuntimeResult,
} from './syncAssistantLifeStateBootstrapRuntime';
import {
  runChatCoreBootstrapRuntime,
  type ChatCoreBootstrapRuntimeResult,
} from './syncChatCoreBootstrapRuntime';
import {
  runChatRelationshipBootstrapRuntime,
  type ChatRelationshipBootstrapRuntimeResult,
} from './syncChatRelationshipBootstrapRuntime';
import {
  runContinuityLedgerBootstrapRuntime,
  type ContinuityLedgerBootstrapRuntimeResult,
} from './syncContinuityLedgerRuntime';
import {
  runMemoryExperienceBootstrapRuntime,
  type MemoryExperienceBootstrapRuntimeResult,
} from './syncMemoryExperienceBootstrapRuntime';
import {
  runMemoryRecordsBootstrapRuntime,
  runMemoryRecordsOutboxPromotionRuntime,
  type MemoryRecordsBootstrapRuntimeResult,
  type MemoryRecordsPromotionRuntimeResult,
} from './syncMemoryRecordsRuntime';
import {
  runPersonaExpressionObjectsBootstrapRuntime,
  type PersonaExpressionObjectsBootstrapRuntimeResult,
} from './syncPersonaExpressionObjectsBootstrapRuntime';
import {
  runProactiveLedgerBootstrapRuntime,
  type ProactiveLedgerBootstrapRuntimeResult,
} from './syncProactiveLedgerBootstrapRuntime';
import {
  runRemoteBudgetBootstrapRuntime,
  type RemoteBudgetBootstrapRuntimeResult,
} from './syncRemoteBudgetBootstrapRuntime';

export type SyncBootstrapCoordinatorReport = {
  assistantLifeState: AssistantLifeStateBootstrapRuntimeResult;
  chatCore: ChatCoreBootstrapRuntimeResult;
  chatRelationshipState: ChatRelationshipBootstrapRuntimeResult;
  memoryRecords: MemoryRecordsBootstrapRuntimeResult;
  continuityLedger: ContinuityLedgerBootstrapRuntimeResult;
  memoryRecordsPromotion: MemoryRecordsPromotionRuntimeResult;
  memoryExperience: MemoryExperienceBootstrapRuntimeResult;
  personaExpressionObjects: PersonaExpressionObjectsBootstrapRuntimeResult;
  proactiveLedger: ProactiveLedgerBootstrapRuntimeResult;
  remoteBudget: RemoteBudgetBootstrapRuntimeResult;
  behaviorRouting: BehaviorRoutingBootstrapRuntimeResult;
  semanticReviewBudget: SemanticReviewBudgetBootstrapRuntimeResult;
  relationshipAuthorization: RelationshipAuthorizationBootstrapRuntimeResult;
  scheduleSemantic: ScheduleSemanticBootstrapRuntimeResult;
  scheduleSemanticPromotion: ScheduleSemanticPromotionRuntimeResult;
  todoSemantic: TodoSemanticBootstrapRuntimeResult;
  todoSemanticPromotion: TodoSemanticPromotionRuntimeResult;
  focusSemantic: FocusSemanticBootstrapRuntimeResult;
  focusSemanticPromotion: FocusSemanticPromotionRuntimeResult;
  readingWorkspace: ReadingWorkspaceBootstrapRuntimeResult;
  readingObjects: ReadingObjectsBootstrapRuntimeResult;
  lettersLife: LettersLifeBootstrapRuntimeResult;
  wishPoolLife: WishPoolLifeBootstrapRuntimeResult;
  togetherWalkedLife: TogetherWalkedLifeBootstrapRuntimeResult;
  theaterIsolated: TheaterIsolatedBootstrapRuntimeResult;
  theaterIsolatedPromotion: TheaterIsolatedPromotionRuntimeResult;
  expenseLedger: ExpenseLedgerBootstrapRuntimeResult;
  expenseLedgerPromotion: ExpenseLedgerPromotionRuntimeResult;
  walletLedger: WalletLedgerBootstrapRuntimeResult;
  walletLedgerPromotion: WalletLedgerPromotionRuntimeResult;
  periodHealth: PeriodHealthBootstrapRuntimeResult;
  periodHealthPromotion: PeriodHealthPromotionRuntimeResult;
  bodySignalHealth: BodySignalHealthBootstrapRuntimeResult;
  bodySignalHealthPromotion: BodySignalHealthPromotionRuntimeResult;
  activityObservations: ActivityObservationsBootstrapRuntimeResult;
  activityObservationsPromotion: ActivityObservationsPromotionRuntimeResult;
  nearbyWorldHealth: NearbyWorldHealthBootstrapRuntimeResult;
  cameraPreferences: CameraPreferencesBootstrapRuntimeResult;
  toolsAudit: ToolsAuditBootstrapRuntimeResult;
  toolsWorkspace: ToolsWorkspaceBootstrapRuntimeResult;
  vaultExportableSessions: VaultExportableSessionsBootstrapRuntimeResult;
  vaultSharedSecrets: VaultSharedSecretsBootstrapRuntimeResult;
  aiLogicalConfig: AiLogicalConfigBootstrapRuntimeResult;
  appearanceFonts: AppearanceFontsBootstrapRuntimeResult;
  appearanceBackground: AppearanceBackgroundBootstrapRuntimeResult;
  appearanceWeather: AppearanceWeatherBootstrapRuntimeResult;
  researchMaterials: ResearchMaterialsBootstrapRuntimeResult;
};

async function runBootstrapStage<T>(
  stage: string,
  operation: () => Promise<T>,
) {
  try {
    return await runWithPatientTransientSqliteLockRetry(operation);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`旧数据整理停在 ${stage}：${detail}`);
  }
}

export async function runAvailableSyncBootstraps():
Promise<SyncBootstrapCoordinatorReport> {
  const chatCore = await runBootstrapStage(
    'chat.core',
    async () => await runChatCoreBootstrapRuntime(),
  );
  const chatRelationshipState = await runBootstrapStage(
    'chat.relationship-state',
    async () => await runChatRelationshipBootstrapRuntime(),
  );
  const memoryRecords = await runBootstrapStage(
    'memory.records',
    async () => await runMemoryRecordsBootstrapRuntime(),
  );
  const continuityLedger = await runBootstrapStage(
    'continuity.ledger',
    async () => await runContinuityLedgerBootstrapRuntime(),
  );
  const memoryRecordsPromotion = await runBootstrapStage(
    'memory.records promotion',
    async () => await runMemoryRecordsOutboxPromotionRuntime(),
  );
  const memoryExperience = await runBootstrapStage(
    'memory.experience',
    async () => {
      return await runMemoryExperienceBootstrapRuntime();
    },
  );
  const assistantLifeState = await runBootstrapStage(
    'assistant.life-state',
    async () => {
      return await runAssistantLifeStateBootstrapRuntime();
    },
  );
  const personaExpressionObjects =
    await runBootstrapStage(
      'persona.expression-objects',
      async () => await runPersonaExpressionObjectsBootstrapRuntime(),
    );
  const proactiveLedger =
    await runBootstrapStage(
      'proactive.ledger',
      async () => await runProactiveLedgerBootstrapRuntime(),
    );
  const remoteBudget =
    await runBootstrapStage(
      'remote.budget',
      async () => await runRemoteBudgetBootstrapRuntime(),
    );
  const behaviorRouting =
    await runBootstrapStage(
      'behavior.routing',
      async () => await runBehaviorRoutingBootstrapRuntime(),
    );
  const semanticReviewBudget =
    await runBootstrapStage(
      'semantic-review.budget',
      async () => await runSemanticReviewBudgetBootstrapRuntime(),
    );
  const relationshipAuthorization =
    await runBootstrapStage(
      'relationship.authorization',
      async () => await runRelationshipAuthorizationBootstrapRuntime(),
    );
  const scheduleSemantic =
    await runBootstrapStage(
      'schedule.semantic',
      async () => await runScheduleSemanticBootstrapRuntime(),
    );
  const scheduleSemanticPromotion =
    await runBootstrapStage(
      'schedule.semantic promotion',
      async () => await runScheduleSemanticOutboxPromotionRuntime(),
    );
  const todoSemantic =
    await runBootstrapStage(
      'todo.semantic',
      async () => await runTodoSemanticBootstrapRuntime(),
    );
  const todoSemanticPromotion =
    await runBootstrapStage(
      'todo.semantic promotion',
      async () => await runTodoSemanticOutboxPromotionRuntime(),
    );
  const focusSemantic =
    await runBootstrapStage(
      'focus.semantic',
      async () => await runFocusSemanticBootstrapRuntime(),
    );
  const focusSemanticPromotion =
    await runBootstrapStage(
      'focus.semantic promotion',
      async () => await runFocusSemanticOutboxPromotionRuntime(),
    );
  const readingWorkspace =
    await runBootstrapStage(
      'reading.workspace',
      async () => await runReadingWorkspaceBootstrapRuntime(),
    );
  const readingObjects =
    await runBootstrapStage(
      'reading.objects',
      async () => await runReadingObjectsBootstrapRuntime(),
    );
  const lettersLife =
    await runBootstrapStage(
      'letters.life',
      async () => await runLettersLifeBootstrapRuntime(),
    );
  const wishPoolLife =
    await runBootstrapStage(
      'wish-pool.life',
      async () => await runWishPoolLifeBootstrapRuntime(),
    );
  const togetherWalkedLife =
    await runBootstrapStage(
      'together-walked.life',
      async () => await runTogetherWalkedLifeBootstrapRuntime(),
    );
  const theaterIsolated =
    await runBootstrapStage(
      'theater.isolated',
      async () => await runTheaterIsolatedBootstrapRuntime(),
    );
  const theaterIsolatedPromotion =
    await runBootstrapStage(
      'theater.isolated promotion',
      async () => await runTheaterIsolatedOutboxPromotionRuntime(),
    );
  const expenseLedger =
    await runBootstrapStage(
      'expense.ledger',
      async () => await runExpenseLedgerBootstrapRuntime(),
    );
  const expenseLedgerPromotion =
    await runBootstrapStage(
      'expense.ledger promotion',
      async () => await runExpenseLedgerOutboxPromotionRuntime(),
    );
  const walletLedger =
    await runBootstrapStage(
      'wallet.ledger',
      async () => await runWalletLedgerBootstrapRuntime(),
    );
  const walletLedgerPromotion =
    await runBootstrapStage(
      'wallet.ledger promotion',
      async () => await runWalletLedgerOutboxPromotionRuntime(),
    );
  const periodHealth =
    await runBootstrapStage(
      'period.health',
      async () => await runPeriodHealthBootstrapRuntime(),
    );
  const periodHealthPromotion =
    await runBootstrapStage(
      'period.health promotion',
      async () => await runPeriodHealthOutboxPromotionRuntime(),
    );
  const bodySignalHealth =
    await runBootstrapStage(
      'body-signal.health',
      async () => await runBodySignalHealthBootstrapRuntime(),
    );
  const bodySignalHealthPromotion =
    await runBootstrapStage(
      'body-signal.health promotion',
      async () => await runBodySignalHealthOutboxPromotionRuntime(),
    );
  const activityObservations =
    await runBootstrapStage(
      'activity.observations',
      async () => await runActivityObservationsBootstrapRuntime(),
    );
  const activityObservationsPromotion =
    await runBootstrapStage(
      'activity.observations promotion',
      async () => await runActivityObservationsOutboxPromotionRuntime({
        refreshCapturedRows: false,
      }),
    );
  const nearbyWorldHealth =
    await runBootstrapStage(
      'nearby-world.health',
      async () => await runNearbyWorldHealthBootstrapRuntime(),
    );
  const cameraPreferences =
    await runBootstrapStage(
      'camera.preferences',
      async () => await runCameraPreferencesBootstrapRuntime(),
    );
  const toolsAudit =
    await runBootstrapStage(
      'tools.audit',
      async () => await runToolsAuditBootstrapRuntime(),
    );
  const toolsWorkspace =
    await runBootstrapStage(
      'tools.workspace',
      async () => await runToolsWorkspaceBootstrapRuntime(),
    );
  const vaultExportableSessions =
    await runBootstrapStage(
      'vault.exportable-sessions',
      async () => await runVaultExportableSessionsBootstrapRuntime(),
    );
  const vaultSharedSecrets =
    await runBootstrapStage(
      'vault.shared-secrets',
      async () => await runVaultSharedSecretsBootstrapRuntime(),
    );
  const aiLogicalConfig =
    await runBootstrapStage(
      'ai.logical-config',
      async () => await runAiLogicalConfigBootstrapRuntime(),
    );
  const appearanceFonts =
    await runBootstrapStage(
      'appearance.fonts',
      async () => await runAppearanceFontsBootstrapRuntime(),
    );
  const appearanceBackground =
    await runBootstrapStage(
      'appearance.background',
      async () => await runAppearanceBackgroundBootstrapRuntime(),
    );
  const appearanceWeather =
    await runBootstrapStage(
      'appearance.weather',
      async () => await runAppearanceWeatherBootstrapRuntime(),
    );
  const researchMaterials =
    await runBootstrapStage(
      'research.materials',
      async () => await runResearchMaterialsBootstrapRuntime(),
    );
  return {
    assistantLifeState,
    chatCore,
    chatRelationshipState,
    personaExpressionObjects,
    memoryRecords,
    continuityLedger,
    memoryRecordsPromotion,
    memoryExperience,
    proactiveLedger,
    remoteBudget,
    behaviorRouting,
    semanticReviewBudget,
    relationshipAuthorization,
    scheduleSemantic,
    scheduleSemanticPromotion,
    todoSemantic,
    todoSemanticPromotion,
    focusSemantic,
    focusSemanticPromotion,
    readingWorkspace,
    readingObjects,
    lettersLife,
    wishPoolLife,
    togetherWalkedLife,
    theaterIsolated,
    theaterIsolatedPromotion,
    expenseLedger,
    expenseLedgerPromotion,
    walletLedger,
    walletLedgerPromotion,
    periodHealth,
    periodHealthPromotion,
    bodySignalHealth,
    bodySignalHealthPromotion,
    activityObservations,
    activityObservationsPromotion,
    nearbyWorldHealth,
    cameraPreferences,
    toolsAudit,
    toolsWorkspace,
    vaultExportableSessions,
    vaultSharedSecrets,
    aiLogicalConfig,
    appearanceFonts,
    appearanceBackground,
    appearanceWeather,
    researchMaterials,
  };
}
