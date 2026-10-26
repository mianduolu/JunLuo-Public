import type { TheaterDraftStorage } from './theaterDraftSession';
import type { TheaterBinding } from './theaterGenerationStore';
import { THEATER_LOCAL_STORAGE_PREFIX } from './theaterLocalState';

export type TheaterReadingMark = { offset: number; positionId: string | null; unread: string[]; width?: number };
type State = { ready: boolean; selectedByStory: Record<string, string>; recentByStory: Record<string, string[]>;
  branches: Record<string, TheaterReadingMark>; saveError: boolean };
const key = (b: TheaterBinding) => JSON.stringify([b.storyId, b.branchId]);
export const THEATER_READING_KEY = `${THEATER_LOCAL_STORAGE_PREFIX}reading`;
const empty = (): State => ({ ready: false, selectedByStory: {}, recentByStory: {}, branches: {}, saveError: false });

// Device-only bookmarks and unread receipts. No story text, model call, or story write.
export class TheaterReadingSession {
  private state = empty();
  private listeners = new Set<() => void>();
  private revision = 0;
  private saved = 0;
  private writing: Promise<void> | null = null;
  readonly ready: Promise<void>;
  constructor(private storage: TheaterDraftStorage) {
    this.ready = storage.getItem(THEATER_READING_KEY).then(raw => {
      if (raw) {
        const value = JSON.parse(raw) as State;
        if (value.branches && value.selectedByStory && value.recentByStory) {
          const branches: State['branches'] = {};
          for (const [id, mark] of Object.entries(value.branches)) {
            const binding = JSON.parse(id);
            if (!Array.isArray(binding) || binding.length !== 2 || binding.some(v => typeof v !== 'string')) continue;
            if (Array.isArray(mark.unread) && Number.isFinite(mark.offset)) branches[id] = {
              offset: Math.max(0, mark.offset), positionId: typeof mark.positionId === 'string' ? mark.positionId : null,
              unread: mark.unread.filter(v => typeof v === 'string'),
              width: Number.isFinite(mark.width) ? mark.width : undefined,
            };
          }
          this.state = { ...this.state, branches, selectedByStory: value.selectedByStory, recentByStory: value.recentByStory };
        }
      }
    }).catch(() => { this.state = { ...this.state, saveError: true }; })
      .then(() => { this.update({ ready: true }, false); });
  }
  getSnapshot = () => this.state;
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private update(patch: Partial<State>, persist = true) {
    this.state = { ...this.state, ...patch }; this.listeners.forEach(fn => fn());
    if (persist) { this.revision++; void this.flush(); }
  }
  mark(binding: TheaterBinding): TheaterReadingMark {
    return this.state.branches[key(binding)] ?? { offset: 0, positionId: null, unread: [] };
  }
  private put(binding: TheaterBinding, mark: TheaterReadingMark) {
    this.update({ branches: { ...this.state.branches, [key(binding)]: mark } });
  }
  select(binding: TheaterBinding) {
    if (!this.state.ready) { void this.ready.then(() => this.select(binding)); return; }
    if (this.state.selectedByStory[binding.storyId] === binding.branchId) return;
    this.update({ selectedByStory: { ...this.state.selectedByStory, [binding.storyId]: binding.branchId },
      recentByStory: { ...this.state.recentByStory, [binding.storyId]: [binding.branchId,
        ...(this.state.recentByStory[binding.storyId] ?? []).filter(id => id !== binding.branchId)] } });
  }
  bookmark(binding: TheaterBinding, offset: number, positionId: string | null, width?: number) {
    if (!this.state.ready || !Number.isFinite(offset)) return;
    const mark = this.mark(binding);
    if (mark.offset !== offset || mark.positionId !== positionId || mark.width !== width)
      this.put(binding, { ...mark, offset: Math.max(0, offset), positionId, width });
  }
  replySaved(binding: TheaterBinding, versionId: string) {
    if (!this.state.ready) { void this.ready.then(() => this.replySaved(binding, versionId)); return; }
    const mark = this.mark(binding);
    if (!mark.unread.includes(versionId)) this.put(binding, { ...mark, unread: [...mark.unread, versionId] });
  }
  seen(binding: TheaterBinding, visibleVersionIds: string[]) {
    if (!this.state.ready) return;
    const mark = this.mark(binding), unread = mark.unread.filter(id => !visibleVersionIds.includes(id));
    if (unread.length !== mark.unread.length) this.put(binding, { ...mark, unread });
  }
  reconcile(binding: TheaterBinding, adoptedIds: string[], examinedIds = this.mark(binding).unread) {
    const mark = this.mark(binding), unread = mark.unread.filter(id => !examinedIds.includes(id) || adoptedIds.includes(id));
    if (unread.length !== mark.unread.length) this.put(binding, { ...mark, unread });
  }
  unreadStoryIds() {
    return [...new Set(Object.entries(this.state.branches).filter(([, m]) => m.unread.length)
      .map(([id]) => (JSON.parse(id) as string[])[0]))];
  }
  async removeBranches(storyId: string, ids: string[]) {
    await this.ready;
    const branches = { ...this.state.branches }, selectedByStory = { ...this.state.selectedByStory };
    for (const branchId of ids) delete branches[key({ storyId, branchId })];
    if (ids.includes(selectedByStory[storyId])) delete selectedByStory[storyId];
    this.update({ branches, selectedByStory, recentByStory: { ...this.state.recentByStory,
      [storyId]: (this.state.recentByStory[storyId] ?? []).filter(id => !ids.includes(id)) } });
    await this.flush();
  }
  async reset() { await this.ready; this.update({ ...empty(), ready: true }); await this.flush(); }
  async flush(): Promise<void> {
    await this.ready;
    if (this.writing) return this.writing;
    if (this.saved >= this.revision) return;
    this.writing = (async () => {
      try {
        while (this.saved < this.revision) {
          const revision = this.revision;
          await this.storage.setItem(THEATER_READING_KEY, JSON.stringify(this.state));
          this.saved = revision;
        }
        if (this.state.saveError) this.update({ saveError: false }, false);
      } catch { this.update({ saveError: true }, false); }
      finally { this.writing = null; }
    })();
    return this.writing;
  }
  dispose() { void this.flush(); this.listeners.clear(); }
}

export function theaterDateTime(timestamp: number) {
  const d = new Date(timestamp), pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function theaterDay(timestamp: number) {
  const d = new Date(timestamp); return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}
