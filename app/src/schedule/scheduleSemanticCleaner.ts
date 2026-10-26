export type ScheduleCompletionSemantics = {
  cleanText: string;
  hasCompletionVerb: boolean;
  hasConcretePastMarker: boolean;
  hasContinuationMarker: boolean;
  hasExplicitCompletionAction: boolean;
  hasPartialMarker: boolean;
  hasProjectContext: boolean;
  hasScheduleObject: boolean;
  isBareCompletionAck: boolean;
  isExplicitCompletionCommand: boolean;
  isLikelyProgressReport: boolean;
};

const completionVerbs = ['完成', '做完', '搞定', '弄完', '处理完', '写完', '学完', '看完', '修完', '弄好', '做好', '修好'];
const concretePastMarkers = ['终于', '已经', '刚刚', '刚才', '今天', '提交了', '交了', '去了', '吃了', '买了'];
const commandSubjects = ['把', '帮我', '帮鼠', '给我', '给鼠'];
const completionActions = ['标记', '设为', '改成', '点成', '点掉', '勾掉', '打勾'];
const scheduleObjects = ['待办', '代办', '任务', '事项', '日程', '提醒', '时间块', '安排'];
const deicticObjects = ['这个', '这条', '这项', '它'];
const partialMarkers = ['基本上', '差不多', '大概', '几乎', '快', '算是', '应该', '可能'];
const continuationMarkers = ['但是', '但', '不过', '只是', '还', '剩下', '其他', '也要', '继续', '没做完', '做不完'];
const projectContextWords = ['功能', '系统', '页面', '界面', '代码', '项目', '模块', '开发', 'debug', '测试'];
const bareCompletionAcks = ['完成了', '做完了', '搞定了', '弄完了', '好了', '结束了', '已完成'];

export function normalizeScheduleSemanticText(text: string) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[\s"'“”‘’`·,，。.!！?？；;：:、（）()【】[\]{}<>《》~～…]+/g, '');
}

function containsAny(text: string, words: readonly string[]) {
  return words.some((word) => text.includes(word.toLowerCase()));
}

function indexOfAny(text: string, words: readonly string[]) {
  let result = -1;
  words.forEach((word) => {
    const index = text.indexOf(word.toLowerCase());
    if (index >= 0 && (result < 0 || index < result)) result = index;
  });
  return result;
}

function hasOrderedPairWithin(text: string, leftWords: readonly string[], rightWords: readonly string[], maxDistance: number) {
  const leftIndex = indexOfAny(text, leftWords);
  if (leftIndex < 0) return false;
  return rightWords.some((word) => {
    const rightIndex = text.indexOf(word.toLowerCase(), leftIndex);
    return rightIndex >= 0 && rightIndex - leftIndex <= maxDistance;
  });
}

export function analyzeScheduleCompletionSemantics(text: string): ScheduleCompletionSemantics {
  const cleanText = normalizeScheduleSemanticText(text);
  const hasCompletionVerb = containsAny(cleanText, completionVerbs);
  const hasConcretePastMarker = containsAny(cleanText, concretePastMarkers);
  const hasScheduleObject = containsAny(cleanText, scheduleObjects);
  const hasDeicticObject = containsAny(cleanText, deicticObjects);
  const hasPartialMarker = containsAny(cleanText, partialMarkers);
  const hasContinuationMarker = containsAny(cleanText, continuationMarkers);
  const hasProjectContext = containsAny(cleanText, projectContextWords);
  const hasExplicitCompletionAction =
    hasOrderedPairWithin(cleanText, commandSubjects, completionVerbs, 36)
    || hasOrderedPairWithin(cleanText, commandSubjects, completionActions, 36);
  const objectCompletion = (hasScheduleObject || hasDeicticObject)
    && hasCompletionVerb
    && !hasPartialMarker
    && !hasContinuationMarker;
  const isBareCompletionAck = bareCompletionAcks.includes(cleanText);
  const isExplicitCompletionCommand = hasExplicitCompletionAction || objectCompletion;
  const isLikelyProgressReport = hasCompletionVerb
    && !hasExplicitCompletionAction
    && (hasPartialMarker || hasContinuationMarker || hasProjectContext);

  return {
    cleanText,
    hasCompletionVerb,
    hasConcretePastMarker,
    hasContinuationMarker,
    hasExplicitCompletionAction,
    hasPartialMarker,
    hasProjectContext,
    hasScheduleObject,
    isBareCompletionAck,
    isExplicitCompletionCommand,
    isLikelyProgressReport,
  };
}
