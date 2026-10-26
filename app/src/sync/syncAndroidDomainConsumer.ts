import {
  resolveAndroidSyncDomain,
} from './syncAndroidDomainCatalog';
import type {
  PlainMutationV1,
} from './syncProtocol';

export interface AndroidSyncDomainConsumer {
  validateIncomingMutation(
    mutation: PlainMutationV1,
  ): Promise<void>;
  materializeCurrentMutation(
    mutation: PlainMutationV1,
  ): Promise<unknown>;
}

async function validateForAdapter(
  adapterId: string,
  mutation: PlainMutationV1,
) {
  switch (adapterId) {
    case 'chat.core':
      return import('./syncChatCore').then(
        ({ assertChatCoreMutationV1 }) =>
          assertChatCoreMutationV1(mutation),
      );
    case 'chat.relationship-state':
      return import('./syncChatRelationship').then(
        ({ assertChatRelationshipMutationV1 }) =>
          assertChatRelationshipMutationV1(mutation),
      );
    case 'chat.objects':
      throw new Error(
        'chat.objects 只经 content-addressed 对象通道搬运，不能接收普通 mutation。',
      );
    case 'memory.records':
    case 'continuity.ledger':
      return import('./syncMemoryRecords').then(
        ({ assertMemoryRecordsMutationV1 }) =>
          assertMemoryRecordsMutationV1(mutation),
      );
    case 'memory.experience':
      if (mutation.entity.type === 'style-memory') {
        return import('./syncMemoryRecords').then(
          ({ assertMemoryRecordsMutationV1 }) =>
            assertMemoryRecordsMutationV1(mutation),
        );
      }
      return import('./syncMemoryExperience').then(
        ({ assertMemoryExperienceMutationV1 }) =>
          assertMemoryExperienceMutationV1(mutation),
      );
    case 'assistant.life-state':
      return import('./syncAssistantLifeState').then(
        ({ assertAssistantLifeStateMutationV1 }) =>
          assertAssistantLifeStateMutationV1(mutation),
      );
    case 'persona.expression-objects':
      return import('./syncPersonaExpressionObjects').then(
        ({ assertPersonaExpressionObjectsMutationV1 }) =>
          assertPersonaExpressionObjectsMutationV1(mutation),
      );
    case 'proactive.ledger':
      return import('./syncProactiveLedger').then(
        ({ assertProactiveLedgerMutationV1 }) =>
          assertProactiveLedgerMutationV1(mutation),
      );
    case 'usage.remote-budget':
      return import('./syncRemoteBudget').then(
        ({ assertRemoteBudgetMutationV1 }) =>
          assertRemoteBudgetMutationV1(mutation),
      );
    case 'behavior.routing':
      return import('./syncBehaviorRouting').then(
        ({ assertBehaviorRoutingMutationV1 }) =>
          assertBehaviorRoutingMutationV1(mutation),
      );
    case 'usage.semantic-review-budget':
      return import('./syncSemanticReviewBudget').then(
        ({ assertSemanticReviewBudgetMutationV1 }) =>
          assertSemanticReviewBudgetMutationV1(mutation),
      );
    case 'relationship.authorization':
      return import('./syncRelationshipAuthorization').then(
        ({ assertRelationshipAuthorizationMutationV1 }) =>
          assertRelationshipAuthorizationMutationV1(mutation),
      );
    case 'schedule.semantic':
      return import('./syncScheduleSemantic').then(
        ({ assertScheduleSemanticMutationV1 }) =>
          assertScheduleSemanticMutationV1(mutation),
      );
    case 'todo.semantic':
      return import('./syncTodoSemantic').then(
        ({ assertTodoSemanticMutationV1 }) =>
          assertTodoSemanticMutationV1(mutation),
      );
    case 'focus.semantic':
      return import('./syncFocusSemantic').then(
        ({ assertFocusSemanticMutationV1 }) =>
          assertFocusSemanticMutationV1(mutation),
      );
    case 'reading.workspace':
      return import('./syncReadingWorkspace').then(
        ({ assertReadingWorkspaceMutationV1 }) =>
          assertReadingWorkspaceMutationV1(mutation),
      );
    case 'reading.objects':
      return import('./syncReadingObjects').then(
        ({ assertReadingObjectsMutationV1 }) =>
          assertReadingObjectsMutationV1(mutation),
      );
    case 'gifts.life':
      return import('./syncGiftsLife').then(({ assertGiftsLifeMutationV1 }) => assertGiftsLifeMutationV1(mutation));
    case 'letters.life':
      return import('./syncLettersLife').then(
        ({ assertLettersLifeMutationV1 }) =>
          assertLettersLifeMutationV1(mutation),
      );
    case 'wish-pool.life':
      return import('./syncWishPoolLife').then(
        ({ assertWishPoolLifeMutationV1 }) =>
          assertWishPoolLifeMutationV1(mutation),
      );
    case 'together-walked.life':
      return import('./syncTogetherWalkedLife').then(
        ({ assertTogetherWalkedLifeMutationV1 }) =>
          assertTogetherWalkedLifeMutationV1(mutation),
      );
    case 'theater.isolated':
      return import('./syncTheaterIsolated').then(
        ({ assertTheaterIsolatedMutationV1 }) =>
          assertTheaterIsolatedMutationV1(mutation),
      );
    case 'expense.ledger':
      return import('./syncExpenseLedger').then(
        ({ assertExpenseLedgerMutationV1 }) =>
          assertExpenseLedgerMutationV1(mutation),
      );
    case 'wallet.ledger':
      return import('./syncWalletLedger').then(
        ({ assertWalletLedgerMutationV1 }) =>
          assertWalletLedgerMutationV1(mutation),
      );
    case 'period.health':
      return import('./syncPeriodHealth').then(
        ({ assertPeriodHealthMutationV1 }) =>
          assertPeriodHealthMutationV1(mutation),
      );
    case 'body-signal.health':
      return import('./syncBodySignalHealth').then(
        ({ assertBodySignalHealthMutationV1 }) =>
          assertBodySignalHealthMutationV1(mutation),
      );
    case 'activity.observations':
      return import('./syncActivityObservations').then(
        ({ assertActivityObservationsMutationV1 }) =>
          assertActivityObservationsMutationV1(mutation),
      );
    case 'nearby-world.health':
      return import('./syncNearbyWorldHealth').then(
        ({ assertNearbyWorldHealthMutationV1 }) =>
          assertNearbyWorldHealthMutationV1(mutation),
      );
    case 'camera.preferences':
      return import('./syncCameraPreferences').then(
        ({ assertCameraPreferencesMutationV1 }) =>
          assertCameraPreferencesMutationV1(mutation),
      );
    case 'tools.audit':
      return import('./syncToolsAudit').then(
        ({ assertToolsAuditMutationV1 }) =>
          assertToolsAuditMutationV1(mutation),
      );
    case 'tools.workspace':
      return import('./syncToolsWorkspace').then(
        ({ assertToolsWorkspaceMutationV1 }) =>
          assertToolsWorkspaceMutationV1(mutation),
      );
    case 'vault.exportable-sessions':
      return import('./syncVaultExportableSessions').then(
        ({ assertVaultExportableSessionMutationV1 }) =>
          assertVaultExportableSessionMutationV1(mutation),
      );
    case 'vault.shared-secrets':
      return import('./syncVaultSharedSecrets').then(
        ({ assertVaultSharedSecretMutationV1 }) =>
          assertVaultSharedSecretMutationV1(mutation),
      );
    case 'ai.logical-config':
      return import('./syncAiLogicalConfig').then(
        ({ assertAiLogicalConfigMutationV1 }) =>
          assertAiLogicalConfigMutationV1(mutation),
      );
    case 'appearance.fonts':
      return import('./syncAppearanceFonts').then(
        ({ assertAppearanceFontMutationV1 }) =>
          assertAppearanceFontMutationV1(mutation),
      );
    case 'appearance.background':
      return import('./syncAppearanceBackground').then(
        ({ assertAppearanceBackgroundMutationV1 }) =>
          assertAppearanceBackgroundMutationV1(mutation),
      );
    case 'appearance.weather':
      return import('./syncAppearanceWeather').then(
        ({ assertAppearanceWeatherMutationV1 }) =>
          assertAppearanceWeatherMutationV1(mutation),
      );
    case 'desktop.preferences':
      return import('./syncDesktopPreferences').then(
        ({ assertDesktopPreferencesMutationV1 }) =>
          assertDesktopPreferencesMutationV1(mutation),
      );
    case 'research.materials':
      return import('./syncResearchMaterials').then(
        ({ assertResearchMaterialsMutationV1 }) =>
          assertResearchMaterialsMutationV1(mutation),
      );
    default:
      throw new Error(`Android 没有 ${adapterId} 的业务校验器。`);
  }
}

async function materializeForAdapter(
  adapterId: string,
  mutation: PlainMutationV1,
) {
  switch (adapterId) {
    case 'chat.core': {
      const [{ ChatCoreBusinessApplier }, { chatCoreNonRecursingBusinessPort }] =
        await Promise.all([
          import('./syncChatCoreApply'),
          import('./syncChatCoreNonRecursingPort'),
        ]);
      return new ChatCoreBusinessApplier(
        chatCoreNonRecursingBusinessPort,
      ).applySyncMutation(mutation);
    }
    case 'chat.relationship-state': {
      const [
        { ChatRelationshipBusinessApplier },
        { chatRelationshipAsyncStorageBusinessPort },
      ] = await Promise.all([
        import('./syncChatRelationshipApply'),
        import('./syncChatRelationshipAsyncStoragePort'),
      ]);
      return new ChatRelationshipBusinessApplier(
        chatRelationshipAsyncStorageBusinessPort,
      ).applySyncMutation(mutation);
    }
    case 'chat.objects':
      return { handled: false, reason: 'content-object-only' } as const;
    case 'memory.records':
    case 'continuity.ledger': {
      const [
        { MemoryRecordsBusinessApplier },
        { memoryRecordsSqliteApplyPort },
      ] = await Promise.all([
        import('./syncMemoryRecordsApply'),
        import('./syncMemoryRecordsSqliteApply'),
      ]);
      const applier = new MemoryRecordsBusinessApplier(memoryRecordsSqliteApplyPort);
      const projection = mutation.entity.type === 'memory'
        ? await applier.reconcileCurrentMemory(mutation) : null;
      const result = projection ?? await applier.applySyncMutation(mutation, ['post', 'post-comment', 'post-tag'].includes(mutation.entity.type)
        || mutation.entity.type === 'memory' && (await (await import('./syncMutationStateStore')).loadSyncEntityHeadMutations(
          { domain: 'memory', type: 'post', id: mutation.entity.id })).length > 0);
      if (mutation.entity.type === 'post-review-action') {
        await (await import('../posts/baiyunPostSharedReviewActions')).processPhonePostReviewAction(mutation.entity.id);
      }
      return result;
    }
    case 'memory.experience': {
      if (mutation.entity.type === 'style-memory') {
        const [
          { MemoryRecordsBusinessApplier },
          { memoryRecordsSqliteApplyPort },
        ] = await Promise.all([
          import('./syncMemoryRecordsApply'),
          import('./syncMemoryRecordsSqliteApply'),
        ]);
        return new MemoryRecordsBusinessApplier(
          memoryRecordsSqliteApplyPort,
        ).applySyncMutation(mutation);
      }
      const [
        { MemoryExperienceBusinessApplier },
        { memoryExperienceAsyncStorageBusinessPort },
      ] = await Promise.all([
        import('./syncMemoryExperienceApply'),
        import('./syncMemoryExperienceAsyncStoragePort'),
      ]);
      return new MemoryExperienceBusinessApplier(
        memoryExperienceAsyncStorageBusinessPort,
      ).applySyncMutation(mutation);
    }
    case 'assistant.life-state': {
      const [
        { AssistantLifeStateBusinessApplier },
        { assistantLifeStateAsyncStorageBusinessPort },
      ] = await Promise.all([
        import('./syncAssistantLifeStateApply'),
        import('./syncAssistantLifeStateAsyncStoragePort'),
      ]);
      return new AssistantLifeStateBusinessApplier(
        assistantLifeStateAsyncStorageBusinessPort,
      ).applySyncMutation(mutation);
    }
    case 'persona.expression-objects': {
      const [
        { PersonaExpressionObjectsBusinessApplier },
        { personaExpressionObjectsAsyncStorageBusinessPort },
      ] = await Promise.all([
        import('./syncPersonaExpressionObjectsApply'),
        import('./syncPersonaExpressionObjectsAsyncStoragePort'),
      ]);
      return new PersonaExpressionObjectsBusinessApplier(
        personaExpressionObjectsAsyncStorageBusinessPort,
      ).applySyncMutation(mutation);
    }
    case 'proactive.ledger': {
      const [
        { ProactiveLedgerBusinessApplier },
        { proactiveLedgerAsyncStorageBusinessPort },
      ] = await Promise.all([
        import('./syncProactiveLedgerApply'),
        import('./syncProactiveLedgerAsyncStoragePort'),
      ]);
      return new ProactiveLedgerBusinessApplier(
        proactiveLedgerAsyncStorageBusinessPort,
      ).applySyncMutation(mutation);
    }
    case 'usage.remote-budget': {
      const [
        { RemoteBudgetBusinessApplier },
        { remoteBudgetAsyncStorageBusinessPort },
      ] = await Promise.all([
        import('./syncRemoteBudgetApply'),
        import('./syncRemoteBudgetAsyncStoragePort'),
      ]);
      return new RemoteBudgetBusinessApplier(
        remoteBudgetAsyncStorageBusinessPort,
      ).applySyncMutation(mutation);
    }
    case 'behavior.routing': {
      const [
        { BehaviorRoutingBusinessApplier },
        { behaviorRoutingAsyncStorageBusinessPort },
      ] = await Promise.all([
        import('./syncBehaviorRoutingApply'),
        import('./syncBehaviorRoutingAsyncStoragePort'),
      ]);
      return new BehaviorRoutingBusinessApplier(
        behaviorRoutingAsyncStorageBusinessPort,
      ).applySyncMutation(mutation);
    }
    case 'usage.semantic-review-budget': {
      const [
        { SemanticReviewBudgetBusinessApplier },
        { semanticReviewBudgetAsyncStorageBusinessPort },
      ] = await Promise.all([
        import('./syncSemanticReviewBudgetApply'),
        import('./syncSemanticReviewBudgetAsyncStoragePort'),
      ]);
      return new SemanticReviewBudgetBusinessApplier(
        semanticReviewBudgetAsyncStorageBusinessPort,
      ).applySyncMutation(mutation);
    }
    case 'relationship.authorization': {
      const [
        { RelationshipAuthorizationBusinessApplier },
        { relationshipAuthorizationAsyncStorageBusinessPort },
      ] = await Promise.all([
        import('./syncRelationshipAuthorizationApply'),
        import('./syncRelationshipAuthorizationAsyncStoragePort'),
      ]);
      return new RelationshipAuthorizationBusinessApplier(
        relationshipAuthorizationAsyncStorageBusinessPort,
      ).applySyncMutation(mutation);
    }
    case 'schedule.semantic': {
      const [
        { ScheduleSemanticBusinessApplier },
        { scheduleSemanticBusinessPort },
      ] = await Promise.all([
        import('./syncScheduleSemanticApply'),
        import('./syncScheduleSemanticBusinessPort'),
      ]);
      return new ScheduleSemanticBusinessApplier(
        scheduleSemanticBusinessPort,
      ).applySyncMutation(mutation);
    }
    case 'todo.semantic': {
      const [
        { TodoSemanticBusinessApplier },
        { todoSemanticSqliteBusinessPort },
      ] = await Promise.all([
        import('./syncTodoSemanticApply'),
        import('./syncTodoSemanticSqliteApply'),
      ]);
      return new TodoSemanticBusinessApplier(
        todoSemanticSqliteBusinessPort,
      ).applySyncMutation(mutation);
    }
    case 'focus.semantic': {
      const [
        { FocusSemanticBusinessApplier },
        { focusSemanticBusinessPort },
      ] = await Promise.all([
        import('./syncFocusSemanticApply'),
        import('./syncFocusSemanticBusinessPort'),
      ]);
      return new FocusSemanticBusinessApplier(
        focusSemanticBusinessPort,
      ).applySyncMutation(mutation);
    }
    case 'reading.workspace': {
      const [
        { ReadingWorkspaceBusinessApplier },
        { readingWorkspaceAsyncStorageBusinessPort },
      ] = await Promise.all([
        import('./syncReadingWorkspaceApply'),
        import('./syncReadingWorkspaceAsyncStoragePort'),
      ]);
      return new ReadingWorkspaceBusinessApplier(
        readingWorkspaceAsyncStorageBusinessPort,
      ).applySyncMutation(mutation);
    }
    case 'reading.objects': {
      const [
        { ReadingObjectsBusinessApplier },
        { readingObjectsAsyncStorageBusinessPort },
      ] = await Promise.all([
        import('./syncReadingObjectsApply'),
        import('./syncReadingObjectsAsyncStoragePort'),
      ]);
      return new ReadingObjectsBusinessApplier(
        readingObjectsAsyncStorageBusinessPort,
      ).applySyncMutation(mutation);
    }
    case 'gifts.life': {
      const { materializeAndroidGiftMutation } = await import('./syncGiftsRuntime');
      return materializeAndroidGiftMutation(mutation);
    }
    case 'letters.life': {
      const [
        { LettersLifeBusinessApplier },
        { lettersLifeAsyncStorageBusinessPort },
      ] = await Promise.all([
        import('./syncLettersLifeApply'),
        import('./syncLettersLifeAsyncStoragePort'),
      ]);
      return new LettersLifeBusinessApplier(
        lettersLifeAsyncStorageBusinessPort,
      ).applySyncMutation(mutation);
    }
    case 'wish-pool.life': {
      const [
        { WishPoolLifeBusinessApplier },
        { wishPoolLifeAsyncStorageBusinessPort },
      ] = await Promise.all([
        import('./syncWishPoolLifeApply'),
        import('./syncWishPoolLifeAsyncStoragePort'),
      ]);
      return new WishPoolLifeBusinessApplier(
        wishPoolLifeAsyncStorageBusinessPort,
      ).applySyncMutation(mutation);
    }
    case 'together-walked.life': {
      const [
        { TogetherWalkedLifeBusinessApplier },
        { togetherWalkedLifeAsyncStorageBusinessPort },
      ] = await Promise.all([
        import('./syncTogetherWalkedLifeApply'),
        import('./syncTogetherWalkedLifeAsyncStoragePort'),
      ]);
      return new TogetherWalkedLifeBusinessApplier(
        togetherWalkedLifeAsyncStorageBusinessPort,
      ).applySyncMutation(mutation);
    }
    case 'theater.isolated': {
      const [
        { TheaterIsolatedBusinessApplier },
        { theaterIsolatedSqliteBusinessPort },
      ] = await Promise.all([
        import('./syncTheaterIsolatedApply'),
        import('./syncTheaterIsolatedSqliteApply'),
      ]);
      return new TheaterIsolatedBusinessApplier(
        theaterIsolatedSqliteBusinessPort,
      ).applySyncMutation(mutation);
    }
    case 'expense.ledger': {
      const [
        { ExpenseLedgerBusinessApplier },
        { expenseLedgerSqliteBusinessPort },
      ] = await Promise.all([
        import('./syncExpenseLedgerApply'),
        import('./syncExpenseLedgerSqliteApply'),
      ]);
      return new ExpenseLedgerBusinessApplier(
        expenseLedgerSqliteBusinessPort,
      ).applySyncMutation(mutation);
    }
    case 'wallet.ledger': {
      const [
        { WalletLedgerBusinessApplier },
        { walletLedgerSqliteBusinessPort },
      ] = await Promise.all([
        import('./syncWalletLedgerApply'),
        import('./syncWalletLedgerSqliteApply'),
      ]);
      return new WalletLedgerBusinessApplier(
        walletLedgerSqliteBusinessPort,
      ).applySyncMutation(mutation);
    }
    case 'period.health': {
      const [
        { PeriodHealthBusinessApplier },
        { periodHealthSqliteBusinessPort },
      ] = await Promise.all([
        import('./syncPeriodHealthApply'),
        import('./syncPeriodHealthSqliteApply'),
      ]);
      return new PeriodHealthBusinessApplier(
        periodHealthSqliteBusinessPort,
      ).applySyncMutation(mutation);
    }
    case 'body-signal.health': {
      const [
        { BodySignalHealthBusinessApplier },
        { bodySignalHealthSqliteBusinessPort },
      ] = await Promise.all([
        import('./syncBodySignalHealthApply'),
        import('./syncBodySignalHealthSqliteApply'),
      ]);
      return new BodySignalHealthBusinessApplier(
        bodySignalHealthSqliteBusinessPort,
      ).applySyncMutation(mutation);
    }
    case 'activity.observations': {
      const [
        { ActivityObservationsBusinessApplier },
        { activityObservationsSqliteBusinessPort },
      ] = await Promise.all([
        import('./syncActivityObservationsApply'),
        import('./syncActivityObservationsSqliteApply'),
      ]);
      return new ActivityObservationsBusinessApplier(
        activityObservationsSqliteBusinessPort,
      ).applySyncMutation(mutation);
    }
    case 'nearby-world.health': {
      const [
        { NearbyWorldHealthBusinessApplier },
        { nearbyWorldHealthAsyncStorageBusinessPort },
      ] = await Promise.all([
        import('./syncNearbyWorldHealthApply'),
        import('./syncNearbyWorldHealthAsyncStoragePort'),
      ]);
      return new NearbyWorldHealthBusinessApplier(
        nearbyWorldHealthAsyncStorageBusinessPort,
      ).applySyncMutation(mutation);
    }
    case 'camera.preferences': {
      const [
        { CameraPreferencesBusinessApplier },
        { cameraPreferencesAsyncStorageBusinessPort },
      ] = await Promise.all([
        import('./syncCameraPreferencesApply'),
        import('./syncCameraPreferencesAsyncStoragePort'),
      ]);
      return new CameraPreferencesBusinessApplier(
        cameraPreferencesAsyncStorageBusinessPort,
      ).applySyncMutation(mutation);
    }
    case 'tools.audit': {
      const [
        { ToolsAuditBusinessApplier },
        { toolsAuditAsyncStorageBusinessPort },
      ] = await Promise.all([
        import('./syncToolsAuditApply'),
        import('./syncToolsAuditAsyncStoragePort'),
      ]);
      return new ToolsAuditBusinessApplier(
        toolsAuditAsyncStorageBusinessPort,
      ).applySyncMutation(mutation);
    }
    case 'tools.workspace': {
      const [
        { ToolsWorkspaceBusinessApplier },
        { toolsWorkspaceAsyncStorageBusinessPort },
      ] = await Promise.all([
        import('./syncToolsWorkspaceApply'),
        import('./syncToolsWorkspaceAsyncStoragePort'),
      ]);
      return new ToolsWorkspaceBusinessApplier(
        toolsWorkspaceAsyncStorageBusinessPort,
      ).applySyncMutation(mutation);
    }
    case 'vault.exportable-sessions': {
      const [
        { VaultExportableSessionBusinessApplier },
        { vaultExportableSessionSecretStoreBusinessPort },
      ] = await Promise.all([
        import('./syncVaultExportableSessionsApply'),
        import('./syncVaultExportableSessionsSecretStorePort'),
      ]);
      return new VaultExportableSessionBusinessApplier(
        vaultExportableSessionSecretStoreBusinessPort,
      ).applySyncMutation(mutation);
    }
    case 'vault.shared-secrets': {
      const [
        { VaultSharedSecretBusinessApplier },
        { vaultSharedSecretStoreBusinessPort },
      ] = await Promise.all([
        import('./syncVaultSharedSecretsApply'),
        import('./syncVaultSharedSecretsSecretStorePort'),
      ]);
      return new VaultSharedSecretBusinessApplier(
        vaultSharedSecretStoreBusinessPort,
      ).applySyncMutation(mutation);
    }
    case 'ai.logical-config': {
      const {
        AiLogicalConfigBusinessApplier,
        aiLogicalConfigAsyncStorageBusinessPort,
      } = await import('./syncAiLogicalConfigApply');
      return new AiLogicalConfigBusinessApplier(
        aiLogicalConfigAsyncStorageBusinessPort,
      ).applySyncMutation(mutation);
    }
    case 'appearance.fonts': {
      const {
        AppearanceFontBusinessApplier,
        appearanceFontAsyncStorageBusinessPort,
      } = await import('./syncAppearanceFontsApply');
      return new AppearanceFontBusinessApplier(
        appearanceFontAsyncStorageBusinessPort,
      ).applySyncMutation(mutation);
    }
    case 'appearance.background': {
      const [
        { AppearanceBackgroundBusinessApplier },
        { appearanceBackgroundAsyncStorageBusinessPort },
      ] = await Promise.all([
        import('./syncAppearanceBackgroundApply'),
        import('./syncAppearanceBackgroundAsyncStoragePort'),
      ]);
      return new AppearanceBackgroundBusinessApplier(
        appearanceBackgroundAsyncStorageBusinessPort,
      ).applySyncMutation(mutation);
    }
    case 'appearance.weather': {
      const [
        { AppearanceWeatherBusinessApplier },
        { appearanceWeatherAsyncStorageBusinessPort },
      ] = await Promise.all([
        import('./syncAppearanceWeatherApply'),
        import('./syncAppearanceWeatherAsyncStoragePort'),
      ]);
      return new AppearanceWeatherBusinessApplier(
        appearanceWeatherAsyncStorageBusinessPort,
      ).applySyncMutation(mutation);
    }
    case 'desktop.preferences':
      return {
        handled: false,
        reason: 'windows-execution-only',
      } as const;
    case 'research.materials': {
      const [
        { ResearchMaterialsBusinessApplier },
        { researchMaterialsAsyncStorageBusinessPort },
      ] = await Promise.all([
        import('./syncResearchMaterialsApply'),
        import('./syncResearchMaterialsAsyncStoragePort'),
      ]);
      return new ResearchMaterialsBusinessApplier(
        researchMaterialsAsyncStorageBusinessPort,
      ).applySyncMutation(mutation);
    }
    default:
      throw new Error(`Android 没有 ${adapterId} 的业务物化器。`);
  }
}

export class AndroidProductionSyncDomainConsumer
implements AndroidSyncDomainConsumer {
  async validateIncomingMutation(
    mutation: PlainMutationV1,
  ) {
    const entry = resolveAndroidSyncDomain(mutation);
    await validateForAdapter(entry.adapterId, mutation);
  }

  materializeCurrentMutation(
    mutation: PlainMutationV1,
  ) {
    const entry = resolveAndroidSyncDomain(mutation);
    return materializeForAdapter(entry.adapterId, mutation);
  }
}
