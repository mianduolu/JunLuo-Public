// Persistence contracts only. These are not model input/output schemas.
export type TheaterStorySettings = {
  world: string;
  youIdentity: string;
  iIdentity: string;
  tone: string;
  openingPrompt: string;
  names: { I: string; you: string };
  temperature: number;
  contextLimit: number;
  // Legacy free text has no reliable field boundaries. Keep it verbatim for editing.
  legacyPersona: string | null;
};

export function emptyTheaterStorySettings(): TheaterStorySettings {
  return {
    world: '', youIdentity: '', iIdentity: '', tone: '', openingPrompt: '',
    names: { I: '白云小姐', you: '小仓鼠' },
    temperature: 0.8, contextLimit: 20, legacyPersona: null,
  };
}

export function readTheaterSummaryInterval(value: number | null | undefined) {
  return value === undefined ? 20 : value;
}

export type TheaterStory = {
  id: string;
  title: string;
  settings: TheaterStorySettings;
  summaryInterval: number | null;
  isDraft: boolean;
  isPinned?: boolean;
  createdAt: number;
  updatedAt: number;
};

export type TheaterBranch = {
  id: string;
  conversationId: string;
  name: string;
  activeCheckpointId: string | null;
  // Explicit retired selection for review only; never model evidence or an automatic fallback.
  staleCheckpointId?: string | null;
  // Number of unchanged common positions when this branch was created; null for an initial/old branch.
  forkBoundary?: number | null;
  createdAt: number;
  updatedAt: number;
};

export type TheaterAdoption = { positionId: string; versionId: string };

export type TheaterTextVersion = {
  id: string;
  conversationId: string;
  positionId: string;
  content: string;
  origin: 'legacy' | 'generated' | 'edited';
  // Successful original adopted model reply only; edits/alternatives never create a new fact.
  coCreation?: { branchId: string; completedAt: number; youVersionIds: string[];
    identities?: { I: string; you: string } };
  createdAt: number;
  updatedAt: number;
} & (
  | { kind: 'dialogue'; subject: 'I' | 'you' }
  | { kind: 'legacy-context-note'; subject: null }
);

export type TheaterCheckpoint = {
  id: string;
  conversationId: string;
  branchId: string;
  content: string;
  coveredPositionId: string | null;
  basis: TheaterAdoption[];
  status: 'draft' | 'saved' | 'legacy-unverified';
  createdAt: number;
  updatedAt: number;
};

export type TheaterAnchor = {
  id: string;
  conversationId: string;
  branchId: string;
  positionId: string;
  sourceVersionId: string | null;
  source: 'manual' | 'message' | 'summary';
  content: string;
  confirmed: boolean;
  createdAt: number;
  updatedAt: number;
};
