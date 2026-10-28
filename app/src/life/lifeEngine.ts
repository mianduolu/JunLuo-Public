import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { changeUnifiedContactState } from '../proactive/unifiedContactStore';
import { maybePublishBaiyunPost, resumeSleepingBaiyunPostReply } from '../posts/baiyunPostGeneration';

import { loadAiConfigPreferencesSnapshot, resolveLifeCreativeConfig } from '../ai/AiConfigPreferences';
import { runBudgetedAiCall } from '../ai/aiCallBudget';
import { loadAssistantState, type AssistantState } from '../ai/assistantState';
import { refreshAssistantLifeState } from '../ai/assistantLife';
import { defaultAiProfile, type AiConnection, type AiProfile } from '../ai/types';
import { maybeSendProactiveMessage } from '../proactive/proactiveMessages';
import { maybeCreateContextualAiLetter } from '../letters/letterDelivery';
import { defaultAutonomySettings, isAutonomyFeatureEnabled, loadAutonomySettings } from './autonomySettings';
import { JUNLUO_DESIRE_VISIBLE_THRESHOLD } from './junluoDesireMetabolism';
import { loadJunluoDesireSnapshot } from './junluoDesireRuntime';
import { tryGenerateDream } from './dreamEngine';
import { runRhythmTick } from './lifeRhythm';
import { runSleepPlanTick, createNaturalEarlyWakeOwner, completeNaturalEarlyWake } from './sleepPlanRuntime';
import { runSocialDesireAction } from './socialAgent';
import { runWebVoyageTick } from './webVoyage';
import { executeLifeTickOnce } from './lifeTickExecutionOnce';
import {
  beginLifePeriodicSyncCheckpoint,
  completeLifePeriodicSyncComponent,
  loadLifePeriodicSyncCheckpoint,
  saveLifePeriodicSyncCheckpoint,
  shouldSynchronizeLifePeriodicComponent,
  type LifePeriodicSyncComponent,
} from './lifePeriodicSyncCheckpoint';
import {
  isAutomaticRemoteAiAllowed,
  loadAutomaticRemoteAiPolicy,
} from '../runtime/automaticRemoteAiPolicy';
import {
  createLifeTickExecutionIdentity,
  createLifeTickOperationId,
} from './lifeTickExecutionOnceCore';

const LIFE_ENGINE_STATE_KEY = 'junluo.lifeEngine.state';
export const LIFE_ENGINE_FOREGROUND_INTERVAL_MS = 240 * 1000;
export const LIFE_ENGINE_BACKGROUND_INTERVAL_MS = 60 * 60 * 1000;

export type LifeTickSource = 'foreground' | 'background' | 'active' | 'manual';

export type LifeTickOptions = {
  apiKey?: string;
  backupRestoreLeaseHeld?: boolean;
  chatApiKey?: string;
  chatConnection?: AiConnection;
  connection?: AiConnection;
  diagnosticParentToken?: number;
  force?: boolean;
  localOnly?: boolean;
  now?: number;
  profile?: AiProfile;
  source?: LifeTickSource;
};

export type LifeTickResult = {
  afterLifeMode?: AssistantState['lifeMode'];
  beforeLifeMode?: AssistantState['lifeMode'];
  projectAdvanced: boolean;
  proactiveMessageInserted: number;
  skippedReason?:
    | 'throttled'
    | 'in-flight'
    | 'leased-elsewhere'
    | 'reconciliation-required';
  source: LifeTickSource;
  stateUpdated: boolean;
  updatedAt?: number;
};

type LifeEngineState = {
  completedOperationIds?: string[];
  lastBackgroundTickAt?: number;
  lastForegroundTickAt?: number;
  lastTickAt?: number;
};

let pendingTick: Promise<LifeTickResult> | undefined;

function isBackgroundSource(source: LifeTickSource) {
  return source === 'background';
}

function sameAssistantState(before: AssistantState, after: AssistantState) {
  return before.updatedAt === after.updatedAt &&
    before.scheduleSlot === after.scheduleSlot &&
    before.title === after.title &&
    before.activity === after.activity &&
    before.moodId === after.moodId &&
    before.lifeMode === after.lifeMode;
}


async function loadLifeEngineState(): Promise<LifeEngineState> {
  const raw = await AsyncStorage.getItem(LIFE_ENGINE_STATE_KEY);
  if (!raw) return {};
  try {
    const state = JSON.parse(raw) as LifeEngineState;
    return {
      completedOperationIds: Array.isArray(state.completedOperationIds)
        ? state.completedOperationIds.filter(
            (value): value is string => typeof value === 'string',
          ).slice(-16)
        : undefined,
      lastBackgroundTickAt: typeof state.lastBackgroundTickAt === 'number' ? state.lastBackgroundTickAt : undefined,
      lastForegroundTickAt: typeof state.lastForegroundTickAt === 'number' ? state.lastForegroundTickAt : undefined,
      lastTickAt: typeof state.lastTickAt === 'number' ? state.lastTickAt : undefined,
    };
  } catch {
    return {};
  }
}

async function markLifeTickExecutionCompleted(input: {
  operationId: string;
  source: LifeTickSource;
  tickAt: number;
}) {
  const current = await loadLifeEngineState();
  const completedOperationIds = current.completedOperationIds?.includes(
    input.operationId,
  )
    ? current.completedOperationIds
    : [...(current.completedOperationIds ?? []), input.operationId].slice(-16);
  await saveLifeEngineState({
    ...current,
    completedOperationIds,
    lastTickAt: Math.max(current.lastTickAt ?? 0, input.tickAt),
    ...(isBackgroundSource(input.source)
      ? {
          lastBackgroundTickAt: Math.max(
            current.lastBackgroundTickAt ?? 0,
            input.tickAt,
          ),
        }
      : {
          lastForegroundTickAt: Math.max(
            current.lastForegroundTickAt ?? 0,
            input.tickAt,
          ),
        }),
  });
}

async function saveLifeEngineState(state: LifeEngineState) {
  await AsyncStorage.setItem(LIFE_ENGINE_STATE_KEY, JSON.stringify(state));
}

function shouldSkipForThrottle({
  force,
  now,
  source,
  state,
}: {
  force?: boolean;
  now: number;
  source: LifeTickSource;
  state: LifeEngineState;
}) {
  if (force) return false;
  const interval = isBackgroundSource(source) ? LIFE_ENGINE_BACKGROUND_INTERVAL_MS : LIFE_ENGINE_FOREGROUND_INTERVAL_MS;
  const lastTickAt = isBackgroundSource(source) ? state.lastBackgroundTickAt : state.lastForegroundTickAt;
  return typeof lastTickAt === 'number' && now - lastTickAt < interval;
}

async function performLifeTick(options: LifeTickOptions): Promise<LifeTickResult> {
  if (Platform.OS === 'android') await changeUnifiedContactState(() => undefined);
  const now = options.now ?? Date.now();
  const source = options.source ?? 'foreground';
  const localOnly = options.localOnly === true;
  const backgroundAiTick = isBackgroundSource(source) && !localOnly;
  const throttleState = await loadLifeEngineState();
  if (shouldSkipForThrottle({ force: options.force, now, source, state: throttleState })) {
    return {
      projectAdvanced: false,
      proactiveMessageInserted: 0,
      skippedReason: 'throttled',
      source,
      stateUpdated: false,
    };
  }

  const profile = options.profile ?? defaultAiProfile;
  const autonomySettings = await loadAutonomySettings().catch(() => null);
  const periodicPersistence = source !== 'manual';
  let periodicCheckpoint = periodicPersistence
    ? beginLifePeriodicSyncCheckpoint(
        await loadLifePeriodicSyncCheckpoint(),
        now,
      )
    : null;
  const periodicMode = (component: LifePeriodicSyncComponent) => (
    periodicCheckpoint
    && shouldSynchronizeLifePeriodicComponent(periodicCheckpoint, component)
      ? 'synchronized' as const
      : periodicPersistence
        ? 'local-only' as const
        : 'synchronized' as const
  );
  const markPeriodicComponent = async (
    component: LifePeriodicSyncComponent,
  ) => {
    if (
      !periodicCheckpoint
      || !shouldSynchronizeLifePeriodicComponent(
        periodicCheckpoint,
        component,
      )
    ) {
      return;
    }
    const next = completeLifePeriodicSyncComponent(
      periodicCheckpoint,
      component,
      now,
    );
    await saveLifePeriodicSyncCheckpoint(next);
    periodicCheckpoint = next;
  };
  await markPeriodicComponent('drive').catch(() => undefined);
  const effectiveAutonomySettings = autonomySettings ?? defaultAutonomySettings;
  const naturalEarlyWakeOwner = createNaturalEarlyWakeOwner(!localOnly);
  let sleepPlanHandled = await runSleepPlanTick({ now, allowRequest: !localOnly, naturalEarlyWakeOwner }).catch(() => false);
  const firstWake = await completeNaturalEarlyWake(naturalEarlyWakeOwner);
  sleepPlanHandled = firstWake.handled || sleepPlanHandled;
  let proactiveMessageInserted = firstWake.inserted;
  await (await import('./readingActivityRuntime')).runReadingActivityTick(now, !localOnly).catch(() => undefined);
  await (await import('../schedule/ownScheduleExecution')).runOwnScheduleExecution(now).catch(() => undefined);
  await (await import('./ownDayPlanRuntime')).runOwnDayPlanTick(now, !localOnly).catch(() => undefined);
  await (await import('./sleepPlanRuntime')).reconcileSleepPlanLocally(Date.now(), undefined,
    !localOnly, undefined, naturalEarlyWakeOwner).catch(() => undefined);
  const localWake = await completeNaturalEarlyWake(naturalEarlyWakeOwner);
  sleepPlanHandled = localWake.handled || sleepPlanHandled;
  proactiveMessageInserted = Math.max(proactiveMessageInserted, localWake.inserted);
  // Existing startup/foreground/life opportunities own this low-frequency paper.
  // Local recovery remains possible even when automatic calls are disabled.
  void import('../posts/baiyunPostMemoryRuntime').then(async runtime => {
    if (localOnly) await runtime.recoverPostMemoryOrganization();
    else await runtime.organizePostMemory({ now });
  }).catch(error => console.warn('[post-memory-opportunity]', error instanceof Error ? error.message : String(error)));
  const beforeState = await loadAssistantState();
  const rhythmSnapshot = isAutonomyFeatureEnabled(effectiveAutonomySettings, 'realtimeRhythmEnabled')
    ? await runRhythmTick({
      lifeMode: beforeState.lifeMode,
      manualSleepUntil: beforeState.manualSleepUntil,
      manualWakeUntil: beforeState.manualWakeUntil,
      // Sleep/wake reconciliation above may already have settled past this round's start.
      now: Math.max(now, Date.now()),
    }, periodicMode('rhythm'))
      .then(async (snapshot) => {
        await markPeriodicComponent('rhythm');
        return snapshot;
      })
      .catch(() => null)
    : await markPeriodicComponent('rhythm').then(() => null);
  const desireSnapshot = isAutonomyFeatureEnabled(effectiveAutonomySettings, 'desireDrivenBehaviorEnabled')
    ? await loadJunluoDesireSnapshot(now).catch(() => null)
    : null;
  await markPeriodicComponent('desire').catch(() => undefined);
  const exploreDesire = desireSnapshot?.desires.explore_world;
  const explorationVisible = Boolean(
    exploreDesire
    && exploreDesire.effectiveValue + 1e-9 >= exploreDesire.baseline + JUNLUO_DESIRE_VISIBLE_THRESHOLD
  );
  const explorationIntent = exploreDesire ? {
    driveKey: 'curiosity' as const,
    queryHint: '',
    reason: 'explore_world',
    score: exploreDesire.effectiveValue,
    wantAction: 'web_browse' as const,
  } : null;
  const allowSocialDesireAction = source !== 'active' && !options.force && !localOnly;
  if (
    allowSocialDesireAction &&
    explorationVisible && explorationIntent &&
    beforeState.lifeMode !== 'sleeping' &&
    isAutonomyFeatureEnabled(effectiveAutonomySettings, 'webVoyageEnabled') &&
    isAutonomyFeatureEnabled(effectiveAutonomySettings, 'githubVoyageEnabled')
  ) {
    await runWebVoyageTick({
      backupRestoreLeaseHeld: options.backupRestoreLeaseHeld,
      intent: explorationIntent,
      now,
    }).catch(() => undefined);
  }
  if (
    allowSocialDesireAction &&
    explorationVisible && explorationIntent &&
    (
      isAutonomyFeatureEnabled(effectiveAutonomySettings, 'xiaohongshuEnabled') ||
      isAutonomyFeatureEnabled(effectiveAutonomySettings, 'publicPostingEnabled')
    )
  ) {
    await runSocialDesireAction(explorationIntent, now).catch(() => undefined);
  }
  let nextState = await refreshAssistantLifeState({
    sleepOpportunityChecked: true,
    skipNearStatus: sleepPlanHandled,
    apiKey: localOnly || backgroundAiTick ? undefined : options.apiKey,
    backupRestoreLeaseHeld: options.backupRestoreLeaseHeld,
    connection: localOnly || backgroundAiTick ? undefined : options.connection,
    diagnosticParentToken: options.diagnosticParentToken,
    now,
    profile,
  });
  await import('../gifts/giftReceptionRuntime').then(module => module.runGiftReceptionTick({
    now, allowRequest: !localOnly,
  })).catch(() => undefined);
  const lifeCreativeReady = Boolean(options.apiKey?.trim() && options.connection);
  const chatReady = Boolean(options.chatApiKey?.trim() && options.chatConnection);
  if (source !== 'active' && !localOnly && !sleepPlanHandled && (lifeCreativeReady || chatReady)) {
    if (lifeCreativeReady) {
      await import('../proactive/unifiedContactDispatch')
        .then(module => module.prepareUnifiedContactWaitingAffect()).catch(() => undefined);
      const proactiveResult = await runBudgetedAiCall('proactive', 'urgent', () =>
        maybeSendProactiveMessage({
          unifiedSchedulerHeld: true,
          naturalEarlyWakeOwner,
          apiKey: options.apiKey,
          backupRestoreLeaseHeld: options.backupRestoreLeaseHeld,
          connection: options.connection,
          profile,
        }),
        { shouldRecordSuccess: (value) => value > 0 },
      ).catch(() => null);
      const freshWakeDelivered = await completeNaturalEarlyWake(naturalEarlyWakeOwner);
      sleepPlanHandled = freshWakeDelivered.handled || sleepPlanHandled;
      proactiveMessageInserted = (proactiveResult?.ok ? proactiveResult.value : 0)
        + Math.max(proactiveMessageInserted, freshWakeDelivered.inserted);
    }

    // 后台一次只产出一类 AI 内容；前台仍可在主动消息后继续补齐到期的生活记录。
    if (!sleepPlanHandled && (!backgroundAiTick || !proactiveMessageInserted)) {
      const slowTasks = [
        async () => resumeSleepingBaiyunPostReply(),
        async () => {
          const result = await runBudgetedAiCall('contextualLetter', 'background', () =>
            maybeCreateContextualAiLetter({
              apiKey: options.chatApiKey,
              backupRestoreLeaseHeld: options.backupRestoreLeaseHeld,
              connection: options.chatConnection,
              now,
              profile,
            }),
            {
              connection: options.chatConnection,
              shouldRecordSuccess: (value) => value > 0,
            },
          );
          return result.ok && result.value > 0;
        },
        async () => {
          if (!isAutonomyFeatureEnabled(effectiveAutonomySettings, 'dreamSleepLoopEnabled')) return false;
          const result = await runBudgetedAiCall('dream', 'background', admission =>
            tryGenerateDream({
              admission,
              apiKey: options.apiKey,
              connection: options.connection,
              now,
              profile,
              rhythmSnapshot,
            }),
            {
              connection: options.connection,
              purpose: 'dream',
              shouldRecordSuccess: Boolean,
            },
          );
          return result.ok && !!result.value;
        },
        async () => maybePublishBaiyunPost({ apiKey: options.apiKey, connection: options.connection,
          profile, now, proactiveSent: proactiveMessageInserted > 0 }),
        async () => {
          const result = await import('../gifts/giftCreativeRuntime').then(module => module.runGiftCreativeTick({ now }));
          return result.requested;
        },
        async () => {
          // Background near-status reuses this queue without moving existing life tasks.
          if (!backgroundAiTick || !lifeCreativeReady) return false;
          const before = nextState;
          nextState = await refreshAssistantLifeState({ apiKey: options.apiKey, connection: options.connection,
            profile, now: Date.now(), sleepOpportunityChecked: true, skipNearStatus: sleepPlanHandled,
            backupRestoreLeaseHeld: options.backupRestoreLeaseHeld, diagnosticParentToken: options.diagnosticParentToken });
          return !sameAssistantState(before, nextState);
        },
      ];
      for (const runSlowTask of slowTasks) {
        const created = await runSlowTask().catch(() => false);
        if (created) break;
      }
    }
  }

  const nextThrottleState: LifeEngineState = {
    ...await loadLifeEngineState(),
    lastTickAt: now,
    ...(isBackgroundSource(source) ? { lastBackgroundTickAt: now } : { lastForegroundTickAt: now }),
  };
  await saveLifeEngineState(nextThrottleState);

  return {
    afterLifeMode: nextState.lifeMode,
    beforeLifeMode: beforeState.lifeMode,
    projectAdvanced: false,
    proactiveMessageInserted,
    source,
    stateUpdated: !sameAssistantState(beforeState, nextState),
    updatedAt: now,
  };
}

export function runLifeTick(options: LifeTickOptions = {}) {
  if (pendingTick) {
    return Promise.resolve({
      afterLifeMode: undefined,
      beforeLifeMode: undefined,
      projectAdvanced: false,
      proactiveMessageInserted: 0,
      skippedReason: 'in-flight' as const,
      source: options.source ?? 'foreground',
      stateUpdated: false,
    });
  }
  pendingTick = runLifeTickWithExecutionLease(options).finally(() => {
    pendingTick = undefined;
  });
  return pendingTick;
}

async function runLifeTickWithExecutionLease(
  options: LifeTickOptions,
): Promise<LifeTickResult> {
  const now = options.now ?? Date.now();
  const source = options.source ?? 'foreground';
  // Local scheduled delivery remains available when the outer life claim is
  // offline or already complete. Model stages own their separate gift claims.
  await import('../gifts/giftReceptionRuntime').then(module => module.runGiftReceptionTick({
    now, allowRequest: false,
  })).catch(() => undefined);
  await import('../gifts/giftCreativeRuntime').then(module => module.runGiftCreativeTick({
    now, allowRequest: false,
  })).catch(() => undefined);
  const throttleState = await loadLifeEngineState();
  if (shouldSkipForThrottle({
    force: options.force,
    now,
    source,
    state: throttleState,
  })) {
    return {
      projectAdvanced: false,
      proactiveMessageInserted: 0,
      skippedReason: 'throttled',
      source,
      stateUpdated: false,
    };
  }

  const identity = createLifeTickExecutionIdentity(now);
  const operationId = createLifeTickOperationId(identity);
  let localResult: LifeTickResult | undefined;
  try {
    const result = await executeLifeTickOnce(identity, {
      reconcileLocally: async () => (
        (await loadLifeEngineState()).completedOperationIds?.includes(
          operationId,
        )
          ? 'completed'
          : null
      ),
      executeLocally: async () => {
        localResult = await performLifeTick({ ...options, now, source });
        await markLifeTickExecutionCompleted({
          operationId,
          source,
          tickAt: now,
        });
        return 'completed';
      },
      applyReceipt: async (outcome) => {
        if (outcome === 'completed') {
          await markLifeTickExecutionCompleted({
            operationId,
            source,
            tickAt: now,
          });
        }
      },
    });
    if (result.outcome !== 'completed') {
      return {
        projectAdvanced: false,
        proactiveMessageInserted: 0,
        skippedReason: 'reconciliation-required',
        source,
        stateUpdated: false,
      };
    }
    if (result.executedNow && localResult) return localResult;
    return {
      projectAdvanced: false,
      proactiveMessageInserted: 0,
      source,
      stateUpdated: false,
      updatedAt: result.completedAt,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'life-tick-owned-by-another-device') {
      return {
        projectAdvanced: false,
        proactiveMessageInserted: 0,
        skippedReason: 'leased-elsewhere',
        source,
        stateUpdated: false,
      };
    }
    if (message === 'life-tick-needs-reconciliation') {
      return {
        projectAdvanced: false,
        proactiveMessageInserted: 0,
        skippedReason: 'reconciliation-required',
        source,
        stateUpdated: false,
      };
    }
    throw error;
  }
}

export async function runLifeTickFromStoredConfig(options: Omit<LifeTickOptions, 'apiKey' | 'chatApiKey' | 'chatConnection' | 'connection' | 'profile'> = {}) {
  const snapshot = await loadAiConfigPreferencesSnapshot();
  const automaticRemoteAiEnabled = isAutomaticRemoteAiAllowed(
    await loadAutomaticRemoteAiPolicy(),
  );
  const localOnly = options.localOnly === true || !automaticRemoteAiEnabled;
  const lifeCreativeConfig = resolveLifeCreativeConfig(snapshot);
  return runLifeTick({
    ...options,
    apiKey: localOnly ? undefined : lifeCreativeConfig.apiKey,
    chatApiKey: localOnly ? undefined : snapshot.chatKey,
    chatConnection: localOnly ? undefined : snapshot.chatConnection,
    connection: localOnly ? undefined : lifeCreativeConfig.connection,
    localOnly,
    profile: snapshot.profile,
  });
}
