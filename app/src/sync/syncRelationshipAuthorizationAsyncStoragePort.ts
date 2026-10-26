import RawAsyncStorage from '@react-native-async-storage/async-storage';

import type {
  RelationshipAuthorizationBusinessPort,
} from './syncRelationshipAuthorizationApply';
import {
  assertRelationshipAuthorizationEntityField,
  assertRelationshipAuthorizationFieldValue,
  type RelationshipAuthorizationEntityType,
  type RelationshipAuthorizationField,
  type RelationshipAuthorizationFieldValue,
  type RelationshipContactPauseValue,
} from './syncRelationshipAuthorization';
import {
  runRelationshipAuthorizationCaptureExclusive,
} from './syncRelationshipAuthorizationCaptureQueue';
import {
  RELATIONSHIP_AUTONOMY_SETTINGS_KEY,
  RELATIONSHIP_INTIMACY_SAFETY_SETTINGS_KEY,
  RELATIONSHIP_PROACTIVE_SETTINGS_KEY,
  RELATIONSHIP_SOCIAL_SETTINGS_KEY,
} from './syncRelationshipAuthorizationStorageDerivation';

function storageKeyForField(field: RelationshipAuthorizationField) {
  if (
    field === 'autonomousInteractionEnabled'
    || field === 'preferredPlatforms'
  ) {
    return RELATIONSHIP_SOCIAL_SETTINGS_KEY;
  }
  if (field === 'enabled' || field === 'firstPromptAnswered' || field === 'contactPause') {
    return RELATIONSHIP_PROACTIVE_SETTINGS_KEY;
  }
  if (field === 'safeWord') {
    return RELATIONSHIP_INTIMACY_SAFETY_SETTINGS_KEY;
  }
  return RELATIONSHIP_AUTONOMY_SETTINGS_KEY;
}

async function loadRawRecord(key: string) {
  const raw = await RawAsyncStorage.getItem(key);
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

function ensureAutonomyDefaults(record: Record<string, unknown>) {
  for (const field of [
    'desireDrivenBehaviorEnabled',
    'dreamSleepLoopEnabled',
    'githubVoyageEnabled',
    'masterEnabled',
    'publicPostingEnabled',
    'realtimeRhythmEnabled',
    'webVoyageEnabled',
  ]) {
    if (typeof record[field] !== 'boolean') record[field] = true;
  }
  if (typeof record.xiaohongshuEnabled !== 'boolean') {
    record.xiaohongshuEnabled = false;
  }
  record.schemaVersion = 2;
  if (typeof record.dailyPlanningEnabled !== 'boolean') record.dailyPlanningEnabled = false;
}

function ensureProactiveDefaults(record: Record<string, unknown>) {
  if (typeof record.enabled !== 'boolean') record.enabled = true;
  if (typeof record.firstPromptAnswered !== 'boolean') {
    record.firstPromptAnswered = true;
  }
  if (
    record.notificationPreview !== 'full'
    && record.notificationPreview !== 'private'
  ) {
    record.notificationPreview = 'private';
  }
}

function ensureSocialDefaults(record: Record<string, unknown>) {
  if (typeof record.autonomousInteractionEnabled !== 'boolean') {
    record.autonomousInteractionEnabled = true;
  }
  if (!Array.isArray(record.preferredPlatforms)) {
    record.preferredPlatforms = ['xiaohongshu'];
  }
}

async function writeField(input: {
  entityType: RelationshipAuthorizationEntityType;
  field: RelationshipAuthorizationField;
  value: RelationshipAuthorizationFieldValue;
}) {
  assertRelationshipAuthorizationEntityField(
    input.entityType,
    input.field,
  );
  assertRelationshipAuthorizationFieldValue(input.field, input.value);
  const key = storageKeyForField(input.field);
  const next = await loadRawRecord(key);
  if (input.field === 'dailyPlanningActivatedAt' && typeof next.dailyPlanningActivatedAt === 'number') {
    if (input.value === null || typeof input.value === 'number' && input.value >= next.dailyPlanningActivatedAt) return;
  }
  if (input.field === 'contactPause') {
    const group = input.value as RelationshipContactPauseValue;
    const currentAt = Number(next.contactPauseSourceAt ?? 0);
    if (group.sourceAt < currentAt || group.sourceAt === currentAt
      && next.contactPauseSourceKind === 'explicit' && group.sourceKind !== 'explicit') return;
    Object.assign(next, { contactPause: group.pause, contactPauseSourceAt: group.sourceAt,
      contactPauseSourceMessageId: group.sourceMessageId, contactPauseSourceKind: group.sourceKind });
    await RawAsyncStorage.setItem(key, JSON.stringify(next));
    return;
  }
  if (key === RELATIONSHIP_AUTONOMY_SETTINGS_KEY) {
    ensureAutonomyDefaults(next);
  } else if (key === RELATIONSHIP_PROACTIVE_SETTINGS_KEY) {
    ensureProactiveDefaults(next);
  } else if (key === RELATIONSHIP_SOCIAL_SETTINGS_KEY) {
    ensureSocialDefaults(next);
  }
  next[input.field] = Array.isArray(input.value)
    ? [...input.value]
    : input.value;
  await RawAsyncStorage.setItem(key, JSON.stringify(next));
}

export const relationshipAuthorizationAsyncStorageBusinessPort:
RelationshipAuthorizationBusinessPort = {
  upsertField: (input) => runRelationshipAuthorizationCaptureExclusive(
    () => writeField(input),
  ),
};
