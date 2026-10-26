import type { MemoryCandidateReview } from './memoryCandidateReview';
import type { MemoryCurrentState } from './memoryCurrentStateStore';
import type { MemoryDraft, MemoryEntry } from './memoryStore';
import type { MemoryCurrentStateCandidate, MemoryCurrentStateResolveCandidate } from './memoryCurrentStateCandidates';

export type MemoryBrowserSection = 'current_states' | 'understandings' | 'pending';
export type MemoryBrowserCursor = { at: number; id: string };
export type MemoryBrowserRequest = {
  section: MemoryBrowserSection;
  search?: string;
  /** Archived understandings only; current states always show active records. */
  history?: boolean;
  subject?: 'I' | 'you';
  candidateType?: 'understanding' | 'current_state' | 'all';
  cursor?: MemoryBrowserCursor;
  limit?: number;
};
export type MemoryBrowserPreview = {
  id: string;
  kind: 'current_state' | 'understanding' | 'candidate' | 'legacy_current_state';
  title: string;
  preview: string;
  createdAt: number;
  knownAt?: number;
  subject?: 'I' | 'you';
  status: string;
  source?: string;
  waiting?: boolean;
  candidateType?: 'understanding' | 'current_state';
};
export type MemoryBrowserPage = {
  items: MemoryBrowserPreview[];
  total: number;
  hasMore: boolean;
  nextCursor?: MemoryBrowserCursor;
};
export type MemoryBrowserExternalPreview = MemoryBrowserPreview & { searchText: string; searchMatches?: boolean };
export type MemoryBrowserDetail = {
  id: string;
  kind: MemoryBrowserPreview['kind'];
  status: string;
  waiting?: boolean;
  memory?: MemoryEntry;
  currentState?: MemoryCurrentState;
  candidate?: MemoryCandidateReview;
  legacyCurrentState?: MemoryCurrentStateCandidate | MemoryCurrentStateResolveCandidate;
  editableHash?: string;
  sources: Array<{ label: string; content: string }>;
  comparison?: { title: string; content: string; hash: string; draft?: MemoryDraft };
  readingSource?: { content: string; version: string };
};
export type MemoryBrowserAction = {
  id: string;
  action: 'edit' | 'save' | 'discard' | 'recheck' | 'compare' | 'summary_check' | 'close';
  expectedEditableHash?: string;
  patch?: Partial<MemoryCandidateReview>;
  targetHash?: string;
};
export type MemoryBrowserActionResult = {
  state: 'applied' | 'saved' | 'discarded' | 'pending';
  savedId?: string;
  detail?: MemoryBrowserDetail;
};
