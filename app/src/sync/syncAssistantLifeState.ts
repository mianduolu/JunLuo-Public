import { assertOwnDayPlanNight } from './syncOwnDayPlanState';
import type {
  ChatCoreMutationEnvelope,
} from './syncChatCore';
import {
  isJunluoAffectStateV1,
  isJunluoAffectStateLegacyV1,
  isJunluoDesireState,
  JUNLUO_DESIRE_IDS,
  BAIYUN_EMOTION_IDS,
  type JunluoInnerOperationRef,
  isJunluoThoughtStateV1,
} from '../life/junluoInnerState';
import { upgradeJunluoDesireState } from '../life/junluoInnerStatePersistence';
import {
  assertJsonValue,
  assertPlainMutationV1,
  type JsonValue,
  type PlainMutationV1,
} from './syncProtocol';

export const ASSISTANT_LIFE_STATE_ADAPTER_ID = 'assistant.life-state' as const;
export const ASSISTANT_LIFE_STATE_SCHEMA_VERSION = 1 as const;
export const ASSISTANT_LIFE_STATE_RETENTION_CLASS = 'relationship-history' as const;

export type AssistantLifeStateEntityType =
  | 'assistant-state'
  | 'life-day'
  | 'drive-state'
  | 'inner-state';

export type AssistantLifeStateRecordKind =
  | 'assistant-state'
  | 'life-day'
  | 'desire-state'
  | 'drive-metabolism'
  | 'life-rhythm'
  | 'conversation-afterglow'
  | 'global-interaction'
  | 'love-summary'
  | 'inner-desire-state'
  | 'inner-affect-state'
  | 'inner-thought-state';

type JsonRecord = { [key: string]: JsonValue };

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DRIVE_IDS = new Set([
  'attachment',
  'curiosity',
  'reflection',
  'duty',
  'social',
  'fatigue',
  'libido',
  'stress',
]);
const GLOBAL_INTERACTION_SOURCES = new Set([
  'chat',
  'focus',
  'proactive',
  'letter',
  'schedule',
  'life',
]);

function recordOf(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象。`);
  }
  return value as Record<string, unknown>;
}

function assertKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
) {
  const allowed = new Set([...required, ...optional]);
  const extra = Object.keys(value).filter((key) => !allowed.has(key));
  if (extra.length) {
    throw new Error(`${label} 包含未允许字段：${extra.sort().join(', ')}。`);
  }
  const missing = required.filter((key) => !(key in value));
  if (missing.length) {
    throw new Error(`${label} 缺少字段：${missing.join(', ')}。`);
  }
}

function assertString(value: unknown, label: string, maximumLength: number) {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > maximumLength
  ) {
    throw new Error(`${label} 必须是 1–${maximumLength} 字符的字符串。`);
  }
  return value;
}

function assertNullableString(
  value: unknown,
  label: string,
  maximumLength: number,
) {
  if (value === undefined || value === null) return;
  assertString(value, label, maximumLength);
}

function assertTimestamp(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} 必须是非负 Unix 毫秒整数。`);
  }
  return value as number;
}

function assertNullableTimestamp(value: unknown, label: string) {
  if (value === undefined || value === null) return;
  assertTimestamp(value, label);
}

function assertFiniteNumber(value: unknown, label: string) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} 必须是有限数值。`);
  }
}

function assertUnitNumber(value: unknown, label: string) {
  assertFiniteNumber(value, label);
  if (Number(value) < 0 || Number(value) > 1) {
    throw new Error(`${label} 必须在 0–1 之间。`);
  }
}

function assertDateKey(value: unknown, label: string) {
  const dateKey = assertString(value, label, 10);
  if (!DATE_KEY_PATTERN.test(dateKey)) {
    throw new Error(`${label} 必须是 YYYY-MM-DD。`);
  }
  return dateKey;
}

function assertEntityId(entityId: unknown) {
  assertString(entityId, 'assistant.life-state entity id', 256);
}

function assertRecordArrayWithIds(
  value: unknown,
  label: string,
  timestampFields: readonly string[] = [],
) {
  if (!Array.isArray(value)) throw new Error(`${label} 必须是数组。`);
  const ids = new Set<string>();
  for (const item of value) {
    const record = recordOf(item, `${label} item`);
    const id = assertString(record.id, `${label} item id`, 256);
    if (ids.has(id)) throw new Error(`${label} 包含重复 id：${id}。`);
    ids.add(id);
    for (const field of timestampFields) {
      if (record[field] !== undefined) {
        assertTimestamp(record[field], `${label}.${field}`);
      }
    }
    assertJsonValue(record);
  }
}

export function projectUnifiedContactSummary(value: unknown): Record<string, JsonValue> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const state = value as Record<string, unknown>;
  if (state.version !== 1) return undefined;
  const current = state.current as Record<string, unknown> | null | undefined;
  const summary = {
    day: state.day, used: state.used, lastEndedAt: state.lastEndedAt,
    lastOrdinaryReplyAt: state.lastOrdinaryReplyAt,
    current: current ? { id: current.id, sources: current.sources, requests: current.requests,
      status: current.status, expiresAt: current.expiresAt,
      ...(current.qwenChatSource !== undefined ? { qwenChatSource: current.qwenChatSource } : {}) } : null,
  };
  assertUnifiedContactSummary(summary);
  return summary as Record<string, JsonValue>;
}

function assertUnifiedContactSummary(value: unknown) {
  const summary = object(value, ['day', 'used', 'lastEndedAt', 'lastOrdinaryReplyAt', 'current'], 'unified contact summary');
  if (!DATE_KEY_PATTERN.test(String(summary.day))) throw new Error('unified contact day 无效。');
  for (const key of ['used', 'lastEndedAt', 'lastOrdinaryReplyAt']) assertTimestamp(summary[key], key);
  if (summary.current === null) return;
  const current = recordOf(summary.current, 'unified contact current');
  assertKeys(current, ['id', 'sources', 'requests', 'status', 'expiresAt'], ['qwenChatSource'], 'unified contact current');
  assertString(current.id, 'unified contact id', 512);
  assertTimestamp(current.requests, 'unified contact requests');
  assertTimestamp(current.expiresAt, 'unified contact expiresAt');
  assertEnum(current.status, ['ready', 'requesting', 'waiting_retry', 'saving', 'handoff', 'finished'], 'unified contact status');
  if (current.qwenChatSource !== undefined) assertUnifiedContactQwenChatSource(current.qwenChatSource);
  if (!Array.isArray(current.sources)) throw new Error('unified contact sources 无效。');
  for (const source of current.sources) {
    const ref = object(source, ['kind', 'id', 'version'], 'unified contact source');
    assertEnum(ref.kind, ['heart', 'period', 'life', 'care', 'web', 'nearby', 'social', 'current_state', 'weekly_review'], 'unified contact source kind');
    const ownLife = ref.kind === 'life' && typeof ref.id === 'string' && ref.id.startsWith('contact-own:');
    // A locator can contain book (128) + schedule (242) IDs with JSON escaping.
    assertString(ref.id, 'unified contact source id', ownLife ? 3072 : 512);
    assertString(ref.version, 'unified contact source version', 512);
  }
}

function assertUnifiedContactQwenChatSource(value: unknown) {
  const source = object(value, ['version', 'connectionFingerprint', 'messageIds'], 'unified contact qwen chat source');
  if (source.version !== 1) throw new Error('unified contact qwen chat source version 无效。');
  assertString(source.connectionFingerprint, 'unified contact qwen connection', 512);
  if (!Array.isArray(source.messageIds) || !source.messageIds.length) throw new Error('unified contact qwen chat refs 无效。');
  const ids = new Set<string>();
  for (const item of source.messageIds) {
    const id = assertString(item, 'unified contact qwen message id', 512);
    if (ids.has(id)) throw new Error('unified contact qwen chat refs 重复。');
    ids.add(id);
  }
}

export function mergeUnifiedContactSummary(left: JsonValue | undefined, right: JsonValue | undefined): JsonValue | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  assertUnifiedContactSummary(left); assertUnifiedContactSummary(right);
  const a = left as Record<string, JsonValue>, b = right as Record<string, JsonValue>;
  if (a.day !== b.day) return String(a.day) > String(b.day) ? a : b;
  const rank = (summary: Record<string, JsonValue>) => {
    const op = summary.current as Record<string, JsonValue> | null;
    return [Number(summary.used), Number(summary.lastEndedAt), Number(summary.lastOrdinaryReplyAt),
      Number(op?.requests ?? 0), ['ready','requesting','waiting_retry','saving','handoff','finished'].indexOf(String(op?.status))];
  };
  const ar = rank(a), br = rank(b);
  const difference = ar.findIndex((value, index) => value !== br[index]);
  const chosen = difference < 0 || ar[difference] >= br[difference] ? a : b;
  const other = chosen === a ? b : a;
  const op = chosen.current as Record<string, JsonValue> | null;
  const otherOp = other.current as Record<string, JsonValue> | null;
  const current = op && otherOp && op.id === otherOp.id && op.qwenChatSource === undefined && otherOp.qwenChatSource !== undefined
    ? { ...op, qwenChatSource: otherOp.qwenChatSource } : op;
  return { ...chosen, current, used: Math.max(Number(a.used), Number(b.used)),
    lastEndedAt: Math.max(Number(a.lastEndedAt), Number(b.lastEndedAt)),
    lastOrdinaryReplyAt: Math.max(Number(a.lastOrdinaryReplyAt), Number(b.lastOrdinaryReplyAt)) };
}

function assertAssistantState(value: Record<string, unknown>) {
  assertKeys(
    value,
    ['activity', 'lifeMode', 'moodId', 'sourceType', 'title', 'updatedAt'],
    [
      'lifeContext',
      'manualSleepUntil',
      'manualWakeUntil',
      'scheduleSlot',
      'sourceMessageId',
      'sleepSource', // Legacy signed transport only; upgrade/materialization strips the retired marker.
      'wakeSource',
      'sleepNearStatus',
      'unifiedContact',
      'cloudForm',
      'textUpdatedAt',
    ],
    'assistant state',
  );
  assertString(value.activity, 'assistant state activity', 4000);
  assertString(value.title, 'assistant state title', 240);
  const lifeMode = assertString(value.lifeMode, 'assistant state lifeMode', 40);
  if (!['available', 'self-time', 'sleeping'].includes(lifeMode)) {
    throw new Error('assistant state lifeMode 无效。');
  }
  assertString(value.moodId, 'assistant state moodId', 40);
  const sourceType = assertString(
    value.sourceType,
    'assistant state sourceType',
    40,
  );
  if (!['default', 'idle-conversation', 'self-schedule', 'sleep'].includes(sourceType)) {
    throw new Error('assistant state sourceType 无效。');
  }
  assertTimestamp(value.updatedAt, 'assistant state updatedAt');
  if (value.textUpdatedAt !== undefined) assertTimestamp(value.textUpdatedAt, 'assistant state textUpdatedAt');
  if (value.unifiedContact !== undefined) assertUnifiedContactSummary(value.unifiedContact);
  if (value.cloudForm !== undefined) assertEnum(value.cloudForm, ['white', 'black'], 'cloud form');
  assertNullableString(value.lifeContext, 'assistant state lifeContext', 8000);
  assertNullableTimestamp(value.manualSleepUntil, 'assistant state manualSleepUntil');
  assertNullableTimestamp(value.manualWakeUntil, 'assistant state manualWakeUntil');
  assertNullableString(value.scheduleSlot, 'assistant state scheduleSlot', 512);
  assertNullableString(value.sourceMessageId, 'assistant state sourceMessageId', 256);
  assertNullableString(value.sleepSource, 'assistant state sleepSource', 80);
  assertNullableString(value.wakeSource, 'assistant state wakeSource', 80);
  if (value.sleepNearStatus !== undefined) {
    const display = object(value.sleepNearStatus, ['nightKey', 'slotId', 'phase', 'sleepAt', 'wakeAt', 'deepAt', 'preWakeAt', 'recordedAt'], 'sleep display');
    assertString(display.nightKey, 'sleep display nightKey', 40);
    assertString(display.slotId, 'sleep display slotId', 80);
    assertEnum(display.phase, ['sleeping', 'deep', 'pre-wake'], 'sleep display phase');
    for (const key of ['sleepAt', 'wakeAt', 'deepAt', 'preWakeAt', 'recordedAt']) assertTimestamp(display[key], key);
  }
}

function assertSleepGreetingReceipt(value: unknown) {
  const receipt = recordOf(value, 'sleep greeting receipt');
  assertKeys(receipt, ['sessionId', 'messageId', 'deliveredAt'], ['opportunityId'], 'sleep greeting receipt');
  for (const key of ['sessionId', 'messageId', 'opportunityId'])
    if (receipt[key] !== undefined) assertString(receipt[key], `sleep greeting ${key}`, 256);
  assertTimestamp(receipt.deliveredAt, 'sleep greeting deliveredAt');
}

function assertLifeDay(value: Record<string, unknown>, entityId: string) {
  assertKeys(
    value,
    [
      'createdAt',
      'dateKey',
      'deviations',
      'segments',
      'sleepTargetAt',
      'timelineEntries',
      'wakeTargetAt',
    ],
    [
      'dailyFocus',
      'dailySummary',
      'schemaVersion',
      'summaryGeneratedAt',
      'nightSleepPlan',
      'nearStatus',
      'sleepPlanUpdatedAt',
    ],
    'assistant life day',
  );
  const dateKey = assertDateKey(value.dateKey, 'assistant life day dateKey');
  if (dateKey !== entityId) {
    throw new Error('assistant life day dateKey 与 entity id 不一致。');
  }
  assertTimestamp(value.createdAt, 'assistant life day createdAt');
  assertTimestamp(value.sleepTargetAt, 'assistant life day sleepTargetAt');
  assertTimestamp(value.wakeTargetAt, 'assistant life day wakeTargetAt');
  assertNullableTimestamp(value.sleepPlanUpdatedAt, 'assistant life day sleepPlanUpdatedAt');
  if (value.nightSleepPlan !== undefined) {
    const plan = recordOf(value.nightSleepPlan, 'night sleep plan');
    if (plan.nearStatus !== undefined) assertSleepNearStatus(plan.nearStatus);
    if (plan.dayPlan !== undefined) assertOwnDayPlanNight(plan.dayPlan);
    assertTimestamp(plan.originalSleepAt, 'night sleep plan originalSleepAt');
    assertTimestamp(plan.originalWakeAt, 'night sleep plan originalWakeAt');
    assertFiniteNumber(plan.revision, 'night sleep plan revision');
    assertNullableTimestamp(plan.scheduleChangedAt, 'night sleep plan scheduleChangedAt');
    assertNullableTimestamp(plan.attemptedAt, 'night sleep plan attemptedAt');
    assertNullableTimestamp(plan.actualSleepAt, 'night sleep plan actualSleepAt');
    assertNullableTimestamp(plan.explicitWakeAt, 'night sleep plan explicitWakeAt');
    assertNullableTimestamp(plan.actualWakeAt, 'night sleep plan actualWakeAt');
    for (const key of ['morningAwakeAt', 'chatOpenedAt'])
      if (plan[key] !== undefined) assertTimestamp(plan[key], `night sleep plan ${key}`);
    if (plan.recovery !== undefined) {
      const recovery = recordOf(plan.recovery, 'sleep recovery');
      assertKeys(recovery, ['sleepStartedAt', 'eligible', 'checkedAt'], ['estimatedAt'], 'sleep recovery');
      for (const key of ['sleepStartedAt', 'checkedAt']) assertTimestamp(recovery[key], `sleep recovery ${key}`);
      if (typeof recovery.eligible !== 'boolean' || Number(recovery.checkedAt) < Number(recovery.sleepStartedAt))
        throw new Error('invalid_sleep_recovery');
      if (recovery.estimatedAt !== undefined) {
        assertTimestamp(recovery.estimatedAt, 'sleep recovery estimatedAt');
        if (Number(recovery.estimatedAt) < Number(recovery.checkedAt)) throw new Error('invalid_sleep_recovery_estimate');
      }
    }
    if (plan.pendingSleep !== undefined) {
      const pending = recordOf(plan.pendingSleep, 'pending sleep');
      assertKeys(pending, ['id', 'kind', 'decidedAt', 'hardDeadlineAt', 'sessionId', 'turnId'],
        ['sourceMessageIds', 'turnEndedAt', 'dueAt', 'round', 'roundStartedAt', 'roundDeadlineAt', 'greeting'], 'pending sleep');
      for (const key of ['id', 'sessionId', 'turnId']) assertString(pending[key], `pending sleep ${key}`, 256);
      assertEnum(pending.kind, ['sleep', 'return'], 'pending sleep kind');
      for (const key of ['decidedAt', 'hardDeadlineAt']) assertTimestamp(pending[key], `pending sleep ${key}`);
      for (const key of ['turnEndedAt', 'dueAt']) if (pending[key] !== undefined) assertTimestamp(pending[key], `pending sleep ${key}`);
      if (pending.greeting !== undefined) {
        const greeting = recordOf(pending.greeting, 'pending greeting');
        assertKeys(greeting, ['fallbackAt', 'waitingUntil'], ['deliveredAt'], 'pending greeting');
        for (const key of ['fallbackAt', 'waitingUntil', 'deliveredAt'])
          if (greeting[key] !== undefined) assertTimestamp(greeting[key], `pending greeting ${key}`);
        if (greeting.fallbackAt !== pending.hardDeadlineAt
          || greeting.deliveredAt !== undefined && Number(greeting.waitingUntil) < Number(greeting.deliveredAt)) throw Error('invalid_pending_greeting');
      }
      const hasRounds = ['round', 'roundStartedAt', 'roundDeadlineAt'].some(key => pending[key] !== undefined);
      if (hasRounds) {
        if (pending.round !== 1 && pending.round !== 2) throw new Error('invalid_pending_sleep_round');
        for (const key of ['roundStartedAt', 'roundDeadlineAt']) assertTimestamp(pending[key], `pending sleep ${key}`);
        if ((pending.round === 1
          ? Number(pending.decidedAt) < Number(pending.roundStartedAt) || Number(pending.decidedAt) > Number(pending.roundDeadlineAt)
          : Number(pending.roundStartedAt) < Number(pending.decidedAt))
          || Number(pending.roundDeadlineAt) !== Number(pending.roundStartedAt) + 300000
          || (pending.turnEndedAt === undefined) !== (pending.dueAt === undefined)
          || pending.turnEndedAt !== undefined && (Number(pending.turnEndedAt) < Number(pending.roundStartedAt)
            || Number(pending.turnEndedAt) > Number(pending.roundDeadlineAt)
            || pending.greeting === undefined && (Number(pending.dueAt) < Number(pending.turnEndedAt)
              || Number(pending.dueAt) > Number(pending.turnEndedAt) + 300000))) throw new Error('invalid_pending_sleep_time');
      } else if (Number(pending.hardDeadlineAt) < Number(pending.decidedAt)
        || pending.turnEndedAt !== undefined && Number(pending.turnEndedAt) < Number(pending.decidedAt)
        || pending.dueAt !== undefined && (Number(pending.dueAt) < Number(pending.decidedAt)
          || Number(pending.dueAt) > Number(pending.hardDeadlineAt))) throw new Error('invalid_pending_sleep_time');
      if (pending.sourceMessageIds !== undefined) {
        if (!Array.isArray(pending.sourceMessageIds)) throw new Error('invalid_pending_sleep_message_ids');
        for (const id of pending.sourceMessageIds) assertString(id, 'pending sleep message id', 256);
      }
    }
    if (plan.events !== undefined) {
      if (!Array.isArray(plan.events)) throw new Error('invalid_sleep_events');
      const ids = new Set<string>();
      for (const value of plan.events) {
        const event = recordOf(value, 'sleep event');
        assertKeys(event, ['id', 'kind', 'at'], ['sleepAt', 'wakeAt', 'until', 'sessionId', 'turnId', 'messageIds', 'toolCallId', 'greeting', 'greetingOpportunityId'], 'sleep event');
        const id = assertString(event.id, 'sleep event id', 256);
        if (ids.has(id)) throw new Error('duplicate_sleep_event');
        ids.add(id);
        assertEnum(event.kind, ['schedule', 'late', 'sleep_intent', 'sleep', 'poke_awake', 'sleep_return', 'morning_awake', 'get_up'], 'sleep event kind');
        assertTimestamp(event.at, 'sleep event at');
        for (const key of ['sleepAt', 'wakeAt', 'until']) if (event[key] !== undefined) assertTimestamp(event[key], `sleep event ${key}`);
        for (const key of ['sessionId', 'turnId', 'toolCallId']) if (event[key] !== undefined) assertString(event[key], `sleep event ${key}`, 256);
        if (event.greeting !== undefined) assertSleepGreetingReceipt(event.greeting);
        if (event.greetingOpportunityId !== undefined) assertString(event.greetingOpportunityId, 'sleep greeting opportunity id', 256);
        if (event.kind === 'schedule' && event.sleepAt === undefined && event.wakeAt === undefined) throw new Error('empty_sleep_schedule_event');
        if (event.messageIds !== undefined) {
          if (!Array.isArray(event.messageIds)) throw new Error('invalid_sleep_event_message_ids');
          for (const id of event.messageIds) assertString(id, 'sleep event message id', 256);
        }
      }
    }
    for (const phase of ['prepare', 'wake']) {
      if (plan[phase] === undefined) continue;
      const opportunity = recordOf(plan[phase], 'sleep opportunity');
      if (!['requesting', 'retry', 'complete', 'failed', 'skipped'].includes(String(opportunity.status))
        || !Number.isInteger(opportunity.requestCount) || Number(opportunity.requestCount) < 0 || Number(opportunity.requestCount) > 3) {
        throw new Error('invalid_sleep_opportunity');
      }
      assertNullableTimestamp(opportunity.retryAt, 'sleep opportunity retryAt');
      assertNullableString(opportunity.sessionId, 'sleep opportunity sessionId', 256);
      assertNullableString(opportunity.messageId, 'sleep opportunity messageId', 256);
      assertNullableString(opportunity.contextMessageId, 'sleep opportunity contextMessageId', 256);
      assertNullableTimestamp(opportunity.deliveredAt, 'sleep opportunity deliveredAt');
      if (opportunity.sharedContactId !== undefined) assertString(opportunity.sharedContactId, 'sleep shared contact id', 256);
      if (opportunity.greeting !== undefined) assertSleepGreetingReceipt(opportunity.greeting);
      if (opportunity.retryUsed !== undefined && typeof opportunity.retryUsed !== 'boolean') throw new Error('invalid_sleep_retry_used');
      if (opportunity.toolResult !== undefined) {
        const result = recordOf(opportunity.toolResult, 'sleep tool result');
        if (result.subject !== 'I' || result.ok !== true || !['applied', 'unchanged', 'pending_sleep'].includes(String(result.status))) throw new Error('invalid_sleep_tool_result');
        assertNullableString(result.sleepAt, 'sleep tool sleepAt', 80);
        assertNullableString(result.wakeAt, 'sleep tool wakeAt', 80);
        const call = recordOf(opportunity.toolCall, 'sleep tool call');
        assertString(call.callId, 'sleep tool call id', 256);
        recordOf(call.input, 'sleep tool input');
      }
    }
  }
  assertNullableTimestamp(
    value.summaryGeneratedAt,
    'assistant life day summaryGeneratedAt',
  );
  if (value.nearStatus !== undefined) assertNearStatusRun(value.nearStatus);
  assertNullableString(value.dailyFocus, 'assistant life day dailyFocus', 1000);
  assertNullableString(value.dailySummary, 'assistant life day dailySummary', 8000);
  if (value.schemaVersion !== undefined) {
    assertFiniteNumber(value.schemaVersion, 'assistant life day schemaVersion');
  }
  assertRecordArrayWithIds(value.deviations, 'assistant life day deviations', [
    'startsAt',
    'endsAt',
  ]);
  assertRecordArrayWithIds(value.segments, 'assistant life day segments', [
    'startAt',
    'endAt',
  ]);
  assertRecordArrayWithIds(
    value.timelineEntries,
    'assistant life day timeline entries',
    ['at'],
  );
  for (const entry of value.timelineEntries as Record<string, unknown>[]) {
    if (entry.cloudForm !== undefined) assertEnum(entry.cloudForm, ['white', 'black'], 'timeline cloud form');
  }
}

function assertDriveRecord(
  value: unknown,
  label: string,
  exact = true,
) {
  const record = recordOf(value, label);
  if (exact) {
    const keys = Object.keys(record).sort();
    const expected = [...DRIVE_IDS].sort();
    if (
      keys.length !== expected.length
      || keys.some((key, index) => key !== expected[index])
    ) {
      throw new Error(`${label} 驱动力字段不完整。`);
    }
  }
  for (const [key, drive] of Object.entries(record)) {
    if (!DRIVE_IDS.has(key)) throw new Error(`${label} 包含未知驱动力：${key}。`);
    assertUnitNumber(drive, `${label}.${key}`);
  }
}

function assertDesireState(value: Record<string, unknown>) {
  assertKeys(
    value,
    ['drive', 'lastTickAt', 'refractory', 'selfDrive', 'thoughts', 'updatedAt'],
    ['schemaVersion'],
    'desire state',
  );
  assertDriveRecord(value.drive, 'desire state drive');
  assertTimestamp(value.lastTickAt, 'desire state lastTickAt');
  assertTimestamp(value.updatedAt, 'desire state updatedAt');
  if (value.schemaVersion !== undefined && value.schemaVersion !== 2) {
    throw new Error('desire state schemaVersion 无效。');
  }
  const refractory = recordOf(value.refractory, 'desire state refractory');
  for (const [key, remainingHours] of Object.entries(refractory)) {
    if (!DRIVE_IDS.has(key) || !Number.isFinite(remainingHours) || Number(remainingHours) < 0) {
      throw new Error('desire state refractory 无效。');
    }
  }
  const selfDrive = recordOf(value.selfDrive, 'desire state selfDrive');
  assertString(
    selfDrive.selfPulseDateKey,
    'desire state selfPulseDateKey',
    10,
  );
  if (typeof selfDrive.enabled !== 'boolean') {
    throw new Error('desire state selfDrive.enabled 必须是布尔值。');
  }
  assertUnitNumber(
    selfDrive.curiosityFloor,
    'desire state selfDrive.curiosityFloor',
  );
  if (
    !Number.isSafeInteger(selfDrive.selfPulseCountToday)
    || Number(selfDrive.selfPulseCountToday) < 0
  ) {
    throw new Error('desire state selfPulseCountToday 无效。');
  }
  assertNullableTimestamp(
    selfDrive.lastSelfPulseAt,
    'desire state lastSelfPulseAt',
  );
  if (!Array.isArray(value.thoughts)) {
    throw new Error('desire state thoughts 必须是数组。');
  }
  const thoughtIds = new Set<string>();
  for (const thoughtValue of value.thoughts) {
    const thought = recordOf(thoughtValue, 'desire thought');
    const id = assertString(thought.id, 'desire thought id', 256);
    if (thoughtIds.has(id)) throw new Error(`desire thoughts 重复 id：${id}。`);
    thoughtIds.add(id);
    const drive = assertString(thought.drive, 'desire thought drive', 40);
    if (!DRIVE_IDS.has(drive)) throw new Error('desire thought drive 无效。');
    assertTimestamp(thought.bornAt, 'desire thought bornAt');
    assertTimestamp(thought.updatedAt, 'desire thought updatedAt');
    assertUnitNumber(thought.strength, 'desire thought strength');
    assertString(thought.text, 'desire thought text', 4000);
    assertJsonValue(thought);
  }
}

function assertDriveMetabolism(value: Record<string, unknown>) {
  assertKeys(
    value,
    ['lastChatAt', 'lastExcitingEventAt', 'lastTickAt'],
    ['baseline'],
    'drive metabolism',
  );
  assertTimestamp(value.lastChatAt, 'drive metabolism lastChatAt');
  assertTimestamp(
    value.lastExcitingEventAt,
    'drive metabolism lastExcitingEventAt',
  );
  assertTimestamp(value.lastTickAt, 'drive metabolism lastTickAt');
  if (value.baseline !== undefined) {
    const baseline = recordOf(value.baseline, 'drive metabolism baseline');
    for (const [key, drive] of Object.entries(baseline)) {
      assertString(key, 'drive metabolism baseline key', 80);
      assertUnitNumber(drive, `drive metabolism baseline.${key}`);
    }
  }
}

function assertLifeRhythm(value: Record<string, unknown>) {
  assertKeys(
    value,
    [
      'alertness',
      'lastTickAt',
      'restQuality',
      'sleepDebt',
      'sleepPressure',
      'updatedAt',
      'wakePressure',
    ],
    [
      'lastSleepDurationMinutes',
      'lastSleepEndedAt',
      'lastSleepStartedAt',
      'lastSleepWasMain',
      'lastWakeAt',
      'phase',
      'phaseStartedAt',
      'schemaVersion',
    ],
    'life rhythm',
  );
  for (const field of [
    'alertness',
    'restQuality',
    'sleepDebt',
    'sleepPressure',
    'wakePressure',
  ]) {
    assertUnitNumber(value[field], `life rhythm ${field}`);
  }
  assertTimestamp(value.lastTickAt, 'life rhythm lastTickAt');
  assertTimestamp(value.updatedAt, 'life rhythm updatedAt');
  assertNullableTimestamp(value.lastWakeAt, 'life rhythm lastWakeAt');
  assertNullableTimestamp(value.lastSleepStartedAt, 'life rhythm lastSleepStartedAt');
  assertNullableTimestamp(value.lastSleepEndedAt, 'life rhythm lastSleepEndedAt');
  if (
    value.lastSleepDurationMinutes !== undefined
    && (!Number.isFinite(value.lastSleepDurationMinutes) || Number(value.lastSleepDurationMinutes) < 0)
  ) {
    throw new Error('life rhythm lastSleepDurationMinutes 无效。');
  }
  if (value.lastSleepWasMain !== undefined && typeof value.lastSleepWasMain !== 'boolean') {
    throw new Error('life rhythm lastSleepWasMain 必须是布尔值。');
  }
  if (value.schemaVersion !== undefined && value.schemaVersion !== 2) {
    throw new Error('life rhythm schemaVersion 无效。');
  }
  if (value.phase !== undefined && value.phase !== 'awake' && value.phase !== 'sleeping') {
    throw new Error('life rhythm phase 无效。');
  }
  if (value.phaseStartedAt !== undefined) {
    assertTimestamp(value.phaseStartedAt, 'life rhythm phaseStartedAt');
  }
  if (value.schemaVersion === 2 && (value.phase === undefined || value.phaseStartedAt === undefined)) {
    throw new Error('life rhythm v2 缺少阶段字段。');
  }
}

function assertAfterglowPosition(value: unknown, label: string, withRevision = false) {
  const position = recordOf(value, label);
  assertKeys(position, ['id', 'createdAt', ...(withRevision ? ['revision'] : [])], [], label);
  assertString(position.id, `${label}.id`, 256);
  assertTimestamp(position.createdAt, `${label}.createdAt`);
  if (withRevision) assertString(position.revision, `${label}.revision`, 256);
  return position;
}

function assertAfterglowPositions(value: unknown, label: string, withRevision = false) {
  if (!Array.isArray(value)) throw new Error(`${label} 必须是数组。`);
  const ids = new Set();
  for (const item of value) {
    const position = assertAfterglowPosition(item, label, withRevision);
    if (ids.has(position.id)) throw new Error(`${label} 包含重复 id。`);
    ids.add(position.id);
  }
  return value as Record<string, unknown>[];
}

// Legacy data validation is used only while importing or acknowledging old transport bytes.
function assertAfterglowParsedResult(value: unknown) {
  const label = 'conversation afterglow pending.parsed';
  const result = recordOf(value, label);
  assertKeys(result, ['extraFields', 'parsed', 'status'], ['counterIdea'], label);
  if (!Array.isArray(result.extraFields) || result.extraFields.some(field => typeof field !== 'string')) {
    throw new Error(`${label}.extraFields 无效。`);
  }
  const status = recordOf(result.status, `${label}.status`);
  assertKeys(status, ['affect', 'desire', 'thought'], ['counterIdea'], `${label}.status`);
  for (const entry of Object.values(status)) {
    if (typeof entry !== 'string' || !['absent', 'adopted', 'invalid'].includes(entry)) throw new Error(`${label}.status 无效。`);
  }
  const parsed = result.parsed === null ? null : recordOf(result.parsed, label);
  if (parsed) assertKeys(parsed, ['affect', 'desire', 'thought'], [], label);
  for (const basket of ['affect', 'desire', 'thought']) {
    const item = parsed?.[basket] ?? null;
    if ((status[basket] === 'adopted') !== (item !== null)) throw new Error(`${label}.${basket} 与 status 不一致。`);
  }
  function object(input: unknown, keys: string[], location: string) {
    const item = recordOf(input, location);
    assertKeys(item, keys, [], location);
    return item;
  }
  function nullableStrings(item: Record<string, unknown>, keys: string[]) {
    for (const key of keys) if (item[key] !== null) assertString(item[key], `${label}.${key}`, 256);
  }
  if (parsed?.affect !== null && parsed?.affect !== undefined) {
    const affect = object(parsed.affect, ['emotions', 'lifeState', 'relationshipChoice', 'relationshipFeeling', 'strain'], label);
    nullableStrings(affect, ['lifeState', 'relationshipChoice', 'relationshipFeeling', 'strain']);
    if (affect.emotions !== null) {
      const emotions = object(affect.emotions, ['primary', 'secondary'], label);
      if (!Array.isArray(emotions.secondary) || emotions.secondary.length > 1) throw new Error(`${label}.emotions.secondary 无效。`);
      for (const item of [emotions.primary, ...emotions.secondary]) {
        const emotion = recordOf(item, label);
        assertKeys(emotion, ['id', 'strength', 'target'], ['reason'], label);
        for (const key of ['id', 'strength', 'target']) assertString(emotion[key], `${label}.${key}`, 256);
        if (Object.hasOwn(emotion, 'reason') && emotion.reason !== null && typeof emotion.reason !== 'string') throw new Error(`${label}.reason 无效。`);
      }
    }
  }
  if (parsed?.desire !== null && parsed?.desire !== undefined) {
    nullableStrings(object(parsed.desire, ['focus', 'satisfied'], label), ['focus', 'satisfied']);
  }
  if (parsed?.thought !== null && parsed?.thought !== undefined) {
    const thought = object(parsed.thought, ['decision', 'new'], label);
    for (const [key, fields] of [['decision', ['choice', 'thoughtId']], ['new', ['content', 'desireId']]] as const) {
      if (thought[key] === null) continue;
      const item = object(thought[key], [...fields], label);
      for (const field of fields) assertString(item[field], `${label}.${field}`, 256);
    }
  }
  if ((status.counterIdea === 'adopted') !== (result.counterIdea != null)) throw new Error(`${label}.counterIdea 与 status 不一致。`);
  if (result.counterIdea != null) {
    const idea = object(result.counterIdea, ['keyword', 'targetCount', 'days'], label);
    if (typeof idea.keyword !== 'string' || !idea.keyword.trim()) throw new Error(`${label}.counterIdea.keyword 无效。`);
    if (!((idea.targetCount === null && Number.isSafeInteger(idea.days) && Number(idea.days) > 0)
      || (idea.days === null && Number.isSafeInteger(idea.targetCount) && Number(idea.targetCount) > 0))) {
      throw new Error(`${label}.counterIdea 无效。`);
    }
  }
}

function assertConversationAfterglowV2(value: Record<string, unknown>) {
  const label = 'conversation afterglow v2';
  assertKeys(value, ['schemaVersion', 'activatedAt', 'updatedAt', 'cursors'],
    ['lateMessages', 'lastAttemptAt', 'generatedAt', 'lastLifeMaterialKey', 'pending'], label);
  for (const field of ['activatedAt', 'updatedAt', 'lastAttemptAt', 'generatedAt']) {
    if (field in value) assertTimestamp(value[field], `${label}.${field}`);
  }
  if ('lastLifeMaterialKey' in value) assertString(value.lastLifeMaterialKey, `${label}.lastLifeMaterialKey`, 256);
  for (const [sessionId, cursor] of Object.entries(recordOf(value.cursors, `${label}.cursors`))) {
    assertString(sessionId, `${label}.sessionId`, 256);
    assertAfterglowPosition(cursor, `${label}.cursor`);
  }
  if ('lateMessages' in value) {
    for (const [sessionId, refs] of Object.entries(recordOf(value.lateMessages, `${label}.lateMessages`))) {
      assertString(sessionId, `${label}.sessionId`, 256);
      assertAfterglowPositions(refs, `${label}.lateMessages`);
    }
  }
  if (!('pending' in value)) return;
  const pending = recordOf(value.pending, `${label}.pending`);
  assertKeys(pending, ['generationKey', 'source', 'materialKey', 'attemptedAt', 'refs', 'parsed', 'reviewThoughtId', 'sleeping', 'applied'],
    ['sessionId', 'end'], `${label}.pending`);
  for (const field of ['generationKey', 'materialKey']) assertString(pending[field], `${label}.${field}`, 256);
  assertTimestamp(pending.attemptedAt, `${label}.attemptedAt`);
  if (pending.reviewThoughtId !== null) assertString(pending.reviewThoughtId, `${label}.reviewThoughtId`, 256);
  if (typeof pending.sleeping !== 'boolean') throw new Error(`${label}.sleeping 无效。`);
  if (!Array.isArray(pending.applied) || pending.applied.some(item => !['affect', 'desire', 'thought', 'counterIdea'].includes(item))
    || new Set(pending.applied).size !== pending.applied.length) {
    throw new Error(`${label}.applied 无效。`);
  }
  const refs = assertAfterglowPositions(pending.refs, `${label}.pending.refs`, true);
  if (pending.source === 'afterglow') {
    assertString(pending.sessionId, `${label}.pending.sessionId`, 256);
    const end = assertAfterglowPosition(pending.end, `${label}.pending.end`);
    if (!refs.some(ref => ref.id === end.id && ref.createdAt === end.createdAt)) throw new Error(`${label}.pending.end 不在 refs 内。`);
  } else if (pending.source !== 'life' || refs.length || 'sessionId' in pending || 'end' in pending) {
    throw new Error(`${label}.pending.source/refs 无效。`);
  }
  assertAfterglowParsedResult(pending.parsed);
}

export function hasPokeProgress(value: Record<string, unknown>) {
  const affect = recordOf(value.affect ?? {}, 'affect reader');
  if (recordOf(value.materials ?? {}, 'paper materials').pokes || affect.pokes) return true;
  return [value.pending, value.retry, affect.pending, affect.retry].some(item => {
    const pending = recordOf(item ?? {}, 'paper pending');
    return (Array.isArray(pending.pokeRefs) && pending.pokeRefs.length > 0)
      || (Array.isArray(pending.materials)
        && pending.materials.some(ref => recordOf(ref, 'paper material ref').kind === 'poke'));
  });
}

export function shouldKeepCurrentWantsState(current: unknown, incoming: unknown) {
  const previous = recordOf(current, 'conversation afterglow current');
  const next = recordOf(incoming, 'conversation afterglow incoming');
  if (isJunluoDesireState(current) && isJunluoDesireState(incoming)
    && Boolean(current.clock.correction) !== Boolean(incoming.clock.correction)) {
    return Boolean(current.clock.correction);
  }
  if ('desires' in previous) return previous.schemaVersion === 4
    && (next.schemaVersion !== 4 || Number(previous.updatedAt) > Number(next.updatedAt));
  if (previous.schemaVersion === 3 && next.schemaVersion === 3 && previous.activatedAt !== next.activatedAt
    && [previous, next].some(hasPokeProgress)) {
    return Number(previous.activatedAt) > Number(next.activatedAt);
  }
  return previous.schemaVersion === 3 && (next.schemaVersion !== 3
    || Number(previous.updatedAt) > Number(next.updatedAt)
    || (previous.affect !== undefined && (next.affect === undefined
      || Number(recordOf(previous.affect, 'affect').updatedAt) > Number(recordOf(next.affect, 'affect').updatedAt))));
}

export function assertLegacyConversationAfterglowState(input: unknown) {
  const value = recordOf(input, 'legacy conversation afterglow');
  if (value.schemaVersion === 2) return assertConversationAfterglowV2(value);
  assertKeys(
    value,
    ['generatedAt', 'sessionId', 'sourceMessageId', 'youMessageCount'],
    [],
    'conversation afterglow',
  );
  assertTimestamp(value.generatedAt, 'conversation afterglow generatedAt');
  assertString(value.sessionId, 'conversation afterglow sessionId', 256);
  assertString(
    value.sourceMessageId,
    'conversation afterglow sourceMessageId',
    256,
  );
  if (!Number.isSafeInteger(value.youMessageCount) || Number(value.youMessageCount) < 0) {
    throw new Error('conversation afterglow youMessageCount 无效。');
  }
}

export function upgradeLegacyConversationAfterglowState(
  input: unknown,
  now: number,
  desireOperations: readonly JunluoInnerOperationRef[] = [],
) {
  assertLegacyConversationAfterglowState(input);
  const old = recordOf(input, 'legacy conversation afterglow');
  const next: Record<string, unknown> = {
    schemaVersion: 3, paper: 'wants', activatedAt: now, updatedAt: now,
    cursors: {}, lateMessages: {}, materials: { activatedAt: now, care: {}, hearts: [], life: {} },
  };
  if (old.schemaVersion !== 2) return next;
  Object.assign(next, { activatedAt: old.activatedAt, cursors: { ...recordOf(old.cursors, 'legacy cursors') },
    lateMessages: { ...recordOf(old.lateMessages ?? {}, 'legacy late messages') } });
  for (const field of ['lastAttemptAt', 'generatedAt']) {
    if (old[field] !== undefined) next[field] = old[field];
  }
  if (!old.pending) return next;
  const pending = recordOf(old.pending, 'legacy pending');
  const applied = (pending.applied as string[]).includes('desire')
    || desireOperations.some(op => op.operationId === `${pending.generationKey}:desire`);
  if (!applied) return next;
  next.generatedAt = now;
  if (pending.source === 'life') {
    next.lastLifeMaterialKey = pending.materialKey;
  } else {
    const sessionId = String(pending.sessionId);
    const cursors = recordOf(next.cursors, 'legacy cursors');
    const end = recordOf(pending.end, 'legacy pending end');
    const previous = cursors[sessionId] as Record<string, unknown> | undefined;
    if (!previous || Number(end.createdAt) > Number(previous.createdAt)
      || (end.createdAt === previous.createdAt && String(end.id).localeCompare(String(previous.id)) > 0)) {
      cursors[sessionId] = end;
    }
    const consumed = new Set((pending.refs as Record<string, unknown>[]).map(ref => ref.id));
    const late = recordOf(next.lateMessages, 'legacy late messages');
    late[sessionId] = ((late[sessionId] ?? []) as Record<string, unknown>[]).filter(ref => !consumed.has(ref.id));
  }
  return next;
}

function assertEnum(value: unknown, values: readonly string[], label: string) {
  if (typeof value !== 'string' || !values.includes(value)) throw new Error(`${label} 无效。`);
}

function object(input: unknown, keys: string[], label: string) {
  const value = recordOf(input, label);
  assertKeys(value, keys, [], label);
  return value;
}

function assertTextDraft(value: unknown, label: string, allowCloudForm = false) {
  const draft = recordOf(value, label);
  assertKeys(draft, ['title', 'activity'], allowCloudForm ? ['cloudForm'] : [], label);
  assertString(draft.title, `${label}.title`, 240);
  assertString(draft.activity, `${label}.activity`, 4000);
  if (allowCloudForm && draft.cloudForm !== undefined) assertEnum(draft.cloudForm, ['white', 'black'], 'near cloud form');
}

function assertSleepNearStatus(value: unknown) {
  const state = object(value, ['schemaVersion', 'initializedAt', 'updatedAt', 'sleepAt', 'postCount', 'wakeCount', 'slots'], 'sleep near status');
  if (state.schemaVersion !== 1 || typeof state.postCount !== 'number' || typeof state.wakeCount !== 'number'
    || ![2, 3].includes(state.postCount) || ![1, 2, 3].includes(state.wakeCount)) throw new Error('sleep near status counts');
  for (const key of ['initializedAt', 'updatedAt', 'sleepAt']) assertTimestamp(state[key], key);
  const slots = recordOf(state.slots, 'sleep slots');
  const ids = [...Array.from({ length: state.postCount }, (_, i) => `post:${i}`),
    ...Array.from({ length: state.wakeCount }, (_, i) => `wake:${i}`)];
  if (Object.keys(slots).length !== ids.length || ids.some(id => !slots[id])) throw new Error('sleep slots do not match counts');
  for (const [id, value] of Object.entries(slots)) {
    if (!/^(post|wake):[0-2]$/.test(id)) throw new Error('sleep slot id');
    const slot = recordOf(value, 'sleep slot');
    assertKeys(slot, ['phase', 'at', 'expiresAt', 'status'], ['attemptedAt', 'sourceRevision', 'sourceStateKey', 'draft'], 'sleep slot');
    assertEnum(slot.phase, ['sleeping', 'deep', 'pre-wake'], 'sleep phase');
    if (slot.phase !== (id.startsWith('wake:') ? 'pre-wake' : id === `post:${state.postCount - 1}` ? 'deep' : 'sleeping')) throw new Error('sleep slot phase mismatch');
    assertEnum(slot.status, ['pending', 'requesting', 'complete', 'failed', 'skipped'], 'sleep slot status');
    for (const key of ['at', 'expiresAt', 'attemptedAt']) if (key in slot) assertTimestamp(slot[key], key);
    if (slot.sourceRevision !== undefined && (!Number.isSafeInteger(slot.sourceRevision) || Number(slot.sourceRevision) < 0)) throw new Error('sleep slot revision');
    if (slot.sourceStateKey !== undefined) assertString(slot.sourceStateKey, 'sleep source', 1024);
    if (slot.draft !== undefined) assertTextDraft(slot.draft, 'sleep pending draft');
  }
}

function assertChatSupplement(value: unknown, primarySession?: unknown, primaryRefs: Record<string, unknown>[] = []) {
  const supplement = object(value, ['sessionId', 'unreadRefs', 'backgroundRefs'], 'chat supplement');
  assertString(supplement.sessionId, 'chat supplement session', 256);
  if (primarySession !== undefined && supplement.sessionId !== primarySession) throw new Error('chat supplement session mismatch');
  const seen = new Set(primarySession === supplement.sessionId ? primaryRefs.map(ref => ref.id) : []);
  for (const key of ['unreadRefs', 'backgroundRefs']) {
    const refs = assertAfterglowPositions(supplement[key], `chat supplement ${key}`, true);
    if (refs.length > 6) throw new Error('chat supplement capacity');
    for (const ref of refs) {
      if (seen.has(ref.id)) throw new Error('chat supplement duplicate');
      seen.add(ref.id);
    }
  }
}

function assertInternalPaperRetry(value: unknown, affectOnly: boolean) {
  const retry = recordOf(value, 'internal paper retry');
  assertKeys(retry, ['generationKey', 'attemptedAt', 'attempts', 'retryAfter', 'refs', 'materials'],
    affectOnly ? ['sessionId', 'end', 'contactWaiting'] : ['sessionId', 'end', 'chatSupplement'], 'internal paper retry');
  assertString(retry.generationKey, 'retry generationKey', 256);
  for (const key of ['attemptedAt', 'retryAfter']) assertTimestamp(retry[key], `retry ${key}`);
  if (!Number.isSafeInteger(retry.attempts) || Number(retry.attempts) < 1 || Number(retry.attempts) > 3) throw new Error('retry attempts 无效。');
  const refs = assertAfterglowPositions(retry.refs, 'retry refs', true);
  if (retry.contactWaiting !== undefined) {
    assertContactWaiting(retry.contactWaiting);
    if (retry.sessionId !== undefined || refs.length) throw new Error('waiting context cannot consume chat');
  }
  if (retry.chatSupplement !== undefined) assertChatSupplement(retry.chatSupplement, retry.sessionId, refs);
  if (retry.sessionId !== undefined) {
    assertString(retry.sessionId, 'retry sessionId', 256);
    const end = assertAfterglowPosition(retry.end, 'retry end');
    if (!refs.some(ref => ref.id === end.id && ref.createdAt === end.createdAt)) throw new Error('retry end 不在 refs 内。');
  } else if (refs.length || retry.end !== undefined) throw new Error('retry life 包含 chat。');
  if (!Array.isArray(retry.materials)) throw new Error('retry materials 无效。');
  const ids = new Set<string>();
  for (const value of retry.materials) {
    const ref = object(value, ['kind', 'id', 'createdAt', 'revision'], 'retry material');
    assertEnum(ref.kind, affectOnly ? ['life', 'poke'] : ['care', 'heart', 'dream', 'life', 'poke'], 'retry material kind');
    assertString(ref.id, 'retry material id', 256);
    assertString(ref.revision, 'retry material revision', 256);
    assertTimestamp(ref.createdAt, 'retry material createdAt');
    const key = `${ref.kind}:${ref.id}`;
    if (ids.has(key)) throw new Error('retry material 重复。');
    ids.add(key);
  }
}

function assertInternalPaperSkipped(value: unknown) {
  const skipped = object(value, ['generationKey', 'at'], 'internal paper lastSkipped');
  assertString(skipped.generationKey, 'lastSkipped generationKey', 256);
  assertTimestamp(skipped.at, 'lastSkipped at');
}

function assertContactWaiting(value: unknown) {
  const waiting = object(value, ['sessionId', 'firstI', 'latestYou', 'refs'], 'contact waiting');
  assertString(waiting.sessionId, 'contact waiting session', 256);
  const firstI = assertAfterglowPositions([waiting.firstI], 'contact waiting first I', true)[0];
  const latestYou = assertAfterglowPositions([waiting.latestYou], 'contact waiting latest you', true)[0];
  const refs = assertAfterglowPositions(waiting.refs, 'contact waiting refs', true);
  if (Number(firstI.createdAt) < Number(latestYou.createdAt) || !refs.some(ref => ref.id === firstI.id
    && ref.createdAt === firstI.createdAt && ref.revision === firstI.revision)
    || !refs.some(ref => ref.id === latestYou.id && ref.createdAt === latestYou.createdAt && ref.revision === latestYou.revision))
    throw new Error('contact waiting sources missing');
}

function assertAffectReader(value: unknown) {
  const reader = recordOf(value, 'affect reader');
  assertKeys(reader, ['paper', 'activatedAt', 'updatedAt', 'cursors', 'life'], ['lateMessages', 'lastAttemptAt', 'retryAfter', 'generatedAt', 'pending', 'retry', 'lastSkipped', 'pokes'], 'affect reader');
  if (reader.retry !== undefined) assertInternalPaperRetry(reader.retry, true);
  if (reader.lastSkipped !== undefined) assertInternalPaperSkipped(reader.lastSkipped);
  if (reader.paper !== 'affect') throw new Error('affect paper');
  for (const key of ['activatedAt', 'updatedAt', 'lastAttemptAt', 'retryAfter', 'generatedAt']) if (key in reader) assertTimestamp(reader[key], key);
  for (const cursor of Object.values(recordOf(reader.cursors, 'affect cursors'))) assertAfterglowPosition(cursor, 'affect cursor');
  for (const refs of Object.values(recordOf(reader.lateMessages ?? {}, 'affect late'))) assertAfterglowPositions(refs, 'affect late');
  for (const revision of Object.values(recordOf(reader.life, 'affect life'))) assertString(revision, 'affect life revision', 256);
  for (const [id, revision] of Object.entries(recordOf(reader.pokes ?? {}, 'affect pokes'))) {
    assertString(id, 'affect poke id', 256); assertString(revision, 'affect poke revision', 256);
  }
  if (reader.pending === undefined) return;
  const p = recordOf(reader.pending, 'affect pending');
  assertKeys(p, ['generationKey', 'attemptedAt', 'refs', 'lifeRefs', 'affect', 'applied'], ['sessionId', 'end', 'pokeRefs', 'contactWaiting'], 'affect pending');
  assertString(p.generationKey, 'affect operation', 256); assertTimestamp(p.attemptedAt, 'affect attempt');
  const refs = assertAfterglowPositions(p.refs, 'affect refs', true);
  if (p.contactWaiting !== undefined) {
    assertContactWaiting(p.contactWaiting);
    if (p.sessionId !== undefined || refs.length) throw new Error('waiting context cannot consume chat');
  }
  assertAfterglowPositions(p.lifeRefs, 'affect life refs', true);
  if (p.pokeRefs !== undefined) assertAfterglowPositions(p.pokeRefs, 'affect poke refs', true);
  if (typeof p.applied !== 'boolean') throw new Error('affect applied');
  if (p.sessionId !== undefined) {
    assertString(p.sessionId, 'affect session', 256);
    const end = assertAfterglowPosition(p.end, 'affect end');
    if (!refs.some(ref => ref.id === end.id && ref.createdAt === end.createdAt)) throw new Error('affect end not in refs');
  } else if (refs.length || p.end !== undefined) throw new Error('affect life contains chat');
  assertAffectBasket(p.affect);
}

function assertAffectBasket(value: unknown) {
  if (value === null) return;
  const affect = object(value, ['emotions', 'lifeState', 'relationshipFeeling', 'relationshipChoice', 'strain'], 'affect basket');
  for (const [key, values] of Object.entries({ lifeState: ['calm', 'tired', 'sleepy', 'asleep'], relationshipFeeling: ['warm', 'mixed', 'unhappy', 'averse'],
    relationshipChoice: ['closer', 'steady', 'farther', 'consider_leaving'], strain: ['clear', 'tense', 'blocked'] })) {
    if (affect[key] !== null) assertEnum(affect[key], values, `affect ${key}`);
  }
  if (affect.emotions !== null) {
    const emotions = object(affect.emotions, ['primary', 'secondary'], 'affect emotions');
    if (!Array.isArray(emotions.secondary) || emotions.secondary.length > 1) throw new Error('affect secondary');
    for (const value of [emotions.primary, ...emotions.secondary]) {
      const e = recordOf(value, 'emotion');
      assertKeys(e, ['id', 'strength', 'target'], ['reason'], 'emotion');
      if (Object.hasOwn(e, 'reason') && e.reason !== null && typeof e.reason !== 'string') throw new Error('emotion reason');
      assertEnum(e.id, BAIYUN_EMOTION_IDS, 'emotion id'); assertEnum(e.strength, ['soft', 'clear', 'strong'], 'emotion strength');
      assertEnum(e.target, ['I', 'you', 'other', 'situation'], 'emotion target');
    }
  }
}

function assertWantsBasket(value: unknown) {
  if (value === null) return;
  if (!Array.isArray(value) || value.length > 3) throw new Error('wants basket 无效。');
  const ids = new Set();
  for (const item of value) {
    const want = object(item, ['id', 'change'], 'wants basket item');
    if (!JUNLUO_DESIRE_IDS.includes(want.id as never) || want.id === 'remind_you' || ids.has(want.id)
      || !['更想一点', '更想一些', '更想很多', '更不愿意一点', '更不愿意一些', '更不愿意很多',
        '满足一点', '满足一些', '满足很多'].includes(String(want.change))) throw new Error('wants basket item 无效。');
    ids.add(want.id);
  }
}

function assertTheaterSelection(value: unknown) {
  const selection = recordOf(value, 'theater selection');
  assertKeys(selection, ['revision', 'checkpointParagraphs', 'lines', 'updatedAt'], ['attempts'], 'theater selection');
  assertString(selection.revision, 'theater selection revision', 256);
  assertTimestamp(selection.updatedAt, 'theater selection updatedAt');
  if (selection.attempts !== undefined) {
    const attempts = object(selection.attempts, ['wants', 'affect'], 'theater selection attempts');
    for (const count of Object.values(attempts)) {
      if (!Number.isSafeInteger(count) || Number(count) < 0 || Number(count) > 3) throw new Error('theater selection attempts 无效。');
    }
  }
  if (!Array.isArray(selection.checkpointParagraphs)
    || selection.checkpointParagraphs.some((index, position, all) => !Number.isSafeInteger(index)
      || Number(index) < 0 || position > 0 && Number(index) <= Number(all[position - 1]))) {
    throw new Error('theater checkpoint paragraphs 无效。');
  }
  if (!Array.isArray(selection.lines) || !selection.lines.length) throw new Error('theater selected lines 无效。');
  const ends = new Map<string, number>();
  for (const value of selection.lines) {
    const line = object(value, ['versionId', 'start', 'end'], 'theater selected line');
    assertString(line.versionId, 'theater selected version', 512);
    if (!Number.isSafeInteger(line.start) || !Number.isSafeInteger(line.end)
      || Number(line.start) < 0 || Number(line.end) <= Number(line.start)
      || Number(line.start) < (ends.get(String(line.versionId)) ?? 0)) throw new Error('theater selected range 无效。');
    ends.set(String(line.versionId), Number(line.end));
  }
}

function assertSharedExperience(value: unknown) {
  const state = recordOf(value, 'shared experience');
  assertKeys(state, ['activatedAt', 'updatedAt', 'processed', 'focus'],
    ['lastReadingAttemptAt', 'crossPageActivatedAt', 'lastCrossPageAttemptAt', 'batch', 'lastFinished', 'theaterSelections'], 'shared experience');
  for (const key of ['activatedAt', 'updatedAt', 'lastReadingAttemptAt', 'crossPageActivatedAt', 'lastCrossPageAttemptAt'])
    if (key in state) assertTimestamp(state[key], key);
  for (const [id, revision] of Object.entries(recordOf(state.processed, 'experience processed'))) {
    assertString(id, 'experience processed id', 1024);
    if (!/^(focus-log|focus-end|reading-summary|reading-annotation|reading-question|post-exchange|call-round|letter-exchange|theater-unit|gift-event):.+$/.test(id)) throw new Error('experience processed kind 无效。');
    assertString(revision, 'experience processed revision', 256);
  }
  for (const [id, value] of Object.entries(recordOf(state.focus, 'experience focus'))) {
    assertString(id, 'experience focus id', 512);
    const progress = object(value, ['throughAt', 'throughElapsedSeconds'], 'experience focus progress');
    assertTimestamp(progress.throughAt, 'experience focus throughAt');
    assertFiniteNumber(progress.throughElapsedSeconds, 'experience focus elapsed');
    if (Number(progress.throughElapsedSeconds) < 0) throw new Error('experience focus elapsed 无效。');
  }
  if (state.theaterSelections !== undefined) {
    for (const [positionId, selection] of Object.entries(recordOf(state.theaterSelections, 'theater selections'))) {
      assertString(positionId, 'theater selection position', 512);
      assertTheaterSelection(selection);
    }
  }
  if (state.lastFinished !== undefined) {
    const finished = object(state.lastFinished, ['generationKey', 'at', 'outcome'], 'experience lastFinished');
    assertString(finished.generationKey, 'experience finished key', 256);
    assertTimestamp(finished.at, 'experience finished at');
    assertEnum(finished.outcome, ['saved', 'skipped'], 'experience finished outcome');
  }
  if (state.batch === undefined) return;
  const batch = recordOf(state.batch, 'experience batch');
  assertKeys(batch, ['generationKey', 'preparedAt', 'kind', 'ownerId', 'refs', 'fromAt', 'throughAt', 'wants', 'affect'],
    ['fromElapsedSeconds', 'throughElapsedSeconds', 'focusEnded', 'chatMessageIds', 'segments', 'theaterSelection', 'chatSupplement', 'outingRefs'], 'experience batch');
  if (batch.chatSupplement !== undefined) assertChatSupplement(batch.chatSupplement);
  if (batch.outingRefs !== undefined) {
    if (!Array.isArray(batch.outingRefs) || batch.outingRefs.length > 6) throw new Error('outing refs capacity');
    const seen = new Set<string>();
    for (const value of batch.outingRefs) {
      const ref = object(value, ['kind', 'id', 'createdAt', 'revision'], 'outing ref');
      assertString(ref.id, 'outing ref id', 256);
      assertString(ref.revision, 'outing ref revision', 256);
      assertTimestamp(ref.createdAt, 'outing ref time');
      if (ref.kind !== 'life' || !String(ref.id).startsWith('nearby-outing:')
        || Number(ref.createdAt) > Number(batch.throughAt) || seen.has(String(ref.id))) throw new Error('outing ref invalid');
      seen.add(String(ref.id));
    }
  }
  assertString(batch.generationKey, 'experience batch key', 256);
  assertString(batch.ownerId, 'experience owner', 512);
  assertEnum(batch.kind, ['focus', 'reading', 'post', 'call', 'letter', 'theater', 'gift'], 'experience kind');
  const crossPage = ['post', 'call', 'letter', 'theater', 'gift'].includes(String(batch.kind));
  if (crossPage && state.crossPageActivatedAt === undefined) throw new Error('cross-page experience activation missing');
  for (const key of ['preparedAt', 'fromAt', 'throughAt']) assertTimestamp(batch[key], key);
  if (Number(batch.fromAt) > Number(batch.throughAt) || Number(batch.throughAt) > Number(batch.preparedAt)) throw new Error('experience time range 无效。');
  if (batch.kind === 'focus') {
    for (const key of ['fromElapsedSeconds', 'throughElapsedSeconds']) {
      assertFiniteNumber(batch[key], key);
      if (Number(batch[key]) < 0) throw new Error('experience elapsed 无效。');
    }
    if (Number(batch.fromElapsedSeconds) > Number(batch.throughElapsedSeconds) || typeof batch.focusEnded !== 'boolean') throw new Error('experience focus range 无效。');
  } else if (['fromElapsedSeconds', 'throughElapsedSeconds', 'focusEnded'].some(key => key in batch)) throw new Error('non-focus batch contains focus fields');
  if (batch.chatMessageIds !== undefined) {
    if (batch.kind !== 'letter' || !Array.isArray(batch.chatMessageIds)) throw new Error('experience linked messages 无效。');
    const messageIds = new Set<string>();
    for (const id of batch.chatMessageIds) {
      assertString(id, 'experience linked message id', 512);
      if (messageIds.has(id as string)) throw new Error('experience linked message duplicate');
      messageIds.add(id as string);
    }
  }
  if (batch.segments !== undefined) {
    if (!crossPage || batch.kind === 'theater') throw new Error('experience segments unavailable');
    const segments = object(batch.segments, ['ends', 'index'], 'experience segments');
    if (!Array.isArray(segments.ends) || !segments.ends.length
      || !Number.isSafeInteger(segments.index) || Number(segments.index) < 0
      || Number(segments.index) >= segments.ends.length) throw new Error('experience segment index 无效。');
    let previous = 0;
    for (const end of segments.ends) {
      if (!Number.isSafeInteger(end) || Number(end) <= previous) throw new Error('experience segment boundary 无效。');
      previous = Number(end);
    }
  }
  if (!Array.isArray(batch.refs) || !batch.refs.length) throw new Error('experience refs 无效。');
  if (batch.kind === 'theater' && batch.refs.length !== 1) throw new Error('theater experience requires one unit');
  if (batch.theaterSelection !== undefined) {
    if (batch.kind !== 'theater') throw new Error('non-theater batch contains theater selection');
    assertTheaterSelection(batch.theaterSelection);
    if (recordOf(batch.theaterSelection, 'theater selection').revision
      !== recordOf(batch.refs[0], 'theater ref').revision) throw new Error('theater selection revision mismatch');
  }
  const ids = new Set<string>();
  for (const value of batch.refs) {
    const ref = object(value, ['kind', 'id', 'createdAt', 'revision', 'ownerId'], 'experience ref');
    const refKinds = batch.kind === 'focus' ? ['focus-log', 'focus-end'] : batch.kind === 'reading'
      ? ['reading-summary', 'reading-annotation', 'reading-question'] : batch.kind === 'post' ? ['post-exchange']
        : batch.kind === 'call' ? ['call-round'] : batch.kind === 'theater' ? ['theater-unit'] : batch.kind === 'gift' ? ['gift-event'] : ['letter-exchange'];
    assertEnum(ref.kind, refKinds, 'experience ref kind');
    assertString(ref.id, 'experience ref id', 512); assertString(ref.revision, 'experience ref revision', 256);
    assertString(ref.ownerId, 'experience ref owner', 512); assertTimestamp(ref.createdAt, 'experience ref createdAt');
    if (ref.ownerId !== batch.ownerId || Number(ref.createdAt) > Number(batch.throughAt)
      || ref.kind === 'focus-end' && (batch.focusEnded !== true || ref.id !== batch.ownerId || ref.createdAt !== batch.throughAt)) throw new Error('experience ref identity/time mismatch');
    const key = `${ref.kind}:${ref.id}`;
    if (ids.has(key)) throw new Error('experience ref duplicate');
    ids.add(key);
  }
  for (const name of ['wants', 'affect']) {
    const paper = recordOf(batch[name], `experience ${name}`);
    assertKeys(paper, ['attempts'], ['retryAt', 'result'], `experience ${name}`);
    if (!Number.isSafeInteger(paper.attempts) || Number(paper.attempts) < 0 || Number(paper.attempts) > 3) throw new Error('experience attempts 无效。');
    if (('result' in paper || 'retryAt' in paper) && paper.attempts === 0) throw new Error('experience unattempted result/retry');
    if (paper.retryAt !== undefined) assertTimestamp(paper.retryAt, 'experience retryAt');
    if ('result' in paper) (name === 'wants' ? assertWantsBasket : assertAffectBasket)(paper.result);
  }
}

function assertNearStatusChatSource(value: unknown) {
  const source = object(value, ['version', 'connectionFingerprint', 'sessionId', 'refs'], 'near chat source');
  if (source.version !== 1 || !Array.isArray(source.refs) || !source.refs.length) throw new Error('near chat source version/refs');
  assertString(source.connectionFingerprint, 'near chat connection', 256);
  assertString(source.sessionId, 'near chat session', 512);
  const ids = new Set<string>();
  for (const value of source.refs) {
    const ref = object(value, ['id', 'revision'], 'near chat ref');
    const id = assertString(ref.id, 'near chat id', 1024);
    assertString(ref.revision, 'near chat revision', 256);
    if (ids.has(id)) throw new Error('near duplicate chat source');
    ids.add(id);
  }
}

function assertNearStatusContinuation(value: unknown, run: Record<string, unknown>) {
  const c = recordOf(value, 'near continuation');
  assertKeys(c, ['nextOrdinal', 'usedRequests', 'retryAllowed', 'materials', 'controlKey', 'sleepFacts', 'mixedTools', 'requests'],
    ['inFlight', 'sleep', 'tool', 'received', 'scheduleSources'], 'near continuation');
  const received = c.received === undefined ? undefined : recordOf(c.received, 'near continuation received');
  if (run.outcome !== 'started' || run.pending !== undefined || c.nextOrdinal !== 2 && c.nextOrdinal !== 3
    || c.usedRequests !== Number(c.nextOrdinal) - (c.inFlight === true || received?.kind === 'sleep_message' ? 0 : 1)
    || c.inFlight !== undefined && c.inFlight !== true
    || typeof c.retryAllowed !== 'boolean' || typeof c.mixedTools !== 'boolean') throw new Error('near continuation request state');
  const text = (v: unknown, label: string) => { if (typeof v !== 'string') throw new Error(`near continuation ${label}`); };
  text(c.controlKey, 'control'); text(c.sleepFacts, 'sleep facts');
  const m = recordOf(c.materials, 'near continuation materials');
  assertKeys(m, ['cloudForm', 'chatKey', 'materialKey', 'material', 'sleepConversation', 'counterEnabled',
    'lifeRefs', 'activityRefs', 'scheduleRefs', 'appointmentRefs'], ['thoughtRef', 'chatSource'], 'near continuation materials');
  if (m.chatSource !== undefined) assertNearStatusChatSource(m.chatSource);
  assertEnum(m.cloudForm, ['white', 'black'], 'near continuation cloud form');
  for (const key of ['chatKey', 'materialKey', 'material', 'sleepConversation']) text(m[key], key);
  if (m.materialKey !== run.materialKey || typeof m.counterEnabled !== 'boolean') throw new Error('near continuation material identity');
  for (const key of ['lifeRefs', 'activityRefs', 'scheduleRefs', 'appointmentRefs']) {
    if (!Array.isArray(m[key])) throw new Error('near continuation source refs');
    const ids = new Set<string>();
    for (const value of m[key]) {
      const ref = object(value, ['id', 'revision'], 'near continuation source');
      const id = assertString(ref.id, 'near continuation source id', 1024);
      assertString(ref.revision, 'near continuation source revision', 256);
      if (ids.has(id)) throw new Error('near continuation duplicate source');
      ids.add(id);
    }
  }
  if (m.thoughtRef !== undefined) {
    const ref = object(m.thoughtRef, ['id', 'revision', 'contentRevision'], 'near continuation thought');
    for (const key of ['id', 'revision', 'contentRevision']) assertString(ref[key], `near thought ${key}`, 256);
  }
  if (c.tool !== undefined) {
    const tool = recordOf(c.tool, 'near continuation tool');
    assertKeys(tool, ['subject', 'callId', 'toolId', 'name', 'input', 'receipt'], ['reasoningContent'], 'near continuation tool');
    if (tool.subject !== 'I') throw new Error('near continuation tool subject');
    assertEnum(tool.toolId, ['schedule.save_own', 'life.set_sleep_schedule'], 'near continuation tool id');
    assertString(tool.callId, 'near continuation call id', 512); assertString(tool.name, 'near continuation tool name', 256);
    recordOf(tool.input, 'near continuation tool input');
    if (tool.reasoningContent !== undefined) text(tool.reasoningContent, 'reasoning');
    const receipt = recordOf(tool.receipt, 'near continuation receipt');
    assertKeys(receipt, ['callId', 'toolId', 'ok', 'status', 'summary'], ['data', 'errorCode'], 'near continuation receipt');
    if (receipt.callId !== tool.callId || receipt.toolId !== tool.toolId || typeof receipt.ok !== 'boolean') throw new Error('near continuation receipt identity');
    assertString(receipt.status, 'near continuation receipt status', 256); text(receipt.summary, 'receipt summary');
    if (receipt.errorCode !== undefined) assertString(receipt.errorCode, 'near continuation receipt error', 256);
  }
  if (c.sleep !== undefined) {
    const sleep = recordOf(c.sleep, 'near continuation sleep');
    assertKeys(sleep, ['context', 'expectedRevision', 'sessionId', 'activeSessionId', 'messageKey', 'handoff'], ['savedResult'], 'near continuation sleep');
    const context = recordOf(sleep.context, 'near continuation sleep context');
    assertKeys(context, ['nightKey', 'revision', 'requestAt', 'originalSleepAt', 'originalWakeAt', 'currentSleepAt', 'currentWakeAt'], ['manualWakeUntil'], 'near continuation sleep context');
    assertString(context.nightKey, 'near continuation night', 40);
    for (const key of ['revision', 'requestAt', 'originalSleepAt', 'originalWakeAt', 'currentSleepAt', 'currentWakeAt', 'manualWakeUntil']) {
      if (context[key] !== undefined) assertTimestamp(context[key], `near continuation ${key}`);
    }
    assertTimestamp(sleep.expectedRevision, 'near continuation sleep revision');
    for (const key of ['sessionId', 'activeSessionId', 'messageKey']) assertString(sleep[key], `near continuation ${key}`, 512);
    if (sleep.savedResult !== undefined) {
      const result = object(sleep.savedResult, ['subject', 'ok', 'status', 'sleepAt', 'wakeAt'], 'near continuation sleep result');
      if (result.subject !== 'I' || typeof result.ok !== 'boolean') throw new Error('near continuation sleep result subject');
      assertEnum(result.status, ['applied', 'unchanged', 'pending_sleep', 'invalid_time', 'stale', 'unavailable'], 'near continuation sleep status');
      for (const key of ['sleepAt', 'wakeAt']) if (result[key] !== null) assertString(result[key], `near continuation ${key}`, 128);
    }
    if (sleep.handoff !== null) {
      const handoff = object(sleep.handoff, ['nightKey', 'messageId', 'sessionId'], 'near continuation sleep handoff');
      for (const key of ['nightKey', 'messageId', 'sessionId']) assertString(handoff[key], `near handoff ${key}`, 512);
      if (handoff.nightKey !== context.nightKey || handoff.sessionId !== sleep.sessionId) throw new Error('near continuation handoff identity');
    }
  }
  if (c.nextOrdinal === 3 && (!c.tool || !c.retryAllowed || c.sleep && recordOf(c.sleep, 'near continuation sleep').handoff !== null)) {
    throw new Error('near continuation third request unavailable');
  }
  if (received) {
    if (received.subject !== 'I' || c.inFlight !== undefined || c.nextOrdinal !== 2 || c.retryAllowed !== false
      || m.chatSource === undefined || run.sleepTransition !== undefined) {
      throw new Error('near continuation received identity');
    }
    if (received.kind === 'tool_instruction') {
      assertKeys(received, ['subject', 'kind', 'callId', 'toolId', 'name', 'input'], ['reasoningContent'], 'near continuation received tool');
      if (c.tool !== undefined || c.usedRequests !== 1) throw new Error('near continuation received tool state');
      assertEnum(received.toolId, ['schedule.save_own', 'life.set_sleep_schedule'], 'near continuation received tool id');
      assertString(received.callId, 'near continuation received call id', 512);
      assertString(received.name, 'near continuation received name', 256); recordOf(received.input, 'near continuation received input');
      if (received.reasoningContent !== undefined) text(received.reasoningContent, 'received reasoning');
    } else if (received.kind === 'sleep_message') {
      assertKeys(received, ['subject', 'kind', 'content'], [], 'near continuation received sleep message');
      assertString(received.content, 'near continuation received body', 10000);
      if (c.usedRequests !== 2 || !c.tool || recordOf(c.tool, 'near continuation tool').toolId !== 'life.set_sleep_schedule'
        || !c.sleep || !recordOf(c.sleep, 'near continuation sleep').handoff) throw new Error('near continuation received handoff state');
    } else throw new Error('near continuation received kind');
  }
  if (!Array.isArray(c.requests) || c.requests.length > Number(c.usedRequests)) throw new Error('near continuation requests');
  if (c.scheduleSources !== undefined) {
    const instruction = c.tool ? recordOf(c.tool, 'near continuation tool') : received;
    if (!m.chatSource || instruction?.toolId !== 'schedule.save_own' || run.sleepTransition !== undefined
      || !Array.isArray(c.scheduleSources) || !c.scheduleSources.length || c.scheduleSources.length > 8) throw new Error('near schedule sources');
    const ids = new Set<string>();
    for (const value of c.scheduleSources) {
      const source = recordOf(value, 'near schedule source');
      assertKeys(source, ['id', 'revision', 'planVersion', 'planRevision', 'started'], ['activityId'], 'near schedule source');
      const id = assertString(source.id, 'near schedule source id', 1024);
      assertString(source.revision, 'near schedule source revision', 256);
      assertTimestamp(source.planVersion, 'near schedule source plan version'); assertTimestamp(source.planRevision, 'near schedule source plan revision');
      if (typeof source.started !== 'boolean' || ids.has(id) || !(m.scheduleRefs as JsonRecord[]).some(ref => ref.id === id)) throw new Error('near schedule source identity');
      if (source.activityId !== undefined) assertString(source.activityId, 'near schedule source activity', 1024);
      ids.add(id);
    }
  }
  for (const value of c.requests) {
    const request = recordOf(value, 'near continuation request');
    assertKeys(request, ['paper', 'status', 'outputChars'], ['transport', 'cachedPromptTokens', 'completionTokens', 'finishReason', 'promptTokens', 'reason'], 'near continuation request');
    assertEnum(request.paper, ['visible', 'inner'], 'near continuation paper');
    assertEnum(request.status, ['success', 'failure', 'not-started'], 'near continuation request status');
    for (const key of ['outputChars', 'cachedPromptTokens', 'completionTokens', 'promptTokens']) if (request[key] !== undefined) assertTimestamp(request[key], key);
    for (const key of ['finishReason', 'reason']) if (request[key] !== undefined) text(request[key], key);
    if (request.transport !== undefined) {
      const transport = recordOf(request.transport, 'near continuation transport');
      assertKeys(transport, ['startedAt', 'outcome'], ['finishedAt', 'httpStatus', 'offeredToolCount', 'toolCapabilitySource'], 'near continuation transport');
      assertTimestamp(transport.startedAt, 'near continuation transport start');
      if (transport.finishedAt !== undefined) assertTimestamp(transport.finishedAt, 'near continuation transport end');
      if (transport.httpStatus !== undefined) assertTimestamp(transport.httpStatus, 'near continuation HTTP status');
      if (transport.offeredToolCount !== undefined) assertTimestamp(transport.offeredToolCount, 'near continuation offered tool count');
      if (transport.toolCapabilitySource !== undefined) assertEnum(transport.toolCapabilitySource,
        ['official_profile', 'verified_probe', 'protocol_default', 'disabled_default'], 'near continuation tool capability source');
      assertEnum(transport.outcome, ['started', 'response', 'http-error', 'network-error', 'timeout', 'aborted'], 'near continuation transport outcome');
    }
  }
}

function assertNearStatusRun(value: unknown) {
  const run = recordOf(value, 'near status run');
  assertKeys(run, ['schemaVersion', 'updatedAt', 'attemptedAt', 'generationKey', 'materialKey', 'outcome'], ['pending', 'opportunity', 'sleepTransition', 'continuation'], 'near status run');
  if (run.schemaVersion !== 1) throw new Error('near status version');
  for (const key of ['updatedAt', 'attemptedAt']) assertTimestamp(run[key], key);
  for (const key of ['generationKey', 'materialKey']) assertString(run[key], key, 256);
  assertEnum(run.outcome, ['started', 'saved', 'failed', 'interrupted'], 'near outcome');
  if (run.sleepTransition !== undefined) {
    const transition = object(run.sleepTransition, ['nightKey', 'eventId', 'at', 'revision', 'kind'], 'near sleep transition');
    assertString(transition.nightKey, 'transition night', 40);
    assertString(transition.eventId, 'transition event', 256);
    assertString(transition.revision, 'transition revision', 256);
    assertTimestamp(transition.at, 'transition time');
    assertEnum(transition.kind, ['sleep', 'sleep_return', 'poke_awake', 'morning_awake', 'get_up'], 'transition kind');
  }
  if (run.opportunity !== undefined) {
    const opportunity = object(run.opportunity, ['observedAt', 'refs'], 'near opportunity');
    assertTimestamp(opportunity.observedAt, 'near opportunity time');
    if (!Array.isArray(opportunity.refs) || opportunity.refs.length > 10) throw new Error('near opportunity refs');
    const ids = new Set<string>();
    for (const value of opportunity.refs) {
      const ref = object(value, ['id', 'revision'], 'near opportunity ref');
      assertString(ref.id, 'near opportunity id', 1024);
      assertString(ref.revision, 'near opportunity revision', 256);
      if (ids.has(ref.id as string)) throw new Error('near opportunity duplicate');
      ids.add(ref.id as string);
    }
  }
  if (run.continuation !== undefined) assertNearStatusContinuation(run.continuation, run);
  if (run.pending === undefined) return;
  const p = recordOf(run.pending, 'near pending');
  assertKeys(p, ['paper', 'chatKey', 'controlKey', 'applied', 'lifeRefs', 'appointmentRefs'], ['thoughtRef', 'cloudForm', 'activityRefs', 'scheduleRefs', 'chatSource'], 'near pending');
  if (p.chatSource !== undefined) assertNearStatusChatSource(p.chatSource);
  if (p.cloudForm !== undefined) assertEnum(p.cloudForm, ['white', 'black'], 'near source cloud form');
  for (const field of ['lifeRefs', 'appointmentRefs', 'activityRefs', 'scheduleRefs']) {
    if ((field === 'activityRefs' || field === 'scheduleRefs') && p[field] === undefined) continue;
    if (!Array.isArray(p[field])) throw new Error('near source refs');
    for (const value of p[field]) { const ref = object(value, ['id', 'revision'], 'near source');
      assertString(ref.id, 'near source id', 1024); assertString(ref.revision, 'near source revision', 256); }
  }
  assertString(p.controlKey, 'near control', 2048);
  if (typeof p.chatKey !== 'string' || p.chatKey.length > 256) throw new Error('near chat key');
  if (p.thoughtRef !== undefined) { const ref = object(p.thoughtRef, ['id', 'revision', 'contentRevision'], 'near thought ref');
    assertString(ref.id, 'thought id', 256); assertString(ref.revision, 'thought revision', 256);
    assertString(ref.contentRevision, 'thought content revision', 256); }
  const paper = recordOf(p.paper, 'near paper');
  const parts = ['nearStatus', 'thoughtNew', 'thoughtDecision', 'counterIdea'];
  assertKeys(paper, ['issues'], parts, 'near paper');
  if (!Array.isArray(paper.issues) || paper.issues.some(issue => typeof issue !== 'string')) throw new Error('near issues');
  if (!parts.some(key => key in paper) || !Array.isArray(p.applied) || new Set(p.applied).size !== p.applied.length
    || p.applied.some(key => typeof key !== 'string' || !parts.includes(key) || !(key in paper))) throw new Error('near applied');
  if (paper.nearStatus !== undefined) assertTextDraft(paper.nearStatus, 'near text', true);
  if (paper.thoughtNew != null) { const t = object(paper.thoughtNew, ['desireId', 'content'], 'near thought');
    assertEnum(t.desireId, JUNLUO_DESIRE_IDS.filter(id => id !== 'remind_you'), 'thought desire'); assertString(t.content, 'thought content', 160); }
  if (paper.thoughtDecision != null) { const d = object(paper.thoughtDecision, ['thoughtId', 'choice'], 'near decision');
    assertString(d.thoughtId, 'decision id', 256); assertEnum(d.choice, ['choose_again', 'release'], 'decision choice');
    if (d.thoughtId !== recordOf(p.thoughtRef, 'decision source').id) throw new Error('near mismatched thought'); }
  if (paper.counterIdea != null) { const idea = object(paper.counterIdea, ['keyword', 'targetCount', 'days'], 'near counter');
    assertString(idea.keyword, 'counter keyword', 4000);
    const positive = (v: unknown) => Number.isSafeInteger(v) && Number(v) > 0;
    if (!((positive(idea.targetCount) && idea.days === null) || (positive(idea.days) && idea.targetCount === null))) throw new Error('near counter target'); }
}

function assertConversationAfterglow(value: Record<string, unknown>) {
  const label = 'conversation afterglow wants';
  assertKeys(value, ['schemaVersion', 'paper', 'activatedAt', 'updatedAt', 'cursors', 'materials'],
    ['lateMessages', 'lastAttemptAt', 'generatedAt', 'lastLifeMaterialKey', 'pending', 'affect', 'retry', 'lastSkipped', 'experience'], label);
  if (value.retry !== undefined) assertInternalPaperRetry(value.retry, false);
  if (value.lastSkipped !== undefined) assertInternalPaperSkipped(value.lastSkipped);
  if (value.affect !== undefined) assertAffectReader(value.affect);
  if (value.experience !== undefined) assertSharedExperience(value.experience);
  if (value.schemaVersion !== 3 || value.paper !== 'wants') throw new Error(`${label} 只接受当前格式。`);
  for (const field of ['activatedAt', 'updatedAt', 'lastAttemptAt', 'generatedAt']) {
    if (field in value) assertTimestamp(value[field], `${label}.${field}`);
  }
  if ('lastLifeMaterialKey' in value) assertString(value.lastLifeMaterialKey, `${label}.lastLifeMaterialKey`, 256);
  for (const [sessionId, cursor] of Object.entries(recordOf(value.cursors, `${label}.cursors`))) {
    assertString(sessionId, `${label}.sessionId`, 256);
    assertAfterglowPosition(cursor, `${label}.cursor`);
  }
  if ('lateMessages' in value) {
    for (const [sessionId, refs] of Object.entries(recordOf(value.lateMessages, `${label}.lateMessages`))) {
      assertString(sessionId, `${label}.sessionId`, 256);
      assertAfterglowPositions(refs, `${label}.lateMessages`);
    }
  }
  const materials = recordOf(value.materials, `${label}.materials`);
  assertKeys(materials, ['activatedAt', 'care', 'hearts', 'life'], ['dream', 'pokes'], `${label}.materials`);
  assertTimestamp(materials.activatedAt, `${label}.materials.activatedAt`);
  for (const [id, revision] of Object.entries(recordOf(materials.pokes ?? {}, 'wants pokes'))) {
    assertString(id, 'wants poke id', 256); assertString(revision, 'wants poke revision', 256);
  }
  if (materials.dream !== undefined) assertAfterglowPosition(materials.dream, `${label}.materials.dream`);
  for (const kind of ['care', 'life']) {
    for (const [id, revision] of Object.entries(recordOf(materials[kind], `${label}.materials.${kind}`))) {
      assertString(id, `${label}.materials.id`, 256);
      assertString(revision, `${label}.materials.revision`, 256);
    }
  }
  if (!Array.isArray(materials.hearts) || new Set(materials.hearts).size !== materials.hearts.length) {
    throw new Error(`${label}.materials.hearts 无效。`);
  }
  for (const id of materials.hearts) assertString(id, `${label}.materials.hearts.id`, 256);
  if (!('pending' in value)) return;
  const pending = recordOf(value.pending, `${label}.pending`);
  assertKeys(pending, ['generationKey', 'source', 'materialKey', 'attemptedAt', 'refs', 'wants', 'materials', 'applied'],
    ['sessionId', 'end', 'chatSupplement'], `${label}.pending`);
  for (const field of ['generationKey', 'materialKey']) assertString(pending[field], `${label}.${field}`, 256);
  assertTimestamp(pending.attemptedAt, `${label}.attemptedAt`);
  if (typeof pending.applied !== 'boolean') throw new Error(`${label}.applied 无效。`);
  const refs = assertAfterglowPositions(pending.refs, `${label}.pending.refs`, true);
  if (pending.chatSupplement !== undefined) assertChatSupplement(pending.chatSupplement, pending.sessionId, refs);
  if (pending.source === 'afterglow') {
    assertString(pending.sessionId, `${label}.pending.sessionId`, 256);
    const end = assertAfterglowPosition(pending.end, `${label}.pending.end`);
    if (!refs.some(ref => ref.id === end.id && ref.createdAt === end.createdAt)) throw new Error(`${label}.pending.end 不在 refs 内。`);
  } else if (pending.source !== 'life' || refs.length || 'sessionId' in pending || 'end' in pending) {
    throw new Error(`${label}.pending.source/refs 无效。`);
  }
  assertWantsBasket(pending.wants);
  if (!Array.isArray(pending.materials)) throw new Error(`${label}.pending.materials 无效。`);
  const materialIds = new Set();
  for (const item of pending.materials) {
    const material = recordOf(item, `${label}.pending.material`);
    assertKeys(material, ['kind', 'id', 'createdAt', 'revision'], [], `${label}.pending.material`);
    if (!['care', 'heart', 'dream', 'life', 'poke'].includes(String(material.kind))) throw new Error(`${label}.pending.material.kind 无效。`);
    assertString(material.id, `${label}.pending.material.id`, 256);
    assertString(material.revision, `${label}.pending.material.revision`, 256);
    assertTimestamp(material.createdAt, `${label}.pending.material.createdAt`);
    const key = `${material.kind}:${material.id}`;
    if (materialIds.has(key)) throw new Error(`${label}.pending.material 重复。`);
    materialIds.add(key);
  }
}

export function isLegacyWantsStateRecord(kind: AssistantLifeStateRecordKind, value: unknown) {
  return (kind === 'inner-desire-state' || kind === 'conversation-afterglow')
    && recordOf(value, kind).schemaVersion !== (kind === 'inner-desire-state' ? 4 : 3);
}

export function assertAssistantLifeStateTransportRecord(kind: AssistantLifeStateRecordKind, entityId: string, value: unknown) {
  if (isLegacyWantsStateRecord(kind, value)) {
    if (kind === 'inner-desire-state') {
      if (entityId !== 'desire' || !upgradeJunluoDesireState(value)) throw new Error('legacy inner desire state 无效。');
    } else {
      if (entityId !== 'conversation-afterglow') throw new Error('legacy afterglow entity id 无效。');
      assertLegacyConversationAfterglowState(value);
    }
    return;
  }
  assertAssistantLifeStateRecord(kind, entityId, value);
}

function assertGlobalInteraction(value: Record<string, unknown>) {
  assertKeys(
    value,
    ['lastInteractionAt', 'source'],
    [],
    'global interaction',
  );
  assertTimestamp(value.lastInteractionAt, 'global interaction lastInteractionAt');
  const source = assertString(value.source, 'global interaction source', 40);
  if (!GLOBAL_INTERACTION_SOURCES.has(source)) {
    throw new Error('global interaction source 无效。');
  }
}

function assertLoveSummary(value: Record<string, unknown>) {
  const hasCurrentFields = 'fromYou' in value || 'toYou' in value;
  const hasLegacyFields = 'fromHamster' in value || 'toHamster' in value;
  if (hasCurrentFields && hasLegacyFields) {
    throw new Error('love summary 不得混用新旧主体字段。');
  }
  const fromField = hasCurrentFields ? 'fromYou' : 'fromHamster';
  const toField = hasCurrentFields ? 'toYou' : 'toHamster';

  assertKeys(
    value,
    [
      fromField,
      'generatedAt',
      'intimacyLevel',
      'libidoLabel',
      'sourceHash',
      'sourceTags',
      toField,
      'want',
    ],
    [],
    'love summary',
  );
  assertTimestamp(value.generatedAt, 'love summary generatedAt');
  assertString(value.sourceHash, 'love summary sourceHash', 160);
  for (const field of [fromField, 'libidoLabel', toField, 'want']) {
    assertString(value[field], `love summary ${field}`, 8000);
  }
  if (!['low', 'medium', 'high'].includes(String(value.intimacyLevel))) {
    throw new Error('love summary intimacyLevel 无效。');
  }
  if (
    !Array.isArray(value.sourceTags)
    || value.sourceTags.some((tag) => typeof tag !== 'string' || tag.length > 80)
  ) {
    throw new Error('love summary sourceTags 无效。');
  }
}

function assertKindMatchesEntity(
  entityType: string,
  kind: AssistantLifeStateRecordKind,
) {
  const valid = (
    (entityType === 'assistant-state' && kind === 'assistant-state')
    || (entityType === 'life-day' && kind === 'life-day')
    || (
      entityType === 'drive-state'
      && [
        'desire-state',
        'drive-metabolism',
        'life-rhythm',
        'conversation-afterglow',
        'global-interaction',
        'love-summary',
      ].includes(kind)
    )
    || (
      entityType === 'inner-state'
      && [
        'inner-desire-state',
        'inner-affect-state',
        'inner-thought-state',
      ].includes(kind)
    )
  );
  if (!valid) throw new Error('assistant.life-state kind 与 entity type 不匹配。');
}

export function assertAssistantLifeStateRecord(
  kind: AssistantLifeStateRecordKind,
  entityId: string,
  value: unknown,
) {
  assertEntityId(entityId);
  const record = recordOf(value, `assistant.life-state ${kind}`);
  assertJsonValue(record);
  switch (kind) {
    case 'assistant-state':
      if (entityId !== 'current') throw new Error('assistant state entity id 必须为 current。');
      assertAssistantState(record);
      return;
    case 'life-day':
      assertLifeDay(record, entityId);
      return;
    case 'desire-state':
      if (entityId !== 'desire') throw new Error('desire state entity id 无效。');
      assertDesireState(record);
      return;
    case 'drive-metabolism':
      if (entityId !== 'metabolism') throw new Error('drive metabolism entity id 无效。');
      assertDriveMetabolism(record);
      return;
    case 'life-rhythm':
      if (entityId !== 'rhythm') throw new Error('life rhythm entity id 无效。');
      assertLifeRhythm(record);
      return;
    case 'conversation-afterglow':
      if (entityId !== 'conversation-afterglow') {
        throw new Error('conversation afterglow entity id 无效。');
      }
      assertConversationAfterglow(record);
      return;
    case 'global-interaction':
      if (entityId !== 'global-interaction') {
        throw new Error('global interaction entity id 无效。');
      }
      assertGlobalInteraction(record);
      return;
    case 'love-summary':
      if (entityId !== 'love-summary') throw new Error('love summary entity id 无效。');
      assertLoveSummary(record);
      return;
    case 'inner-desire-state':
      if (entityId !== 'desire' || !isJunluoDesireState(value)) {
        throw new Error('inner desire state 无效。');
      }
      return;
    case 'inner-affect-state':
      if (
        entityId !== 'affect'
        || (!isJunluoAffectStateV1(value) && !isJunluoAffectStateLegacyV1(value))
      ) {
        throw new Error('inner affect state 无效。');
      }
      return;
    case 'inner-thought-state':
      if (entityId !== 'thoughts' || !isJunluoThoughtStateV1(value)) {
        throw new Error('inner thought state 无效。');
      }
      return;
  }
}

export function assertAssistantLifeStateMutationV1(
  value: unknown,
): asserts value is PlainMutationV1 {
  assertPlainMutationV1(value);
  if (
    value.entity.domain !== 'life'
    || ![
      'assistant-state',
      'life-day',
      'drive-state',
      'inner-state',
    ].includes(value.entity.type)
  ) {
    throw new Error('assistant.life-state mutation entity 无效。');
  }
  if (value.revision.schemaVersion !== ASSISTANT_LIFE_STATE_SCHEMA_VERSION) {
    throw new Error('assistant.life-state schemaVersion 无效。');
  }
  if (value.sensitivity !== 'high') {
    throw new Error('assistant.life-state sensitivity 必须为 high。');
  }
  if (value.retentionClass !== ASSISTANT_LIFE_STATE_RETENTION_CLASS) {
    throw new Error('assistant.life-state retentionClass 无效。');
  }
  if (value.objectRefs.length) {
    throw new Error('assistant.life-state 不接受对象引用。');
  }
  const payload = recordOf(value.payload, 'assistant.life-state payload');
  if (value.revision.operation === 'delete') {
    assertKeys(
      payload,
      ['schemaVersion', 'deletedAt'],
      [],
      'assistant.life-state delete',
    );
    if (payload.schemaVersion !== ASSISTANT_LIFE_STATE_SCHEMA_VERSION) {
      throw new Error('assistant.life-state delete schemaVersion 无效。');
    }
    assertTimestamp(payload.deletedAt, 'assistant.life-state deletedAt');
    return;
  }
  if (
    value.revision.operation !== 'upsert'
    && value.revision.operation !== 'restore'
  ) {
    throw new Error('assistant.life-state 只允许 upsert、restore 或 delete。');
  }
  assertKeys(
    payload,
    ['schemaVersion', 'kind', 'value'],
    [],
    'assistant.life-state record',
  );
  if (payload.schemaVersion !== ASSISTANT_LIFE_STATE_SCHEMA_VERSION) {
    throw new Error('assistant.life-state payload schemaVersion 无效。');
  }
  const kind = payload.kind as AssistantLifeStateRecordKind;
  if (
    ![
      'assistant-state',
      'life-day',
      'desire-state',
      'drive-metabolism',
      'life-rhythm',
      'conversation-afterglow',
      'global-interaction',
      'love-summary',
      'inner-desire-state',
      'inner-affect-state',
      'inner-thought-state',
    ].includes(kind)
  ) {
    throw new Error('assistant.life-state record kind 无效。');
  }
  assertKindMatchesEntity(value.entity.type, kind);
  assertAssistantLifeStateTransportRecord(kind, value.entity.id, payload.value);
}

// Compatibility retry only after normal signature/decryption verification.
// Match the old rejection to the exact new field; never release arbitrary invalid life state.
export function isSupportedTheaterCoCreationProgressMutation(value: unknown, detail: string): boolean {
  try {
    assertAssistantLifeStateMutationV1(value);
    if (value.revision.operation !== 'upsert' && value.revision.operation !== 'restore') return false;
    const payload = recordOf(value.payload, 'assistant.life-state payload');
    if (payload.kind !== 'conversation-afterglow') return false;
    const state = recordOf(payload.value, 'conversation-afterglow');
    if (state.schemaVersion !== 3 || !state.experience) return false;
    const experience = recordOf(state.experience, 'shared experience');
    const batch = experience.batch ? recordOf(experience.batch, 'experience batch') : undefined;
    switch (detail) {
      case 'shared experience 包含未允许字段：theaterSelections。':
        return Object.prototype.hasOwnProperty.call(experience, 'theaterSelections');
      case 'experience processed kind 无效。':
        return Object.keys(recordOf(experience.processed, 'experience processed')).some(key => key.startsWith('theater-unit:'));
      case 'experience batch 包含未允许字段：theaterSelection。':
        return batch?.kind === 'theater' && Object.prototype.hasOwnProperty.call(batch, 'theaterSelection');
      case 'experience kind 无效。':
        return batch?.kind === 'theater';
      default: return false;
    }
  } catch { return false; }
}

export function buildAssistantLifeStateRecordMutation(input: {
  envelope: ChatCoreMutationEnvelope;
  entityType: AssistantLifeStateEntityType;
  entityId: string;
  kind: AssistantLifeStateRecordKind;
  value: JsonValue;
  operation?: 'upsert' | 'restore';
}) {
  assertAssistantLifeStateRecord(input.kind, input.entityId, input.value);
  const mutation: PlainMutationV1 = {
    protocolVersion: 1,
    mutationId: input.envelope.mutationId,
    vaultId: input.envelope.vaultId,
    sourceDeviceId: input.envelope.sourceDeviceId,
    sourceSequence: input.envelope.sourceSequence,
    createdAt: input.envelope.createdAt,
    entity: {
      domain: 'life',
      type: input.entityType,
      id: input.entityId,
    },
    revision: {
      id: input.envelope.revisionId,
      parents: [...input.envelope.parentRevisionIds],
      operation: input.operation ?? 'upsert',
      schemaVersion: ASSISTANT_LIFE_STATE_SCHEMA_VERSION,
    },
    sensitivity: 'high',
    payload: {
      schemaVersion: ASSISTANT_LIFE_STATE_SCHEMA_VERSION,
      kind: input.kind,
      value: input.value,
    },
    objectRefs: [],
    retentionClass: ASSISTANT_LIFE_STATE_RETENTION_CLASS,
  };
  assertAssistantLifeStateMutationV1(mutation);
  return mutation;
}

export function buildAssistantLifeStateDeleteMutation(input: {
  envelope: ChatCoreMutationEnvelope;
  entityType: AssistantLifeStateEntityType;
  entityId: string;
  deletedAt: number;
}) {
  const mutation: PlainMutationV1 = {
    protocolVersion: 1,
    mutationId: input.envelope.mutationId,
    vaultId: input.envelope.vaultId,
    sourceDeviceId: input.envelope.sourceDeviceId,
    sourceSequence: input.envelope.sourceSequence,
    createdAt: input.envelope.createdAt,
    entity: {
      domain: 'life',
      type: input.entityType,
      id: input.entityId,
    },
    revision: {
      id: input.envelope.revisionId,
      parents: [...input.envelope.parentRevisionIds],
      operation: 'delete',
      schemaVersion: ASSISTANT_LIFE_STATE_SCHEMA_VERSION,
    },
    sensitivity: 'high',
    payload: {
      schemaVersion: ASSISTANT_LIFE_STATE_SCHEMA_VERSION,
      deletedAt: input.deletedAt,
    },
    objectRefs: [],
    retentionClass: ASSISTANT_LIFE_STATE_RETENTION_CLASS,
  };
  assertAssistantLifeStateMutationV1(mutation);
  return mutation;
}
