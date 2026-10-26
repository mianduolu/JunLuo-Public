export type MemoryRecallSource = 'vector' | 'fts' | 'cjk' | 'bridge' | 'pinned' | 'related' | 'reranker';

export type MemoryRecallScoreMemory = {
  id: string;
  title: string;
  content: string;
  domain: string;
  tags: string[];
  recallCues: string[];
  importance: number;
  activationCount: number;
  lastActiveAt: number;
  statsSemanticsVersion?: number;
  confidence?: number;
  pinned: boolean;
  protected: boolean;
  anchor: boolean;
  tier: 'core' | 'working' | 'peripheral';
  semanticType: string;
  resolved: boolean;
  surfaceMutedAt?: number;
};

export type MemoryTextCandidateScore = {
  fts: number;
  cjk: number;
  hintFts?: number;
  hintCjk?: number;
};

export type MemoryRecallScoreOptions = {
  feedbackBoosts?: Map<string, number>;
  feedbackPenalties?: Map<string, number>;
  related?: boolean;
  semanticScores?: Map<string, number>;
  textScores?: Map<string, MemoryTextCandidateScore>;
};

export type MemoryRerankFeatures<TMemory extends MemoryRecallScoreMemory = MemoryRecallScoreMemory> = {
  memory: TMemory;
  textScore: number;
  semanticScore: number;
  ftsScore: number;
  cjkScore: number;
  bridgeScore: number;
  evidenceScore: number;
  boostScore: number;
  score: number;
  baseRankScore: number;
  admitted: boolean;
  sources: MemoryRecallSource[];
  tier: 'direct' | 'context' | 'semantic' | 'weak';
};

const VECTOR_ONLY_THRESHOLD = 0.62;
const SUPPORTED_VECTOR_THRESHOLD = 0.42;
const TEXT_EVIDENCE_THRESHOLD = 0.24;
const CORE_TEXT_EVIDENCE_THRESHOLD = 0.12;
const CJK_EVIDENCE_THRESHOLD = 0.26;
const EMPTY_QUERY_CORE_LIMIT = 0.55;
const TECH_RECALL_INTENT_PATTERN = /app|应用|功能|bug|报错|代码|开发|测试|搜索|检索|修|改|优化|构建/i;
const TECH_MEMORY_SIGNAL_PATTERN = /app|应用|功能|bug|报错|代码|开发|测试|搜索|检索|优化|构建|react native|expo|君落/i;
const STRAINED_TECH_CONTEXT_PATTERN = /凌晨|半夜|熬夜|睡不着|失眠|困|累|疲惫|压力|焦虑|崩溃|卡住|头疼|难受/;
const STRAINED_TECH_MEMORY_PATTERN = /失眠|睡不着|熬夜|凌晨|半夜|困|累|疲惫|压力|焦虑|崩溃|卡住|身体|休息|头疼|难受|不舒服/;
const PERSONAL_PREFERENCE_QUERY_PATTERN = /喜欢|偏爱|爱吃|爱喝|爱听|爱看|讨厌|不喜欢|不要|不能接受|吃|喝|饮料|冰|冷|热|奶茶|咖啡|茶|糖|主食|饭|菜|胃|肚子|身体|不舒服|难受|疼|痛|天气|热|冷/;

export function normalizeRecallEvidenceText(value: string) {
  return value
    .toLowerCase()
    .replace(/白云小姐|小仓鼠|仓鼠|鼠鼠|白云|小姐|小鼠|鼠/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function queryTerms(query: string) {
  return Array.from(new Set(
    normalizeRecallEvidenceText(query)
      .split(/[^\p{L}\p{N}_]+/u)
      .map((term) => term.trim())
      .filter((term) => term.length >= 2)
      .slice(0, 12),
  ));
}

function compactRecallEvidenceText(value: string) {
  return normalizeRecallEvidenceText(value).replace(/[^\p{L}\p{N}]+/gu, '');
}

export function cjkBigrams(value: string) {
  const compact = compactRecallEvidenceText(value);
  const grams = new Set<string>();
  for (let index = 0; index < compact.length - 1; index += 1) {
    grams.add(compact.slice(index, index + 2));
  }
  return grams;
}

/** Query grams come from cjkBigrams; each is exactly two UTF-16 code units. */
export function countCjkBigramMatches(value: string, queryGrams: ReadonlySet<string>) {
  // Avoid building every memory gram for short queries; keep linear Set lookup
  // for long queries, where repeated substring scans can be slower.
  const searchable = queryGrams.size <= 32 ? compactRecallEvidenceText(value) : cjkBigrams(value);
  let overlap = 0;
  queryGrams.forEach(gram => {
    if (typeof searchable === 'string' ? searchable.includes(gram) : searchable.has(gram)) overlap += 1;
  });
  return overlap;
}

export function recallQuerySimilarity(left: string, right: string) {
  const leftTerms = new Set(queryTerms(left));
  const rightTerms = new Set(queryTerms(right));
  let termOverlap = 0;
  leftTerms.forEach((term) => {
    if (rightTerms.has(term)) termOverlap += 1;
  });
  const termScore = leftTerms.size && rightTerms.size ? termOverlap / Math.min(leftTerms.size, rightTerms.size) : 0;

  const leftGrams = cjkBigrams(left);
  const rightGrams = cjkBigrams(right);
  let gramOverlap = 0;
  leftGrams.forEach((gram) => {
    if (rightGrams.has(gram)) gramOverlap += 1;
  });
  const gramScore = leftGrams.size && rightGrams.size ? gramOverlap / Math.min(leftGrams.size, rightGrams.size) : 0;
  return Math.max(termScore, gramScore);
}

export function lexicalMatchScore(memory: MemoryRecallScoreMemory, query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return 0;
  const fields: Array<[string, number]> = [
    [memory.title, 3],
    [memory.domain, 2.5],
    [memory.tags.join(' '), 2],
    [memory.recallCues.join(' '), 2],
    [memory.content, 1],
  ];
  const totalWeight = fields.reduce((sum, [, weight]) => sum + weight, 0);
  const score = fields.reduce((sum, [field, weight]) => {
    const text = field.toLowerCase();
    if (!text) return sum;
    if (text.includes(normalized)) return sum + weight;
    const terms = normalized.split(/\s+/).filter(Boolean);
    const hits = terms.filter((term) => text.includes(term)).length;
    return sum + weight * (terms.length ? hits / terms.length : 0);
  }, 0);
  return score / totalWeight;
}

function memorySearchText(memory: MemoryRecallScoreMemory) {
  return `${memory.title} ${memory.content} ${memory.domain} ${memory.tags.join(' ')} ${memory.recallCues.join(' ')}`.toLowerCase();
}

function isSingleSearchCharacter(query: string) {
  return /^[\p{L}\p{N}]$/u.test(query.trim());
}

function queryCoverageScore(memory: MemoryRecallScoreMemory, query: string) {
  const terms = queryTerms(query);
  const haystack = memorySearchText(memory);
  // A one-character literal has no bigrams and must not become an empty query.
  if (isSingleSearchCharacter(query)) return haystack.includes(query.trim().toLowerCase()) ? 1 : 0;
  const termHits = terms.filter((term) => haystack.includes(term)).length;
  const termCoverage = terms.length ? termHits / terms.length : 0;
  const queryGrams = cjkBigrams(query);
  if (!queryGrams.size) return termCoverage;
  const overlap = countCjkBigramMatches(haystack, queryGrams);
  return Math.max(termCoverage, overlap / queryGrams.size);
}

function technicalRecallEvidence(memory: MemoryRecallScoreMemory, query: string) {
  if (!TECH_RECALL_INTENT_PATTERN.test(query)) return 0;
  return TECH_MEMORY_SIGNAL_PATTERN.test(memorySearchText(memory)) ? 0.3 : 0;
}

function contextualBridgeEvidence(memory: MemoryRecallScoreMemory, query: string) {
  if (!TECH_RECALL_INTENT_PATTERN.test(query) || !STRAINED_TECH_CONTEXT_PATTERN.test(query)) return 0;
  return STRAINED_TECH_MEMORY_PATTERN.test(memorySearchText(memory)) ? 0.34 : 0;
}

export function scoreMemoryForRecall<TMemory extends MemoryRecallScoreMemory>(
  memory: TMemory,
  query: string,
  options: MemoryRecallScoreOptions = {},
  now = Date.now(),
): MemoryRerankFeatures<TMemory> {
  const textScore = lexicalMatchScore(memory, query);
  const semanticScore = options.semanticScores?.get(memory.id) ?? 0;
  const indexedText = options.textScores?.get(memory.id);
  const ftsScore = indexedText?.fts ?? 0;
  const cjkScore = indexedText?.cjk ?? 0;
  const hintScore = Math.max(indexedText?.hintFts ?? 0, indexedText?.hintCjk ?? 0);
  const coverageScore = queryCoverageScore(memory, query);
  const techScore = technicalRecallEvidence(memory, query);
  const bridgeScore = contextualBridgeEvidence(memory, query);
  const reliableFtsScore = ftsScore > 0 && coverageScore >= CORE_TEXT_EVIDENCE_THRESHOLD ? ftsScore : 0;
  const directTextEvidence = Math.max(textScore, reliableFtsScore, cjkScore, coverageScore, techScore);
  const textEvidence = Math.max(directTextEvidence, bridgeScore);
  const hasTextEvidence = directTextEvidence >= TEXT_EVIDENCE_THRESHOLD || cjkScore >= CJK_EVIDENCE_THRESHOLD;
  const hasCoreTextEvidence = directTextEvidence >= CORE_TEXT_EVIDENCE_THRESHOLD;
  const hasBridgeEvidence = bridgeScore >= TEXT_EVIDENCE_THRESHOLD;
  const strongVectorEvidence = semanticScore >= VECTOR_ONLY_THRESHOLD;
  const supportedVectorEvidence = semanticScore >= SUPPORTED_VECTOR_THRESHOLD && (hasCoreTextEvidence || hasBridgeEvidence);
  const relatedEvidence = options.related === true && (hasCoreTextEvidence || hasBridgeEvidence || semanticScore >= 0.35);
  const personalPreferenceMemory = memory.domain === '喜好' || memory.domain === '边界' || memory.semanticType === 'preference';
  const preferenceRelevantQuery = PERSONAL_PREFERENCE_QUERY_PATTERN.test(query);
  const directEvidence = Math.max(
    textScore * 0.75,
    reliableFtsScore * 0.9,
    cjkScore * 0.85,
    coverageScore * 0.8,
    techScore * 0.85,
    bridgeScore * 0.82,
    relatedEvidence ? 0.18 : 0,
    strongVectorEvidence || supportedVectorEvidence ? semanticScore * 0.65 : 0,
  );
  const hasReference = memory.statsSemanticsVersion === 1 && memory.activationCount > 0 && memory.lastActiveAt > 0;
  const days = hasReference ? Math.max(0, (now - memory.lastActiveAt) / 86400000) : 0;
  const recencyBoost = hasReference ? Math.exp(-0.02 * days) * 0.08 : 0;
  const importanceBoost = (memory.importance / 10) * 0.08;
  const activationBoost = hasReference ? Math.min(1, Math.log1p(memory.activationCount) / Math.log(10)) * 0.05 : 0;
  const confidenceBoost = (memory.confidence ?? 0.5) * 0.04;
  const pinnedBoost = memory.pinned || memory.protected ? 0.08 : 0;
  const relatedBoost = options.related ? 0.04 : 0;
  const hintBoost = hintScore * 0.04;
  const baseBoostScore = importanceBoost + confidenceBoost + pinnedBoost + relatedBoost + hintBoost;
  const boostScore = baseBoostScore + recencyBoost + activationBoost;
  const emptyQuery = query.trim().length < 2 && !isSingleSearchCharacter(query);
  const coreMemory = memory.pinned || memory.protected || memory.anchor;
  const hasRelevantEvidence = hasTextEvidence || hasBridgeEvidence || strongVectorEvidence || supportedVectorEvidence || relatedEvidence;
  const baseAdmitted = emptyQuery
    ? coreMemory && (memory.importance / 10 + (memory.pinned || memory.protected ? 0.3 : 0)) >= EMPTY_QUERY_CORE_LIMIT
    : hasRelevantEvidence;
  const admittedBeforeFeedback = personalPreferenceMemory && !preferenceRelevantQuery
    ? baseAdmitted && (hasTextEvidence || hasBridgeEvidence || semanticScore >= 0.68 || relatedEvidence)
    : baseAdmitted;
  const tier = hasTextEvidence
    ? 'direct'
    : hasBridgeEvidence || relatedEvidence
      ? 'context'
      : strongVectorEvidence || supportedVectorEvidence
        ? 'semantic'
        : 'weak';
  const tierRank = tier === 'direct' ? 0.06 : tier === 'context' ? 0.035 : tier === 'semantic' ? 0.02 : 0;
  const lengthFactor = memory.content.length <= 500
    ? 1
    : 1 / (1 + 0.5 * Math.log2(memory.content.length / 500));
  const evidenceScore = directEvidence * lengthFactor;
  const feedbackBoost = Math.min(0.12, options.feedbackBoosts?.get(memory.id) ?? 0);
  const feedbackPenalty = Math.min(0.55, options.feedbackPenalties?.get(memory.id) ?? 0);
  const feedbackBlocked = feedbackPenalty >= 0.35 && evidenceScore < 0.3 && semanticScore < 0.68;
  const preferencePenalty = personalPreferenceMemory && !preferenceRelevantQuery ? 0.72 : 1;
  const admitted = admittedBeforeFeedback && !feedbackBlocked
    && (!memory.surfaceMutedAt || (!emptyQuery && hasRelevantEvidence));
  const baseRankScore = admitted
    ? Math.max(0, (evidenceScore + tierRank + Math.min(baseBoostScore, 0.2) + feedbackBoost - feedbackPenalty) * preferencePenalty)
    : 0;
  const score = admitted
    ? Math.max(0, (evidenceScore + tierRank + Math.min(boostScore, 0.2) + feedbackBoost - feedbackPenalty) * preferencePenalty)
    : 0;
  const sourceCandidates: Array<Exclude<MemoryRecallSource, 'reranker'> | null> = [
    semanticScore >= SUPPORTED_VECTOR_THRESHOLD ? 'vector' as const : null,
    reliableFtsScore > 0 ? 'fts' as const : null,
    cjkScore > 0 ? 'cjk' as const : null,
    bridgeScore > 0 ? 'bridge' as const : null,
    memory.pinned || memory.protected ? 'pinned' as const : null,
    options.related ? 'related' as const : null,
  ];
  const sources = sourceCandidates.filter(Boolean) as MemoryRecallSource[];

  return {
    memory,
    textScore: textEvidence,
    semanticScore,
    ftsScore,
    cjkScore,
    bridgeScore,
    evidenceScore,
    boostScore,
    score,
    baseRankScore,
    admitted,
    sources,
    tier,
  };
}

export function rankMemoryEntriesForRecall<TMemory extends MemoryRecallScoreMemory>(
  memories: TMemory[],
  query: string,
  options: MemoryRecallScoreOptions & { limit?: number; now?: number } = {},
): Array<MemoryRerankFeatures<TMemory>> {
  const now = options.now ?? Date.now();
  return memories
    .map((memory) => scoreMemoryForRecall(memory, query, options, now))
    .filter((item) => item.admitted)
    .sort(compareMemoryRecallRanks)
    .slice(0, options.limit ?? 30);
}

/** Frequency breaks ties within a fit group; it cannot promote a weaker group. */
export function compareMemoryRecallRanks(
  left: { memory: Pick<MemoryRecallScoreMemory, 'id' | 'importance'>; score?: number; baseRankScore?: number },
  right: { memory: Pick<MemoryRecallScoreMemory, 'id' | 'importance'>; score?: number; baseRankScore?: number },
) {
  return Math.floor((right.baseRankScore ?? right.score ?? 0) / 0.05)
    - Math.floor((left.baseRankScore ?? left.score ?? 0) / 0.05)
    || (right.score ?? 0) - (left.score ?? 0)
    || right.memory.importance - left.memory.importance
    || left.memory.id.localeCompare(right.memory.id);
}

// Explicit page lookup returns nearby candidates, not permission to bring them up in chat.
// Keep a small relative neighbourhood: a positive cosine alone is not a useful match.
export function rankMemoryEntriesForSearch<TMemory extends MemoryRecallScoreMemory>(
  memories: TMemory[],
  query: string,
  options: Pick<MemoryRecallScoreOptions, 'semanticScores' | 'textScores'> & { limit?: number } = {},
): TMemory[] {
  if (!query.trim()) return [];
  const scored = memories.map(memory => {
    const coverage = queryCoverageScore(memory, query);
    const indexed = options.textScores?.get(memory.id);
    const text = Math.max(lexicalMatchScore(memory, query), coverage,
      coverage >= CORE_TEXT_EVIDENCE_THRESHOLD ? indexed?.fts ?? 0 : 0, indexed?.cjk ?? 0);
    const rawVector = options.semanticScores?.get(memory.id) ?? 0;
    return { memory, text, vector: Number.isFinite(rawVector) ? rawVector : 0 };
  });
  const vectorRanked = scored.filter(item => item.vector >= 0.4)
    .sort((left, right) => right.vector - left.vector || left.memory.id.localeCompare(right.memory.id));
  const vectorFloor = Math.max(0.4, (vectorRanked[0]?.vector ?? 0) - 0.08);
  const vectorIds = new Set(vectorRanked.filter(item => item.vector >= vectorFloor)
    .slice(0, 8).map(item => item.memory.id));
  return scored
    .filter(item => item.text >= TEXT_EVIDENCE_THRESHOLD || vectorIds.has(item.memory.id))
    .sort((left, right) => {
      const score = (item: typeof left) => Math.max(item.text, vectorIds.has(item.memory.id) ? item.vector : 0);
      return score(right) - score(left) || left.memory.id.localeCompare(right.memory.id);
    })
    .slice(0, options.limit ?? 30)
    .map(item => item.memory);
}
