import type {
  ChatPreferences,
} from '../chat/chatPreferences';
import type {
  FavoriteMessage,
} from '../chat/favoriteMessageStore';
import type {
  KeywordCounterEvent,
  KeywordCounterInsight,
  KeywordCounterSnapshot,
  KeywordCounterTask,
} from '../chat/keywordCounterStore';
import type {
  NotebookEntry,
  NotebookSnapshot,
} from '../chat/notebookStore';
import {
  buildChatRelationshipDeleteMutation,
  buildChatRelationshipRecordMutation,
  type ChatRelationshipEntityType,
  type ChatRelationshipRecordKind,
} from './syncChatRelationship';
import type {
  ChatCoreMutationEnvelope,
} from './syncChatCore';
import type {
  SyncMutationEntityRef,
} from './syncMutationEnvelope';
import {
  assertJsonValue,
  type JsonValue,
  type PlainMutationV1,
} from './syncProtocol';

export const CHAT_RELATIONSHIP_KEYS = Object.freeze({
  favorites: 'junluo.chat.favoriteMessages',
  likedStyleReferences: 'junluo.chat.likedStyleReferenceIds',
  userCorrections: 'junluo.chat.userCorrectionEvents',
  preferences: 'junluo.chat.preferences',
  keywordCounters: 'junluo.chat.keywordCounters.v1',
  notebook: 'junluo.chat.baiyunNotebook.v1',
  notebookPendingInteraction: 'junluo.chat.baiyunNotebook.pendingInteraction.v1',
  sleepState: 'junluo.chat.sleepInteraction.v1',
});

export type ChatRelationshipStorageChange =
  | { kind: 'set'; key: string; value: string }
  | { kind: 'remove'; key: string };

export type ChatRelationshipStorageReadPort = {
  getItem(key: string): Promise<string | null>;
};

export type ChatRelationshipEnvelopeFactory = (
  entity: SyncMutationEntityRef,
) => Promise<ChatCoreMutationEnvelope>;

type JsonRecord = { [key: string]: JsonValue };

// Legacy transport shape, retained only to delete the retired expression notebook.
type RetiredUserCorrectionRecord = {
  id: string; kind: string; summary: string; createdAt: number; updatedAt: number; hitCount: number;
};

type CollectionDescriptor<T> = {
  entityType: ChatRelationshipEntityType;
  kind: ChatRelationshipRecordKind;
  operationForNew: 'append' | 'upsert';
  deleteMissing: boolean;
  entityId(value: T): string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseJson(raw: string | null, label: string): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${label} 不是有效 JSON，不能捕获同步变更。`);
  }
}

function jsonValue(value: unknown, label: string): JsonValue {
  try {
    assertJsonValue(value);
  } catch {
    throw new Error(`${label} 不是可同步 JSON。`);
  }
  return value;
}

function jsonRecord(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`${label} 必须是对象。`);
  return jsonValue(value, label) as JsonRecord;
}

function parseRecordArray<T>(
  raw: string | null,
  label: string,
  isValid: (value: unknown) => value is T,
) {
  const parsed = parseJson(raw, label);
  if (parsed === null) return [];
  if (!Array.isArray(parsed)) throw new Error(`${label} 必须是数组。`);
  if (!parsed.every(isValid)) throw new Error(`${label} 含无效记录。`);
  return parsed;
}

function jsonEqual(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && !!item);
}

function isFavorite(value: unknown): value is FavoriteMessage {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string'
    && typeof value.messageId === 'string'
    && typeof value.content === 'string'
    && typeof value.messageCreatedAt === 'number'
    && typeof value.savedAt === 'number'
  );
}

function isCorrection(value: unknown): value is RetiredUserCorrectionRecord {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string'
    && typeof value.kind === 'string'
    && typeof value.summary === 'string'
    && typeof value.createdAt === 'number'
    && typeof value.updatedAt === 'number'
    && typeof value.hitCount === 'number'
  );
}

function isKeywordTask(value: unknown): value is KeywordCounterTask {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string'
    && typeof value.createdAt === 'number'
    && typeof value.startAt === 'number'
    && typeof value.updatedAt === 'number'
    && typeof value.status === 'string'
    && isStringArray(value.keywords)
  );
}

function isKeywordEvent(value: unknown): value is KeywordCounterEvent {
  if (!isRecord(value)) return false;
  return (
    typeof value.taskId === 'string'
    && typeof value.messageId === 'string'
    && typeof value.keyword === 'string'
    && typeof value.messageCreatedAt === 'number'
  );
}

function isKeywordInsight(value: unknown): value is KeywordCounterInsight {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string'
    && typeof value.taskId === 'string'
    && typeof value.message === 'string'
    && typeof value.createdAt === 'number'
  );
}

function isNotebookEntry(value: unknown): value is NotebookEntry {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string'
    && typeof value.content === 'string'
    && typeof value.title === 'string'
    && typeof value.createdAt === 'number'
    && typeof value.updatedAt === 'number'
    && isStringArray(value.keywords)
  );
}

function stableToken(value: string) {
  let first = 0x811c9dc5;
  let second = 0x9e3779b1;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

export function keywordEventEntityId(event: KeywordCounterEvent) {
  return `keyword-event:${stableToken(`${event.taskId}\u0000${event.messageId}\u0000${event.keyword}`)}`;
}

function likedStyleEntityId(referenceId: string) {
  return `liked-style:${stableToken(referenceId)}`;
}

async function buildCollectionMutations<T>(input: {
  before: readonly T[];
  after: readonly T[];
  descriptor: CollectionDescriptor<T>;
  envelopeFactory: ChatRelationshipEnvelopeFactory;
  deletedAt: number;
}) {
  const beforeById = new Map(input.before.map((value) => [
    input.descriptor.entityId(value),
    value,
  ]));
  const afterById = new Map(input.after.map((value) => [
    input.descriptor.entityId(value),
    value,
  ]));
  if (beforeById.size !== input.before.length || afterById.size !== input.after.length) {
    throw new Error(`${input.descriptor.kind} 含重复稳定 ID。`);
  }
  const mutations: PlainMutationV1[] = [];
  if (input.descriptor.deleteMissing) {
    for (const entityId of [...beforeById.keys()].sort()) {
      if (afterById.has(entityId)) continue;
      mutations.push(buildChatRelationshipDeleteMutation({
        envelope: await input.envelopeFactory({
          domain: 'chat',
          type: input.descriptor.entityType,
          id: entityId,
        }),
        entityType: input.descriptor.entityType,
        entityId,
        deletedAt: input.deletedAt,
      }));
    }
  }
  for (const [entityId, value] of [...afterById.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const oldValue = beforeById.get(entityId);
    if (oldValue && jsonEqual(oldValue, value)) continue;
    mutations.push(buildChatRelationshipRecordMutation({
      envelope: await input.envelopeFactory({
        domain: 'chat',
        type: input.descriptor.entityType,
        id: entityId,
      }),
      entityType: input.descriptor.entityType,
      entityId,
      kind: input.descriptor.kind,
      value: jsonValue(value, input.descriptor.kind),
      operation: oldValue ? 'upsert' : input.descriptor.operationForNew,
    }));
  }
  return mutations;
}

function changedFields(before: unknown, after: unknown) {
  const beforeRecord = isRecord(before) ? before : {};
  const afterRecord = isRecord(after) ? after : {};
  const patch: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(beforeRecord), ...Object.keys(afterRecord)]);
  for (const key of [...keys].sort()) {
    const beforeValue = beforeRecord[key];
    const afterValue = afterRecord[key];
    if (jsonEqual(beforeValue, afterValue)) continue;
    patch[key] = Object.prototype.hasOwnProperty.call(afterRecord, key) ? afterValue : null;
  }
  return patch;
}

async function buildSingletonMutation(input: {
  before: unknown;
  after: unknown;
  entityType: ChatRelationshipEntityType;
  entityId: string;
  kind: ChatRelationshipRecordKind;
  envelopeFactory: ChatRelationshipEnvelopeFactory;
  deletedAt: number;
  fieldPatch?: boolean;
}) {
  if (input.after === null) {
    if (input.before === null) return [];
    return [buildChatRelationshipDeleteMutation({
      envelope: await input.envelopeFactory({
        domain: 'chat',
        type: input.entityType,
        id: input.entityId,
      }),
      entityType: input.entityType,
      entityId: input.entityId,
      deletedAt: input.deletedAt,
    })];
  }
  const value = input.fieldPatch
    ? changedFields(input.before, input.after)
    : input.after;
  if (input.before !== null && (input.fieldPatch ? !Object.keys(value as object).length : jsonEqual(input.before, input.after))) {
    return [];
  }
  return [buildChatRelationshipRecordMutation({
    envelope: await input.envelopeFactory({
      domain: 'chat',
      type: input.entityType,
      id: input.entityId,
    }),
    entityType: input.entityType,
    entityId: input.entityId,
    kind: input.kind,
    value: jsonValue(value, input.kind),
    operation: 'upsert',
  })];
}

function parseKeywordSnapshot(raw: string | null): KeywordCounterSnapshot | null {
  const parsed = parseJson(raw, 'keyword counter snapshot');
  if (parsed === null) return null;
  if (!isRecord(parsed)) throw new Error('keyword counter snapshot 必须是对象。');
  const tasks = Array.isArray(parsed.tasks) && parsed.tasks.every(isKeywordTask) ? parsed.tasks : null;
  const events = Array.isArray(parsed.events) && parsed.events.every(isKeywordEvent) ? parsed.events : null;
  const insights = Array.isArray(parsed.insights) && parsed.insights.every(isKeywordInsight) ? parsed.insights : null;
  if (!tasks || !events || !insights || !isRecord(parsed.settings)) {
    throw new Error('keyword counter snapshot 缺少稳定字段。');
  }
  return parsed as unknown as KeywordCounterSnapshot;
}

function parseNotebookSnapshot(raw: string | null): NotebookSnapshot | null {
  const parsed = parseJson(raw, 'notebook snapshot');
  if (parsed === null) return null;
  if (
    !isRecord(parsed)
    || !Array.isArray(parsed.entries)
    || !parsed.entries.every(isNotebookEntry)
    || !isRecord(parsed.settings)
  ) {
    throw new Error('notebook snapshot 缺少稳定字段。');
  }
  return parsed as unknown as NotebookSnapshot;
}

function parsePreferences(raw: string | null): ChatPreferences | null {
  const parsed = parseJson(raw, 'chat preferences');
  if (parsed === null) return null;
  if (
    !isRecord(parsed)
    || typeof parsed.musicAutoplay !== 'boolean'
    || typeof parsed.musicEnabled !== 'boolean'
    || typeof parsed.musicMultipleCardsEnabled !== 'boolean'
    || typeof parsed.waitingModeEnabled !== 'boolean'
  ) {
    throw new Error('chat preferences 缺少稳定字段。');
  }
  return parsed as unknown as ChatPreferences;
}

function sharedSleepState(raw: string | null) {
  const parsed = parseJson(raw, 'sleep interaction state');
  if (parsed === null) return null;
  const state = jsonRecord(parsed, 'sleep interaction state');
  const shared: Record<string, unknown> = { ...state };
  if (isRecord(state.pending)) {
    const {
      claimedAt: _claimedAt,
      claimToken: _claimToken,
      ...pending
    } = state.pending;
    shared.pending = pending;
  }
  return jsonRecord(shared, 'shared sleep interaction state');
}

async function deriveFavorites(input: DeriveInput, change: ChatRelationshipStorageChange) {
  return buildCollectionMutations({
    before: parseRecordArray(await input.reader.getItem(change.key), 'favorites', isFavorite),
    after: change.kind === 'set' ? parseRecordArray(change.value, 'favorites', isFavorite) : [],
    descriptor: {
      entityType: 'favorite',
      kind: 'favorite',
      operationForNew: 'append',
      deleteMissing: true,
      entityId: (value) => value.id,
    },
    envelopeFactory: input.envelopeFactory,
    deletedAt: input.deletedAt,
  });
}

async function deriveLikedStyleReferences(input: DeriveInput, change: ChatRelationshipStorageChange) {
  const before = parseJson(await input.reader.getItem(change.key), 'liked style references');
  const after = change.kind === 'set' ? parseJson(change.value, 'liked style references') : [];
  const beforeValues = before === null ? [] : before;
  if (!isStringArray(beforeValues) || !isStringArray(after)) {
    throw new Error('liked style references 必须是字符串数组。');
  }
  return buildCollectionMutations({
    before: beforeValues,
    after,
    descriptor: {
      entityType: 'expression-feedback',
      kind: 'liked-style-reference',
      operationForNew: 'append',
      deleteMissing: true,
      entityId: likedStyleEntityId,
    },
    envelopeFactory: input.envelopeFactory,
    deletedAt: input.deletedAt,
  });
}

async function deriveCorrections(input: DeriveInput, change: ChatRelationshipStorageChange) {
  if (change.kind !== 'remove') return [];
  return buildCollectionMutations({
    before: parseRecordArray(await input.reader.getItem(change.key), 'user corrections', isCorrection),
    after: [],
    descriptor: {
      entityType: 'expression-feedback',
      kind: 'user-correction',
      operationForNew: 'append',
      deleteMissing: true,
      entityId: (value) => `correction:${value.id}`,
    },
    envelopeFactory: input.envelopeFactory,
    deletedAt: input.deletedAt,
  });
}

async function derivePreferences(input: DeriveInput, change: ChatRelationshipStorageChange) {
  return buildSingletonMutation({
    before: parsePreferences(await input.reader.getItem(change.key)),
    after: change.kind === 'set' ? parsePreferences(change.value) : null,
    entityType: 'preference',
    entityId: 'chat-preferences',
    kind: 'chat-preferences',
    envelopeFactory: input.envelopeFactory,
    deletedAt: input.deletedAt,
    fieldPatch: true,
  });
}

async function deriveKeywordCounters(input: DeriveInput, change: ChatRelationshipStorageChange) {
  const before = parseKeywordSnapshot(await input.reader.getItem(change.key));
  const after = change.kind === 'set' ? parseKeywordSnapshot(change.value) : null;
  return [
    ...await buildCollectionMutations({
      before: before?.tasks ?? [],
      after: after?.tasks ?? [],
      descriptor: {
        entityType: 'preference',
        kind: 'keyword-task',
        operationForNew: 'append',
        deleteMissing: true,
        entityId: (value) => `keyword-task:${value.id}`,
      },
      envelopeFactory: input.envelopeFactory,
      deletedAt: input.deletedAt,
    }),
    ...await buildCollectionMutations({
      before: before?.events ?? [],
      after: after?.events ?? [],
      descriptor: {
        entityType: 'expression-feedback',
        kind: 'keyword-event',
        operationForNew: 'append',
        deleteMissing: false,
        entityId: keywordEventEntityId,
      },
      envelopeFactory: input.envelopeFactory,
      deletedAt: input.deletedAt,
    }),
    ...await buildCollectionMutations({
      before: before?.insights ?? [],
      after: after?.insights ?? [],
      descriptor: {
        entityType: 'expression-feedback',
        kind: 'keyword-insight',
        operationForNew: 'append',
        deleteMissing: false,
        entityId: (value) => `keyword-insight:${value.id}`,
      },
      envelopeFactory: input.envelopeFactory,
      deletedAt: input.deletedAt,
    }),
    ...await buildSingletonMutation({
      before: before?.settings ?? null,
      after: after?.settings ?? null,
      entityType: 'preference',
      entityId: 'keyword-settings',
      kind: 'keyword-settings',
      envelopeFactory: input.envelopeFactory,
      deletedAt: input.deletedAt,
      fieldPatch: true,
    }),
  ];
}

async function deriveNotebook(input: DeriveInput, change: ChatRelationshipStorageChange) {
  const before = parseNotebookSnapshot(await input.reader.getItem(change.key));
  const after = change.kind === 'set' ? parseNotebookSnapshot(change.value) : null;
  return [
    ...await buildCollectionMutations({
      before: before?.entries ?? [],
      after: after?.entries ?? [],
      descriptor: {
        entityType: 'notebook-entry',
        kind: 'notebook-entry',
        operationForNew: 'append',
        deleteMissing: true,
        entityId: (value) => value.id,
      },
      envelopeFactory: input.envelopeFactory,
      deletedAt: input.deletedAt,
    }),
    ...await buildSingletonMutation({
      before: before?.settings ?? null,
      after: after?.settings ?? null,
      entityType: 'preference',
      entityId: 'notebook-settings',
      kind: 'notebook-settings',
      envelopeFactory: input.envelopeFactory,
      deletedAt: input.deletedAt,
      fieldPatch: true,
    }),
  ];
}

async function deriveSleepState(input: DeriveInput, change: ChatRelationshipStorageChange) {
  return buildSingletonMutation({
    before: sharedSleepState(await input.reader.getItem(change.key)),
    after: change.kind === 'set' ? sharedSleepState(change.value) : null,
    entityType: 'sleep-state',
    entityId: 'current',
    kind: 'sleep-state',
    envelopeFactory: input.envelopeFactory,
    deletedAt: input.deletedAt,
  });
}

type DeriveInput = {
  reader: ChatRelationshipStorageReadPort;
  envelopeFactory: ChatRelationshipEnvelopeFactory;
  deletedAt: number;
};

export async function deriveChatRelationshipMutationsForStorageChanges(input: DeriveInput & {
  changes: readonly ChatRelationshipStorageChange[];
}) {
  const lastByKey = new Map<string, ChatRelationshipStorageChange>();
  input.changes.forEach((change) => lastByKey.set(change.key, change));
  const mutations: PlainMutationV1[] = [];
  for (const change of [...lastByKey.values()].sort((left, right) => left.key.localeCompare(right.key))) {
    switch (change.key) {
      case CHAT_RELATIONSHIP_KEYS.favorites:
        mutations.push(...await deriveFavorites(input, change));
        break;
      case CHAT_RELATIONSHIP_KEYS.likedStyleReferences:
        mutations.push(...await deriveLikedStyleReferences(input, change));
        break;
      case CHAT_RELATIONSHIP_KEYS.userCorrections:
        mutations.push(...await deriveCorrections(input, change));
        break;
      case CHAT_RELATIONSHIP_KEYS.preferences:
        mutations.push(...await derivePreferences(input, change));
        break;
      case CHAT_RELATIONSHIP_KEYS.keywordCounters:
        mutations.push(...await deriveKeywordCounters(input, change));
        break;
      case CHAT_RELATIONSHIP_KEYS.notebook:
        mutations.push(...await deriveNotebook(input, change));
        break;
      case CHAT_RELATIONSHIP_KEYS.sleepState:
        mutations.push(...await deriveSleepState(input, change));
        break;
      case CHAT_RELATIONSHIP_KEYS.notebookPendingInteraction:
        break;
      default:
        throw new Error(`chat.relationship-state 尝试写入未登记 key：${change.key}。`);
    }
  }
  return mutations;
}
