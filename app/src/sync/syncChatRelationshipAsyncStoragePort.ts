import RawAsyncStorage from '@react-native-async-storage/async-storage';

import type {
  ChatRelationshipBusinessPort,
} from './syncChatRelationshipApply';
import {
  keywordEventEntityId,
  CHAT_RELATIONSHIP_KEYS,
} from './syncChatRelationshipStorageDerivation';
import type {
  JsonValue,
} from './syncProtocol';

type JsonRecord = { [key: string]: JsonValue };

let relationshipApplyQueue = Promise.resolve();

function enqueueRelationshipApply<T>(apply: () => Promise<T>) {
  const current = relationshipApplyQueue.catch(() => undefined).then(apply);
  relationshipApplyQueue = current.then(() => undefined, () => undefined);
  return current;
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function record(value: JsonValue, label: string) {
  if (!isRecord(value)) throw new Error(`${label} 必须是对象。`);
  return value;
}

async function readJson(key: string, fallback: JsonValue): Promise<JsonValue> {
  const raw = await RawAsyncStorage.getItem(key);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as JsonValue;
  } catch {
    throw new Error(`本机 ${key} 不是有效 JSON，已停止远端 materialize。`);
  }
}

async function writeJson(key: string, value: JsonValue) {
  await RawAsyncStorage.setItem(key, JSON.stringify(value));
}

function upsertRecordInArray(
  values: JsonValue,
  value: JsonRecord,
  matches: (candidate: JsonRecord) => boolean,
) {
  const array = Array.isArray(values) ? values : [];
  let replaced = false;
  const next = array.map((candidate) => {
    if (!isRecord(candidate) || !matches(candidate)) return candidate;
    replaced = true;
    return value;
  });
  if (!replaced) next.push(value);
  return next;
}

function removeRecordFromArray(
  values: JsonValue,
  matches: (candidate: JsonRecord) => boolean,
) {
  const array = Array.isArray(values) ? values : [];
  return array.filter((candidate) => !isRecord(candidate) || !matches(candidate));
}

async function updateObjectSnapshot(input: {
  key: string;
  defaults: JsonRecord;
  update: (snapshot: JsonRecord) => JsonRecord;
}) {
  const stored = await readJson(input.key, input.defaults);
  const snapshot = isRecord(stored) ? stored : input.defaults;
  await writeJson(input.key, input.update(snapshot));
}

function mergePatch(target: JsonRecord, patch: JsonRecord) {
  const next: JsonRecord = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete next[key];
    } else {
      next[key] = value;
    }
  }
  return next;
}

async function upsertFavorite(entityId: string, value: JsonValue) {
  const favorite = record(value, 'favorite');
  const stored = await readJson(CHAT_RELATIONSHIP_KEYS.favorites, []);
  const next = upsertRecordInArray(
    stored,
    favorite,
    (candidate) => candidate.id === entityId,
  ).sort((left, right) => (
    Number(isRecord(right) ? right.savedAt ?? 0 : 0)
    - Number(isRecord(left) ? left.savedAt ?? 0 : 0)
  ));
  await writeJson(CHAT_RELATIONSHIP_KEYS.favorites, next);
}

async function upsertLikedStyleReference(value: JsonValue) {
  if (typeof value !== 'string') throw new Error('liked-style-reference 必须是字符串。');
  const stored = await readJson(CHAT_RELATIONSHIP_KEYS.likedStyleReferences, []);
  const ids = Array.isArray(stored)
    ? stored.filter((item): item is string => typeof item === 'string')
    : [];
  if (!ids.includes(value)) ids.push(value);
  await writeJson(CHAT_RELATIONSHIP_KEYS.likedStyleReferences, ids);
}

async function upsertKeywordRecord(
  bucket: 'events' | 'insights' | 'tasks',
  entityId: string,
  value: JsonValue,
) {
  const item = record(value, `keyword ${bucket}`);
  await updateObjectSnapshot({
    key: CHAT_RELATIONSHIP_KEYS.keywordCounters,
    defaults: {
      events: [],
      insights: [],
      settings: { enabled: true },
      tasks: [],
    },
    update(snapshot) {
      const matches = bucket === 'events'
        ? (candidate: JsonRecord) => keywordEventEntityId(candidate as never) === entityId
        : bucket === 'insights'
          ? (candidate: JsonRecord) => `keyword-insight:${String(candidate.id ?? '')}` === entityId
          : (candidate: JsonRecord) => `keyword-task:${String(candidate.id ?? '')}` === entityId;
      return {
        ...snapshot,
        [bucket]: upsertRecordInArray(snapshot[bucket] ?? [], item, matches),
      };
    },
  });
}

async function upsertKeywordSettings(value: JsonValue) {
  const patch = record(value, 'keyword settings');
  await updateObjectSnapshot({
    key: CHAT_RELATIONSHIP_KEYS.keywordCounters,
    defaults: {
      events: [],
      insights: [],
      settings: { enabled: true },
      tasks: [],
    },
    update: (snapshot) => ({
      ...snapshot,
      settings: mergePatch(
        isRecord(snapshot.settings) ? snapshot.settings : { enabled: true },
        patch,
      ),
    }),
  });
}

async function upsertNotebookEntry(entityId: string, value: JsonValue) {
  const entry = record(value, 'notebook entry');
  await updateObjectSnapshot({
    key: CHAT_RELATIONSHIP_KEYS.notebook,
    defaults: {
      entries: [],
      settings: { cooldownMs: 30 * 60 * 1000, enabled: true },
    },
    update: (snapshot) => ({
      ...snapshot,
      entries: upsertRecordInArray(
        snapshot.entries ?? [],
        entry,
        (candidate) => candidate.id === entityId,
      ).sort((left, right) => (
        Number(isRecord(right) ? right.createdAt ?? 0 : 0)
        - Number(isRecord(left) ? left.createdAt ?? 0 : 0)
      )),
    }),
  });
}

async function upsertNotebookSettings(value: JsonValue) {
  const patch = record(value, 'notebook settings');
  await updateObjectSnapshot({
    key: CHAT_RELATIONSHIP_KEYS.notebook,
    defaults: {
      entries: [],
      settings: { cooldownMs: 30 * 60 * 1000, enabled: true },
    },
    update: (snapshot) => ({
      ...snapshot,
      settings: mergePatch(
        isRecord(snapshot.settings)
          ? snapshot.settings
          : { cooldownMs: 30 * 60 * 1000, enabled: true },
        patch,
      ),
    }),
  });
}

async function upsertSleepState(value: JsonValue) {
  const incoming = record(value, 'sleep state');
  const stored = await readJson(CHAT_RELATIONSHIP_KEYS.sleepState, {});
  const existing = isRecord(stored) ? stored : {};
  const next: JsonRecord = { ...incoming };
  if (incoming.pokeExperiences === undefined && existing.pokeExperiences !== undefined) {
    next.pokeExperiences = existing.pokeExperiences;
  }
  if (isRecord(incoming.pending) && isRecord(existing.pending)) {
    const samePending = (
      incoming.pending.sessionId === existing.pending.sessionId
      && JSON.stringify(incoming.pending.messageIds) === JSON.stringify(existing.pending.messageIds)
    );
    if (samePending) {
      next.pending = {
        ...incoming.pending,
        ...(typeof existing.pending.claimedAt === 'number'
          ? { claimedAt: existing.pending.claimedAt }
          : {}),
        ...(typeof existing.pending.claimToken === 'string'
          ? { claimToken: existing.pending.claimToken }
          : {}),
      };
    }
  }
  await writeJson(CHAT_RELATIONSHIP_KEYS.sleepState, next);
}

async function upsertRecord(
  input: Parameters<ChatRelationshipBusinessPort['upsertRecord']>[0],
) {
  switch (input.kind) {
    case 'favorite':
      await upsertFavorite(input.entityId, input.value);
      return;
    case 'liked-style-reference':
      await upsertLikedStyleReference(input.value);
      return;
    case 'user-correction':
      // Decode legacy revisions without reviving the retired business content.
      return;
    case 'chat-preferences': {
      const patch = record(input.value, 'chat preferences');
      const stored = await readJson(CHAT_RELATIONSHIP_KEYS.preferences, {});
      await writeJson(
        CHAT_RELATIONSHIP_KEYS.preferences,
        mergePatch(isRecord(stored) ? stored : {}, patch),
      );
      return;
    }
    case 'keyword-task':
      await upsertKeywordRecord('tasks', input.entityId, input.value);
      return;
    case 'keyword-event':
      await upsertKeywordRecord('events', input.entityId, input.value);
      return;
    case 'keyword-insight':
      await upsertKeywordRecord('insights', input.entityId, input.value);
      return;
    case 'keyword-settings':
      await upsertKeywordSettings(input.value);
      return;
    case 'notebook-entry':
      await upsertNotebookEntry(input.entityId, input.value);
      return;
    case 'notebook-settings':
      await upsertNotebookSettings(input.value);
      return;
    case 'sleep-state':
      await upsertSleepState(input.value);
  }
}

async function tombstone(
  input: Parameters<ChatRelationshipBusinessPort['tombstone']>[0],
) {
  switch (input.entityType) {
    case 'favorite': {
      const stored = await readJson(CHAT_RELATIONSHIP_KEYS.favorites, []);
      await writeJson(
        CHAT_RELATIONSHIP_KEYS.favorites,
        removeRecordFromArray(stored, (candidate) => candidate.id === input.entityId),
      );
      return;
    }
    case 'notebook-entry':
      await updateObjectSnapshot({
        key: CHAT_RELATIONSHIP_KEYS.notebook,
        defaults: {
          entries: [],
          settings: { cooldownMs: 30 * 60 * 1000, enabled: true },
        },
        update: (snapshot) => ({
          ...snapshot,
          entries: removeRecordFromArray(
            snapshot.entries ?? [],
            (candidate) => candidate.id === input.entityId,
          ),
        }),
      });
      return;
    case 'sleep-state':
      await RawAsyncStorage.removeItem(CHAT_RELATIONSHIP_KEYS.sleepState);
      return;
    case 'preference':
      if (input.entityId === 'chat-preferences') {
        await RawAsyncStorage.removeItem(CHAT_RELATIONSHIP_KEYS.preferences);
        return;
      }
      if (input.entityId === 'keyword-settings') {
        await upsertKeywordSettings({ enabled: true });
        return;
      }
      if (input.entityId === 'notebook-settings') {
        await upsertNotebookSettings({
          cooldownMs: 30 * 60 * 1000,
          enabled: true,
        });
        return;
      }
      if (input.entityId.startsWith('keyword-task:')) {
        await updateObjectSnapshot({
          key: CHAT_RELATIONSHIP_KEYS.keywordCounters,
          defaults: {
            events: [],
            insights: [],
            settings: { enabled: true },
            tasks: [],
          },
          update: (snapshot) => ({
            ...snapshot,
            tasks: removeRecordFromArray(
              snapshot.tasks ?? [],
              (candidate) => `keyword-task:${String(candidate.id ?? '')}` === input.entityId,
            ),
          }),
        });
      }
      return;
    case 'expression-feedback': {
      if (input.entityId.startsWith('correction:')) {
        const stored = await readJson(CHAT_RELATIONSHIP_KEYS.userCorrections, []);
        const remaining = removeRecordFromArray(stored,
          (candidate) => `correction:${String(candidate.id ?? '')}` === input.entityId);
        if (remaining.length) await writeJson(CHAT_RELATIONSHIP_KEYS.userCorrections, remaining);
        else await RawAsyncStorage.removeItem(CHAT_RELATIONSHIP_KEYS.userCorrections);
        return;
      }
      if (input.entityId.startsWith('liked-style:')) {
        const stored = await readJson(CHAT_RELATIONSHIP_KEYS.likedStyleReferences, []);
        const ids = Array.isArray(stored)
          ? stored.filter((value): value is string => typeof value === 'string')
          : [];
        const remaining = ids.filter((id) => {
          const current = deriveLikedStyleEntityId(id);
          return current !== input.entityId;
        });
        await writeJson(CHAT_RELATIONSHIP_KEYS.likedStyleReferences, remaining);
      }
      return;
    }
  }
}

function deriveLikedStyleEntityId(referenceId: string) {
  let first = 0x811c9dc5;
  let second = 0x9e3779b1;
  for (let index = 0; index < referenceId.length; index += 1) {
    const code = referenceId.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `liked-style:${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

export const chatRelationshipAsyncStorageBusinessPort: ChatRelationshipBusinessPort = {
  upsertRecord: (input) => enqueueRelationshipApply(() => upsertRecord(input)),
  tombstone: (input) => enqueueRelationshipApply(() => tombstone(input)),
};
