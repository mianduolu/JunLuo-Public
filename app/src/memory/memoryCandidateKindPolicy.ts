import type { MemoryDraft } from './memoryStore';

export type MemoryCandidateKind = 'long_term' | 'small_note' | 'emotional_weather';

export type MemoryCandidateWithKind = MemoryDraft & {
  candidateKind?: MemoryCandidateKind;
};

export const MEMORY_CANDIDATE_KIND_POLICIES: Record<MemoryCandidateKind, {
  admissionReason: string;
  hint: string;
  label: string;
  tag: string;
}> = {
  emotional_weather: {
    admissionReason: '这是近期状态，能帮助白云更温柔地承接。',
    hint: '这是近期状态，白云会更小心承接，不把它当成定论。',
    label: '情绪天气',
    tag: '情绪天气',
  },
  long_term: {
    admissionReason: '这像长期有用的记忆。',
    hint: '这是长期有用的记忆，保存后会稳定参与以后想起。',
    label: '长期记忆',
    tag: '长期记忆',
  },
  small_note: {
    admissionReason: '这是具体小事，值得被轻轻看见。',
    hint: '这是近期小事，保存后会轻轻参与近期陪伴，不是永久标签。',
    label: '近况小纸条',
    tag: '近况小纸条',
  },
};

export function normalizeMemoryCandidateKind(value: unknown): MemoryCandidateKind | undefined {
  return value === 'long_term' || value === 'small_note' || value === 'emotional_weather'
    ? value
    : undefined;
}

export function getMemoryCandidateKind(candidate: Partial<MemoryCandidateWithKind>): MemoryCandidateKind {
  if (candidate.candidateKind) return candidate.candidateKind;
  if (candidate.source === 'small-note' || candidate.tags?.some((tag) => tag === '近况小纸条')) return 'small_note';
  if (candidate.source === 'emotional-weather' || candidate.tags?.some((tag) => tag === '情绪天气')) return 'emotional_weather';
  return 'long_term';
}

export function getMemoryCandidateKindPolicy(candidate: Partial<MemoryCandidateWithKind>) {
  return MEMORY_CANDIDATE_KIND_POLICIES[getMemoryCandidateKind(candidate)];
}

export function applyMemoryCandidateKindDefaults(
  candidate: MemoryDraft,
  kind?: MemoryCandidateKind,
): MemoryCandidateWithKind {
  if (!kind || kind === 'long_term') {
    return kind ? { ...candidate, candidateKind: 'long_term' } : candidate;
  }
  const policy = MEMORY_CANDIDATE_KIND_POLICIES[kind];
  const tags = Array.from(new Set([policy.tag, ...(candidate.tags ?? [])]));
  if (kind === 'small_note') {
    return {
      ...candidate,
      anchor: false,
      candidateKind: kind,
      importance: Math.max(2, Math.min(5, candidate.importance ?? 3)),
      pinned: false,
      protected: false,
      semanticType: candidate.semanticType === 'pattern' ? 'event' : candidate.semanticType ?? 'event',
      source: 'small-note',
      sourceType: 'automatic',
      stability: Math.min(candidate.stability ?? 0.35, 0.45),
      tags,
    };
  }
  return {
    ...candidate,
    anchor: false,
    arousal: Math.max(candidate.arousal ?? 0.45, 0.45),
    candidateKind: kind,
    importance: Math.max(3, Math.min(6, candidate.importance ?? 4)),
    pinned: false,
    protected: false,
    semanticType: candidate.semanticType === 'event' ? 'event' : 'pattern',
    source: 'emotional-weather',
    sourceType: 'automatic',
    stability: Math.min(candidate.stability ?? 0.35, 0.45),
    tags,
  };
}

export function isConcreteLightMemoryCandidate(candidate: MemoryDraft, kind = getMemoryCandidateKind(candidate)) {
  if (kind === 'long_term') return true;
  const compact = `${candidate.title}${candidate.content}${candidate.recallCues.join('')}`.replace(/\s+/g, '');
  if (compact.length < 14) return false;
  if (kind === 'emotional_weather') {
    return /不开心|难过|委屈|焦虑|害怕|不安|压力|冲突|吵架|被骂|被凶|被欺负|霸凌|受伤|伤害|冒犯|越界|情绪|朋友|家人|同学|同事|室友/.test(compact);
  }
  return /买|吃|喝|看|听|收到|发现|做了|去了|今天|昨天|刚才|舍不得|喜欢|想要|在意|贵|礼物|快递|点心|蛋黄酥|奶茶|咖啡|音乐|电影|书|游戏/.test(compact);
}
