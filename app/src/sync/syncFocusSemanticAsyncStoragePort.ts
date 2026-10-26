import RawAsyncStorage from '@react-native-async-storage/async-storage';

import { makeFocusSessionId } from '../focus/focusIdentity';
import type {
  FocusSemanticBusinessPort,
} from './syncFocusSemanticApply';
import {
  assertFocusSemanticRecord,
  preserveFocusReadingExtension,
  type FocusSemanticRecordKind,
} from './syncFocusSemantic';
import {
  FOCUS_ACTIVE_STORAGE_KEY,
  FOCUS_COMPANION_POLICY_STORAGE_KEY,
  FOCUS_INVITE_COOLDOWN_STORAGE_KEY,
  FOCUS_PENDING_INVITE_STORAGE_KEY,
  FOCUS_TAGS_STORAGE_KEY,
  projectFocusSemanticStorageValue,
} from './syncFocusSemanticStorageDerivation';
import type { JsonValue } from './syncProtocol';
import { runFocusSemanticCaptureExclusive } from './syncFocusSemanticCaptureQueue';

type FocusRecord = JsonValue & Record<string, JsonValue>;

function parseObject(raw: string | null) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function activeSessionId(active: Record<string, unknown>) {
  try {
    return makeFocusSessionId({
      startedAt: active.startedAt as number,
      mode: active.mode as string,
      userActivity: active.userActivity as string,
    });
  } catch {
    return null;
  }
}

async function upsertCurrentAgreement(record: FocusRecord) {
  const current = parseObject(
    await RawAsyncStorage.getItem(FOCUS_ACTIVE_STORAGE_KEY),
  );
  const sameSession = activeSessionId(current) === record.sessionId;
  const preserved = preserveFocusReadingExtension({ ...current,
    sessionId: activeSessionId(current) } as FocusRecord, record);
  const next = {
    ...(sameSession ? current : {
      elapsedSeconds: 0,
      logs: [],
      paused: true,
      totalPausedMs: 0,
    }),
    baiyunActivity: preserved.baiyunActivity,
    mode: record.mode,
    pomodoroGoal: record.pomodoroGoal ?? undefined,
    pomodoroLongBreakSeconds: record.pomodoroLongBreakSeconds ?? undefined,
    pomodoroShortBreakSeconds: record.pomodoroShortBreakSeconds ?? undefined,
    pomodoroWorkSeconds: record.pomodoroWorkSeconds ?? undefined,
    startedAt: record.startedAt,
    targetSeconds: record.targetSeconds ?? undefined,
    timerMode: record.timerMode,
    userActivity: record.userActivity,
    ...(preserved.reading !== undefined ? { reading: preserved.reading } : {}),
  };
  await RawAsyncStorage.setItem(
    FOCUS_ACTIVE_STORAGE_KEY,
    JSON.stringify(next),
  );
}

export async function upsertFocusLogIntoActiveStorage(record: FocusRecord) {
  const current = parseObject(
    await RawAsyncStorage.getItem(FOCUS_ACTIVE_STORAGE_KEY),
  );
  if (activeSessionId(current) !== record.sessionId) return;
  const logs = Array.isArray(current.logs) ? current.logs : [];
  const nextLog = {
    id: record.id,
    role: record.role,
    content: record.content,
    createdAt: record.createdAt,
    elapsedSeconds: record.elapsedSeconds,
    trigger: record.trigger,
  };
  const existingIndex = logs.findIndex((item) => (
    item
    && typeof item === 'object'
    && !Array.isArray(item)
    && (item as Record<string, unknown>).id === record.id
  ));
  const nextLogs = [...logs];
  if (existingIndex >= 0) nextLogs[existingIndex] = nextLog;
  else nextLogs.push(nextLog);
  await RawAsyncStorage.setItem(
    FOCUS_ACTIVE_STORAGE_KEY,
    JSON.stringify({ ...current, logs: nextLogs }),
  );
}

export async function deleteFocusLogFromActiveStorage(entityId: string) {
  const prefix = 'focus-log:';
  if (!entityId.startsWith(prefix)) return;
  const id = entityId.slice(prefix.length);
  const current = parseObject(
    await RawAsyncStorage.getItem(FOCUS_ACTIVE_STORAGE_KEY),
  );
  if (!Array.isArray(current.logs)) return;
  const logs = current.logs.filter((item) => !(
    item
    && typeof item === 'object'
    && !Array.isArray(item)
    && (item as Record<string, unknown>).id === id
  ));
  if (logs.length === current.logs.length) return;
  await RawAsyncStorage.setItem(
    FOCUS_ACTIVE_STORAGE_KEY,
    JSON.stringify({ ...current, logs }),
  );
}

async function upsertInvitation(record: FocusRecord) {
  const previous = parseObject(await RawAsyncStorage.getItem(FOCUS_PENDING_INVITE_STORAGE_KEY));
  const preserved = preserveFocusReadingExtension({ ...previous,
    id: `invite-${previous.createdAt}` } as FocusRecord, record);
  await RawAsyncStorage.setItem(
    FOCUS_PENDING_INVITE_STORAGE_KEY,
    JSON.stringify({
      baiyunActivity: record.baiyunActivity,
      createdAt: record.createdAt,
      message: record.message,
      mode: record.mode,
      ...(preserved.readingId !== undefined ? { readingId: preserved.readingId } : {}),
      ...(preserved.readingActivityId !== undefined ? { readingActivityId: preserved.readingActivityId } : {}),
    }),
  );
}

async function deleteInvitation(entityId: string) {
  const raw = await RawAsyncStorage.getItem(
    FOCUS_PENDING_INVITE_STORAGE_KEY,
  );
  const current = parseObject(raw);
  const createdAt = Number(current.createdAt);
  if (`focus-invitation:invite-${createdAt}` === entityId) {
    await RawAsyncStorage.removeItem(FOCUS_PENDING_INVITE_STORAGE_KEY);
  }
}

async function upsertPolicyField(record: FocusRecord) {
  const current = parseObject(
    await RawAsyncStorage.getItem(FOCUS_COMPANION_POLICY_STORAGE_KEY),
  );
  await RawAsyncStorage.setItem(
    FOCUS_COMPANION_POLICY_STORAGE_KEY,
    JSON.stringify({ ...current, [record.field as string]: record.value }),
  );
}

async function deletePolicyField(entityId: string) {
  const prefix = 'companion-policy:';
  if (!entityId.startsWith(prefix)) return;
  const field = entityId.slice(prefix.length);
  const current = parseObject(
    await RawAsyncStorage.getItem(FOCUS_COMPANION_POLICY_STORAGE_KEY),
  );
  if (!(field in current)) return;
  delete current[field];
  if (Object.keys(current).length) {
    await RawAsyncStorage.setItem(
      FOCUS_COMPANION_POLICY_STORAGE_KEY,
      JSON.stringify(current),
    );
  } else {
    await RawAsyncStorage.removeItem(FOCUS_COMPANION_POLICY_STORAGE_KEY);
  }
}

async function changeTag(record: FocusRecord | null, entityId: string) {
  const raw = await RawAsyncStorage.getItem(FOCUS_TAGS_STORAGE_KEY);
  const tags = raw === null ? [] : projectFocusSemanticStorageValue({
    key: FOCUS_TAGS_STORAGE_KEY, raw,
  }).map(item => item.record);
  const id = entityId.slice('focus-tag:'.length);
  const index = tags.findIndex(tag => tag.id === id);
  if (record) {
    if (index < 0) tags.push(record);
    else tags[index] = record;
  } else {
    if (index < 0) return;
    tags.splice(index, 1);
  }
  // Incoming changes materialize exactly one ID through Raw storage: no echo
  // capture, no replacement of unrelated tags or saved session snapshots.
  await RawAsyncStorage.setItem(FOCUS_TAGS_STORAGE_KEY, JSON.stringify(tags));
}

const STORAGE_KINDS = new Set<FocusSemanticRecordKind>([
  'focus-current-agreement',
  'focus-invitation',
  'focus-invite-cooldown',
  'companion-policy-field',
  'focus-tag',
]);

export const focusSemanticAsyncStorageBusinessPort:
FocusSemanticBusinessPort = {
  async upsertRecord(input) {
    if (!STORAGE_KINDS.has(input.kind)) {
      throw new Error(`focus AsyncStorage 不处理 ${input.kind}。`);
    }
    assertFocusSemanticRecord(input.kind, input.record);
    if (input.kind === 'focus-tag') {
      await runFocusSemanticCaptureExclusive(() => changeTag(input.record, input.entityId));
    } else if (input.kind === 'focus-current-agreement') {
      await upsertCurrentAgreement(input.record);
    } else if (input.kind === 'focus-invitation') {
      await upsertInvitation(input.record);
    } else if (input.kind === 'focus-invite-cooldown') {
      await RawAsyncStorage.setItem(
        FOCUS_INVITE_COOLDOWN_STORAGE_KEY,
        String(input.record.offeredAt),
      );
    } else {
      await upsertPolicyField(input.record);
    }
  },
  async deleteRecord(input) {
    if (!STORAGE_KINDS.has(input.kind)) {
      throw new Error(`focus AsyncStorage 不处理 ${input.kind} tombstone。`);
    }
    if (input.kind === 'focus-tag') {
      await runFocusSemanticCaptureExclusive(() => changeTag(null, input.entityId));
    } else if (input.kind === 'focus-current-agreement') {
      await RawAsyncStorage.removeItem(FOCUS_ACTIVE_STORAGE_KEY);
    } else if (input.kind === 'focus-invitation') {
      await deleteInvitation(input.entityId);
    } else if (input.kind === 'focus-invite-cooldown') {
      await RawAsyncStorage.removeItem(FOCUS_INVITE_COOLDOWN_STORAGE_KEY);
    } else {
      await deletePolicyField(input.entityId);
    }
  },
};
