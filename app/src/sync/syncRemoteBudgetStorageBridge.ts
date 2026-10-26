import RawAsyncStorage from '@react-native-async-storage/async-storage';
import { AI_CALL_BUDGET_KEY, parseAiCallBudgetState, serializeAiCallBudgetState, type AiCallBudgetKind } from '../ai/aiCallBudgetStorage';
import type { ContactOpportunity } from '../proactive/unifiedContact';

import {
  REMOTE_BUDGET_BATCH_CAPTURE_POLICY,
  RemoteBudgetBusinessApplier,
} from './syncRemoteBudgetApply';
import { appendRemoteBudgetEvent } from './syncRemoteBudgetAsyncStoragePort';
import { ASSISTANT_LIFE_STATE_KEYS } from './syncAssistantLifeStateStorageDerivation';
import type { RemoteBudgetEventRecord } from './syncRemoteBudget';
import type { SyncDurableIntent } from './syncRecoveryIntent';
import {
  runRemoteBudgetCaptureExclusive,
} from './syncRemoteBudgetCaptureQueue';
import {
  deriveRemoteBudgetMutationsForStorageChanges,
  isRemoteBudgetGlobalStorageKey,
  type RemoteBudgetStorageChange,
} from './syncRemoteBudgetStorageDerivation';
import { loadCurrentSyncDevice } from './syncCurrentDevice';
import { assertSyncMutationBatchCaptureIntentV1, captureSyncMutationBatch, recoverSyncMutationBatch } from './syncMutationBatchCapture';
import { createSyncMutationEnvelope } from './syncMutationEnvelope';
import {
  enqueueSyncMutationAndAdvanceHeads,
  syncMutationStatePort,
} from './syncMutationStateStore';
import {
  advanceSyncDurableIntent,
  discardPreparedSyncDurableIntent,
  loadIncompleteSyncDurableIntents,
  loadSyncDurableIntent,
  prepareSyncDurableIntent,
} from './syncStore';

const durableCapture = {
  prepareSyncDurableIntent,
  advanceSyncDurableIntent,
  enqueueSyncMutation: enqueueSyncMutationAndAdvanceHeads,
};

// A live business-write rejection proves no transport started even before the
// caller can persist its not_started cleanup. Restart relies on that original undo.
const unstartedRequestRecords = new Set<string>();

function budgetRequestEvent(intent: SyncDurableIntent): RemoteBudgetEventRecord | null {
  if (intent.adapterId !== REMOTE_BUDGET_BATCH_CAPTURE_POLICY.adapterId) return null;
  assertSyncMutationBatchCaptureIntentV1(intent.intent);
  if (intent.intent.mutations.length !== 1) return null;
  const mutation = intent.intent.mutations[0];
  if (!REMOTE_BUDGET_BATCH_CAPTURE_POLICY.isMutationAllowed(mutation)) return null;
  const event = (mutation.payload as { value: RemoteBudgetEventRecord }).value;
  return (event.kind === 'proactive' && event.id.startsWith('proactive:'))
    || (event.kind === 'cameraVision' && event.id.startsWith('camera-vision:'))
    || (event.kind === 'reading' && event.id.startsWith('reading:'))
    || (event.kind === 'dayPlan' && event.id.startsWith('dayPlan:'))
    || (event.purpose !== undefined && event.id.startsWith('ai-call-')) ? event : null;
}

function discardUnstartedBudgetRequestCaptures(
  recordId: string,
  remoteAccountId: string,
  kind: AiCallBudgetKind,
) {
  return runRemoteBudgetCaptureExclusive(async () => {
    if (kind !== 'proactive') {
      const state = parseAiCallBudgetState(await RawAsyncStorage.getItem(AI_CALL_BUDGET_KEY));
      const records = state.records.filter(record => record.id !== recordId
        || record.scope !== 'remote-account' || record.remoteAccountId !== remoteAccountId);
      if (records.length !== state.records.length) await RawAsyncStorage.setItem(
        AI_CALL_BUDGET_KEY, serializeAiCallBudgetState({ ...state, records }),
      );
    }
    for (const intent of await loadIncompleteSyncDurableIntents()) {
      const event = budgetRequestEvent(intent);
      if (event?.kind !== kind || event.id !== recordId || event.remoteAccountId !== remoteAccountId) continue;
      await discardPreparedSyncDurableIntent(intent);
    }
    unstartedRequestRecords.delete(recordId);
  });
}

/** Called only for the original request whose transport was proven not to start. */
export function discardUnstartedProactiveBudgetCaptures(recordId: string, remoteAccountId: string) {
  return discardUnstartedBudgetRequestCaptures(recordId, remoteAccountId, 'proactive');
}

/** A failed camera admission has not returned permission to start its transport. */
export function discardUnstartedCameraVisionBudgetCaptures(recordId: string, remoteAccountId: string) {
  return discardUnstartedBudgetRequestCaptures(recordId, remoteAccountId, 'cameraVision');
}

export function discardUnstartedReadingBudgetCaptures(recordId: string, remoteAccountId: string, kind: 'reading' | 'dayPlan' = 'reading') {
  return discardUnstartedBudgetRequestCaptures(recordId, remoteAccountId, kind);
}

export function discardUnstartedAutomaticBudgetCaptures(recordId: string, remoteAccountId: string, kind: AiCallBudgetKind) {
  return discardUnstartedBudgetRequestCaptures(recordId, remoteAccountId, kind);
}

/** Budget-only recovery: never replay an exactly identified, cancelled request. */
export function recoverRemoteBudgetStorageCapture(snapshot: SyncDurableIntent) {
  return runRemoteBudgetCaptureExclusive(async () => {
    // A startup snapshot may precede the caller's successful local cancellation.
    const intent = await loadSyncDurableIntent(snapshot.operationId);
    if (!intent) return;
    const event = intent.state === 'prepared' ? budgetRequestEvent(intent) : null;
    if (event) {
      const state = parseAiCallBudgetState(await RawAsyncStorage.getItem(AI_CALL_BUDGET_KEY));
      let notStarted = unstartedRequestRecords.has(event.id);
      if (event.kind === 'proactive') {
        const raw = await RawAsyncStorage.getItem(ASSISTANT_LIFE_STATE_KEYS.proactiveState);
        const op = (raw ? JSON.parse(raw) : null)?.unified?.current as ContactOpportunity | undefined;
        const token = event.id.slice('proactive:'.length);
        notStarted ||= op?.requestToken === token
          && op.requestUndo?.token === token && op.transportState === 'not_started';
      } else {
        // Camera transport can only start after its local budget write returns.
        // A prepared capture with no matching local record must not invent a request on recovery.
        notStarted ||= !state.records.some(record => record.id === event.id
          && record.scope === 'remote-account' && record.remoteAccountId === event.remoteAccountId);
      }
      if (notStarted) {
        const records = state.records.filter(record => record.id !== event.id
          || record.scope !== 'remote-account' || record.remoteAccountId !== event.remoteAccountId);
        if (records.length !== state.records.length) await RawAsyncStorage.setItem(
          AI_CALL_BUDGET_KEY, serializeAiCallBudgetState({ ...state, records }),
        );
        await discardPreparedSyncDurableIntent(intent);
        unstartedRequestRecords.delete(event.id);
        return;
      }
    }
    await recoverSyncMutationBatch({ policy: REMOTE_BUDGET_BATCH_CAPTURE_POLICY, durableCapture,
      // The whole recovery already owns the existing budget capture queue.
      businessApplier: new RemoteBudgetBusinessApplier({ appendEvent: appendRemoteBudgetEvent }), durableIntent: intent });
  });
}

async function performCapturedRemoteBudgetChangeUnqueued<T>(
  changes: readonly RemoteBudgetStorageChange[],
  performBusinessWrite: () => Promise<T>,
) {
  const globalChanges = changes.filter(
    (change) => isRemoteBudgetGlobalStorageKey(change.key),
  );
  if (!globalChanges.length) return performBusinessWrite();
  const currentDevice = await loadCurrentSyncDevice();
  if (!currentDevice) return performBusinessWrite();
  const { expoSyncRandomUuidV1 } = await import('./syncCryptoExpo');
  const now = Date.now();
  const mutations = await deriveRemoteBudgetMutationsForStorageChanges({
    changes: globalChanges,
    reader: RawAsyncStorage,
    capturedAt: now,
    envelopeFactory: (entity) => createSyncMutationEnvelope({
      identity: currentDevice.identity,
      entity,
      state: syncMutationStatePort,
      randomUuid: expoSyncRandomUuidV1,
      now: () => now,
    }),
  });
  if (!mutations.length) return performBusinessWrite();
  let localWriteResult: { value: T } | undefined;
  const operationId = expoSyncRandomUuidV1();
  try {
    await captureSyncMutationBatch({
      operationId,
      policy: REMOTE_BUDGET_BATCH_CAPTURE_POLICY,
      durableCapture,
      mutations,
      performBusinessWrite: async () => {
        localWriteResult = { value: await performBusinessWrite() };
      },
      now: () => now,
    });
    return localWriteResult!.value;
  } catch (error) {
    if (localWriteResult) {
      console.warn('[sync-remote-budget] sync capture failed after local budget write', error);
      return localWriteResult.value;
    }
    const event = budgetRequestEvent({ operationId, adapterId: REMOTE_BUDGET_BATCH_CAPTURE_POLICY.adapterId,
      intent: { kind: 'sync-mutation-batch-v1', mutations }, state: 'prepared', createdAt: now, updatedAt: now });
    if (event) unstartedRequestRecords.add(event.id);
    throw error;
  }
}

function performCapturedRemoteBudgetChange<T>(
  changes: readonly RemoteBudgetStorageChange[],
  performBusinessWrite: () => Promise<T>,
) {
  return runRemoteBudgetCaptureExclusive(
    () => performCapturedRemoteBudgetChangeUnqueued(
      changes,
      performBusinessWrite,
    ),
  );
}

export const remoteBudgetStorageBridge = {
  getItem: (key: string) => RawAsyncStorage.getItem(key),
  multiGet: (keys: readonly string[]) => RawAsyncStorage.multiGet(keys),
  getAllKeys: () => RawAsyncStorage.getAllKeys(),
  setItem: (key: string, value: string) =>
    performCapturedRemoteBudgetChange(
      [{ kind: 'set', key, value }],
      () => RawAsyncStorage.setItem(key, value),
    ),
  multiSet: (entries: readonly (readonly [string, string])[]) => {
    const writableEntries = entries.map(
      ([key, value]) => [key, value] as [string, string],
    );
    return performCapturedRemoteBudgetChange(
      writableEntries.map(([key, value]) => ({
        kind: 'set' as const,
        key,
        value,
      })),
      () => RawAsyncStorage.multiSet(writableEntries),
    );
  },
  removeItem: (key: string) =>
    performCapturedRemoteBudgetChange(
      [{ kind: 'remove', key }],
      () => RawAsyncStorage.removeItem(key),
    ),
  multiRemove: (keys: readonly string[]) => {
    const writableKeys = [...keys];
    return performCapturedRemoteBudgetChange(
      writableKeys.map((key) => ({
        kind: 'remove' as const,
        key,
      })),
      () => RawAsyncStorage.multiRemove(writableKeys),
    );
  },
};

/** Keep the original durable capture prepared until the host also claims its
 * attempt. A rejected host cannot leave a captured charge for an unsent request. */
export function saveAutomaticBudgetBeforeTransport(value: string, beforeStart?: () => Promise<void>) {
  return performCapturedRemoteBudgetChange([{ kind: 'set', key: AI_CALL_BUDGET_KEY, value }], async () => {
    await RawAsyncStorage.setItem(AI_CALL_BUDGET_KEY, value);
    await beforeStart?.();
  });
}
