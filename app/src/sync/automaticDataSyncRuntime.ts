import * as Battery from 'expo-battery';

import { loadBackendSettings } from '../backend/backendClient';
import {
  loadMemoryDuplicateCleanupJournal,
  memoryDuplicateCleanupNeedsOneTimeDrain,
  saveMemoryDuplicateCleanupJournal,
} from '../memory/memoryDuplicateCleanupState';
import {
  ensureMemoryDuplicateCleanupCompletionMarker,
  memoryDuplicateCleanupMarkerId,
} from '../memory/memoryDuplicateCleanupMarker';
import {
  automaticDataSyncFailureBackoffMs,
  automaticDataSyncCooldownAllowsRun,
  loadAutomaticDataSyncPolicy,
  loadAutomaticDataSyncRuntimeStatus,
  memoryCleanupDrainCooldownAllowsRun,
  saveAutomaticDataSyncRuntimeStatus,
  type AutomaticDataSyncRuntimeStateV1,
} from './automaticDataSyncPolicy';
import { createAndroidManualSyncController } from './syncAndroidManualSync';
import { androidSyncLedgerSnapshot } from './syncAndroidMutationLedger';
import { loadAndroidSyncNetworkClass } from './syncAndroidNetworkClass';
import { getAndroidSyncReceiveFetchCursor } from './syncReceiveStore';
import { prepareAndPromoteHighNoiseDomains } from './syncHighNoiseSummaryPromotion';
import {
  automaticDataSyncOrdinaryBacklog,
  selectAutomaticDataSyncBudget,
  type AutomaticDataSyncProgressV1,
} from './automaticDataSyncProgressCore';
import {
  loadAutomaticDataSyncProgress,
  updateAutomaticDataSyncProgress,
} from './automaticDataSyncProgress';
import { loadSyncObjectProgressSnapshot } from './syncObjectJobStore';
import { runMemoryRecordsOutboxPromotionRuntime } from './syncMemoryRecordsRuntime';
import { loadMemoryRecordsDomainDrainSnapshot } from './syncMemoryRecordsSqlitePort';
import {
  createAndroidSyncRelayClient,
  loadCurrentSyncRelayEnrollment,
} from './syncRelayClientExpo';
import { assertOrdinarySyncAllowed } from './syncEmergencyWorldRebuildStore';
import { loadSyncMutationRelayReceiptCursor } from './syncStore';

export type AndroidAutomaticDataSyncSource =
  | 'cold-start'
  | 'foreground'
  | 'interval'
  | 'local-change'
  | 'background'
  | 'resume';

export type AndroidAutomaticDataSyncRunInput = {
  source: AndroidAutomaticDataSyncSource;
  allowFullSync: boolean;
  now?: () => number;
};

let automaticCheckInFlight: Promise<{
  state: AutomaticDataSyncRuntimeStateV1;
  synchronized: boolean;
}> | null = null;

async function canTransferLargeFilesAutomatically() {
  const [network, batteryState] = await Promise.all([
    loadAndroidSyncNetworkClass(),
    Battery.getBatteryStateAsync().catch(() => Battery.BatteryState.UNKNOWN),
  ]);
  return network === 'wifi'
    && (
      batteryState === Battery.BatteryState.CHARGING
      || batteryState === Battery.BatteryState.FULL
    );
}

function hasOrdinaryWork(snapshot: Awaited<ReturnType<
  typeof androidSyncLedgerSnapshot
>>) {
  return snapshot.pendingOutbox > 0 || snapshot.receivedInbox > 0;
}

function madeProgress(result: Awaited<ReturnType<
  ReturnType<typeof createAndroidManualSyncController>['runOnce']
>>) {
  return result.sentMutations > 0
    || result.receivedEntries > 0
    || result.consumedEntries > 0
    || result.uploadedObjects > 0
    || result.downloadedObjects > 0
    || result.materializedObjects > 0;
}

async function loadProgressQueues(remoteLatestCursor?: number) {
  const [ledger, objects, fetchCursor] = await Promise.all([
    androidSyncLedgerSnapshot(),
    loadSyncObjectProgressSnapshot(),
    remoteLatestCursor === undefined ? 0 : getAndroidSyncReceiveFetchCursor(),
  ]);
  return {
    pendingOutgoing: ledger.pendingOutbox,
    waitingAtRelay: remoteLatestCursor === undefined
      ? 0
      : Math.max(0, remoteLatestCursor - fetchCursor),
    receivedAwaitingApply: ledger.receivedInbox,
    conflicts: ledger.pendingConflicts,
    quarantined: ledger.quarantined,
    objectJobs: objects.objectJobs,
    blockedObjectJobs: objects.blockedObjectJobs,
    completedObjectChunks: objects.completedObjectChunks,
    totalObjectChunks: objects.totalObjectChunks,
  } satisfies AutomaticDataSyncProgressV1['queues'];
}

async function publishProgress(input: Omit<AutomaticDataSyncProgressV1,
  'lastRound' | 'updatedAt'> & {
    lastRound?: AutomaticDataSyncProgressV1['lastRound'];
    updatedAt: number;
    persistLastRound?: boolean;
  }) {
  const previous = await loadAutomaticDataSyncProgress();
  await updateAutomaticDataSyncProgress({
    phase: input.phase,
    tier: input.tier,
    queues: input.queues,
    lastRound: input.lastRound === undefined
      ? previous.lastRound
      : input.lastRound,
    updatedAt: input.updatedAt,
  }, input.persistLastRound);
}

async function reconcileMemoryCleanupDrain(input: {
  relay: ReturnType<typeof createAndroidSyncRelayClient>;
  enrollment: NonNullable<Awaited<ReturnType<typeof loadCurrentSyncRelayEnrollment>>>;
  updatedAt: number;
}) {
  const journal = await loadMemoryDuplicateCleanupJournal();
  if (!memoryDuplicateCleanupNeedsOneTimeDrain(journal) || !journal) return;
  const markerId = memoryDuplicateCleanupMarkerId(journal.startedAt);
  let [domain, ledger] = await Promise.all([
    loadMemoryRecordsDomainDrainSnapshot(markerId),
    androidSyncLedgerSnapshot(),
  ]);
  const hasBlockingTechnicalWork = domain.quarantined > 0
    || ledger.pendingConflicts > 0
    || ledger.quarantined > 0
    || ledger.objectJobs > 0;
  if (hasBlockingTechnicalWork) {
    await saveMemoryDuplicateCleanupJournal({
      ...journal,
      phase: 'publishing',
      updatedAt: input.updatedAt,
      lastErrorCode: domain.quarantined > 0
        ? 'memory-cleanup-domain-quarantined'
        : ledger.pendingConflicts > 0
          ? 'memory-cleanup-conflicts-pending'
          : ledger.quarantined > 0
            ? 'memory-cleanup-sync-quarantined'
            : 'memory-cleanup-object-jobs-pending',
    });
    return;
  }
  if (
    !domain.markerMutationId
    && domain.pendingOrLeased === 0
    && ledger.pendingOutbox === 0
    && ledger.receivedInbox === 0
  ) {
    await ensureMemoryDuplicateCleanupCompletionMarker({
      startedAt: journal.startedAt,
      createdAt: input.updatedAt,
    });
    domain = await loadMemoryRecordsDomainDrainSnapshot(markerId);
  }
  if (!domain.markerMutationId) return;
  const publishedThroughCursor = await loadSyncMutationRelayReceiptCursor(
    domain.markerMutationId,
  );
  if (
    publishedThroughCursor === null
    || domain.pendingOrLeased > 0
    || ledger.pendingOutbox > 0
    || ledger.receivedInbox > 0
  ) return;
  const freshness = await input.relay.listDeviceFreshness(input.enrollment);
  const waitingDeviceCount = freshness.filter((item) => (
    item.deviceId !== input.enrollment.publicIdentity.deviceId
    && item.appliedCursor < publishedThroughCursor!
  )).length;
  await saveMemoryDuplicateCleanupJournal({
    ...journal,
    phase: waitingDeviceCount === 0 ? 'complete' : 'waiting-windows',
    publishedThroughCursor,
    waitingDeviceCount,
    updatedAt: input.updatedAt,
    lastErrorCode: null,
  });
}

export async function refreshAndroidAutomaticDataSyncProgress() {
  const previous = await loadAutomaticDataSyncProgress();
  const queues = await loadProgressQueues();
  const transientPhases: AutomaticDataSyncProgressV1['phase'][] = [
    'checking',
    'sending',
    'receiving',
    'materializing',
    'files',
  ];
  await updateAutomaticDataSyncProgress({
    ...previous,
    phase: transientPhases.includes(previous.phase)
      ? previous.phase
      : queues.conflicts > 0
        || queues.quarantined > 0
        || queues.blockedObjectJobs > 0
        ? 'attention-required'
        : 'idle',
    queues,
    updatedAt: previous.updatedAt,
  });
}

export async function recordAndroidManualSyncProgress(
  result: Awaited<ReturnType<
    ReturnType<typeof createAndroidManualSyncController>['runOnce']
  >>,
) {
  const previous = await loadAutomaticDataSyncProgress();
  const queues = await loadProgressQueues();
  const completedAt = result.completedAt;
  await updateAutomaticDataSyncProgress({
    phase: result.sync.pendingConflicts > 0
      || result.sync.quarantined > 0
      || queues.blockedObjectJobs > 0
      ? 'attention-required'
      : result.state === 'complete'
        ? 'idle'
        : 'paused',
    tier: previous.tier,
    queues: {
      ...queues,
      waitingAtRelay: result.state === 'complete'
        ? 0
        : previous.queues.waitingAtRelay,
    },
    lastRound: {
      sent: result.sentMutations,
      received: result.receivedEntries,
      materialized: result.consumedEntries,
      durationMs: Math.max(0, completedAt - result.startedAt),
      stoppedBy: result.state === 'complete'
        ? 'complete'
        : completedAt - result.startedAt >= 45_000
          ? 'time-limit'
          : 'item-limit',
    },
    updatedAt: completedAt,
  }, true);
}

async function runAutomaticCheck(input: AndroidAutomaticDataSyncRunInput) {
  await assertOrdinarySyncAllowed();
  const now = input.now ?? Date.now;
  const [policy, cleanupJournal] = await Promise.all([
    loadAutomaticDataSyncPolicy(),
    loadMemoryDuplicateCleanupJournal(),
  ]);
  const cleanupDrain = memoryDuplicateCleanupNeedsOneTimeDrain(cleanupJournal);
  if (!policy.enabled && !cleanupDrain) {
    return { state: 'disabled' as const, synchronized: false };
  }

  const previous = await loadAutomaticDataSyncRuntimeStatus();
  const startedAt = now();
  if (!automaticDataSyncCooldownAllowsRun({
    now: startedAt,
    source: input.source,
    status: previous,
  }) || (
    cleanupDrain
    && !memoryCleanupDrainCooldownAllowsRun({
      now: startedAt,
      status: previous,
    })
  )) {
    return { state: previous.state, synchronized: false };
  }

  const backend = await loadBackendSettings();
  if (!backend.enabled || !backend.baseUrl.trim()) {
    const queues = await loadProgressQueues();
    await publishProgress({
      phase: 'waiting-relay',
      tier: 'gentle',
      queues,
      updatedAt: startedAt,
    });
    await saveAutomaticDataSyncRuntimeStatus({
      ...previous,
      state: 'waiting-relay',
      lastAttemptAt: startedAt,
      nextAttemptAt: startedAt + 60_000,
      workRemaining: true,
    });
    return { state: 'waiting-relay' as const, synchronized: false };
  }

  await saveAutomaticDataSyncRuntimeStatus({
    ...previous,
    state: 'checking',
    lastAttemptAt: startedAt,
    nextAttemptAt: null,
  });

  try {
    const enrollment = await loadCurrentSyncRelayEnrollment();
    if (!enrollment) {
      await saveAutomaticDataSyncRuntimeStatus({
        ...previous,
        state: 'attention-required',
        lastAttemptAt: startedAt,
        nextAttemptAt: startedAt + 60_000,
        workRemaining: true,
      });
      return { state: 'attention-required' as const, synchronized: false };
    }
    await import('./syncChatStorageBridge').then(
      ({ flushPendingChatStorageSyncCapture }) => (
        flushPendingChatStorageSyncCapture()
      ),
    );
    let before = await androidSyncLedgerSnapshot();
    let cleanupDomain = cleanupDrain && cleanupJournal
      ? await loadMemoryRecordsDomainDrainSnapshot(
        memoryDuplicateCleanupMarkerId(cleanupJournal.startedAt),
      )
      : null;
    if (cleanupDrain) {
      await runMemoryRecordsOutboxPromotionRuntime({
        now: startedAt,
        batchLimit: 16,
        maximumBatches: 3,
      });
      before = await androidSyncLedgerSnapshot();
      if (cleanupJournal) {
        cleanupDomain = await loadMemoryRecordsDomainDrainSnapshot(
          memoryDuplicateCleanupMarkerId(cleanupJournal.startedAt),
        );
      }
    }
    if (
      input.allowFullSync
      && !hasOrdinaryWork(before)
      && !cleanupDrain
    ) {
      await prepareAndPromoteHighNoiseDomains({
        mode: 'automatic',
        limit: 16,
        now: startedAt,
      });
      before = await androidSyncLedgerSnapshot();
    }
    const fetchCursor = await getAndroidSyncReceiveFetchCursor();
    const relay = createAndroidSyncRelayClient({
      baseUrl: backend.baseUrl,
    });
    const changeStatus = await relay.getChangeStatus(enrollment, fetchCursor);
    let queues = await loadProgressQueues(changeStatus.latestCursor);
    const budget = cleanupDrain
      ? {
        tier: 'catch-up' as const,
        maxSendBatches: 3,
        maxReceivePages: 3,
        maxConsumedEntries: 48,
        runtimeLimitMs: 25_000,
        maximumObjectChunks: 0,
      }
      : selectAutomaticDataSyncBudget(
        automaticDataSyncOrdinaryBacklog(queues),
        { background: input.source === 'background', maximumObjectChunks: 2 },
      );
    await publishProgress({
      phase: 'checking',
      tier: budget.tier,
      queues,
      updatedAt: startedAt,
    });
    const ordinaryWorkAvailable = hasOrdinaryWork(before);
    const runnableObjectJobs = Math.max(
      0,
      queues.objectJobs - queues.blockedObjectJobs,
    );
    const allowObjectTransfer = !cleanupDrain
      && input.allowFullSync && runnableObjectJobs > 0
      ? await canTransferLargeFilesAutomatically()
      : false;
    const remoteHasChanges = changeStatus.hasChanges;
    const workAvailable = ordinaryWorkAvailable
      || remoteHasChanges
      || (cleanupDomain?.pendingOrLeased ?? 0) > 0
      || (runnableObjectJobs > 0 && allowObjectTransfer);

    if (!workAvailable) {
      if (cleanupDrain) {
        await reconcileMemoryCleanupDrain({
          relay,
          enrollment,
          updatedAt: startedAt,
        });
      }
      const state = queues.blockedObjectJobs > 0
        ? 'attention-required' as const
        : runnableObjectJobs > 0
          ? 'waiting-large-file-conditions' as const
        : before.pendingConflicts > 0 || before.quarantined > 0
          ? 'attention-required' as const
          : 'idle' as const;
      await saveAutomaticDataSyncRuntimeStatus({
        state,
        lastAttemptAt: startedAt,
        lastSuccessAt: startedAt,
        nextAttemptAt: startedAt + 60_000,
        consecutiveFailures: 0,
        workRemaining: state !== 'idle',
      });
      await publishProgress({
        phase: state === 'attention-required'
          ? 'attention-required'
          : state === 'waiting-large-file-conditions'
            ? 'paused'
            : 'idle',
        tier: budget.tier,
        queues,
        updatedAt: startedAt,
      });
      return { state, synchronized: false };
    }

    if (!input.allowFullSync) {
      await saveAutomaticDataSyncRuntimeStatus({
        ...previous,
        state: 'idle',
        lastAttemptAt: startedAt,
        nextAttemptAt: startedAt + 60_000,
        workRemaining: true,
      });
      await publishProgress({
        phase: 'paused',
        tier: budget.tier,
        queues,
        updatedAt: startedAt,
      });
      return { state: 'idle' as const, synchronized: false };
    }

    await saveAutomaticDataSyncRuntimeStatus({
      ...previous,
      state: 'syncing',
      lastAttemptAt: startedAt,
      nextAttemptAt: null,
      workRemaining: true,
    });
    const result = await createAndroidManualSyncController({
      baseUrl: backend.baseUrl,
      now,
    }).runOnce({
      mode: 'automatic',
      allowObjectTransfer,
      automaticBudget: budget,
      suppressOptionalPromotions: cleanupDrain,
      onAutomaticProgress: (phase, counts) => {
        void publishProgress({
          phase,
          tier: budget.tier,
          queues,
          lastRound: {
            ...counts,
            durationMs: Math.max(0, now() - startedAt),
            stoppedBy: 'item-limit',
          },
          updatedAt: now(),
        });
      },
    });
    const completedAt = now();
    const completedFetchCursor = await getAndroidSyncReceiveFetchCursor();
    const completedChangeStatus = await relay.getChangeStatus(
      enrollment,
      completedFetchCursor,
    );
    queues = await loadProgressQueues(completedChangeStatus.latestCursor);
    if (cleanupDrain) {
      await reconcileMemoryCleanupDrain({
        relay,
        enrollment,
        updatedAt: completedAt,
      });
    }
    const progressed = madeProgress(result);
    const onlyAttention = !progressed
      && result.sync.pendingOutbox === 0
      && result.sync.receivedInbox === 0
      && (
        result.sync.pendingConflicts > 0
        || result.sync.quarantined > 0
      );
    const state = onlyAttention
      ? 'attention-required' as const
      : queues.blockedObjectJobs > 0
        ? 'attention-required' as const
        : result.sync.objectJobs > 0 && !allowObjectTransfer
          ? 'waiting-large-file-conditions' as const
          : 'idle' as const;
    await saveAutomaticDataSyncRuntimeStatus({
      state,
      lastAttemptAt: startedAt,
      lastSuccessAt: completedAt,
      nextAttemptAt: completedAt + 60_000,
      consecutiveFailures: 0,
      workRemaining: result.state === 'work-remaining'
        || memoryDuplicateCleanupNeedsOneTimeDrain(
          await loadMemoryDuplicateCleanupJournal(),
        ),
    });
    await publishProgress({
      phase: onlyAttention
        ? 'attention-required'
        : queues.blockedObjectJobs > 0
          ? 'attention-required'
          : result.sync.objectJobs > 0 && !allowObjectTransfer
            ? 'paused'
            : 'idle',
      tier: budget.tier,
      queues,
      lastRound: {
        sent: result.sentMutations,
        received: result.receivedEntries,
        materialized: result.consumedEntries,
        durationMs: Math.max(0, completedAt - startedAt),
        stoppedBy: result.state === 'complete'
          ? 'complete'
          : completedAt - startedAt >= budget.runtimeLimitMs
            ? 'time-limit'
            : 'item-limit',
      },
      updatedAt: completedAt,
      persistLastRound: true,
    });
    return { state, synchronized: true };
  } catch {
    const failures = previous.consecutiveFailures + 1;
    const nextAttemptAt = now() + automaticDataSyncFailureBackoffMs(failures);
    await saveAutomaticDataSyncRuntimeStatus({
      ...previous,
      state: 'waiting-relay',
      lastAttemptAt: startedAt,
      nextAttemptAt,
      consecutiveFailures: failures,
      workRemaining: true,
    });
    const previousProgress = await loadAutomaticDataSyncProgress();
    await publishProgress({
      phase: 'waiting-relay',
      tier: previousProgress.tier,
      queues: previousProgress.queues,
      lastRound: previousProgress.lastRound
        ? { ...previousProgress.lastRound, stoppedBy: 'error' }
        : null,
      updatedAt: now(),
      persistLastRound: true,
    });
    return { state: 'waiting-relay' as const, synchronized: false };
  }
}

export function runAndroidAutomaticDataSyncCheck(
  input: AndroidAutomaticDataSyncRunInput,
) {
  if (automaticCheckInFlight) return automaticCheckInFlight;
  const operation = runAutomaticCheck(input);
  automaticCheckInFlight = operation;
  operation.finally(() => {
    if (automaticCheckInFlight === operation) automaticCheckInFlight = null;
  }).catch(() => undefined);
  return operation;
}
