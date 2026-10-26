import RawAsyncStorage from '@react-native-async-storage/async-storage';

import type {
  ScheduleSemanticBusinessPort,
} from './syncScheduleSemanticApply';
import {
  assertScheduleSemanticRecord,
  assertChatReminderMetadata,
  type ScheduleDayTemplateField,
} from './syncScheduleSemantic';
import {
  runScheduleSemanticCaptureExclusive,
  runAlarmStoreMutation,
} from './syncScheduleSemanticCaptureQueue';
import {
  SCHEDULE_ALARM_STORAGE_KEY,
  SCHEDULE_DAY_TEMPLATE_STORAGE_KEY,
  SCHEDULE_GOAL_COOLDOWN_STORAGE_KEY,
  SCHEDULE_PENDING_REQUEST_STORAGE_KEY,
} from './syncScheduleSemanticStorageDerivation';
import type { JsonValue } from './syncProtocol';

async function loadRawObject(key: string) {
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

async function loadRawArray(key: string) {
  const raw = await RawAsyncStorage.getItem(key);
  if (raw === null) return [] as unknown[];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw new Error('schedule-semantic-storage-corrupt-records');
    return [...parsed];
  } catch {
    throw new Error('schedule-semantic-storage-corrupt-json');
  }
}

function nestedObject(
  parent: Record<string, unknown>,
  key: string,
) {
  const current = parent[key];
  if (current && typeof current === 'object' && !Array.isArray(current)) {
    return { ...(current as Record<string, unknown>) };
  }
  return {} as Record<string, unknown>;
}

async function writeDayTemplateField(
  field: ScheduleDayTemplateField,
  value: JsonValue,
  operationId?: JsonValue,
) {
  const template = await loadRawObject(SCHEDULE_DAY_TEMPLATE_STORAGE_KEY);
  if (template.operationId && !operationId) return;
  template.version = 1;
  if (typeof operationId === 'string') template.operationId = operationId;
  const [group, child] = field.split('.');
  if (child) {
    const nested = nestedObject(template, group);
    if (value === null) delete nested[child];
    else nested[child] = value;
    template[group] = nested;
  } else {
    template[field] = value;
  }
  await RawAsyncStorage.setItem(
    SCHEDULE_DAY_TEMPLATE_STORAGE_KEY,
    JSON.stringify(template),
  );
}

async function writeGoalCooldown(
  category: string,
  until: number,
) {
  const cooldowns = await loadRawObject(SCHEDULE_GOAL_COOLDOWN_STORAGE_KEY);
  cooldowns[category] = until;
  await RawAsyncStorage.setItem(
    SCHEDULE_GOAL_COOLDOWN_STORAGE_KEY,
    JSON.stringify(cooldowns),
  );
}

function applyNullableField(
  target: Record<string, unknown>,
  field: string,
  value: JsonValue,
) {
  if (value === null) {
    delete target[field];
    return;
  }
  target[field] = value;
}

async function writeAlarm(record: Record<string, JsonValue>) {
  const alarms = await loadRawArray(SCHEDULE_ALARM_STORAGE_KEY);
  const ids = new Set<string>();
  for (const value of alarms) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('schedule-semantic-storage-corrupt-alarm');
    const existing = value as Record<string, unknown>;
    if (typeof existing.id !== 'string' || !existing.id.trim() || ids.has(existing.id)
      || typeof existing.title !== 'string' || typeof existing.triggerAt !== 'number' || !Number.isFinite(existing.triggerAt)) {
      throw new Error('schedule-semantic-storage-corrupt-alarm');
    }
    ids.add(existing.id);
    assertChatReminderMetadata(existing.chatReminder);
    if (existing.chatReminder && (typeof existing.message !== 'string' || !Number.isSafeInteger(existing.triggerAt)
      || !Number.isSafeInteger(existing.createdAt) || !Number.isSafeInteger(existing.updatedAt)
      || !['pending', 'delivered', 'cancelled'].includes(String(existing.status))
      || existing.soundMode !== (existing.chatReminder as Record<string, unknown>).mode)) throw new Error('schedule-semantic-storage-corrupt-alarm');
  }
  const index = alarms.findIndex((value) => (
    !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value as Record<string, unknown>).id === record.id
  ));
  const existing = index >= 0
    ? {
        ...(alarms[index] as Record<string, unknown>),
      }
    : {};
  for (const [field, value] of Object.entries(record)) {
    applyNullableField(existing, field, value);
  }
  const next = index >= 0
    ? alarms.map((value, itemIndex) => (
        itemIndex === index ? existing : value
      ))
    : [...alarms, existing];
  await RawAsyncStorage.setItem(
    SCHEDULE_ALARM_STORAGE_KEY,
    JSON.stringify(next),
  );
}

async function writeStorageRecord(input: {
  kind:
    | 'day-template-field'
    | 'goal-suggestion-cooldown'
    | 'schedule-request'
    | 'alarm';
  record: JsonValue & Record<string, JsonValue>;
}) {
  assertScheduleSemanticRecord(input.kind, input.record);
  if (input.kind === 'day-template-field') {
    await writeDayTemplateField(
      input.record.field as ScheduleDayTemplateField,
      input.record.value,
      input.record.operationId,
    );
    return;
  }
  if (input.kind === 'goal-suggestion-cooldown') {
    await writeGoalCooldown(
      input.record.category as string,
      input.record.until as number,
    );
    return;
  }
  if (input.kind === 'schedule-request') {
    if (input.record.status === 'consumed') {
      await RawAsyncStorage.removeItem(SCHEDULE_PENDING_REQUEST_STORAGE_KEY);
    } else {
      await RawAsyncStorage.setItem(
        SCHEDULE_PENDING_REQUEST_STORAGE_KEY,
        input.record.request as string,
      );
    }
    return;
  }
  await writeAlarm(input.record);
}

export const scheduleSemanticAsyncStorageBusinessPort:
ScheduleSemanticBusinessPort = {
  upsertRecord: (input) => {
    const apply = () => runScheduleSemanticCaptureExclusive(async () => {
      if (
        input.kind !== 'day-template-field'
        && input.kind !== 'goal-suggestion-cooldown'
        && input.kind !== 'schedule-request'
        && input.kind !== 'alarm'
      ) {
        throw new Error(
          `schedule.semantic AsyncStorage port 不处理 ${input.kind}。`,
        );
      }
      await writeStorageRecord({
        kind: input.kind,
        record: input.record,
      });
    });
    return input.kind === 'alarm' ? runAlarmStoreMutation(apply) : apply();
  },
  deleteRecord: async (input) => {
    throw new Error(
      `schedule.semantic AsyncStorage port 不处理 ${input.kind} tombstone。`,
    );
  },
};
