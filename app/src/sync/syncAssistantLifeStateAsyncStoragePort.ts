import RawAsyncStorage from '@react-native-async-storage/async-storage';
import { initialContactState, runUnifiedContactStorageWrite } from '../proactive/unifiedContact';

import {
  JUNLUO_INNER_STATE_KEYS,
} from '../life/junluoInnerState';
import {
  upgradeJunluoAffectState,
  retainMissingJunluoThoughtOriginals,
} from '../life/junluoInnerStatePersistence';
import {
  assertAssistantLifeStateRecord,
  assertAssistantLifeStateTransportRecord,
  isLegacyWantsStateRecord,
  shouldKeepCurrentWantsState,
} from './syncAssistantLifeState';
import { runJunluoDesireWriteBoundary } from '../life/junluoInnerStateStore';
import { mergeConversationAfterglowRuntimeProgress, mergeLifeDayRuntimeProgress } from './syncAssistantLifeStateMerge';
import type {
  AssistantLifeStateBusinessPort,
} from './syncAssistantLifeStateApply';
import {
  ASSISTANT_LIFE_STATE_KEYS,
} from './syncAssistantLifeStateStorageDerivation';
import type {
  JsonValue,
} from './syncProtocol';

let assistantLifeStateApplyQueue = Promise.resolve();

function enqueueAssistantLifeStateApply<T>(callback: () => Promise<T>) {
  const current = assistantLifeStateApplyQueue
    .catch(() => undefined)
    .then(callback);
  assistantLifeStateApplyQueue = current.then(
    () => undefined,
    () => undefined,
  );
  return current;
}

async function readJson(key: string, fallback: unknown) {
  const raw = await RawAsyncStorage.getItem(key);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`本机 ${key} 不是有效 JSON，已停止远端 materialize。`);
  }
}

async function writeJson(key: string, value: JsonValue) {
  await RawAsyncStorage.setItem(key, JSON.stringify(value));
}

function mergeSyncedOrdinaryContactReply(savedAt: number): Promise<void> {
  return runUnifiedContactStorageWrite(async () => {
    const stored = await readJson(ASSISTANT_LIFE_STATE_KEYS.proactiveState, {});
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) throw new Error('proactive-storage-invalid');
    const record = stored as Record<string, unknown>;
    const state = (record.unified ?? initialContactState(Date.now())) as Record<string, unknown>;
    if (state.version !== 1 || !Number.isFinite(state.lastOrdinaryReplyAt)) throw new Error('unified-contact-state-invalid');
    if (savedAt <= Number(state.lastOrdinaryReplyAt)) return;
    // Raw write avoids recapturing an incoming summary as a new local mutation.
    await RawAsyncStorage.setItem(ASSISTANT_LIFE_STATE_KEYS.proactiveState, JSON.stringify({ ...record,
      unified: { ...state, lastOrdinaryReplyAt: savedAt } }));
  });
}

async function updateLifeDayIndex(dateKey: string, present: boolean) {
  const stored = await readJson(ASSISTANT_LIFE_STATE_KEYS.lifeDayIndex, []);
  const keys = Array.isArray(stored)
    ? stored.filter((value): value is string => typeof value === 'string')
    : [];
  const next = new Set(keys);
  if (present) next.add(dateKey);
  else next.delete(dateKey);
  await writeJson(
    ASSISTANT_LIFE_STATE_KEYS.lifeDayIndex,
    [...next].sort(),
  );
}

function driveStorageKey(entityId: string) {
  switch (entityId) {
    case 'desire':
      return ASSISTANT_LIFE_STATE_KEYS.desireState;
    case 'metabolism':
      return ASSISTANT_LIFE_STATE_KEYS.driveMetabolism;
    case 'rhythm':
      return ASSISTANT_LIFE_STATE_KEYS.lifeRhythm;
    case 'conversation-afterglow':
      return ASSISTANT_LIFE_STATE_KEYS.conversationAfterglow;
    case 'global-interaction':
      return ASSISTANT_LIFE_STATE_KEYS.globalInteraction;
    case 'love-summary':
      return ASSISTANT_LIFE_STATE_KEYS.loveSummary;
    default:
      throw new Error(`未知 assistant life drive entity：${entityId}。`);
  }
}

function innerStorageKey(entityId: string) {
  switch (entityId) {
    case 'desire':
      return JUNLUO_INNER_STATE_KEYS.desire;
    case 'affect':
      return JUNLUO_INNER_STATE_KEYS.affect;
    case 'thoughts':
      return JUNLUO_INNER_STATE_KEYS.thought;
    default:
      throw new Error(`未知 assistant life inner entity：${entityId}。`);
  }
}

async function upsertRecord(
  input: Parameters<AssistantLifeStateBusinessPort['upsertRecord']>[0],
) {
  assertAssistantLifeStateTransportRecord(input.kind, input.entityId, input.value);
  if (isLegacyWantsStateRecord(input.kind, input.value)) return;
  let cleanValue = (input.kind === 'inner-affect-state'
    ? upgradeJunluoAffectState(input.value)
    : input.value) as JsonValue | null;
  if (!cleanValue) throw new Error('inner affect state 无法升级到 V2。');
  assertAssistantLifeStateRecord(input.kind, input.entityId, cleanValue);
  switch (input.entityType) {
    case 'assistant-state': {
      // Phone owns the runtime. Only the monotonic reply time crosses back;
      // a desktop projection can never recreate requests or refund quota.
      const { unifiedContact: _readOnlySummary, sleepSource: _retiredSoothingSource, ...assistant } = input.value as Record<string, JsonValue>;
      if (_readOnlySummary && typeof _readOnlySummary === 'object' && !Array.isArray(_readOnlySummary)) {
        await mergeSyncedOrdinaryContactReply(Number(_readOnlySummary.lastOrdinaryReplyAt));
      }
      if (assistant.cloudForm === undefined || assistant.textUpdatedAt === undefined) {
        const current = await readJson(ASSISTANT_LIFE_STATE_KEYS.assistantState, null) as Record<string, unknown> | null;
        if (assistant.cloudForm === undefined && (current?.cloudForm === 'white' || current?.cloudForm === 'black')) assistant.cloudForm = current.cloudForm;
        if (assistant.textUpdatedAt === undefined && current?.title === assistant.title
          && current?.activity === assistant.activity && typeof current?.textUpdatedAt === 'number') {
          assistant.textUpdatedAt = current.textUpdatedAt;
        }
      }
      await writeJson(ASSISTANT_LIFE_STATE_KEYS.assistantState, assistant);
      return;
    }
    case 'life-day': {
      const key = `${ASSISTANT_LIFE_STATE_KEYS.lifeDayPrefix}${input.entityId}`;
      const current = await readJson(key, null);
      if (current !== null) assertAssistantLifeStateRecord('life-day', input.entityId, current);
      const merged = current === null ? cleanValue : mergeLifeDayRuntimeProgress(
        current as Record<string, JsonValue>, cleanValue as Record<string, JsonValue>);
      assertAssistantLifeStateRecord('life-day', input.entityId, merged);
      await writeJson(key, merged);
      await updateLifeDayIndex(input.entityId, true);
      return;
    }
    case 'drive-state':
      if (input.kind === 'conversation-afterglow') {
        const current = await readJson(ASSISTANT_LIFE_STATE_KEYS.conversationAfterglow, null);
        if (current !== null) {
          assertAssistantLifeStateTransportRecord(input.kind, input.entityId, current);
          const merged = mergeConversationAfterglowRuntimeProgress(current as Record<string, JsonValue>, input.value as Record<string, JsonValue>);
          assertAssistantLifeStateRecord(input.kind, input.entityId, merged);
          await writeJson(ASSISTANT_LIFE_STATE_KEYS.conversationAfterglow, merged);
          return;
        }
      }
      await writeJson(driveStorageKey(input.entityId), input.value);
      return;
    case 'inner-state':
      if (input.kind === 'inner-thought-state') {
        const current = await readJson(JUNLUO_INNER_STATE_KEYS.thought, null);
        if (current !== null) {
          const retained = await (await import('../memory/lifeSelfMemoryRetention')).loadLifeSelfRetainedIds();
          cleanValue = retainMissingJunluoThoughtOriginals(current, cleanValue, retained.wish) as unknown as JsonValue;
          assertAssistantLifeStateRecord(input.kind, input.entityId, cleanValue);
        }
      }
      if (input.kind === 'inner-desire-state') {
        const current = await readJson(JUNLUO_INNER_STATE_KEYS.desire, null);
        if (current !== null) {
          assertAssistantLifeStateTransportRecord(input.kind, input.entityId, current);
          if (shouldKeepCurrentWantsState(current, cleanValue)) return;
        }
      }
      await writeJson(innerStorageKey(input.entityId), cleanValue);
  }
}

async function tombstone(
  input: Parameters<AssistantLifeStateBusinessPort['tombstone']>[0],
) {
  switch (input.entityType) {
    case 'assistant-state':
      await RawAsyncStorage.removeItem(ASSISTANT_LIFE_STATE_KEYS.assistantState);
      return;
    case 'life-day':
      await RawAsyncStorage.removeItem(
        `${ASSISTANT_LIFE_STATE_KEYS.lifeDayPrefix}${input.entityId}`,
      );
      await updateLifeDayIndex(input.entityId, false);
      return;
    case 'drive-state':
      await RawAsyncStorage.removeItem(driveStorageKey(input.entityId));
      return;
    case 'inner-state':
      await RawAsyncStorage.removeItem(innerStorageKey(input.entityId));
  }
}

export const assistantLifeStateAsyncStorageBusinessPort:
AssistantLifeStateBusinessPort = {
  upsertRecord: (input) => enqueueAssistantLifeStateApply(
    () => input.kind === 'inner-desire-state'
      ? runJunluoDesireWriteBoundary(() => upsertRecord(input)) : upsertRecord(input),
  ),
  tombstone: (input) => enqueueAssistantLifeStateApply(
    () => input.entityType === 'inner-state' && input.entityId === 'desire'
      ? runJunluoDesireWriteBoundary(() => tombstone(input)) : tombstone(input),
  ),
};
