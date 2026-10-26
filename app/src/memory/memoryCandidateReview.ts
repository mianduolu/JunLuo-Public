import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import { deriveMemoryExtractionBasis, stableMemoryHash } from './memoryAtomicity';
import type { MemoryIngestionItemRef } from './memoryIngestionLedger';
import { buildDirectMemorySourceRefs } from './memorySourceRefs';
import type { MemoryDraft, MemorySourceRefInput } from './memoryStore';
import type { MemoryAdmissionSignal } from './memoryAdmissionControl';
import type { UnderstandingReview } from './memoryUnderstanding';
import type { ContinuationReview } from './memoryEpisodeReview';
import type { EpisodeSummaryCandidateFields } from './memoryEpisodeSummaryReview';
import type { CurrentStateReview } from './memoryCurrentStateReview';
import { isFocusMemorySource, focusMemorySourceSessionId, makeFocusMaterialBinding, type FocusMaterialBinding } from '../focus/focusMemorySource';
import {
  getMemoryCandidateKind,
  type MemoryCandidateKind,
  type MemoryCandidateWithKind,
} from './memoryCandidateKindPolicy';

export type MemoryCandidateOrigin = 'digest' | 'episode' | 'proposal' | 'weekly' | 'history_import' | 'voice_call' | 'post';

// Runtime-only editor baseline. Object spreads preserve the session across typing;
// JSON and IPC never serialize symbol properties into evidence or model material.
export const memoryCandidateEditSession = Symbol('memoryCandidateEditSession');
export type MemoryCandidateEditSession = { id: string; hash: string };

export type ReadingMemoryReview = {
  targetMemoryId: string;
  targetHash: string;
  previousDraft: MemoryDraft;
};

export type MemoryCandidateReview = MemoryDraft & EpisodeSummaryCandidateFields & {
  lifeSelfBindings?: import('../life/lifeSelfMemorySource').LifeSelfBinding[];
  shiyingBindings?: import('../shiying/shiyingMemorySource').ShiyingMemoryBinding[];
  shiyingCorrection?: boolean;
  [memoryCandidateEditSession]?: MemoryCandidateEditSession;
  postBindings?: import('../posts/baiyunPostMemorySource').PostMaterialBinding[];
  postDataEpoch?: number | null;
  // Host-owned intent. Editing a proposal cannot turn progress into a correction.
  postCorrection?: boolean;
  focusBindings?: FocusMaterialBinding[];
  readingBinding?: import('../reading/readingMemorySource').ReadingMemoryBinding & { dataEpoch: number | null };
  readingReview?: ReadingMemoryReview;
  readingBindings?: import('../reading/readingMemoryOrganizationSource').ReadingOrganizationBinding[];
  readingSourcePreview?: string;
  readingCorrection?: boolean;
  voiceBindings?: import('../voiceCall/voiceCallMemorySource').VoiceCallMaterialBinding[];
  letterBindings?: import('./letterMemoryIngestion').LetterMaterialBinding[];
  observationBindings?: import('./memoryObservationIngestion').ObservationMaterialBinding[];
  understandingReview?: UnderstandingReview;
  continuationReview?: ContinuationReview;
  currentStateReview?: CurrentStateReview;
  understandingStale?: boolean;
  reviewStatus?: 'current' | 'target_changed' | 'basis_changed' | 'missing' | 'archived';
  weeklyRefresh?: { memoryId: string; targetHash: string; previousTitle: string; previousContent: string };
  admission?: MemoryAdmissionSignal;
  candidateKind?: MemoryCandidateKind;
  ingestionRefs?: MemoryIngestionItemRef[];
  manualEventTimeText?: string;
  origin: MemoryCandidateOrigin;
  reviewId: string;
  sourceRefs?: MemorySourceRefInput[];
};

// Only fields exposed by the existing editors. Identity, evidence and provenance
// belong to the persisted proposal and cannot be replaced by a UI patch.
export function memoryCandidateEditableFields(candidate: MemoryCandidateReview) {
  if (candidate.currentStateReview) return { title: candidate.title, content: candidate.content };
  if (candidate.readingBinding) return { title: candidate.title, content: candidate.content,
    tags: candidate.tags, recallCues: candidate.recallCues, rememberedReason: candidate.rememberedReason };
  return {
    title: candidate.title, content: candidate.content, domain: candidate.domain,
    tags: candidate.tags, recallCues: candidate.recallCues, rememberedReason: candidate.rememberedReason,
    importance: candidate.importance, pinned: candidate.pinned, anchor: candidate.anchor,
    anchorKind: candidate.anchorKind,
    ...(candidate.episodeSummaryEnabled && candidate.continuationReview && candidate.source === 'episode-memory'
      ? { episodeSummary: candidate.episodeSummary } : {}),
    ...(!candidate.understandingSubject && candidate.source !== 'weekly-context' && candidate.origin !== 'weekly'
      ? { eventAt: candidate.eventAt, eventTime: candidate.eventTime, manualEventTimeText: candidate.manualEventTimeText } : {}),
  };
}

export function memoryCandidateEditableHash(candidate: MemoryCandidateReview) {
  const fields = memoryCandidateEditableFields(candidate);
  return stableMemoryHash(JSON.stringify(candidate.episodeSummaryEnabled && candidate.continuationReview && candidate.source === 'episode-memory'
    ? { ...fields, episodeSummaryReview: candidate.episodeSummaryReview } : fields));
}

export function beginMemoryCandidateEdit(candidate: MemoryCandidateReview, hash = memoryCandidateEditableHash(candidate)): MemoryCandidateReview {
  return { ...candidate, [memoryCandidateEditSession]: { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, hash } };
}

export function memoryCandidateTargetKey(candidate: Pick<MemoryCandidateReview, 'currentStateReview' | 'understandingReview' | 'continuationReview' | 'readingReview'>) {
  return candidate.currentStateReview?.targetCurrentStateId ? `current_state:${candidate.currentStateReview.targetCurrentStateId}`
    : candidate.understandingReview?.targetMemoryId ?? candidate.continuationReview?.targetMemoryId ?? candidate.readingReview?.targetMemoryId;
}

export function makeReviewCandidates(
  candidates: Array<MemoryDraft & { sourceMessageIds?: string[]; sourceRefs?: MemorySourceRefInput[]; focusBindings?: FocusMaterialBinding[] }>,
  origin: MemoryCandidateOrigin,
  range: {
    messages?: SubjectiveMessage[];
    sessionId?: string | null;
    sourceStartAt?: number;
    sourceEndAt?: number;
  } = {},
) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return candidates.map((candidate, index): MemoryCandidateReview => {
    const sourceRefs = (candidate.sourceRefs ?? (
      range.sessionId && range.messages && candidate.sourceMessageIds
        ? buildDirectMemorySourceRefs(range.sessionId, range.messages, candidate.sourceMessageIds)
        : undefined
    ))?.map(ref => isFocusMemorySource(ref.sessionId) ? { ...ref,
      sessionId: focusMemorySourceSessionId(ref.sessionId) } : ref);
    const extractionBasis = deriveMemoryExtractionBasis({
      existing: candidate.extractionBasis,
      origin,
      sourceRefCount: sourceRefs?.length ?? 0,
      sourceType: candidate.source,
    });
    const selectedFocusBindings = (sourceRefs ?? []).flatMap(ref => {
      if (!isFocusMemorySource(ref.sessionId) || ref.relation !== 'direct') return [];
      const message = range.messages?.find(value => value.id === ref.messageId
        && value.focusContext?.sessionId === ref.sessionId);
      return message ? [makeFocusMaterialBinding(message)] : [];
    });
    const bindings = new Map((candidate.focusBindings ?? []).map(binding => [`${binding.sessionId}\0${binding.messageId}`, binding]));
    for (const binding of selectedFocusBindings) {
      const key = `${binding.sessionId}\0${binding.messageId}`;
      if (bindings.has(key) && bindings.get(key)!.sourceHash !== binding.sourceHash) throw new Error('MEMORY_SOURCE_CHANGED');
      bindings.set(key, binding);
    }
    const focusBindings = [...bindings.values()];
    return beginMemoryCandidateEdit({
      ...normalizeMemoryCandidateForReview(candidate),
      candidateKind: getMemoryCandidateKind(candidate),
      extractionBasis,
      sourceEndAt: range.sourceEndAt,
      sourceRefs,
      ...(focusBindings.length ? { focusBindings } : {}),
      sourceStartAt: range.sourceStartAt,
      origin,
      reviewId: `${origin}-${stamp}-${index}`,
    });
  });
}

export function appendMemoryCandidateReviews<T extends MemoryDraft & {
  reviewId?: string; ingestionRefs?: MemoryIngestionItemRef[];
}>(
  current: T[],
  additions: T[],
) {
  const next = [...current];
  additions.forEach((candidate) => {
    const existingIndex = next.findIndex((existing) => {
      const nextTarget = candidate as T & { understandingReview?: UnderstandingReview; continuationReview?: ContinuationReview; currentStateReview?: CurrentStateReview; readingReview?: ReadingMemoryReview };
      const oldTarget = existing as typeof nextTarget;
      if (nextTarget.currentStateReview || oldTarget.currentStateReview) {
        const id = nextTarget.currentStateReview?.targetCurrentStateId;
        if (id && oldTarget.currentStateReview?.targetCurrentStateId === id) return true;
      }
      const target = nextTarget.understandingReview?.targetMemoryId ?? nextTarget.continuationReview?.targetMemoryId ?? nextTarget.readingReview?.targetMemoryId;
      if (target && (oldTarget.understandingReview?.targetMemoryId ?? oldTarget.continuationReview?.targetMemoryId ?? oldTarget.readingReview?.targetMemoryId) === target) return true;
      if (existing.ingestionRefs?.length && candidate.ingestionRefs?.length) {
        return existing.ingestionRefs.some((left) => candidate.ingestionRefs!.some((right) => (
          left.batchId === right.batchId && left.itemKey === right.itemKey
        )));
      }
      return !!existing.reviewId && existing.reviewId === candidate.reviewId;
    });
    if (existingIndex >= 0) {
      const existing = next[existingIndex] as T & { ingestionRefs?: MemoryIngestionItemRef[] };
      const incoming = candidate as T & { ingestionRefs?: MemoryIngestionItemRef[] };
      // Sharing a target is not proof that the two drafts contain the same work.
      // Keep the visible draft; the ledger retains the blocked later proposal.
      if (existing.reviewId !== incoming.reviewId && !existing.ingestionRefs?.some(left => incoming.ingestionRefs?.some(right =>
        left.batchId === right.batchId && left.itemKey === right.itemKey))) return;
      const ingestionRefs = new Map([
        ...(existing.ingestionRefs ?? []),
        ...(incoming.ingestionRefs ?? []),
      ].map((ref) => [`${ref.batchId}\u0000${ref.itemKey}`, ref]));
      next[existingIndex] = {
        ...existing,
        ...(ingestionRefs.size ? { ingestionRefs: Array.from(ingestionRefs.values()) } : {}),
      };
      return;
    }
    next.push(candidate);
  });
  return next;
}

export function updateMemoryCandidateReview<T extends { reviewId: string }>(
  current: T[],
  reviewId: string,
  updates: Partial<T>,
) {
  return current.map((candidate) => candidate.reviewId === reviewId ? { ...candidate, ...updates } : candidate);
}

export function discardMemoryCandidateReview<T extends { reviewId: string }>(
  current: T[],
  reviewId: string,
) {
  return current.filter((candidate) => candidate.reviewId !== reviewId);
}

export function compactMemoryCandidateText(text: string, limit: number) {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= limit) return cleaned;
  return `${cleaned.slice(0, limit - 1).replace(/[，,。；;、\s]+$/g, '')}…`;
}

export function normalizeMemoryCandidateForReview(
  candidate: MemoryCandidateWithKind,
): MemoryCandidateWithKind {
  return {
    ...candidate,
    content: candidate.content.trim(),
    rememberedReason: candidate.understandingSubject ? candidate.rememberedReason?.trim()
      : candidate.rememberedReason ? compactMemoryCandidateText(candidate.rememberedReason, 60) : undefined,
  };
}
