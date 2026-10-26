import { applyMemoryCandidateKindDefaults } from '../memory/memoryCandidateKindPolicy';
import type { MemoryDraft } from '../memory/memoryStore';
import type { VoiceCallMemoryCandidate } from './voiceCallRecord';

export function voiceCallCandidateToMemoryDraft(
  candidate: VoiceCallMemoryCandidate,
  endedAt: number,
): MemoryDraft & { candidateKind: VoiceCallMemoryCandidate['candidateKind'] } {
  const base: MemoryDraft = {
    anchor: candidate.suggestedAnchor,
    anchorKind: candidate.suggestedAnchor ? candidate.suggestedAnchorKind : undefined,
    arousal: candidate.arousal,
    atomicKind: candidate.atomicKind,
    confidence: candidate.confidence,
    content: candidate.content,
    digested: false,
    domain: candidate.domain,
    eventAt: candidate.atomicKind === 'event' ? endedAt : undefined,
    importance: candidate.importance,
    pinned: false,
    protected: false,
    recallCues: candidate.recallCues,
    rememberedReason: candidate.rememberedReason,
    resolved: false,
    semanticType: candidate.semanticType,
    source: 'voice-call',
    sourceEndAt: endedAt,
    sourceStartAt: endedAt,
    sourceType: 'automatic',
    stability: candidate.stability,
    tags: candidate.tags,
    title: candidate.title,
    type: 'dynamic',
    valence: candidate.valence,
  };
  return applyMemoryCandidateKindDefaults(base, candidate.candidateKind) as MemoryDraft & {
    candidateKind: VoiceCallMemoryCandidate['candidateKind'];
  };
}
