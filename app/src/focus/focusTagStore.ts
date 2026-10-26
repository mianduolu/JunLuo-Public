import { focusSemanticStorageBridge as AsyncStorage, runFocusSemanticStorageMutation } from '../sync/syncFocusSemanticStorageBridge';
import { runBackupRestoreDataEpochCommit, captureBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { focusCategories, focusTagColors, nextFocusTagColor, type FocusTag } from './focusReviewData';

export const FOCUS_TAGS_KEY = 'junluo.focus.tags.v1';
let tail: Promise<unknown> = Promise.resolve();

export async function loadFocusTags(storage: Pick<typeof AsyncStorage, 'getItem'> = AsyncStorage): Promise<FocusTag[]> {
  const raw = await storage.getItem(FOCUS_TAGS_KEY);
  if (!raw) return [];
  const value = JSON.parse(raw);
  if (!Array.isArray(value)) throw new Error('FOCUS_TAGS_INVALID');
  const ids = new Set<string>();
  return value.filter(tag => {
    const valid = tag && typeof tag.id === 'string' && tag.id.length <= 240 && tag.id && !ids.has(tag.id)
      && typeof tag.label === 'string' && tag.label.trim() && tag.label.length <= 32
      && focusCategories.some(category => category.id === tag.categoryId) && focusTagColors.includes(tag.color);
    if (valid) ids.add(tag.id); return valid;
  });
}

export function changeFocusTag(categoryId: string, input: { label: string } | { deleteId: string },
  epoch = captureBackupRestoreDataEpoch()) {
  const work = async () => {
    const committed = await runBackupRestoreDataEpochCommit(epoch, () => runFocusSemanticStorageMutation(async storage => {
      const current = await loadFocusTags(storage);
      if ('deleteId' in input) {
        const tags = current.filter(tag => tag.id !== input.deleteId || tag.categoryId !== categoryId);
        await storage.setItem(FOCUS_TAGS_KEY, JSON.stringify(tags)); return { tags, selected: null };
      }
      const label = input.label.trim().slice(0, 32);
      if (!label || !focusCategories.some(category => category.id === categoryId)) throw new Error('FOCUS_TAG_NAME_INVALID');
      const existing = current.find(tag => tag.categoryId === categoryId && tag.label === label);
      if (existing) return { tags: current, selected: existing };
      const selected: FocusTag = { id: `focus-tag-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        categoryId, label, color: nextFocusTagColor(current, categoryId) };
      const tags = [...current, selected];
      await storage.setItem(FOCUS_TAGS_KEY, JSON.stringify(tags)); return { tags, selected };
    }));
    if (!committed.committed) throw new Error('FOCUS_TAGS_DATA_CHANGED');
    return committed.value;
  };
  const result = tail.then(work, work); tail = result.catch(() => undefined); return result;
}
