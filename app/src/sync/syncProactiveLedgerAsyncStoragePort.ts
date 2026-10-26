import RawAsyncStorage from '@react-native-async-storage/async-storage';
import { RETIRED_SOCIAL_SHARE_QUEUE_KEY } from '../ai/retiredAssistantFeatureData';

import {
  assertProactiveLedgerRecord,
  type ProactiveActiveDeliveryRecord,
  type ProactiveAgentTaskRecord,
  type ProactiveSocialActionLogRecord,
  type ProactiveSocialCommentReplyRecord,
  type ProactiveSocialDraftRecord,
  type ProactiveShareResponseExchangeRecord,
  type ProactiveWebVoyageLogRecord,
  type ProactiveWebVoyageShareIntentRecord,
} from './syncProactiveLedger';
import type {
  ProactiveLedgerBusinessPort,
} from './syncProactiveLedgerApply';
import {
  proactiveActiveDeliveryEntityId,
  PROACTIVE_ACTIVE_MESSAGE_COORDINATOR_KEY,
  PROACTIVE_AGENT_TASK_KEY,
  PROACTIVE_SOCIAL_ACTION_LOG_KEY,
  PROACTIVE_SOCIAL_COMMENT_REPLY_STATE_KEY,
  PROACTIVE_SOCIAL_DRAFTS_KEY,
  PROACTIVE_SHARE_RESPONSE_EXCHANGES_KEY,
  PROACTIVE_WEB_VOYAGE_LOG_KEY,
  PROACTIVE_WEB_VOYAGE_SHARE_QUEUE_KEY,
} from './syncProactiveLedgerStorageDerivation';

type UnknownRecord = Record<string, unknown>;

let proactiveLedgerApplyQueue = Promise.resolve();

function enqueueProactiveLedgerApply<T>(
  callback: () => Promise<T>,
) {
  const current = proactiveLedgerApplyQueue
    .catch(() => undefined)
    .then(callback);
  proactiveLedgerApplyQueue = current.then(
    () => undefined,
    () => undefined,
  );
  return current;
}

function recordOf(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

async function loadArray(key: string) {
  const raw = await RawAsyncStorage.getItem(key);
  if (!raw) return [] as UnknownRecord[];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.map(recordOf).filter(
          (item): item is UnknownRecord => item !== null,
        )
      : [];
  } catch {
    return [];
  }
}

async function saveArray(key: string, values: UnknownRecord[]) {
  await RawAsyncStorage.setItem(key, JSON.stringify(values));
}

function recordId(value: UnknownRecord) {
  return typeof value.id === 'string' ? value.id : '';
}

function numberAt(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function replaceById(
  values: UnknownRecord[],
  next: UnknownRecord,
) {
  const id = recordId(next);
  const index = values.findIndex((value) => recordId(value) === id);
  if (index < 0) return [...values, next];
  return values.map((value, itemIndex) => (
    itemIndex === index ? next : value
  ));
}

async function upsertAgentTask(
  entityId: string,
  value: ProactiveAgentTaskRecord,
) {
  const current = await loadArray(PROACTIVE_AGENT_TASK_KEY);
  const existing = current.find((item) => recordId(item) === entityId);
  const notificationId = typeof existing?.notificationId === 'string'
    ? existing.notificationId
    : undefined;
  const next = {
    ...value,
    ...(notificationId ? { notificationId } : {}),
  };
  const merged = replaceById(current, next)
    .sort((left, right) => (
      numberAt(left.triggerAt) - numberAt(right.triggerAt)
    ))
    .slice(-200);
  await saveArray(PROACTIVE_AGENT_TASK_KEY, merged);
}

async function loadActiveCoordinator() {
  const raw = await RawAsyncStorage.getItem(
    PROACTIVE_ACTIVE_MESSAGE_COORDINATOR_KEY,
  );
  if (!raw) return { records: [] as UnknownRecord[] };
  try {
    const parsed = recordOf(JSON.parse(raw) as unknown);
    return {
      ...(parsed ?? {}),
      records: Array.isArray(parsed?.records)
        ? parsed.records.map(recordOf).filter(
            (item): item is UnknownRecord => item !== null,
          )
        : [],
    };
  } catch {
    return { records: [] as UnknownRecord[] };
  }
}

async function upsertActiveDelivery(
  entityId: string,
  value: ProactiveActiveDeliveryRecord,
) {
  const snapshot = await loadActiveCoordinator();
  const exists = snapshot.records.some(
    (item) => proactiveActiveDeliveryEntityId(item) === entityId,
  );
  const records = exists
    ? snapshot.records
    : [
        ...snapshot.records,
        Object.fromEntries(
          Object.entries(value).filter(([key]) => key !== 'id'),
        ),
      ];
  await RawAsyncStorage.setItem(
    PROACTIVE_ACTIVE_MESSAGE_COORDINATOR_KEY,
    JSON.stringify({
      ...snapshot,
      records: records
        .sort((left, right) => (
          numberAt(left.deliveredAt) - numberAt(right.deliveredAt)
        ))
        .slice(-80),
      updatedAt: Date.now(),
      version: 1,
    }),
  );
}

async function removeDeliveredWebShareIntent(logId: string) {
  const queue = await loadArray(PROACTIVE_WEB_VOYAGE_SHARE_QUEUE_KEY);
  const next = queue.filter((item) => item.logId !== logId);
  if (next.length !== queue.length) {
    await saveArray(PROACTIVE_WEB_VOYAGE_SHARE_QUEUE_KEY, next);
  }
}

async function upsertWebVoyageLog(
  value: ProactiveWebVoyageLogRecord,
) {
  const current = await loadArray(PROACTIVE_WEB_VOYAGE_LOG_KEY);
  const local = current.find(entry => entry.id === value.id);
  const original = local?.memoryIngestionVersion === 1 ? { ...value, memoryIngestionVersion: 1 as const } : value;
  const entries = replaceById(current, original)
    .sort((left, right) => numberAt(right.at) - numberAt(left.at));
  const { loadLifeSelfRetainedIds, retainLifeSelfRecent } = await import('../memory/lifeSelfMemoryRetention');
  let next = entries;
  try {
    const retained = (await loadLifeSelfRetainedIds(undefined, entries.filter(entry => entry.status === 'completed'
      && entry.readingStatus === 'body_excerpt' && typeof entry.summary === 'string' && !!entry.summary.trim()).map(entry => ({
      id: String(entry.id), at: numberAt(entry.at),
      ...(entry.memoryIngestionVersion === 1 ? { memoryIngestionVersion: 1 as const } : {}),
    })))).exploration;
    next = retainLifeSelfRecent(entries as Array<(typeof entries)[number] & { id: string }>, retained, 10);
  } catch { console.warn('life-self-exploration-retention-read-failed'); }
  await saveArray(PROACTIVE_WEB_VOYAGE_LOG_KEY, next);
  if (value.shareStatus === 'delivered' || value.shareCancelledAt !== undefined || value.shareAttemptedAt !== undefined) {
    await removeDeliveredWebShareIntent(value.id);
  }
}

async function webVoyageAlreadyDelivered(logId: string) {
  const logs = await loadArray(PROACTIVE_WEB_VOYAGE_LOG_KEY);
  if (logs.some(
    (item) => item.id === logId && (item.shareStatus === 'delivered' || item.shareCancelledAt !== undefined || item.shareAttemptedAt !== undefined),
  )) return true;
  // The ten-entry UI cache is not the full lifetime of a stopped share.
  const { loadSyncEntityHeadMutations } = await import('./syncMutationStateStore');
  const heads = await loadSyncEntityHeadMutations({ domain: 'proactive', type: 'voyage', id: logId });
  return heads.some(head => {
    const payload = recordOf(head.payload);
    const value = recordOf(payload?.value);
    return payload?.kind === 'web-voyage-log' && value?.id === logId
      && (value.shareStatus === 'delivered' || value.shareCancelledAt !== undefined || value.shareAttemptedAt !== undefined);
  });
}

async function upsertWebVoyageShareIntent(
  value: ProactiveWebVoyageShareIntentRecord,
) {
  if (await webVoyageAlreadyDelivered(value.logId)) {
    await removeDeliveredWebShareIntent(value.logId);
    return;
  }
  const current = await loadArray(PROACTIVE_WEB_VOYAGE_SHARE_QUEUE_KEY);
  const duplicateIndex = current.findIndex(
    (item) => item.id === value.id || item.logId === value.logId,
  );
  const next = duplicateIndex < 0
    ? [...current, value]
    : current.map((item, index) => (
        index === duplicateIndex ? value : item
      ));
  await saveArray(
    PROACTIVE_WEB_VOYAGE_SHARE_QUEUE_KEY,
    next
      .sort((left, right) => numberAt(left.at) - numberAt(right.at))
      .slice(-8),
  );
}

async function upsertSocialActionLog(
  value: ProactiveSocialActionLogRecord,
) {
  const current = await loadArray(PROACTIVE_SOCIAL_ACTION_LOG_KEY);
  await saveArray(
    PROACTIVE_SOCIAL_ACTION_LOG_KEY,
    replaceById(current, value)
      .sort((left, right) => numberAt(right.at) - numberAt(left.at))
      .slice(0, 40),
  );
}

async function upsertSocialDraft(
  value: ProactiveSocialDraftRecord,
) {
  const current = await loadArray(PROACTIVE_SOCIAL_DRAFTS_KEY);
  await saveArray(
    PROACTIVE_SOCIAL_DRAFTS_KEY,
    replaceById(current, value)
      .sort((left, right) => (
        numberAt(right.updatedAt) - numberAt(left.updatedAt)
      ))
      .slice(0, 12),
  );
}

async function upsertSocialCommentReply(
  value: ProactiveSocialCommentReplyRecord,
) {
  const raw = await RawAsyncStorage.getItem(
    PROACTIVE_SOCIAL_COMMENT_REPLY_STATE_KEY,
  );
  let state: UnknownRecord = {};
  if (raw) {
    try {
      state = recordOf(JSON.parse(raw) as unknown) ?? {};
    } catch {
      state = {};
    }
  }
  const repliedCommentIds = Array.isArray(state.repliedCommentIds)
    ? state.repliedCommentIds.filter(
        (item): item is string => typeof item === 'string',
      )
    : [];
  if (!repliedCommentIds.includes(value.commentId)) {
    repliedCommentIds.push(value.commentId);
  }
  await RawAsyncStorage.setItem(
    PROACTIVE_SOCIAL_COMMENT_REPLY_STATE_KEY,
    JSON.stringify({
      ...(typeof state.lastReplyAt === 'number'
        ? { lastReplyAt: state.lastReplyAt }
        : {}),
      repliedCommentIds: repliedCommentIds.slice(-80),
    }),
  );
}

async function upsertShareResponseExchange(
  value: ProactiveShareResponseExchangeRecord,
) {
  const current = await loadArray(PROACTIVE_SHARE_RESPONSE_EXCHANGES_KEY);
  await saveArray(
    PROACTIVE_SHARE_RESPONSE_EXCHANGES_KEY,
    replaceById(current, value)
      .sort((left, right) => numberAt(left.createdAt) - numberAt(right.createdAt))
      .slice(-80),
  );
}

async function upsertRecord(
  input: Parameters<ProactiveLedgerBusinessPort['upsertRecord']>[0],
) {
  assertProactiveLedgerRecord(
    input.kind,
    input.entityId,
    input.value,
  );
  switch (input.kind) {
    case 'agent-task':
      await upsertAgentTask(
        input.entityId,
        input.value as ProactiveAgentTaskRecord,
      );
      return;
    case 'active-message-delivery':
      await upsertActiveDelivery(
        input.entityId,
        input.value as ProactiveActiveDeliveryRecord,
      );
      return;
    case 'web-voyage-log':
      await upsertWebVoyageLog(
        input.value as ProactiveWebVoyageLogRecord,
      );
      return;
    case 'web-voyage-share-intent':
      await upsertWebVoyageShareIntent(
        input.value as ProactiveWebVoyageShareIntentRecord,
      );
      return;
    case 'social-action-log':
      await upsertSocialActionLog(
        input.value as ProactiveSocialActionLogRecord,
      );
      return;
    case 'social-draft':
      await upsertSocialDraft(
        input.value as ProactiveSocialDraftRecord,
      );
      return;
    case 'social-share-intent':
      // Accepted only at the historical transport boundary; never materialize a task.
      await RawAsyncStorage.removeItem(RETIRED_SOCIAL_SHARE_QUEUE_KEY);
      return;
    case 'social-comment-reply':
      await upsertSocialCommentReply(
        input.value as ProactiveSocialCommentReplyRecord,
      );
      return;
    case 'share-response-exchange':
      await upsertShareResponseExchange(
        input.value as ProactiveShareResponseExchangeRecord,
      );
  }
}

export const proactiveLedgerAsyncStorageBusinessPort:
ProactiveLedgerBusinessPort = {
  upsertRecord: (input) => enqueueProactiveLedgerApply(
    () => upsertRecord(input),
  ),
};
