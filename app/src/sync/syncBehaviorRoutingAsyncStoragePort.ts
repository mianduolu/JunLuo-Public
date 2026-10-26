import RawAsyncStorage from '@react-native-async-storage/async-storage';

import type { BehaviorRoutingBusinessPort } from './syncBehaviorRoutingApply';
import {
  assertBehaviorRoutingFieldValue,
  defaultBehaviorRoutingFieldValue,
  type BehaviorRoutingField,
  type BehaviorRoutingFieldValue,
} from './syncBehaviorRouting';
import {
  runBehaviorRoutingCaptureExclusive,
} from './syncBehaviorRoutingCaptureQueue';
import {
  BEHAVIOR_ROUTING_STORAGE_KEY,
} from './syncBehaviorRoutingStorageDerivation';

async function loadRawRecord() {
  const raw = await RawAsyncStorage.getItem(BEHAVIOR_ROUTING_STORAGE_KEY);
  if (!raw) return {} as Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? { ...(parsed as Record<string, unknown>) }
      : {};
  } catch {
    return {};
  }
}

async function writeField(
  field: BehaviorRoutingField,
  value: BehaviorRoutingFieldValue,
) {
  assertBehaviorRoutingFieldValue(field, value);
  const next = await loadRawRecord();
  if (
    (field === 'primaryConnectionId'
      || field === 'remoteFallbackConnectionId')
    && value === null
  ) {
    delete next[field];
  } else {
    next[field] = value;
  }
  await RawAsyncStorage.setItem(
    BEHAVIOR_ROUTING_STORAGE_KEY,
    JSON.stringify(next),
  );
}

async function resetField(field: BehaviorRoutingField) {
  await writeField(field, defaultBehaviorRoutingFieldValue(field));
}

export const behaviorRoutingAsyncStorageBusinessPort:
BehaviorRoutingBusinessPort = {
  upsertField: ({ field, value }) => runBehaviorRoutingCaptureExclusive(
    () => writeField(field, value),
  ),
  deleteField: ({ field }) => runBehaviorRoutingCaptureExclusive(
    () => resetField(field),
  ),
};
