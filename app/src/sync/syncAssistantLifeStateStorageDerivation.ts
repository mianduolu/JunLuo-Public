import {
  stripRetiredLifeProjectFields,
} from '../ai/retiredAssistantFeatureData';
import {
  JUNLUO_INNER_STATE_KEYS,
  JUNLUO_INNER_STATE_SYNC_SPECS,
} from '../life/junluoInnerState';
import { upgradeJunluoAffectState } from '../life/junluoInnerStatePersistence';
import {
  assertAssistantLifeStateRecord,
  projectUnifiedContactSummary,
  buildAssistantLifeStateDeleteMutation,
  buildAssistantLifeStateRecordMutation,
  type AssistantLifeStateEntityType,
  type AssistantLifeStateRecordKind,
} from './syncAssistantLifeState';
import type {
  ChatCoreMutationEnvelope,
} from './syncChatCore';
import {
  assertJsonValue,
  type JsonValue,
  type PlainMutationV1,
} from './syncProtocol';

export const ASSISTANT_LIFE_STATE_KEYS = Object.freeze({
  assistantState: 'junluo.assistant.currentState',
  proactiveState: 'junluo.proactiveMessage.state',
  lifeDayIndex: 'junluo.assistant.lifeDayIndex',
  lifeDayPrefix: 'junluo.assistant.lifeDay.',
  driveMetabolism: 'junluo.life.driveMetabolism.state',
  desireState: 'junluo.life.desire.state.v1',
  lifeRhythm: 'junluo.life.rhythm.state.v1',
  conversationAfterglow: 'junluo.assistant.conversationAfterglowState',
  globalInteraction: 'junluo.globalCognition.lastInteraction',
  loveSummary: 'junluo.life.loveSummary.v1',
  innerDesire: JUNLUO_INNER_STATE_KEYS.desire,
  innerAffect: JUNLUO_INNER_STATE_KEYS.affect,
  innerThought: JUNLUO_INNER_STATE_KEYS.thought,
} as const);

export const ASSISTANT_LIFE_STATE_FIXED_GLOBAL_KEYS = Object.freeze([
  ASSISTANT_LIFE_STATE_KEYS.assistantState,
  ASSISTANT_LIFE_STATE_KEYS.proactiveState,
  ASSISTANT_LIFE_STATE_KEYS.driveMetabolism,
  ASSISTANT_LIFE_STATE_KEYS.desireState,
  ASSISTANT_LIFE_STATE_KEYS.lifeRhythm,
  ASSISTANT_LIFE_STATE_KEYS.conversationAfterglow,
  ASSISTANT_LIFE_STATE_KEYS.globalInteraction,
  ASSISTANT_LIFE_STATE_KEYS.loveSummary,
  ASSISTANT_LIFE_STATE_KEYS.innerDesire,
  ASSISTANT_LIFE_STATE_KEYS.innerAffect,
  ASSISTANT_LIFE_STATE_KEYS.innerThought,
] as const);

const FIXED_GLOBAL_KEY_SET = new Set<string>(
  ASSISTANT_LIFE_STATE_FIXED_GLOBAL_KEYS,
);
const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type AssistantLifeStateStorageChange =
  | { kind: 'set'; key: string; value: string }
  | { kind: 'remove'; key: string };

export type AssistantLifeStateStorageReadPort = {
  getItem(key: string): Promise<string | null>;
};

export type AssistantLifeStateEnvelopeFactory = (
  entity: {
    domain: 'life';
    type: AssistantLifeStateEntityType;
    id: string;
  },
) => Promise<ChatCoreMutationEnvelope>;

type JsonRecord = { [key: string]: JsonValue };

type LogicalRecordChange = {
  entityType: AssistantLifeStateEntityType;
  entityId: string;
  kind: AssistantLifeStateRecordKind;
  value: JsonValue;
  operation: 'upsert';
};

type LogicalDeleteChange = {
  entityType: AssistantLifeStateEntityType;
  entityId: string;
  operation: 'delete';
};

type LogicalChange = LogicalRecordChange | LogicalDeleteChange;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseJson(raw: string | null, label: string): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${label} 不是有效 JSON。`);
  }
}

function jsonValue(value: unknown, label: string): JsonValue {
  try {
    assertJsonValue(value);
    return value;
  } catch {
    throw new Error(`${label} 不是严格 JSON 值。`);
  }
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== typeof right) {
    return false;
  }
  if (Array.isArray(left)) {
    return (
      Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => jsonEqual(value, right[index]))
    );
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length
    && leftKeys.every(
      (key, index) => (
        key === rightKeys[index]
        && jsonEqual(left[key], right[key])
      ),
    )
  );
}

function timestamp(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} 必须是非负 Unix 毫秒整数。`);
  }
  return value as number;
}

export function isAssistantLifeDayStorageKey(key: string) {
  if (!key.startsWith(ASSISTANT_LIFE_STATE_KEYS.lifeDayPrefix)) return false;
  const dateKey = key.slice(ASSISTANT_LIFE_STATE_KEYS.lifeDayPrefix.length);
  return DATE_KEY_PATTERN.test(dateKey);
}

export function isAssistantLifeStateGlobalStorageKey(key: string) {
  return (
    FIXED_GLOBAL_KEY_SET.has(key)
    || isAssistantLifeDayStorageKey(key)
  );
}

function recordValue(raw: string | null, label: string) {
  if (raw === null) return null;
  const parsed = parseJson(raw, label);
  if (!isRecord(parsed)) throw new Error(`${label} 必须是对象。`);
  return jsonValue(parsed, label) as JsonRecord;
}

function fixedKind(
  key: string,
): {
  entityType: AssistantLifeStateEntityType;
  entityId: string;
  kind: AssistantLifeStateRecordKind;
} | null {
  if (key === ASSISTANT_LIFE_STATE_KEYS.assistantState) {
    return {
      entityType: 'assistant-state',
      entityId: 'current',
      kind: 'assistant-state',
    };
  }
  if (key === ASSISTANT_LIFE_STATE_KEYS.driveMetabolism) {
    return {
      entityType: 'drive-state',
      entityId: 'metabolism',
      kind: 'drive-metabolism',
    };
  }
  if (key === ASSISTANT_LIFE_STATE_KEYS.desireState) {
    return {
      entityType: 'drive-state',
      entityId: 'desire',
      kind: 'desire-state',
    };
  }
  if (key === ASSISTANT_LIFE_STATE_KEYS.lifeRhythm) {
    return {
      entityType: 'drive-state',
      entityId: 'rhythm',
      kind: 'life-rhythm',
    };
  }
  if (key === ASSISTANT_LIFE_STATE_KEYS.conversationAfterglow) {
    return {
      entityType: 'drive-state',
      entityId: 'conversation-afterglow',
      kind: 'conversation-afterglow',
    };
  }
  if (key === ASSISTANT_LIFE_STATE_KEYS.globalInteraction) {
    return {
      entityType: 'drive-state',
      entityId: 'global-interaction',
      kind: 'global-interaction',
    };
  }
  if (key === ASSISTANT_LIFE_STATE_KEYS.loveSummary) {
    return {
      entityType: 'drive-state',
      entityId: 'love-summary',
      kind: 'love-summary',
    };
  }
  if (key === ASSISTANT_LIFE_STATE_KEYS.innerDesire) {
    return {
      entityType: JUNLUO_INNER_STATE_SYNC_SPECS.desire.entityType,
      entityId: JUNLUO_INNER_STATE_SYNC_SPECS.desire.entityId,
      kind: JUNLUO_INNER_STATE_SYNC_SPECS.desire.kind,
    };
  }
  if (key === ASSISTANT_LIFE_STATE_KEYS.innerAffect) {
    return {
      entityType: JUNLUO_INNER_STATE_SYNC_SPECS.affect.entityType,
      entityId: JUNLUO_INNER_STATE_SYNC_SPECS.affect.entityId,
      kind: JUNLUO_INNER_STATE_SYNC_SPECS.affect.kind,
    };
  }
  if (key === ASSISTANT_LIFE_STATE_KEYS.innerThought) {
    return {
      entityType: JUNLUO_INNER_STATE_SYNC_SPECS.thought.entityType,
      entityId: JUNLUO_INNER_STATE_SYNC_SPECS.thought.entityId,
      kind: JUNLUO_INNER_STATE_SYNC_SPECS.thought.kind,
    };
  }
  return null;
}

function logicalKey(change: LogicalChange) {
  return `${change.entityType}\u0000${change.entityId}`;
}

function setLogical(
  changes: Map<string, LogicalChange>,
  change: LogicalChange,
) {
  changes.set(logicalKey(change), change);
}

function deriveFixedRecord(
  key: string,
  previousRaw: string | null,
  nextRaw: string | null,
  logicalChanges: Map<string, LogicalChange>,
) {
  const spec = fixedKind(key);
  if (!spec) return;
  const previous = recordValue(previousRaw, key);
  let next = recordValue(nextRaw, key);
  if (key === ASSISTANT_LIFE_STATE_KEYS.assistantState && next !== null) {
    const { sleepSource: _retiredSoothingSource, ...current } = next;
    next = current;
  }
  if (key === ASSISTANT_LIFE_STATE_KEYS.innerAffect && next !== null) {
    const upgraded = upgradeJunluoAffectState(next);
    if (!upgraded) throw new Error(`${key} 无法升级到 V2。`);
    next = jsonValue(upgraded, key) as JsonRecord;
  }
  if (jsonEqual(previous, next)) return;
  if (next === null) {
    setLogical(logicalChanges, {
      entityType: spec.entityType,
      entityId: spec.entityId,
      operation: 'delete',
    });
    return;
  }
  assertAssistantLifeStateRecord(spec.kind, spec.entityId, next);
  setLogical(logicalChanges, {
    ...spec,
    operation: 'upsert',
    value: next,
  });
}

function deriveLifeDay(
  key: string,
  previousRaw: string | null,
  nextRaw: string | null,
  logicalChanges: Map<string, LogicalChange>,
) {
  const dateKey = key.slice(ASSISTANT_LIFE_STATE_KEYS.lifeDayPrefix.length);
  const previousStored = recordValue(previousRaw, key);
  const nextStored = recordValue(nextRaw, key);
  const previousResult = stripRetiredLifeProjectFields(previousStored);
  const nextResult = stripRetiredLifeProjectFields(nextStored);
  const previous = previousResult.value as JsonRecord | null;
  const next = nextResult.value as JsonRecord | null;
  if (
    jsonEqual(previous, next)
    && !(previousResult.changed && !nextResult.changed)
  ) return;
  if (next === null) {
    // The app evicts old materialized days after 90 days. That local retention
    // cleanup must not erase the shared life history.
    return;
  }
  assertAssistantLifeStateRecord('life-day', dateKey, next);
  setLogical(logicalChanges, {
    entityType: 'life-day',
    entityId: dateKey,
    kind: 'life-day',
    value: next,
    operation: 'upsert',
  });
}

export async function deriveAssistantLifeStateMutationsForStorageChanges(input: {
  changes: readonly AssistantLifeStateStorageChange[];
  reader: AssistantLifeStateStorageReadPort;
  capturedAt: number;
  envelopeFactory: AssistantLifeStateEnvelopeFactory;
}) {
  timestamp(input.capturedAt, 'assistant.life-state capture time');
  const seenKeys = new Set<string>();
  const logicalChanges = new Map<string, LogicalChange>();
  const pairedKeys = [ASSISTANT_LIFE_STATE_KEYS.assistantState, ASSISTANT_LIFE_STATE_KEYS.proactiveState] as const;
  if (input.changes.some(change => pairedKeys.some(key => key === change.key))) {
    const before = new Map(await Promise.all(pairedKeys.map(async key => [key, await input.reader.getItem(key)] as const)));
    const after = new Map(before);
    for (const change of input.changes) if (pairedKeys.some(key => key === change.key)) {
      after.set(change.key as typeof pairedKeys[number], change.kind === 'set' ? change.value : null);
    }
    const combine = (values: Map<typeof pairedKeys[number], string | null>) => {
      const assistant = recordValue(values.get(pairedKeys[0]) ?? null, pairedKeys[0]);
      if (!assistant) return null;
      const runtime = recordValue(values.get(pairedKeys[1]) ?? null, pairedKeys[1]);
      const summary = projectUnifiedContactSummary(runtime?.unified);
      const { unifiedContact: _transportOnly, ...own } = assistant;
      return JSON.stringify({ ...own, ...(summary ? { unifiedContact: summary } : {}) });
    };
    deriveFixedRecord(ASSISTANT_LIFE_STATE_KEYS.assistantState, combine(before), combine(after), logicalChanges);
  }
  for (const change of input.changes) {
    if (seenKeys.has(change.key)) {
      throw new Error(`assistant.life-state 同批重复变更 key：${change.key}。`);
    }
    seenKeys.add(change.key);
    if (pairedKeys.some(key => key === change.key)) continue;
    if (
      !isAssistantLifeStateGlobalStorageKey(change.key)
      && change.key !== ASSISTANT_LIFE_STATE_KEYS.lifeDayIndex
    ) {
      continue;
    }
    if (change.key === ASSISTANT_LIFE_STATE_KEYS.lifeDayIndex) {
      continue;
    }
    const previousRaw = await input.reader.getItem(change.key);
    const nextRaw = change.kind === 'set' ? change.value : null;
    if (isAssistantLifeDayStorageKey(change.key)) {
      deriveLifeDay(change.key, previousRaw, nextRaw, logicalChanges);
    } else {
      deriveFixedRecord(
        change.key,
        previousRaw,
        nextRaw,
        logicalChanges,
      );
    }
  }

  const ordered = [...logicalChanges.values()].sort((left, right) => (
    left.entityType.localeCompare(right.entityType)
    || left.entityId.localeCompare(right.entityId)
  ));
  const mutations: PlainMutationV1[] = [];
  for (const change of ordered) {
    const envelope = await input.envelopeFactory({
      domain: 'life',
      type: change.entityType,
      id: change.entityId,
    });
    mutations.push(
      change.operation === 'delete'
        ? buildAssistantLifeStateDeleteMutation({
            envelope,
            entityType: change.entityType,
            entityId: change.entityId,
            deletedAt: input.capturedAt,
          })
        : buildAssistantLifeStateRecordMutation({
            envelope,
            entityType: change.entityType,
            entityId: change.entityId,
            kind: change.kind,
            value: change.value,
          }),
    );
  }
  return mutations;
}
