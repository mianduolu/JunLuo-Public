import type { TheaterStoryDetail } from './theaterBranchStore';
import type { TheaterBinding } from './theaterGenerationStore';
import { searchTheaterStory, theaterSearchEntries, theaterSearchNeedsPreview,
  type TheaterSearchResult, type TheaterSearchScope } from './theaterSearch';

export type TheaterSearchState = {
  visible: boolean; binding: TheaterBinding | null; query: string; scope: TheaterSearchScope;
  loading: boolean; searched: boolean; error: 'read' | 'missing' | null;
  results: TheaterSearchResult[]; preview: TheaterSearchResult | null;
};

export class TheaterSearchSession {
  private state: TheaterSearchState = { visible: false, binding: null, query: '', scope: 'branch',
    loading: false, searched: false, error: null, results: [], preview: null };
  private sequence = 0;
  private listeners = new Set<() => void>();
  constructor(private ports: { load: (storyId: string) => Promise<TheaterStoryDetail | null> }) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<TheaterSearchState>) {
    this.state = { ...this.state, ...patch }; this.listeners.forEach(listener => listener());
  }
  open(binding: TheaterBinding) {
    this.sequence++;
    this.update({ visible: true, binding, query: '', scope: 'branch', loading: false,
      searched: false, error: null, results: [], preview: null });
  }
  close() { this.sequence++; this.update({ visible: false, loading: false, preview: null, error: null }); }
  setQuery(query: string) { this.update({ query }); return this.search(); }
  setScope(scope: TheaterSearchScope) { this.update({ scope }); return this.search(); }
  async search() {
    const sequence = ++this.sequence;
    const { visible, binding, query, scope } = this.state;
    if (!visible || !binding || !query.trim()) {
      this.update({ loading: false, searched: false, error: null, results: [], preview: null }); return;
    }
    this.update({ loading: true, error: null, preview: null, searched: false });
    try {
      const detail = await this.ports.load(binding.storyId);
      if (sequence !== this.sequence) return;
      this.update({ loading: false, searched: true, results: detail ? searchTheaterStory(detail, binding, scope, query) : [] });
    } catch {
      if (sequence === this.sequence) this.update({ loading: false, searched: false, error: 'read' });
    }
  }
  retry() { return this.search(); }
  returnToResults() { return this.search(); }
  async validateTarget(result: TheaterSearchResult): Promise<TheaterSearchResult | null> {
    const { binding, visible } = this.state;
    if (!visible || !binding || binding.storyId !== result.storyId) return null;
    const sequence = ++this.sequence;
    this.update({ loading: true, error: null });
    try {
      const detail = await this.ports.load(result.storyId);
      if (sequence !== this.sequence) return null;
      const fresh = detail && theaterSearchEntries(detail, binding, 'story').find(entry => entry.id === result.id);
      this.update({ loading: false, error: fresh ? null : 'missing', preview: fresh ?? null });
      return fresh ?? null;
    } catch {
      if (sequence === this.sequence) this.update({ loading: false, error: 'read', preview: null });
      return null;
    }
  }
  async select(result: TheaterSearchResult): Promise<TheaterSearchResult | null> {
    const fresh = await this.validateTarget(result);
    if (!fresh || !this.state.binding || theaterSearchNeedsPreview(fresh, this.state.binding)) return null;
    this.update({ preview: null });
    return fresh;
  }
  dispose() { this.sequence++; this.listeners.clear(); }
}
