import RawAsyncStorage from '@react-native-async-storage/async-storage';

import {
  captureBackupRestoreDataEpoch,
  runBackupRestoreDataEpochCommit,
} from '../backup/backupRestoreCoordinator';
import { chatRelationshipStorageBridge } from '../sync/syncChatRelationshipStorageBridge';
import {
  findChatSessionContainingMessage,
  loadChatSessionMessageOrder,
  loadChatSessionMessagePage,
  loadChatSessionMessages,
} from './chatStorage';
import {
  HEART_CORPUS_INDEX_KEY,
  LIKED_HEART_ROUND_IDS_KEY,
  createHeartCorpusEntry,
  findHeartReplyRound,
  parseHeartCorpusIndex,
  parseLikedHeartRoundIds,
  sortHeartCorpusForDisplay,
  type HeartCorpusEntryV1,
  type HeartCorpusIndexV1,
  type HeartReplyRound,
  type ResolvedHeartCorpusRound,
} from './heartCorpus';

let heartMutationQueue: Promise<unknown> = Promise.resolve();

function enqueueHeartMutation<T>(task: () => Promise<T>) {
  const result = heartMutationQueue.catch(() => undefined).then(task);
  heartMutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function retryLocalWriteOnce<T>(write: () => Promise<T>) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await write();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function loadIndex() {
  return parseHeartCorpusIndex(await RawAsyncStorage.getItem(HEART_CORPUS_INDEX_KEY));
}

async function saveIndex(index: HeartCorpusIndexV1) {
  await retryLocalWriteOnce(() => RawAsyncStorage.setItem(
    HEART_CORPUS_INDEX_KEY,
    JSON.stringify(index),
  ));
}

async function saveActiveIds(ids: readonly string[]) {
  await retryLocalWriteOnce(() => chatRelationshipStorageBridge.setItem(
    LIKED_HEART_ROUND_IDS_KEY,
    JSON.stringify([...new Set(ids)]),
  ));
}

function replaceEntry(
  index: HeartCorpusIndexV1,
  entry: HeartCorpusEntryV1,
  updatedAt: number,
): HeartCorpusIndexV1 {
  return {
    schemaVersion: 1,
    entries: [
      ...index.entries.filter((item) => item.replyRoundId !== entry.replyRoundId),
      entry,
    ],
    updatedAt,
  };
}

export async function loadActiveHeartRoundIds() {
  return parseLikedHeartRoundIds(
    await chatRelationshipStorageBridge.getItem(LIKED_HEART_ROUND_IDS_KEY),
  );
}

export function toggleHeartReplyRound(input: {
  now?: number;
  round: HeartReplyRound;
  sessionId: string | null;
}) {
  return enqueueHeartMutation(async () => {
    const now = input.now ?? Date.now();
    const dataEpoch = captureBackupRestoreDataEpoch();
    const committed = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
      const [activeIds, storedIndex] = await Promise.all([
        loadActiveHeartRoundIds(),
        loadIndex(),
      ]);
      const existing = storedIndex.entries.find(
        (entry) => entry.replyRoundId === input.round.replyRoundId,
      ) ?? null;

      if (activeIds.includes(input.round.replyRoundId)) {
        const nextActiveIds = activeIds.filter((id) => id !== input.round.replyRoundId);
        await saveActiveIds(nextActiveIds);
        return { activeIds: nextActiveIds, liked: false };
      }

      const entry = existing
        ? {
            ...existing,
            lastHeartedAt: now,
            sessionId: input.sessionId ?? existing.sessionId,
            youMessageIds: input.round.youMessages.map((message) => message.id),
            iMessageIds: input.round.iMessages.map((message) => message.id),
          }
        : createHeartCorpusEntry({ legacy: false, now, round: input.round, sessionId: input.sessionId });
      const index = replaceEntry(storedIndex, entry, now);
      await saveIndex(index);
      const nextActiveIds = [...activeIds, input.round.replyRoundId];
      await saveActiveIds(nextActiveIds);
      return { activeIds: nextActiveIds, liked: true };
    });
    if (!committed.committed) throw new Error('junluo_heart_data_epoch_changed');
    return committed.value;
  });
}

export function removeHeartCorpusRound(replyRoundId: string) {
  return enqueueHeartMutation(async () => {
    const dataEpoch = captureBackupRestoreDataEpoch();
    const committed = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
      const activeIds = await loadActiveHeartRoundIds();
      const next = activeIds.filter((id) => id !== replyRoundId);
      if (next.length !== activeIds.length) await saveActiveIds(next);
      return next;
    });
    if (!committed.committed) throw new Error('junluo_heart_remove_data_epoch_changed');
    return committed.value;
  });
}

async function pruneActiveIds(predicate: (entry: HeartCorpusEntryV1) => boolean) {
  const dataEpoch = captureBackupRestoreDataEpoch();
  const committed = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
    const [activeIds, index] = await Promise.all([loadActiveHeartRoundIds(), loadIndex()]);
    const removedIds = new Set(index.entries.filter(predicate).map((entry) => entry.replyRoundId));
    if (!removedIds.size) return;
    const next = activeIds.filter((id) => !removedIds.has(id));
    if (next.length !== activeIds.length) await saveActiveIds(next);
  });
  if (!committed.committed) throw new Error('junluo_heart_prune_data_epoch_changed');
}

export function removeHeartCorpusEntriesForSession(sessionId: string) {
  return enqueueHeartMutation(() => pruneActiveIds((entry) => entry.sessionId === sessionId));
}

export function removeHeartCorpusEntriesForMessageIds(messageIds: readonly string[]) {
  const removed = new Set(messageIds);
  return enqueueHeartMutation(() => pruneActiveIds((entry) => (
    entry.youMessageIds.some((id) => removed.has(id))
    || entry.iMessageIds.some((id) => removed.has(id))
  )));
}

async function resolveEntry(
  entry: HeartCorpusEntryV1,
): Promise<ResolvedHeartCorpusRound | null> {
  const sessionId = entry.sessionId
    ?? await findChatSessionContainingMessage(entry.replyRoundId);
  if (!sessionId) return null;
  const order = await loadChatSessionMessageOrder(sessionId);
  const sourceIds = [...entry.youMessageIds, ...entry.iMessageIds];
  const start = order.findIndex((message) => message.id === sourceIds[0]);
  if (start < 0 || sourceIds.some((id, offset) => order[start + offset]?.id !== id)) return null;
  // Include the two boundary messages so an edited round cannot silently lose
  // an adjacent you/I bubble. Only the referenced round's page is read.
  const pageStart = Math.max(0, start - 1);
  const pageEnd = Math.min(order.length, start + sourceIds.length + 1);
  const page = await loadChatSessionMessagePage(sessionId, {
    beforeIndex: pageEnd,
    limit: pageEnd - pageStart,
  });
  const round = findHeartReplyRound(page.messages, entry.replyRoundId);
  if (!round) return null;
  const currentYouIds = round.youMessages.map((message) => message.id);
  const currentIIds = round.iMessages.map((message) => message.id);
  if (
    currentYouIds.join('\n') !== entry.youMessageIds.join('\n')
    || currentIIds.join('\n') !== entry.iMessageIds.join('\n')
  ) return null;
  return { ...round, entry, sessionId };
}

/** Factual metadata only: no legacy timestamp invention, mutation, or scoring. */
export async function loadHeartFeedbackCandidates(options: {
  sessionId?: string;
  replyRoundIds?: readonly string[];
} = {}) {
  await heartMutationQueue;
  const [activeIds, index] = await Promise.all([loadActiveHeartRoundIds(), loadIndex()]);
  const active = new Set(activeIds);
  const requested = options.replyRoundIds ? new Set(options.replyRoundIds) : null;
  return index.entries.filter((entry) => (
    active.has(entry.replyRoundId)
    && entry.firstHeartedAt !== null
    && (options.sessionId === undefined || entry.sessionId === options.sessionId)
    && (!requested || requested.has(entry.replyRoundId))
  )).sort((left, right) => (
    left.firstHeartedAt! - right.firstHeartedAt!
    || left.replyRoundId.localeCompare(right.replyRoundId)
  ));
}

/** Resolve one currently active heart against its current original messages. */
export async function loadHeartFeedbackRound(replyRoundId: string) {
  const [entry] = await loadHeartFeedbackCandidates({ replyRoundIds: [replyRoundId] });
  return entry ? resolveEntry(entry) : null;
}

export function loadResolvedHeartCorpusRounds() {
  return enqueueHeartMutation(async () => {
    const now = Date.now();
    const [activeIds, storedIndex] = await Promise.all([loadActiveHeartRoundIds(), loadIndex()]);
    let index = storedIndex;
    const byId = new Map(index.entries.map((entry) => [entry.replyRoundId, entry]));

    for (const replyRoundId of activeIds) {
      if (byId.has(replyRoundId)) continue;
      const sessionId = await findChatSessionContainingMessage(replyRoundId);
      if (!sessionId) continue;
      const round = findHeartReplyRound(await loadChatSessionMessages(sessionId), replyRoundId);
      if (!round) continue;
      const entry = createHeartCorpusEntry({ legacy: true, now, round, sessionId });
      byId.set(replyRoundId, entry);
      index = replaceEntry(index, entry, now);
    }

    if (index !== storedIndex) await saveIndex(index);

    const resolved = (await Promise.all(activeIds.map(async (replyRoundId) => {
      const entry = byId.get(replyRoundId);
      return entry ? resolveEntry(entry) : null;
    }))).filter((round): round is ResolvedHeartCorpusRound => !!round);
    const validIds = new Set(resolved.map((round) => round.replyRoundId));
    const nextActiveIds = activeIds.filter((id) => validIds.has(id));
    if (nextActiveIds.length !== activeIds.length) await saveActiveIds(nextActiveIds);
    return sortHeartCorpusForDisplay(resolved.filter((round) => round.exportable));
  });
}
