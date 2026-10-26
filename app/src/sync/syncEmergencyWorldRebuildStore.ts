import AsyncStorage from '@react-native-async-storage/async-storage';

import { assertBackupRestoreAllowsOrdinarySync } from '../backup/backupRestoreSyncGate';

import {
  EMERGENCY_WORLD_REBUILD_ADAPTER_TOTAL,
  assertEmergencySyncWorldCutoverJournalV1,
  assertEmergencySyncWorldRebuildV1,
  emergencySyncWorldRebuildSnapshot,
  type EmergencySyncWorldCutoverJournalV1,
  type EmergencySyncWorldRebuildSnapshot,
  type EmergencySyncWorldRebuildV1,
} from './syncEmergencyWorldRebuild';

const REBUILD_STATE_KEY = '@junluo/sync/v2/emergency-rebuild:v1';
const CUTOVER_JOURNAL_KEY = '@junluo/sync/v2/emergency-cutover:v1';

type Listener = (snapshot: EmergencySyncWorldRebuildSnapshot) => void;

const listeners = new Set<Listener>();
let writeQueue: Promise<void> = Promise.resolve();

function parseState(raw: string | null) {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('紧急重建状态不是有效 JSON。');
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>;
    const completed = record.completedAdapters;
    if (record.version === 1 && record.totalAdapters === 41 && Number.isSafeInteger(completed)) {
      // The old current-action slot was capture index 9. Counts after it move once;
      // 41 marks the old fully verified catalog, not a capture page.
      if (completed === 41 || (Number(completed) >= 0 && Number(completed) <= 36)) {
        record.totalAdapters = 40;
        record.completedAdapters = completed === 41
          ? 40
          : Number(completed) > 9 ? Number(completed) - 1 : completed;
      }
    }
  }
  assertEmergencySyncWorldRebuildV1(parsed);
  if (parsed.version === 1) {
    // gifts.life is appended, so earlier capture indexes keep their meaning.
    return { ...parsed, version: 2 as const, totalAdapters: EMERGENCY_WORLD_REBUILD_ADAPTER_TOTAL,
      completedAdapters: parsed.phase === 'complete' ? EMERGENCY_WORLD_REBUILD_ADAPTER_TOTAL : parsed.completedAdapters };
  }
  return parsed;
}

function parseJournal(raw: string | null) {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('紧急切换日志不是有效 JSON。');
  }
  assertEmergencySyncWorldCutoverJournalV1(parsed);
  return parsed;
}

async function notify(state?: EmergencySyncWorldRebuildV1 | null) {
  const snapshot = emergencySyncWorldRebuildSnapshot(
    state === undefined ? await loadEmergencySyncWorldRebuild() : state,
  );
  for (const listener of listeners) listener(snapshot);
}

export async function loadEmergencySyncWorldRebuild() {
  await writeQueue;
  return parseState(await AsyncStorage.getItem(REBUILD_STATE_KEY));
}

export async function saveEmergencySyncWorldRebuild(
  state: EmergencySyncWorldRebuildV1,
) {
  assertEmergencySyncWorldRebuildV1(state);
  const operation = writeQueue.then(() => AsyncStorage.setItem(
    REBUILD_STATE_KEY,
    JSON.stringify(state),
  ));
  writeQueue = operation.then(() => undefined, () => undefined);
  await operation;
  await notify(state);
  return state;
}

export async function updateEmergencySyncWorldRebuild(
  update: (
    current: EmergencySyncWorldRebuildV1,
  ) => EmergencySyncWorldRebuildV1,
) {
  let next: EmergencySyncWorldRebuildV1 | null = null;
  const operation = writeQueue.then(async () => {
    const current = parseState(await AsyncStorage.getItem(REBUILD_STATE_KEY));
    if (!current) throw new Error('紧急重建会话不存在。');
    next = update(current);
    assertEmergencySyncWorldRebuildV1(next);
    await AsyncStorage.setItem(REBUILD_STATE_KEY, JSON.stringify(next));
  });
  writeQueue = operation.then(() => undefined, () => undefined);
  await operation;
  await notify(next);
  return next!;
}

export async function loadEmergencySyncWorldCutoverJournal() {
  await writeQueue;
  return parseJournal(await AsyncStorage.getItem(CUTOVER_JOURNAL_KEY));
}

export async function saveEmergencySyncWorldCutoverJournal(
  journal: EmergencySyncWorldCutoverJournalV1,
) {
  assertEmergencySyncWorldCutoverJournalV1(journal);
  const operation = writeQueue.then(() => AsyncStorage.setItem(
    CUTOVER_JOURNAL_KEY,
    JSON.stringify(journal),
  ));
  writeQueue = operation.then(() => undefined, () => undefined);
  await operation;
  return journal;
}

export async function clearEmergencySyncWorldCutoverJournal() {
  const operation = writeQueue.then(() => AsyncStorage.removeItem(
    CUTOVER_JOURNAL_KEY,
  ));
  writeQueue = operation.then(() => undefined, () => undefined);
  await operation;
}

export async function loadEmergencySyncWorldRebuildSnapshot() {
  return emergencySyncWorldRebuildSnapshot(
    await loadEmergencySyncWorldRebuild(),
  );
}

export function subscribeEmergencySyncWorldRebuild(
  listener: Listener,
) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export async function assertOrdinarySyncAllowed() {
  await assertBackupRestoreAllowsOrdinarySync();
  const state = await loadEmergencySyncWorldRebuild();
  if (state && state.phase !== 'complete') {
    throw new Error('同步世界正在重新建立，普通同步已暂停。');
  }
}

export function createInitialEmergencySyncWorldRebuild(input: {
  sessionId: string;
  oldVaultId: string;
  oldKeyId: string;
  now: number;
}): EmergencySyncWorldRebuildV1 {
  const state: EmergencySyncWorldRebuildV1 = Object.freeze({
    version: 2,
    sessionId: input.sessionId,
    phase: 'freezing-old-world',
    oldVaultId: input.oldVaultId,
    oldKeyId: input.oldKeyId,
    newVaultId: null,
    newKeyId: null,
    completedAdapters: 0,
    totalAdapters: EMERGENCY_WORLD_REBUILD_ADAPTER_TOTAL,
    completedFiles: 0,
    totalFiles: 0,
    missingFiles: 0,
    oldDeviceRevocation: 'not-attempted',
    lastErrorCode: null,
    startedAt: input.now,
    updatedAt: input.now,
  });
  assertEmergencySyncWorldRebuildV1(state);
  return state;
}
