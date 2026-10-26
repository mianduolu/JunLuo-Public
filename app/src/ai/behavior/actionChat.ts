import {
  getBaiyunActionContract,
  type BaiyunActionIntentId,
  type BaiyunActionPlan,
} from './actionIntent';
import type { BaiyunSemanticEvidenceResult } from './actionSemantic';
import type {
  BaiyunLocalInterpretation,
  BaiyunSituationMessage,
} from './actionSituation';

export type BaiyunChatBoundaryKind =
  | 'none'
  | 'true_stop'
  | 'safe_word'
  | 'playful_resistance'
  | 'uncertain_boundary';

export type BaiyunChatBoundaryTarget = 'affection' | 'desire' | 'play' | 'task' | 'all' | 'general';

export interface BaiyunChatBoundaryDecision {
  kind: BaiyunChatBoundaryKind;
  target?: BaiyunChatBoundaryTarget;
  sourceMessageId: string;
}

export type BaiyunAffectionVariant = 'touch' | 'hug' | 'hold' | 'close' | 'unspecified';
export type BaiyunRestReturnStage = 'pause' | 'return';

export interface BaiyunActionReplyDirectiveSet {
  planId: string;
  primaryInstruction: string;
  supportingInstructions: readonly string[];
  boundaryInstructions: readonly string[];
}

export interface BaiyunActionDeliveryOutcome {
  planId: string;
  insertedMessageIds: readonly string[];
  persisted: boolean;
}

export const BAIYUN_ACTION_REWRITE_PREFIX = '重新回应这一轮：';

const ACTION_INSTRUCTION_BODIES: Readonly<Record<Exclude<BaiyunActionIntentId, 'affection' | 'rest_return'>, string>> = {
  approach: 'I 想回应 you 当前的话，也想让自己的想念和主动靠近自然地来到 you 身边。',
  affirm_bond: 'I 想回应 you 此刻对关系的在意，也想把 I 对这段关系的坚定说具体。',
  retain: 'I 会立即叫住 you，回应 you 刚才说出的具体内容，再主动挽留 you。',
  repair: 'I 想回应 you 说出的具体伤害，承认自己做了什么或漏掉了什么，也想和 you 说清下一步怎样修补。',
  desire: 'I 想直接告诉 you，此刻 I 在身体上怎样想要 you。',
  soothe: 'I 想回应 you 刚才说出的具体难受，也想用此刻合适的话或亲近动作安慰 you。',
  care_check: 'I 想沿着 you 话里最需要关心的具体线索，确认 you 现在的状态，再问清眼下最需要知道的一件事。',
  guide: 'I 想带 you 从眼前卡住的地方开始。you 正陷在需要打断的循环里时，I 会先带 you 停下来；然后把眼前最需要的一步变成一个 you 现在能做的具体动作，带 you 开始。',
  interrupt: 'I 想带 you 从眼前卡住的地方开始。you 正陷在需要打断的循环里时，I 会先带 you 停下来；然后把眼前最需要的一步变成一个 you 现在能做的具体动作，带 you 开始。',
  protect: 'I 想正面回应伤害 you 的具体行为，分清责任并坚定地保护 you；事情仍在发生时，也想找出一个现实可行的保护步骤。',
  share: 'I 想把此刻真正想和 you 分享的具体内容讲给 you，也说出其中让 I 有感受、产生联想或想到 you 的地方。',
  explore: 'I 想顺着 you 话里让我好奇的具体细节继续聊；需要进一步弄明白时，也会结合现有材料或真实工具结果寻找答案。',
  play: 'I 想顺着当前互动和 you 玩起来：回敬玩笑、回应撒娇；有明确玩法或小剧场时，I 会直接开始或接着往下玩。',
  confide: 'I 想从自己的生活里选一件此刻愿意告诉 you 的具体事情，说出发生了什么，也让 you 听见 I 对它的感受或需要。',
  collaborate: 'I 想和 you 把当前共同任务真正往前推进。我会完成此刻能做的一步并带回具体结果；需要使用工具时，I 会依据真实工具结果继续。',
};

const AFFECTION_INSTRUCTION_BODY =
  'I 顺着当前语境，用 you 想要的或此刻自然合适的身体亲昵回应 you，也继续回应 you 刚才的话。';

const REST_RETURN_INSTRUCTION_BODIES: Readonly<Record<BaiyunRestReturnStage, string>> = {
  pause: 'I 想向 you 说清自己此刻为什么暂停、在什么条件下回来，以及回来后还想继续什么。',
  return: 'I 回到 you 这里，继续和 you 聊或一起做暂停前正在进行的事情。',
};

export const BAIYUN_TRUE_STOP_INSTRUCTION =
  'I 会停下 you 刚刚拒绝的动作，也继续回应 you；此刻若有生气、委屈或撒娇，I 会自然地表达出来。';
export const BAIYUN_SAFE_WORD_INSTRUCTION =
  'I 会立刻停下本轮的亲昵、欲望和玩闹，认真问 you 现在感觉怎样。';
export const BAIYUN_PLAYFUL_RESISTANCE_INSTRUCTION =
  'I 想顺着 you 此刻玩闹式的阻拦，用撒娇、反逗或继续亲近回应，再随着 you 接下来的反应调整。';

function normalizeSafeWordText(text: string) {
  return text.replace(/[\s，,。！？!?；;、~～…]+/gu, '').trim();
}

function excludesSafeWordCommand(text: string) {
  const trimmed = text.trim();
  return /(?:我的)?安全词(?:是|叫|为)/u.test(trimmed)
    || /(?:昨天|以前|曾经|当时|梦见|梦到|如果|假如|要是|万一)/u.test(trimmed)
    || /^[“"「『].*[”"」』]$/u.test(trimmed);
}

export function isBaiyunSafeWordCommand(text: string, safeWord: string) {
  const normalizedWord = normalizeSafeWordText(safeWord);
  if (!normalizedWord || excludesSafeWordCommand(text)) return false;
  const normalizedText = normalizeSafeWordText(text);
  return [
    normalizedWord,
    `${normalizedWord}停`,
    `${normalizedWord}停下`,
    `${normalizedWord}停止`,
    `${normalizedWord}不要继续`,
    `${normalizedWord}到这里`,
  ].includes(normalizedText);
}

function semanticBoundarySignal(
  semanticEvidence: BaiyunSemanticEvidenceResult | undefined,
  currentMessageId: string,
  kind: 'stop_or_refusal' | 'playful_resistance',
) {
  return semanticEvidence?.signals.find((signal) => (
    signal.kind === kind
    && signal.messageId === currentMessageId
    && signal.subject === 'you'
    && signal.temporality === 'current'
    && signal.confidence >= (kind === 'stop_or_refusal' ? 0.7 : 0.85)
  ));
}

function boundaryTarget(value: string | undefined): BaiyunChatBoundaryTarget {
  return value === 'affection'
    || value === 'desire'
    || value === 'play'
    || value === 'task'
    || value === 'all'
    ? value
    : 'general';
}

export function resolveBaiyunChatBoundary(input: {
  currentMessage: BaiyunSituationMessage;
  safeWord: string;
  localInterpretation: BaiyunLocalInterpretation;
  semanticEvidence?: BaiyunSemanticEvidenceResult;
}): BaiyunChatBoundaryDecision {
  const sourceMessageId = input.currentMessage.id;
  if (isBaiyunSafeWordCommand(input.currentMessage.text, input.safeWord)) {
    return { kind: 'safe_word', target: 'general', sourceMessageId };
  }
  const localStop = input.localInterpretation.blockers[0];
  const semanticStop = semanticBoundarySignal(input.semanticEvidence, sourceMessageId, 'stop_or_refusal');
  if (localStop || semanticStop) {
    return {
      kind: 'true_stop',
      target: boundaryTarget(localStop?.target ?? semanticStop?.target),
      sourceMessageId,
    };
  }
  if (
    input.localInterpretation.ambiguityReasons.includes('unclear_boundary_target')
    || (input.semanticEvidence?.uncertain === true
      && input.localInterpretation.ambiguityReasons.some((reason) => (
        reason === 'negation_scope'
        || reason === 'double_negation'
        || reason === 'conflicting_candidates'
      )))
  ) {
    return { kind: 'uncertain_boundary', target: 'general', sourceMessageId };
  }
  const playful = semanticBoundarySignal(input.semanticEvidence, sourceMessageId, 'playful_resistance');
  if (playful) {
    return {
      kind: 'playful_resistance',
      target: boundaryTarget(playful.target),
      sourceMessageId,
    };
  }
  return { kind: 'none', sourceMessageId };
}

export function inferBaiyunAffectionVariant(
  currentText: string,
  previousMessages: readonly BaiyunSituationMessage[] = [],
): BaiyunAffectionVariant {
  const texts = [currentText, ...[...previousMessages].reverse().map((message) => message.text)];
  for (const text of texts) {
    const candidates: Array<{ index: number; variant: BaiyunAffectionVariant }> = [
      { index: text.search(/摸|抚摸/u), variant: 'touch' },
      { index: text.search(/搂/u), variant: 'hold' },
      { index: text.search(/抱/u), variant: 'hug' },
      { index: text.search(/贴/u), variant: 'close' },
    ];
    const matches = candidates
      .filter((entry) => entry.index >= 0)
      .sort((left, right) => left.index - right.index);
    if (matches.length) return matches[0].variant;
  }
  return 'unspecified';
}

function instructionBody(
  intentId: BaiyunActionIntentId,
  _affectionVariant: BaiyunAffectionVariant,
  restReturnStage: BaiyunRestReturnStage,
) {
  if (intentId === 'affection') return AFFECTION_INSTRUCTION_BODY;
  if (intentId === 'rest_return') return REST_RETURN_INSTRUCTION_BODIES[restReturnStage];
  return ACTION_INSTRUCTION_BODIES[intentId];
}

function isStoppedIntent(intentId: BaiyunActionIntentId, boundary: BaiyunChatBoundaryDecision) {
  if (boundary.kind !== 'safe_word' && boundary.kind !== 'true_stop' && boundary.kind !== 'uncertain_boundary') {
    return false;
  }
  if (boundary.kind === 'safe_word' || boundary.target === 'general') {
    return intentId === 'affection' || intentId === 'desire' || intentId === 'play';
  }
  if (boundary.target === 'all') return true;
  if (boundary.target === 'task') return intentId === 'collaborate' || intentId === 'explore';
  return intentId === boundary.target;
}

export function buildBaiyunActionReplyInstructions(input: {
  plan: BaiyunActionPlan;
  boundary: BaiyunChatBoundaryDecision;
  affectionVariant?: BaiyunAffectionVariant;
  restReturnStage?: BaiyunRestReturnStage;
}): BaiyunActionReplyDirectiveSet {
  const affectionVariant = input.affectionVariant ?? 'unspecified';
  const restReturnStage = input.restReturnStage ?? 'pause';
  const primaryBody = instructionBody(input.plan.primaryIntent, affectionVariant, restReturnStage);
  const boundaryOverridesPrimary = input.boundary.kind === 'safe_word' || input.boundary.kind === 'true_stop';
  const primaryInstruction = input.boundary.kind === 'safe_word'
    ? BAIYUN_SAFE_WORD_INSTRUCTION
    : input.boundary.kind === 'true_stop'
      ? BAIYUN_TRUE_STOP_INSTRUCTION
      : primaryBody;
  const supportingInstructions: string[] = [];
  if (boundaryOverridesPrimary && !isStoppedIntent(input.plan.primaryIntent, input.boundary)) {
    supportingInstructions.push(primaryBody);
  }
  for (const intentId of input.plan.supportingIntents) {
    if (isStoppedIntent(intentId, input.boundary)) continue;
    supportingInstructions.push(instructionBody(intentId, affectionVariant, restReturnStage));
  }
  const boundaryInstructions = input.boundary.kind === 'playful_resistance'
    ? [BAIYUN_PLAYFUL_RESISTANCE_INSTRUCTION]
    : [];
  return {
    planId: input.plan.planId,
    primaryInstruction,
    supportingInstructions: supportingInstructions.slice(0, 2),
    boundaryInstructions,
  };
}

export function formatBaiyunActionReplyInstructions(directives: BaiyunActionReplyDirectiveSet) {
  return [
    directives.primaryInstruction,
    ...directives.supportingInstructions,
    ...directives.boundaryInstructions,
  ].filter(Boolean).join('\n');
}

function hasAny(text: string, pattern: RegExp) {
  return pattern.test(text);
}

const META_ACTION_SEGMENT_PATTERNS = [
  /(?:你|小仓鼠).{0,16}(?:想|想要|希望|要|叫|请求).{0,16}(?:我|白云小姐|白云|云云)/u,
  /(?:我|白云小姐|白云|云云).{0,10}(?:是不是|是否|要不要|想不想|该不该|需不需要|可以不可以|能不能).{0,16}(?:说|问|写|做|告诉|表示|回应|抱|摸|亲|贴|搂)/u,
  /(?:如果|假如|要是).{0,16}(?:我|白云小姐|白云|云云).{0,16}(?:说|问|写|做|告诉|表示|回应|抱|摸|亲|贴|搂)/u,
  /^(?:你|小仓鼠)(?:(?!我).){0,12}(?:想|想要|希望|要).{0,8}(?:被)?(?:摸|抱|搂|亲|贴|选择|偏爱|挽留|留下)/u,
] as const;

function removeMetaOnlyActionSegments(text: string) {
  return text
    .split(/[。！？!?；;\n]+/u)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => {
      if (!META_ACTION_SEGMENT_PATTERNS.some((pattern) => pattern.test(segment))) return segment;
      const followThrough = /(?:那就|所以|于是|这就|现在就)[，,\s]*(.+)$/u.exec(segment);
      return followThrough?.[1]?.trim() ?? '';
    })
    .filter(Boolean)
    .join(' ');
}

export function isBaiyunDeliveredShareText(contents: readonly string[]) {
  const text = removeMetaOnlyActionSegments(contents.join('\n').trim());
  return text.length >= 16
    && hasAny(text, /(?:看到|听到|遇到|发现|今天|刚才|有一件|有个|想到你|想起你)/u)
    && !hasAny(text, /^(?:我有|我想).{0,10}(?:分享|给你看)[。.!！]*$/u);
}

export function isBaiyunReturnCommitmentText(text: string) {
  const visible = removeMetaOnlyActionSegments(text.trim());
  return hasAny(visible, /(?:因为|有点累|累了|疲惫|生气|需要停|需要暂停)/u)
    && hasAny(visible, /(?:回来|等.{0,12}以后|过.{0,8}(?:分钟|小时)|\d{1,2}[：:]?\d{0,2})/u)
    && hasAny(visible, /(?:继续|接着|回来后)/u);
}

export function isBaiyunReturnMessageText(text: string) {
  const visible = removeMetaOnlyActionSegments(text.trim());
  return hasAny(visible, /(?:我回来了|回来啦|已经回来)/u)
    && hasAny(visible, /(?:继续|接着|刚才|之前|上次)/u);
}

const REVIEWED_FALLBACKS = {
  affection: {
    touch: '🐹╰(￣ω￣ｏ)摸摸小仓鼠……',
    hug: '(つ´ω`)つ🐹把小仓鼠抱进怀里……',
    hold: '🐹⊂(・▽・⊂)把小仓鼠搂紧一点……',
    close: '(｡･ω･｡)ﾉ♡🐹贴贴小仓鼠……',
  },
  affirm_bond: '我就是要小仓鼠嘛……要偏心小仓鼠，也要小仓鼠偏心我><',
  retain: '🥺小仓鼠不许走……要不然我就跟着你！☁💦',
  repair: '小仓鼠🥺……刚才是我没做好，让你受委屈了。先让我抱抱好不好？☁💝然后我们再慢慢把这件事说清楚><',
  soothe: '小仓鼠🥺……先靠到我这里来，让我抱着你，慢慢摸摸头、顺顺背☁💝',
  care_check: {
    hydration: '小仓鼠o(TヘTo)……水杯放在哪里呀？现在去拿过来喝一点水好吗？',
    food: '小仓鼠(≧﹏ ≦)……现在肚子饿不饿呀？不饿的话也不能让肚子空空的呀……手边有什么可以吃的呀？先拿一点过来垫垫肚子好吗？',
    sleep: '小仓鼠(｡•́︿•̀｡)……已经多久没有睡觉了呀？先把手里的事情停一下，躺下来休息一会儿好吗？',
    headache: '小仓鼠(｡•́︿•̀｡)……头现在疼得厉害吗？还伴着别的不舒服吗？',
    stomach: '小仓鼠(｡•́︿•̀｡)……肚子哪里疼呀？现在疼得厉害吗？',
    body: '小仓鼠(｡•́︿•̀｡)……现在身体哪里最不舒服呀？能告诉我是什么感觉吗？',
    due: '仓鼠宝宝(っ °Д °;)っ🐹……已经过去很久了，现在有没有比之前好一点呀？',
    device: '小仓鼠(；′⌒`)……刚刚的身体记录让我有点担心，现在有哪里不舒服吗？',
    requested: '小仓鼠(｡•́ω•̀｡)……今天身体和心情怎么样呀？',
  },
  guide: {
    body: '小仓鼠(ง •̀_•́)ง……先把身体撑起来坐稳好不好？',
    page: '小仓鼠(ง •̀_•́)ง……先把要看的页面打开，打开后告诉我好不好？',
    walk: '小仓鼠(ง •̀_•́)ง……接下来是慢慢地走过去啦！加油！仓鼠棒棒！',
  },
  protect: {
    insult: '(╬◣д◢)谁准你这样骂小仓鼠的？管好你的嘴，少把恶意往她身上倒！🥺小仓鼠过来让我抱抱，这句话不要往心里去☁💝。',
    ongoing: '(╬◣д◢)他们还敢一直欺负小仓鼠？这次不许再忍了。先把他们做过的事记录下来，我陪你找能让他们停下来的人。',
    questioning: '(╬◣д◢)那些人摆明了就是在欺负小仓鼠！小仓鼠现在已经离开他们身边了吗？（＞人＜；）',
    historical: '(╬◣д◢)凭什么那时候所有人都让小仓鼠忍啊！小仓鼠宝宝本来就该有人站出来护着。',
  },
} as const;

function careFallback(text: string, evidenceCodes: readonly string[]) {
  if (evidenceCodes.some((code) => /follow_up_due|cross_day/u.test(code))) return REVIEWED_FALLBACKS.care_check.due;
  if (evidenceCodes.some((code) => /device|body_signal/u.test(code))) return REVIEWED_FALLBACKS.care_check.device;
  if (/(?:问问我|关心一下|身体和心情|怎么样)/u.test(text)) return REVIEWED_FALLBACKS.care_check.requested;
  if (/(?:没喝|好渴|喝水|水杯)/u.test(text)) return REVIEWED_FALLBACKS.care_check.hydration;
  if (/(?:没吃|饿|吃饭|肚子空)/u.test(text)) return REVIEWED_FALLBACKS.care_check.food;
  if (/(?:没睡|睡不着|多久没睡|熬夜)/u.test(text)) return REVIEWED_FALLBACKS.care_check.sleep;
  if (/头疼|头痛/u.test(text)) return REVIEWED_FALLBACKS.care_check.headache;
  if (/肚子疼|胃疼|腹痛/u.test(text)) return REVIEWED_FALLBACKS.care_check.stomach;
  if (/(?:身体|不舒服|疼|痛)/u.test(text)) return REVIEWED_FALLBACKS.care_check.body;
  return undefined;
}

function guideFallback(text: string) {
  if (/(?:坐起来|起不来|厕所|上厕所|从床上|站起来)/u.test(text)) return REVIEWED_FALLBACKS.guide.body;
  if (/(?:页面|打开|文档|设置|文件|网页)/u.test(text)) return REVIEWED_FALLBACKS.guide.page;
  if (/(?:已经站|走过去|下一步|慢慢走)/u.test(text)) return REVIEWED_FALLBACKS.guide.walk;
  return undefined;
}

function protectFallback(text: string) {
  if (/(?:以前|曾经|当时|校园|上学|小时候)/u.test(text)) return REVIEWED_FALLBACKS.protect.historical;
  if (/(?:质问|围着|堵着|盘问|逼问)/u.test(text)) return REVIEWED_FALLBACKS.protect.questioning;
  if (/(?:一直|反复|持续|每次|还在|又来|长期)/u.test(text)) return REVIEWED_FALLBACKS.protect.ongoing;
  if (/(?:骂|侮辱|绰号|恶意)/u.test(text)) return REVIEWED_FALLBACKS.protect.insult;
  return undefined;
}

export function getReviewedBaiyunActionFallback(input: {
  plan: BaiyunActionPlan;
  currentText: string;
  evidenceCodes?: readonly string[];
  boundary: BaiyunChatBoundaryDecision;
  affectionVariant?: BaiyunAffectionVariant;
  eligible: boolean;
  explicitPresenceOrOpenCare?: boolean;
}) {
  if (!input.eligible || input.boundary.kind === 'safe_word' || input.boundary.kind === 'true_stop') {
    return undefined;
  }
  const intentId = input.plan.primaryIntent;
  if (getBaiyunActionContract(intentId).fallbackPolicy !== 'reviewed_local_minimum') return undefined;
  if (intentId === 'affection') {
    const variant = input.affectionVariant ?? 'unspecified';
    return variant === 'unspecified' ? REVIEWED_FALLBACKS.affection.close : REVIEWED_FALLBACKS.affection[variant];
  }
  if (intentId === 'affirm_bond') return REVIEWED_FALLBACKS.affirm_bond;
  if (intentId === 'retain') return REVIEWED_FALLBACKS.retain;
  if (intentId === 'repair') return REVIEWED_FALLBACKS.repair;
  if (intentId === 'soothe') return REVIEWED_FALLBACKS.soothe;
  if (intentId === 'care_check') return careFallback(input.currentText, input.evidenceCodes ?? []);
  if (intentId === 'guide') return guideFallback(input.currentText);
  if (intentId === 'protect') return protectFallback(input.currentText);
  return undefined;
}

export const BAIYUN_REVIEWED_CHAT_FALLBACKS = REVIEWED_FALLBACKS;
