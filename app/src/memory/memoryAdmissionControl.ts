import {
  loadActiveMemoriesCoveringDirectSourceRefs,
  loadMemories,
  type MemoryDraft,
  type MemoryEntry,
} from './memoryStore';
import {
  getMemoryCandidateKind,
  getMemoryCandidateKindPolicy,
  isConcreteLightMemoryCandidate,
} from './memoryCandidateKindPolicy';
import {
  findSourceCoveredMemoryDuplicate,
  type MemorySourceRefInput,
} from './memorySourceRefs';
import { hasLocalMemorySeparationGate } from './memoryDeduplication';

export type MemoryAdmissionStatus = 'admit' | 'review' | 'suppress';

export type MemoryAdmissionSignal = {
  duplicateMemoryId?: string;
  duplicateTitle?: string;
  label: string;
  reasons: string[];
  score: number;
  status: MemoryAdmissionStatus;
};

export type MemoryAdmissionReasonCount = {
  count: number;
  reason: string;
};

export type MemoryAdmissionSummary = {
  admit: number;
  recentCount: number;
  review: number;
  suppress: number;
  suppressReasons: MemoryAdmissionReasonCount[];
  topReasons: MemoryAdmissionReasonCount[];
};

type AdmissionOptions = {
  existingMemories?: Array<MemoryEntry | MemoryDraft>;
  mode?: 'automatic' | 'manual';
  sourceCoveredMemories?: MemoryEntry[];
};

const RECENT_ADMISSION_LIMIT = 80;
const recentAdmissions: Array<{ at: number; mode: 'automatic' | 'manual'; signal: MemoryAdmissionSignal }> = [];

function rememberAdmission(signal: MemoryAdmissionSignal, mode: 'automatic' | 'manual') {
  recentAdmissions.unshift({ at: Date.now(), mode, signal });
  if (recentAdmissions.length > RECENT_ADMISSION_LIMIT) recentAdmissions.length = RECENT_ADMISSION_LIMIT;
}

function normalizeText(text: string) {
  return text
    .toLowerCase()
    .replace(/白云小姐|小仓鼠|仓鼠|鼠鼠|白云/g, ' ')
    .replace(/[^a-z0-9_\u3400-\u9fff]+/g, '')
    .trim();
}

function bigrams(text: string) {
  const normalized = normalizeText(text);
  const grams = new Set<string>();
  for (let index = 0; index < normalized.length - 1; index += 1) grams.add(normalized.slice(index, index + 2));
  return grams;
}

function similarity(left: string, right: string) {
  const leftTerms = bigrams(left);
  const rightTerms = bigrams(right);
  if (!leftTerms.size || !rightTerms.size) return 0;
  let overlap = 0;
  leftTerms.forEach((term) => {
    if (rightTerms.has(term)) overlap += 1;
  });
  return overlap / Math.min(leftTerms.size, rightTerms.size);
}

function candidateText(candidate: MemoryDraft) {
  return `${candidate.title}\n${candidate.content}\n${candidate.domain}\n${candidate.tags.join(' ')}\n${candidate.recallCues.join(' ')}`;
}

function memoryText(memory: MemoryEntry | MemoryDraft) {
  return `${memory.title}\n${memory.content}\n${memory.domain}\n${memory.tags.join(' ')}\n${memory.recallCues.join(' ')}`;
}

function hasEmotionalBackgroundSignal(candidate: MemoryDraft) {
  const text = candidateText(candidate);
  return /不开心|难过|委屈|焦虑|害怕|压力|冲突|吵架|被骂|被凶|被欺负|霸凌|受伤|伤害|冒犯|越界|创伤|边界|情绪|未解决|陪伴|避雷/.test(text);
}

function scoreCandidate(candidate: MemoryDraft) {
  const reasons: string[] = [];
  const compactContent = normalizeText(candidate.content);
  let score = 0;

  if (compactContent.length >= 18) score += 0.24;
  else reasons.push('正文太短，可能只是闲聊碎片。');

  if (candidate.importance >= 7) {
    score += 0.2;
    reasons.push('重要度较高。');
  } else if (candidate.importance >= 5) {
    score += 0.12;
  }

  if (candidate.anchor || candidate.pinned || candidate.protected) {
    score += 0.18;
    reasons.push('像长期坐标或重要记忆。');
  }
  if (candidate.semanticType === 'case' || candidate.tags.includes('阶段记忆') || candidate.source === 'weekly-context') {
    score += 0.14;
    reasons.push('适合作为连续经历/阶段脉络。');
  }
  if (candidate.rememberedReason?.trim()) {
    score += 0.08;
    reasons.push('有留下理由。');
  }
  if (candidate.tags.length || candidate.recallCues.length) score += 0.06;
  if (candidate.domain !== '其他') score += 0.06;
  if (candidate.arousal >= 0.65) {
    score += 0.08;
    reasons.push('情绪较明显。');
  }
  if (hasEmotionalBackgroundSignal(candidate) && candidate.importance >= 5 && compactContent.length >= 18) {
    score += 0.08;
    reasons.push('这类情绪背景以后可能需要温柔留意。');
  }
  const kind = getMemoryCandidateKind(candidate);
  if (kind !== 'long_term') {
    score += 0.12;
    reasons.push(getMemoryCandidateKindPolicy(candidate).admissionReason);
  }
  return { reasons, score: Math.min(1, score) };
}

export function evaluateMemoryCandidateAdmission(
  candidate: MemoryDraft,
  options: AdmissionOptions = {},
): MemoryAdmissionSignal {
  const mode = options.mode ?? 'automatic';
  const scored = scoreCandidate(candidate);
  let duplicate: { memory: MemoryEntry | MemoryDraft; score: number } | null = null;
  for (const memory of options.existingMemories ?? []) {
    if (candidate.understandingSubject || memory.understandingSubject) continue;
    if (hasLocalMemorySeparationGate(
      { atomicKind: candidate.atomicKind ?? 'unknown', eventTime: candidate.eventTime },
      { atomicKind: memory.atomicKind ?? 'unknown', eventTime: memory.eventTime },
    )) continue;
    const score = similarity(candidateText(candidate), memoryText(memory));
    if (!duplicate || score > duplicate.score) duplicate = { memory, score };
  }

  const reasons = [...scored.reasons];
  let score = scored.score;
  const sourceCoveredDuplicate = findSourceCoveredMemoryDuplicate(candidate, options.sourceCoveredMemories ?? []);
  const duplicateMatch = sourceCoveredDuplicate ?? duplicate;
  if (sourceCoveredDuplicate) {
    score -= 0.42;
    reasons.push(`和已保存记忆“${sourceCoveredDuplicate.memory.title}”使用同一组精确来源。`);
  } else if (duplicateMatch && duplicateMatch.score >= 0.86) {
    score -= 0.42;
    reasons.push(`和“${duplicateMatch.memory.title}”非常相似。`);
  } else if (duplicateMatch && duplicateMatch.score >= 0.72) {
    score -= 0.2;
    reasons.push(`可能已有相似记忆：“${duplicateMatch.memory.title}”。`);
  }

  const kind = getMemoryCandidateKind(candidate);
  const isLightCandidate = kind !== 'long_term';
  const tooThin = isLightCandidate
    ? !isConcreteLightMemoryCandidate(candidate, kind)
    : normalizeText(candidate.content).length < 18 && !candidate.anchor && !candidate.pinned;
  const strongDuplicate = !!sourceCoveredDuplicate;
  const reportDuplicate = !!sourceCoveredDuplicate || (!!duplicateMatch && duplicateMatch.score >= 0.72);
  // Similarity can suggest review, but cannot turn otherwise useful content into a rejection.
  const status: MemoryAdmissionStatus = mode === 'automatic' && (tooThin || strongDuplicate || (!isLightCandidate && scored.score < 0.24))
    ? 'suppress'
    : score < 0.42 || strongDuplicate
      ? 'review'
      : 'admit';

  return {
    duplicateMemoryId: reportDuplicate && duplicateMatch && 'id' in duplicateMatch.memory ? duplicateMatch.memory.id : undefined,
    duplicateTitle: reportDuplicate ? duplicateMatch?.memory.title : undefined,
    label: status === 'suppress'
      ? '自动跳过'
      : status === 'review'
        ? strongDuplicate ? '可能重复' : '需要看一眼'
        : '建议保存',
    reasons: reasons.length ? Array.from(new Set(reasons)).slice(0, 4) : ['内容信息量足够。'],
    score: Number(Math.max(0, Math.min(1, score)).toFixed(3)),
    status,
  };
}

export async function filterAutomaticMemoryCandidates<T extends MemoryDraft & { sourceRefs?: MemorySourceRefInput[] }>(
  candidates: T[],
  options: AdmissionOptions = {},
): Promise<Array<T & { admission?: MemoryAdmissionSignal }>> {
  if (!candidates.length) return [];
  const existing = options.existingMemories ?? await loadMemories({ includeArchived: false, currentOnly: true }).catch(() => []);
  const sourceCoveredMemories = await Promise.all(candidates.map((candidate) => (
    loadActiveMemoriesCoveringDirectSourceRefs(candidate.sourceRefs ?? []).catch(() => [])
  )));
  const accepted: Array<T & { admission?: MemoryAdmissionSignal }> = [];
  for (const [index, candidate] of candidates.entries()) {
    const admission = evaluateMemoryCandidateAdmission(candidate, {
      ...options,
      existingMemories: [...existing, ...accepted],
      mode: 'automatic',
      sourceCoveredMemories: sourceCoveredMemories[index],
    });
    rememberAdmission(admission, 'automatic');
    if (admission.status === 'suppress') continue;
    accepted.push({ ...candidate, admission });
  }
  return accepted;
}

export async function annotateManualMemoryCandidates<T extends MemoryDraft>(
  candidates: T[],
  options: AdmissionOptions = {},
): Promise<Array<T & { admission?: MemoryAdmissionSignal }>> {
  if (!candidates.length) return [];
  const existing = options.existingMemories ?? await loadMemories({ includeArchived: false, currentOnly: true }).catch(() => []);
  return candidates.map((candidate) => {
    const admission = evaluateMemoryCandidateAdmission(candidate, {
      ...options,
      existingMemories: existing,
      mode: 'manual',
    });
    rememberAdmission(admission, 'manual');
    return { ...candidate, admission };
  });
}

function countAdmissionReasons(
  items: Array<{ signal: MemoryAdmissionSignal }>,
  options: { limit?: number } = {},
): MemoryAdmissionReasonCount[] {
  const counts = new Map<string, number>();
  items.forEach((item) => {
    item.signal.reasons.forEach((reason) => {
      const key = reason.trim();
      if (!key) return;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    });
  });
  return Array.from(counts.entries())
    .map(([reason, count]) => ({ count, reason }))
    .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason))
    .slice(0, options.limit ?? 3);
}

export function buildRecentMemoryAdmissionSummary(options: { limit?: number } = {}): MemoryAdmissionSummary {
  const limit = Math.max(1, Math.min(RECENT_ADMISSION_LIMIT, options.limit ?? 40));
  const items = recentAdmissions.slice(0, limit);
  const suppressed = items.filter((item) => item.signal.status === 'suppress');
  return {
    admit: items.filter((item) => item.signal.status === 'admit').length,
    recentCount: items.length,
    review: items.filter((item) => item.signal.status === 'review').length,
    suppress: suppressed.length,
    suppressReasons: countAdmissionReasons(suppressed),
    topReasons: countAdmissionReasons(items),
  };
}

