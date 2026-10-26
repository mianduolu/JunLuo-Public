import type { ChatCoreMutationEnvelope } from './syncChatCore';
import {
  buildScheduleSemanticMutation,
  assertScheduleSemanticRecord,
  assertChatReminderMetadata,
  SCHEDULE_DAY_TEMPLATE_FIELDS,
  SCHEDULE_GOAL_CATEGORIES,
  scheduleSemanticEntityId,
  scheduleSemanticEntityTypeForKind,
  scheduleSemanticRecordPayload,
  type ScheduleSemanticEntityType,
  type ScheduleSemanticRecordKind,
} from './syncScheduleSemantic';
import type { JsonValue, PlainMutationV1 } from './syncProtocol';

export const SCHEDULE_DAY_TEMPLATE_STORAGE_KEY =
  'junluo.schedule.day-template.v1' as const;
export const SCHEDULE_GOAL_COOLDOWN_STORAGE_KEY =
  'junluo.schedule.goal-suggestion-cooldowns.v1' as const;
export const SCHEDULE_PENDING_REQUEST_STORAGE_KEY =
  'junluo.schedule.pendingRequest' as const;
export const SCHEDULE_ALARM_STORAGE_KEY =
  'junluo.alarm.records.v1' as const;

export const SCHEDULE_SEMANTIC_GLOBAL_STORAGE_KEYS = Object.freeze([
  SCHEDULE_DAY_TEMPLATE_STORAGE_KEY,
  SCHEDULE_GOAL_COOLDOWN_STORAGE_KEY,
  SCHEDULE_PENDING_REQUEST_STORAGE_KEY,
  SCHEDULE_ALARM_STORAGE_KEY,
] as const);

export type ScheduleSemanticStorageChange =
  | { kind: 'set'; key: string; value: string }
  | { kind: 'remove'; key: string };

export type ScheduleSemanticStorageReadPort = {
  getItem(key: string): Promise<string | null>;
};

export type ScheduleSemanticEnvelopeFactory = (
  entity: {
    domain: 'schedule';
    type: ScheduleSemanticEntityType;
    id: string;
  },
) => Promise<ChatCoreMutationEnvelope>;

export type ScheduleSemanticProjectedRecord = {
  kind: ScheduleSemanticRecordKind;
  record: JsonValue & Record<string, JsonValue>;
};

const ALARM_STATUSES = new Set(['pending', 'delivered', 'cancelled']);
const ALARM_SOUND_MODES = new Set(['notification', 'music', 'strong']);
const MUSIC_PLAY_STATUSES = new Set(['pending', 'played', 'failed', 'skipped']);
const STRONG_RING_STATUSES = new Set(['pending', 'started', 'failed', 'stopped']);
const STRONG_RINGTONES = new Set(['default', 'gentle', 'urgent']);

function recordOf(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parseJson(raw: string, label: string) {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${label} 不是有效 JSON。`);
  }
}

function boolean(value: unknown, fallback: boolean) {
  return typeof value === 'boolean' ? value : fallback;
}

function projectDayTemplate(value: unknown) {
  const candidate = recordOf(value);
  return SCHEDULE_DAY_TEMPLATE_FIELDS.flatMap((field) => {
    const [group, child] = field.split('.');
    const source = child ? recordOf(candidate[group]) : candidate;
    const key = child ?? group;
    // Missing legacy fields carry no instruction. A new edit explicitly clears
    // an omitted duration, whose local representation is undefined.
    const clearsDuration = child === 'durationMinutes' && !!candidate.operationId && group in candidate;
    if (!(key in source) && !clearsDuration) return [];
    const record: Record<string, JsonValue> = { field, value: (source[key] ?? null) as JsonValue };
    if (typeof candidate.operationId === 'string') record.operationId = candidate.operationId;
    assertScheduleSemanticRecord('day-template-field', record);
    return [{ kind: 'day-template-field' as const, record }];
  });
}

function projectGoalCooldowns(value: unknown) {
  const candidate = recordOf(value);
  return SCHEDULE_GOAL_CATEGORIES.flatMap((category) => {
    const until = candidate[category];
    if (!Number.isSafeInteger(until) || (until as number) < 0) return [];
    return [{
      kind: 'goal-suggestion-cooldown' as const,
      record: {
        category,
        until: until as number,
      },
    }];
  });
}

function stringOrNull(value: unknown, maximumLength: number) {
  if (typeof value !== 'string') return null;
  return value.slice(0, maximumLength);
}

function timestampOrNull(value: unknown) {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? value as number
    : null;
}

function enumOrNull(value: unknown, allowed: ReadonlySet<string>) {
  return typeof value === 'string' && allowed.has(value) ? value : null;
}

function projectSharedCover(value: unknown) {
  if (typeof value !== 'string') return '';
  const cover = value.slice(0, 4096);
  return /^(?:file|content|asset-library|ph|blob):/i.test(cover)
    ? ''
    : cover;
}

function projectMusicSong(value: unknown) {
  const candidate = recordOf(value);
  if (
    typeof candidate.id !== 'string'
    || !candidate.id.trim()
    || typeof candidate.name !== 'string'
    || !candidate.name.trim()
  ) {
    return null;
  }
  const duration = typeof candidate.duration === 'number'
    && Number.isFinite(candidate.duration)
    && candidate.duration >= 0
    ? candidate.duration
    : 0;
  return {
    id: candidate.id.trim().slice(0, 512),
    name: candidate.name.trim().slice(0, 1000),
    artist: typeof candidate.artist === 'string'
      ? candidate.artist.slice(0, 1000)
      : '',
    album: typeof candidate.album === 'string'
      ? candidate.album.slice(0, 1000)
      : '',
    cover: projectSharedCover(candidate.cover),
    duration,
  };
}

function projectAlarm(value: unknown): ScheduleSemanticProjectedRecord | null {
  const candidate = recordOf(value);
  assertChatReminderMetadata(candidate.chatReminder);
  if (
    typeof candidate.id !== 'string'
    || !candidate.id
    || typeof candidate.title !== 'string'
    || !Number.isSafeInteger(candidate.triggerAt)
    || (candidate.triggerAt as number) < 0
  ) {
    return null;
  }
  const soundMode = typeof candidate.soundMode === 'string'
    && ALARM_SOUND_MODES.has(candidate.soundMode)
    ? candidate.soundMode
    : 'notification';
  const rawMusicStatus = enumOrNull(
    candidate.musicPlayStatus,
    MUSIC_PLAY_STATUSES,
  );
  const record = {
    ...(candidate.chatReminder ? { chatReminder: candidate.chatReminder as JsonValue } : {}),
    id: candidate.id.slice(0, 250),
    title: candidate.title.slice(0, 1000),
    message: typeof candidate.message === 'string'
      ? candidate.message.slice(0, 10_000)
      : candidate.title.slice(0, 10_000),
    triggerAt: candidate.triggerAt as number,
    status: typeof candidate.status === 'string'
      && ALARM_STATUSES.has(candidate.status)
      ? candidate.status
      : 'pending',
    soundMode,
    musicKeyword: stringOrNull(candidate.musicKeyword, 1000),
    musicSong: projectMusicSong(candidate.musicSong),
    musicFallbackToNotification:
      typeof candidate.musicFallbackToNotification === 'boolean'
        ? candidate.musicFallbackToNotification
        : null,
    musicPlayStatus: candidate.chatReminder ? null : rawMusicStatus
      ?? (soundMode === 'music' ? 'pending' : null),
    musicPlayAttemptedAt: timestampOrNull(candidate.musicPlayAttemptedAt),
    musicPlayResultSummary: stringOrNull(
      candidate.musicPlayResultSummary,
      10_000,
    ),
    musicPlayErrorMessage: stringOrNull(
      candidate.musicPlayErrorMessage,
      10_000,
    ),
    strongAlarmRingtone: enumOrNull(
      candidate.strongAlarmRingtone,
      STRONG_RINGTONES,
    ),
    strongAlarmRingStatus: enumOrNull(
      candidate.strongAlarmRingStatus,
      STRONG_RING_STATUSES,
    ),
    strongAlarmTriggeredAt: timestampOrNull(candidate.strongAlarmTriggeredAt),
    strongAlarmNotificationShown:
      typeof candidate.strongAlarmNotificationShown === 'boolean'
        ? candidate.strongAlarmNotificationShown
        : null,
    vibrate: typeof candidate.vibrate === 'boolean'
      ? candidate.vibrate
      : null,
    createdAt: timestampOrNull(candidate.createdAt) ?? 0,
    updatedAt: timestampOrNull(candidate.updatedAt) ?? 0,
    cancelledAt: timestampOrNull(candidate.cancelledAt),
  };
  return {
    kind: 'alarm',
    record,
  };
}

function projectAlarmRecords(value: unknown) {
  if (!Array.isArray(value)) return [];
  const byId = new Map<string, ScheduleSemanticProjectedRecord>();
  for (const item of value) {
    const projected = projectAlarm(item);
    if (projected) {
      byId.set(String(projected.record.id), projected);
    }
  }
  return [...byId.values()].sort((left, right) => (
    String(left.record.id).localeCompare(String(right.record.id))
  ));
}

function projectPendingRequest(raw: string, capturedAt: number) {
  const request = raw.trim();
  if (!request) return [];
  return [{
    kind: 'schedule-request' as const,
    record: {
      request: request.slice(0, 20_000),
      status: 'pending',
      updatedAt: capturedAt,
    },
  }];
}

export function isScheduleSemanticGlobalStorageKey(key: string) {
  return (
    SCHEDULE_SEMANTIC_GLOBAL_STORAGE_KEYS as readonly string[]
  ).includes(key);
}

export function projectScheduleSemanticStorageValue(input: {
  key: string;
  raw: string;
  capturedAt: number;
}): ScheduleSemanticProjectedRecord[] {
  if (input.key === SCHEDULE_PENDING_REQUEST_STORAGE_KEY) {
    return projectPendingRequest(input.raw, input.capturedAt);
  }
  const parsed = parseJson(
    input.raw,
    `schedule.semantic ${input.key}`,
  );
  if (input.key === SCHEDULE_DAY_TEMPLATE_STORAGE_KEY) {
    return projectDayTemplate(parsed);
  }
  if (input.key === SCHEDULE_GOAL_COOLDOWN_STORAGE_KEY) {
    return projectGoalCooldowns(parsed);
  }
  if (input.key === SCHEDULE_ALARM_STORAGE_KEY) {
    return projectAlarmRecords(parsed);
  }
  throw new Error(`schedule.semantic 未登记 storage key：${input.key}。`);
}

function sameValue(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function byIdentity(records: readonly ScheduleSemanticProjectedRecord[]) {
  return new Map(records.map((item) => [
    scheduleSemanticEntityId(item.kind, item.record),
    item,
  ]));
}

async function mutationForRecord(input: {
  projected: ScheduleSemanticProjectedRecord;
  envelopeFactory: ScheduleSemanticEnvelopeFactory;
}) {
  const entityType = scheduleSemanticEntityTypeForKind(input.projected.kind);
  const entityId = scheduleSemanticEntityId(
    input.projected.kind,
    input.projected.record,
  );
  const envelope = await input.envelopeFactory({
    domain: 'schedule',
    type: entityType,
    id: entityId,
  });
  return buildScheduleSemanticMutation({
    envelope,
    entityType,
    entityId,
    operation: 'upsert',
    payload: scheduleSemanticRecordPayload(input.projected),
  });
}

export async function deriveScheduleSemanticMutationsForStorageChanges(
  input: {
    changes: readonly ScheduleSemanticStorageChange[];
    reader: ScheduleSemanticStorageReadPort;
    capturedAt: number;
    envelopeFactory: ScheduleSemanticEnvelopeFactory;
  },
): Promise<PlainMutationV1[]> {
  const mutations: PlainMutationV1[] = [];
  for (const change of input.changes) {
    if (!isScheduleSemanticGlobalStorageKey(change.key)) continue;
    const previousRaw = await input.reader.getItem(change.key);
    if (
      change.kind === 'remove'
      && change.key !== SCHEDULE_PENDING_REQUEST_STORAGE_KEY
    ) {
      // 清理模板、节流或旧闹钟缓存不能被解释成全局删除。
      continue;
    }
    if (change.kind === 'remove') {
      if (!previousRaw?.trim()) continue;
      const projected: ScheduleSemanticProjectedRecord = {
        kind: 'schedule-request',
        record: {
          request: previousRaw.trim().slice(0, 20_000),
          status: 'consumed',
          updatedAt: input.capturedAt,
        },
      };
      mutations.push(await mutationForRecord({
        projected,
        envelopeFactory: input.envelopeFactory,
      }));
      continue;
    }
    const next = projectScheduleSemanticStorageValue({
      key: change.key,
      raw: change.value,
      capturedAt: input.capturedAt,
    });
    let previous: ScheduleSemanticProjectedRecord[] = [];
    if (previousRaw !== null) {
      try {
        previous = projectScheduleSemanticStorageValue({
          key: change.key,
          raw: previousRaw,
          capturedAt: input.capturedAt,
        });
      } catch {
        previous = [];
      }
    }
    const previousById = byIdentity(previous);
    for (const projected of next) {
      const entityId = scheduleSemanticEntityId(
        projected.kind,
        projected.record,
      );
      const old = previousById.get(entityId);
      if (old && sameValue(old.record, projected.record)) continue;
      mutations.push(await mutationForRecord({
        projected,
        envelopeFactory: input.envelopeFactory,
      }));
    }
  }
  return mutations;
}
