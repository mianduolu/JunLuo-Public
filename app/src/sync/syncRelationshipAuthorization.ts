import type { ChatCoreMutationEnvelope } from './syncChatCore';
import {
  assertJsonValue,
  assertPlainMutationV1,
  type JsonValue,
  type PlainMutationV1,
} from './syncProtocol';

export const RELATIONSHIP_AUTHORIZATION_ADAPTER_ID =
  'relationship.authorization' as const;
export const RELATIONSHIP_AUTHORIZATION_SCHEMA_VERSION = 1 as const;
export const RELATIONSHIP_AUTHORIZATION_RETENTION_CLASS =
  'relationship-authorization' as const;
export const RELATIONSHIP_AUTHORIZATION_RECORD_KIND =
  'relationship-authorization-field' as const;

export const RELATIONSHIP_AUTONOMY_FIELDS = Object.freeze([
  'dailyPlanningEnabled',
  'dailyPlanningActivatedAt',
  'desireDrivenBehaviorEnabled',
  'dreamSleepLoopEnabled',
  'githubVoyageEnabled',
  'masterEnabled',
  'publicPostingEnabled',
  'realtimeRhythmEnabled',
  'webVoyageEnabled',
  'xiaohongshuEnabled',
  'autonomousInteractionEnabled',
  'preferredPlatforms',
] as const);

export const RELATIONSHIP_PROACTIVE_FIELDS = Object.freeze([
  'enabled',
  'firstPromptAnswered',
  'contactPause',
] as const);

export const RELATIONSHIP_SAFETY_FIELDS = Object.freeze([
  'safeWord',
] as const);

export const RELATIONSHIP_AUTHORIZATION_ENTITY_TYPES = Object.freeze([
  'autonomy-policy',
  'safety-boundary',
  'proactive-policy',
] as const);

export type RelationshipAuthorizationEntityType =
  typeof RELATIONSHIP_AUTHORIZATION_ENTITY_TYPES[number];
export type RelationshipAutonomyField =
  typeof RELATIONSHIP_AUTONOMY_FIELDS[number];
export type RelationshipProactiveField =
  typeof RELATIONSHIP_PROACTIVE_FIELDS[number];
export type RelationshipSafetyField =
  typeof RELATIONSHIP_SAFETY_FIELDS[number];
export type RelationshipAuthorizationField =
  | RelationshipAutonomyField
  | RelationshipProactiveField
  | RelationshipSafetyField;
export type RelationshipAuthorizationFieldValue =
  | number
  | null
  | boolean
  | string
  | string[]
  | RelationshipContactPauseValue;

export type RelationshipContactPauseValue = {
  pause: { sourceMessageId: string; sourceAt: number; until: number | null } | null;
  sourceMessageId: string;
  sourceAt: number;
  sourceKind: 'auto' | 'explicit' | null;
};

const ENTITY_TYPES = new Set<string>(
  RELATIONSHIP_AUTHORIZATION_ENTITY_TYPES,
);
const AUTONOMY_FIELDS = new Set<string>(RELATIONSHIP_AUTONOMY_FIELDS);
const PROACTIVE_FIELDS = new Set<string>(RELATIONSHIP_PROACTIVE_FIELDS);
const SAFETY_FIELDS = new Set<string>(RELATIONSHIP_SAFETY_FIELDS);
const SOCIAL_PLATFORMS = new Set(['weibo', 'xiaohongshu', 'junluo']);

function recordOf(value: unknown, label: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象。`);
  }
  return value as Record<string, unknown>;
}

function assertKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  label: string,
) {
  const allowed = new Set(required);
  const extra = Object.keys(value).filter((key) => !allowed.has(key));
  const missing = required.filter((key) => !(key in value));
  if (extra.length || missing.length) {
    throw new Error(`${label} 字段集合无效。`);
  }
}

export function isRelationshipAuthorizationEntityType(
  value: unknown,
): value is RelationshipAuthorizationEntityType {
  return typeof value === 'string' && ENTITY_TYPES.has(value);
}

export function isRelationshipAuthorizationField(
  value: unknown,
): value is RelationshipAuthorizationField {
  return typeof value === 'string'
    && (
      AUTONOMY_FIELDS.has(value)
      || PROACTIVE_FIELDS.has(value)
      || SAFETY_FIELDS.has(value)
    );
}

export function relationshipAuthorizationEntityTypeForField(
  field: RelationshipAuthorizationField,
): RelationshipAuthorizationEntityType {
  if (AUTONOMY_FIELDS.has(field)) return 'autonomy-policy';
  if (PROACTIVE_FIELDS.has(field)) return 'proactive-policy';
  return 'safety-boundary';
}

export function assertRelationshipAuthorizationEntityField(
  entityType: RelationshipAuthorizationEntityType,
  field: RelationshipAuthorizationField,
) {
  if (relationshipAuthorizationEntityTypeForField(field) !== entityType) {
    throw new Error(
      'relationship.authorization entity type 与 field 不一致。',
    );
  }
}

export function assertRelationshipAuthorizationFieldValue(
  field: RelationshipAuthorizationField,
  value: unknown,
): asserts value is RelationshipAuthorizationFieldValue {
  if (field === 'dailyPlanningActivatedAt') {
    if (value !== null && (!Number.isSafeInteger(value) || Number(value) < 0)) throw new Error('dailyPlanningActivatedAt 无效。');
    return;
  }
  if (field === 'contactPause') {
    const group = recordOf(value, 'contactPause');
    assertKeys(group, ['pause', 'sourceMessageId', 'sourceAt', 'sourceKind'], 'contactPause');
    if (typeof group.sourceMessageId !== 'string' || group.sourceMessageId !== group.sourceMessageId.trim()
      || !Number.isSafeInteger(group.sourceAt) || Number(group.sourceAt) < 0
      || ![null, 'auto', 'explicit'].includes(group.sourceKind as null | string)) throw new Error('contactPause source 无效。');
    if (group.pause === null) return;
    const pause = recordOf(group.pause, 'contactPause.pause');
    assertKeys(pause, ['sourceMessageId', 'sourceAt', 'until'], 'contactPause.pause');
    if (typeof pause.sourceMessageId !== 'string' || !pause.sourceMessageId.trim()
      || pause.sourceMessageId !== pause.sourceMessageId.trim()
      || !Number.isSafeInteger(pause.sourceAt) || Number(pause.sourceAt) < 0
      || Number(pause.sourceAt) > Number(group.sourceAt)
      || pause.until !== null && (!Number.isSafeInteger(pause.until) || Number(pause.until) < 0)) {
      throw new Error('contactPause 无效。');
    }
    return;
  }
  if (field === 'safeWord') {
    if (
      typeof value !== 'string'
      || Array.from(value).length > 24
      || value !== value.trim()
    ) {
      throw new Error('safeWord mutation value 无效。');
    }
    return;
  }
  if (field === 'preferredPlatforms') {
    if (
      !Array.isArray(value)
      || value.length > 3
      || value.some((entry) => (
        typeof entry !== 'string' || !SOCIAL_PLATFORMS.has(entry)
      ))
      || new Set(value).size !== value.length
    ) {
      throw new Error('preferredPlatforms mutation value 无效。');
    }
    return;
  }
  if (typeof value !== 'boolean') {
    throw new Error(`${field} mutation value 必须是 boolean。`);
  }
}

export function defaultRelationshipAuthorizationFieldValue(
  field: RelationshipAuthorizationField,
): RelationshipAuthorizationFieldValue {
  if (field === 'dailyPlanningEnabled') return false;
  if (field === 'dailyPlanningActivatedAt') return null;
  if (field === 'contactPause') return { pause: null, sourceMessageId: '', sourceAt: 0, sourceKind: null };
  if (field === 'safeWord') return '';
  if (field === 'preferredPlatforms') return ['xiaohongshu'];
  if (field === 'xiaohongshuEnabled') return false;
  return true;
}

export function assertRelationshipAuthorizationMutationV1(
  value: unknown,
): asserts value is PlainMutationV1 {
  assertPlainMutationV1(value);
  if (
    value.entity.domain !== 'relationship'
    || !isRelationshipAuthorizationEntityType(value.entity.type)
    || !isRelationshipAuthorizationField(value.entity.id)
  ) {
    throw new Error('relationship.authorization mutation entity 无效。');
  }
  assertRelationshipAuthorizationEntityField(
    value.entity.type,
    value.entity.id,
  );
  if (
    value.revision.schemaVersion
    !== RELATIONSHIP_AUTHORIZATION_SCHEMA_VERSION
  ) {
    throw new Error('relationship.authorization schemaVersion 无效。');
  }
  if (
    value.revision.operation !== 'upsert'
    && value.revision.operation !== 'restore'
  ) {
    throw new Error(
      'relationship.authorization 只接受 upsert 或 restore 状态迁移。',
    );
  }
  if (value.sensitivity !== 'highest') {
    throw new Error(
      'relationship.authorization sensitivity 必须为 highest。',
    );
  }
  if (
    value.retentionClass
    !== RELATIONSHIP_AUTHORIZATION_RETENTION_CLASS
  ) {
    throw new Error('relationship.authorization retentionClass 无效。');
  }
  if (value.objectRefs.length) {
    throw new Error('relationship.authorization 不接受对象引用。');
  }
  const payload = recordOf(
    value.payload,
    'relationship.authorization payload',
  );
  assertKeys(
    payload,
    ['schemaVersion', 'kind', 'field', 'value'],
    'relationship.authorization payload',
  );
  if (
    payload.schemaVersion
    !== RELATIONSHIP_AUTHORIZATION_SCHEMA_VERSION
    || payload.kind !== RELATIONSHIP_AUTHORIZATION_RECORD_KIND
    || payload.field !== value.entity.id
  ) {
    throw new Error('relationship.authorization payload identity 无效。');
  }
  assertRelationshipAuthorizationFieldValue(
    value.entity.id,
    payload.value,
  );
  assertJsonValue(payload);
}

export function relationshipAuthorizationMutationValue(
  mutation: PlainMutationV1,
) {
  assertRelationshipAuthorizationMutationV1(mutation);
  const payload = mutation.payload as {
    value: RelationshipAuthorizationFieldValue;
  };
  return payload.value;
}

export function buildRelationshipAuthorizationMutation(input: {
  envelope: ChatCoreMutationEnvelope;
  entityType: RelationshipAuthorizationEntityType;
  field: RelationshipAuthorizationField;
  value: RelationshipAuthorizationFieldValue;
  operation?: 'upsert' | 'restore';
}) {
  assertRelationshipAuthorizationEntityField(
    input.entityType,
    input.field,
  );
  assertRelationshipAuthorizationFieldValue(input.field, input.value);
  const mutation: PlainMutationV1 = {
    protocolVersion: 1,
    mutationId: input.envelope.mutationId,
    vaultId: input.envelope.vaultId,
    sourceDeviceId: input.envelope.sourceDeviceId,
    sourceSequence: input.envelope.sourceSequence,
    createdAt: input.envelope.createdAt,
    entity: {
      domain: 'relationship',
      type: input.entityType,
      id: input.field,
    },
    revision: {
      id: input.envelope.revisionId,
      parents: input.envelope.parentRevisionIds,
      operation: input.operation ?? 'upsert',
      schemaVersion: RELATIONSHIP_AUTHORIZATION_SCHEMA_VERSION,
    },
    sensitivity: 'highest',
    payload: {
      schemaVersion: RELATIONSHIP_AUTHORIZATION_SCHEMA_VERSION,
      kind: RELATIONSHIP_AUTHORIZATION_RECORD_KIND,
      field: input.field,
      value: input.value,
    },
    objectRefs: [],
    retentionClass: RELATIONSHIP_AUTHORIZATION_RETENTION_CLASS,
  };
  assertRelationshipAuthorizationMutationV1(mutation);
  return mutation;
}
