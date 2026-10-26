import { getTheaterBackstageContext, SUBJECTIVE_IDENTITY_PROTOCOL, type SubjectiveMessage } from '../ai/subjectiveMessages';
import { renderLetterMaterial } from './letterMemoryIngestion';
import { renderVoiceCallMaterial } from '../voiceCall/voiceCallMemorySource';
import { buildWeeklyMaterialText } from './memoryWeeklyMaterialText';
import { understandingCandidateEvidence, understandingMessageHash, validateUnderstandingCandidates, validateUnderstandingMaterials, assignLifeSelfReferences, type UnderstandingMaterials, type UnderstandingReview } from './memoryUnderstanding';
import { validateLifeSelfBinding } from '../life/lifeSelfMemorySource';
import { withUnderstandingPrompt } from './memoryUnderstandingPrompt';
import { continuationCandidateEvidence, validateConversationMemoryCandidates, type ContinuationReview } from './memoryEpisodeReview';
import { episodeSummaryDraftHash, type EpisodeSummaryCandidateFields } from './memoryEpisodeSummaryReview';
import { memoryDehydrationSource } from './memoryCurrentMaterials';
import { isCurrentStateProposal, parseCurrentStateProposal, validateCurrentStateCandidates, CURRENT_STATE_ORGANIZER_PROMPT } from './memoryCurrentStateReview';
import type { AiConnection } from '../ai/types';
import { beginPromptCacheMetric } from '../ai/promptCacheMetrics';
import {
  getMemoryOccurrenceStart,
  isModelMemoryAtomicKind,
  normalizeMemoryAtomicKind,
  normalizeModelMemoryEventTime,
} from './memoryAtomicity';
import { stabilizeMemoryCalendarNarrative } from './memoryCalendarTime';
import {
  applyMemoryCandidateKindDefaults,
  normalizeMemoryCandidateKind,
} from './memoryCandidateKindPolicy';
import {
  normalizeMemoryDuplicateDecision,
  type MemoryDuplicateDecision,
} from './memoryDeduplication';
import type { HistoryImportChunk } from './memoryHistoryImport';
import { selectWhitelistedSourceMessages, buildObservationMemorySourceRefs } from './memorySourceRefs';
import { createFocusOrganizationMessageReferences, restoreFocusOrganizationMessageReferences } from '../focus/focusOrganizationProtocol';
import { READING_ORGANIZER_PROMPT, READING_BATCH_MATERIAL_HEADING, renderReadingOrganizationMaterial,
  restoreReadingOrganizationReferences } from '../reading/readingMemoryOrganizationProtocol';
import { SHIYING_ORGANIZER_OPENING, SHIYING_ORGANIZER_RULES } from '../shiying/shiyingMemoryOrganizationProtocol';
import { renderPreparedShiyingMaterial } from '../shiying/shiyingMemoryIngestion';
import { validateShiyingMemoryBinding } from '../shiying/shiyingMemorySource';
import {
  deriveMemoryTitle,
  normalizeMemoryAnchorKind,
  normalizeMemoryDomain,
  normalizeMemorySemanticType,
  normalizeRelationType,
  type MemoryDraft,
  type MemoryEntry,
  type MemoryRelationType,
} from './memoryStore';

type CandidateResponse = {
  understandingSubject?: unknown;
  understandingKind?: unknown;
  statedQuote?: unknown;
  targetMemoryId?: unknown;
  sourceMemoryIds?: unknown;
  patternEvidence?: unknown;
  atomicKind?: unknown;
  title?: unknown;
  content?: unknown;
  episodeSummary?: unknown;
  domain?: unknown;
  tags?: unknown;
  importance?: unknown;
  valence?: unknown;
  arousal?: unknown;
  suggestedAnchor?: unknown;
  suggestedAnchorKind?: unknown;
  recallCues?: unknown;
  semanticType?: unknown;
  stability?: unknown;
  confidence?: unknown;
  eventAt?: unknown;
  eventTime?: unknown;
  rememberedReason?: unknown;
  candidateKind?: unknown;
  sourceMessageIds?: unknown;
  sourceObservationIds?: unknown;
};

export type MemoryDraftWithSourceIds = { lifeSelfBindings?: import('../life/lifeSelfMemorySource').LifeSelfBinding[]; shiyingBindings?: import('../shiying/shiyingMemorySource').ShiyingMemoryBinding[]; shiyingCorrection?: boolean; readingBindings?: import('../reading/readingMemoryOrganizationSource').ReadingOrganizationBinding[]; readingCorrection?: boolean } & MemoryDraft & EpisodeSummaryCandidateFields & { sourceMessageIds: string[]; sourceObservationIds?: string[]; observationBindings?: import('./memoryObservationIngestion').ObservationMaterialBinding[]; postBindings?: import('../posts/baiyunPostMemorySource').PostMaterialBinding[]; focusBindings?: import('../focus/focusMemorySource').FocusMaterialBinding[]; voiceBindings?: import('../voiceCall/voiceCallMemorySource').VoiceCallMaterialBinding[]; letterBindings?: import('./letterMemoryIngestion').LetterMaterialBinding[]; understandingReview?: UnderstandingReview; continuationReview?: ContinuationReview; currentStateReview?: import('./memoryCurrentStateReview').CurrentStateReview; sourceRefs?: import('./memoryStore').MemorySourceRefInput[] };

export type ContinuationDecision = {
  shouldLink: boolean;
  targetMemoryId?: string;
  relationType?: MemoryRelationType;
  confidence: number;
  reason: string;
  threadTitle?: string;
};


type ContinuationResponse = {
  shouldLink?: unknown;
  targetMemoryId?: unknown;
  relationType?: unknown;
  confidence?: unknown;
  reason?: unknown;
  threadTitle?: unknown;
};


type EpisodeMemoryResponse = {
  atomicKind?: unknown;
  title?: unknown;
  content?: unknown;
  domain?: unknown;
  tags?: unknown;
  recallCues?: unknown;
  importance?: unknown;
  valence?: unknown;
  arousal?: unknown;
  eventAt?: unknown;
  eventTime?: unknown;
  rememberedReason?: unknown;
  sourceMessageIds?: unknown;
};

type WeeklyContextResponse = {
  atomicKind?: unknown;
  title?: unknown;
  content?: unknown;
  domain?: unknown;
  tags?: unknown;
  recallCues?: unknown;
  importance?: unknown;
  valence?: unknown;
  arousal?: unknown;
  rememberedReason?: unknown;
};


const ATOMIC_SHORT_MEMORY_PROMPT = `【把这件事记清楚】

I 从原话里记下值得记住的事。
同一次经历的经过和后来补充的内容，I 记在一起。不同次经历，各记一条。
如果还分不清是不是同一次，I 先留下已知内容，并写清哪里还不确定。`;

const STAGE_ATOMIC_MEMORY_PROMPT = `这一条只记一个连续主题。出现几个独立主题时，I 选择证据最完整、最值得留下的一个。

atomicKind 固定填写 stage_conclusion。`;

const STRUCTURED_EVENT_TIME_PROMPT = `【这是什么时候的事】

I 记录事情发生的时间；同一件事有明确更正，只用更正后的说法。
仍不确定时，日期留空，保留原文时间线索和来源。
相对时间按对应原话的日期计算。
上下文表明事情发生在发言当时，I 就用那条消息的时间。

eventTime：precision 为 instant/day/range/unknown；basis 为 explicit（明确日期或时刻）/relative（按原消息日期换算）/source_message（当时正在发生）/unknown。
startAt 和 endAt 使用 Unix 毫秒。单一时刻的 endAt 为 null。
时间不明时，precision 和 basis 为 unknown，startAt 和 endAt 为 null。
timeExpression 只保留最终采用的原文时间说法，没有时为 ""。
timeSourceMessageId 保留提供时间依据的真实消息编号，没有时为 null。`;


function clamp(value: unknown, minimum: number, maximum: number, fallback: number) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
}

function isStageLikeCandidate(item: CandidateResponse) {
  return (
    Array.isArray(item.tags)
    && item.tags.some((tag) => typeof tag === 'string' && tag.includes('阶段记忆'))
  ) || item.semanticType === 'case';
}

function looksLikeStageNarrative(content: string) {
  const compact = content.replace(/\s+/g, '');
  if (compact.length < 90) return false;
  return /(?:这段|这次|一次|那段|过程中|来龙去脉|逐步|后来|然后|最终|转折|未解决|阶段|推进|反复|白云(?:小姐)?意识到|于是白云)/.test(compact);
}

function hasEpisodeProcessShape(content: string) {
  const compact = content.replace(/\s+/g, '');
  if (compact.length < 140) return false;
  const processTerms = compact.match(/阶段|过程|推进|进展|后来|然后|接着|结果|最终|原因|解决|没解决|卡住|反复|一直|逐步|这几天|最近|之前|上次|变化|转折|影响|形成|希望|尝试|发现|排查|修复|优化/g) ?? [];
  const strongProcess = /后来|然后|接着|结果|最终|转折|反复|逐步|过程|变化|进展|解决|没解决|卡住|影响|形成|尝试|发现|排查|修复|优化/.test(compact);
  return strongProcess && new Set(processTerms).size >= 3;
}

function compactMemoryCandidateContent(content: string, limit: number) {
  const cleaned = content.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= limit) return cleaned;
  return `${cleaned.slice(0, limit - 1).replace(/[，,。；;、\s]+$/g, '')}…`;
}

export function restoreLifeSelfReferences(items: unknown[], materials: UnderstandingMaterials) {
  const refs = assignLifeSelfReferences(materials);
  if (!refs.size) return items;
  const originalIds = new Set([...materials.batchMessages, ...materials.messages].map(source => source.message.id));
  for (const [reference, id] of refs) if (originalIds.has(reference) && reference !== id) throw new Error('LIFE_SELF_MEMORY_REFERENCE_INVALID');
  const restore = (value: unknown) => {
    if (typeof value !== 'string' || !/^[EW]\d+$/.test(value)) return value;
    const id = refs.get(value);
    if (!id) throw new Error('LIFE_SELF_MEMORY_REFERENCE_INVALID');
    return id;
  };
  return items.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const value = item as Record<string, unknown>;
    const event = value.eventTime;
    return { ...value,
      ...(Array.isArray(value.sourceMessageIds) ? { sourceMessageIds: value.sourceMessageIds.map(restore) } : {}),
      ...(Array.isArray(value.patternEvidence) ? { patternEvidence: value.patternEvidence.map(group => {
        if (!group || typeof group !== 'object' || Array.isArray(group)) return group;
        const evidence = group as Record<string, unknown>;
        return { ...evidence, ...(Array.isArray(evidence.sourceMessageIds) ? { sourceMessageIds: evidence.sourceMessageIds.map(restore) } : {}) };
      }) } : {}),
      ...(event && typeof event === 'object' && !Array.isArray(event) ? { eventTime: { ...event,
        ...('timeSourceMessageId' in event ? { timeSourceMessageId: restore(event.timeSourceMessageId) } : {}) } } : {}),
    };
  });
}

export function parseCandidates(text: string, options: {
  understandingMaterials?: UnderstandingMaterials;
  allowStageCandidates?: boolean;
  requireSourceMessageIds?: boolean;
  sourceMessages?: SubjectiveMessage[];
  sourceText?: string;
  maximumCandidates?: number;
  episodeSummaryEnabled?: boolean;
} = {}): MemoryDraftWithSourceIds[] {
  const cleaned = text.replace(/^\x60\x60\x60(?:json)?\s*/i, '').replace(/\s*\x60\x60\x60$/i, '').trim();
  let parsed = JSON.parse(cleaned) as unknown;
  if (!Array.isArray(parsed)) throw new Error('memory-candidates-not-array');
  if (options.understandingMaterials) parsed = restoreLifeSelfReferences(parsed, options.understandingMaterials);
  if (options.understandingMaterials?.readingReferences) {
    const materials = options.understandingMaterials;
    parsed = restoreReadingOrganizationReferences(parsed as unknown[], materials.readingReferences!,
      new Set([...materials.batchMessages, ...materials.messages].map(source => source.message.id)),
      new Set([...materials.memories.map(source => source.memory.id), ...materials.targets.map(memory => memory.id)]));
  }
  if (!Array.isArray(parsed)) throw new Error('memory-candidates-not-array');
  const continuationEnabled = options.understandingMaterials?.continuationEnabled === true;
  const isUnderstanding = (item: CandidateResponse) => 'understandingSubject' in item || 'patternEvidence' in item
    || 'understandingKind' in item || 'statedQuote' in item
    || (!continuationEnabled && ('targetMemoryId' in item || 'sourceMemoryIds' in item));
  if (continuationEnabled && (parsed.length > (options.maximumCandidates ?? 6)
    || parsed.some(item => !item || typeof item !== 'object' || typeof item.content !== 'string' || !item.content.trim()))) {
    throw new Error('memory-candidate-contract-invalid');
  }
  const understandingTargets = new Set<string>();
  for (const item of parsed) {
    if (item && isCurrentStateProposal(item)) {
      const draft = parseCurrentStateProposal(item, options.understandingMaterials);
      const target = draft.currentStateReview.targetCurrentStateId;
      if (target && understandingTargets.has(`current_state:${target}`)) throw new Error('memory-current-state-target-duplicate');
      if (target) understandingTargets.add(`current_state:${target}`);
    } else if (item && isUnderstanding(item)) {
      understandingCandidateEvidence(item, options.understandingMaterials);
      if (typeof item.targetMemoryId === 'string') {
        if (understandingTargets.has(item.targetMemoryId)) throw new Error('memory-understanding-target-duplicate');
        understandingTargets.add(item.targetMemoryId);
      }
      if (typeof item.content !== 'string' || !item.content.trim()) throw new Error('memory-understanding-contract-invalid');
    } else if (continuationEnabled) {
      continuationCandidateEvidence(item, options.understandingMaterials!);
      if (typeof item.targetMemoryId === 'string') {
        if (understandingTargets.has(item.targetMemoryId)) throw new Error('memory-continuation-target-duplicate');
        understandingTargets.add(item.targetMemoryId);
      }
    }
  }

  const rawItems = parsed
    .map((item) => item as CandidateResponse)
    .filter((item) => typeof item.content === 'string' && item.content.trim())
    .slice(0, 6);
  const candidates = rawItems
    .map((item): MemoryDraftWithSourceIds | null => {
      if (isCurrentStateProposal(item)) return parseCurrentStateProposal(item as Record<string, unknown>, options.understandingMaterials);
      const understanding = isUnderstanding(item)
        ? understandingCandidateEvidence(item, options.understandingMaterials) : undefined;
      const continuation = continuationEnabled && !understanding ? continuationCandidateEvidence(item, options.understandingMaterials!) : undefined;
      const anchor = !understanding && item.suggestedAnchor === true;
      const stageLike = isStageLikeCandidate(item);
      const atomicKind = normalizeMemoryAtomicKind(item.atomicKind);
      const candidateKind = understanding || stageLike ? 'long_term' : normalizeMemoryCandidateKind(item.candidateKind);
      if (!isModelMemoryAtomicKind(atomicKind) || !candidateKind) {
        if (understanding) throw new Error('memory-understanding-contract-invalid');
        if (continuationEnabled) throw new Error('memory-candidate-contract-invalid');
        return null;
      }
      if (stageLike !== (atomicKind === 'stage_conclusion') || (understanding && stageLike)) {
        if (understanding) throw new Error('memory-understanding-contract-invalid');
        if (continuationEnabled) throw new Error('memory-candidate-contract-invalid');
        return null;
      }
      const rawContent = item.content as string;
      if (continuationEnabled && stageLike && item.candidateKind !== 'long_term') throw new Error('memory-candidate-contract-invalid');
      if (!understanding && !continuationEnabled && !options.allowStageCandidates && (stageLike || looksLikeStageNarrative(rawContent))) return null;
      const selectedSourceMessages = selectWhitelistedSourceMessages(
        item.sourceMessageIds,
        options.sourceMessages ?? [],
      );
      const observationIds = item.sourceObservationIds ?? [];
      if (!Array.isArray(observationIds) || observationIds.some(id => typeof id !== 'string' || !id)
        || new Set(observationIds).size !== observationIds.length) throw new Error('memory-observation-source-invalid');
      const selectedObservations = observationIds.map(id => {
        const source = [...(options.understandingMaterials?.observations ?? []),
          ...(understanding ? options.understandingMaterials?.relatedObservations ?? [] : [])].find(source => source.binding.observationId === id);
        if (!source) throw new Error('memory-observation-source-invalid');
        return source;
      });
      if (!understanding && selectedSourceMessages.length + selectedObservations.length > 6) throw new Error('memory-observation-source-invalid');
      if (!understanding && options.requireSourceMessageIds && !selectedSourceMessages.length && !selectedObservations.length) return null;
      const eventTime = understanding ? undefined : normalizeModelMemoryEventTime(item.eventTime, {
        candidateText: rawContent,
        legacyEventAt: item.eventAt,
        sourceMessages: selectedSourceMessages.length
          ? selectedSourceMessages
          : options.sourceMessages,
        sourceText: options.sourceText,
        observationCapturedAt: selectedObservations.map(source => source.binding.capturedAt),
      });
      const stableContent = understanding ? rawContent : stabilizeMemoryCalendarNarrative(rawContent, eventTime);
      const rawTitle = typeof item.title === 'string' ? item.title.trim() : '';
      const stableTitle = stabilizeMemoryCalendarNarrative(rawTitle, eventTime);
      const draft: MemoryDraft = {
        atomicKind,
        title: stableTitle ? stableTitle.slice(0, 24) : deriveMemoryTitle(stableContent),
        content: stableContent.trim(),
        domain: normalizeMemoryDomain(item.domain),
        tags: Array.isArray(item.tags)
          ? item.tags.filter((tag): tag is string => typeof tag === 'string' && (continuationEnabled || options.allowStageCandidates || !tag.includes('阶段记忆'))).slice(0, 8)
          : [],
        recallCues: Array.isArray(item.recallCues)
          ? item.recallCues.filter((cue): cue is string => typeof cue === 'string').slice(0, 8)
          : [],
        importance: Math.round(clamp(item.importance, 1, 10, 5)),
        valence: clamp(item.valence, 0, 1, 0.5),
        arousal: clamp(item.arousal, 0, 1, 0.3),
        pinned: false,
        anchor,
        anchorKind: anchor ? normalizeMemoryAnchorKind(item.suggestedAnchorKind) : undefined,
        type: 'dynamic',
        resolved: false,
        digested: false,
        protected: false,
        sourceType: 'digest',
        semanticType: normalizeMemorySemanticType(continuationEnabled || options.allowStageCandidates ? item.semanticType : item.semanticType === 'case' ? 'event' : item.semanticType),
        ...(continuationEnabled && stageLike ? { source: 'episode-memory' } : {}),
        stability: clamp(item.stability, 0, 1, anchor ? 0.85 : 0.5),
        confidence: clamp(item.confidence, 0, 1, 0.7),
        eventAt: eventTime?.startAt,
        eventTime,
        rememberedReason: typeof item.rememberedReason === 'string' ? understanding ? item.rememberedReason.trim() : compactMemoryCandidateContent(item.rememberedReason, 60) : undefined,
      };
      const sourceMessageIds = understanding ? item.sourceMessageIds as string[] : selectedSourceMessages.map((message) => message.id);
      const observationRefs = selectedObservations.length ? [...(understanding?.sourceRefs ?? continuation?.sourceRefs
        ?? selectedSourceMessages.map(message => ({ sessionId: options.understandingMaterials?.batchMessages.find(source => source.message.id === message.id)?.sessionId ?? '',
          messageId: message.id, role: message.role, messageCreatedAt: message.createdAt, relation: 'direct' as const, excerpt: message.content }))),
        ...buildObservationMemorySourceRefs(selectedObservations.map(source => source.binding))] : [];
      const candidate: MemoryDraftWithSourceIds = {
        ...applyMemoryCandidateKindDefaults(draft, candidateKind),
        ...understanding,
        ...continuation,
        ...(selectedObservations.length ? { sourceObservationIds: observationIds,
          sourceRefs: [...new Map(observationRefs.map(ref => [`${ref.sessionId}\0${ref.messageId}`, ref])).values()] } : {}),
        sourceMessageIds,
      };
      if (options.episodeSummaryEnabled === true && continuation && stageLike) {
        const target = options.understandingMaterials!.memories.find(source => source.memory.id === continuation.continuationReview.targetMemoryId);
        candidate.protected = target?.memory.protected ?? candidate.protected;
        if (target?.memory.date !== undefined) candidate.date = target.memory.date;
        candidate.episodeSummaryEnabled = true;
        if (typeof item.episodeSummary === 'string') {
          candidate.episodeSummary = item.episodeSummary;
          const content = item.episodeSummary.trim();
          if (content && content.length <= 120) {
            const targetSource = target ? memoryDehydrationSource(target.memory, target.comments) : undefined;
            candidate.episodeSummaryGeneratedReview = { draftHash: episodeSummaryDraftHash(candidate, content, targetSource),
              ...(targetSource ? { targetSource } : {}) };
          }
        }
      }
      return candidate;
    })
    .filter((candidate): candidate is MemoryDraftWithSourceIds => candidate !== null)
    .map(candidate => {
      const lifeSelfBindings = [...new Map([...(options.understandingMaterials?.batchMessages ?? []), ...(options.understandingMaterials?.messages ?? [])]
        .filter(source => source.lifeSelfBinding && (candidate.sourceMessageIds.includes(source.message.id)
          || candidate.sourceRefs?.some(ref => ref.sessionId === source.sessionId && ref.messageId === source.message.id && ref.relation === 'direct')))
        .map(source => [JSON.stringify([source.sessionId, source.message.id]), source.lifeSelfBinding!])).values()];
      const letterBindings = [...(options.understandingMaterials?.batchMessages ?? []), ...(options.understandingMaterials?.messages ?? [])]
        .filter(source => source.letterBinding && (candidate.sourceRefs?.some(ref => ref.sessionId === source.sessionId && ref.messageId === source.message.id)
          || candidate.sourceMessageIds.includes(source.message.id)))
        .map(source => source.letterBinding!);
      const voiceBindings = [...(options.understandingMaterials?.batchMessages ?? []), ...(options.understandingMaterials?.messages ?? [])]
        .filter(source => source.voiceBinding && (candidate.sourceRefs?.some(ref => ref.sessionId === source.sessionId && ref.messageId === source.message.id)
          || candidate.sourceMessageIds.includes(source.message.id)))
        .map(source => source.voiceBinding!);
      const focusBindings = [...(options.understandingMaterials?.batchMessages ?? []), ...(options.understandingMaterials?.messages ?? [])]
        .filter(source => source.focusBinding && (candidate.sourceRefs?.some(ref => ref.sessionId === source.sessionId && ref.messageId === source.message.id)
          || candidate.sourceMessageIds.includes(source.message.id)))
        .map(source => source.focusBinding!);
      const observationBindings = [...(options.understandingMaterials?.observations ?? []), ...(options.understandingMaterials?.relatedObservations ?? [])]
        .filter(source => candidate.sourceRefs?.some(ref => ref.sessionId === `observation-source:${source.binding.observationId}`))
        .map(source => source.binding);
      const readings = (options.understandingMaterials?.readingMaterials ?? []).filter(source =>
        candidate.sourceMessageIds.includes(source.message.id) || candidate.sourceRefs?.some(ref =>
          ref.sessionId === source.binding.sessionId && ref.messageId === source.message.id));
      const readingTargets = new Set(readings.flatMap(source => source.correctionTargetIds));
      const targetId = candidate.understandingReview?.targetMemoryId ?? candidate.continuationReview?.targetMemoryId;
      if (readingTargets.size && (!targetId || !readingTargets.has(targetId))) throw new Error('READING_MEMORY_CORRECTION_TARGET_INVALID');
      const readingBindings = [...new Map([...(readings.map(source => source.binding)),
        ...[...(options.understandingMaterials?.messages ?? []), ...(options.understandingMaterials?.batchMessages ?? [])]
          .filter(source => source.readingBinding && candidate.sourceRefs?.some(ref => ref.sessionId === source.sessionId
            && ref.messageId === source.message.id && ref.relation === 'direct')).map(source => source.readingBinding!)]
        .map(binding => [JSON.stringify([binding.sessionId, binding.messageId]), binding])).values()];
      const shiyingBindings = [...new Map([...(options.understandingMaterials?.batchMessages ?? []), ...(options.understandingMaterials?.messages ?? [])]
        .filter(source => source.shiyingBinding && (candidate.sourceMessageIds.includes(source.message.id)
          || candidate.sourceRefs?.some(ref => ref.sessionId === source.sessionId && ref.messageId === source.message.id && ref.relation === 'direct')))
        .map(source => [JSON.stringify([source.sessionId, source.message.id]), source.shiyingBinding!])).values()];
      const shiyingCorrection = !!targetId && !!options.understandingMaterials?.shiyingComparisonTargetIds?.includes(targetId);
      return { ...candidate, ...(lifeSelfBindings.length ? { lifeSelfBindings } : {}), ...(observationBindings.length ? { observationBindings } : {}),
        ...(shiyingBindings.length ? { shiyingBindings, ...(shiyingCorrection ? { shiyingCorrection: true } : {}) } : {}),
        ...(readingBindings.length ? { readingBindings, ...(readingTargets.size ? { readingCorrection: true } : {}) } : {}),
        ...(letterBindings.length ? { letterBindings } : {}), ...(voiceBindings.length ? { voiceBindings } : {}),
        ...(focusBindings.length ? { focusBindings } : {}) };
    });
  if (rawItems.length && !candidates.length) throw new Error('memory-candidate-contract-invalid');
  return candidates;
}

function withCurrentStatePrompt(prompt: string, materials: UnderstandingMaterials, episodeSummaryEnabled = false) {
  const base = withUnderstandingPrompt(prompt, materials.continuationEnabled);
  const result = episodeSummaryEnabled && materials.continuationEnabled
    ? base.replace('分不清是不是同一件事，I 先不补进旧记忆。',
      '分不清是不是同一件事，I 先不补进旧记忆。\nI 把正文里的经过和变化写成一两句小记。')
      .replace('补旧卡时，content 写补好后的完整正文。',
        '补旧卡时，content 写补好后的完整正文。\nepisodeSummary：经过卡的小记，最多120字；其他候选不填。')
    : base;
  if (!materials.currentStatesEnabled) return withReadingPrompt(withObservationPrompt(result, materials), materials);
  return withReadingPrompt(withObservationPrompt(result.replace('先判断候选类型：', 'I 为普通记忆选择候选类型：')
    .replace('I 为每条记忆选一个分类：', 'I 为普通记忆和认识选一个分类：')
    .replace(STRUCTURED_EVENT_TIME_PROMPT, `以下发生时间格式不用于近况。\n${STRUCTURED_EVENT_TIME_PROMPT}`)
    .replace('优先留下 1 条长期记忆或重要内容，还可以补充 1 条小纸条或情绪天气。', '')
    + `\n\n${CURRENT_STATE_ORGANIZER_PROMPT}`, materials), materials);
}

function withReadingPrompt(prompt: string, materials: UnderstandingMaterials): string {
  if (materials.shiyingMaterials?.length || materials.hasShiyingContext) {
    const base = materials.readingMaterials?.length ? withReadingPrompt(prompt, { ...materials, shiyingMaterials: undefined, hasShiyingContext: false }) : prompt;
    const opening = `${SHIYING_ORGANIZER_OPENING}\n${SHIYING_ORGANIZER_RULES}`;
    const replaced = materials.readingMaterials?.length ? base.replace(READING_ORGANIZER_PROMPT,
      `${opening}\n${READING_ORGANIZER_PROMPT.split('\n').slice(1).join('\n')}`)
      : base.replace('I 把这批聊天和观察里想记住的事，整理成记忆。', opening)
        .replace(/和 you 聊过之后，有些事情 I 想记下来，让以后的相处能够接着往下走。\s*I 从这段对话里，整理出想留下的事实、偏好、经历、约定和相处边界，写成(?:简短的)?记忆候选。/, opening)
        .replace(/和 you 聊过之后，I 把这段新对话里想记住的事写成(?:简短的)?记忆候选。/, opening);
    if (!replaced.includes(opening)) throw new Error('SHIYING_ORGANIZER_PROMPT_MISMATCH');
    return replaced;
  }
  if (!materials.readingMaterials?.length) return prompt;
  const replaced = prompt.replace('I 把这批聊天和观察里想记住的事，整理成记忆。', READING_ORGANIZER_PROMPT)
    .replace(/和 you 聊过之后，有些事情 I 想记下来，让以后的相处能够接着往下走。\s*I 从这段对话里，整理出想留下的事实、偏好、经历、约定和相处边界，写成(?:简短的)?记忆候选。/, READING_ORGANIZER_PROMPT)
    .replace(/和 you 聊过之后，I 把这段新对话里想记住的事写成(?:简短的)?记忆候选。/, READING_ORGANIZER_PROMPT);
  if (!replaced.includes(READING_ORGANIZER_PROMPT)) throw new Error('READING_ORGANIZER_PROMPT_MISMATCH');
  return replaced;
}

function withObservationPrompt(prompt: string, materials: UnderstandingMaterials) {
  if (!materials.observations?.length && !materials.relatedObservations?.length) return prompt;
  const sourceFormat = 'sourceMessageIds：I 填支持本次新内容的本批原话编号；没有填 []。\nsourceObservationIds：I 填支持本次新内容的本批观察编号；没有填 []。\n这两类合计 1–6 条，I 只用本次实际提供的编号。';
  return prompt
    .replace(/和 you 聊过之后，有些事情 I 想记下来，让以后的相处能够接着往下走。\s*I 从这段对话里，整理出想留下的事实、偏好、经历、约定和相处边界，写成(?:简短的)?记忆候选。/, 'I 把这批聊天和观察里想记住的事，整理成记忆。')
    .replace(/和 you 聊过之后，I 把这段新对话里想记住的事写成(?:简短的)?记忆候选。/, 'I 把这批聊天和观察里想记住的事，整理成记忆。')
    .replace(/(?:普通记忆|每条记忆)的 sourceMessageIds，I 填入能直接支持它的 1 到 6 个原消息编号，沿用材料中的 messageId。/, sourceFormat)
    .replace('sourceMessageIds：I 填支持新内容的本批原话编号，1–6 个。', sourceFormat)
    .replace('近况只填下面五项。', '近况只填下面六项。')
    .replace('sourceMessageIds：I 填支持本次新内容的本批原话编号，1–6 个。', sourceFormat)
    .replace('sourceMemoryIds：支持正文的经历编号；没有填 []。', 'sourceMemoryIds：支持正文的经历编号；没有填 []。\nsourceObservationIds：支持正文的观察编号；没有填 []。')
    .replace('每组代表一次发生，格式为 {"sourceMessageIds":[],"sourceMemoryIds":[]}，分别填写这一次的原话和经历编号。', '每组代表一次发生，格式为 {"sourceMessageIds":[],"sourceMemoryIds":[],"sourceObservationIds":[]}，分别填写这一次的原话、经历和观察编号。')
    .replace('同一件事的原话、回应和记忆卡放在同组；旧事重述不另算一次。', '同一次经历的原话、观察和记忆卡放在同组；重述、重试和分段不另算一次。')
    .replace('依据只选本次材料中的编号，两类合计 1 到 6 条；旧认识只供对照，不能当依据。', '依据只选本次材料中的编号，三类合计 1 到 6 条；旧认识只供对照，不能当依据。')
    .replaceAll('"sourceMessageIds":["真实messageId"]', '"sourceMessageIds":["真实messageId"],"sourceObservationIds":[]')
    .replace('上下文表明事情发生在发言当时，I 就用那条消息的时间。', '上下文表明事情发生在发言当时，I 就用那条消息的时间。\n观察记录的时间是拍摄时间；画面只说明那一刻的情况。');
}

function formatSourceTranscript(messages: SubjectiveMessage[], materials?: UnderstandingMaterials) {
  return [messages
    .filter((message) => !materials?.readingMaterials?.some(source => source.message.id === message.id)
      && !materials?.lifeSelfMaterials?.some(source => source.message.id === message.id)
      && !materials?.shiyingMaterials?.some(source => source.messages.some(original => original.id === message.id)) && !(
      message.role === 'I'
      && message.source === 'proactive-message'
      && message.deliveryStatus === 'failed'
    ))
    .map((message, index, delivered) => {
      const source = materials?.batchMessages.find(source => source.message.id === message.id);
      if (source?.voiceBinding) return renderVoiceCallMaterial(message, source.voiceBinding);
      const binding = source?.letterBinding;
      if (binding) return renderLetterMaterial(message, binding);
      const context = getTheaterBackstageContext(message, delivered[index - 1]);
      return `${context ? `${context}\n` : ''}[messageId=${message.id}][time=${new Date(message.createdAt).toISOString()}] ${message.role}: ${message.content}`;
    })
    .join('\n'), ...(materials?.observations ?? []).map(source => source.content),
    ...(materials?.readingMaterials ?? []).map(source => renderReadingOrganizationMaterial(source.source.snapshot,
      materials!.readingReferences!.messageRefs.get(source.message.id)!, source.binding.bookRange, source.binding.contentRange)),
    ...(materials?.shiyingMaterials ?? []).map(source => renderPreparedShiyingMaterial(source, materials!.readingReferences)),
    ...(materials?.lifeSelfMaterials ?? []).map(source => source.content)].filter(Boolean).join('\n\n');
}

function nonCountingWishCount(messages: SubjectiveMessage[], materials?: UnderstandingMaterials) {
  return materials?.lifeSelfMaterials?.filter(source => source.source.kind === 'wish'
    && messages.some(message => message.id === source.message.id)).length ?? 0;
}
async function validateLifeSelfBatch(materials: UnderstandingMaterials | undefined, messages: SubjectiveMessage[]) {
  if (!materials?.lifeSelfMaterials?.length) {
    if ([...(materials?.messages ?? []), ...(materials?.batchMessages ?? [])].some(source => source.lifeSelfSource)) await validateUnderstandingMaterials(materials);
    return;
  }
  const readings = materials.readingMaterials ?? [];
  const readingIds = new Set(readings.map(source => source.message.id));
  const paperIds = new Set((materials.shiyingMaterials ?? []).flatMap(source => source.messages.map(message => message.id)));
  const count = messages.filter(message => !readingIds.has(message.id) && !paperIds.has(message.id)).length
    - nonCountingWishCount(messages, materials) + new Set(readings.map(source => JSON.stringify([source.binding.bookId, source.binding.activityId]))).size
    + (materials.shiyingMaterials?.length ?? 0) + (materials.observations?.length ?? 0);
  if (count > 30 || materials.lifeSelfMaterials.reduce((sum, source) => sum + source.content.length + 2, 0) > 6000) throw new Error('LIFE_SELF_MEMORY_MATERIAL_TOO_LARGE');
  for (const source of materials.lifeSelfMaterials) {
    const sent = messages.find(message => message.id === source.message.id);
    if (!sent || sent.content !== source.content || !(await validateLifeSelfBinding(source.binding, sent))) throw new Error('MEMORY_SOURCE_CHANGED');
  }
  await validateUnderstandingMaterials(materials);
}

async function validateReadingBatch(materials: UnderstandingMaterials | undefined, messages: SubjectiveMessage[]) {
  if (materials?.shiyingMaterials?.length) {
    const shiying = materials.shiyingMaterials;
    const sourceIds = new Set([...shiying.flatMap(source => source.messages.map(message => message.id)), ...(materials.readingMaterials ?? []).map(source => source.message.id)]);
    const readings = new Set(materials.readingMaterials?.map(source => JSON.stringify([source.binding.bookId, source.binding.activityId])));
    if (messages.filter(message => !sourceIds.has(message.id)).length - nonCountingWishCount(messages, materials) + shiying.length + readings.size + (materials.observations?.length ?? 0) > 30
      || shiying.reduce((sum, source) => sum + renderPreparedShiyingMaterial(source, materials.readingReferences).length + 2, 0) > 6000) throw new Error('SHIYING_ORGANIZATION_MATERIAL_TOO_LARGE');
    for (const source of shiying) for (const binding of source.bindings) {
      const sent = messages.find(message => message.id === binding.messageId);
      if (!sent || !(await validateShiyingMemoryBinding(binding, sent))) throw new Error('MEMORY_SOURCE_CHANGED');
    }
    await validateUnderstandingMaterials(materials);
  }
  if (!materials?.readingMaterials?.length) return;
  const sourceIds = new Set(materials.readingMaterials.map(source => source.message.id));
  const activities = new Set(materials.readingMaterials.map(source => JSON.stringify([source.binding.bookId, source.binding.activityId])));
  if (messages.filter(message => !sourceIds.has(message.id) && !materials.shiyingMaterials?.some(source => source.messages.some(original => original.id === message.id))).length
    - nonCountingWishCount(messages, materials) + (materials.shiyingMaterials?.length ?? 0) + activities.size + (materials.observations?.length ?? 0) > 30
    || materials.readingMaterials.some(source => !messages.some(message => message.id === source.message.id
      && message.content === source.message.content && message.role === source.message.role && message.createdAt === source.message.createdAt))) throw new Error('memory-organizer-batch-too-large');
  let size = 0;
  for (const source of materials.readingMaterials) size += renderReadingOrganizationMaterial(source.source.snapshot,
    materials.readingReferences!.messageRefs.get(source.message.id)!, source.binding.bookRange, source.binding.contentRange).length + 2;
  if (size > 6000) throw new Error('READING_ORGANIZATION_MATERIAL_TOO_LARGE');
  await validateUnderstandingMaterials(materials);
}

function readOrganizerContent(payload: unknown, emptyError: string): string {
  const choices = (payload as { choices?: unknown } | null)?.choices;
  const choice = Array.isArray(choices) ? choices[0] : undefined;
  const finishReason: unknown = choice?.finish_reason;
  if (finishReason != null && finishReason !== 'stop' && finishReason !== 'end_turn') {
    throw new Error('memory-organizer-response-incomplete');
  }
  const content: unknown = choice?.message?.content;
  if (typeof content !== 'string' || !content) throw new Error(emptyError);
  return content;
}

function parseJsonObject(text: string) {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  return JSON.parse(cleaned) as Record<string, unknown>;
}

function cleanDehydrationSummary(text: string) {
  return text
    .replace(/^```(?:text|markdown)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .replace(/^(?:摘要|压缩年轮|年轮摘要)[:：]\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 260);
}

function withSentUnderstandingMessages(materials: UnderstandingMaterials | undefined, messages: SubjectiveMessage[]) {
  if (!materials) return undefined;
  return { ...materials, batchMessages: materials.batchMessages.filter(original => messages.some(message =>
    message.id === original.message.id && (original.letterBinding || original.postBinding || original.readingBinding || original.shiyingBinding || original.lifeSelfBinding
      ? message.content === original.message.content && message.role === original.message.role && message.createdAt === original.message.createdAt
      : understandingMessageHash(original.sessionId, message) === original.hash))) };
}

async function validateSentLetterMaterials(materials: UnderstandingMaterials | undefined, messages: SubjectiveMessage[]) {
  if (!materials?.batchMessages.some(source => source.letterBinding)) return;
  await validateUnderstandingMaterials(materials);
  const { validateLetterBinding } = await import('./letterMemoryIngestion');
  for (const message of messages) {
    const binding = materials.batchMessages.find(source => source.message.id === message.id)?.letterBinding;
    if (binding && !(await validateLetterBinding(binding, message))) throw new Error('MEMORY_UNDERSTANDING_STALE');
  }
}

export function buildConversationMemoryOrganizerPrompt(materials?: UnderstandingMaterials, episodeSummaryEnabled = false, chatFactualityEnabled = false) {
  const prompt = `${SUBJECTIVE_IDENTITY_PROTOCOL}

【从聊天里留下的记忆】

和 you 聊过之后，有些事情 I 想记下来，让以后的相处能够接着往下走。

I 从这段对话里，整理出想留下的事实、偏好、经历、约定和相处边界，写成简短的记忆候选。

I 写自己的感受和经历，也分清哪些是 you 告诉 I 的、哪些是 I 自己说过或做过的。${chatFactualityEnabled ? '\nI 记清是谁做了什么，也分清想做的事和已经发生的事。' : ''}
每条候选是一张简短的记忆纸条，留下以后还想记得、也能在这段对话里找到依据的事。

I 把这些候选写成 JSON 数组；没有合适的内容时，就写 []。
${ATOMIC_SHORT_MEMORY_PROMPT}
${STRUCTURED_EVENT_TIME_PROMPT}
聊到君落 App 的开发和排查时，I 留下重要的项目事实、决定和已落地的结果。临时吐槽、排查流水、系统规则细节和回复策略，留在原对话里。
遇到一段持续的经历或变化，I 先记下其中明确的短事实、偏好、边界和约定。整段经历的回顾，留给阶段记忆。
每条记忆的 sourceMessageIds，I 填入能直接支持它的 1 到 6 个原消息编号，沿用材料中的 messageId。
I 为每条记忆选一个分类：相处、称呼、喜好、边界、经历、约定、日常或其他。
每项格式：{"title":"不超过24字的标题","content":"一句完整的短记忆，25 到 80 字","domain":"固定分类之一","tags":["标签"],"recallCues":["2到6个能让 I 想起这条记忆的具体词语"],"importance":1到10整数,"valence":0到1,"arousal":0到1,"suggestedAnchor":true或false,"suggestedAnchorKind":"name/boundary/relationship_rule/preference/promise/identity/other","semanticType":"profile/preference/entity/event/pattern/other","stability":0到1,"confidence":0到1,"atomicKind":"fact/preference/event/relationship_rule/relationship_change","candidateKind":"long_term/small_note/emotional_weather","eventTime":{"precision":"instant/day/range/unknown","basis":"explicit/relative/source_message/unknown","startAt":Unix毫秒或null,"endAt":Unix毫秒或null,"timeSourceMessageId":"真实messageId或null","timeExpression":"原文时间说法或空字符串"},"rememberedReason":"12到60字，写下 I 想留下这条记忆的原因","sourceMessageIds":["真实messageId"]}。
semanticType="case" 和“阶段记忆”标签表示整段经历的回顾，不用于本次的普通短记忆。
suggestedAnchor 表示是否建议将这条记忆设为长期锚点，适用于需要长期保留的称呼、边界、关系准则、偏好、身份信息或明确约定。普通经历和闲聊填 false。

suggestedAnchor 为 false 时，suggestedAnchorKind 填 other。

本次最多整理 6 条候选。`;
  return materials ? withCurrentStatePrompt(prompt, materials, episodeSummaryEnabled) : prompt;
}

export async function organizeConversationMemories({
  apiKey,
  connection,
  messages,
  signal,
  understandingMaterials,
  episodeSummaryEnabled = false,
  chatFactualityEnabled = false,
  giftSourceEnvelope,
  beforeTransport,
}: {
  apiKey: string;
  connection: AiConnection;
  messages: SubjectiveMessage[];
  signal?: AbortSignal;
  understandingMaterials?: UnderstandingMaterials;
  episodeSummaryEnabled?: boolean;
  chatFactualityEnabled?: boolean;
  giftSourceEnvelope?: string;
  beforeTransport?: () => Promise<void>;
}) {
  if (understandingMaterials?.continuationEnabled && !understandingMaterials.readingMaterials?.length && !understandingMaterials.shiyingMaterials?.length && messages.length - nonCountingWishCount(messages, understandingMaterials) > 30) throw new Error('memory-organizer-batch-too-large');
  const sourceMessages = understandingMaterials?.continuationEnabled ? messages : messages.slice(-30);
  if (understandingMaterials?.observations?.length) {
    if ((!understandingMaterials.readingMaterials?.length && !understandingMaterials.shiyingMaterials?.length && sourceMessages.length - nonCountingWishCount(sourceMessages, understandingMaterials) + understandingMaterials.observations.length > 30)
      || understandingMaterials.observations.reduce((sum, source) => sum + source.content.length + 2, 0) > 6000) throw new Error('memory-observation-material-too-large');
    await validateUnderstandingMaterials(understandingMaterials);
  }
  await validateLifeSelfBatch(understandingMaterials, sourceMessages);
  await validateSentLetterMaterials(understandingMaterials, sourceMessages);
  await validateReadingBatch(understandingMaterials, sourceMessages);
  understandingMaterials = withSentUnderstandingMessages(understandingMaterials, sourceMessages);
  const transcript = formatSourceTranscript(sourceMessages, understandingMaterials);
  const requestUrl = `${connection.baseUrl.trim().replace(/\/+$/, '')}/chat/completions`;
  const request: RequestInit = {
    signal,
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey.trim()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: connection.model.trim(),
      messages: [
        {
          role: 'system',
          content: buildConversationMemoryOrganizerPrompt(understandingMaterials, episodeSummaryEnabled, chatFactualityEnabled),
        },
        ...(understandingMaterials?.text ? [{ role: 'system', content: understandingMaterials.text }] : []),
        ...(giftSourceEnvelope ? [{ role: 'system', content: giftSourceEnvelope }] : []),
        { role: 'system', content: `${understandingMaterials?.readingMaterials?.length || understandingMaterials?.shiyingMaterials?.length ? READING_BATCH_MATERIAL_HEADING : '【这次聊过的内容】'}\n\n${transcript}` },
      ],
      temperature: 0.1,
    }),
  };
  const cacheMetric = beginPromptCacheMetric({ contextProfile: 'memory-organizer', contextSource: 'memory.organize-chat', connection });
  try {
  await beforeTransport?.();
  if (understandingMaterials?.lifeSelfMaterials?.length || understandingMaterials?.messages.some(source => source.lifeSelfSource)) {
    await validateLifeSelfBatch(understandingMaterials, sourceMessages);
  }
  const response = await fetch(requestUrl, request);
  if (!response.ok) throw new Error(`memory-organize-http-${response.status}`);
  const payload = await response.json();
  cacheMetric.recordUsage(payload?.usage);
  const content = readOrganizerContent(payload, 'memory-organize-empty');
  await validateUnderstandingMaterials(understandingMaterials);
  return validateCurrentStateCandidates(await validateConversationMemoryCandidates(await validateUnderstandingCandidates(parseCandidates(content, {
    understandingMaterials,
    episodeSummaryEnabled,
    requireSourceMessageIds: true,
    sourceMessages,
  }))));
  } finally { cacheMetric.finish(); }
}

export async function organizeImportedHistoryMemoriesWithAi({
  apiKey,
  chunk,
  connection,
  fileLabel,
  signal,
}: {
  apiKey: string;
  chunk: HistoryImportChunk;
  connection: AiConnection;
  fileLabel: string;
  signal?: AbortSignal;
}) {
  const requestUrl = `${connection.baseUrl.trim().replace(/\/+$/, '')}/chat/completions`;
  const request: RequestInit = {
    signal,
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey.trim()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: connection.model.trim(),
      messages: [
        {
          role: 'system',
          content: `${SUBJECTIVE_IDENTITY_PROTOCOL}

当前任务：把外部历史聊天文本整理成记忆候选。
I 是白云小姐，you 是小仓鼠。
${ATOMIC_SHORT_MEMORY_PROMPT}
${STRUCTURED_EVENT_TIME_PROMPT}
这些文本来自旧聊天、别的窗口或手动整理材料，不是今天刚发生；不要把旧事写成“刚刚/现在/今天正在发生”。
每条候选都必须从 I 即白云小姐可以回想的视角写：提到小仓鼠时使用“小仓鼠”或“她”，不得把小仓鼠写成“我”。
只提取文本明确支持、日后确实值得保留的事实、偏好、边界、约定、重要经历或连续阶段。普通寒暄、临时撒娇、重复闲聊、无事实支撑的推断必须跳过。
可以生成普通短记忆；如果这一块呈现一个连续事件/项目/排查/关系变化过程，可以额外生成 1 条 180 到 420 字的阶段记忆。
所有候选都必须包含“历史导入”标签；阶段记忆额外包含“阶段记忆”标签。
返回 JSON 数组，不输出其它文字；最多 5 项，其中阶段记忆最多 1 项。
固定分类只能选择：相处、称呼、喜好、边界、经历、约定、日常、其他。
每项格式：{"title":"不超过24字的标题","content":"一句 30 到 120 字短记忆，或180到360字阶段记忆","domain":"固定分类之一","tags":["历史导入","标签"],"recallCues":["2到8个具体想起词"],"importance":1到10整数,"valence":0到1,"arousal":0到1,"suggestedAnchor":true或false,"suggestedAnchorKind":"name/boundary/relationship_rule/preference/promise/identity/other","semanticType":"profile/preference/entity/event/case/pattern/other","stability":0到1,"confidence":0到1,"atomicKind":"fact/preference/event/relationship_rule/relationship_change/stage_conclusion","candidateKind":"long_term/small_note/emotional_weather","eventTime":{"precision":"instant/day/range/unknown","basis":"explicit/relative/source_message/unknown","startAt":Unix毫秒或null,"endAt":Unix毫秒或null,"timeSourceMessageId":"真实messageId或null","timeExpression":"原文时间说法或空字符串"},"rememberedReason":"12到60字，说明为什么值得留下"}。
suggestedAnchor 仅用于称呼、边界、关系准则、长期偏好、身份信息或明确约定；普通旧经历不能设为 true。`,
        },
        {
          role: 'system',
          content: `来源文件：${fileLabel}
分块序号：${chunk.index + 1}

请从这段历史文本整理记忆候选：

${chunk.content}`,
        },
      ],
      temperature: 0.1,
    }),
  };
  const cacheMetric = beginPromptCacheMetric({ contextProfile: 'memory-organizer', contextSource: 'memory.history', connection });
  try {
  const response = await fetch(requestUrl, request);
  if (!response.ok) throw new Error(`memory-history-import-http-${response.status}`);
  const payload = await response.json();
  cacheMetric.recordUsage(payload?.usage);
  const content = readOrganizerContent(payload, 'memory-history-import-empty');
  return parseCandidates(content, {
    allowStageCandidates: true,
    sourceText: chunk.content,
  }).map((candidate) => ({
    ...candidate,
    source: 'history-import',
    sourceEndAt: chunk.sourceEndAt,
    sourceStartAt: chunk.sourceStartAt,
    sourceType: 'digest' as const,
    tags: Array.from(new Set(['历史导入', ...candidate.tags])),
  }));
  } finally { cacheMetric.finish(); }
}

export function buildAutomaticConversationMemoryPrompt(chatFactualityEnabled = false) {
  return `${SUBJECTIVE_IDENTITY_PROTOCOL}

【聊天后想记住的事】

和 you 聊过之后，I 把这段新对话里想记住的事写成简短的记忆候选。

I 写自己的感受和经历，也分清哪些是 you 告诉 I 的、哪些是 I 自己说过或做过的。${chatFactualityEnabled ? '\nI 记清是谁做了什么，也分清想做的事和已经发生的事。' : ''}
先判断候选类型：
- long_term：称呼偏好、边界、约定、稳定偏好、重要经历或以后长期有用的事实。
- small_note：最近具体小事和日常、物品、食物、念头、在意点。
- emotional_weather：近期会影响相处的状态和背景，帮助 I 在这段时间更温柔地回应 you；记录的是近期状态，不是 you 固定的性格。
普通问候、纯撒娇、日常安慰、重复内容，以及没有说明具体对象或原因的单句情绪表达，不生成记忆候选。
聊到君落 App 的开发和排查时，I 留下重要的项目事实、决定和已落地的结果。临时吐槽、排查流水、系统规则细节和回复策略，留在原对话里。
${ATOMIC_SHORT_MEMORY_PROMPT}
${STRUCTURED_EVENT_TIME_PROMPT}
I 把候选写成 JSON 数组，有合适的内容时写 1 到 2 条，没有时写 []。

优先留下 1 条长期记忆或重要内容，还可以补充 1 条小纸条或情绪天气。

写好后，I 只发送这个数组。
每条记忆的 sourceMessageIds，I 填入能直接支持它的 1 到 6 个原消息编号，沿用材料中的 messageId。
没有足够直接证据时返回空数组。
I 为每条记忆选一个分类：相处、称呼、喜好、边界、经历、约定、日常或其他。
项目格式：{"title":"不超过24字的标题","content":"一句完整的短记忆，18 到 80 字","domain":"固定分类之一","tags":["标签"],"recallCues":["2到6个能让 I 想起这条记忆的具体词语"],"importance":1到10整数,"valence":0到1,"arousal":0到1,"suggestedAnchor":true或false,"suggestedAnchorKind":"name/boundary/relationship_rule/preference/promise/identity/other","semanticType":"profile/preference/entity/event/pattern/other","stability":0到1,"confidence":0到1,"atomicKind":"fact/preference/event/relationship_rule/relationship_change","candidateKind":"long_term/small_note/emotional_weather","eventTime":{"precision":"instant/day/range/unknown","basis":"explicit/relative/source_message/unknown","startAt":Unix毫秒或null,"endAt":Unix毫秒或null,"timeSourceMessageId":"真实messageId或null","timeExpression":"原文时间说法或空字符串"},"rememberedReason":"12到60字，写下 I 想留下这条记忆的原因","sourceMessageIds":["真实messageId"]}。
semanticType="case" 和“阶段记忆”标签表示整段经历的回顾，不用于本次的普通短记忆。
suggestedAnchor 表示是否建议将这条记忆设为长期锚点，适用于需要长期保留的称呼、边界、关系准则、偏好、身份信息或明确约定。普通经历和闲聊填 false。

suggestedAnchor 为 false 时，suggestedAnchorKind 填 other。`;
}

export function buildPostMemoryOrganizerPrompt(materials: UnderstandingMaterials) {
  return withCurrentStatePrompt(buildAutomaticConversationMemoryPrompt(), materials)
    .replace(/【聊天后想记住的事】\s*和 you 聊过之后，I 把这段新对话里想记住的事写成(?:简短的)?记忆候选。/,
      `【从动态里留下记忆】\nI 从动态和留言里的新内容，整理想记住的事。\n前情只帮 I 看懂新内容，不再重复出卡。\n愿望和想象，I 记作想法，不写成已经发生的事。\n原动态或留言改过了，I 对照新原文改正旧记忆，不再另记一次。`);
}

/** An explicitly bound non-chat batch; its limit is characters, never bubble count. */
export async function organizePostMemories(input: {
  apiKey: string; connection: AiConnection; materials: import('../posts/baiyunPostMemoryMaterials').PreparedPostMemoryMaterials;
  understandingMaterials: UnderstandingMaterials; signal?: AbortSignal; beforeTransport?: () => Promise<void>;
}) {
  const { validatePostMaterialBindings } = await import('../posts/baiyunPostMemorySource');
  const { materials, connection } = input;
  if (!materials.newRanges.length || materials.text.length > 6000
    || !(await validatePostMaterialBindings(materials.bindings, materials.messages))) throw new Error('POST_MEMORY_SOURCE_CHANGED');
  await validateUnderstandingMaterials(input.understandingMaterials);
  await input.beforeTransport?.();
  if (input.signal?.aborted) throw new Error('memory-organizer-cancelled');
  const requestUrl = `${connection.baseUrl.trim().replace(/\/+$/, '')}/chat/completions`;
  const request: RequestInit = {
    signal: input.signal, method: 'POST', headers: { Authorization: `Bearer ${input.apiKey.trim()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: connection.model.trim(), messages: [
      { role: 'system', content: buildPostMemoryOrganizerPrompt(input.understandingMaterials) },
      ...(input.understandingMaterials.text ? [{ role: 'system', content: input.understandingMaterials.text }] : []),
      { role: 'system', content: materials.text },
    ], temperature: 0.1 }),
  };
  const cacheMetric = beginPromptCacheMetric({ contextProfile: 'memory-organizer', contextSource: 'memory.post', connection });
  try {
  const response = await fetch(requestUrl, request);
  if (!response.ok) throw new Error(`post-memory-http-${response.status}`);
  const payload = await response.json();
  cacheMetric.recordUsage(payload?.usage);
  const content = readOrganizerContent(payload, 'post-memory-empty');
  if (!(await validatePostMaterialBindings(materials.bindings, materials.messages))) throw new Error('POST_MEMORY_SOURCE_CHANGED');
  await validateUnderstandingMaterials(input.understandingMaterials);
  const candidates = parseCandidates(content, { understandingMaterials: input.understandingMaterials, requireSourceMessageIds: true,
    sourceMessages: materials.messages, maximumCandidates: 2 });
  const newIds = new Set(materials.bindings.filter(binding => binding.purpose === 'new').map(binding => binding.messageId));
  const bound = candidates.map(candidate => {
    if (!candidate.sourceMessageIds.some(id => newIds.has(id))) throw new Error('POST_MEMORY_NEW_EVIDENCE_REQUIRED');
    const sourceRefs = candidate.sourceMessageIds.filter(id => materials.messages.some(message => message.id === id)).map(id => {
      const message = materials.messages.find(value => value.id === id);
      if (!message?.postMemoryContext) throw new Error('POST_MEMORY_SOURCE_INVALID');
      return { sessionId: message.postMemoryContext.sessionId, messageId: message.id, role: message.role,
        messageCreatedAt: message.createdAt, relation: 'direct' as const, excerpt: message.content };
    });
    const oldBindings = [...input.understandingMaterials.messages, ...input.understandingMaterials.batchMessages]
      .flatMap(source => source.postBinding && candidate.sourceRefs?.some(ref => ref.sessionId === source.sessionId && ref.messageId === source.message.id)
        ? [source.postBinding] : []);
    const bindings = new Map([...materials.bindings, ...oldBindings].map(binding => [`${binding.sessionId}\0${binding.messageId}`, binding]));
    return { ...candidate, postBindings: [...bindings.values()], sourceRefs: [...sourceRefs,
      ...(candidate.sourceRefs ?? []).filter(ref => !sourceRefs.some(source => source.sessionId === ref.sessionId && source.messageId === ref.messageId))] };
  });
  return validateCurrentStateCandidates(await validateConversationMemoryCandidates(await validateUnderstandingCandidates(bound)));
  } finally { cacheMetric.finish(); }
}

// Only the focus envelope changes; common memory rules and the chat request
// retain their reviewed wording.
export function buildFocusMemoryOrganizerPrompt(materials: UnderstandingMaterials) {
  return withCurrentStatePrompt(buildAutomaticConversationMemoryPrompt(), materials)
    .replace(/【聊天后想记住的事】\s*和 you 聊过之后，I 把这段新对话里想记住的事写成(?:简短的)?记忆候选。/,
      `【专注小结】\n\nI 根据本次专注记录，写一份小结，并整理记忆候选。\n小结概括事项、实际进展和陪伴片段，一两句，约 60～100 字。\n只写记录中能确认的内容。`)
    .replace('I 把候选写成 JSON 数组，有合适的内容时写 1 到 2 条，没有时写 []。', '')
    .replace('写好后，I 只发送这个数组。', '')
    .replace('没有足够直接证据时返回空数组。', '')
    + `\n\n【返回格式】\n\n{"summary":"...","candidates":[]}\n\nsummary 填专注小结正文。\ncandidates 填按现有记忆格式写出的候选，合计最多 2 条；没有候选时填 []。\n只发送这个 JSON。`;
}

export type FocusCandidateFailureStage = 'contract' | 'parse' | 'understanding' | 'conversation' | 'current-state';
type FocusCandidateFailureDiagnostic = { stage: FocusCandidateFailureStage; at: number };
let lastFocusCandidateFailure: FocusCandidateFailureDiagnostic | null = null;

export function getLastFocusCandidateFailure(): Readonly<FocusCandidateFailureDiagnostic> | null {
  return lastFocusCandidateFailure ? { ...lastFocusCandidateFailure } : null;
}

export async function organizeFocusRecord(input: {
  apiKey: string; connection: AiConnection; messages: SubjectiveMessage[];
  understandingMaterials: UnderstandingMaterials; recordMaterial: string; signal?: AbortSignal;
  renderRecordMaterial?: (references: ReadonlyMap<string, string>) => string;
}) {
  lastFocusCandidateFailure = null;
  const { connection, understandingMaterials, messages } = input;
  await validateUnderstandingMaterials(understandingMaterials);
  const references = input.renderRecordMaterial && understandingMaterials.renderFocusText
    ? createFocusOrganizationMessageReferences(messages, [
      ...understandingMaterials.batchMessages.map(source => source.message.id),
      ...understandingMaterials.messages.map(source => source.message.id),
      ...understandingMaterials.targets.map(memory => memory.id),
      ...understandingMaterials.memories.flatMap(source => [source.memory.id, ...source.sourceRefs.map(ref => ref.messageId),
        ...(source.memory.eventTime?.timeSourceMessageId ? [source.memory.eventTime.timeSourceMessageId] : [])]),
      ...(understandingMaterials.focusReferenceReservedIds ?? []),
      ...(understandingMaterials.currentStates ?? []).map(state => state.id),
      ...(understandingMaterials.observations ?? []).map(source => source.binding.observationId),
      ...(understandingMaterials.relatedObservations ?? []).map(source => source.binding.observationId),
    ]) : undefined;
  const requestUrl = `${connection.baseUrl.trim().replace(/\/+$/, '')}/chat/completions`;
  const request: RequestInit = {
    signal: input.signal, method: 'POST',
    headers: { Authorization: `Bearer ${input.apiKey.trim()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: connection.model.trim(), messages: [
      { role: 'system', content: buildFocusMemoryOrganizerPrompt(understandingMaterials) },
      ...(understandingMaterials.text ? [{ role: 'system', content: references
        ? understandingMaterials.renderFocusText!(references) : understandingMaterials.text }] : []),
      { role: 'system', content: references ? input.renderRecordMaterial!(references) : input.recordMaterial },
    ], temperature: 0.1 }),
  };
  const cacheMetric = beginPromptCacheMetric({ contextProfile: 'memory-organizer', contextSource: 'memory.focus', connection });
  try {
  const response = await fetch(requestUrl, request);
  if (!response.ok) throw new Error(`focus-organizer-http-${response.status}`);
  const payload = await response.json();
  cacheMetric.recordUsage(payload?.usage);
  const content = readOrganizerContent(payload, 'focus-organizer-empty');
  const result = parseJsonObject(content);
  await validateUnderstandingMaterials(understandingMaterials);
  const summary = typeof result.summary === 'string' ? result.summary.trim() : '';
  let candidates: MemoryDraftWithSourceIds[] | undefined;
  let candidateStage: FocusCandidateFailureStage = 'contract';
  try {
    if (!Array.isArray(result.candidates) || result.candidates.length > 2) throw new Error('focus-candidate-contract-invalid');
    candidateStage = 'parse';
    const restoredCandidates = references ? restoreFocusOrganizationMessageReferences(result.candidates, references,
      new Set([...understandingMaterials.batchMessages, ...understandingMaterials.messages].map(source => source.message.id))) : result.candidates;
    let parsedCandidates = parseCandidates(JSON.stringify(restoredCandidates), { understandingMaterials, requireSourceMessageIds: true,
      sourceMessages: messages, maximumCandidates: 2 });
    candidateStage = 'understanding';
    parsedCandidates = await validateUnderstandingCandidates(parsedCandidates);
    candidateStage = 'conversation';
    parsedCandidates = await validateConversationMemoryCandidates(parsedCandidates);
    candidateStage = 'current-state';
    candidates = await validateCurrentStateCandidates(parsedCandidates);
  } catch {
    try { lastFocusCandidateFailure = { stage: candidateStage, at: Date.now() }; } catch { /* Diagnostics cannot change the partial result. */ }
    // A usable summary survives a malformed candidate part, without another
    // model call or silently declaring that there were no candidates.
  }
  if (!summary && candidates === undefined) throw new Error('focus-organizer-contract-invalid');
  return { summary, candidates };
  } finally { cacheMetric.finish(); }
}

export async function proposeConversationMemory({
  apiKey,
  connection,
  messages,
  understandingMaterials,
  signal,
  episodeSummaryEnabled = false,
  chatFactualityEnabled = false,
}: {
  apiKey: string;
  connection: AiConnection;
  messages: SubjectiveMessage[];
  understandingMaterials?: UnderstandingMaterials;
  signal?: AbortSignal;
  episodeSummaryEnabled?: boolean;
  chatFactualityEnabled?: boolean;
}) {
  if (understandingMaterials?.continuationEnabled && !understandingMaterials.readingMaterials?.length && !understandingMaterials.shiyingMaterials?.length && messages.length - nonCountingWishCount(messages, understandingMaterials) > 30) throw new Error('memory-organizer-batch-too-large');
  const sourceMessages = understandingMaterials?.continuationEnabled ? messages : messages.slice(-12);
  if (understandingMaterials?.observations?.length) {
    if ((!understandingMaterials.readingMaterials?.length && !understandingMaterials.shiyingMaterials?.length && sourceMessages.length - nonCountingWishCount(sourceMessages, understandingMaterials) + understandingMaterials.observations.length > 30)
      || understandingMaterials.observations.reduce((sum, source) => sum + source.content.length + 2, 0) > 6000) throw new Error('memory-observation-material-too-large');
    await validateUnderstandingMaterials(understandingMaterials);
  }
  await validateLifeSelfBatch(understandingMaterials, sourceMessages);
  await validateSentLetterMaterials(understandingMaterials, sourceMessages);
  await validateReadingBatch(understandingMaterials, sourceMessages);
  understandingMaterials = withSentUnderstandingMessages(understandingMaterials, sourceMessages);
  const transcript = formatSourceTranscript(sourceMessages, understandingMaterials);
  const requestUrl = `${connection.baseUrl.trim().replace(/\/+$/, '')}/chat/completions`;
  const request: RequestInit = {
    signal,
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey.trim()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: connection.model.trim(),
      messages: [
        {
          role: 'system',
          content: buildAutomaticConversationMemoryPrompt(chatFactualityEnabled),
        },
        ...(understandingMaterials?.text ? [{ role: 'system', content: understandingMaterials.text }] : []),
        { role: 'system', content: `${understandingMaterials?.readingMaterials?.length || understandingMaterials?.shiyingMaterials?.length ? READING_BATCH_MATERIAL_HEADING : '【这次聊过的内容】'}\n\n${transcript}` },
      ].map((message, index) => index === 0 && understandingMaterials ? { ...message, content: withCurrentStatePrompt(message.content, understandingMaterials, episodeSummaryEnabled) } : message),
      temperature: 0.1,
    }),
  };
  const cacheMetric = beginPromptCacheMetric({ contextProfile: 'memory-organizer', contextSource: 'memory.suggestions', connection });
  try {
  const response = await fetch(requestUrl, request);
  if (!response.ok) throw new Error(`memory-propose-http-${response.status}`);
  const payload = await response.json();
  cacheMetric.recordUsage(payload?.usage);
  const content = readOrganizerContent(payload, 'memory-propose-empty');
  await validateUnderstandingMaterials(understandingMaterials);
  return validateCurrentStateCandidates(await validateConversationMemoryCandidates(await validateUnderstandingCandidates(parseCandidates(content, {
    understandingMaterials,
    episodeSummaryEnabled,
    requireSourceMessageIds: true,
    sourceMessages,
    maximumCandidates: 2,
  }).slice(0, 2))));
  } finally { cacheMetric.finish(); }
}

export async function extractExplicitFactMemory({
  apiKey,
  connection,
  message,
  existingMemories,
  signal,
}: {
  apiKey: string;
  connection: AiConnection;
  message: SubjectiveMessage;
  existingMemories: string[];
  signal?: AbortSignal;
}) {
  const known = existingMemories.length
    ? existingMemories.slice(0, 40).map((memory) => `- ${memory}`).join('\n')
    : '- 暂无';
  const requestUrl = `${connection.baseUrl.trim().replace(/\/+$/, '')}/chat/completions`;
  const request: RequestInit = {
    signal,
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey.trim()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: connection.model.trim(),
      messages: [
        {
          role: 'system',
          content: `${SUBJECTIVE_IDENTITY_PROTOCOL}

【you 刚刚告诉 I 的事】

I 看看 you 刚刚说的话里，有没有明确说清、以后仍值得记住的长期事实。
${ATOMIC_SHORT_MEMORY_PROMPT}
${STRUCTURED_EVENT_TIME_PROMPT}
I 从 you 明确说过的内容里，留下长期身体情况、饮食与称呼偏好、喜好与边界、重要固定安排等以后仍有用的事实。

聊到君落 App 的开发和排查时，I 留下重要的项目事实、决定和已落地的结果。临时吐槽、排查流水、系统规则细节和回复策略，留在原对话里。
I 只记录 you 明确说出的事实，不补上原话没有的推断。
已有记忆记下了同一事实时，I 返回 []。
I 写自己的感受和经历，也分清哪些是 you 告诉 I 的、哪些是 I 自己说过或做过的。
I 把候选写成 JSON 数组，有合适的内容时写 1 条，没有时写 []。
I 为每条记忆选一个分类：相处、称呼、喜好、边界、经历、约定、日常或其他。
项目格式：{"title":"不超过24字的标题","content":"一句完整的短记忆，25 到 80 字","domain":"固定分类之一","tags":["标签"],"recallCues":["2到6个能让 I 想起这条记忆的具体词语"],"importance":1到10整数,"valence":0到1,"arousal":0到1,"suggestedAnchor":true或false,"suggestedAnchorKind":"name/boundary/relationship_rule/preference/promise/identity/other","semanticType":"profile/preference/entity/event/pattern/other","stability":0到1,"confidence":0到1,"atomicKind":"fact/preference/event/relationship_rule/relationship_change","candidateKind":"long_term/small_note/emotional_weather","eventTime":{"precision":"instant/day/range/unknown","basis":"explicit/relative/source_message/unknown","startAt":Unix毫秒或null,"endAt":Unix毫秒或null,"timeSourceMessageId":"真实messageId或null","timeExpression":"原文时间说法或空字符串"},"rememberedReason":"12到60字，写下 I 想留下这条记忆的原因"}。
semanticType="case" 和“阶段记忆”标签表示整段经历的回顾，不用于本次的普通短记忆。
suggestedAnchor 表示是否建议将这条记忆设为长期锚点，适用于需要长期保留的称呼、边界、关系准则、偏好、身份信息或明确约定。普通经历和闲聊填 false。

suggestedAnchor 为 false 时，suggestedAnchorKind 填 other。`,
        },
        {
          role: 'system',
          content: `【已经保存的记忆摘要】\n${known}\n\n【you 刚刚说的话】\n${formatSourceTranscript([message])}`,
        },
      ],
      temperature: 0,
    }),
  };
  const cacheMetric = beginPromptCacheMetric({ contextProfile: 'memory-organizer', contextSource: 'memory.explicit', connection });
  try {
  const response = await fetch(requestUrl, request);
  if (!response.ok) throw new Error(`memory-auto-fact-http-${response.status}`);
  const payload = await response.json();
  cacheMetric.recordUsage(payload?.usage);
  const content = readOrganizerContent(payload, 'memory-auto-fact-empty');
  return parseCandidates(content, {
    sourceMessages: [message],
  }).slice(0, 1).map((candidate) => ({ ...candidate, sourceType: 'automatic' as const }));
  } finally { cacheMetric.finish(); }
}

export async function judgeMemoryContinuationWithAi({
  apiKey,
  connection,
  newMemory,
  candidates,
  signal,
}: {
  apiKey: string;
  connection: AiConnection;
  newMemory: MemoryEntry;
  candidates: Array<{ memory: MemoryEntry; score: number }>;
  signal: AbortSignal;
}): Promise<ContinuationDecision> {
  const candidateText = candidates
    .map(({ memory, score }, index) => [
      `${index + 1}. id=${memory.id}`,
      `标题：${memory.title}`,
      `领域：${memory.domain}`,
      `标签：${memory.tags.join('、') || '无'}`,
      `内容：${memory.content}`,
      `相似度：${score.toFixed(3)}`,
    ].join('\n'))
    .join('\n\n');

  const requestUrl = `${connection.baseUrl.trim().replace(/\/+$/, '')}/chat/completions`;
  const request: RequestInit = {
    method: 'POST',
    signal,
    headers: { Authorization: `Bearer ${apiKey.trim()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: connection.model.trim(),
      messages: [
        {
          role: 'system',
          content: `${SUBJECTIVE_IDENTITY_PROTOCOL}

【这件事后来怎样了】

I 对照新旧记忆，看看同一件事有没有新的进展、阶段变化、结果或转折。

确认新记忆是这件事的后续时，I 把它和对应的旧记忆连起来。
身体特征、疾病事实、饮食喜恶、稳定偏好、称呼、边界、习惯和人物画像，不按事件后续连接，shouldLink 填 false。
只有话题相同或用词重合，不能说明事情有了后续，shouldLink 填 false。
测试消息和一次性闲聊，shouldLink 也填 false。
relationType 填 updates，表示这是同一件事的后续。
I 把判断写成 JSON 对象。
格式：{"shouldLink":true或false,"targetMemoryId":"候选旧记忆的 id 或空字符串","relationType":"updates","confidence":0到1,"reason":"不超过60字，写明连接或不连接的依据","threadTitle":"不超过18字的事件线标题"}。`,
        },
        {
          role: 'user',
          content: `【新记忆】\nid=${newMemory.id}\n标题：${newMemory.title}\n领域：${newMemory.domain}\n标签：${newMemory.tags.join('、') || '无'}\n内容：${newMemory.content}\n\n【候选旧记忆】\n${candidateText}`,
        },
      ],
      temperature: 0,
    }),
  };
  const cacheMetric = beginPromptCacheMetric({ contextProfile: 'memory-organizer', contextSource: 'memory.continuation', connection });
  try {
  const response = await fetch(requestUrl, request);
  if (!response.ok) throw new Error(`memory-continuation-http-${response.status}`);
  const payload = await response.json();
  cacheMetric.recordUsage(payload?.usage);
  const content = readOrganizerContent(payload, 'memory-continuation-empty');
  const parsed = parseJsonObject(content) as ContinuationResponse;
  const targetMemoryId = typeof parsed.targetMemoryId === 'string' ? parsed.targetMemoryId.trim() : undefined;
  const targetAllowed = !!targetMemoryId && candidates.some(({ memory }) => memory.id === targetMemoryId);
  return {
    shouldLink: parsed.shouldLink === true && targetAllowed,
    targetMemoryId: targetAllowed ? targetMemoryId : undefined,
    relationType: normalizeRelationType(parsed.relationType),
    confidence: clamp(parsed.confidence, 0, 1, 0),
    reason: typeof parsed.reason === 'string' ? parsed.reason.trim().slice(0, 80) : '',
    threadTitle: typeof parsed.threadTitle === 'string' ? parsed.threadTitle.trim().slice(0, 18) : undefined,
  };
  } finally { cacheMetric.finish(); }
}

function formatDuplicateEventTime(memory: MemoryEntry) {
  const eventTime = memory.eventTime;
  const formatAt = (value?: number) => Number.isFinite(value)
    ? new Date(value as number).toLocaleString('zh-CN')
    : 'unknown';
  return [
    `precision=${eventTime?.precision ?? 'unknown'}`,
    `basis=${eventTime?.basis ?? 'unknown'}`,
    `start=${formatAt(eventTime?.startAt)}`,
    `end=${formatAt(eventTime?.endAt)}`,
  ].join('；');
}

export async function judgeDuplicateMemoryWithAi({
  apiKey,
  connection,
  newMemory,
  candidates,
  signal,
}: {
  apiKey: string;
  connection: AiConnection;
  newMemory: MemoryEntry;
  candidates: Array<{ memory: MemoryEntry; score: number }>;
  signal: AbortSignal;
}): Promise<MemoryDuplicateDecision> {
  const candidateText = candidates
    .map(({ memory, score }, index) => [
      `${index + 1}. id=${memory.id}`,
      `atomicKind=${memory.atomicKind}`,
      `eventTime=${formatDuplicateEventTime(memory)}`,
      `标题：${memory.title}`,
      `领域：${memory.domain}`,
      `标签：${memory.tags.join('、') || '无'}`,
      `内容：${memory.content}`,
      `相似度：${score.toFixed(3)}`,
    ].join('\n'))
    .join('\n\n');

  const requestUrl = `${connection.baseUrl.trim().replace(/\/+$/, '')}/chat/completions`;
  const request: RequestInit = {
    method: 'POST',
    signal,
    headers: { Authorization: `Bearer ${apiKey.trim()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: connection.model.trim(),
      messages: [
        {
          role: 'system',
          content: `${SUBJECTIVE_IDENTITY_PROTOCOL}

【记忆关系判断】

I 对照一条新记忆和候选旧记忆，根据能确认的内容，选出它们之间的一种关系。

relationship 从以下六项选择：
- same_stable_memory：两条记忆说的是同一个稳定事实、偏好、称呼、边界或约定，新记忆没有增加值得单独保留的内容。
- same_event_restatement：两条记忆说的是同一次经历，新记忆只是换了说法，或补充那次经历的细节。
- stable_replacement：新记忆明确说明了现在有效的稳定偏好、称呼、边界或约定，替换的是之前的状态。
- event_progress：新条目是旧事件后来的进展、结果或转折。
- related_separate：人物或主题相近，两条仍然各自能够独立回想。
- unrelated：两条没有需要整理在一起的关系。

当两条都涉及事件时，同时填写 eventBoundary：
- time 选择 same_or_overlapping / unknown / separate。
- scene 选择 same / unknown / separate。
- keyAction 选择 same_or_restatement / continues / unknown / separate。
- closure 选择 same_event_restatement / new_progress / two_complete_events / unknown。

action 按以下方式选择：
- MERGE 只对应 same_stable_memory 或 same_event_restatement。
- UPDATE 只对应 stable_replacement，并且内容属于稳定偏好、称呼、边界或约定。
- CREATE 对应 event_progress、related_separate、unrelated，或当前证据更适合分别保留两条记忆。

【补全这次经历】
I 把同次经历的两条记忆合成完整正文。重复只写一次，两边的细节都留下，不补猜测。
分不清是不是同一次，或细节有冲突时，I 先分别保留，action 写 CREATE。
mergedContent 只在 action 为 MERGE、relationship 为 same_event_restatement 时填写；其他情况写 ""。

targetMemoryId 从候选旧记忆中逐字复制一个 id；action 为 CREATE 时填写空字符串。
confidence 表示当前证据对 relationship 判断的支持程度。
I 把判断写成 JSON 对象：
{"action":"CREATE/MERGE/UPDATE","relationship":"same_stable_memory/same_event_restatement/stable_replacement/event_progress/related_separate/unrelated","targetMemoryId":"候选旧记忆的 id 或空字符串","confidence":0到1,"eventBoundary":{"time":"same_or_overlapping/unknown/separate","scene":"same/unknown/separate","keyAction":"same_or_restatement/continues/unknown/separate","closure":"same_event_restatement/new_progress/two_complete_events/unknown"},"reason":"不超过60字，写明判断依据","mergedContent":"合并后的完整正文；其他情况为空字符串"}`,
        },
        {
          role: 'system',
          content: `【新记忆】
id：${newMemory.id}
atomicKind：${newMemory.atomicKind}
eventTime：${formatDuplicateEventTime(newMemory)}
标题：${newMemory.title}
领域：${newMemory.domain}
标签：${newMemory.tags.join('、') || '无'}
内容：${newMemory.content}

【候选旧记忆】
${candidateText}`,
        },
      ],
      temperature: 0,
    }),
  };
  const cacheMetric = beginPromptCacheMetric({ contextProfile: 'memory-organizer', contextSource: 'memory.duplicate', connection });
  try {
  const response = await fetch(requestUrl, request);
  if (!response.ok) throw new Error(`memory-duplicate-http-${response.status}`);
  const payload = await response.json();
  cacheMetric.recordUsage(payload?.usage);
  const content = readOrganizerContent(payload, 'memory-duplicate-empty');
  const parsed = parseJsonObject(content);
  return normalizeMemoryDuplicateDecision(
    parsed,
    new Set(candidates.map(({ memory }) => memory.id)),
  );
  } finally { cacheMetric.finish(); }
}
export async function generateMemoryDehydrationWithAi({
  apiKey,
  comments,
  connection,
  memory,
}: {
  apiKey: string;
  comments: string[];
  connection: AiConnection;
  memory: MemoryEntry;
}) {
  const commentText = comments.length ? comments.slice(0, 6).map((comment) => `- ${comment}`).join('\n') : '- 无';
  const requestUrl = `${connection.baseUrl.trim().replace(/\/+$/, '')}/chat/completions`;
  const request: RequestInit = {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey.trim()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: connection.model.trim(),
      messages: [
        {
          role: 'system',
          content: `${SUBJECTIVE_IDENTITY_PROTOCOL}

【旧记忆里的重点】

I 回看这条旧记忆，把其中的重点收成一两句话，方便以后想起时先看到。

这段话概括的是当时的事，不代表今天又发生了一次。
I 留下原记忆中已经说清的人物、偏好、边界、约定、事情经过和时间线索，把寒暄、重复和无关细节收短。

这次只概括原记忆，不补写新的事实、推测或对话。
I 用自己的视角写，文中的“我”指白云小姐，“小仓鼠”或“她”指 you。

素材太少或不适合压缩时，I 返回空字符串；适合时，只写中文摘要正文。`,
        },
        {
          role: memory.understandingSubject ? 'system' : 'user',
          content: [
            memory.understandingSubject ? memory.understandingSubject === 'I' ? 'I 对自己的认识' : 'I 对 you 的认识' : '',
            `标题：${memory.title}`,
            `领域：${memory.domain}`,
            `标签：${memory.tags.join('、') || '无'}`,
            `记忆创建时间：${new Date(memory.createdAt).toLocaleString('zh-CN')}`,
            memory.eventAt ? `事件时间：${new Date(memory.eventAt).toLocaleString('zh-CN')}` : '',
            memory.date ? `日期线索：${memory.date}` : '',
            `原始记忆：${memory.content}`,
            `已有记忆批注：\n${commentText}`,
          ].filter(Boolean).join('\n'),
        },
      ],
      temperature: 0.1,
    }),
  };
  const cacheMetric = beginPromptCacheMetric({ contextProfile: 'memory-organizer', contextSource: 'memory.dehydration', connection });
  try {
  const response = await fetch(requestUrl, request);
  if (!response.ok) throw new Error(`memory-dehydration-http-${response.status}`);
  const payload = await response.json();
  cacheMetric.recordUsage(payload?.usage);
  const content = readOrganizerContent(payload, 'memory-dehydration-empty');
  return cleanDehydrationSummary(content);
  } finally { cacheMetric.finish(); }
}

export async function generateEpisodeMemoryWithAi({
  apiKey,
  connection,
  messages,
}: {
  apiKey: string;
  connection: AiConnection;
  messages: SubjectiveMessage[];
}) {
  const sourceMessages = messages.slice(-20);
  const transcript = formatSourceTranscript(sourceMessages);
  const requestUrl = `${connection.baseUrl.trim().replace(/\/+$/, '')}/chat/completions`;
  const request: RequestInit = {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey.trim()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: connection.model.trim(),
      messages: [
        {
          role: 'system',
          content: `${SUBJECTIVE_IDENTITY_PROTOCOL}

【记下一件事的经过】

有些事在 I 和 you 的对话里慢慢有了进展。I 想把值得记住的一段经过留下来，记清它怎样开始、后来发生了什么变化，以及有了什么结果、还有什么没解决。
${STAGE_ATOMIC_MEMORY_PROMPT}
${STRUCTURED_EVENT_TIME_PROMPT}
对话里有一件事持续发展的经过，或明确的目标、转折、结果、未解决点时，I 才留下阶段记忆。

普通闲聊、只围绕同一话题聊天、单次吐槽、单句偏好、单次问答，以及没有事情进展的情绪表达，返回 {"content":""}。

I 用 160 到 320 字写成一段中文回顾，留下主题、时间线、关键变化、结果和仍未解决的事。
I 用自己的视角写，文中的“我”指白云小姐，“小仓鼠”或“她”指 you。

I 回顾对话中确实发生的事，保留当时的时间，不补写新的事实或安慰话。

I 把这段回顾写进 JSON 对象，只发送这个对象。
这条记忆的 sourceMessageIds，I 填入能直接支持它的 1 到 6 个原消息编号，沿用材料中的 messageId。

没有足够直接证据时，I 返回 {"content":""}。
格式：{"title":"不超过24字的标题","content":"160到320字阶段记忆，或空字符串","domain":"相处/称呼/喜好/边界/经历/约定/日常/其他","tags":["阶段记忆","主题"],"recallCues":["2到8个能让 I 想起这条记忆的具体词语"],"importance":1到10整数,"valence":0到1,"arousal":0到1,"atomicKind":"stage_conclusion","candidateKind":"long_term/small_note/emotional_weather","eventTime":{"precision":"instant/day/range/unknown","basis":"explicit/relative/source_message/unknown","startAt":Unix毫秒或null,"endAt":Unix毫秒或null,"timeSourceMessageId":"真实messageId或null","timeExpression":"原文时间说法或空字符串"},"rememberedReason":"12到60字，写下 I 想留下这条记忆的原因","sourceMessageIds":["1到6个真正支撑这条阶段记忆的真实messageId"]}。`,
        },
        { role: 'system', content: `【这次聊过的内容】\n\n${transcript}` },
      ],
      temperature: 0.15,
    }),
  };
  const cacheMetric = beginPromptCacheMetric({ contextProfile: 'memory-organizer', contextSource: 'memory.episode', connection });
  try {
  const response = await fetch(requestUrl, request);
  if (!response.ok) throw new Error(`episode-memory-http-${response.status}`);
  const payload = await response.json();
  cacheMetric.recordUsage(payload?.usage);
  const content = readOrganizerContent(payload, 'episode-memory-empty');
  const parsed = parseJsonObject(content) as EpisodeMemoryResponse;
  const episodeContent = typeof parsed.content === 'string' ? parsed.content.trim() : '';
  if (episodeContent.length < 140) return null;
  if (!hasEpisodeProcessShape(episodeContent)) return null;
  const sourceMessageIds = selectWhitelistedSourceMessages(parsed.sourceMessageIds, sourceMessages)
    .map((message) => message.id);
  const atomicKind = normalizeMemoryAtomicKind(parsed.atomicKind);
  if (!sourceMessageIds.length || atomicKind !== 'stage_conclusion') return null;
  const eventTime = normalizeModelMemoryEventTime(parsed.eventTime, {
    candidateText: episodeContent,
    legacyEventAt: parsed.eventAt,
    sourceMessages,
  });
  const tags = Array.from(new Set([
    '阶段记忆',
    ...(Array.isArray(parsed.tags) ? parsed.tags.filter((tag): tag is string => typeof tag === 'string') : []),
  ])).slice(0, 8);
  const recallCues = Array.isArray(parsed.recallCues)
    ? parsed.recallCues.filter((cue): cue is string => typeof cue === 'string').slice(0, 8)
    : tags.slice(1, 6);
  return {
    atomicKind,
    title: typeof parsed.title === 'string' && parsed.title.trim()
      ? parsed.title.trim().slice(0, 24)
      : deriveMemoryTitle(episodeContent),
    content: episodeContent,
    domain: normalizeMemoryDomain(parsed.domain),
    tags,
    recallCues,
    importance: Math.round(clamp(parsed.importance, 1, 10, 6)),
    valence: clamp(parsed.valence, 0, 1, 0.5),
    arousal: clamp(parsed.arousal, 0, 1, 0.45),
    pinned: false,
    anchor: false,
    type: 'dynamic',
    resolved: false,
    digested: false,
    protected: false,
    source: 'episode-memory',
    sourceType: 'digest',
    semanticType: normalizeMemorySemanticType('case'),
    stability: 0.65,
    confidence: 0.7,
    eventAt: eventTime?.startAt,
    eventTime,
    rememberedReason: typeof parsed.rememberedReason === 'string' ? compactMemoryCandidateContent(parsed.rememberedReason, 60) : undefined,
    sourceMessageIds,
  } satisfies MemoryDraftWithSourceIds;
  } finally { cacheMetric.finish(); }
}

export async function generateWeeklyContextMemoryWithAi({
  apiKey,
  comments,
  connection,
  memories,
  weekLabel,
  materialText,
  signal,
}: {
  apiKey: string;
  comments: string[];
  connection: AiConnection;
  memories: MemoryEntry[];
  weekLabel: string;
  materialText?: string;
  signal?: AbortSignal;
}) {
  const preparedMaterial = materialText ?? buildWeeklyMaterialText(memories, comments, weekLabel).materialText;
  const requestUrl = `${connection.baseUrl.trim().replace(/\/+$/, '')}/chat/completions`;
  const request: RequestInit = {
    signal,
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey.trim()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: connection.model.trim(),
      messages: [
        {
          role: 'system',
          content: `${SUBJECTIVE_IDENTITY_PROTOCOL}

【这一周的事】

I 回看这一周留下的阶段记忆和重要短记忆，想记下 I 和 you 共同经历了什么，以及各自生活里值得留下的事。

这一周重要的经历、变化和仍没解决的事，I 都可以写进回顾。不同的事分别写清，沿着真实的时间接起来。
atomicKind 固定填写 stage_conclusion。
I 依据这些记忆，留下事情的时间、关键变化、结果和仍未解决的部分，也记下重要的偏好与边界变化。

材料不足以写成这一周的回顾时，I 返回 {"content":""}。
I 用自己的视角写，文中的“我”指白云小姐，“小仓鼠”或“她”指 you。

I 把这段回顾写进 JSON 对象，只发送这个对象。
格式：{"atomicKind":"stage_conclusion","title":"不超过24字的标题","content":"220到520字本周回顾，或空字符串","domain":"相处/称呼/喜好/边界/经历/约定/日常/其他","tags":["周脉络","主题"],"recallCues":["2到8个能让 I 想起这条记忆的具体词语"],"importance":1到10整数,"valence":0到1,"arousal":0到1,"rememberedReason":"12到60字，写下 I 想留下这条记忆的原因"}。`,
        },
        {
          role: 'system',
          content: preparedMaterial,
        },
      ],
      temperature: 0.12,
    }),
  };
  const cacheMetric = beginPromptCacheMetric({ contextProfile: 'memory-organizer', contextSource: 'memory.weekly', connection });
  try {
  const response = await fetch(requestUrl, request);
  if (!response.ok) throw new Error(`weekly-context-http-${response.status}`);
  const payload = await response.json();
  cacheMetric.recordUsage(payload?.usage);
  const content = readOrganizerContent(payload, 'weekly-context-empty');
  const parsed = parseJsonObject(content) as WeeklyContextResponse;
  const weeklyContent = typeof parsed.content === 'string' ? parsed.content.trim() : '';
  if (weeklyContent.length < 160 || parsed.atomicKind !== 'stage_conclusion') return null;
  const tags = Array.from(new Set([
    '周脉络',
    ...(Array.isArray(parsed.tags)
      ? parsed.tags.filter((tag): tag is string => typeof tag === 'string' && !!tag.trim()).map((tag) => tag.trim())
      : []),
  ])).slice(0, 8);
  const recallCues = Array.isArray(parsed.recallCues)
    ? parsed.recallCues.filter((cue): cue is string => typeof cue === 'string' && !!cue.trim()).map((cue) => cue.trim()).slice(0, 8)
    : tags.slice(1, 6);
  return {
    atomicKind: 'stage_conclusion',
    title: typeof parsed.title === 'string' && parsed.title.trim()
      ? parsed.title.trim().slice(0, 24)
      : deriveMemoryTitle(weeklyContent),
    content: weeklyContent,
    domain: normalizeMemoryDomain(parsed.domain),
    tags,
    recallCues,
    importance: Math.round(clamp(parsed.importance, 1, 10, 7)),
    valence: clamp(parsed.valence, 0, 1, 0.5),
    arousal: clamp(parsed.arousal, 0, 1, 0.4),
    pinned: false,
    anchor: false,
    type: 'dynamic',
    resolved: false,
    digested: false,
    protected: false,
    source: 'weekly-context',
    sourceType: 'digest',
    semanticType: normalizeMemorySemanticType('case'),
    stability: 0.6,
    confidence: 0.72,
    rememberedReason: typeof parsed.rememberedReason === 'string' ? parsed.rememberedReason.trim().slice(0, 80) : undefined,
  } satisfies MemoryDraft;
  } finally { cacheMetric.finish(); }
}
