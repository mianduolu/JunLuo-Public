import RawAsyncStorage from '@react-native-async-storage/async-storage';
import { captureBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { runNearbyWorldDataEpochCommit } from '../nearby/nearbyWorldEpochCoordinator';

import { getSecretItem } from '../storage/secretStore';
import {
  assertNearbyWorldLocationObservation,
  assertNearbyWorldMovementEvent,
  assertNearbyWorldSettingsFieldValue,
  type NearbyWorldLocationObservation,
  type NearbyWorldMovementEvent,
} from './syncNearbyWorldHealth';
import type {
  NearbyWorldHealthBusinessPort,
} from './syncNearbyWorldHealthApply';
import {
  NEARBY_WORLD_REMOTE_EVENTS_KEY,
  NEARBY_WORLD_REMOTE_OBSERVATIONS_KEY,
  NEARBY_WORLD_SYNC_SETTINGS_KEY,
  NEARBY_WORLD_SYNC_STATUS_KEY,
  NEARBY_WORLD_SYNC_ACTIVE_EVENTS_KEY,
} from './syncNearbyWorldHealthStorageDerivation';

const CURRENT_SYNC_DEVICE_ID_KEY =
  'junluo.sync.current-device-id.v1' as const;

type UnknownRecord = Record<string, unknown>;
let nearbyWorldApplyQueue = Promise.resolve();

function enqueueNearbyWorldApply<T>(callback: () => Promise<T>) {
  const current = nearbyWorldApplyQueue
    .catch(() => undefined)
    .then(callback);
  nearbyWorldApplyQueue = current.then(
    () => undefined,
    () => undefined,
  );
  return current;
}

function recordOf(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as UnknownRecord) }
    : {};
}

async function loadRecord(key: string) {
  const raw = await RawAsyncStorage.getItem(key);
  if (!raw) return {};
  try {
    return recordOf(JSON.parse(raw) as unknown);
  } catch {
    return {};
  }
}

async function loadArray(key: string) {
  const raw = await RawAsyncStorage.getItem(key);
  if (!raw) return [] as UnknownRecord[];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.map(recordOf)
      : [];
  } catch {
    return [];
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  return `{${Object.entries(value as UnknownRecord)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => (
      `${JSON.stringify(key)}:${canonicalJson(entry)}`
    ))
    .join(',')}}`;
}

async function writeSettingsField(
  input: Parameters<NearbyWorldHealthBusinessPort['upsertSettingsField']>[0],
) {
  assertNearbyWorldSettingsFieldValue(input.field, input.value);
  const settings = await loadRecord(NEARBY_WORLD_SYNC_SETTINGS_KEY);
  if (input.field === 'home' && input.value === null) {
    delete settings.home;
  } else {
    settings[input.field] = input.value;
  }
  await RawAsyncStorage.setItem(
    NEARBY_WORLD_SYNC_SETTINGS_KEY,
    JSON.stringify(settings),
  );
}

function dayShard(timestamp: number) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function monthShard(timestamp: number) {
  return new Date(timestamp).toISOString().slice(0, 7);
}

function observationStorageKey(value: NearbyWorldLocationObservation) {
  return `${NEARBY_WORLD_REMOTE_OBSERVATIONS_KEY}:${value.sourceDeviceId}:${dayShard(value.observedAt)}`;
}

function eventStorageKey(value: NearbyWorldMovementEvent) {
  return `${NEARBY_WORLD_REMOTE_EVENTS_KEY}:${value.sourceDeviceId}:${monthShard(value.observedAt)}`;
}

async function appendImmutable(
  key: string,
  value: UnknownRecord,
  timestampField: 'observedAt',
  retainedUntil?: number,
) {
  const now = Date.now();
  if (retainedUntil !== undefined && retainedUntil <= now) return;
  const current = await loadArray(key);
  const id = typeof value.id === 'string' ? value.id : '';
  const existing = current.find((entry) => entry.id === id);
  if (existing) {
    if (canonicalJson(existing) !== canonicalJson(value)) {
      throw new Error('nearby-world immutable record identity 冲突。');
    }
    return;
  }
  const next = [
    ...current.filter((entry) => (
      retainedUntil === undefined
      || typeof entry.retainedUntil !== 'number'
      || entry.retainedUntil > now
    )),
    value,
  ].sort((left, right) => (
    Number(left[timestampField] ?? 0)
    - Number(right[timestampField] ?? 0)
  ));
  await RawAsyncStorage.setItem(key, JSON.stringify(next));
}

async function appendLocationObservation(
  input: Parameters<NearbyWorldHealthBusinessPort['appendLocationObservation']>[0],
) {
  assertNearbyWorldLocationObservation(
    input.observation,
    input.observation.id,
    input.revision.sourceDeviceId,
  );
  await appendImmutable(
    observationStorageKey(input.observation),
    input.observation,
    'observedAt',
    input.observation.retainedUntil,
  );
}

async function appendMovementEvent(
  input: Parameters<NearbyWorldHealthBusinessPort['appendMovementEvent']>[0],
) {
  assertNearbyWorldMovementEvent(
    input.event,
    input.event.id,
    input.revision.sourceDeviceId,
  );
  await appendImmutable(
    eventStorageKey(input.event),
    input.event,
    'observedAt',
  );
}

async function deleteLocationObservation(
  input: Parameters<
    NearbyWorldHealthBusinessPort['deleteLocationObservation']
  >[0],
) {
  const keys = await RawAsyncStorage.getAllKeys();
  const shardPrefix = `${NEARBY_WORLD_REMOTE_OBSERVATIONS_KEY}:`;
  for (const key of keys.filter((candidate) => (
    candidate.startsWith(shardPrefix)
  ))) {
    const current = await loadArray(key);
    const next = current.filter((entry) => entry.id !== input.entityId);
    if (next.length === current.length) continue;
    if (next.length) {
      await RawAsyncStorage.setItem(key, JSON.stringify(next));
    } else {
      await RawAsyncStorage.removeItem(key);
    }
  }

  const [currentDeviceId, localStatusRaw] = await Promise.all([
    getSecretItem(CURRENT_SYNC_DEVICE_ID_KEY),
    RawAsyncStorage.getItem(NEARBY_WORLD_SYNC_STATUS_KEY),
  ]);
  if (!currentDeviceId || !localStatusRaw) return;
  try {
    const status = recordOf(JSON.parse(localStatusRaw) as unknown);
    const updatedAt = Number(status.updatedAt);
    if (
      Number.isSafeInteger(updatedAt)
      && input.entityId
        === `nearby-location:${currentDeviceId}:${updatedAt}`
    ) {
      await RawAsyncStorage.removeItem(NEARBY_WORLD_SYNC_STATUS_KEY);
    }
  } catch {
    // 损坏的业务状态由既有 store 恢复；墓碑不扩大删除范围。
  }
}

async function deleteMovementEvent(
  input: Parameters<
    NearbyWorldHealthBusinessPort['deleteMovementEvent']
  >[0],
) {
  const dataEpoch = captureBackupRestoreDataEpoch();
  const keys = await RawAsyncStorage.getAllKeys();
  const shardPrefix = `${NEARBY_WORLD_REMOTE_EVENTS_KEY}:`;
  for (const key of keys.filter((candidate) => (
    candidate.startsWith(shardPrefix)
  ))) {
    const current = await loadArray(key);
    const next = current.filter((entry) => entry.id !== input.entityId);
    if (next.length === current.length) continue;
    if (next.length) {
      await RawAsyncStorage.setItem(key, JSON.stringify(next));
    } else {
      await RawAsyncStorage.removeItem(key);
    }
  }
  const committed = await runNearbyWorldDataEpochCommit(dataEpoch, async () => {
    const raw = await RawAsyncStorage.getItem(NEARBY_WORLD_SYNC_ACTIVE_EVENTS_KEY);
    if (!raw) return;
    // A corrupt/read-failed source must remain unavailable; never replace it by empty history.
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('outing state unavailable');
    const state = recordOf(parsed);
    if (state.outing === undefined) return;
    const outing = recordOf(state.outing);
    if (!Array.isArray(outing.segments)) throw new Error('outing segments missing');
    const segments = outing.segments.filter(value => recordOf(value).id !== input.entityId);
    if (segments.length === outing.segments.length) return;
    const current = recordOf(outing.current);
    const next: UnknownRecord = { ...outing, segments };
    if (outing.current && !segments.some(value => {
      const segment = recordOf(value);
      return segment.outingId === current.id && segment.occurredAt === current.firstRecordedAt;
    })) delete next.current;
    await RawAsyncStorage.setItem(NEARBY_WORLD_SYNC_ACTIVE_EVENTS_KEY, JSON.stringify({ ...state, outing: next }));
  });
  if (!committed.committed) throw new Error('nearby outing delete epoch invalid');
}

export const nearbyWorldHealthAsyncStorageBusinessPort:
NearbyWorldHealthBusinessPort = {
  upsertSettingsField: (input) => enqueueNearbyWorldApply(
    () => writeSettingsField(input),
  ),
  appendLocationObservation: (input) => enqueueNearbyWorldApply(
    () => appendLocationObservation(input),
  ),
  deleteLocationObservation: (input) => enqueueNearbyWorldApply(
    () => deleteLocationObservation(input),
  ),
  deleteMovementEvent: (input) => enqueueNearbyWorldApply(
    () => deleteMovementEvent(input),
  ),
  appendMovementEvent: (input) => enqueueNearbyWorldApply(
    () => appendMovementEvent(input),
  ),
};
