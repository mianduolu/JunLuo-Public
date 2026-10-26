import RawAsyncStorage from '@react-native-async-storage/async-storage';

import {
  assertLettersLifeRecord,
  type LettersLifeDeliveryStateRecord,
  type LettersLifeLetterRecord,
  type LettersLifeRelationshipDateRecord,
  type LettersLifeSettingsRecord,
} from './syncLettersLife';
import type {
  LettersLifeBusinessPort,
} from './syncLettersLifeApply';
import {
  LETTERS_LIFE_ENTRIES_KEY,
  LETTERS_LIFE_SETTINGS_KEY,
  LETTERS_LIFE_RELATIONSHIP_DATES_KEY,
  parseLettersLifeEntriesStorage,
  parseLettersLifeRelationshipDatesStorage,
  serializeLettersLifeEntriesStorage,
  serializeLettersLifeRelationshipDatesStorage,
  serializeLettersLifeSettingsStorage,
  type LettersLifeEntryStorage,
} from './syncLettersLifeStorageDerivation';

let lettersLifeApplyQueue = Promise.resolve();

function enqueueLettersLifeApply<T>(callback: () => Promise<T>) {
  const current = lettersLifeApplyQueue
    .catch(() => undefined)
    .then(callback);
  lettersLifeApplyQueue = current.then(
    () => undefined,
    () => undefined,
  );
  return current;
}

async function loadEntries() {
  const raw = await RawAsyncStorage.getItem(
    LETTERS_LIFE_ENTRIES_KEY,
  );
  return raw ? parseLettersLifeEntriesStorage(raw) : [];
}

function sortEntries(entries: readonly LettersLifeEntryStorage[]) {
  return [...entries].sort((left, right) => {
    const leftTime = (
      left.deliveredAt
      ?? left.openedAt
      ?? left.dueAt
      ?? left.createdAt
    );
    const rightTime = (
      right.deliveredAt
      ?? right.openedAt
      ?? right.dueAt
      ?? right.createdAt
    );
    return rightTime - leftTime;
  });
}

async function saveEntries(
  entries: readonly LettersLifeEntryStorage[],
) {
  await RawAsyncStorage.setItem(
    LETTERS_LIFE_ENTRIES_KEY,
    serializeLettersLifeEntriesStorage(sortEntries(entries)),
  );
}

async function loadRelationshipDates() {
  const raw = await RawAsyncStorage.getItem(LETTERS_LIFE_RELATIONSHIP_DATES_KEY);
  return raw ? parseLettersLifeRelationshipDatesStorage(raw) : [];
}

async function saveRelationshipDates(records: readonly LettersLifeRelationshipDateRecord[]) {
  await RawAsyncStorage.setItem(
    LETTERS_LIFE_RELATIONSHIP_DATES_KEY,
    serializeLettersLifeRelationshipDatesStorage(
      [...records].sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id)),
    ),
  );
}

function defaultStatus(record: LettersLifeLetterRecord) {
  if (record.kind === 'future-you') return 'sealed' as const;
  return record.direction === 'you-to-I'
    ? 'waiting_ai' as const
    : 'waiting_user' as const;
}

function defaultStorageStatus(record: LettersLifeEntryStorage) {
  if (record.kind === 'future-self') return 'sealed' as const;
  return record.direction === 'you-to-ai'
    ? 'waiting_ai' as const
    : 'waiting_user' as const;
}

function replaceEntry(
  entries: LettersLifeEntryStorage[],
  next: LettersLifeEntryStorage,
) {
  const index = entries.findIndex((entry) => entry.id === next.id);
  if (index < 0) entries.push(next);
  else entries[index] = next;
}

function contentRecordEntry(
  record: LettersLifeLetterRecord,
  existing: LettersLifeEntryStorage | undefined,
): LettersLifeEntryStorage {
  return {
    id: record.id,
    kind: record.kind === 'future-you'
      ? 'future-self'
      : 'exchange',
    direction: record.direction === 'you-to-I'
      ? 'you-to-ai'
      : record.direction === 'I-to-you'
        ? 'ai-to-you'
        : 'ai-to-future-you',
    status: existing?.status ?? defaultStatus(record),
    title: record.title,
    content: record.content,
    createdAt: record.createdAt,
    ...(record.replyContent !== undefined
      ? { replyContent: record.replyContent }
      : {}),
    ...(record.source !== undefined
      ? {
          source: record.source === 'you'
            ? 'user'
            : record.source === 'future-you'
              ? 'future-self'
              : record.source,
        }
      : {}),
    ...(record.chatMessageIds !== undefined
      ? { chatMessageIds: record.chatMessageIds }
      : {}),
    ...(record.memoryIds !== undefined
      ? { memoryIds: record.memoryIds }
      : {}),
    ...(record.generationKey !== undefined ? { generationKey: record.generationKey } : {}),
    ...(record.sourceIds !== undefined ? { sourceIds: record.sourceIds } : {}),
    ...(record.openWhen !== undefined ? { openWhen: record.openWhen } : {}),
    ...(record.dateTicketId !== undefined ? { dateTicketId: record.dateTicketId } : {}),
    ...(existing?.dueAt !== undefined
      ? { dueAt: existing.dueAt }
      : {}),
    ...(existing?.deliveredAt !== undefined
      ? { deliveredAt: existing.deliveredAt }
      : {}),
    ...(existing?.openedAt !== undefined
      ? { openedAt: existing.openedAt }
      : {}),
    ...(existing?.completedAt !== undefined
      ? { completedAt: existing.completedAt }
      : {}),
    ...(existing?.notificationId !== undefined
      ? { notificationId: existing.notificationId }
      : {}),
    ...(existing?.failureReason !== undefined
      ? { failureReason: existing.failureReason }
      : {}),
  };
}

async function upsertLetter(
  input: Parameters<LettersLifeBusinessPort['upsertRecord']>[0],
) {
  assertLettersLifeRecord(input.kind, input.entityId, input.value);
  const record = input.value as LettersLifeLetterRecord;
  const entries = await loadEntries();
  const existing = entries.find((entry) => entry.id === input.entityId);
  const next = contentRecordEntry(record, existing);
  replaceEntry(entries, next);
  await saveEntries(entries);
  const youMessageAt = next.direction === 'you-to-ai' && !existing && next.content.trim()
    ? next.createdAt
    : next.direction === 'ai-to-you' && next.replyContent?.trim() && !existing?.replyContent?.trim()
      ? next.completedAt : undefined;
  if (youMessageAt !== undefined) {
    await (await import('../life/junluoDesireRuntime')).noteJunluoYouMessage(youMessageAt);
  }
}

async function upsertDeliveryState(
  input: Parameters<LettersLifeBusinessPort['upsertRecord']>[0],
) {
  assertLettersLifeRecord(input.kind, input.entityId, input.value);
  const record = input.value as LettersLifeDeliveryStateRecord;
  const entries = await loadEntries();
  const existing = entries.find((entry) => entry.id === input.entityId);
  if (!existing) {
    throw new Error(
      `letters.life delivery-state ${input.entityId} 缺少先行 letter。`,
    );
  }
  const next: LettersLifeEntryStorage = {
    ...existing,
    status: record.status === 'waiting_I'
      ? 'waiting_ai'
      : record.status === 'waiting_you'
        ? 'waiting_user'
        : record.status,
  };
  delete next.dueAt;
  delete next.deliveredAt;
  delete next.openedAt;
  delete next.completedAt;
  if (record.dueAt !== undefined) next.dueAt = record.dueAt;
  if (record.deliveredAt !== undefined) {
    next.deliveredAt = record.deliveredAt;
  }
  if (record.openedAt !== undefined) next.openedAt = record.openedAt;
  if (record.completedAt !== undefined) {
    next.completedAt = record.completedAt;
  }
  if (record.status !== 'failed') delete next.failureReason;
  replaceEntry(entries, next);
  await saveEntries(entries);
  if (next.direction === 'ai-to-you' && next.replyContent?.trim()
    && existing.completedAt === undefined && next.completedAt !== undefined) {
    await (await import('../life/junluoDesireRuntime')).noteJunluoYouMessage(next.completedAt);
  }
}

async function upsertSettings(
  input: Parameters<LettersLifeBusinessPort['upsertRecord']>[0],
) {
  assertLettersLifeRecord(input.kind, input.entityId, input.value);
  const record = input.value as LettersLifeSettingsRecord;
  await RawAsyncStorage.setItem(
    LETTERS_LIFE_SETTINGS_KEY,
    serializeLettersLifeSettingsStorage({
      defaultReplyDelayHours: record.defaultReplyDelayHours,
      ...(record.lastProactiveRequestAt !== undefined ? { lastProactiveRequestAt: record.lastProactiveRequestAt } : {}),
      ...(record.lastProactiveSavedAt !== undefined ? { lastProactiveSavedAt: record.lastProactiveSavedAt } : {}),
      ...(record.offeredDateTicketIds !== undefined ? { offeredDateTicketIds: record.offeredDateTicketIds } : {}),
      ...(record.settledSourceIds !== undefined ? { settledSourceIds: record.settledSourceIds } : {}),
      ...(record.recentGenerationKeys !== undefined ? { recentGenerationKeys: record.recentGenerationKeys } : {}),
    }),
  );
}

async function upsertRelationshipDate(
  input: Parameters<LettersLifeBusinessPort['upsertRecord']>[0],
) {
  assertLettersLifeRecord(input.kind, input.entityId, input.value);
  const record = input.value as LettersLifeRelationshipDateRecord;
  const records = await loadRelationshipDates();
  await saveRelationshipDates([record, ...records.filter((item) => item.id !== record.id)]);
}

async function upsertRecord(
  input: Parameters<LettersLifeBusinessPort['upsertRecord']>[0],
) {
  if (input.entityType === 'letter' && input.kind === 'letter') {
    await upsertLetter(input);
    return;
  }
  if (
    input.entityType === 'delivery-state'
    && input.kind === 'delivery-state'
  ) {
    await upsertDeliveryState(input);
    return;
  }
  if (
    input.entityType === 'letter-settings'
    && input.kind === 'letter-settings'
  ) {
    await upsertSettings(input);
    return;
  }
  if (
    input.entityType === 'relationship-date'
    && input.kind === 'relationship-date'
  ) {
    await upsertRelationshipDate(input);
    return;
  }
  throw new Error('letters.life apply entity/kind 不匹配。');
}

async function tombstone(
  input: Parameters<LettersLifeBusinessPort['tombstone']>[0],
) {
  if (input.entityType === 'letter-settings') {
    await RawAsyncStorage.removeItem(LETTERS_LIFE_SETTINGS_KEY);
    return;
  }
  if (input.entityType === 'relationship-date') {
    const records = await loadRelationshipDates();
    const next = records.filter((record) => record.id !== input.entityId);
    if (next.length !== records.length) await saveRelationshipDates(next);
    return;
  }
  const entries = await loadEntries();
  if (input.entityType === 'letter') {
    const next = entries.filter(
      (entry) => entry.id !== input.entityId,
    );
    if (next.length !== entries.length) await saveEntries(next);
    return;
  }
  const existing = entries.find(
    (entry) => entry.id === input.entityId,
  );
  if (!existing) return;
  const next: LettersLifeEntryStorage = {
    ...existing,
    status: defaultStorageStatus(existing),
  };
  delete next.dueAt;
  delete next.deliveredAt;
  delete next.openedAt;
  delete next.completedAt;
  delete next.failureReason;
  replaceEntry(entries, next);
  await saveEntries(entries);
}

export const lettersLifeAsyncStorageBusinessPort:
LettersLifeBusinessPort = {
  upsertRecord: (input) => enqueueLettersLifeApply(
    () => upsertRecord(input),
  ),
  tombstone: (input) => enqueueLettersLifeApply(
    () => tombstone(input),
  ),
};
