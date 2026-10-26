import type { ChatCoreMutationEnvelope } from './syncChatCore';
import {
  assertLettersLifeRecord,
  buildLettersLifeDeleteMutation,
  buildLettersLifeRecordMutation,
  LETTERS_LIFE_SETTINGS_ENTITY_ID,
  type LettersLifeDeliveryStateRecord,
  type LettersLifeEntityType,
  type LettersLifeLetterRecord,
  type LettersLifeRelationshipDateRecord,
  type LettersLifeSettingsRecord,
} from './syncLettersLife';
import {
  assertJsonValue,
  type JsonValue,
  type PlainMutationV1,
} from './syncProtocol';

export const LETTERS_LIFE_ENTRIES_KEY =
  'junluo.letters.entries' as const;
export const LETTERS_LIFE_SETTINGS_KEY =
  'junluo.letters.settings' as const;
export const LETTERS_LIFE_RELATIONSHIP_DATES_KEY =
  'junluo.relationshipDates.v1' as const;
export const LETTERS_LIFE_GLOBAL_KEYS = Object.freeze([
  LETTERS_LIFE_ENTRIES_KEY,
  LETTERS_LIFE_SETTINGS_KEY,
  LETTERS_LIFE_RELATIONSHIP_DATES_KEY,
] as const);

export type LettersLifeStorageChange =
  | { kind: 'set'; key: string; value: string }
  | { kind: 'remove'; key: string };

export type LettersLifeStorageReadPort = {
  getItem(key: string): Promise<string | null>;
};

export type LettersLifeEnvelopeFactory = (
  entity: {
    domain: 'letters';
    type: LettersLifeEntityType;
    id: string;
  },
) => Promise<ChatCoreMutationEnvelope>;

export type LettersLifeStorageKind = 'exchange' | 'future-self';
export type LettersLifeStorageDirection =
  | 'you-to-ai'
  | 'ai-to-you'
  | 'ai-to-future-you';
export type LettersLifeStorageStatus =
  | 'waiting_ai'
  | 'waiting_user'
  | 'sealed'
  | 'ready_to_open'
  | 'completed'
  | 'failed';
export type LettersLifeStorageSource =
  | 'user'
  | 'life-project'
  | 'memory'
  | 'schedule'
  | 'relationship-date'
  | 'future-self';

export type LettersLifeEntryStorage = {
  id: string;
  kind: LettersLifeStorageKind;
  direction: LettersLifeStorageDirection;
  status: LettersLifeStorageStatus;
  title: string;
  content: string;
  replyContent?: string;
  createdAt: number;
  dueAt?: number;
  deliveredAt?: number;
  openedAt?: number;
  completedAt?: number;
  notificationId?: string;
  source?: LettersLifeStorageSource;
  chatMessageIds?: string[];
  memoryIds?: string[];
  failureReason?: string;
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

export type LettersLifeSettingsStorage = {
  defaultReplyDelayHours: number;
  lastProactiveRequestAt?: number;
  lastProactiveSavedAt?: number;
  offeredDateTicketIds?: string[];
  settledSourceIds?: string[];
  recentGenerationKeys?: string[];
};

export type LettersLifeRelationshipDateStorage = LettersLifeRelationshipDateRecord;

const STORAGE_KINDS = Object.freeze([
  'exchange',
  'future-self',
] as const);
const STORAGE_DIRECTIONS = Object.freeze([
  'you-to-ai',
  'ai-to-you',
  'ai-to-future-you',
] as const);
const STORAGE_STATUSES = Object.freeze([
  'waiting_ai',
  'waiting_user',
  'sealed',
  'ready_to_open',
  'completed',
  'failed',
] as const);
const STORAGE_SOURCES = Object.freeze([
  'user',
  'life-project',
  'memory',
  'schedule',
  'relationship-date',
  'future-self',
] as const);

const ENTRY_FIELDS = new Set([
  'id',
  'kind',
  'direction',
  'status',
  'title',
  'content',
  'replyContent',
  'createdAt',
  'dueAt',
  'deliveredAt',
  'openedAt',
  'completedAt',
  'notificationId',
  'source',
  'chatMessageIds',
  'memoryIds',
  'failureReason',
  'generationKey',
  'sourceIds',
  'openWhen',
  'dateTicketId',
]);
const SETTINGS_FIELDS = new Set([
  'defaultReplyDelayHours',
  'lastProactiveRequestAt',
  'lastProactiveSavedAt',
  'offeredDateTicketIds',
  'settledSourceIds',
  'recentGenerationKeys',
]);
const RELATIONSHIP_DATE_FIELDS = new Set([
  'schemaVersion',
  'id',
  'title',
  'note',
  'mode',
  'originDateKey',
  'lunarMonth',
  'lunarDay',
  'lunarIsLeapMonth',
  'openTimeMinutes',
  'letterEnabled',
  'createdAt',
  'updatedAt',
]);

function recordOf(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象。`);
  }
  return value as Record<string, unknown>;
}

function parseJson(raw: string, label: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${label} 不是有效 JSON。`);
  }
  assertJsonValue(parsed);
  return parsed;
}

function assertNoExtraFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
) {
  const extra = Object.keys(value).filter((key) => !allowed.has(key));
  if (extra.length) {
    throw new Error(
      `${label} 包含未允许字段：${extra.sort().join(', ')}。`,
    );
  }
}

function requiredString(
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
  return value;
}

function optionalString(
  value: unknown,
  label: string,
  maximumLength: number,
) {
  if (value === undefined) return undefined;
  return requiredString(value, label, maximumLength, true);
}

function requiredTimestamp(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} 必须是非负 Unix 毫秒整数。`);
  }
  return Number(value);
}

function optionalTimestamp(value: unknown, label: string) {
  return value === undefined
    ? undefined
    : requiredTimestamp(value, label);
}

function requiredEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
) {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`${label} 无效。`);
  }
  return value as T;
}

function optionalStringArray(value: unknown, label: string) {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value)
    || value.length > 2048
    || value.some((item) => (
      typeof item !== 'string'
      || item.length < 1
      || item.length > 200
    ))
  ) {
    throw new Error(`${label} 无效。`);
  }
  return [...new Set(value as string[])];
}

function optionalOpenWhen(value: unknown, label: string): LettersLifeEntryStorage['openWhen'] {
  if (value === undefined) return undefined;
  const record = recordOf(value, label);
  if (record.kind === 'date_ticket') {
    assertNoExtraFields(record, new Set(['kind', 'dateId']), label);
    return { kind: 'date_ticket', dateId: requiredString(record.dateId, `${label}.dateId`, 200) };
  }
  if (record.kind === 'after_days') {
    assertNoExtraFields(record, new Set(['kind', 'days']), label);
    if (!Number.isInteger(record.days) || Number(record.days) < 1 || Number(record.days) > 90) {
      throw new Error(`${label}.days 无效。`);
    }
    return { kind: 'after_days', days: Number(record.days) };
  }
  throw new Error(`${label}.kind 无效。`);
}

function parseEntry(
  value: unknown,
  index: number,
): LettersLifeEntryStorage {
  const label = `letters[${index}]`;
  const candidate = recordOf(value, label);
  assertNoExtraFields(candidate, ENTRY_FIELDS, label);
  const kind = requiredEnum(
    candidate.kind,
    STORAGE_KINDS,
    `${label}.kind`,
  );
  const direction = requiredEnum(
    candidate.direction,
    STORAGE_DIRECTIONS,
    `${label}.direction`,
  );
  if (
    (kind === 'future-self' && direction !== 'ai-to-future-you')
    || (kind === 'exchange' && direction === 'ai-to-future-you')
  ) {
    throw new Error(`${label} kind 与 direction 不一致。`);
  }
  const entry: LettersLifeEntryStorage = {
    id: requiredString(candidate.id, `${label}.id`, 200),
    kind,
    direction,
    status: requiredEnum(
      candidate.status,
      STORAGE_STATUSES,
      `${label}.status`,
    ),
    title: requiredString(
      candidate.title,
      `${label}.title`,
      240,
      true,
    ),
    content: requiredString(
      candidate.content,
      `${label}.content`,
      262144,
      true,
    ),
    createdAt: requiredTimestamp(
      candidate.createdAt,
      `${label}.createdAt`,
    ),
  };
  const replyContent = optionalString(
    candidate.replyContent,
    `${label}.replyContent`,
    262144,
  );
  const dueAt = optionalTimestamp(candidate.dueAt, `${label}.dueAt`);
  const deliveredAt = optionalTimestamp(
    candidate.deliveredAt,
    `${label}.deliveredAt`,
  );
  const openedAt = optionalTimestamp(
    candidate.openedAt,
    `${label}.openedAt`,
  );
  const completedAt = optionalTimestamp(
    candidate.completedAt,
    `${label}.completedAt`,
  );
  const notificationId = optionalString(
    candidate.notificationId,
    `${label}.notificationId`,
    500,
  );
  const failureReason = optionalString(
    candidate.failureReason,
    `${label}.failureReason`,
    4000,
  );
  const source = candidate.source === undefined
    ? undefined
    : requiredEnum(
        candidate.source,
        STORAGE_SOURCES,
        `${label}.source`,
      );
  const chatMessageIds = optionalStringArray(
    candidate.chatMessageIds,
    `${label}.chatMessageIds`,
  );
  const memoryIds = optionalStringArray(
    candidate.memoryIds,
    `${label}.memoryIds`,
  );
  const generationKey = optionalString(candidate.generationKey, `${label}.generationKey`, 200);
  const sourceIds = optionalStringArray(candidate.sourceIds, `${label}.sourceIds`);
  const openWhen = optionalOpenWhen(candidate.openWhen, `${label}.openWhen`);
  const dateTicketId = optionalString(candidate.dateTicketId, `${label}.dateTicketId`, 200);
  if (replyContent !== undefined) entry.replyContent = replyContent;
  if (dueAt !== undefined) entry.dueAt = dueAt;
  if (deliveredAt !== undefined) entry.deliveredAt = deliveredAt;
  if (openedAt !== undefined) entry.openedAt = openedAt;
  if (completedAt !== undefined) entry.completedAt = completedAt;
  if (notificationId !== undefined) {
    entry.notificationId = notificationId;
  }
  if (source !== undefined) entry.source = source;
  if (chatMessageIds !== undefined) {
    entry.chatMessageIds = chatMessageIds;
  }
  if (memoryIds !== undefined) entry.memoryIds = memoryIds;
  if (failureReason !== undefined) entry.failureReason = failureReason;
  if (generationKey !== undefined) entry.generationKey = generationKey;
  if (sourceIds !== undefined) entry.sourceIds = sourceIds;
  if (openWhen !== undefined) entry.openWhen = openWhen;
  if (dateTicketId !== undefined) entry.dateTicketId = dateTicketId;
  return entry;
}

export function parseLettersLifeEntriesStorage(
  raw: string,
  label = 'letters.life entries',
) {
  const parsed = parseJson(raw, label);
  if (!Array.isArray(parsed)) {
    throw new Error(`${label} 必须是数组。`);
  }
  if (parsed.length > 5000) {
    throw new Error(`${label} 不能超过 5000 条。`);
  }
  const entries = parsed.map(parseEntry);
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) {
      throw new Error(`${label} 包含重复 letter id：${entry.id}。`);
    }
    ids.add(entry.id);
  }
  return entries;
}

export function serializeLettersLifeEntriesStorage(
  entries: readonly LettersLifeEntryStorage[],
) {
  return JSON.stringify(entries);
}

export function parseLettersLifeSettingsStorage(
  raw: string,
  label = 'letters.life settings',
): LettersLifeSettingsStorage {
  const candidate = recordOf(parseJson(raw, label), label);
  assertNoExtraFields(candidate, SETTINGS_FIELDS, label);
  const value = Number(candidate.defaultReplyDelayHours);
  if (!Number.isFinite(value)) {
    throw new Error(`${label}.defaultReplyDelayHours 无效。`);
  }
  const lastProactiveRequestAt = optionalTimestamp(candidate.lastProactiveRequestAt, `${label}.lastProactiveRequestAt`);
  const lastProactiveSavedAt = optionalTimestamp(candidate.lastProactiveSavedAt, `${label}.lastProactiveSavedAt`);
  const offeredDateTicketIds = optionalStringArray(candidate.offeredDateTicketIds, `${label}.offeredDateTicketIds`);
  const settledSourceIds = optionalStringArray(candidate.settledSourceIds, `${label}.settledSourceIds`);
  const recentGenerationKeys = optionalStringArray(candidate.recentGenerationKeys, `${label}.recentGenerationKeys`);
  return {
    defaultReplyDelayHours: Math.max(
      3,
      Math.min(8, Math.round(value)),
    ),
    ...(lastProactiveRequestAt !== undefined ? { lastProactiveRequestAt } : {}),
    ...(lastProactiveSavedAt !== undefined ? { lastProactiveSavedAt } : {}),
    ...(offeredDateTicketIds !== undefined ? { offeredDateTicketIds } : {}),
    ...(settledSourceIds !== undefined ? { settledSourceIds } : {}),
    ...(recentGenerationKeys !== undefined ? { recentGenerationKeys } : {}),
  };
}

export function serializeLettersLifeSettingsStorage(
  settings: LettersLifeSettingsStorage,
) {
  return JSON.stringify(settings);
}

function parseRelationshipDate(value: unknown, index: number): LettersLifeRelationshipDateStorage {
  const label = `relationshipDates[${index}]`;
  const candidate = recordOf(value, label);
  assertNoExtraFields(candidate, RELATIONSHIP_DATE_FIELDS, label);
  const mode = requiredEnum(candidate.mode, ['solar_yearly', 'lunar_yearly', 'once'] as const, `${label}.mode`);
  const originDateKey = requiredString(candidate.originDateKey, `${label}.originDateKey`, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(originDateKey)) throw new Error(`${label}.originDateKey 无效。`);
  if (!Number.isInteger(candidate.openTimeMinutes) || Number(candidate.openTimeMinutes) < 0 || Number(candidate.openTimeMinutes) > 1439) {
    throw new Error(`${label}.openTimeMinutes 无效。`);
  }
  if (typeof candidate.letterEnabled !== 'boolean') throw new Error(`${label}.letterEnabled 无效。`);
  const record: LettersLifeRelationshipDateStorage = {
    schemaVersion: 1,
    id: requiredString(candidate.id, `${label}.id`, 200),
    title: requiredString(candidate.title, `${label}.title`, 80),
    mode,
    originDateKey,
    openTimeMinutes: Number(candidate.openTimeMinutes),
    letterEnabled: candidate.letterEnabled,
    createdAt: requiredTimestamp(candidate.createdAt, `${label}.createdAt`),
    updatedAt: requiredTimestamp(candidate.updatedAt, `${label}.updatedAt`),
  };
  if (candidate.schemaVersion !== 1) throw new Error(`${label}.schemaVersion 无效。`);
  const note = optionalString(candidate.note, `${label}.note`, 1000);
  if (note !== undefined) record.note = note;
  if (mode === 'lunar_yearly') {
    if (
      !Number.isInteger(candidate.lunarMonth)
      || Number(candidate.lunarMonth) < 1
      || Number(candidate.lunarMonth) > 12
      || !Number.isInteger(candidate.lunarDay)
      || Number(candidate.lunarDay) < 1
      || Number(candidate.lunarDay) > 30
      || typeof candidate.lunarIsLeapMonth !== 'boolean'
    ) throw new Error(`${label} 农历字段无效。`);
    record.lunarMonth = Number(candidate.lunarMonth);
    record.lunarDay = Number(candidate.lunarDay);
    record.lunarIsLeapMonth = candidate.lunarIsLeapMonth;
  }
  return record;
}

export function parseLettersLifeRelationshipDatesStorage(
  raw: string,
  label = 'letters.life relationship dates',
) {
  const parsed = parseJson(raw, label);
  if (!Array.isArray(parsed) || parsed.length > 5000) throw new Error(`${label} 必须是至多 5000 条的数组。`);
  const records = parsed.map(parseRelationshipDate);
  if (new Set(records.map((record) => record.id)).size !== records.length) throw new Error(`${label} 包含重复 id。`);
  return records;
}

export function serializeLettersLifeRelationshipDatesStorage(
  records: readonly LettersLifeRelationshipDateStorage[],
) {
  return JSON.stringify(records);
}

function letterRecord(
  entry: LettersLifeEntryStorage,
): LettersLifeLetterRecord {
  return {
    id: entry.id,
    kind: entry.kind === 'future-self'
      ? 'future-you'
      : 'exchange',
    direction: entry.direction === 'you-to-ai'
      ? 'you-to-I'
      : entry.direction === 'ai-to-you'
        ? 'I-to-you'
        : 'I-to-future-you',
    title: entry.title,
    content: entry.content,
    createdAt: entry.createdAt,
    ...(entry.replyContent !== undefined
      ? { replyContent: entry.replyContent }
      : {}),
    ...(entry.source !== undefined
      ? {
          source: entry.source === 'user'
            ? 'you'
            : entry.source === 'future-self'
              ? 'future-you'
              : entry.source,
        }
      : {}),
    ...(entry.chatMessageIds !== undefined
      ? { chatMessageIds: entry.chatMessageIds }
      : {}),
    ...(entry.memoryIds !== undefined
      ? { memoryIds: entry.memoryIds }
      : {}),
    ...(entry.generationKey !== undefined ? { generationKey: entry.generationKey } : {}),
    ...(entry.sourceIds !== undefined ? { sourceIds: entry.sourceIds } : {}),
    ...(entry.openWhen !== undefined ? { openWhen: entry.openWhen } : {}),
    ...(entry.dateTicketId !== undefined ? { dateTicketId: entry.dateTicketId } : {}),
  };
}

function deliveryStateRecord(
  entry: LettersLifeEntryStorage,
): LettersLifeDeliveryStateRecord {
  return {
    letterId: entry.id,
    status: entry.status === 'waiting_ai'
      ? 'waiting_I'
      : entry.status === 'waiting_user'
        ? 'waiting_you'
        : entry.status,
    ...(entry.dueAt !== undefined ? { dueAt: entry.dueAt } : {}),
    ...(entry.deliveredAt !== undefined
      ? { deliveredAt: entry.deliveredAt }
      : {}),
    ...(entry.openedAt !== undefined
      ? { openedAt: entry.openedAt }
      : {}),
    ...(entry.completedAt !== undefined
      ? { completedAt: entry.completedAt }
      : {}),
  };
}

type RecordMaps = {
  letter: Map<string, LettersLifeLetterRecord>;
  'delivery-state': Map<string, LettersLifeDeliveryStateRecord>;
  'letter-settings': Map<string, LettersLifeSettingsRecord>;
  'relationship-date': Map<string, LettersLifeRelationshipDateRecord>;
};

function emptyRecordMaps(): RecordMaps {
  return {
    letter: new Map(),
    'delivery-state': new Map(),
    'letter-settings': new Map(),
    'relationship-date': new Map(),
  };
}

function recordsFromRaw(key: string, raw: string | null) {
  const records = emptyRecordMaps();
  if (raw === null) return records;
  if (key === LETTERS_LIFE_ENTRIES_KEY) {
    for (const entry of parseLettersLifeEntriesStorage(raw)) {
      records.letter.set(entry.id, letterRecord(entry));
      records['delivery-state'].set(
        entry.id,
        deliveryStateRecord(entry),
      );
    }
    return records;
  }
  if (key === LETTERS_LIFE_SETTINGS_KEY) {
    const settings = parseLettersLifeSettingsStorage(raw);
    records['letter-settings'].set(
      LETTERS_LIFE_SETTINGS_ENTITY_ID,
      {
        settingsId: LETTERS_LIFE_SETTINGS_ENTITY_ID,
        defaultReplyDelayHours: settings.defaultReplyDelayHours,
        ...(settings.lastProactiveRequestAt !== undefined ? { lastProactiveRequestAt: settings.lastProactiveRequestAt } : {}),
        ...(settings.lastProactiveSavedAt !== undefined ? { lastProactiveSavedAt: settings.lastProactiveSavedAt } : {}),
        ...(settings.offeredDateTicketIds !== undefined ? { offeredDateTicketIds: settings.offeredDateTicketIds } : {}),
        ...(settings.settledSourceIds !== undefined ? { settledSourceIds: settings.settledSourceIds } : {}),
        ...(settings.recentGenerationKeys !== undefined ? { recentGenerationKeys: settings.recentGenerationKeys } : {}),
      },
    );
    return records;
  }
  if (key === LETTERS_LIFE_RELATIONSHIP_DATES_KEY) {
    for (const record of parseLettersLifeRelationshipDatesStorage(raw)) {
      records['relationship-date'].set(record.id, record);
    }
  }
  return records;
}

function sameJson(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertTimestamp(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} 必须是非负 Unix 毫秒整数。`);
  }
}

const ENTITY_ORDER: readonly LettersLifeEntityType[] = [
  'letter',
  'delivery-state',
  'letter-settings',
  'relationship-date',
];

export function isLettersLifeGlobalStorageKey(key: string) {
  return (
    key === LETTERS_LIFE_ENTRIES_KEY
    || key === LETTERS_LIFE_SETTINGS_KEY
    || key === LETTERS_LIFE_RELATIONSHIP_DATES_KEY
  );
}

export async function deriveLettersLifeMutationsForStorageChanges(
  input: {
    changes: readonly LettersLifeStorageChange[];
    reader: LettersLifeStorageReadPort;
    capturedAt: number;
    envelopeFactory: LettersLifeEnvelopeFactory;
  },
) {
  assertTimestamp(input.capturedAt, 'letters.life capture time');
  const seenKeys = new Set<string>();
  const mutations: PlainMutationV1[] = [];
  for (const change of input.changes) {
    if (seenKeys.has(change.key)) {
      throw new Error(
        `letters.life 同批重复变更 key：${change.key}。`,
      );
    }
    seenKeys.add(change.key);
    if (!isLettersLifeGlobalStorageKey(change.key)) continue;
    const previous = recordsFromRaw(
      change.key,
      await input.reader.getItem(change.key),
    );
    const next = recordsFromRaw(
      change.key,
      change.kind === 'set' ? change.value : null,
    );
    for (const entityType of ENTITY_ORDER) {
      const beforeMap = previous[entityType];
      const afterMap = next[entityType];
      const entityIds = [...new Set([
        ...beforeMap.keys(),
        ...afterMap.keys(),
      ])].sort();
      for (const entityId of entityIds) {
        const before = beforeMap.get(entityId);
        const after = afterMap.get(entityId);
        if (sameJson(before, after)) continue;
        const envelope = await input.envelopeFactory({
          domain: 'letters',
          type: entityType,
          id: entityId,
        });
        if (!after) {
          mutations.push(buildLettersLifeDeleteMutation({
            envelope,
            entityType,
            entityId,
            deletedAt: input.capturedAt,
          }));
          continue;
        }
        assertLettersLifeRecord(entityType, entityId, after);
        mutations.push(buildLettersLifeRecordMutation({
          envelope,
          entityType,
          entityId,
          kind: entityType,
          value: after as unknown as JsonValue,
        }));
      }
    }
  }
  return mutations;
}
