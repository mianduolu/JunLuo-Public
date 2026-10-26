import {
  readingWorkspaceStorageBridge as AsyncStorage,
} from '../sync/syncReadingWorkspaceStorageBridge';

import { getReadingResultActionsKey } from './readingStore';
import type { ReadingResultActionMeta } from './readingTypes';

export type ReadingResultActionMap = Record<string, ReadingResultActionMeta>;

function clampText(value: unknown, maxLength: number) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function normalizeAction(value: unknown): ReadingResultActionMeta | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<ReadingResultActionMeta>;
  const resultId = clampText(item.resultId, 180);
  if (!resultId) return null;
  return {
    resultId,
    notebookEntryId: clampText(item.notebookEntryId, 160) || undefined,
    notebookSavedAt: typeof item.notebookSavedAt === 'number' ? item.notebookSavedAt : undefined,
    memoryId: clampText(item.memoryId, 160) || undefined,
    memorySavedAt: typeof item.memorySavedAt === 'number' ? item.memorySavedAt : undefined,
    updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : Date.now(),
  };
}

function normalizeActionMap(value: unknown): ReadingResultActionMap {
  const rawItems = value && typeof value === 'object' ? Object.values(value as Record<string, unknown>) : [];
  return rawItems.reduce<ReadingResultActionMap>((map, raw) => {
    const action = normalizeAction(raw);
    if (action) map[action.resultId] = action;
    return map;
  }, {});
}

export async function loadReadingResultActions(bookId: string): Promise<ReadingResultActionMap> {
  const raw = await AsyncStorage.getItem(getReadingResultActionsKey(bookId));
  if (!raw) return {};
  try {
    return normalizeActionMap(JSON.parse(raw) as unknown);
  } catch {
    return {};
  }
}

export async function saveReadingResultActions(bookId: string, actions: ReadingResultActionMap) {
  const normalized = normalizeActionMap(actions);
  await AsyncStorage.setItem(getReadingResultActionsKey(bookId), JSON.stringify(normalized));
  return normalized;
}

export async function markReadingResultNotebookSaved(bookId: string, resultId: string, notebookEntryId: string) {
  const actions = await loadReadingResultActions(bookId);
  const now = Date.now();
  return saveReadingResultActions(bookId, {
    ...actions,
    [resultId]: {
      ...actions[resultId],
      resultId,
      notebookEntryId,
      notebookSavedAt: actions[resultId]?.notebookSavedAt ?? now,
      updatedAt: now,
    },
  });
}

export async function markReadingResultMemorySaved(bookId: string, resultId: string, memoryId: string) {
  const actions = await loadReadingResultActions(bookId);
  const now = Date.now();
  return saveReadingResultActions(bookId, {
    ...actions,
    [resultId]: {
      ...actions[resultId],
      resultId,
      memoryId,
      memorySavedAt: actions[resultId]?.memorySavedAt ?? now,
      updatedAt: now,
    },
  });
}
