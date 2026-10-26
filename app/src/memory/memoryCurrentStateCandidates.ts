import type { MemoryCandidateReview } from './memoryCandidateReview';
import type { MemoryEntry } from './memoryStore';
import type { MemoryIngestionItemRef } from './memoryIngestionLedger';
import type { MemorySourceRefInput } from './memorySourceRefs';
import {
  type MemoryCurrentState,
  type MemoryCurrentStateDraft,
  type MemoryCurrentStateKind,
  type MemoryCurrentStateResolveReason,
} from './memoryCurrentStateStore';

export type MemoryCurrentStateCandidate = MemoryCurrentStateDraft & {
  requiresRecheck?: boolean;
  ingestionRef?: MemoryIngestionItemRef;
  sourceRefs?: MemorySourceRefInput[];
  note?: string;
  reviewId: string;
};

export type MemoryCurrentStateResolveCandidate = {
  requiresRecheck?: boolean;
  ingestionRef?: MemoryIngestionItemRef;
  sourceRefs?: MemorySourceRefInput[];
  content: string;
  reason: MemoryCurrentStateResolveReason;
  reviewId: string;
  stateId: string;
  title: string;
};

const EMOTION_PATTERN = /心情|难过|不开心|低落|焦虑|不安|委屈|崩溃|害怕|想哭|情绪|压力|破防/;
const SLEEP_BODY_PATTERN = /睡|困|累|疼|身体|胃|头痛|生病|鼻炎|过敏|发烧|不舒服|疲惫|失眠/;
const PROJECT_PATTERN = /项目|功能|计划|章节|开发|调试|修复|实现|君落|白云|APP|app|代码|测试/;
const TASK_PATTERN = /要做|待办|还没|准备|打算|需要|ddl|作业|考试|报名|处理|收拾|整理/;
const RELATION_PATTERN = /朋友|同学|家人|妈妈|爸爸|老师|同事|室友|对方|关系|相处|吵架|消息/;
const SENSITIVE_PATTERN = /创伤|霸凌|欺负|伤害|自杀|自伤|闪回|恐惧|阴影|越界|骚扰/;
const RECENT_PATTERN = /今天|今晚|刚刚|刚才|这两天|这几天|这阵子|这段时间|最近|本周|这周|现在|眼下|目前|临时|这次|因为.+?这/;
const LONG_TERM_PATTERN = /一直|很多年|从小|长期|总是|每次|经常|反复|很久没|很久没有|好多年|从来都|一直都/;

const RESOLVE_PATTERNS: Array<[RegExp, MemoryCurrentStateResolveReason]> = [
  [/好多了|好转了|缓过来了|现在好多|没那么|不难受了|不疼了/, 'improved'],
  [/做完了|完成了|结束了|已经结束|办完了|解决了|过去了|没事了/, 'ended'],
  [/现在不是这样了|不是这样了|不这样了|这个过期了|这个不适用了/, 'mistaken'],
];

export function classifyMemoryCurrentStateKind(text: string): MemoryCurrentStateKind {
  if (SENSITIVE_PATTERN.test(text)) return 'sensitive_topic';
  if (SLEEP_BODY_PATTERN.test(text)) return 'sleep_body';
  if (EMOTION_PATTERN.test(text)) return 'emotional_weather';
  if (PROJECT_PATTERN.test(text)) return 'project';
  if (TASK_PATTERN.test(text)) return 'task';
  if (RELATION_PATTERN.test(text)) return 'relationship';
  return 'other';
}

export function makeCurrentStateCandidatesFromMemoryCandidate(candidate: MemoryCandidateReview): MemoryCurrentStateCandidate[] {
  // Voice keeps its existing selection rule; ordinary chat uses the reviewed proposal.
  if (candidate.origin !== 'voice_call' || candidate.understandingSubject) return [];
  const text = `${candidate.title}\n${candidate.content}`;
  const recent = RECENT_PATTERN.test(text) || candidate.candidateKind === 'small_note' || candidate.candidateKind === 'emotional_weather';
  const longTerm = LONG_TERM_PATTERN.test(text);
  if (!recent && !(longTerm && (EMOTION_PATTERN.test(text) || SLEEP_BODY_PATTERN.test(text) || SENSITIVE_PATTERN.test(text)))) return [];
  return [{ title: candidate.title || candidate.content, content: candidate.content,
    kind: classifyMemoryCurrentStateKind(text), reviewId: `current-state-${candidate.reviewId}`,
    sourceCandidateId: candidate.reviewId, sourceTitle: candidate.title, sourceType: 'candidate',
    sourceRefs: candidate.sourceRefs, startsAt: Date.now(), requiresRecheck: true }];
}

export function makeCurrentStateCandidateFromMemory(memory: MemoryEntry, sourceRefs: MemorySourceRefInput[] = []): MemoryCurrentStateCandidate {
  const startsAt = Date.now();
  const kind = classifyMemoryCurrentStateKind(`${memory.title}\n${memory.content}\n${memory.tags.join(' ')}`);
  return {
    content: memory.content,
    kind,
    note: '从这条记忆临时摘出一张当前状态便利贴，结束后不会删除原记忆。',
    reviewId: `current-state-memory-${memory.id}-${startsAt}`,
    sourceMemoryId: memory.id,
    sourceTitle: memory.title,
    sourceType: 'memory',
    sourceRefs,
    startsAt,
    title: memory.title || '当前状态',
  };
}

function overlapScore(left: string, right: string) {
  const normalize = (value: string) => value.toLowerCase().replace(/[^\u3400-\u9fffa-z0-9]+/g, '');
  const leftText = normalize(left);
  const rightText = normalize(right);
  if (!leftText || !rightText) return 0;
  const terms = new Set<string>();
  for (let index = 0; index < Math.max(0, leftText.length - 1); index += 1) terms.add(leftText.slice(index, index + 2));
  if (!terms.size) return 0;
  let hit = 0;
  terms.forEach((term) => {
    if (rightText.includes(term)) hit += 1;
  });
  return hit / terms.size;
}

export function detectCurrentStateResolutionIntent(text: string, activeStates: MemoryCurrentState[]) {
  const trimmed = text.trim();
  if (!trimmed || !activeStates.length) return [];
  const matched = RESOLVE_PATTERNS.find(([pattern]) => pattern.test(trimmed));
  if (!matched) return [];
  const [, reason] = matched;
  const ranked = activeStates
    .map((state) => ({
      score: overlapScore(`${state.title}\n${state.content}\n${state.sourceTitle ?? ''}`, trimmed),
      state,
    }))
    .sort((left, right) => right.score - left.score);
  const selected = ranked[0]?.score >= 0.08
    ? ranked.filter((item) => item.score >= 0.08).slice(0, 2)
    : activeStates.slice(0, Math.min(2, activeStates.length)).map((state) => ({ score: 0, state }));
  return selected.map(({ state }): MemoryCurrentStateResolveCandidate => ({
    content: state.content,
    reason,
    reviewId: `resolve-current-state-${state.id}-${Date.now()}`,
    stateId: state.id,
    title: state.title,
  }));
}
