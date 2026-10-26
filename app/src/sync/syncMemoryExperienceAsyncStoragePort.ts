import RawAsyncStorage from '@react-native-async-storage/async-storage';

import type {
  MemoryExperienceBusinessPort,
} from './syncMemoryExperienceApply';
import {
  assertMemoryExperienceRecord,
} from './syncMemoryExperience';
import {
  MEMORY_EXPERIENCE_KEYS,
} from './syncMemoryExperienceStorageDerivation';
import type {
  JsonValue,
} from './syncProtocol';

type JsonRecord = { [key: string]: JsonValue };

let memoryExperienceApplyQueue = Promise.resolve();

function enqueueMemoryExperienceApply<T>(callback: () => Promise<T>) {
  const current = memoryExperienceApplyQueue
    .catch(() => undefined)
    .then(callback);
  memoryExperienceApplyQueue = current.then(
    () => undefined,
    () => undefined,
  );
  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
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

async function upsertDreamState(value: JsonValue) {
  if (!isRecord(value)) throw new Error('dream-state 必须是对象。');
  await writeJson(MEMORY_EXPERIENCE_KEYS.dreamState, value as JsonRecord);
}

async function upsertPendingDream(entityId: string, value: JsonValue) {
  if (!isRecord(value)) throw new Error('pending-dream 必须是对象。');
  const stored = await readJson(MEMORY_EXPERIENCE_KEYS.pendingDreams, []);
  const dreams = Array.isArray(stored)
    ? stored.filter(isRecord)
    : [];
  let replaced = false;
  const next = dreams.map((dream) => {
    if (dream.id !== entityId) return dream;
    replaced = true;
    return value;
  });
  if (!replaced) next.push(value);
  next.sort(
    (left, right) => Number(left.createdAt ?? 0) - Number(right.createdAt ?? 0),
  );
  await writeJson(
    MEMORY_EXPERIENCE_KEYS.pendingDreams,
    next.slice(-5) as JsonValue,
  );
}

async function updateCooldown(
  memoryId: string,
  at: number | null,
) {
  const stored = await readJson(
    MEMORY_EXPERIENCE_KEYS.actionSuggestionCooldowns,
    {},
  );
  const cooldowns = isRecord(stored) ? { ...stored } : {};
  if (at === null) {
    delete cooldowns[memoryId];
  } else {
    cooldowns[memoryId] = at;
  }
  await writeJson(
    MEMORY_EXPERIENCE_KEYS.actionSuggestionCooldowns,
    cooldowns as JsonValue,
  );
}

async function upsertRecord(
  input: Parameters<MemoryExperienceBusinessPort['upsertRecord']>[0],
) {
  assertMemoryExperienceRecord(input.kind, input.entityId, input.value);
  const value = input.value as JsonRecord;
  switch (input.kind) {
    case 'dream-state':
      await upsertDreamState(input.value);
      return;
    case 'pending-dream':
      await upsertPendingDream(input.entityId, input.value);
      return;
    case 'action-suggestion-cooldown':
      await updateCooldown(value.memoryId as string, value.at as number);
      return;
    case 'baiyun-heart-viewed':
      await RawAsyncStorage.setItem(
        MEMORY_EXPERIENCE_KEYS.baiyunHeartViewed,
        value.memoryId as string,
      );
      return;
    case 'post-reading':
      await (await import('../posts/baiyunPostStore')).mergeSyncedBaiyunPostReading(value as unknown as import('./syncMemoryExperience').PostReadingSyncValueV1);
      return;
    case 'post-notice-read':
      await (await import('../posts/baiyunPostNotice')).mergeSyncedPostNoticeRead(value as unknown as import('./syncMemoryExperience').PostNoticeReadSyncValueV1);
      return;
  }
}

async function tombstone(
  input: Parameters<MemoryExperienceBusinessPort['tombstone']>[0],
) {
  if (input.entityType === 'dream') {
    if (input.entityId === 'engine-state') {
      await RawAsyncStorage.removeItem(MEMORY_EXPERIENCE_KEYS.dreamState);
      return;
    }
    const stored = await readJson(MEMORY_EXPERIENCE_KEYS.pendingDreams, []);
    const dreams = Array.isArray(stored)
      ? stored.filter(isRecord)
      : [];
    await writeJson(
      MEMORY_EXPERIENCE_KEYS.pendingDreams,
      dreams.filter((dream) => dream.id !== input.entityId) as JsonValue,
    );
    return;
  }
  if (input.entityId === 'baiyun-heart-viewed') {
    await RawAsyncStorage.removeItem(
      MEMORY_EXPERIENCE_KEYS.baiyunHeartViewed,
    );
    return;
  }
  if (input.entityId === 'post-reading') {
    await (await import('../posts/baiyunPostStore')).mergeSyncedBaiyunPostReading(null); return;
  }
  if (input.entityId === 'post-notice-read') {
    await (await import('../posts/baiyunPostNotice')).mergeSyncedPostNoticeRead(null); return;
  }
  const prefix = 'action-suggestion:';
  if (input.entityId.startsWith(prefix)) {
    await updateCooldown(input.entityId.slice(prefix.length), null);
  }
}

export const memoryExperienceAsyncStorageBusinessPort:
MemoryExperienceBusinessPort = {
  upsertRecord: (input) => enqueueMemoryExperienceApply(
    () => upsertRecord(input),
  ),
  tombstone: (input) => enqueueMemoryExperienceApply(
    () => tombstone(input),
  ),
};
