import AsyncStorage from '@react-native-async-storage/async-storage';
import { assistantLifeStateStorageBridge } from '../sync/syncAssistantLifeStateStorageBridge';
import { relationshipAuthorizationStorageBridge } from '../sync/syncRelationshipAuthorizationStorageBridge';
import { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import { recoverUnifiedContactSavedMessages } from './unifiedContactRuntime';
import { recordContactScheduleRecoveryProvided } from './unifiedContactScheduleRecovery';
import { RETIRED_SOCIAL_SHARE_QUEUE_KEY } from '../ai/retiredAssistantFeatureData';
import { initialContactState, contactPauseAfterYou, finishContactOpportunity, runUnifiedContactStorageWrite, isContactPastMemorySource, contactMessageId, type ContactMotive, type ContactPause, type UnifiedContactState } from './unifiedContact';
import type { JunLuoToolAgentContinuationMessage } from '../tools/toolAgentLoop';
import type { JunLuoToolResult } from '../tools';

// One partition in the existing proactive runtime record; legacy call fields remain owned by calls.
export const PROACTIVE_STATE_KEY = 'junluo.proactiveMessage.state';
export const PROACTIVE_SETTINGS_KEY = 'junluo.proactiveMessage.settings';
export type ContactToolReceipt = {
  continuationMessages: JunLuoToolAgentContinuationMessage[];
  completedResults: JunLuoToolResult[];
};
export type StoredUnifiedContactState = UnifiedContactState & {
  checkAfterAt?: number;
  toolReceipt?: ContactToolReceipt;
  failureAcknowledgedId?: string;
  failure?: { opportunityId: string; attemptedAt: number; motives: ContactMotive[] };
  claimedPriority?: Partial<Record<'heart' | 'period', string>>;
  handledSocialIds?: string[];
  diagnostics?: Array<{ id: string; at: number; stage: string; requests: number;
    savedMessageIds: string[]; sourceIds: string[]; toolResultIds: string[]; reason?: string;
    retryAt?: number | null; expiresAt?: number; saveRetryAt?: number;
    requestToken?: string; transportState?: 'not_started' | 'started' | 'unknown' }>;
};

export async function recoverStoredUnifiedContactMessages(epoch = captureBackupRestoreDataEpoch()): Promise<void> {
  if (epoch === null || !canCommitBackupRestoreDataEpoch(epoch)) return;
  const { loadChatSessionMessage } = await import('../chat/chatStorage');
  const { recordContactWeeklyReviewProvided } = await import('./unifiedContactWeeklyReview');
  await recoverUnifiedContactSavedMessages({ read: readUnifiedContactState,
    change: work => changeUnifiedContactState(work, epoch), readSaved: loadChatSessionMessage,
    recordSavedMaterials: async (op, message) => {
      await recordContactWeeklyReviewProvided(op, message);
      await recordContactScheduleRecoveryProvided(op, message);
      if (message.id === contactMessageId(op, 0) && !op.pastMemoryUsageResult && op.sources.some(isContactPastMemorySource)) {
        const { recordContactPastMemoryProvided } = await import('./unifiedContactMemory');
        await recordContactPastMemoryProvided(op, message);
      }
    },
    isEpochCurrent: value => value === epoch && canCommitBackupRestoreDataEpoch(epoch) });
}

async function readObject(key: string): Promise<Record<string, unknown>> {
  const raw = await AsyncStorage.getItem(key);
  if (!raw) return {};
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('proactive-storage-invalid');
  return value as Record<string, unknown>;
}

export async function readUnifiedContactState(now = Date.now()): Promise<StoredUnifiedContactState> {
  const record = await readObject(PROACTIVE_STATE_KEY);
  const state = record.unified as StoredUnifiedContactState | undefined;
  if (!state) return initialContactState(now);
  if (state.version !== 1 || !Number.isSafeInteger(state.used) || state.used < 0 || !Number.isFinite(state.initializedAt)) {
    throw new Error('unified-contact-state-invalid');
  }
  return state;
}

async function performUnifiedContactStateChange<T>(
  work: (state: StoredUnifiedContactState) => T,
  write: (key: string, value: string) => Promise<void>,
): Promise<T> {
  const record = await readObject(PROACTIVE_STATE_KEY);
  // The existing first-use upgrade owns this retired key. Do not run a
  // whole-store purge or erase any active sync heads during startup.
  if (!record.unified) await AsyncStorage.removeItem(RETIRED_SOCIAL_SHARE_QUEUE_KEY);
  const state: StoredUnifiedContactState = record.unified as StoredUnifiedContactState | undefined ?? initialContactState(Date.now());
  const before = JSON.stringify([state.current?.id, state.current?.status, state.current?.requests,
    state.current?.savedMessageIds, state.toolReceipt?.completedResults.map(result => result.callId), state.current?.reason,
    state.current?.transportState, state.current?.retryAt, state.current?.saveRetryAt]);
  const result = work(state);
  const op = state.current;
  if (op?.status === 'finished') state.toolReceipt = undefined;
  const after = JSON.stringify([op?.id, op?.status, op?.requests, op?.savedMessageIds,
    state.toolReceipt?.completedResults.map(result => result.callId), op?.reason,
    op?.transportState, op?.retryAt, op?.saveRetryAt]);
  if (op && before !== after) state.diagnostics = [...(state.diagnostics ?? []), {
    id: op.id, at: Date.now(), stage: op.status, requests: op.requests,
    savedMessageIds: [...op.savedMessageIds], sourceIds: op.sources.map(source => `${source.kind}:${source.id}`),
    toolResultIds: state.toolReceipt?.completedResults.map(result => result.callId) ?? [],
    ...(op.reason ? { reason: op.reason } : {}),
    retryAt: op.retryAt, expiresAt: op.expiresAt, saveRetryAt: op.saveRetryAt,
    requestToken: op.requestToken, transportState: op.transportState,
  }].slice(-80);
  await write(PROACTIVE_STATE_KEY, JSON.stringify({ ...record, unified: state }));
  return result;
}

export function changeUnifiedContactState<T>(
  work: (state: StoredUnifiedContactState) => T,
  epoch = captureBackupRestoreDataEpoch(),
): Promise<T> {
  return runUnifiedContactStorageWrite(async () => {
    const saved = await runBackupRestoreDataEpochCommit(epoch, () =>
      performUnifiedContactStateChange(work, assistantLifeStateStorageBridge.setItem));
    if (!saved.committed) throw new Error('unified-contact-epoch');
    return saved.value;
  });
}

/** Restore already owns the exclusive window; neither the domain queue nor sync capture may be re-entered. */
export function finishUnifiedContactAfterRestore(now = Date.now()): Promise<void> {
  return performUnifiedContactStateChange(
    state => finishContactOpportunity(state, now, 'automatic_disabled'),
    assistantLifeStateStorageBridge.setLocalItem,
  );
}

// Old autonomous-call accounting shares the key, never replace the unified partition.
export function saveLegacyProactiveFields(fields: Record<string, unknown>): Promise<void> {
  return runUnifiedContactStorageWrite(async () => {
    const current = await readObject(PROACTIVE_STATE_KEY);
    await AsyncStorage.setItem(PROACTIVE_STATE_KEY, JSON.stringify({ ...current, ...fields }));
  });
}

export async function readContactPause(): Promise<ContactPause | null> {
  const settings = await readObject(PROACTIVE_SETTINGS_KEY);
  const pause = settings.contactPause as ContactPause | null | undefined;
  if (!pause) return null;
  if (typeof pause.sourceMessageId !== 'string' || !Number.isFinite(pause.sourceAt)
    || (pause.until !== null && !Number.isFinite(pause.until))) throw new Error('contact-pause-invalid');
  return pause;
}

function changeContactSettings(work: (settings: Record<string, unknown>) => boolean | Promise<boolean>): Promise<void> {
  const epoch = captureBackupRestoreDataEpoch();
  return runUnifiedContactStorageWrite(async () => {
    const committed = await runBackupRestoreDataEpochCommit(epoch, async () => {
      const settings = await readObject(PROACTIVE_SETTINGS_KEY);
      if (await work(settings)) await relationshipAuthorizationStorageBridge.setItem(PROACTIVE_SETTINGS_KEY, JSON.stringify(settings));
    });
    if (!committed.committed) throw new Error('contact-pause-epoch');
  });
}

export function applyContactPauseUpdate(input: {
  state: '暂停' | '恢复'; sourceMessageId: string; sourceAt: number; until?: number;
  isCurrent: () => Promise<boolean>;
}): Promise<void> {
  return changeContactSettings(async settings => {
    if (!await input.isCurrent()) throw new Error('contact-turn-stale');
    const lastAt = Number(settings.contactPauseSourceAt ?? 0);
    const sameSource = input.sourceAt === lastAt && input.sourceMessageId === settings.contactPauseSourceMessageId;
    if (input.sourceAt < lastAt || input.sourceAt === lastAt && !sameSource) throw new Error('contact-turn-stale');
    const previous = settings.contactPause as ContactPause | null | undefined;
    if (sameSource && settings.contactPauseSourceKind === 'explicit') {
      if (input.state === '恢复' && !previous) return false;
      if (input.state === '暂停') {
        if (previous?.sourceMessageId === input.sourceMessageId) return false;
        throw new Error('contact-turn-stale');
      }
    }
    settings.contactPause = input.state === '恢复' ? null : {
      sourceMessageId: input.sourceMessageId, sourceAt: input.sourceAt,
      until: input.until ?? null,
    } satisfies ContactPause;
    settings.contactPauseSourceAt = input.sourceAt;
    settings.contactPauseSourceMessageId = input.sourceMessageId;
    settings.contactPauseSourceKind = 'explicit';
    return true;
  });
}

export function observeContactYouMessage(message: { id: string; createdAt: number }): Promise<void> {
  return changeContactSettings(settings => {
    const lastAt = Number(settings.contactPauseSourceAt ?? 0);
    if (message.createdAt < lastAt || message.id === settings.contactPauseSourceMessageId) return false;
    const previous = settings.contactPause as ContactPause | null | undefined;
    settings.contactPause = contactPauseAfterYou(previous ?? null, message);
    settings.contactPauseSourceAt = message.createdAt;
    settings.contactPauseSourceMessageId = message.id;
    settings.contactPauseSourceKind = 'auto';
    return true;
  });
}

export async function noteOrdinaryContactReply(savedAt: number): Promise<void> {
  await changeUnifiedContactState(state => { state.lastOrdinaryReplyAt = Math.max(state.lastOrdinaryReplyAt, savedAt); });
}

export function saveProactiveSettingsFields(fields: Record<string, unknown>): Promise<void> {
  return changeContactSettings(settings => {
    Object.assign(settings, fields);
    return true;
  });
}
