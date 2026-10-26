import type {
  ChatCoreMutationEnvelope,
} from './syncChatCore';
import {
  assertProactiveLedgerRecord,
  buildProactiveLedgerRecordMutation,
  proactiveLedgerEntityTypeForKind,
  proactiveLedgerOperationForKind,
  type ProactiveActiveDeliveryRecord,
  type ProactiveAgentTaskRecord,
  type ProactiveLedgerEntityType,
  type ProactiveLedgerRecordKind,
  type ProactiveSocialActionLogRecord,
  type ProactiveSocialCommentReplyRecord,
  type ProactiveSocialDraftRecord,
  type ProactiveShareResponseExchangeRecord,
  type ProactiveWebVoyageLogRecord,
  type ProactiveWebVoyageShareIntentRecord,
} from './syncProactiveLedger';
import {
  assertJsonValue,
  type JsonValue,
  type PlainMutationV1,
} from './syncProtocol';

export const PROACTIVE_AGENT_TASK_KEY =
  'junluo.agentTask.once.v1' as const;
export const PROACTIVE_ACTIVE_MESSAGE_COORDINATOR_KEY =
  'junluo.activeMessageCoordinator.v1' as const;
export const PROACTIVE_WEB_VOYAGE_LOG_KEY =
  'junluo.life.webVoyage.log.v1' as const;
export const PROACTIVE_WEB_VOYAGE_SHARE_QUEUE_KEY =
  'junluo.life.webVoyage.shareQueue.v1' as const;
export const PROACTIVE_SOCIAL_ACTION_LOG_KEY =
  'junluo.life.socialAgent.actionLog.v1' as const;
export const PROACTIVE_SOCIAL_DRAFTS_KEY =
  'junluo.life.socialAgent.drafts.v1' as const;
export const PROACTIVE_SOCIAL_COMMENT_REPLY_STATE_KEY =
  'junluo.life.socialAgent.commentReplyState.v1' as const;
export const PROACTIVE_SHARE_RESPONSE_EXCHANGES_KEY =
  'junluo.baiyunBehavior.pendingShareExchanges.v1' as const;

export const PROACTIVE_LEDGER_GLOBAL_KEYS = Object.freeze([
  PROACTIVE_AGENT_TASK_KEY,
  PROACTIVE_ACTIVE_MESSAGE_COORDINATOR_KEY,
  PROACTIVE_WEB_VOYAGE_LOG_KEY,
  PROACTIVE_WEB_VOYAGE_SHARE_QUEUE_KEY,
  PROACTIVE_SOCIAL_ACTION_LOG_KEY,
  PROACTIVE_SOCIAL_DRAFTS_KEY,
  PROACTIVE_SOCIAL_COMMENT_REPLY_STATE_KEY,
  PROACTIVE_SHARE_RESPONSE_EXCHANGES_KEY,
] as const);

const GLOBAL_KEY_SET = new Set<string>(PROACTIVE_LEDGER_GLOBAL_KEYS);

export type ProactiveLedgerStorageChange =
  | { kind: 'set'; key: string; value: string }
  | { kind: 'remove'; key: string };

export type ProactiveLedgerStorageReadPort = {
  getItem(key: string): Promise<string | null>;
};

export type ProactiveLedgerEnvelopeFactory = (
  entity: {
    domain: 'proactive';
    type: ProactiveLedgerEntityType;
    id: string;
  },
) => Promise<ChatCoreMutationEnvelope>;

export type ProactiveLedgerProjectedRecord = {
  entityType: ProactiveLedgerEntityType;
  entityId: string;
  kind: ProactiveLedgerRecordKind;
  operation: 'append' | 'upsert';
  value: JsonValue;
};

type UnknownRecord = Record<string, unknown>;

function recordOf(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象。`);
  }
  return value as UnknownRecord;
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${label} 不是有效 JSON。`);
  }
}

function assertExactKeys(
  value: UnknownRecord,
  allowed: readonly string[],
  label: string,
) {
  const allowedSet = new Set(allowed);
  const extra = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (extra.length) {
    throw new Error(
      `${label} 包含未登记字段：${extra.sort().join(', ')}。`,
    );
  }
}

function arrayOf(raw: string, label: string) {
  const value = parseJson(raw, label);
  if (!Array.isArray(value)) {
    throw new Error(`${label} 必须是数组。`);
  }
  return value;
}

function jsonRecord(
  value: UnknownRecord,
  label: string,
): JsonValue {
  assertJsonValue(value, label);
  return value as JsonValue;
}

function projected(
  kind: ProactiveLedgerRecordKind,
  entityId: string,
  value: UnknownRecord,
): ProactiveLedgerProjectedRecord {
  assertProactiveLedgerRecord(kind, entityId, value);
  return {
    entityType: proactiveLedgerEntityTypeForKind(kind),
    entityId,
    kind,
    operation: proactiveLedgerOperationForKind(kind),
    value: jsonRecord(value, `proactive.ledger ${kind}`),
  };
}

function requiredId(value: UnknownRecord, label: string) {
  if (
    typeof value.id !== 'string'
    || value.id.length < 1
    || value.id.length > 256
  ) {
    throw new Error(`${label}.id 无效。`);
  }
  return value.id;
}

function withoutUndefined(value: UnknownRecord) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
}

function projectAgentTasks(raw: string) {
  return arrayOf(raw, 'proactive agent task storage').map(
    (item, index) => {
      const source = recordOf(item, `agentTasks[${index}]`);
      assertExactKeys(
        source,
        [
          'id',
          'title',
          'message',
          'triggerAt',
          'status',
          'notificationId',
          'sourceMessageId',
          'createdAt',
          'updatedAt',
          'deliveredAt',
          'cancelledAt',
        ],
        `agentTasks[${index}]`,
      );
      const value = { ...source };
      delete value.notificationId;
      const id = requiredId(value, `agentTasks[${index}]`);
      return projected(
        'agent-task',
        id,
        withoutUndefined(value) as ProactiveAgentTaskRecord,
      );
    },
  );
}

function fnv1a32(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function proactiveActiveDeliveryEntityId(
  value: Record<string, unknown>,
) {
  const signature = [
    String(value.deliveredAt ?? ''),
    String(value.messageCount ?? ''),
    String(value.priority ?? ''),
    String(value.source ?? ''),
    String(value.topicKey ?? ''),
  ].join('\u0000');
  return `active-delivery-${String(value.deliveredAt)}-${fnv1a32(signature)}`;
}

function projectActiveMessageDeliveries(raw: string) {
  const snapshot = recordOf(
    parseJson(raw, 'active message coordinator storage'),
    'active message coordinator storage',
  );
  assertExactKeys(
    snapshot,
    ['lastDecision', 'records', 'updatedAt', 'version'],
    'active message coordinator storage',
  );
  if (!Array.isArray(snapshot.records)) {
    throw new Error('active message coordinator records 必须是数组。');
  }
  return snapshot.records.map((item, index) => {
    const source = recordOf(
      item,
      `activeMessageCoordinator.records[${index}]`,
    );
    assertExactKeys(
      source,
      [
        'deliveredAt',
        'messageCount',
        'priority',
        'source',
        'topicKey',
      ],
      `activeMessageCoordinator.records[${index}]`,
    );
    const id = proactiveActiveDeliveryEntityId(source);
    const value = withoutUndefined({
      ...source,
      id,
    }) as ProactiveActiveDeliveryRecord;
    return projected('active-message-delivery', id, value);
  });
}

function projectWebVoyageLogs(raw: string) {
  return arrayOf(raw, 'web voyage log storage').map((item, index) => {
    const value = recordOf(item, `webVoyageLog[${index}]`);
    const id = requiredId(value, `webVoyageLog[${index}]`);
    const { memoryIngestionVersion: _localIngestionVersion, ...transport } = value;
    return projected(
      'web-voyage-log',
      id,
      withoutUndefined(transport) as ProactiveWebVoyageLogRecord,
    );
  });
}

function projectWebVoyageShareIntents(raw: string) {
  return arrayOf(raw, 'web voyage share queue storage').map(
    (item, index) => {
      const value = recordOf(item, `webVoyageShareQueue[${index}]`);
      const id = requiredId(value, `webVoyageShareQueue[${index}]`);
      return projected(
        'web-voyage-share-intent',
        id,
        withoutUndefined(value) as ProactiveWebVoyageShareIntentRecord,
      );
    },
  );
}

function projectSocialActionLogs(raw: string) {
  return arrayOf(raw, 'social action log storage').map((item, index) => {
    const value = recordOf(item, `socialActionLog[${index}]`);
    const id = requiredId(value, `socialActionLog[${index}]`);
    return projected(
      'social-action-log',
      id,
      withoutUndefined(value) as ProactiveSocialActionLogRecord,
    );
  });
}

function projectSocialDrafts(raw: string) {
  return arrayOf(raw, 'social drafts storage').map((item, index) => {
    const value = recordOf(item, `socialDrafts[${index}]`);
    const id = requiredId(value, `socialDrafts[${index}]`);
    return projected(
      'social-draft',
      id,
      withoutUndefined(value) as ProactiveSocialDraftRecord,
    );
  });
}

function projectSocialCommentReplies(raw: string) {
  const state = recordOf(
    parseJson(raw, 'social comment reply state'),
    'social comment reply state',
  );
  assertExactKeys(
    state,
    ['lastReplyAt', 'repliedCommentIds'],
    'social comment reply state',
  );
  if (
    state.repliedCommentIds !== undefined
    && !Array.isArray(state.repliedCommentIds)
  ) {
    throw new Error('social repliedCommentIds 必须是数组。');
  }
  const ids = (state.repliedCommentIds ?? []) as unknown[];
  return [...new Set(ids.map((value, index) => {
    if (
      typeof value !== 'string'
      || value.length < 1
      || value.length > 256
    ) {
      throw new Error(`social repliedCommentIds[${index}] 无效。`);
    }
    return value;
  }))].map((commentId) => projected(
    'social-comment-reply',
    commentId,
    { commentId } as ProactiveSocialCommentReplyRecord,
  ));
}

function projectShareResponseExchanges(raw: string) {
  return arrayOf(raw, 'share response exchange storage').map((item, index) => {
    const value = recordOf(item, `shareResponseExchanges[${index}]`);
    const id = requiredId(value, `shareResponseExchanges[${index}]`);
    return projected(
      'share-response-exchange',
      id,
      withoutUndefined(value) as ProactiveShareResponseExchangeRecord,
    );
  });
}

export function isProactiveLedgerGlobalStorageKey(
  key: string,
): key is typeof PROACTIVE_LEDGER_GLOBAL_KEYS[number] {
  return GLOBAL_KEY_SET.has(key);
}

export function projectProactiveLedgerStorage(
  key: string,
  raw: string,
): ProactiveLedgerProjectedRecord[] {
  switch (key) {
    case PROACTIVE_AGENT_TASK_KEY:
      return projectAgentTasks(raw);
    case PROACTIVE_ACTIVE_MESSAGE_COORDINATOR_KEY:
      return projectActiveMessageDeliveries(raw);
    case PROACTIVE_WEB_VOYAGE_LOG_KEY:
      return projectWebVoyageLogs(raw);
    case PROACTIVE_WEB_VOYAGE_SHARE_QUEUE_KEY:
      return projectWebVoyageShareIntents(raw);
    case PROACTIVE_SOCIAL_ACTION_LOG_KEY:
      return projectSocialActionLogs(raw);
    case PROACTIVE_SOCIAL_DRAFTS_KEY:
      return projectSocialDrafts(raw);
    case PROACTIVE_SOCIAL_COMMENT_REPLY_STATE_KEY:
      return projectSocialCommentReplies(raw);
    case PROACTIVE_SHARE_RESPONSE_EXCHANGES_KEY:
      return projectShareResponseExchanges(raw);
    default:
      return [];
  }
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => (
      `${JSON.stringify(key)}:${canonicalJson(entry)}`
    ))
    .join(',')}}`;
}

function recordKey(value: ProactiveLedgerProjectedRecord) {
  return `${value.kind}\u0000${value.entityId}`;
}

function uniqueProjected(
  records: readonly ProactiveLedgerProjectedRecord[],
  label: string,
) {
  const byKey = new Map<string, ProactiveLedgerProjectedRecord>();
  for (const record of records) {
    const key = recordKey(record);
    const existing = byKey.get(key);
    if (
      existing
      && canonicalJson(existing.value) !== canonicalJson(record.value)
    ) {
      throw new Error(`${label} 包含冲突的重复实体 ${record.entityId}。`);
    }
    byKey.set(key, record);
  }
  return [...byKey.values()];
}

export async function deriveProactiveLedgerMutationsForStorageChanges(
  input: {
    changes: readonly ProactiveLedgerStorageChange[];
    reader: ProactiveLedgerStorageReadPort;
    capturedAt: number;
    envelopeFactory: ProactiveLedgerEnvelopeFactory;
  },
): Promise<PlainMutationV1[]> {
  const mutations: PlainMutationV1[] = [];
  for (const change of input.changes) {
    if (!isProactiveLedgerGlobalStorageKey(change.key)) continue;
    // 领取、窗口截断与测试清理都不是全局删除。状态必须通过记录本身迁移。
    if (change.kind === 'remove') continue;
    const previousRaw = await input.reader.getItem(change.key);
    const previous = previousRaw
      ? uniqueProjected(
          projectProactiveLedgerStorage(change.key, previousRaw),
          `旧 ${change.key}`,
        )
      : [];
    const previousByKey = new Map(
      previous.map((record) => [recordKey(record), record]),
    );
    const next = uniqueProjected(
      projectProactiveLedgerStorage(change.key, change.value),
      `新 ${change.key}`,
    );
    for (const record of next) {
      const before = previousByKey.get(recordKey(record));
      if (
        before
        && canonicalJson(before.value) === canonicalJson(record.value)
      ) {
        continue;
      }
      const envelope = await input.envelopeFactory({
        domain: 'proactive',
        type: record.entityType,
        id: record.entityId,
      });
      mutations.push(buildProactiveLedgerRecordMutation({
        envelope: {
          ...envelope,
          createdAt: input.capturedAt,
        },
        kind: record.kind,
        entityId: record.entityId,
        value: record.value,
        operation: record.operation,
      }));
    }
  }
  return mutations;
}
