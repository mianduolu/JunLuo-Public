import type { TheaterHistoryEntry, TheaterHistoryRepository } from './theaterHistoryStore';

export type TheaterHistoryFilter = 'all' | 'drafts' | 'unread';
export type TheaterHistoryLocal = {
  selectedByStory: Record<string, string>;
  unreadStoryIds: string[];
  generatingStoryId: string | null;
};
type PinTarget = { storyId: string; pinned: boolean };
type Snapshot = {
  entries: TheaterHistoryEntry[]; query: string; filter: TheaterHistoryFilter;
  loading: boolean; loadError: boolean; pinning: PinTarget | null; pinError: PinTarget | null;
  local: TheaterHistoryLocal;
};

export function theaterHistoryRows(state: Snapshot) {
  const query = state.query.trim().toLocaleLowerCase();
  return state.entries.filter(({ story }) => (
    state.filter === 'all' || (state.filter === 'drafts' ? story.isDraft : state.local.unreadStoryIds.includes(story.id))
  ) && (!query || story.title.toLocaleLowerCase().includes(query) || story.settings.world.toLocaleLowerCase().includes(query)))
    .sort((a, b) => Number(!!b.story.isPinned) - Number(!!a.story.isPinned)
      || b.story.updatedAt - a.story.updatedAt || a.story.id.localeCompare(b.story.id));
}

export function theaterHistoryCard(entry: TheaterHistoryEntry, local: TheaterHistoryLocal) {
  const selected = entry.branches.find((branch) => branch.id === local.selectedByStory[entry.story.id]) ?? entry.branches[0];
  const status = entry.story.isDraft ? '草稿' : entry.hasDialogue ? '已开演' : '未开演';
  return {
    detail: [status, selected?.name, entry.branches.length ? `共 ${entry.branches.length} 条走向` : null].filter(Boolean).join(' · '),
    unread: local.unreadStoryIds.includes(entry.story.id), generating: local.generatingStoryId === entry.story.id,
  };
}

export function theaterHistoryTime(timestamp: number) {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// Query/filter are view state; unread and branch selection are supplied by the
// existing device-local reading owner, never saved as story content here.
export class TheaterHistorySession {
  private state: Snapshot = { entries: [], query: '', filter: 'all', loading: false, loadError: false,
    pinning: null, pinError: null, local: { selectedByStory: {}, unreadStoryIds: [], generatingStoryId: null } };
  private listeners = new Set<() => void>();
  private loadSequence = 0;
  private revision = 0;
  constructor(private repository: TheaterHistoryRepository) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<Snapshot>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  setQuery(query: string) { this.update({ query }); }
  setFilter(filter: TheaterHistoryFilter) { this.update({ filter }); }
  setLocal(local: TheaterHistoryLocal) { this.update({ local }); }
  invalidate() {
    ++this.revision; ++this.loadSequence;
    this.update({ entries: [], loading: false, loadError: false, pinning: null, pinError: null });
  }
  async refresh() {
    const sequence = ++this.loadSequence;
    this.update({ loading: true, loadError: false });
    try {
      const entries = await this.repository.load();
      if (sequence === this.loadSequence) this.update({ entries, loading: false });
    } catch {
      if (sequence === this.loadSequence) this.update({ loading: false, loadError: true });
    }
  }
  async setPinned(storyId: string, pinned: boolean) {
    if (this.state.pinning || !this.state.entries.some((entry) => entry.story.id === storyId)) return;
    const revision = this.revision;
    const target = { storyId, pinned };
    ++this.loadSequence;
    this.update({ pinning: target, pinError: null, loading: false });
    try {
      const story = await this.repository.setPinned(storyId, pinned);
      if (revision !== this.revision) return;
      ++this.loadSequence;
      this.update({ entries: this.state.entries.map((entry) => entry.story.id === storyId ? { ...entry, story } : entry),
        pinning: null, pinError: null });
      await this.refresh();
    } catch {
      if (revision === this.revision) this.update({ pinning: null, pinError: target });
    }
  }
  retryPin() {
    const target = this.state.pinError;
    return target ? this.setPinned(target.storyId, target.pinned) : Promise.resolve();
  }
}
