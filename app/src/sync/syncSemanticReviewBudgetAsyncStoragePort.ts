import RawAsyncStorage from '@react-native-async-storage/async-storage';

import {
  DEFAULT_BAIYUN_REMOTE_REVIEW_DAILY_LIMIT,
  type BaiyunSemanticReviewEntry,
} from '../ai/behavior/actionBudget';
import type {
  SemanticReviewBudgetBusinessPort,
} from './syncSemanticReviewBudgetApply';
import {
  runSemanticReviewBudgetCaptureExclusive,
} from './syncSemanticReviewBudgetCaptureQueue';
import {
  SEMANTIC_REVIEW_BUDGET_STORAGE_KEY,
} from './syncSemanticReviewBudgetStorageDerivation';

function recordOf(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function counted(entry: Pick<BaiyunSemanticReviewEntry, 'outcome'>) {
  return entry.outcome === 'budget_blocked' ? 0 : 1;
}

async function upsertEntry(
  input: Parameters<
    SemanticReviewBudgetBusinessPort['upsertEntry']
  >[0],
) {
  const raw = await RawAsyncStorage.getItem(
    SEMANTIC_REVIEW_BUDGET_STORAGE_KEY,
  );
  let current = {} as Record<string, unknown>;
  if (raw) {
    try {
      current = recordOf(JSON.parse(raw) as unknown);
    } catch {
      current = {};
    }
  }
  if (
    typeof current.localDate === 'string'
    && current.localDate !== input.localDate
  ) {
    return;
  }
  const entries = Array.isArray(current.entries)
    ? [...current.entries]
    : [];
  const existingIndex = entries.findIndex((value) => (
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value as { id?: unknown }).id === input.globalEntryId
  ));
  const existing = existingIndex >= 0
    ? entries[existingIndex] as BaiyunSemanticReviewEntry
    : undefined;
  const materialized: BaiyunSemanticReviewEntry = {
    ...input.entry,
    id: input.globalEntryId,
    connectionId: input.remoteAccountId,
  };
  if (existingIndex >= 0) {
    entries[existingIndex] = materialized;
  } else {
    entries.push(materialized);
  }
  const previousCount = Number.isFinite(current.remoteAttemptsUsed)
    ? Math.max(0, Math.round(current.remoteAttemptsUsed as number))
    : 0;
  const countDelta = counted(materialized)
    - (existing ? counted(existing) : 0);
  const next = {
    ...current,
    localDate: input.localDate,
    remoteAttemptsUsed: Math.max(0, previousCount + countDelta),
    dailyLimit: Number.isFinite(current.dailyLimit)
      ? current.dailyLimit
      : DEFAULT_BAIYUN_REMOTE_REVIEW_DAILY_LIMIT,
    entries: entries.slice(-64),
  };
  await RawAsyncStorage.setItem(
    SEMANTIC_REVIEW_BUDGET_STORAGE_KEY,
    JSON.stringify(next),
  );
}

export const semanticReviewBudgetAsyncStorageBusinessPort:
SemanticReviewBudgetBusinessPort = {
  upsertEntry: (input) => runSemanticReviewBudgetCaptureExclusive(
    () => upsertEntry(input),
  ),
};
