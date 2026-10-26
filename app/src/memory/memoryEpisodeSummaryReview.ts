import { normalizeMemoryAtomicKind, normalizeStoredMemoryEventTime, stableMemoryHash } from './memoryAtomicity';
import type { MemoryDraft } from './memoryStore';

export type EpisodeSummaryCandidateFields = {
  episodeSummaryEnabled?: true;
  episodeSummary?: string;
  episodeSummaryGeneratedReview?: { draftHash: string; targetSource?: string };
  // Host-owned: generic candidate edits never write this acknowledgement.
  episodeSummaryReview?: { draftHash: string; targetSource?: string };
};

const domains = ['相处', '称呼', '喜好', '边界', '经历', '约定', '日常', '其他'];
const semanticTypes = ['profile', 'preference', 'entity', 'event', 'case', 'pattern'];
const anchorKinds = ['name', 'boundary', 'relationship_rule', 'preference', 'promise', 'identity', 'other'];
const clamp = (value: number | undefined, minimum: number, maximum: number, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback;

/** Same editable materials as the storage writer; no unknown creation timestamp. */
export function normalizeEpisodeSummaryDraftMaterials(draft: MemoryDraft) {
  const domain = domains.includes(draft.domain) ? draft.domain : '其他';
  const inferredSemantic = ['喜好', '边界', '称呼'].includes(domain) ? 'preference'
    : ['经历', '日常'].includes(domain) ? 'event' : domain === '约定' ? 'pattern' : domain === '相处' ? 'profile' : 'other';
  const semantic = draft.semanticType ?? inferredSemantic;
  const eventTime = normalizeStoredMemoryEventTime(draft.eventTime ?? {
    basis: 'unknown', precision: typeof draft.eventAt === 'number' ? 'instant' : 'unknown', startAt: draft.eventAt,
  });
  return {
    title: draft.title.trim() || draft.content.replace(/\s+/g, ' ').trim().slice(0, 24) || '未命名记忆',
    content: draft.content.trim(), domain, tags: draft.tags.filter(Boolean), recallCues: draft.recallCues.filter(Boolean),
    // Reviewed ingestion commits preserve the complete edited reason.
    rememberedReason: draft.rememberedReason?.trim() || undefined,
    importance: draft.pinned || draft.protected ? 10 : Math.round(clamp(draft.importance, 1, 10, 5)),
    valence: clamp(draft.valence, 0, 1, .5), arousal: clamp(draft.arousal, 0, 1, .3),
    pinned: draft.pinned, anchor: draft.anchor === true,
    anchorKind: draft.anchor === true ? anchorKinds.includes(draft.anchorKind ?? '') ? draft.anchorKind : 'other' : undefined,
    semanticType: semanticTypes.includes(semantic) ? semantic : 'other', atomicKind: normalizeMemoryAtomicKind(draft.atomicKind),
    eventAt: eventTime?.startAt, eventTime, date: draft.date,
  };
}

export function episodeSummaryDraftHash(draft: MemoryDraft, content: string, targetSource?: string) {
  return stableMemoryHash(JSON.stringify([normalizeEpisodeSummaryDraftMaterials(draft), content.trim(), targetSource ?? null]));
}

export function isEpisodeSummaryReviewCurrent(candidate: MemoryDraft & EpisodeSummaryCandidateFields) {
  const review = candidate.episodeSummaryReview;
  return candidate.episodeSummaryEnabled === true && typeof candidate.episodeSummary === 'string'
    && !!candidate.episodeSummary.trim() && candidate.episodeSummary.trim().length <= 120
    && !!review && review.draftHash === episodeSummaryDraftHash(candidate, candidate.episodeSummary, review.targetSource);
}
