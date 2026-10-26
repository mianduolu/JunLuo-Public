import type { FocusTimeSpan } from './focusTiming';

export const focusCategories = [
  { id: 'required-study', label: '不得不学', color: '#c23030' },
  { id: 'curious-study', label: '想学这个', color: '#80c0ff' },
  { id: 'work', label: '工作', color: '#347bb1' },
  { id: 'create', label: '创作', color: '#ff9780' },
  { id: 'exercise', label: '运动', color: '#f0b568' },
  { id: 'meal', label: '吃饭', color: '#b5d45c' },
  { id: 'home', label: '家务', color: '#b78b73' },
  { id: 'entertainment', label: '娱乐', color: '#b095d3' },
  { id: 'on-the-way', label: '在路上', color: '#e7ddc7' },
  { id: 'rest', label: '休息', color: '#1d1d4c' },
  { id: 'custom', label: '自定义', color: '#efbfd6' },
] as const;
export const focusTagColors = ['#a3ccec', '#e8acc9', '#c5b0e1', '#a7d3bd', '#efd99b', '#efb6a6',
  '#d99b9b', '#e4bd8e', '#c8d394', '#91c9ce', '#98a8d0', '#bfa99a'] as const;
export const focusNoTagColor = '#cdd3da';
export type FocusTagSnapshot = { id: string; label: string; color: string };
export type FocusTag = FocusTagSnapshot & { categoryId: string };
export type FocusReviewEvidence = {
  version: 1; categoryId: string | null; tag?: FocusTagSnapshot; spans: FocusTimeSpan[];
};
export type FocusReviewScene = {
  id: string; userActivity: string; startedAt: number; endedAt: number; durationSeconds: number;
  review?: FocusReviewEvidence;
};
export type FocusShare = { id: string; label: string; color: string; milliseconds: number; percent: number };

export function focusCategoryFromActivity(activity: string) {
  const text = activity.trim();
  return focusCategories.find(category => text === category.label
    || text.startsWith(`${category.label}：`) || text.startsWith(`${category.label}:`))?.id ?? null;
}

/** Undo only the label actually composed from this scene's saved tag snapshot. */
export function focusNoteWithoutTag(note: string, tag?: FocusTagSnapshot) {
  if (!tag) return note;
  if (note === tag.label) return '';
  const prefix = `${tag.label} · `;
  return note.startsWith(prefix) ? note.slice(prefix.length) : note;
}

export function parseFocusReview(raw: string | null | undefined, startedAt: number, endedAt: number): FocusReviewEvidence | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw);
    if (!value || value.version !== 1 || !Array.isArray(value.spans)
      || value.categoryId !== null && !focusCategories.some(category => category.id === value.categoryId)) return undefined;
    let previousEnd = startedAt;
    for (const span of value.spans) {
      if (!Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end)
        || span.start < previousEnd || span.end <= span.start || span.end > endedAt) return undefined;
      previousEnd = span.end;
    }
    if (value.tag && (typeof value.tag.id !== 'string' || !value.tag.id || value.tag.id.length > 240
      || typeof value.tag.label !== 'string' || !value.tag.label.trim() || value.tag.label.length > 32
      || !focusTagColors.includes(value.tag.color))) return undefined;
    return { version: 1, categoryId: value.categoryId, spans: value.spans,
      ...(value.tag ? { tag: { id: value.tag.id, label: value.tag.label, color: value.tag.color } } : {}) };
  } catch { return undefined; }
}

export function focusDateKey(value: Date | number) {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function focusDayStart(value: number) {
  const date = new Date(value); return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}
export function shiftFocusDay(value: number, amount: number) {
  const date = new Date(value); return new Date(date.getFullYear(), date.getMonth(), date.getDate() + amount).getTime();
}
export function focusWeekStart(value: number) {
  const date = new Date(value); return shiftFocusDay(value, -((date.getDay() + 6) % 7));
}
export function focusMonthStart(value: number) {
  const date = new Date(value); return new Date(date.getFullYear(), date.getMonth(), 1).getTime();
}
export function shiftFocusMonth(value: number, amount: number) {
  const date = new Date(value); return new Date(date.getFullYear(), date.getMonth() + amount, 1).getTime();
}
export function focusYearStart(value: number) {
  return new Date(new Date(value).getFullYear(), 0, 1).getTime();
}
export function shiftFocusYear(value: number, amount: number) {
  return new Date(new Date(value).getFullYear() + amount, 0, 1).getTime();
}
export function focusMonthDays(value: number) {
  const first = focusMonthStart(value), date = new Date(first);
  const length = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  return Array.from({ length }, (_, index) => shiftFocusDay(first, index));
}
export function focusRangeMilliseconds(scene: FocusReviewScene, from: number, to: number) {
  return scene.review?.spans.reduce((sum, span) => sum + Math.max(0, Math.min(span.end, to) - Math.max(span.start, from)), 0) ?? 0;
}
export function focusSceneMilliseconds(scene: FocusReviewScene) {
  return scene.review?.spans.reduce((sum, span) => sum + span.end - span.start, 0);
}
export function focusSceneCategory(scene: FocusReviewScene) {
  const id = scene.review?.categoryId;
  return focusCategories.find(category => category.id === id)
    ?? { id: 'unclassified', label: '未分类', color: '#d6dadf' };
}
export function formatFocusTime(milliseconds: number) {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}

/** Largest remainder rounding keeps displayed percentages at exactly 100.0%. */
export function focusShares(scenes: readonly FocusReviewScene[], from: number, to: number, categoryId?: string): FocusShare[] {
  const entries = new Map<string, FocusShare>();
  for (const scene of scenes) {
    const milliseconds = focusRangeMilliseconds(scene, from, to);
    if (!milliseconds) continue;
    const category = focusSceneCategory(scene);
    if (categoryId && category.id !== categoryId) continue;
    const group = categoryId ? scene.review?.tag ?? { id: 'no-tag', label: '未设标签', color: focusNoTagColor } : category;
    const existing = entries.get(group.id);
    if (existing) existing.milliseconds += milliseconds;
    else entries.set(group.id, { ...group, milliseconds, percent: 0 });
  }
  const result = [...entries.values()];
  if (!categoryId) result.sort((a, b) => {
    const rank = (id: string) => focusCategories.findIndex(category => category.id === id);
    return (rank(a.id) < 0 ? 11 : rank(a.id)) - (rank(b.id) < 0 ? 11 : rank(b.id));
  });
  const total = result.reduce((sum, entry) => sum + entry.milliseconds, 0);
  const units = result.map(entry => entry.milliseconds / total * 1000);
  const rounded = units.map(Math.floor);
  const missing = 1000 - rounded.reduce((sum, unit) => sum + unit, 0);
  const ranks = units.map((unit, index) => ({ index, remainder: unit - rounded[index] }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (let i = 0; i < missing && i < ranks.length; i += 1) rounded[ranks[i].index] += 1;
  return result.map((entry, index) => ({ ...entry, percent: rounded[index] / 10 }));
}

export function nextFocusTagColor(tags: readonly FocusTag[], categoryId: string) {
  const counts = focusTagColors.map(color => tags.filter(tag => tag.categoryId === categoryId && tag.color === color).length);
  return focusTagColors[counts.indexOf(Math.min(...counts))];
}
