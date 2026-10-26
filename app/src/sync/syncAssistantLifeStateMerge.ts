import { mergeOwnDayPlanState } from './syncOwnDayPlanState';
import {
  assertAssistantLifeStateMutationV1,
  assertAssistantLifeStateRecord,
  mergeUnifiedContactSummary,
  shouldKeepCurrentWantsState,
  hasPokeProgress,
  isLegacyWantsStateRecord,
  ASSISTANT_LIFE_STATE_RETENTION_CLASS,
  ASSISTANT_LIFE_STATE_SCHEMA_VERSION,
  type AssistantLifeStateEntityType,
  type AssistantLifeStateRecordKind,
} from './syncAssistantLifeState';
import type {
  JunluoAffectStateV1,
  JunluoDesireState,
  JunluoThoughtStateV1,
} from '../life/junluoInnerState';
import {
  mergeJunluoAffectStates,
  mergeJunluoDesireStates,
  mergeJunluoThoughtStates,
  upgradeJunluoAffectState,
} from '../life/junluoInnerStatePersistence';
import type {
  JsonValue,
  PlainMutationV1,
  SyncOperation,
} from './syncProtocol';

export type AssistantLifeStateRevisionValue = {
  revisionId: string;
  parentRevisionIds: string[];
  operation: SyncOperation;
  createdAt: number;
  payload: JsonValue;
};

export type AssistantLifeStateMergeDecision =
  | {
      kind: 'already-current' | 'apply-incoming' | 'ignore-incoming';
      payload: JsonValue;
      operation: SyncOperation;
      resultingHeadRevisionIds: string[];
    }
  | {
      kind: 'keep-current' | 'merged';
      payload: JsonValue;
      operation: SyncOperation;
      resultingHeadRevisionIds: string[];
      requiresMergeRevision: true;
      mergeParentRevisionIds: string[];
    }
  | {
      kind: 'conflict';
      payload: JsonValue;
      operation: SyncOperation;
      resultingHeadRevisionIds: string[];
      conflictKind: 'delete-modify';
      conflictingFields: string[];
    };

type JsonRecord = { [key: string]: JsonValue };

function recordOf(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象。`);
  }
  return value as JsonRecord;
}

function payloadRecord(revision: AssistantLifeStateRevisionValue) {
  return recordOf(revision.payload, 'assistant.life-state revision payload');
}

function payloadKind(revision: AssistantLifeStateRevisionValue) {
  if (revision.operation === 'delete') return null;
  const kind = payloadRecord(revision).kind;
  if (typeof kind !== 'string') {
    throw new Error('assistant.life-state revision 缺少 kind。');
  }
  return kind as AssistantLifeStateRecordKind;
}

function payloadValue(revision: AssistantLifeStateRevisionValue) {
  return recordOf(
    payloadRecord(revision).value,
    'assistant.life-state revision value',
  );
}

function compareJson(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== typeof right) {
    return false;
  }
  if (Array.isArray(left)) {
    return (
      Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => compareJson(value, right[index]))
    );
  }
  if (typeof left !== 'object' || Array.isArray(right)) return false;
  const leftRecord = left as JsonRecord;
  const rightRecord = right as JsonRecord;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length
    && leftKeys.every(
      (key, index) => (
        key === rightKeys[index]
        && compareJson(leftRecord[key], rightRecord[key])
      ),
    )
  );
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const record = value as JsonRecord;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function uniqueSorted(values: readonly string[]) {
  return [...new Set(values)].sort();
}

function assertRevision(
  entityType: AssistantLifeStateEntityType,
  entityId: string,
  revision: AssistantLifeStateRevisionValue,
) {
  const mutation: PlainMutationV1 = {
    protocolVersion: 1,
    mutationId: '10000000-0000-4000-8000-000000000001',
    vaultId: '20000000-0000-4000-8000-000000000002',
    sourceDeviceId: '30000000-0000-4000-8000-000000000003',
    sourceSequence: 1,
    createdAt: revision.createdAt,
    entity: {
      domain: 'life',
      type: entityType,
      id: entityId,
    },
    revision: {
      id: revision.revisionId,
      parents: revision.parentRevisionIds,
      operation: revision.operation,
      schemaVersion: ASSISTANT_LIFE_STATE_SCHEMA_VERSION,
    },
    sensitivity: 'high',
    payload: revision.payload,
    objectRefs: [],
    retentionClass: ASSISTANT_LIFE_STATE_RETENTION_CLASS,
  };
  assertAssistantLifeStateMutationV1(mutation);
}

function recordPayload(
  kind: AssistantLifeStateRecordKind,
  entityId: string,
  value: JsonRecord,
) {
  assertAssistantLifeStateRecord(kind, entityId, value);
  return {
    schemaVersion: ASSISTANT_LIFE_STATE_SCHEMA_VERSION,
    kind,
    value,
  } satisfies JsonValue;
}

function numberAt(value: JsonValue | undefined) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function selectRecord(
  current: JsonRecord,
  incoming: JsonRecord,
  currentRevisionId: string,
  incomingRevisionId: string,
  timestampField: string,
) {
  const currentAt = numberAt(current[timestampField]);
  const incomingAt = numberAt(incoming[timestampField]);
  if (currentAt !== incomingAt) return currentAt > incomingAt ? current : incoming;
  return currentRevisionId.localeCompare(incomingRevisionId) >= 0
    ? current
    : incoming;
}

function mergeRecordArrayById(
  leftValue: JsonValue | undefined,
  rightValue: JsonValue | undefined,
  timestampFields: readonly string[],
) {
  const byId = new Map<string, JsonRecord>();
  const insert = (value: JsonValue | undefined) => {
    if (!Array.isArray(value)) return;
    for (const itemValue of value) {
      const item = recordOf(itemValue, 'assistant.life-state merge item');
      const id = String(item.id ?? '');
      if (!id) throw new Error('assistant.life-state merge item 缺少 id。');
      const existing = byId.get(id);
      if (!existing) {
        byId.set(id, item);
        continue;
      }
      const existingAt = Math.max(
        ...timestampFields.map((field) => numberAt(existing[field])),
      );
      const itemAt = Math.max(
        ...timestampFields.map((field) => numberAt(item[field])),
      );
      if (
        itemAt > existingAt
        || (
          itemAt === existingAt
          && canonicalJson(item) > canonicalJson(existing)
        )
      ) {
        byId.set(id, item);
      }
    }
  };
  insert(leftValue);
  insert(rightValue);
  return [...byId.values()].sort((left, right) => {
    const leftAt = Math.max(
      ...timestampFields.map((field) => numberAt(left[field])),
    );
    const rightAt = Math.max(
      ...timestampFields.map((field) => numberAt(right[field])),
    );
    return leftAt - rightAt || String(left.id).localeCompare(String(right.id));
  }) as JsonValue;
}

function maxNumberRecord(
  leftValue: JsonValue | undefined,
  rightValue: JsonValue | undefined,
) {
  const left = (
    leftValue && typeof leftValue === 'object' && !Array.isArray(leftValue)
  ) ? leftValue as JsonRecord : {};
  const right = (
    rightValue && typeof rightValue === 'object' && !Array.isArray(rightValue)
  ) ? rightValue as JsonRecord : {};
  return Object.fromEntries(
    uniqueSorted([...Object.keys(left), ...Object.keys(right)])
      .map((key) => [key, Math.max(numberAt(left[key]), numberAt(right[key]))]),
  ) as JsonRecord;
}

function mergeSleepNearStatus(left?: JsonValue, right?: JsonValue): JsonValue | undefined {
  if (!left || !right) return left ?? right;
  const a = recordOf(left, 'sleep slots left'), b = recordOf(right, 'sleep slots right');
  const base = numberAt(a.initializedAt) <= numberAt(b.initializedAt) ? a : b;
  const other = base === a ? b : a;
  if (base.sleepAt !== other.sleepAt || base.postCount !== other.postCount || base.wakeCount !== other.wakeCount) return base;
  const newer = numberAt(a.updatedAt) >= numberAt(b.updatedAt) ? a : b;
  const aSlots = recordOf(a.slots, 'sleep slots'), bSlots = recordOf(b.slots, 'sleep slots');
  const rank: Record<string, number> = { pending: 0, requesting: 1, skipped: 2, failed: 2, complete: 3 };
  const slots = Object.fromEntries(Object.keys(recordOf(base.slots, 'sleep slots')).map(id => {
    const x = recordOf(aSlots[id], 'slot'), y = recordOf(bSlots[id], 'slot');
    const selected = rank[String(x.status)] === rank[String(y.status)]
      ? recordOf(recordOf(newer.slots, 'slots')[id], 'slot') : rank[String(x.status)] > rank[String(y.status)] ? x : y;
    return [id, selected];
  }));
  return { ...base, updatedAt: Math.max(numberAt(a.updatedAt), numberAt(b.updatedAt)), slots };
}

function mergeNearStatusRun(left?: JsonValue, right?: JsonValue): JsonValue | undefined {
  if (!left || !right) return left ?? right;
  const a = recordOf(left, 'near left'), b = recordOf(right, 'near right');
  if (a.generationKey !== b.generationKey) return numberAt(a.attemptedAt) >= numberAt(b.attemptedAt) ? a : b;
  const rank: Record<string, number> = { started: 0, failed: 1, interrupted: 2, saved: 3 };
  let selected = rank[String(a.outcome)] === rank[String(b.outcome)]
    ? (numberAt(a.updatedAt) >= numberAt(b.updatedAt) ? a : b) : rank[String(a.outcome)] > rank[String(b.outcome)] ? a : b;
  // A changed source is one whole run, never a source/receipt splice.
  if (a.materialKey !== b.materialKey) return selected;
  const chatSource = (run: JsonRecord) => run.pending ? recordOf(run.pending, 'near pending').chatSource
    : run.continuation ? recordOf(recordOf(run.continuation, 'near continuation').materials, 'near materials').chatSource : undefined;
  const aChat = chatSource(a), bChat = chatSource(b);
  if (aChat && bChat && canonicalJson(aChat) !== canonicalJson(bChat)) return selected;
  if (a.continuation && b.continuation) {
    const ac = recordOf(a.continuation, 'near continuation'), bc = recordOf(b.continuation, 'near continuation');
    if (ac.scheduleSources && bc.scheduleSources && canonicalJson(ac.scheduleSources) !== canonicalJson(bc.scheduleSources)) return selected;
    if (ac.scheduleSources || bc.scheduleSources) {
      const identity = (c: JsonRecord) => { const value = c.tool ?? c.received;
        if (!value) return undefined; const tool = recordOf(value, 'near schedule instruction');
        return [tool.callId, tool.toolId, tool.name, tool.input]; };
      const ai = identity(ac), bi = identity(bc);
      if (ai && bi && canonicalJson(ai) !== canonicalJson(bi)) return selected;
    }
    if (ac.received && bc.received && canonicalJson(ac.received) !== canonicalJson(bc.received)) return selected;
    if (ac.received || bc.received) {
      const { chatSource: _aSource, ...am } = recordOf(ac.materials, 'near materials');
      const { chatSource: _bSource, ...bm } = recordOf(bc.materials, 'near materials');
      if (canonicalJson(am) !== canonicalJson(bm)) return selected;
    }
  }
  if (a.outcome === 'started' && b.outcome === 'started') {
    if (Boolean(a.pending) !== Boolean(b.pending)) selected = a.pending ? a : b;
    else if (!a.pending && (a.continuation || b.continuation)) {
      const progress = (run: JsonRecord) => {
        if (!run.continuation) return -1;
        const c = recordOf(run.continuation, 'near continuation');
        return numberAt(c.usedRequests) * 100 + (c.tool ? 20 : 0) + (c.received ? 10 : 0)
          + numberAt(c.nextOrdinal) * 2 + (c.inFlight === true ? 1 : 0);
      };
      if (progress(a) !== progress(b)) selected = progress(a) > progress(b) ? a : b;
    }
  }
  const opportunity = selected.opportunity ?? a.opportunity ?? b.opportunity;
  const sleepTransition = selected.sleepTransition ?? a.sleepTransition ?? b.sleepTransition;
  const chosen: JsonRecord = { ...selected, ...(opportunity ? { opportunity } : {}), ...(sleepTransition ? { sleepTransition } : {}) };
  const fixedChat = chatSource(selected) ?? aChat ?? bChat;
  if (fixedChat && chosen.pending) chosen.pending = { ...recordOf(chosen.pending, 'near pending'), chatSource: fixedChat };
  if (chosen.continuation) {
    const continuation = recordOf(chosen.continuation, 'near continuation');
    const scheduleSources = continuation.scheduleSources
      ?? (a.continuation ? recordOf(a.continuation, 'near continuation').scheduleSources : undefined)
      ?? (b.continuation ? recordOf(b.continuation, 'near continuation').scheduleSources : undefined);
    const instruction = continuation.tool ?? continuation.received;
    chosen.continuation = { ...continuation, ...(scheduleSources && instruction
      && recordOf(instruction, 'near schedule instruction').toolId === 'schedule.save_own' ? { scheduleSources } : {}),
      ...(fixedChat ? { materials: { ...recordOf(continuation.materials, 'near materials'), chatSource: fixedChat } } : {}) };
  }
  if (!chosen.pending || !a.pending || !b.pending) return chosen;
  const ap = recordOf(a.pending, 'near pending'), bp = recordOf(b.pending, 'near pending');
  const pending = recordOf(chosen.pending, 'near pending');
  const activityRefs = pending.activityRefs ?? ap.activityRefs ?? bp.activityRefs;
  const scheduleRefs = pending.scheduleRefs ?? ap.scheduleRefs ?? bp.scheduleRefs;
  return { ...chosen, pending: { ...recordOf(chosen.pending, 'near pending'),
    ...(activityRefs !== undefined ? { activityRefs } : {}), ...(scheduleRefs !== undefined ? { scheduleRefs } : {}),
    applied: uniqueSorted([...(ap.applied as string[]), ...(bp.applied as string[])]) } };
}

function mergePendingSleep(a: JsonRecord | undefined, b: JsonRecord | undefined, selected: JsonRecord | undefined) {
  if (!a || !b) return a ?? b;
  if (a.id !== b.id) return numberAt(a.decidedAt) === numberAt(b.decidedAt)
    ? canonicalJson(a) > canonicalJson(b) ? a : b : numberAt(a.decidedAt) > numberAt(b.decidedAt) ? a : b;
  if (a.round !== b.round) return numberAt(a.round) > numberAt(b.round) ? a : b;
  if (a.round === undefined) return selected?.pendingSleep
    ? recordOf(selected.pendingSleep, 'pending sleep') : canonicalJson(a) > canonicalJson(b) ? a : b;
  const first = numberAt(a.roundStartedAt) === numberAt(b.roundStartedAt)
    ? canonicalJson(a) <= canonicalJson(b) ? a : b : numberAt(a.roundStartedAt) < numberAt(b.roundStartedAt) ? a : b;
  const terminal = [a, b].filter(value => value.turnEndedAt !== undefined)
    .sort((x, y) => numberAt(x.turnEndedAt) - numberAt(y.turnEndedAt)
      || numberAt(x.dueAt) - numberAt(y.dueAt))[0];
  if (!terminal) return first;
  const turnEndedAt = Math.min(numberAt(terminal.turnEndedAt), numberAt(first.roundDeadlineAt));
  return { ...first, turnEndedAt, dueAt: Math.min(numberAt(terminal.dueAt), turnEndedAt + 300000) };
}

function mergeSleepOpportunity(a: JsonValue | undefined, b: JsonValue | undefined) {
  if (!a || !b) return a ?? b;
  const left = recordOf(a, 'sleep opportunity'), right = recordOf(b, 'sleep opportunity');
  const rank: Record<string, number> = { requesting: 0, retry: 1, skipped: 2, failed: 2, complete: 3 };
  const difference = rank[String(left.status)] - rank[String(right.status)]
    || numberAt(left.requestCount) - numberAt(right.requestCount)
    || numberAt(left.deliveredAt) - numberAt(right.deliveredAt);
  const first = difference === 0 ? canonicalJson(left) > canonicalJson(right) ? left : right : difference > 0 ? left : right;
  const other = first === left ? right : left;
  return { ...other, ...first, requestCount: Math.max(numberAt(left.requestCount), numberAt(right.requestCount)),
    ...(left.retryUsed || right.retryUsed ? { retryUsed: true } : {}) };
}

function mergeSleepExperience(current: JsonRecord | undefined, incoming: JsonRecord | undefined, selected: JsonRecord | undefined) {
  if (!current || !incoming) return selected ?? current ?? incoming;
  const sources = [...(Array.isArray(current.events) ? current.events : []), ...(Array.isArray(incoming.events) ? incoming.events : [])]
    .map(value => recordOf(value, 'sleep event'));
  const events = (mergeRecordArrayById(current.events, incoming.events, ['at']) as JsonRecord[]).map(event => {
    // An older projection may omit homepage refs; it cannot refund an already saved change.
    const origin = sources.find(source => source.id === event.id && source.at === event.at
      && source.kind === 'schedule' && event.kind === source.kind && source.sessionId === undefined && event.sessionId === undefined
      && typeof source.toolCallId === 'string' && source.turnId === source.toolCallId
      && (event.turnId === undefined || event.turnId === source.turnId)
      && (event.toolCallId === undefined || event.toolCallId === source.toolCallId));
    return origin ? { ...event, toolCallId: origin.toolCallId, turnId: origin.turnId } : event;
  });
  const next: JsonRecord = { ...selected };
  const dayPlan = mergeOwnDayPlanState(current.dayPlan, incoming.dayPlan);
  if (dayPlan) next.dayPlan = dayPlan;
  if (current.events !== undefined || incoming.events !== undefined) next.events = events;
  for (const key of ['morningAwakeAt', 'chatOpenedAt', 'actualSleepAt', 'actualWakeAt']) {
    const value = Math.max(numberAt(current[key]), numberAt(incoming[key]));
    if (value) next[key] = value;
  }
  const a = current.pendingSleep ? recordOf(current.pendingSleep, 'pending sleep') : undefined;
  const b = incoming.pendingSleep ? recordOf(incoming.pendingSleep, 'pending sleep') : undefined;
  const pending = mergePendingSleep(a, b, selected);
  delete next.pendingSleep;
  if (pending && !events.some(event => ['sleep', 'sleep_return', 'morning_awake', 'get_up'].includes(String(event.kind))
    && numberAt(event.at) >= numberAt(pending.decidedAt)
    || event.kind === 'schedule' && numberAt(event.at) > numberAt(pending.decidedAt)
      && Math.max(numberAt(event.sleepAt), numberAt(event.wakeAt)) > numberAt(event.at))) {
    next.pendingSleep = pending;
  }
  for (const phase of ['prepare', 'wake']) {
    const opportunity = mergeSleepOpportunity(current[phase], incoming[phase]);
    if (opportunity) next[phase] = opportunity;
  }
  if (current.prepareStatus || incoming.prepareStatus) {
    const rank: Record<string, number> = { attempted: 0, skipped: 1, failed: 1, complete: 2 };
    next.prepareStatus = !current.prepareStatus ? incoming.prepareStatus : !incoming.prepareStatus ? current.prepareStatus
      : rank[String(current.prepareStatus)] >= rank[String(incoming.prepareStatus)] ? current.prepareStatus : incoming.prepareStatus;
    const attemptedAt = Math.max(numberAt(current.attemptedAt), numberAt(incoming.attemptedAt));
    if (attemptedAt) next.attemptedAt = attemptedAt;
  }
  delete next.recovery;
  const recoveries = [current.recovery, incoming.recovery].filter(Boolean).map(value => recordOf(value, 'sleep recovery'))
    .filter(value => {
      const startedAt = numberAt(value.sleepStartedAt);
      const returnedAtStart = events.some(event => event.kind === 'sleep_return' && numberAt(event.at) === startedAt);
      return !events.some(event =>
      ['sleep', 'sleep_return'].includes(String(event.kind))
        && numberAt(event.at) > startedAt
        || ['poke_awake', 'morning_awake', 'get_up'].includes(String(event.kind))
          && (numberAt(event.at) > startedAt || numberAt(event.at) === startedAt && !returnedAtStart)
        || event.kind === 'schedule' && numberAt(event.at) > numberAt(value.checkedAt))
      && numberAt(next.actualWakeAt) < startedAt
      && (numberAt(next.morningAwakeAt) < startedAt || numberAt(next.morningAwakeAt) === startedAt && returnedAtStart)
      && numberAt(next.actualSleepAt) <= startedAt;
    })
    .sort((x, y) => numberAt(y.sleepStartedAt) - numberAt(x.sleepStartedAt)
      || numberAt(y.checkedAt) - numberAt(x.checkedAt) || canonicalJson(y).localeCompare(canonicalJson(x)));
  if (recoveries.length) next.recovery = recoveries[0];
  return next;
}

/** Business projections also receive direct descendants, which bypass conflict resolution. */
export function mergeLifeDayRuntimeProgress(current: JsonRecord, incoming: JsonRecord): JsonRecord {
  const oldNight = current.nightSleepPlan ? recordOf(current.nightSleepPlan, 'night') : undefined;
  const newNight = incoming.nightSleepPlan ? recordOf(incoming.nightSleepPlan, 'night') : undefined;
  const nearStatus = mergeNearStatusRun(current.nearStatus, incoming.nearStatus);
  const sleepStatus = mergeSleepNearStatus(oldNight?.nearStatus, newNight?.nearStatus);
  const night = mergeSleepExperience(oldNight, newNight,
    numberAt(current.sleepPlanUpdatedAt) > numberAt(incoming.sleepPlanUpdatedAt) ? oldNight : newNight);
  if (!nearStatus && !sleepStatus && !night) return incoming;
  return { ...incoming, ...(nearStatus ? { nearStatus } : {}),
    ...(night ? { nightSleepPlan: { ...night, ...(sleepStatus ? { nearStatus: sleepStatus } : {}) } } : {}) };
}

function comparePaperPosition(left: JsonRecord, right: JsonRecord) {
  return numberAt(left.createdAt) - numberAt(right.createdAt)
    || (String(left.id) < String(right.id) ? -1 : String(left.id) > String(right.id) ? 1 : 0);
}

function hasCompletedPaperRetry(state: JsonRecord, retry: JsonRecord) {
  if (state.lastSkipped && recordOf(state.lastSkipped, 'paper skipped').generationKey === retry.generationKey) return true;
  const completedAt = Math.max(numberAt(state.generatedAt), state.lastSkipped ? numberAt(recordOf(state.lastSkipped, 'paper skipped').at) : 0);
  if (completedAt < numberAt(retry.attemptedAt)) return false;
  if (retry.contactWaiting && numberAt(state.lastAttemptAt) >= numberAt(retry.attemptedAt)) return true;
  if (retry.chatSupplement) {
    const supplement = recordOf(retry.chatSupplement, 'chat supplement');
    const cursor = recordOf(state.cursors, 'paper cursors')[String(supplement.sessionId)];
    const late = (recordOf(state.lateMessages ?? {}, 'paper late')[String(supplement.sessionId)] ?? []) as JsonRecord[];
    if ((supplement.unreadRefs as JsonRecord[]).some(ref => !cursor
      || comparePaperPosition(recordOf(cursor, 'paper cursor'), ref) < 0
      || late.some(item => item.id === ref.id))) return false;
  }
  const refs = retry.refs as JsonRecord[];
  if (retry.sessionId) {
    const cursor = recordOf(state.cursors, 'paper cursors')[String(retry.sessionId)];
    const late = (recordOf(state.lateMessages ?? {}, 'paper late')[String(retry.sessionId)] ?? []) as JsonRecord[];
    if (!cursor || comparePaperPosition(recordOf(cursor, 'paper cursor'), recordOf(retry.end, 'paper end')) < 0
      || refs.some(ref => late.some(item => item.id === ref.id))) return false;
  }
  const materials = retry.materials as JsonRecord[];
  const progress = state.paper === 'affect' ? { life: state.life, pokes: state.pokes } : recordOf(state.materials, 'paper materials');
  return (refs.length > 0 || materials.length > 0) && materials.every(ref => {
    if (ref.kind === 'heart') return (progress.hearts as JsonValue[]).includes(ref.id);
    if (ref.kind === 'dream') return !!progress.dream
      && comparePaperPosition(recordOf(progress.dream, 'paper dream'), ref) >= 0;
    const saved = recordOf(progress[ref.kind === 'poke' ? 'pokes' : String(ref.kind)] ?? {}, 'paper material progress')[String(ref.id)];
    return saved === ref.revision || (saved !== undefined && numberAt(state.lastAttemptAt) >= numberAt(retry.attemptedAt));
  });
}

function mergePaperRetryProgress(a: JsonRecord, b: JsonRecord, selected: JsonRecord): JsonRecord {
  if (!a.retry && !b.retry && !a.lastSkipped && !b.lastSkipped) return selected;
  if (a.activatedAt !== b.activatedAt) return numberAt(a.activatedAt) >= numberAt(b.activatedAt) ? a : b;
  const next = { ...selected };
  const skips = [a.lastSkipped, b.lastSkipped].filter(Boolean).map(value => recordOf(value, 'paper skipped'))
    .sort((x, y) => numberAt(y.at) - numberAt(x.at) || String(y.generationKey).localeCompare(String(x.generationKey)));
  if (skips.length) next.lastSkipped = skips[0];
  const retries = [a.retry, b.retry].filter(Boolean).map(value => recordOf(value, 'paper retry'));
  const grouped = new Map<string, JsonRecord>();
  for (const retry of retries) {
    const key = String(retry.generationKey), old = grouped.get(key);
    if (!old) { grouped.set(key, retry); continue; }
    const latest = numberAt(retry.attempts) > numberAt(old.attempts)
      || (retry.attempts === old.attempts && (numberAt(retry.attemptedAt) > numberAt(old.attemptedAt)
        || (retry.attemptedAt === old.attemptedAt && canonicalJson(retry).localeCompare(canonicalJson(old)) > 0))) ? retry : old;
    grouped.set(key, { ...retainSupplementBatch(latest, latest === old ? retry : old), attempts: Math.max(numberAt(old.attempts), numberAt(retry.attempts)),
      attemptedAt: Math.max(numberAt(old.attemptedAt), numberAt(retry.attemptedAt)),
      retryAfter: Math.max(numberAt(old.retryAfter), numberAt(retry.retryAfter)) });
  }
  const settled = [...grouped.values()].filter(retry => hasCompletedPaperRetry(a, retry) || hasCompletedPaperRetry(b, retry));
  const settledKeys = new Set(settled.map(retry => retry.generationKey));
  const pending = [a.pending, b.pending].filter(Boolean).map(value => recordOf(value, 'paper pending'))
    .filter(value => grouped.has(String(value.generationKey)) && !settledKeys.has(value.generationKey))
    .filter(value => selected.pending || !selected.retry || recordOf(selected.retry, 'paper retry').generationKey !== value.generationKey)
    .sort((x, y) => numberAt(y.attemptedAt) - numberAt(x.attemptedAt));
  if (pending.length) {
    const chosen = pending.reduce((value, other) => retainSupplementBatch(value, other), pending[0]);
    next.pending = { ...chosen, applied: pending.some(value => value.generationKey === chosen.generationKey
      && sameSupplementedPaperSources(value, chosen) && value.applied === true) };
  }
  if (next.pending && settledKeys.has(recordOf(next.pending, 'paper pending').generationKey)) delete next.pending;
  const retry = [...grouped.values()].filter(value => !settledKeys.has(value.generationKey))
    .sort((x, y) => numberAt(y.attemptedAt) - numberAt(x.attemptedAt)
      || String(y.generationKey).localeCompare(String(x.generationKey)))[0];
  if (retry) next.retry = retry;
  else delete next.retry;
  if (settled.length) {
    // Keep the existing read progress when a later transport snapshot only knows an older retry.
    const progressAt = (state: JsonRecord) => Math.max(numberAt(state.generatedAt),
      state.lastSkipped ? numberAt(recordOf(state.lastSkipped, 'paper skipped').at) : 0);
    const completed = progressAt(a) >= progressAt(b) ? a : b;
    const other = completed === a ? b : a;
    next.cursors = { ...recordOf(completed.cursors, 'paper cursors') };
    const cursors = next.cursors as JsonRecord;
    for (const [id, cursor] of Object.entries(recordOf(other.cursors, 'paper cursors'))) {
      if (!cursors[id] || comparePaperPosition(recordOf(cursor, 'cursor'), recordOf(cursors[id], 'cursor')) > 0) cursors[id] = cursor;
    }
    const late = { ...recordOf(completed.lateMessages ?? {}, 'paper late') };
    for (const [id, refs] of Object.entries(recordOf(other.lateMessages ?? {}, 'paper late'))) {
      const all = new Map(((late[id] ?? []) as JsonRecord[]).map(ref => [String(ref.id), ref]));
      for (const ref of refs as JsonRecord[]) if (!all.has(String(ref.id))) all.set(String(ref.id), ref);
      late[id] = [...all.values()].sort(comparePaperPosition);
    }
    for (const value of settled) if (value.sessionId) {
      const id = String(value.sessionId), consumed = new Set((value.refs as JsonRecord[]).map(ref => ref.id));
      late[id] = ((late[id] ?? []) as JsonRecord[]).filter(ref => !consumed.has(ref.id));
    }
    for (const value of settled) if (value.chatSupplement) {
      const supplement = recordOf(value.chatSupplement, 'chat supplement'), id = String(supplement.sessionId);
      const consumed = new Set((supplement.unreadRefs as JsonRecord[]).map(ref => ref.id));
      late[id] = ((late[id] ?? []) as JsonRecord[]).filter(ref => !consumed.has(ref.id));
    }
    next.lateMessages = late;
    if (completed.generatedAt !== undefined) next.generatedAt = Math.max(numberAt(a.generatedAt), numberAt(b.generatedAt));
    if (selected.paper === 'affect') {
      next.life = { ...recordOf(other.life, 'affect life'), ...recordOf(completed.life, 'affect life') };
      if (other.pokes !== undefined || completed.pokes !== undefined) next.pokes = {
        ...recordOf(other.pokes ?? {}, 'affect pokes'), ...recordOf(completed.pokes ?? {}, 'affect pokes') };
    }
    else {
      const x = recordOf(completed.materials, 'paper materials'), y = recordOf(other.materials, 'paper materials');
      next.materials = { ...x, care: { ...recordOf(y.care, 'care'), ...recordOf(x.care, 'care') },
        ...(x.pokes !== undefined || y.pokes !== undefined ? { pokes: { ...recordOf(y.pokes ?? {}, 'wants pokes'), ...recordOf(x.pokes ?? {}, 'wants pokes') } } : {}),
        life: { ...recordOf(y.life, 'life'), ...recordOf(x.life, 'life') },
        hearts: [...new Set([...(y.hearts as JsonValue[]), ...(x.hearts as JsonValue[])])] };
      if (completed.lastLifeMaterialKey !== undefined) next.lastLifeMaterialKey = completed.lastLifeMaterialKey;
    }
  }
  if (a.lastAttemptAt !== undefined || b.lastAttemptAt !== undefined) next.lastAttemptAt = Math.max(numberAt(a.lastAttemptAt), numberAt(b.lastAttemptAt));
  for (const field of ['pending', 'retry']) if (next[field]) next[field] = preservePendingPokeRefs(
    preservePendingPokeRefs(recordOf(next[field], 'paper pending'), a[field]), b[field]);
  return next;
}

function hasInternalRetryProgress(value: JsonRecord) {
  const affect = value.affect ? recordOf(value.affect, 'affect') : {};
  return !!(value.retry || value.lastSkipped || affect.retry || affect.lastSkipped);
}

function hasChatSupplement(value: JsonRecord) {
  const experience = recordOf(value.experience ?? {}, 'experience');
  return [value.pending, value.retry, experience.batch].some(batch =>
    batch && recordOf(batch, 'paper batch').chatSupplement !== undefined);
}

function completedSupplementMessages(states: JsonRecord[]) {
  const consumed = new Set<string>();
  for (const state of states) {
    const experience = recordOf(state.experience ?? {}, 'experience');
    for (const [value, shared] of [[state.pending, false], [state.retry, false], [experience.batch, true]] as const) {
      if (!value) continue;
      const batch = recordOf(value, 'paper batch');
      if (!batch.chatSupplement) continue;
      const completed = states.some(progress => {
        if (!shared) return hasCompletedPaperRetry(progress, batch);
        const saved = recordOf(progress.experience ?? {}, 'experience');
        const finished = recordOf(saved.lastFinished ?? {}, 'experience finished');
        const processed = recordOf(saved.processed ?? {}, 'experience processed');
        return finished.generationKey === batch.generationKey || (batch.refs as JsonRecord[])
          .every(ref => processed[`${ref.kind}:${ref.id}`] !== undefined);
      });
      if (!completed) continue;
      const supplement = recordOf(batch.chatSupplement, 'chat supplement');
      for (const ref of supplement.unreadRefs as JsonRecord[])
        consumed.add(canonicalJson([supplement.sessionId, ref.id, ref.createdAt]));
      if (!shared && batch.sessionId) for (const ref of batch.refs as JsonRecord[])
        consumed.add(canonicalJson([batch.sessionId, ref.id, ref.createdAt]));
    }
  }
  return consumed;
}

function hasPaperLifeProgress(value: JsonRecord) {
  const materials = recordOf(value.materials ?? {}, 'paper materials');
  const affect = recordOf(value.affect ?? {}, 'affect');
  return [materials.life, affect.life].some(life => Object.keys(recordOf(life ?? {}, 'paper life')).length > 0);
}

function preservePendingPokeRefs(selected: JsonRecord, previous?: JsonValue): JsonRecord {
  if (!previous) return selected;
  const old = recordOf(previous, 'paper pending');
  if (selected.generationKey !== old.generationKey) return selected;
  const next = { ...retainSupplementBatch(selected, old) };
  if (next.pokeRefs === undefined && old.pokeRefs !== undefined) next.pokeRefs = old.pokeRefs;
  if (Array.isArray(next.materials) && Array.isArray(old.materials)) {
    const refs = next.materials as JsonRecord[];
    const missing = (old.materials as JsonRecord[]).filter(ref => ref.kind === 'poke'
      && !refs.some(item => item.kind === 'poke' && item.id === ref.id));
    if (missing.length) next.materials = [...refs, ...missing];
  }
  return next;
}

function hasOutingMaterials(value: JsonRecord) {
  return Array.isArray(value.materials) && value.materials.some(ref =>
    !!ref && typeof ref === 'object' && !Array.isArray(ref) && ref.kind === 'life'
      && typeof ref.id === 'string' && ref.id.startsWith('nearby-outing:'));
}

function sameSupplementedPaperSources(a: JsonRecord, b: JsonRecord) {
  if (a.chatSupplement === undefined && b.chatSupplement === undefined
    && a.contactWaiting === undefined && b.contactWaiting === undefined
    && !hasOutingMaterials(a) && !hasOutingMaterials(b)) return true;
  const source = (value: JsonRecord) => canonicalJson({
    sessionId: value.sessionId ?? null, refs: value.refs, materials: value.materials ?? value.lifeRefs ?? [],
    chatSupplement: value.chatSupplement ?? null,
    contactWaiting: value.contactWaiting ?? null,
  });
  return source(a) === source(b);
}

// Retain a complete fixed-source batch, not a legacy answer with newly grafted references.
function retainSupplementBatch(selected: JsonRecord, previous: JsonRecord): JsonRecord {
  return selected.generationKey === previous.generationKey
    && ((selected.chatSupplement === undefined && previous.chatSupplement !== undefined)
      || (selected.contactWaiting === undefined && previous.contactWaiting !== undefined)
      || (selected.outingRefs === undefined && previous.outingRefs !== undefined)
      || (!hasOutingMaterials(selected) && hasOutingMaterials(previous))) ? previous : selected;
}

function removeProcessedTheaterSelections(value?: JsonValue): JsonValue | undefined {
  if (!value) return value;
  const state = recordOf(value, 'experience');
  if (state.theaterSelections === undefined) return state;
  const processed = recordOf(state.processed, 'experience processed');
  const selections = Object.fromEntries(Object.entries(recordOf(state.theaterSelections, 'theater selections'))
    .filter(([id]) => processed[`theater-unit:${id}`] === undefined));
  const next = { ...state };
  if (Object.keys(selections).length) next.theaterSelections = selections;
  else delete next.theaterSelections;
  return next;
}

function mergeSharedExperience(left?: JsonValue, right?: JsonValue): JsonValue | undefined {
  if (!left || !right) return removeProcessedTheaterSelections(left ?? right);
  const a = recordOf(left, 'experience left'), b = recordOf(right, 'experience right');
  if (a.activatedAt !== b.activatedAt) return removeProcessedTheaterSelections(numberAt(a.activatedAt) >= numberAt(b.activatedAt) ? a : b);
  const selected = numberAt(a.updatedAt) > numberAt(b.updatedAt)
    || a.updatedAt === b.updatedAt && canonicalJson(a) >= canonicalJson(b) ? a : b;
  const other = selected === a ? b : a;
  const processed = { ...recordOf(other.processed, 'experience processed'), ...recordOf(selected.processed, 'experience processed') };
  const focus = { ...recordOf(selected.focus, 'experience focus') };
  for (const [id, value] of Object.entries(recordOf(other.focus, 'experience focus'))) {
    const current = recordOf(focus[id] ?? value, 'experience focus cursor'), incoming = recordOf(value, 'experience focus cursor');
    focus[id] = { throughAt: Math.max(numberAt(current.throughAt), numberAt(incoming.throughAt)),
      throughElapsedSeconds: Math.max(numberAt(current.throughElapsedSeconds), numberAt(incoming.throughElapsedSeconds)) };
  }
  const next: JsonRecord = { ...selected, processed, focus };
  if (a.theaterSelections !== undefined || b.theaterSelections !== undefined) {
    const selections: JsonRecord = {};
    for (const state of [a, b]) {
      for (const [id, value] of Object.entries(recordOf(state.theaterSelections ?? {}, 'theater selections'))) {
        if (processed[`theater-unit:${id}`] !== undefined) continue;
        const incoming = recordOf(value, 'theater selection');
        const current = selections[id] ? recordOf(selections[id], 'theater selection') : undefined;
        const preferred = !current || numberAt(incoming.updatedAt) > numberAt(current.updatedAt)
          || incoming.updatedAt === current.updatedAt && canonicalJson(incoming) > canonicalJson(current) ? incoming : current;
        selections[id] = preferred;
        if (current && (current.attempts !== undefined || incoming.attempts !== undefined)) {
          const x = recordOf(current.attempts ?? {}, 'theater selection attempts');
          const y = recordOf(incoming.attempts ?? {}, 'theater selection attempts');
          selections[id] = { ...preferred, attempts: { wants: Math.max(numberAt(x.wants), numberAt(y.wants)),
            affect: Math.max(numberAt(x.affect), numberAt(y.affect)) } };
        }
      }
    }
    if (Object.keys(selections).length) next.theaterSelections = selections;
    else delete next.theaterSelections;
  }
  for (const key of ['lastReadingAttemptAt', 'crossPageActivatedAt', 'lastCrossPageAttemptAt'])
    if (a[key] !== undefined || b[key] !== undefined) next[key] = Math.max(numberAt(a[key]), numberAt(b[key]));
  const finished = [a.lastFinished, b.lastFinished].filter(Boolean).map(value => recordOf(value, 'experience finished'));
  finished.sort((x, y) => numberAt(y.at) - numberAt(x.at) || canonicalJson(y).localeCompare(canonicalJson(x)));
  if (finished.length) next.lastFinished = finished[0];
  const batches = [a.batch, b.batch].filter(Boolean).map(value => recordOf(value, 'experience batch'));
  const complete = (batch: JsonRecord) => finished.some(item => item.generationKey === batch.generationKey)
    || (batch.refs as JsonRecord[]).every(ref => processed[`${ref.kind}:${ref.id}`] !== undefined);
  const grouped = new Map<string, JsonRecord>();
  for (const batch of batches) {
    if (complete(batch)) continue;
    const key = String(batch.generationKey), previous = grouped.get(key);
    if (!previous) { grouped.set(key, batch); continue; }
    const source = (value: JsonRecord) => canonicalJson({ kind: value.kind, ownerId: value.ownerId,
      refs: value.refs, fromAt: value.fromAt, throughAt: value.throughAt,
      ...(value.theaterSelection ? { theaterSelection: (() => {
        const { updatedAt: _time, attempts: _attempts, ...selection } = recordOf(value.theaterSelection, 'theater selection');
        return selection;
      })() } : {}),
      ...(value.chatMessageIds ? { chatMessageIds: value.chatMessageIds } : {}),
      ...(value.chatSupplement !== undefined ? { chatSupplement: value.chatSupplement } : {}),
      ...(value.outingRefs !== undefined ? { outingRefs: value.outingRefs } : {}),
      ...(value.kind === 'focus' ? { fromElapsedSeconds: value.fromElapsedSeconds,
        throughElapsedSeconds: value.throughElapsedSeconds, focusEnded: value.focusEnded } : {}) });
    const sameSource = source(previous) === source(batch);
    const preferred = selected.batch ? recordOf(selected.batch, 'selected experience batch') : batch;
    const chosen = retainSupplementBatch(preferred, preferred === previous ? batch : previous);
    const segments = (value: JsonRecord) => value.segments
      ? recordOf(value.segments, 'experience segments') : undefined;
    const previousSegments = segments(previous), batchSegments = segments(batch);
    const sameSegments = canonicalJson(previousSegments ?? null) === canonicalJson(batchSegments ?? null);
    if (sameSource && !sameSegments) {
      // Unread suffixes may be repartitioned; only completed boundaries constrain progress.
      let retained = chosen;
      if (previousSegments && batchSegments) {
        const previousIndex = numberAt(previousSegments.index), batchIndex = numberAt(batchSegments.index);
        const earlier = previousIndex <= batchIndex ? previous : batch;
        const later = earlier === previous ? batch : previous;
        const earlierSegments = segments(earlier)!, laterSegments = segments(later)!;
        const earlierEnds = earlierSegments.ends as number[], laterEnds = laterSegments.ends as number[];
        const index = numberAt(earlierSegments.index);
        const prefixMatches = earlierEnds.at(-1) === laterEnds.at(-1)
          && earlierEnds.slice(0, index).every((end, position) => end === laterEnds[position]);
        const attempted = (value: JsonRecord) => ['wants', 'affect'].some(name =>
          numberAt(recordOf(value[name], `experience ${name}`).attempts) > 0);
        if (prefixMatches && previousIndex !== batchIndex) {
          retained = attempted(earlier) && earlierEnds[index] !== laterEnds[index] ? earlier : later;
        } else if (prefixMatches && attempted(previous) !== attempted(batch)) {
          // A boundary-only snapshot cannot recut an already-attempted current segment.
          retained = attempted(previous) ? previous : batch;
        }
      }
      grouped.set(key, retained);
      continue;
    }
    const merged: JsonRecord = { ...chosen };
    for (const name of ['wants', 'affect']) {
      const x = recordOf(previous[name], `experience ${name}`), y = recordOf(batch[name], `experience ${name}`);
      const preferred = recordOf(chosen[name], `experience ${name}`);
      const paper: JsonRecord = { ...preferred, attempts: Math.max(numberAt(x.attempts), numberAt(y.attempts)) };
      // Only the exact same source version may carry the other device's already-parsed half.
      if (sameSource && !('result' in paper)) {
        if ('result' in x) paper.result = x.result;
        else if ('result' in y) paper.result = y.result;
      }
      if (x.retryAt !== undefined || y.retryAt !== undefined) paper.retryAt = Math.max(numberAt(x.retryAt), numberAt(y.retryAt));
      merged[name] = paper;
    }
    grouped.set(key, merged);
  }
  const batch = [...grouped.values()].sort((x, y) => numberAt(x.preparedAt) - numberAt(y.preparedAt)
    || String(x.generationKey).localeCompare(String(y.generationKey)))[0];
  if (batch) next.batch = batch;
  else delete next.batch;
  return next;
}

export function mergeConversationAfterglowRuntimeProgress(current: JsonRecord, incoming: JsonRecord, selected?: JsonRecord): JsonRecord {
  if (current.schemaVersion !== 3 || incoming.schemaVersion !== 3) return current.schemaVersion === 3 ? current : incoming;
  const pokeProgress = hasPokeProgress(current) || hasPokeProgress(incoming);
  const supplementProgress = hasChatSupplement(current) || hasChatSupplement(incoming);
  const separateActivation = current.activatedAt !== incoming.activatedAt
    && (pokeProgress || hasChatSupplement(current) || hasChatSupplement(incoming)
      || hasInternalRetryProgress(current) || hasInternalRetryProgress(incoming));
  const base = selected ?? (numberAt(current.updatedAt) > numberAt(incoming.updatedAt) ? current : incoming);
  const merged = { ...(separateActivation ? (numberAt(current.activatedAt) >= numberAt(incoming.activatedAt) ? current : incoming)
    : mergePaperRetryProgress(current, incoming, base)) };
  if (!separateActivation && current.activatedAt === incoming.activatedAt) {
    if (pokeProgress || supplementProgress) {
      const consumed = supplementProgress ? completedSupplementMessages([current, incoming]) : undefined;
      const progressAt = (state: JsonRecord) => Math.max(numberAt(state.generatedAt),
        state.lastSkipped ? numberAt(recordOf(state.lastSkipped, 'paper skipped').at) : 0);
      const completed = progressAt(current) > progressAt(incoming) ? current
        : progressAt(current) < progressAt(incoming) ? incoming : base;
      const other = completed === current ? incoming : current;
      const cursors = { ...recordOf(completed.cursors, 'wants cursors') };
      for (const [id, position] of Object.entries(recordOf(other.cursors, 'wants cursors'))) {
        if (!cursors[id] || comparePaperPosition(recordOf(position, 'cursor'), recordOf(cursors[id], 'cursor')) > 0) cursors[id] = position;
      }
      const late = { ...recordOf(completed.lateMessages ?? {}, 'wants late') };
      for (const [id, value] of Object.entries(recordOf(other.lateMessages ?? {}, 'wants late'))) {
        const refs = (late[id] ?? []) as JsonRecord[];
        const cursor = recordOf(completed.cursors, 'wants cursors')[id];
        const added = (value as JsonRecord[]).filter(ref => !refs.some(old => old.id === ref.id)
          && (consumed ? !consumed.has(canonicalJson([id, ref.id, ref.createdAt]))
            : !cursor || comparePaperPosition(ref, recordOf(cursor, 'cursor')) > 0));
        late[id] = [...refs, ...added].sort(comparePaperPosition);
      }
      merged.cursors = cursors; merged.lateMessages = late;
      for (const key of ['generatedAt', 'lastAttemptAt']) if (current[key] !== undefined || incoming[key] !== undefined)
        merged[key] = Math.max(numberAt(current[key]), numberAt(incoming[key]));
    }
    const cm = recordOf(current.materials, 'wants materials'), im = recordOf(incoming.materials, 'wants materials');
    const selectedMaterials = { ...recordOf(merged.materials, 'wants materials'),
      life: { ...recordOf(cm.life, 'wants life'), ...recordOf(im.life, 'wants life'),
        ...recordOf(recordOf(merged.materials, 'wants materials').life, 'wants life') } };
    // Older writers cannot erase already-consumed background events they do not know.
    merged.materials = selectedMaterials;
    if (cm.pokes !== undefined || im.pokes !== undefined) merged.materials = { ...selectedMaterials,
      pokes: { ...recordOf(numberAt(current.updatedAt) > numberAt(incoming.updatedAt) ? im.pokes ?? {} : cm.pokes ?? {}, 'wants pokes'),
        ...recordOf(numberAt(current.updatedAt) > numberAt(incoming.updatedAt) ? cm.pokes ?? {} : im.pokes ?? {}, 'wants pokes') } };
    for (const field of ['pending', 'retry']) if (merged[field]) merged[field] = preservePendingPokeRefs(
      preservePendingPokeRefs(recordOf(merged[field], 'paper pending'), current[field]), incoming[field]);
  }
  const affect = separateActivation ? undefined : mergeAffectReader(current.affect, incoming.affect);
  const experience = mergeSharedExperience(current.experience, incoming.experience);
  return { ...merged, ...(affect ? { affect } : {}), ...(experience ? { experience } : {}) };
}

function mergeAffectReader(left?: JsonValue, right?: JsonValue): JsonValue | undefined {
  if (!left || !right) return left ?? right;
  const a = recordOf(left, 'affect left'), b = recordOf(right, 'affect right');
  if (a.activatedAt !== b.activatedAt) return numberAt(a.activatedAt) >= numberAt(b.activatedAt) ? a : b;
  const selected = numberAt(a.updatedAt) >= numberAt(b.updatedAt) ? a : b;
  const other = selected === a ? b : a;
  const order = (x: JsonRecord, y: JsonRecord) => numberAt(x.createdAt) - numberAt(y.createdAt) || String(x.id).localeCompare(String(y.id));
  const cursors = { ...recordOf(selected.cursors, 'affect cursors') };
  for (const [id, position] of Object.entries(recordOf(other.cursors, 'affect cursors'))) {
    if (!cursors[id] || order(recordOf(position, 'cursor'), recordOf(cursors[id], 'cursor')) > 0) cursors[id] = position;
  }
  const late = { ...recordOf(selected.lateMessages ?? {}, 'affect late') };
  for (const [id, value] of Object.entries(recordOf(other.lateMessages ?? {}, 'affect late'))) {
    const current = (late[id] ?? []) as JsonRecord[];
    const cursor = recordOf(selected.cursors, 'affect cursors')[id];
    const added = (value as JsonRecord[]).filter(ref => !current.some(old => old.id === ref.id)
      && (!cursor || order(ref, recordOf(cursor, 'cursor')) > 0));
    late[id] = [...current, ...added].sort(order);
  }
  let pending = selected.pending;
  if (a.pending && b.pending) {
    const ap = recordOf(a.pending, 'affect pending'), bp = recordOf(b.pending, 'affect pending');
    if (ap.generationKey === bp.generationKey) {
      const chosen = retainSupplementBatch(recordOf(pending, 'affect pending'), recordOf(other.pending, 'affect pending'));
      pending = { ...preservePendingPokeRefs(chosen, other.pending),
        applied: [ap, bp].some(value => sameSupplementedPaperSources(value, chosen) && value.applied === true) };
    }
  }
  return mergePaperRetryProgress(a, b, { ...selected, cursors, lateMessages: late, life: { ...recordOf(other.life, 'affect life'), ...recordOf(selected.life, 'affect life') },
    ...(a.pokes !== undefined || b.pokes !== undefined ? { pokes: { ...recordOf(other.pokes ?? {}, 'affect pokes'), ...recordOf(selected.pokes ?? {}, 'affect pokes') } } : {}),
    ...(pending ? { pending } : {}),
    ...(a.lastAttemptAt !== undefined || b.lastAttemptAt !== undefined ? { lastAttemptAt: Math.max(numberAt(a.lastAttemptAt), numberAt(b.lastAttemptAt)) } : {}),
  });
}

function mergeLifeDay(input: {
  current: JsonRecord;
  incoming: JsonRecord;
  currentRevisionId: string;
  incomingRevisionId: string;
}) {
  const selected = selectRecord(
    input.current,
    input.incoming,
    input.currentRevisionId,
    input.incomingRevisionId,
    'summaryGeneratedAt',
  );
  const sleepSource = selectRecord(input.current, input.incoming, input.currentRevisionId, input.incomingRevisionId, 'sleepPlanUpdatedAt');
  const summarySource = numberAt(input.current.summaryGeneratedAt)
    >= numberAt(input.incoming.summaryGeneratedAt)
    ? input.current
    : input.incoming;
  const currentNight = input.current.nightSleepPlan ? recordOf(input.current.nightSleepPlan, 'night') : undefined;
  const incomingNight = input.incoming.nightSleepPlan ? recordOf(input.incoming.nightSleepPlan, 'night') : undefined;
  const sleepStatus = mergeSleepNearStatus(currentNight?.nearStatus, incomingNight?.nearStatus);
  const night = mergeSleepExperience(currentNight, incomingNight,
    sleepSource.nightSleepPlan ? recordOf(sleepSource.nightSleepPlan, 'night') : undefined);
  const nearStatus = mergeNearStatusRun(input.current.nearStatus, input.incoming.nearStatus);
  return {
    ...selected,
    ...(nearStatus ? { nearStatus } : {}),
    ...(numberAt(sleepSource.sleepPlanUpdatedAt) > 0 ? {
      sleepPlanUpdatedAt: sleepSource.sleepPlanUpdatedAt,
      sleepTargetAt: sleepSource.sleepTargetAt,
      wakeTargetAt: sleepSource.wakeTargetAt,
      ...(night ? { nightSleepPlan: { ...night,
        ...(sleepStatus ? { nearStatus: sleepStatus } : {}) } } : {}),
    } : {}),
    createdAt: Math.min(
      numberAt(input.current.createdAt),
      numberAt(input.incoming.createdAt),
    ),
    ...(summarySource.dailySummary !== undefined
      ? { dailySummary: summarySource.dailySummary }
      : {}),
    ...(summarySource.summaryGeneratedAt !== undefined
      ? { summaryGeneratedAt: summarySource.summaryGeneratedAt }
      : {}),
    schemaVersion: Math.max(
      numberAt(input.current.schemaVersion),
      numberAt(input.incoming.schemaVersion),
    ),
    deviations: mergeRecordArrayById(
      input.current.deviations,
      input.incoming.deviations,
      ['affectsUntil', 'endsAt', 'startsAt'],
    ),
    segments: numberAt(sleepSource.sleepPlanUpdatedAt) > 0 ? (
      numberAt(input.current.sleepPlanUpdatedAt) === numberAt(input.incoming.sleepPlanUpdatedAt)
        ? mergeRecordArrayById(input.current.segments, input.incoming.segments, ['generationAttemptedAt'])
        : sleepSource.segments
    ) : mergeRecordArrayById(
      input.current.segments,
      input.incoming.segments,
      ['endAt', 'startAt'],
    ),
    timelineEntries: mergeRecordArrayById(
      input.current.timelineEntries,
      input.incoming.timelineEntries,
      ['at'],
    ),
  } as JsonRecord;
}

function mergeDesireState(input: {
  current: JsonRecord;
  incoming: JsonRecord;
  currentRevisionId: string;
  incomingRevisionId: string;
}) {
  const selected = selectRecord(
    input.current,
    input.incoming,
    input.currentRevisionId,
    input.incomingRevisionId,
    'updatedAt',
  );
  const currentSelf = recordOf(
    input.current.selfDrive,
    'current desire selfDrive',
  );
  const incomingSelf = recordOf(
    input.incoming.selfDrive,
    'incoming desire selfDrive',
  );
  const selectedSelf = selected === input.current ? currentSelf : incomingSelf;
  const samePulseDay = currentSelf.selfPulseDateKey === incomingSelf.selfPulseDateKey;
  return {
    ...selected,
    lastTickAt: Math.max(
      numberAt(input.current.lastTickAt),
      numberAt(input.incoming.lastTickAt),
    ),
    refractory: maxNumberRecord(
      input.current.refractory,
      input.incoming.refractory,
    ),
    selfDrive: {
      ...selectedSelf,
      selfPulseCountToday: samePulseDay
        ? Math.max(
            numberAt(currentSelf.selfPulseCountToday),
            numberAt(incomingSelf.selfPulseCountToday),
          )
        : selectedSelf.selfPulseCountToday,
    },
    thoughts: mergeRecordArrayById(
      input.current.thoughts,
      input.incoming.thoughts,
      ['updatedAt', 'bornAt'],
    ),
    updatedAt: Math.max(
      numberAt(input.current.updatedAt),
      numberAt(input.incoming.updatedAt),
    ),
  } as JsonRecord;
}

function mergeMetabolism(input: {
  current: JsonRecord;
  incoming: JsonRecord;
  currentRevisionId: string;
  incomingRevisionId: string;
}) {
  const selected = selectRecord(
    input.current,
    input.incoming,
    input.currentRevisionId,
    input.incomingRevisionId,
    'lastTickAt',
  );
  return {
    ...selected,
    lastChatAt: Math.max(
      numberAt(input.current.lastChatAt),
      numberAt(input.incoming.lastChatAt),
    ),
    lastExcitingEventAt: Math.max(
      numberAt(input.current.lastExcitingEventAt),
      numberAt(input.incoming.lastExcitingEventAt),
    ),
    lastTickAt: Math.max(
      numberAt(input.current.lastTickAt),
      numberAt(input.incoming.lastTickAt),
    ),
  } as JsonRecord;
}

function mergeRhythm(input: {
  current: JsonRecord;
  incoming: JsonRecord;
  currentRevisionId: string;
  incomingRevisionId: string;
}) {
  const selected = selectRecord(
    input.current,
    input.incoming,
    input.currentRevisionId,
    input.incomingRevisionId,
    'updatedAt',
  );
  const selectedSleepEpisode = selectRecord(
    input.current,
    input.incoming,
    input.currentRevisionId,
    input.incomingRevisionId,
    'lastSleepStartedAt',
  );
  const lastWakeAt = Math.max(
    numberAt(input.current.lastWakeAt),
    numberAt(input.incoming.lastWakeAt),
  );
  const lastSleepStartedAt = numberAt(selectedSleepEpisode.lastSleepStartedAt);
  const sleepEpisode = lastSleepStartedAt > 0
    ? {
      lastSleepStartedAt,
      ...(typeof selectedSleepEpisode.lastSleepEndedAt === 'number'
        ? { lastSleepEndedAt: selectedSleepEpisode.lastSleepEndedAt }
        : {}),
      ...(typeof selectedSleepEpisode.lastSleepDurationMinutes === 'number'
        ? { lastSleepDurationMinutes: selectedSleepEpisode.lastSleepDurationMinutes }
        : {}),
      ...(typeof selectedSleepEpisode.lastSleepWasMain === 'boolean'
        ? { lastSleepWasMain: selectedSleepEpisode.lastSleepWasMain }
        : {}),
    }
    : {};
  return {
    ...selected,
    ...sleepEpisode,
    lastTickAt: Math.max(
      numberAt(input.current.lastTickAt),
      numberAt(input.incoming.lastTickAt),
    ),
    ...(lastWakeAt > 0 ? { lastWakeAt } : {}),
    updatedAt: Math.max(
      numberAt(input.current.updatedAt),
      numberAt(input.incoming.updatedAt),
    ),
  } as JsonRecord;
}

function mergeConcurrentRecords(input: {
  entityId: string;
  current: AssistantLifeStateRevisionValue;
  incoming: AssistantLifeStateRevisionValue;
  heads: string[];
}): AssistantLifeStateMergeDecision {
  const currentKind = payloadKind(input.current);
  const incomingKind = payloadKind(input.incoming);
  if (!currentKind || !incomingKind || currentKind !== incomingKind) {
    throw new Error('assistant.life-state 并发 revision kind 不一致。');
  }
  const currentValue = payloadValue(input.current);
  const incomingValue = payloadValue(input.incoming);
  if (compareJson(currentValue, incomingValue)) {
    return {
      kind: 'keep-current',
      payload: input.current.payload,
      operation: input.current.operation,
      resultingHeadRevisionIds: input.heads,
      requiresMergeRevision: true,
      mergeParentRevisionIds: input.heads,
    };
  }
  let merged: JsonRecord;
  switch (currentKind) {
    case 'life-day':
      merged = mergeLifeDay({
        current: currentValue,
        incoming: incomingValue,
        currentRevisionId: input.current.revisionId,
        incomingRevisionId: input.incoming.revisionId,
      });
      break;
    case 'desire-state':
      merged = mergeDesireState({
        current: currentValue,
        incoming: incomingValue,
        currentRevisionId: input.current.revisionId,
        incomingRevisionId: input.incoming.revisionId,
      });
      break;
    case 'drive-metabolism':
      merged = mergeMetabolism({
        current: currentValue,
        incoming: incomingValue,
        currentRevisionId: input.current.revisionId,
        incomingRevisionId: input.incoming.revisionId,
      });
      break;
    case 'life-rhythm':
      merged = mergeRhythm({
        current: currentValue,
        incoming: incomingValue,
        currentRevisionId: input.current.revisionId,
        incomingRevisionId: input.incoming.revisionId,
      });
      break;
    case 'assistant-state':
      merged = selectRecord(
        currentValue,
        incomingValue,
        input.current.revisionId,
        input.incoming.revisionId,
        'updatedAt',
      );
      {
        const { sleepSource: _retiredSoothingSource, ...current } = merged;
        merged = current;
        const summary = mergeUnifiedContactSummary(currentValue.unifiedContact, incomingValue.unifiedContact);
        if (summary !== undefined) merged = { ...merged, unifiedContact: summary };
        // A legacy state may update text, but its absent form is not a decision to turn white.
        if (merged.cloudForm === undefined && (currentValue.cloudForm ?? incomingValue.cloudForm) !== undefined) {
          merged = { ...merged, cloudForm: currentValue.cloudForm ?? incomingValue.cloudForm };
        }
        if (merged.textUpdatedAt === undefined && currentValue.title === incomingValue.title
          && currentValue.activity === incomingValue.activity) {
          const textUpdatedAt = currentValue.textUpdatedAt ?? incomingValue.textUpdatedAt;
          if (textUpdatedAt !== undefined) merged = { ...merged, textUpdatedAt };
        }
      }
      break;
    case 'conversation-afterglow':
      merged = currentValue.schemaVersion !== incomingValue.schemaVersion
        && (currentValue.schemaVersion === 3 || incomingValue.schemaVersion === 3)
        ? (currentValue.schemaVersion === 3 ? currentValue : incomingValue)
        : selectRecord(
          currentValue,
          incomingValue,
          input.current.revisionId,
          input.incoming.revisionId,
          'updatedAt',
        );
      if (currentValue.schemaVersion === 3 && incomingValue.schemaVersion === 3) {
        merged = mergeConversationAfterglowRuntimeProgress(currentValue, incomingValue, merged);
      }
      break;
    case 'global-interaction':
      merged = selectRecord(
        currentValue,
        incomingValue,
        input.current.revisionId,
        input.incoming.revisionId,
        'lastInteractionAt',
      );
      break;
    case 'love-summary':
      merged = selectRecord(
        currentValue,
        incomingValue,
        input.current.revisionId,
        input.incoming.revisionId,
        'generatedAt',
      );
      break;
    case 'inner-desire-state':
      merged = mergeJunluoDesireStates(
        currentValue as unknown as JunluoDesireState,
        incomingValue as unknown as JunluoDesireState,
      ) as unknown as JsonRecord;
      break;
    case 'inner-affect-state':
      {
        const currentAffect = upgradeJunluoAffectState(currentValue);
        const incomingAffect = upgradeJunluoAffectState(incomingValue);
        if (!currentAffect || !incomingAffect) {
          throw new Error('inner affect state 无法升级到 V2。');
        }
        merged = mergeJunluoAffectStates(
          currentAffect,
          incomingAffect,
        ) as unknown as JsonRecord;
      }
      break;
    case 'inner-thought-state':
      merged = mergeJunluoThoughtStates(
        currentValue as unknown as JunluoThoughtStateV1,
        incomingValue as unknown as JunluoThoughtStateV1,
      ) as unknown as JsonRecord;
      break;
  }
  return {
    kind: 'merged',
    payload: recordPayload(currentKind, input.entityId, merged),
    operation: 'upsert',
    resultingHeadRevisionIds: input.heads,
    requiresMergeRevision: true,
    mergeParentRevisionIds: input.heads,
  };
}

export function resolveAssistantLifeStateRevisions(input: {
  entityType: AssistantLifeStateEntityType;
  entityId: string;
  current: AssistantLifeStateRevisionValue | null;
  incoming: AssistantLifeStateRevisionValue;
}): AssistantLifeStateMergeDecision {
  assertRevision(input.entityType, input.entityId, input.incoming);
  if (input.current === null) {
    return {
      kind: 'apply-incoming',
      payload: input.incoming.payload,
      operation: input.incoming.operation,
      resultingHeadRevisionIds: [input.incoming.revisionId],
    };
  }
  assertRevision(input.entityType, input.entityId, input.current);
  if (input.current.revisionId === input.incoming.revisionId) {
    return {
      kind: 'already-current',
      payload: input.current.payload,
      operation: input.current.operation,
      resultingHeadRevisionIds: [input.current.revisionId],
    };
  }
  const currentKind = payloadKind(input.current);
  const incomingKind = payloadKind(input.incoming);
  if (currentKind === incomingKind && (currentKind === 'inner-desire-state' || currentKind === 'conversation-afterglow')) {
    const currentLegacy = isLegacyWantsStateRecord(currentKind, payloadValue(input.current));
    const incomingLegacy = isLegacyWantsStateRecord(currentKind, payloadValue(input.incoming));
    if (currentLegacy && incomingLegacy) {
      return { kind: 'ignore-incoming', payload: input.current.payload, operation: input.current.operation,
        resultingHeadRevisionIds: uniqueSorted([input.current.revisionId, input.incoming.revisionId]) };
    }
    if (currentLegacy || incomingLegacy) {
      // Old transport bytes can be acknowledged, but cannot replace the current numeric paper.
      const selected = incomingLegacy ? input.current : input.incoming;
      const heads = uniqueSorted([input.current.revisionId, input.incoming.revisionId]);
      return { kind: selected === input.current ? 'keep-current' : 'merged',
        payload: selected.payload, operation: selected.operation,
        resultingHeadRevisionIds: heads, requiresMergeRevision: true, mergeParentRevisionIds: heads };
    }
  }
  if (currentKind === 'inner-desire-state' && incomingKind === currentKind
    && Boolean(recordOf(payloadValue(input.current).clock, 'desire clock').correction)
      !== Boolean(recordOf(payloadValue(input.incoming).clock, 'desire clock').correction)) {
    return mergeConcurrentRecords({ entityId: input.entityId, current: input.current, incoming: input.incoming,
      heads: uniqueSorted([input.current.revisionId, input.incoming.revisionId]) });
  }
  if (input.current.parentRevisionIds.includes(input.incoming.revisionId)) {
    if (currentKind === incomingKind && currentKind === 'conversation-afterglow'
      && [payloadValue(input.current), payloadValue(input.incoming)].some(value => value.experience)) {
      return mergeConcurrentRecords({ entityId: input.entityId, current: input.current, incoming: input.incoming,
        heads: uniqueSorted([input.current.revisionId, input.incoming.revisionId]) });
    }
    return {
      kind: 'ignore-incoming',
      payload: input.current.payload,
      operation: input.current.operation,
      resultingHeadRevisionIds: [input.current.revisionId],
    };
  }
  if (input.incoming.parentRevisionIds.includes(input.current.revisionId)) {
    if (currentKind === 'assistant-state' && incomingKind === currentKind
      && (payloadValue(input.current).unifiedContact || payloadValue(input.incoming).unifiedContact
        || payloadValue(input.current).cloudForm || payloadValue(input.incoming).cloudForm
        || payloadValue(input.current).textUpdatedAt !== undefined || payloadValue(input.incoming).textUpdatedAt !== undefined)) {
      return mergeConcurrentRecords({ entityId: input.entityId, current: input.current, incoming: input.incoming,
        heads: uniqueSorted([input.current.revisionId, input.incoming.revisionId]) });
    }
    if (currentKind === incomingKind && currentKind === 'conversation-afterglow'
      && [payloadValue(input.current), payloadValue(input.incoming)].some(value => hasInternalRetryProgress(value) || hasChatSupplement(value) || hasPokeProgress(value) || hasPaperLifeProgress(value) || value.experience)) {
      return mergeConcurrentRecords({ entityId: input.entityId, current: input.current, incoming: input.incoming,
        heads: uniqueSorted([input.current.revisionId, input.incoming.revisionId]) });
    }
    if (currentKind === incomingKind && currentKind === 'life-day'
      && (payloadValue(input.current).nearStatus || payloadValue(input.incoming).nearStatus
        || recordOf(payloadValue(input.current).nightSleepPlan ?? {}, 'night').nearStatus
        || recordOf(payloadValue(input.incoming).nightSleepPlan ?? {}, 'night').nearStatus
        || payloadValue(input.current).nightSleepPlan || payloadValue(input.incoming).nightSleepPlan)) {
      return mergeConcurrentRecords({ entityId: input.entityId, current: input.current, incoming: input.incoming,
        heads: uniqueSorted([input.current.revisionId, input.incoming.revisionId]) });
    }
    if ((payloadKind(input.current) === 'conversation-afterglow' || payloadKind(input.current) === 'inner-desire-state')
      && payloadKind(input.current) === payloadKind(input.incoming)
      && shouldKeepCurrentWantsState(payloadValue(input.current), payloadValue(input.incoming))) {
      return mergeConcurrentRecords({
        entityId: input.entityId,
        current: input.current,
        incoming: input.incoming,
        heads: uniqueSorted([input.current.revisionId, input.incoming.revisionId]),
      });
    }
    if (
      input.current.operation === 'delete'
      && input.incoming.operation !== 'restore'
    ) {
      const heads = uniqueSorted([
        input.current.revisionId,
        input.incoming.revisionId,
      ]);
      return {
        kind: 'keep-current',
        payload: input.current.payload,
        operation: 'delete',
        resultingHeadRevisionIds: heads,
        requiresMergeRevision: true,
        mergeParentRevisionIds: heads,
      };
    }
    return {
      kind: 'apply-incoming',
      payload: input.incoming.payload,
      operation: input.incoming.operation,
      resultingHeadRevisionIds: [input.incoming.revisionId],
    };
  }

  const heads = uniqueSorted([
    input.current.revisionId,
    input.incoming.revisionId,
  ]);
  const currentDeleted = input.current.operation === 'delete';
  const incomingDeleted = input.incoming.operation === 'delete';
  if (currentDeleted || incomingDeleted) {
    if (currentDeleted && incomingDeleted) {
      const selected = input.current.createdAt === input.incoming.createdAt
        ? (
            input.current.revisionId.localeCompare(input.incoming.revisionId) >= 0
              ? input.current
              : input.incoming
          )
        : input.current.createdAt > input.incoming.createdAt
          ? input.current
          : input.incoming;
      return {
        kind: selected === input.current ? 'keep-current' : 'merged',
        payload: selected.payload,
        operation: 'delete',
        resultingHeadRevisionIds: heads,
        requiresMergeRevision: true,
        mergeParentRevisionIds: heads,
      };
    }
    const deleted = currentDeleted ? input.current : input.incoming;
    return {
      kind: 'conflict',
      payload: deleted.payload,
      operation: 'delete',
      resultingHeadRevisionIds: heads,
      conflictKind: 'delete-modify',
      conflictingFields: [],
    };
  }
  return mergeConcurrentRecords({
    entityId: input.entityId,
    current: input.current,
    incoming: input.incoming,
    heads,
  });
}
