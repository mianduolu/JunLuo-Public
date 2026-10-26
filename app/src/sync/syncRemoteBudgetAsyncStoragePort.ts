import RawAsyncStorage from '@react-native-async-storage/async-storage';

import {
  AI_CALL_BUDGET_KEY,
  isRemoteAiCallBudgetRecord,
  parseAiCallBudgetState,
  serializeAiCallBudgetState,
} from '../ai/aiCallBudgetStorage';
import {
  assertRemoteBudgetEventRecord,
  mergeRemoteBudgetEventMetadata,
  type RemoteBudgetEventRecord,
} from './syncRemoteBudget';
import type { RemoteBudgetBusinessPort } from './syncRemoteBudgetApply';
import {
  runRemoteBudgetCaptureExclusive,
} from './syncRemoteBudgetCaptureQueue';

export async function appendRemoteBudgetEvent(
  input: Parameters<RemoteBudgetBusinessPort['appendEvent']>[0],
) {
  assertRemoteBudgetEventRecord(input.entityId, input.value);
  const now = Date.now();
  const raw = await RawAsyncStorage.getItem(AI_CALL_BUDGET_KEY);
  const state = parseAiCallBudgetState(raw, now);
  const existing = state.records.find(
    (record) => record.id === input.entityId,
  );
  if (existing) {
    const merged = isRemoteAiCallBudgetRecord(existing) ? mergeRemoteBudgetEventMetadata(existing, input.value) : null;
    if (
      !merged
    ) {
      throw new Error(
        `remote budget event ${input.entityId} 与本地事件身份冲突。`,
      );
    }
    if (merged.purpose !== existing.purpose || merged.costRestricted !== existing.costRestricted || merged.endedAt !== existing.endedAt) {
      await RawAsyncStorage.setItem(AI_CALL_BUDGET_KEY, serializeAiCallBudgetState({ version: 2,
        records: state.records.map(record => record.id === existing.id ? { ...record, ...merged } : record) }, now));
    }
    return;
  }
  await RawAsyncStorage.setItem(
    AI_CALL_BUDGET_KEY,
    serializeAiCallBudgetState({
      records: [
        ...state.records,
        {
          ...input.value,
          scope: 'remote-account',
        },
      ],
      version: 2,
    }, now),
  );
}

export const remoteBudgetAsyncStorageBusinessPort:
RemoteBudgetBusinessPort = {
  appendEvent: (input) => runRemoteBudgetCaptureExclusive(
    () => appendRemoteBudgetEvent(input),
  ),
};
