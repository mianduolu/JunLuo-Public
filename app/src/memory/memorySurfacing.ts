import { buildMemoryRecall, memoryLocalRecallQuery, type StructuredMemoryQuery, type CurrentStateRecallSelection } from './memoryRecall';
import type { ShiyingRecallSelection } from './memoryShiyingRecall';
import type { PostRecallSelection } from './memoryPostRecall';
import {
  loadMemories,
  updateMemoryState,
  updateMemorySurfacingState,
  selectRefreshedMemoryRecallItems,
  type MemoryEntry,
  type MemoryRecallItem,
  type MemoryRecallResult,
} from './memoryStore';
import { observeRuntimeWorkload } from '../runtime/runtimeWorkloadDiagnostics';
import { createMemoryMaterialPreparation, type MemoryMaterialPreparation } from './memoryCurrentMaterials';

export type MemorySurfacingMode = 'quiet_context' | 'suggested_mention';

export type MemorySurfacingCandidate = {
  memory: MemoryEntry;
  mode: MemorySurfacingMode;
  score: number;
  reasons: string[];
  recallEvidence?: Pick<MemoryRecallItem, 'baseRankScore' | 'relevanceTier' | 'sources' | 'latestComment' | 'commentsChecked'>;
};

export type MemorySurfacingFeedback = 'skip' | 'suppress' | 'mute' | 'digested';

const DAY_MS = 86400000;
const SUGGESTED_MENTION_COOLDOWN_MS = 7 * DAY_MS;
const SUPPRESS_COOLDOWN_MS = 7 * DAY_MS;
const DIGESTED_PATTERN = /(?:放下了|翻篇了|消化(?:完|好了|掉了)?|想开了|释怀了|不用再挂着)/;
const MUTE_PATTERN = /(?:以后|之后|以后都|以后也|以后不用|以后不要|别再|不要再|不再|这个不要|这件事不要).{0,8}(?:主动提|主动说|提这个|说这个|提起|提了|再提)/;
const SUPPRESS_PATTERN = /(?:不想(?:聊|说|提)|先别提|别提|不要提|别问|不要问|算了|跳过|略过|先不说|不聊这个|别说这个)/;
const SKIP_PATTERN = /^(?:没事|没事啦|没事了|还好|还好啦|不用啦|不用管|没关系|没啥)(?:[。！!~～…\s哈呀啦呢]*)?$/;

function isWhisperOrDailyMemory(memory: MemoryEntry) {
  if (memory.period === 'whisper' || memory.period === 'daily') return true;
  if (memory.tags.some((tag) => tag.toLowerCase() === 'whisper' || tag === '碎碎念' || tag === '白云动态' || tag === '日印象')) return true;
  return memory.type === 'feel';
}

async function currentSurfacingMemories(memories: readonly MemoryEntry[]) {
  const active = memories.filter(memory => memory.type !== 'archived');
  const { inspectCurrentMemoryMaterial } = await import('./memoryCurrentMaterials');
  const current = await Promise.all(active.map(memory => inspectCurrentMemoryMaterial(memory)));
  // Keep the original version until selected: the preparation must observe the change
  // and spend its one local reread, rather than silently accepting or dropping a new body.
  return active.filter((_, index) => current[index].memory && current[index].memory!.type !== 'archived');
}

export function memorySurfacingBlockReason(memory: MemoryEntry, now: number) {
  if (memory.type === 'archived') return 'archived' as const;
  if (isWhisperOrDailyMemory(memory)) return 'category' as const;
  if (memory.surfaceMutedAt) return 'muted' as const;
  if (memory.surfaceSuppressedUntil && memory.surfaceSuppressedUntil > now) return 'cooldown' as const;
  return undefined;
}

export function scoreSurfacingMemory(memory: MemoryEntry, now: number) {
  if (memorySurfacingBlockReason(memory, now)) return null;

  const daysSinceActive = memory.activationCount > 0 && memory.lastActiveAt > 0 ? Math.max(0, (now - memory.lastActiveAt) / DAY_MS) : 0;
  const daysSinceSurfaced = memory.lastSurfacedAt ? Math.max(0, (now - memory.lastSurfacedAt) / DAY_MS) : 999;
  const emotionBoost = memory.arousal >= 0.7 ? 0.8 : memory.arousal >= 0.45 ? 0.35 : 0;
  const staleBoost = daysSinceActive >= 14 ? Math.min(0.9, daysSinceActive / 60) : 0;
  const pinnedBoost = memory.pinned || memory.protected ? 0.45 : 0;
  const digestedPenalty = memory.digested ? 0.55 : 1;
  const recentSurfacingPenalty = daysSinceSurfaced < 7 ? 0.2 : 1;
  const score = (
    memory.importance / 10
    + memory.activationCount * 0.035
    + emotionBoost
    + staleBoost
    + pinnedBoost
  ) * digestedPenalty * recentSurfacingPenalty;

  const reasons: string[] = [];
  if (memory.arousal >= 0.7) reasons.push('high_arousal');
  if (daysSinceActive >= 14) reasons.push('stale_but_important');
  if (memory.pinned || memory.protected) reasons.push('pinned_or_protected');
  if (memory.digested) reasons.push('digested_lower_priority');

  return { score, reasons };
}

export function inspectMemorySurfacingCandidate(memory: MemoryEntry, now = Date.now()): {
  blocker?: ReturnType<typeof memorySurfacingBlockReason> | 'low_score';
  candidate?: MemorySurfacingCandidate;
} {
  const blocker = memorySurfacingBlockReason(memory, now);
  if (blocker) return { blocker };
  const scored = scoreSurfacingMemory(memory, now);
  if (!scored || scored.score < 1.15) return { blocker: 'low_score' };
  const canSuggest = !memory.lastSurfacedAt || now - memory.lastSurfacedAt >= SUGGESTED_MENTION_COOLDOWN_MS;
  const mode: MemorySurfacingMode = canSuggest && memory.arousal >= 0.65 && scored.score >= 2.05
    ? 'suggested_mention'
    : 'quiet_context';
  return { candidate: { memory, mode, score: Number(scored.score.toFixed(4)), reasons: scored.reasons } };
}

export async function getMemorySurfacingCandidates(options: {
  now?: number;
  limit?: number;
  excludeIds?: string[];
  modes?: MemorySurfacingMode[];
} = {}): Promise<MemorySurfacingCandidate[]> {
  const now = options.now ?? Date.now();
  const excludeIds = new Set(options.excludeIds ?? []);
  const allowedModes = options.modes ? new Set(options.modes) : null;
  const memories = await loadMemories({ includeArchived: false, currentOnly: true });
  const candidates = memories
    .filter((memory) => !excludeIds.has(memory.id))
    .map((memory) => {
      const { candidate } = inspectMemorySurfacingCandidate(memory, now);
      return candidate && (!allowedModes || allowedModes.has(candidate.mode)) ? candidate : null;
    })
    .filter((candidate): candidate is MemorySurfacingCandidate => candidate !== null)
    .sort((left, right) => right.score - left.score || right.memory.importance - left.memory.importance);

  const limit = Math.max(1, Math.min(6, options.limit ?? 4));
  const selected: MemorySurfacingCandidate[] = [];
  let suggestedUsed = false;
  for (const candidate of candidates) {
    if (candidate.mode === 'suggested_mention') {
      if (suggestedUsed) continue;
      suggestedUsed = true;
    }
    selected.push(candidate);
    if (selected.length >= limit) break;
  }

  return selected;
}

export async function getMemoryCarePoolCandidates(options: {
  now?: number;
  limit?: number;
  excludeIds?: string[];
  memories?: readonly MemoryEntry[];
  materialPreparation?: MemoryMaterialPreparation;
} = {}): Promise<MemorySurfacingCandidate[]> {
  const now = options.now ?? Date.now();
  const excludeIds = new Set(options.excludeIds ?? []);
  const memories = options.memories
    ? await currentSurfacingMemories(options.memories)
    : await loadMemories({ includeArchived: false, currentOnly: true });
  const limit = Math.max(1, Math.min(6, options.limit ?? 5));
  const selected = memories
    .filter((memory) => !excludeIds.has(memory.id))
    .map((memory): MemorySurfacingCandidate | null => {
      const scored = scoreSurfacingMemory(memory, now);
      if (!scored || scored.score < 1.05) return null;
      if (memory.lastSurfacedAt && now - memory.lastSurfacedAt < SUGGESTED_MENTION_COOLDOWN_MS) return null;
      return {
        memory,
        mode: 'suggested_mention' as const,
        score: Number(scored.score.toFixed(4)),
        reasons: [...scored.reasons, 'care_pool'],
      };
    })
    .filter((candidate): candidate is MemorySurfacingCandidate => candidate !== null)
    .sort((left, right) => (
      right.score - left.score
      || right.memory.arousal - left.memory.arousal
      || right.memory.importance - left.memory.importance
    ))
    .slice(0, limit);
  const preparation = options.materialPreparation ?? createMemoryMaterialPreparation();
  const current = await preparation.refresh(selected.map(item => item.memory), memory => memory.type !== 'archived');
  return current.flatMap(memory => {
    const scored = scoreSurfacingMemory(memory, now);
    if (!scored || scored.score < 1.05
      || memory.lastSurfacedAt && now - memory.lastSurfacedAt < SUGGESTED_MENTION_COOLDOWN_MS) return [];
    return [{ memory, mode: 'suggested_mention' as const, score: Number(scored.score.toFixed(4)), reasons: [...scored.reasons, 'care_pool'] }];
  }).sort((left, right) => right.score - left.score
    || right.memory.arousal - left.memory.arousal || right.memory.importance - left.memory.importance);
}

export function isBackgroundEligible(memory: MemoryEntry, now: number) {
  if (memory.type === 'archived' || isWhisperOrDailyMemory(memory)) return false;
  if (memory.surfaceMutedAt) return false;
  if (memory.surfaceSuppressedUntil && memory.surfaceSuppressedUntil > now) return false;
  return true;
}

function backgroundMemoryText(memory: MemoryEntry) {
  return [
    memory.title,
    memory.content,
    memory.domain,
    memory.tags.join(' '),
    memory.recallCues.join(' '),
    memory.rememberedReason ?? '',
  ].join('\n').toLowerCase();
}

export function normalizeBackgroundTerms(input: string | StructuredMemoryQuery | undefined, topic?: string, keywords?: string[]) {
  const raw = [
    typeof input === 'string' ? input : input?.userText,
    typeof input === 'string' ? '' : input?.activeContext,
    typeof input === 'string' ? '' : input?.sourceHints,
    topic,
    ...(keywords ?? []),
  ].filter(Boolean).join('\n').toLowerCase();
  const chunks = raw
    .split(/[^\u3400-\u9fff\w]+/g)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2 && term.length <= 18);
  const cjk = raw.replace(/[^\u3400-\u9fff]/g, '');
  for (let index = 0; index < cjk.length - 1; index += 1) {
    chunks.push(cjk.slice(index, index + 2));
  }
  return Array.from(new Set(chunks)).slice(0, 40);
}

export function scoreBackgroundTopicMatch(memory: MemoryEntry, terms: string[]) {
  if (!terms.length) return 0;
  const haystack = backgroundMemoryText(memory);
  let score = 0;
  for (const term of terms) {
    if (!haystack.includes(term)) continue;
    if (memory.title.toLowerCase().includes(term)) score += 3;
    else if (memory.tags.some((tag) => tag.toLowerCase().includes(term))) score += 2.6;
    else if (memory.recallCues.some((cue) => cue.toLowerCase().includes(term))) score += 2.3;
    else if (memory.domain.toLowerCase().includes(term)) score += 2;
    else score += term.length >= 3 ? 1 : 0.35;
  }
  return score;
}

function backgroundToCandidate(memory: MemoryEntry, score: number, reasons: string[]): MemorySurfacingCandidate {
  return {
    memory,
    mode: 'quiet_context',
    reasons,
    score: Number(score.toFixed(4)),
  };
}

function pushUniqueBackgroundCandidate(
  selected: MemorySurfacingCandidate[],
  candidate: MemorySurfacingCandidate,
  selectedIds: Set<string>,
  limit: number,
) {
  if (selected.length >= limit || selectedIds.has(candidate.memory.id)) return;
  selected.push(candidate);
  selectedIds.add(candidate.memory.id);
}

export async function getBackgroundMemoryCandidates(options: {
  input?: string | StructuredMemoryQuery;
  topic?: string;
  keywords?: string[];
  now?: number;
  limit?: number;
  excludeIds?: string[];
  recentDays?: number;
  memories?: readonly MemoryEntry[];
  materialPreparation?: MemoryMaterialPreparation;
  relatedCandidates?: readonly MemoryRecallItem[];
} = {}): Promise<MemorySurfacingCandidate[]> {
  const now = options.now ?? Date.now();
  const limit = Math.max(1, Math.min(8, options.limit ?? 8));
  const recentDays = Math.max(1, Math.min(14, options.recentDays ?? 3));
  const excludeIds = new Set(options.excludeIds ?? []);
  const selectedIds = new Set<string>();
  const selected: MemorySurfacingCandidate[] = [];
  const memories = (options.relatedCandidates !== undefined ? options.relatedCandidates
    .filter(item => item.relevanceTier !== undefined && item.relevanceTier !== 'weak').map(item => item.memory) : options.memories
    ? options.materialPreparation?.hasCandidateSnapshot()
      ? await options.materialPreparation.filterCandidateSnapshots(options.memories)
      : await currentSurfacingMemories(options.memories)
    : await loadMemories({ includeArchived: false, currentOnly: true }))
    .filter((memory) => !excludeIds.has(memory.id) && isBackgroundEligible(memory, now));
  const terms = normalizeBackgroundTerms(options.input, options.topic, options.keywords);

  const highEmotion = memories
    .filter((memory) => memory.arousal >= 0.65)
    .sort((left, right) => (
      right.arousal - left.arousal
      || right.importance - left.importance
      || right.updatedAt - left.updatedAt
    ))
    .slice(0, 2)
    .map((memory) => backgroundToCandidate(
      memory,
      2.4 + memory.importance / 10 + memory.arousal,
      ['background_high_arousal'],
    ));
  highEmotion.forEach((candidate) => pushUniqueBackgroundCandidate(selected, candidate, selectedIds, limit));

  const topicMatches = memories
    .filter((memory) => !selectedIds.has(memory.id))
    .map((memory) => ({ memory, textScore: scoreBackgroundTopicMatch(memory, terms) }))
    .filter(({ textScore }) => textScore >= 1)
    .sort((left, right) => right.textScore - left.textScore || right.memory.importance - left.memory.importance)
    .slice(0, 3)
    .map(({ memory, textScore }) => backgroundToCandidate(
      memory,
      1.7 + textScore / 4 + memory.importance / 20,
      ['background_topic_match'],
    ));
  topicMatches.forEach((candidate) => pushUniqueBackgroundCandidate(selected, candidate, selectedIds, limit));

  const recentFloor = now - recentDays * DAY_MS;
  const recent = memories
    .filter((memory) => !selectedIds.has(memory.id))
    .filter((memory) => Math.max(memory.createdAt, memory.updatedAt, memory.lastActiveAt) >= recentFloor)
    .sort((left, right) => (
      Math.max(right.createdAt, right.updatedAt, right.lastActiveAt)
      - Math.max(left.createdAt, left.updatedAt, left.lastActiveAt)
      || right.importance - left.importance
    ))
    .map((memory) => backgroundToCandidate(
      memory,
      1.1 + memory.importance / 20 + memory.arousal / 5,
      ['background_recent'],
    ));
  recent.forEach((candidate) => pushUniqueBackgroundCandidate(selected, candidate, selectedIds, limit));

  const preparation = options.materialPreparation ?? createMemoryMaterialPreparation();
  const current = await preparation.refresh(selected.map(item => item.memory), memory => isBackgroundEligible(memory, now));
  const related = options.relatedCandidates === undefined ? undefined : new Map(selectRefreshedMemoryRecallItems(
    options.relatedCandidates, memoryLocalRecallQuery(options.input ?? ''), preparation, current, { requireRelevant: true },
  ).map(item => [item.memory.id, item]));
  const attachEvidence = (candidate: MemorySurfacingCandidate) => {
    const evidence = related?.get(candidate.memory.id);
    return evidence ? { ...candidate, recallEvidence: { baseRankScore: evidence.baseRankScore, relevanceTier: evidence.relevanceTier,
      sources: evidence.sources, latestComment: evidence.latestComment, commentsChecked: evidence.commentsChecked } } : candidate;
  };
  return current.flatMap(memory => {
    if (related && !related.has(memory.id)) return [];
    const previous = selected.find(item => item.memory.id === memory.id)!;
    if (previous.reasons.includes('background_topic_match')) {
      const textScore = scoreBackgroundTopicMatch(memory, terms);
      return textScore >= 1 ? [attachEvidence(backgroundToCandidate(memory, 1.7 + textScore / 4 + memory.importance / 20, previous.reasons))] : [];
    }
    if (previous.reasons.includes('background_recent')) {
      return Math.max(memory.createdAt, memory.updatedAt, memory.lastActiveAt) >= recentFloor
        ? [attachEvidence(backgroundToCandidate(memory, 1.1 + memory.importance / 20 + memory.arousal / 5, previous.reasons))] : [];
    }
    return memory.arousal >= 0.65
      ? [attachEvidence(backgroundToCandidate(memory, 2.4 + memory.importance / 10 + memory.arousal,
        ['background_high_arousal']))]
      : [];
  });
}

export async function markMemorySurfacingFeedback(memoryId: string, feedback: MemorySurfacingFeedback) {
  const now = Date.now();
  if (feedback === 'digested') {
    await updateMemoryState(memoryId, { digested: true });
    await updateMemorySurfacingState(memoryId, { lastSurfacedAt: now });
    return;
  }
  if (feedback === 'mute') {
    await updateMemoryState(memoryId, { surfaceMutedAt: now });
    await updateMemorySurfacingState(memoryId, { lastSurfacedAt: now });
    return;
  }
  await updateMemorySurfacingState(memoryId, {
    lastSurfacedAt: now,
    surfaceSuppressedUntil: feedback === 'suppress' ? now + SUPPRESS_COOLDOWN_MS : undefined,
  });
}

export function detectMemorySurfacingFeedback(text: string): MemorySurfacingFeedback | null {
  const normalized = text.trim().replace(/\s+/g, '');
  if (!normalized) return null;
  if (DIGESTED_PATTERN.test(normalized)) return 'digested';
  if (MUTE_PATTERN.test(normalized)) return 'mute';
  if (SUPPRESS_PATTERN.test(normalized)) return 'suppress';
  if (SKIP_PATTERN.test(normalized)) return 'skip';
  return null;
}

export async function applyMemorySurfacingFeedbackFromUser(
  items: MemoryRecallItem[] | null | undefined,
  text: string,
) {
  const feedback = detectMemorySurfacingFeedback(text);
  if (!feedback || !items?.length) return 0;

  const surfaced = items.filter((item) => item.reason === 'suggested_mention' || item.reason === 'quiet_context');
  if (!surfaced.length) return 0;

  const targets = surfaced.some((item) => item.reason === 'suggested_mention')
    ? surfaced.filter((item) => item.reason === 'suggested_mention')
    : surfaced.slice(0, 1);
  await Promise.all(targets.map((item) => markMemorySurfacingFeedback(item.memory.id, feedback)));
  return targets.length;
}

function surfacingToRecallItem(candidate: MemorySurfacingCandidate): MemoryRecallItem {
  return {
    ...candidate.recallEvidence,
    memory: candidate.memory,
    reason: candidate.mode,
    score: candidate.score,
    sources: candidate.recallEvidence?.sources ?? [],
    recallReasons: candidate.reasons,
  };
}

export async function buildMemoryContextPack(
  input: string | StructuredMemoryQuery,
  options: {
    memoryWorkReporter?: import('./memoryChatPreparation').MemoryRecallWorkReporter;
    allowRerank?: boolean;
    currentStateSelection?: CurrentStateRecallSelection;
    shiyingSelection?: ShiyingRecallSelection;
    postSelection?: PostRecallSelection;
    memories?: readonly MemoryEntry[];
    throwOnError?: boolean;
    diagnosticParentToken?: number;
    maxResults?: number;
    signal?: AbortSignal;
    touch?: boolean;
    includeSurfacing?: boolean;
    backgroundLimit?: number;
    backgroundRecentDays?: number;
    includeSuggestedMentions?: boolean;
    materialPreparation?: MemoryMaterialPreparation;
    collectBackgroundCandidates?: boolean;
  } = {},
): Promise<MemoryRecallResult> {
  const recall = await buildMemoryRecall(input, options);
  if (options.signal?.aborted) throw Object.assign(new Error('memory-recall-cancelled'), { name: 'AbortError' });
  if (options.includeSurfacing === false) return recall;

  const background = await observeRuntimeWorkload(
    'memory.background',
    () => getBackgroundMemoryCandidates({
      excludeIds: recall.items.map(({ memory }) => memory.id),
      input,
      limit: options.backgroundLimit ?? 8,
      recentDays: options.backgroundRecentDays,
      materialPreparation: options.materialPreparation,
      memories: options.memories,
      relatedCandidates: options.collectBackgroundCandidates ? recall.backgroundCandidates ?? [] : undefined,
    }).catch((error) => { if (options.throwOnError) throw error; return []; }),
    (value) => ({ memoryCount: value.length }),
    { parentToken: options.diagnosticParentToken },
  );
  if (options.signal?.aborted) throw Object.assign(new Error('memory-recall-cancelled'), { name: 'AbortError' });
  const excludedFromSuggested = [
    ...recall.items.map(({ memory }) => memory.id),
    ...background.map(({ memory }) => memory.id),
  ];
  const surfaced = options.includeSuggestedMentions === false
    ? []
    : await getMemorySurfacingCandidates({
      excludeIds: excludedFromSuggested,
      limit: 2,
      modes: ['suggested_mention'],
    }).catch((error) => { if (options.throwOnError) throw error; return []; });
  if (options.signal?.aborted) throw Object.assign(new Error('memory-recall-cancelled'), { name: 'AbortError' });
  if (!background.length && !surfaced.length) return recall;

  return {
    ...(recall.backgroundCandidates ? { backgroundCandidates: recall.backgroundCandidates } : {}),
    context: recall.context,
    items: [
      ...recall.items,
      ...background.map(surfacingToRecallItem),
      ...surfaced.map(surfacingToRecallItem),
    ],
  };
}
