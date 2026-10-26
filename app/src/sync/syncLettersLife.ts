import type { ChatCoreMutationEnvelope } from './syncChatCore';
import {
  assertJsonValue,
  assertPlainMutationV1,
  type JsonValue,
  type PlainMutationV1,
} from './syncProtocol';

export const LETTERS_LIFE_ADAPTER_ID = 'letters.life' as const;
export const LETTERS_LIFE_SCHEMA_VERSION = 2 as const;
export const LETTERS_LIFE_ACCEPTED_SCHEMA_VERSIONS = Object.freeze([1, 2] as const);
export const LETTERS_LIFE_RETENTION_CLASS =
  'relationship-history' as const;
export const LETTERS_LIFE_SETTINGS_ENTITY_ID = 'default' as const;

export const LETTER_KINDS = Object.freeze([
  'exchange',
  'future-you',
] as const);
export const LETTER_DIRECTIONS = Object.freeze([
  'you-to-I',
  'I-to-you',
  'I-to-future-you',
] as const);
export const LETTER_STATUSES = Object.freeze([
  'waiting_I',
  'waiting_you',
  'sealed',
  'ready_to_open',
  'completed',
  'failed',
] as const);
export const LETTER_SOURCES = Object.freeze([
  'you',
  'life-project',
  'memory',
  'schedule',
  'relationship-date',
  'future-you',
] as const);

export type LettersLifeEntityType =
  | 'letter'
  | 'letter-settings'
  | 'delivery-state'
  | 'relationship-date';
export type LettersLifeRecordKind =
  | 'letter'
  | 'letter-settings'
  | 'delivery-state'
  | 'relationship-date';
export type LetterKind = typeof LETTER_KINDS[number];
export type LetterDirection = typeof LETTER_DIRECTIONS[number];
export type LetterStatus = typeof LETTER_STATUSES[number];
export type LetterSource = typeof LETTER_SOURCES[number];

export type LettersLifeLetterRecord = {
  id: string;
  kind: LetterKind;
  direction: LetterDirection;
  title: string;
  content: string;
  replyContent?: string;
  createdAt: number;
  source?: LetterSource;
  chatMessageIds?: string[];
  memoryIds?: string[];
  generationKey?: string;
  sourceIds?: string[];
  openWhen?: {
    kind: 'date_ticket';
    dateId: string;
  } | {
    kind: 'after_days';
    days: number;
  };
  dateTicketId?: string;
};

export type LettersLifeDeliveryStateRecord = {
  letterId: string;
  status: LetterStatus;
  dueAt?: number;
  deliveredAt?: number;
  openedAt?: number;
  completedAt?: number;
};

export type LettersLifeSettingsRecord = {
  settingsId: typeof LETTERS_LIFE_SETTINGS_ENTITY_ID;
  defaultReplyDelayHours: number;
  lastProactiveRequestAt?: number;
  lastProactiveSavedAt?: number;
  offeredDateTicketIds?: string[];
  settledSourceIds?: string[];
  recentGenerationKeys?: string[];
};

export type LettersLifeRelationshipDateRecord = {
  schemaVersion: 1;
  id: string;
  title: string;
  note?: string;
  mode: 'solar_yearly' | 'lunar_yearly' | 'once';
  originDateKey: string;
  lunarMonth?: number;
  lunarDay?: number;
  lunarIsLeapMonth?: boolean;
  openTimeMinutes: number;
  letterEnabled: boolean;
  createdAt: number;
  updatedAt: number;
};

function recordOf(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象。`);
  }
  return value as Record<string, unknown>;
}

function assertKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
) {
  const allowed = new Set([...required, ...optional]);
  const extra = Object.keys(value).filter((key) => !allowed.has(key));
  const missing = required.filter((key) => !(key in value));
  if (extra.length || missing.length) {
    throw new Error(`${label} 字段集合无效。`);
  }
}

function assertString(
  value: unknown,
  label: string,
  maximumLength: number,
  allowEmpty = false,
) {
  if (
    typeof value !== 'string'
    || (!allowEmpty && value.length < 1)
    || value.length > maximumLength
  ) {
    throw new Error(`${label} 字符串长度无效。`);
  }
}

function assertOptionalString(
  value: unknown,
  label: string,
  maximumLength: number,
) {
  if (value !== undefined) {
    assertString(value, label, maximumLength, true);
  }
}

function assertTimestamp(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} 必须是非负 Unix 毫秒整数。`);
  }
}

function assertOptionalTimestamp(value: unknown, label: string) {
  if (value !== undefined) assertTimestamp(value, label);
}

function assertEnum(
  value: unknown,
  allowed: readonly string[],
  label: string,
) {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new Error(`${label} 无效。`);
  }
}

function assertStringArray(
  value: unknown,
  label: string,
) {
  if (value === undefined) return;
  if (
    !Array.isArray(value)
    || value.length > 2048
    || value.some((item) => (
      typeof item !== 'string'
      || item.length < 1
      || item.length > 200
    ))
    || new Set(value).size !== value.length
  ) {
    throw new Error(`${label} 无效。`);
  }
}

function assertLetterRecord(
  entityId: string,
  value: Record<string, unknown>,
) {
  assertKeys(
    value,
    ['id', 'kind', 'direction', 'title', 'content', 'createdAt'],
    [
      'replyContent',
      'source',
      'chatMessageIds',
      'memoryIds',
      'generationKey',
      'sourceIds',
      'openWhen',
      'dateTicketId',
    ],
    'letters.life letter',
  );
  assertString(value.id, 'letter id', 200);
  if (value.id !== entityId) {
    throw new Error('letter record id 与 entity id 不一致。');
  }
  assertEnum(value.kind, LETTER_KINDS, 'letter kind');
  assertEnum(value.direction, LETTER_DIRECTIONS, 'letter direction');
  if (
    (value.kind === 'future-you'
      && value.direction !== 'I-to-future-you')
    || (
      value.kind === 'exchange'
      && value.direction === 'I-to-future-you'
    )
  ) {
    throw new Error('letter kind 与 direction 不一致。');
  }
  assertString(value.title, 'letter title', 240, true);
  assertString(value.content, 'letter content', 262144, true);
  assertOptionalString(
    value.replyContent,
    'letter replyContent',
    262144,
  );
  assertTimestamp(value.createdAt, 'letter createdAt');
  if (value.source !== undefined) {
    assertEnum(value.source, LETTER_SOURCES, 'letter source');
  }
  assertStringArray(value.chatMessageIds, 'letter chatMessageIds');
  assertStringArray(value.memoryIds, 'letter memoryIds');
  assertOptionalString(value.generationKey, 'letter generationKey', 200);
  assertStringArray(value.sourceIds, 'letter sourceIds');
  assertOptionalString(value.dateTicketId, 'letter dateTicketId', 200);
  if (value.openWhen !== undefined) {
    const openWhen = recordOf(value.openWhen, 'letter openWhen');
    if (openWhen.kind === 'date_ticket') {
      assertKeys(openWhen, ['kind', 'dateId'], [], 'letter date_ticket openWhen');
      assertString(openWhen.dateId, 'letter openWhen dateId', 200);
    } else if (openWhen.kind === 'after_days') {
      assertKeys(openWhen, ['kind', 'days'], [], 'letter after_days openWhen');
      if (!Number.isInteger(openWhen.days) || Number(openWhen.days) < 1 || Number(openWhen.days) > 90) {
        throw new Error('letter openWhen days 必须是 1–90 的整数。');
      }
    } else {
      throw new Error('letter openWhen kind 无效。');
    }
  }
}

function assertDeliveryStateRecord(
  entityId: string,
  value: Record<string, unknown>,
) {
  assertKeys(
    value,
    ['letterId', 'status'],
    [
      'dueAt',
      'deliveredAt',
      'openedAt',
      'completedAt',
    ],
    'letters.life delivery state',
  );
  assertString(value.letterId, 'delivery letterId', 200);
  if (value.letterId !== entityId) {
    throw new Error('delivery-state letterId 与 entity id 不一致。');
  }
  assertEnum(value.status, LETTER_STATUSES, 'letter status');
  assertOptionalTimestamp(value.dueAt, 'letter dueAt');
  assertOptionalTimestamp(value.deliveredAt, 'letter deliveredAt');
  assertOptionalTimestamp(value.openedAt, 'letter openedAt');
  assertOptionalTimestamp(value.completedAt, 'letter completedAt');
}

function assertSettingsRecord(
  entityId: string,
  value: Record<string, unknown>,
) {
  assertKeys(
    value,
    ['settingsId', 'defaultReplyDelayHours'],
    [
      'lastProactiveRequestAt',
      'lastProactiveSavedAt',
      'offeredDateTicketIds',
      'settledSourceIds',
      'recentGenerationKeys',
    ],
    'letters.life settings',
  );
  if (
    entityId !== LETTERS_LIFE_SETTINGS_ENTITY_ID
    || value.settingsId !== LETTERS_LIFE_SETTINGS_ENTITY_ID
  ) {
    throw new Error('letter-settings identity 无效。');
  }
  if (
    !Number.isInteger(value.defaultReplyDelayHours)
    || Number(value.defaultReplyDelayHours) < 3
    || Number(value.defaultReplyDelayHours) > 8
  ) {
    throw new Error('defaultReplyDelayHours 必须是 3–8 的整数。');
  }
  assertOptionalTimestamp(value.lastProactiveRequestAt, 'letter lastProactiveRequestAt');
  assertOptionalTimestamp(value.lastProactiveSavedAt, 'letter lastProactiveSavedAt');
  assertStringArray(value.offeredDateTicketIds, 'letter offeredDateTicketIds');
  assertStringArray(value.settledSourceIds, 'letter settledSourceIds');
  assertStringArray(value.recentGenerationKeys, 'letter recentGenerationKeys');
}

function assertRelationshipDateRecord(
  entityId: string,
  value: Record<string, unknown>,
) {
  assertKeys(
    value,
    [
      'schemaVersion',
      'id',
      'title',
      'mode',
      'originDateKey',
      'openTimeMinutes',
      'letterEnabled',
      'createdAt',
      'updatedAt',
    ],
    ['note', 'lunarMonth', 'lunarDay', 'lunarIsLeapMonth'],
    'letters.life relationship-date',
  );
  if (value.schemaVersion !== 1 || value.id !== entityId) {
    throw new Error('relationship-date identity 无效。');
  }
  assertString(value.id, 'relationship-date id', 200);
  assertString(value.title, 'relationship-date title', 80);
  assertOptionalString(value.note, 'relationship-date note', 1000);
  assertEnum(value.mode, ['solar_yearly', 'lunar_yearly', 'once'], 'relationship-date mode');
  if (typeof value.originDateKey !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.originDateKey)) {
    throw new Error('relationship-date originDateKey 无效。');
  }
  if (!Number.isInteger(value.openTimeMinutes) || Number(value.openTimeMinutes) < 0 || Number(value.openTimeMinutes) > 1439) {
    throw new Error('relationship-date openTimeMinutes 无效。');
  }
  if (typeof value.letterEnabled !== 'boolean') throw new Error('relationship-date letterEnabled 无效。');
  assertTimestamp(value.createdAt, 'relationship-date createdAt');
  assertTimestamp(value.updatedAt, 'relationship-date updatedAt');
  if (value.mode === 'lunar_yearly') {
    if (
      !Number.isInteger(value.lunarMonth)
      || Number(value.lunarMonth) < 1
      || Number(value.lunarMonth) > 12
      || !Number.isInteger(value.lunarDay)
      || Number(value.lunarDay) < 1
      || Number(value.lunarDay) > 30
      || typeof value.lunarIsLeapMonth !== 'boolean'
    ) throw new Error('relationship-date 农历字段无效。');
  }
}

function kindMatchesEntity(
  entityType: string,
  kind: LettersLifeRecordKind,
) {
  return entityType === kind;
}

export function assertLettersLifeRecord(
  kind: LettersLifeRecordKind,
  entityId: string,
  value: unknown,
) {
  const record = recordOf(value, `letters.life ${kind}`);
  assertJsonValue(record);
  switch (kind) {
    case 'letter':
      assertLetterRecord(entityId, record);
      return;
    case 'delivery-state':
      assertDeliveryStateRecord(entityId, record);
      return;
    case 'letter-settings':
      assertSettingsRecord(entityId, record);
      return;
    case 'relationship-date':
      assertRelationshipDateRecord(entityId, record);
  }
}

export function assertLettersLifeMutationV1(
  value: unknown,
): asserts value is PlainMutationV1 {
  assertPlainMutationV1(value);
  if (
    value.entity.domain !== 'letters'
    || ![
      'letter',
      'letter-settings',
      'delivery-state',
      'relationship-date',
    ].includes(value.entity.type)
  ) {
    throw new Error('letters.life mutation entity 无效。');
  }
  if (!LETTERS_LIFE_ACCEPTED_SCHEMA_VERSIONS.includes(value.revision.schemaVersion as 1 | 2)) {
    throw new Error('letters.life schemaVersion 无效。');
  }
  if (value.sensitivity !== 'high') {
    throw new Error('letters.life sensitivity 必须为 high。');
  }
  if (value.retentionClass !== LETTERS_LIFE_RETENTION_CLASS) {
    throw new Error('letters.life retentionClass 无效。');
  }
  if (value.objectRefs.length) {
    throw new Error('letters.life 不接受对象引用。');
  }
  const payload = recordOf(value.payload, 'letters.life payload');
  if (value.revision.operation === 'delete') {
    assertKeys(
      payload,
      ['schemaVersion', 'deletedAt'],
      [],
      'letters.life delete',
    );
    if (payload.schemaVersion !== value.revision.schemaVersion) {
      throw new Error('letters.life delete schemaVersion 无效。');
    }
    assertTimestamp(payload.deletedAt, 'letters.life deletedAt');
    return;
  }
  if (
    value.revision.operation !== 'upsert'
    && value.revision.operation !== 'restore'
  ) {
    throw new Error(
      'letters.life 只允许 upsert、restore 或 delete。',
    );
  }
  assertKeys(
    payload,
    ['schemaVersion', 'kind', 'value'],
    [],
    'letters.life record',
  );
  if (payload.schemaVersion !== value.revision.schemaVersion) {
    throw new Error('letters.life record schemaVersion 无效。');
  }
  const kind = payload.kind as LettersLifeRecordKind;
  if (
    !['letter', 'letter-settings', 'delivery-state', 'relationship-date'].includes(kind)
    || !kindMatchesEntity(value.entity.type, kind)
  ) {
    throw new Error('letters.life kind 与 entity type 不匹配。');
  }
  if (kind === 'relationship-date' && value.revision.schemaVersion !== 2) {
    throw new Error('relationship-date 只允许 letters.life V2。');
  }
  assertLettersLifeRecord(kind, value.entity.id, payload.value);
}

export function buildLettersLifeRecordMutation(input: {
  envelope: ChatCoreMutationEnvelope;
  entityType: LettersLifeEntityType;
  entityId: string;
  kind: LettersLifeRecordKind;
  value: JsonValue;
  operation?: 'upsert' | 'restore';
}) {
  const mutation: PlainMutationV1 = {
    protocolVersion: 1,
    mutationId: input.envelope.mutationId,
    vaultId: input.envelope.vaultId,
    sourceDeviceId: input.envelope.sourceDeviceId,
    sourceSequence: input.envelope.sourceSequence,
    createdAt: input.envelope.createdAt,
    entity: {
      domain: 'letters',
      type: input.entityType,
      id: input.entityId,
    },
    revision: {
      id: input.envelope.revisionId,
      parents: input.envelope.parentRevisionIds,
      operation: input.operation ?? 'upsert',
      schemaVersion: LETTERS_LIFE_SCHEMA_VERSION,
    },
    sensitivity: 'high',
    payload: {
      schemaVersion: LETTERS_LIFE_SCHEMA_VERSION,
      kind: input.kind,
      value: input.value,
    },
    objectRefs: [],
    retentionClass: LETTERS_LIFE_RETENTION_CLASS,
  };
  assertLettersLifeMutationV1(mutation);
  return mutation;
}

export function buildLettersLifeDeleteMutation(input: {
  envelope: ChatCoreMutationEnvelope;
  entityType: LettersLifeEntityType;
  entityId: string;
  deletedAt: number;
}) {
  const mutation: PlainMutationV1 = {
    protocolVersion: 1,
    mutationId: input.envelope.mutationId,
    vaultId: input.envelope.vaultId,
    sourceDeviceId: input.envelope.sourceDeviceId,
    sourceSequence: input.envelope.sourceSequence,
    createdAt: input.envelope.createdAt,
    entity: {
      domain: 'letters',
      type: input.entityType,
      id: input.entityId,
    },
    revision: {
      id: input.envelope.revisionId,
      parents: input.envelope.parentRevisionIds,
      operation: 'delete',
      schemaVersion: LETTERS_LIFE_SCHEMA_VERSION,
    },
    sensitivity: 'high',
    payload: {
      schemaVersion: LETTERS_LIFE_SCHEMA_VERSION,
      deletedAt: input.deletedAt,
    },
    objectRefs: [],
    retentionClass: LETTERS_LIFE_RETENTION_CLASS,
  };
  assertLettersLifeMutationV1(mutation);
  return mutation;
}
