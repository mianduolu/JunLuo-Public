import { makeFocusSessionId } from '../focus/focusIdentity';
import type { ChatCoreMutationEnvelope } from './syncChatCore';
import {
  buildFocusSemanticMutation,
  assertFocusSemanticRecord,
  focusSemanticDeletePayload,
  focusSemanticEntityId,
  focusSemanticEntityTypeForKind,
  focusSemanticRecordPayload,
  type FocusSemanticEntityType,
  type FocusSemanticRecordKind,
} from './syncFocusSemantic';
import type { JsonValue, PlainMutationV1 } from './syncProtocol';

export const FOCUS_ACTIVE_STORAGE_KEY =
  'junluo.focus.activeSession' as const;
export const FOCUS_PENDING_INVITE_STORAGE_KEY =
  'junluo.focus.pendingInvite' as const;
export const FOCUS_INVITE_COOLDOWN_STORAGE_KEY =
  'junluo.focus.lastInviteOfferedAt' as const;
export const FOCUS_COMPANION_POLICY_STORAGE_KEY =
  'junluo.focus.companionPolicy.v1' as const;
export const FOCUS_TAGS_STORAGE_KEY = 'junluo.focus.tags.v1' as const;

export const FOCUS_SEMANTIC_GLOBAL_STORAGE_KEYS = Object.freeze([
  FOCUS_ACTIVE_STORAGE_KEY,
  FOCUS_PENDING_INVITE_STORAGE_KEY,
  FOCUS_INVITE_COOLDOWN_STORAGE_KEY,
  FOCUS_COMPANION_POLICY_STORAGE_KEY,
  FOCUS_TAGS_STORAGE_KEY,
] as const);

export type FocusSemanticStorageChange =
  | { kind: 'set'; key: string; value: string }
  | { kind: 'remove'; key: string };

export type FocusSemanticStorageReadPort = {
  getItem(key: string): Promise<string | null>;
};

export type FocusSemanticEnvelopeFactory = (
  entity: {
    domain: 'focus';
    type: FocusSemanticEntityType;
    id: string;
  },
) => Promise<ChatCoreMutationEnvelope>;

export type FocusSemanticProjectedRecord = {
  kind: FocusSemanticRecordKind;
  record: JsonValue & Record<string, JsonValue>;
};

const FOCUS_MODES = new Set(['support', 'cowork']);
const TIMER_MODES = new Set(['stopwatch', 'countdown', 'pomodoro']);
const LOG_ROLES = new Set(['system', 'I', 'you']);
const POLICY_FIELDS = [
  'idleMinutes',
  'defaultLeaveMinutes',
  'growthDelaySeconds',
  'growthFillSeconds',
] as const;

function recordOf(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parseJson(raw: string) {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function string(value: unknown, maximumLength: number, allowEmpty = false) {
  if (typeof value !== 'string') return null;
  const normalized = value.slice(0, maximumLength);
  if (!allowEmpty && !normalized.length) return null;
  return normalized;
}

function timestamp(value: unknown) {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? value as number
    : null;
}

function integer(
  value: unknown,
  minimum: number,
  maximum: number,
) {
  return Number.isSafeInteger(value)
    && (value as number) >= minimum
    && (value as number) <= maximum
    ? value as number
    : null;
}

function nullableInteger(
  value: unknown,
  minimum: number,
  maximum: number,
) {
  return value === undefined || value === null
    ? null
    : integer(value, minimum, maximum);
}

function projectActiveSession(value: unknown) {
  const candidate = recordOf(value);
  const startedAt = timestamp(candidate.startedAt);
  const mode = typeof candidate.mode === 'string'
    && FOCUS_MODES.has(candidate.mode)
    ? candidate.mode
    : null;
  const timerMode = typeof candidate.timerMode === 'string'
    && TIMER_MODES.has(candidate.timerMode)
    ? candidate.timerMode
    : null;
  const userActivity = string(candidate.userActivity, 4_000);
  const baiyunActivity = string(candidate.baiyunActivity, 4_000, true);
  if (
    startedAt === null
    || mode === null
    || timerMode === null
    || userActivity === null
    || baiyunActivity === null
  ) {
    return [];
  }
  let sessionId: string;
  try {
    sessionId = makeFocusSessionId({
      startedAt,
      mode,
      userActivity,
    });
  } catch {
    return [];
  }
  const records: FocusSemanticProjectedRecord[] = [{
    kind: 'focus-current-agreement',
    record: {
      sessionId,
      mode,
      userActivity,
      baiyunActivity,
      startedAt,
      timerMode,
      targetSeconds: nullableInteger(
        candidate.targetSeconds,
        1,
        100_000_000,
      ),
      pomodoroGoal: nullableInteger(candidate.pomodoroGoal, 1, 10_000),
      pomodoroWorkSeconds: nullableInteger(
        candidate.pomodoroWorkSeconds,
        1,
        86_400,
      ),
      pomodoroShortBreakSeconds: nullableInteger(
        candidate.pomodoroShortBreakSeconds,
        1,
        86_400,
      ),
      pomodoroLongBreakSeconds: nullableInteger(
        candidate.pomodoroLongBreakSeconds,
        1,
        86_400,
      ),
      state: 'active',
      ...(candidate.reading !== undefined ? { reading: candidate.reading as JsonValue } : {}),
    },
  }];
  if (!Array.isArray(candidate.logs)) return records;
  const seen = new Set<string>();
  for (const item of candidate.logs.slice(-2_000)) {
    const log = recordOf(item);
    const id = string(log.id, 240);
    const role = typeof log.role === 'string' && LOG_ROLES.has(log.role)
      ? log.role
      : null;
    const content = string(log.content, 40_000, true);
    const createdAt = timestamp(log.createdAt);
    const elapsedSeconds = integer(log.elapsedSeconds, 0, 100_000_000);
    const trigger = string(log.trigger, 200);
    if (
      id === null
      || seen.has(id)
      || role === null
      || content === null
      || createdAt === null
      || elapsedSeconds === null
      || trigger === null
    ) {
      continue;
    }
    seen.add(id);
    records.push({
      kind: 'focus-log',
      record: {
        id,
        sessionId,
        role,
        content,
        createdAt,
        elapsedSeconds,
        trigger,
      },
    });
  }
  return records;
}

function projectInvitation(value: unknown) {
  const candidate = recordOf(value);
  const createdAt = timestamp(candidate.createdAt);
  const mode = typeof candidate.mode === 'string'
    && FOCUS_MODES.has(candidate.mode)
    ? candidate.mode
    : null;
  const baiyunActivity = string(candidate.baiyunActivity, 4_000, true);
  const message = string(candidate.message, 20_000);
  if (
    createdAt === null
    || mode === null
    || baiyunActivity === null
    || message === null
  ) {
    return [];
  }
  return [{
    kind: 'focus-invitation' as const,
    record: {
      id: `invite-${createdAt}`,
      mode,
      baiyunActivity,
      message,
      createdAt,
      state: 'pending',
      ...(candidate.readingId !== undefined ? { readingId: candidate.readingId as JsonValue } : {}),
      ...(candidate.readingActivityId !== undefined ? { readingActivityId: candidate.readingActivityId as JsonValue } : {}),
    },
  }];
}

function projectCooldown(raw: string) {
  const offeredAt = timestamp(Number(raw));
  if (offeredAt === null) return [];
  return [{
    kind: 'focus-invite-cooldown' as const,
    record: {
      id: 'primary',
      offeredAt,
    },
  }];
}

function projectCompanionPolicy(value: unknown) {
  const candidate = recordOf(value);
  return POLICY_FIELDS.flatMap((field) => {
    const projected = integer(candidate[field], 1, 999);
    return projected === null
      ? []
      : [{
          kind: 'companion-policy-field' as const,
          record: { field, value: projected },
        }];
  });
}

function projectTags(value: unknown): FocusSemanticProjectedRecord[] {
  if (!Array.isArray(value)) throw new Error('FOCUS_TAGS_INVALID');
  const ids = new Set<string>();
  return value.map((tag) => {
    assertFocusSemanticRecord('focus-tag', tag);
    const record = tag as FocusSemanticProjectedRecord['record'];
    if (ids.has(String(record.id))) throw new Error('FOCUS_TAGS_DUPLICATE_ID');
    ids.add(String(record.id));
    return { kind: 'focus-tag', record };
  });
}

export function isFocusSemanticGlobalStorageKey(key: string) {
  return (
    FOCUS_SEMANTIC_GLOBAL_STORAGE_KEYS as readonly string[]
  ).includes(key);
}

export function projectFocusSemanticStorageValue(input: {
  key: string;
  raw: string;
}): FocusSemanticProjectedRecord[] {
  if (input.key === FOCUS_INVITE_COOLDOWN_STORAGE_KEY) {
    return projectCooldown(input.raw);
  }
  const parsed = parseJson(input.raw);
  if (input.key === FOCUS_TAGS_STORAGE_KEY) {
    return projectTags(parsed);
  }
  if (input.key === FOCUS_ACTIVE_STORAGE_KEY) {
    return projectActiveSession(parsed);
  }
  if (input.key === FOCUS_PENDING_INVITE_STORAGE_KEY) {
    return projectInvitation(parsed);
  }
  if (input.key === FOCUS_COMPANION_POLICY_STORAGE_KEY) {
    return projectCompanionPolicy(parsed);
  }
  throw new Error(`focus.semantic 未登记 storage key：${input.key}。`);
}

function sameValue(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function byIdentity(records: readonly FocusSemanticProjectedRecord[]) {
  return new Map(records.map((item) => [
    focusSemanticEntityId(item.kind, item.record),
    item,
  ]));
}

function shouldDeleteMissingRecord(
  key: string,
  kind: FocusSemanticRecordKind,
) {
  if (key === FOCUS_ACTIVE_STORAGE_KEY) {
    return kind === 'focus-current-agreement';
  }
  return true;
}

async function buildMutation(input: {
  projected: FocusSemanticProjectedRecord;
  operation: 'upsert' | 'delete';
  deletedAt: number;
  envelopeFactory: FocusSemanticEnvelopeFactory;
}) {
  const entityType = focusSemanticEntityTypeForKind(input.projected.kind);
  const entityId = focusSemanticEntityId(
    input.projected.kind,
    input.projected.record,
  );
  const envelope = await input.envelopeFactory({
    domain: 'focus',
    type: entityType,
    id: entityId,
  });
  return buildFocusSemanticMutation({
    envelope,
    entityType,
    entityId,
    operation: input.operation,
    payload: input.operation === 'delete'
      ? focusSemanticDeletePayload({
          kind: input.projected.kind,
          deletedAt: input.deletedAt,
        })
      : focusSemanticRecordPayload(input.projected),
  });
}

export async function hasFocusSemanticStorageProjectionChange(input: {
  changes: readonly FocusSemanticStorageChange[];
  reader: FocusSemanticStorageReadPort;
}) {
  for (const change of input.changes) {
    if (!isFocusSemanticGlobalStorageKey(change.key)) continue;
    const previousRaw = await input.reader.getItem(change.key);
    const previous = previousRaw === null
      ? []
      : projectFocusSemanticStorageValue({
          key: change.key,
          raw: previousRaw,
        });
    const next = change.kind === 'set'
      ? projectFocusSemanticStorageValue({
          key: change.key,
          raw: change.value,
        })
      : [];
    const previousById = byIdentity(previous);
    const nextById = byIdentity(next);
    for (const projected of next) {
      const entityId = focusSemanticEntityId(
        projected.kind,
        projected.record,
      );
      if (!sameValue(
        previousById.get(entityId)?.record,
        projected.record,
      )) {
        return true;
      }
    }
    for (const projected of previous) {
      const entityId = focusSemanticEntityId(
        projected.kind,
        projected.record,
      );
      if (
        !nextById.has(entityId)
        && shouldDeleteMissingRecord(change.key, projected.kind)
      ) {
        return true;
      }
    }
  }
  return false;
}

export async function deriveFocusSemanticMutationsForStorageChanges(input: {
  changes: readonly FocusSemanticStorageChange[];
  reader: FocusSemanticStorageReadPort;
  capturedAt: number;
  envelopeFactory: FocusSemanticEnvelopeFactory;
}): Promise<PlainMutationV1[]> {
  const mutations: PlainMutationV1[] = [];
  for (const change of input.changes) {
    if (!isFocusSemanticGlobalStorageKey(change.key)) continue;
    const previousRaw = await input.reader.getItem(change.key);
    const previous = previousRaw === null
      ? []
      : projectFocusSemanticStorageValue({
          key: change.key,
          raw: previousRaw,
        });
    const next = change.kind === 'set'
      ? projectFocusSemanticStorageValue({
          key: change.key,
          raw: change.value,
        })
      : [];
    const previousById = byIdentity(previous);
    const nextById = byIdentity(next);
    for (const projected of next) {
      const entityId = focusSemanticEntityId(
        projected.kind,
        projected.record,
      );
      if (sameValue(previousById.get(entityId)?.record, projected.record)) {
        continue;
      }
      mutations.push(await buildMutation({
        projected,
        operation: 'upsert',
        deletedAt: input.capturedAt,
        envelopeFactory: input.envelopeFactory,
      }));
    }
    for (const projected of previous) {
      const entityId = focusSemanticEntityId(
        projected.kind,
        projected.record,
      );
      if (
        nextById.has(entityId)
        || !shouldDeleteMissingRecord(change.key, projected.kind)
      ) {
        continue;
      }
      mutations.push(await buildMutation({
        projected,
        operation: 'delete',
        deletedAt: input.capturedAt,
        envelopeFactory: input.envelopeFactory,
      }));
    }
  }
  return mutations;
}
