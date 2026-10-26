import { analyzeScheduleCompletionSemantics } from './scheduleSemanticCleaner';

const COMPLETION_WORDS = /(?:终于|已经|刚刚|刚才|今天).{0,12}(?:做完|完成|办完|处理完|看完|写完|修好|弄好|搞定)|(?:交了|提交了|去了|吃了|买了)/;
const CONTEXTUAL_PAST_ACTION = /(?:终于|已经|刚刚|刚才|今天).{0,12}(?:去|办|处理|交|提交|看|写|修|弄|吃|买).{0,12}了/;
const QUESTION_OR_UNCERTAIN = /[？?]|(?:是不是|算不算|完成了吗|做完了吗|有没有)/;
const NEGATED = /(?:没|没有|还没|并未|未能|没来得及).{0,8}(?:做完|完成|办|处理|交|提交|去|看|写|修|弄|搞定|吃|买)/;
const FUTURE = /(?:明天|后天|下周|待会|等会|之后|一会儿|准备|打算|计划|想要|要去|会去|再去).{0,16}(?:做|办|处理|交|提交|去|看|写|修|弄|吃|买)/;

export function looksLikeCompletionNarrative(text: string) {
  const compact = text.trim();
  if (!compact || compact.length > 140) return false;
  const semantics = analyzeScheduleCompletionSemantics(compact);
  if (
    QUESTION_OR_UNCERTAIN.test(compact)
    || NEGATED.test(compact)
    || FUTURE.test(compact)
    || semantics.isLikelyProgressReport
    || (semantics.hasCompletionVerb && !semantics.hasConcretePastMarker && !semantics.hasScheduleObject)
  ) return false;
  return COMPLETION_WORDS.test(compact) || CONTEXTUAL_PAST_ACTION.test(compact);
}

export function selectNarrativeCompletionCandidate<T extends { score: number }>(candidates: T[]) {
  const ranked = [...candidates].sort((left, right) => right.score - left.score);
  const first = ranked[0];
  if (!first || first.score < 5) return null;
  if (ranked[1] && first.score - ranked[1].score < 2) return null;
  return first;
}
