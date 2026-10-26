import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import {
  loadMemories,
  type MemoryDraft,
  type MemoryEntry,
} from './memoryStore';
import type { MemoryAdmissionSignal, MemoryAdmissionStatus } from './memoryAdmissionControl';

export type MemoryImportanceGateKind = 'episode' | 'weekly';

export type MemoryImportanceGateSignal = MemoryAdmissionSignal & {
  kind: MemoryImportanceGateKind;
};

export type MemoryImportanceGateReasonCount = {
  count: number;
  reason: string;
};

export type MemoryImportanceGateSummary = {
  admit: number;
  recentCount: number;
  review: number;
  suppress: number;
  suppressReasons: MemoryImportanceGateReasonCount[];
  topReasons: MemoryImportanceGateReasonCount[];
};

type ImportanceGateOptions = {
  existingMemories?: Array<MemoryEntry | MemoryDraft>;
  kind?: MemoryImportanceGateKind;
  mode?: 'automatic' | 'manual';
};

const RECENT_IMPORTANCE_GATE_LIMIT = 80;
const recentImportanceGates: Array<{
  at: number;
  mode: 'automatic' | 'manual';
  signal: MemoryImportanceGateSignal;
}> = [];

const LONG_MEMORY_TAGS = ['阶段记忆', '周脉络'];
const TOPIC_PATTERN = /项目|功能|排查|调试|修复|优化|关系|约定|边界|身体|情绪|焦虑|失眠|疼|难受|创伤|校园|欺负|霸凌|生病|复盘|当前状态|记忆|星图|附近世界/;
const PROCESS_TERM_PATTERN = /阶段|计划|继续|进展|后来|然后|接着|结果|最终|原因|解决|没解决|卡住|反复|一直|逐步|这几天|最近|之前|上次|过程|变化|转折|影响|形成|希望|尝试|发现|排查|修复|优化|完成|留下|决定|后续/g;
const STRONG_PROCESS_PATTERN = /后来|然后|接着|结果|最终|转折|反复|逐步|过程|变化|进展|解决|没解决|卡住|影响|形成|尝试|发现|排查|修复|优化|完成|后续/;
const RESULT_OR_OPEN_PATTERN = /结果|最终|解决|没解决|卡住|仍然|留下|决定|完成|修好|失败|下次|后续|影响|还要|继续/;
const SMALL_TALK_PATTERN = /哈哈|笑死|随便|闲聊|八卦|表情包|梗|蜗牛|好玩|好笑|今天吃|买了|好吃|舍不得吃/;

function rememberImportanceGate(signal: MemoryImportanceGateSignal, mode: 'automatic' | 'manual') {
  recentImportanceGates.unshift({ at: Date.now(), mode, signal });
  if (recentImportanceGates.length > RECENT_IMPORTANCE_GATE_LIMIT) {
    recentImportanceGates.length = RECENT_IMPORTANCE_GATE_LIMIT;
  }
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
  for (let index = 0; index < normalized.length - 1; index += 1) {
    grams.add(normalized.slice(index, index + 2));
  }
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
  return `${candidate.title}\n${candidate.content}\n${candidate.domain}\n${candidate.tags.join(' ')}\n${candidate.recallCues.join(' ')}\n${candidate.rememberedReason ?? ''}`;
}

function memoryText(memory: MemoryEntry | MemoryDraft) {
  return `${memory.title}\n${memory.content}\n${memory.domain}\n${memory.tags.join(' ')}\n${memory.recallCues.join(' ')}\n${memory.rememberedReason ?? ''}`;
}

function longMemoryKind(candidate: MemoryDraft): MemoryImportanceGateKind | null {
  if (candidate.source === 'weekly-context' || candidate.tags.includes('周脉络')) return 'weekly';
  if (
    candidate.source === 'episode-memory'
    || candidate.semanticType === 'case'
    || candidate.tags.some((tag) => LONG_MEMORY_TAGS.includes(tag))
  ) {
    return 'episode';
  }
  return null;
}

function isLongMemory(memory: MemoryEntry | MemoryDraft) {
  return memory.semanticType === 'case'
    || memory.source === 'episode-memory'
    || memory.source === 'weekly-context'
    || memory.tags.some((tag) => LONG_MEMORY_TAGS.includes(tag));
}

function uniqueReasons(reasons: string[]) {
  return Array.from(new Set(reasons.map((reason) => reason.trim()).filter(Boolean))).slice(0, 4);
}

function buildSignal(input: {
  duplicate?: MemoryEntry | MemoryDraft;
  kind: MemoryImportanceGateKind;
  reasons: string[];
  score: number;
  status: MemoryAdmissionStatus;
}): MemoryImportanceGateSignal {
  return {
    duplicateMemoryId: input.duplicate && 'id' in input.duplicate ? input.duplicate.id : undefined,
    duplicateTitle: input.duplicate?.title,
    kind: input.kind,
    label: input.status === 'suppress'
      ? '长卡已跳过'
      : input.status === 'review'
        ? '长卡需要看一眼'
        : '长卡可生成',
    reasons: uniqueReasons(input.reasons.length ? input.reasons : ['阶段线索足够。']),
    score: Number(Math.max(0, Math.min(1, input.score)).toFixed(3)),
    status: input.status,
  };
}

export function evaluateEpisodeMemoryPreGate(
  messages: SubjectiveMessage[],
  options: { mode?: 'automatic' | 'manual'; remember?: boolean } = {},
): MemoryImportanceGateSignal {
  const mode = options.mode ?? 'automatic';
  const userText = messages
    .filter((message) => message.role === 'you')
    .map((message) => message.content)
    .join('\n');
  const compactLength = userText.replace(/\s+/g, '').length;
  const processTerms = userText.match(PROCESS_TERM_PATTERN) ?? [];
  const uniqueProcessTermCount = new Set(processTerms).size;
  const reasons: string[] = [];
  let score = 0;

  if (compactLength >= 260) score += 0.16;
  else reasons.push('聊天材料还不够长卡。');
  if (TOPIC_PATTERN.test(userText)) score += 0.16;
  else reasons.push('没有明显阶段主题。');
  if (STRONG_PROCESS_PATTERN.test(userText)) score += 0.18;
  else reasons.push('阶段推进线索不足。');
  if (uniqueProcessTermCount >= 3) score += 0.16;
  else reasons.push('过程词太少。');
  if (RESULT_OR_OPEN_PATTERN.test(userText)) score += 0.14;
  else reasons.push('缺少结果或未解决点。');
  if (messages.filter((message) => message.role === 'you').length >= 4) score += 0.08;
  if (SMALL_TALK_PATTERN.test(userText) && !RESULT_OR_OPEN_PATTERN.test(userText)) {
    score -= 0.18;
    reasons.push('更像普通闲聊，建议短卡或小纸条。');
  }

  const status: MemoryAdmissionStatus = mode === 'automatic' && score < 0.42
    ? 'suppress'
    : score < 0.58
      ? 'review'
      : 'admit';
  const signal = buildSignal({
    kind: 'episode',
    reasons,
    score,
    status,
  });
  if (options.remember) rememberImportanceGate(signal, mode);
  return signal;
}

export function evaluateLongMemoryCandidateGate(
  candidate: MemoryDraft,
  options: ImportanceGateOptions = {},
): MemoryImportanceGateSignal {
  const kind = options.kind ?? longMemoryKind(candidate) ?? 'episode';
  const mode = options.mode ?? 'automatic';
  if (!longMemoryKind(candidate) && candidate.semanticType !== 'case') {
    return buildSignal({
      kind,
      reasons: ['不是长卡候选。'],
      score: 1,
      status: 'admit',
    });
  }

  const text = candidateText(candidate);
  const compactLength = normalizeText(candidate.content).length;
  const processTerms = text.match(PROCESS_TERM_PATTERN) ?? [];
  const uniqueProcessTermCount = new Set(processTerms).size;
  const reasons: string[] = [];
  let score = 0.12;

  if (candidate.tags.some((tag) => LONG_MEMORY_TAGS.includes(tag)) || candidate.semanticType === 'case') score += 0.12;
  if (compactLength >= 80 && compactLength <= 520) score += 0.1;
  else if (compactLength < 80) reasons.push('长卡正文太薄。');
  if (TOPIC_PATTERN.test(text) || candidate.domain !== '其他') score += 0.12;
  else reasons.push('主题不够明确。');
  if (STRONG_PROCESS_PATTERN.test(text)) score += 0.16;
  else reasons.push('缺少连续推进线。');
  if (uniqueProcessTermCount >= 3) score += 0.14;
  else reasons.push('过程线索不足。');
  if (RESULT_OR_OPEN_PATTERN.test(text)) score += 0.12;
  else reasons.push('缺少结果或未解决点。');
  if (candidate.rememberedReason?.trim()) score += 0.08;
  if (candidate.importance >= 7 || candidate.arousal >= 0.65) score += 0.08;
  if (SMALL_TALK_PATTERN.test(text) && !RESULT_OR_OPEN_PATTERN.test(text)) {
    score -= 0.18;
    reasons.push('更像闲聊碎片，建议短卡保存。');
  }

  let duplicate: { memory: MemoryEntry | MemoryDraft; score: number } | null = null;
  for (const memory of (options.existingMemories ?? []).filter(isLongMemory)) {
    const duplicateScore = similarity(text, memoryText(memory));
    if (!duplicate || duplicateScore > duplicate.score) duplicate = { memory, score: duplicateScore };
  }

  if (duplicate && duplicate.score >= 0.84) {
    score -= 0.45;
    reasons.push(`和已有长卡“${duplicate.memory.title}”非常相似。`);
  } else if (duplicate && duplicate.score >= 0.72) {
    score -= 0.22;
    reasons.push(`可能已有相似长卡：“${duplicate.memory.title}”。`);
  }

  const strongDuplicate = !!duplicate && duplicate.score >= 0.84;
  const status: MemoryAdmissionStatus = mode === 'automatic' && (strongDuplicate || score < 0.44)
    ? 'suppress'
    : score < 0.58 || strongDuplicate
      ? 'review'
      : 'admit';
  return buildSignal({
    duplicate: duplicate && duplicate.score >= 0.72 ? duplicate.memory : undefined,
    kind,
    reasons,
    score,
    status,
  });
}

function mergeAdmission(
  current: MemoryAdmissionSignal | undefined,
  gate: MemoryImportanceGateSignal,
): MemoryAdmissionSignal {
  if (!current || gate.status !== 'admit') {
    return {
      duplicateMemoryId: gate.duplicateMemoryId,
      duplicateTitle: gate.duplicateTitle,
      label: gate.label,
      reasons: gate.reasons,
      score: gate.score,
      status: gate.status,
    };
  }
  return current;
}

export async function filterAutomaticLongMemoryCandidates<T extends MemoryDraft & { admission?: MemoryAdmissionSignal }>(
  candidates: T[],
  options: ImportanceGateOptions = {},
): Promise<T[]> {
  if (!candidates.length) return [];
  const existing = options.existingMemories ?? await loadMemories({ includeArchived: false }).catch(() => []);
  const accepted: T[] = [];
  for (const candidate of candidates) {
    const kind = longMemoryKind(candidate);
    if (!kind && candidate.semanticType !== 'case') {
      accepted.push(candidate);
      continue;
    }
    const signal = evaluateLongMemoryCandidateGate(candidate, {
      ...options,
      existingMemories: [...existing, ...accepted],
      kind: options.kind ?? kind ?? 'episode',
      mode: 'automatic',
    });
    rememberImportanceGate(signal, 'automatic');
    if (signal.status === 'suppress') continue;
    accepted.push({
      ...candidate,
      admission: mergeAdmission(candidate.admission, signal),
    });
  }
  return accepted;
}

export async function annotateManualLongMemoryCandidates<T extends MemoryDraft & { admission?: MemoryAdmissionSignal }>(
  candidates: T[],
  options: ImportanceGateOptions = {},
): Promise<T[]> {
  if (!candidates.length) return [];
  const existing = options.existingMemories ?? await loadMemories({ includeArchived: false }).catch(() => []);
  return candidates.map((candidate) => {
    const kind = longMemoryKind(candidate);
    if (!kind && candidate.semanticType !== 'case') return candidate;
    const signal = evaluateLongMemoryCandidateGate(candidate, {
      ...options,
      existingMemories: existing,
      kind: options.kind ?? kind ?? 'episode',
      mode: 'manual',
    });
    rememberImportanceGate(signal, 'manual');
    return {
      ...candidate,
      admission: mergeAdmission(candidate.admission, signal),
    };
  });
}

function countGateReasons(
  items: Array<{ signal: MemoryImportanceGateSignal }>,
  options: { limit?: number } = {},
): MemoryImportanceGateReasonCount[] {
  const counts = new Map<string, number>();
  items.forEach((item) => {
    item.signal.reasons.forEach((reason) => {
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
    });
  });
  return Array.from(counts.entries())
    .map(([reason, count]) => ({ count, reason }))
    .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason))
    .slice(0, options.limit ?? 3);
}

export function buildRecentMemoryImportanceGateSummary(
  options: { limit?: number } = {},
): MemoryImportanceGateSummary {
  const limit = Math.max(1, Math.min(RECENT_IMPORTANCE_GATE_LIMIT, options.limit ?? 40));
  const items = recentImportanceGates.slice(0, limit);
  const suppressed = items.filter((item) => item.signal.status === 'suppress');
  return {
    admit: items.filter((item) => item.signal.status === 'admit').length,
    recentCount: items.length,
    review: items.filter((item) => item.signal.status === 'review').length,
    suppress: suppressed.length,
    suppressReasons: countGateReasons(suppressed),
    topReasons: countGateReasons(items),
  };
}
