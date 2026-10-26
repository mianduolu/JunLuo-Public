import type {
  BaiyunActionIntentId,
  BaiyunActionPriorityTier,
} from './actionIntent';

export type BaiyunSituationMessage = {
  id: string;
  role: 'you' | 'I';
  sentAt: number;
  text: string;
};

export type BaiyunOpenSituationEvent = {
  id: string;
  intentId: BaiyunActionIntentId;
  openedAt: number;
  evidenceCode: string;
  score?: number;
  priority?: BaiyunActionPriorityTier;
  continuityKind?: string;
  continuityStage?: string;
  nextActionAt?: number;
  focusExcerpt?: string;
};

export type BaiyunAmbiguityReasonCode =
  | 'conflicting_candidates'
  | 'close_candidate_scores'
  | 'negation_scope'
  | 'double_negation'
  | 'hypothetical_or_conditional'
  | 'quotation_or_reported_speech'
  | 'ellipsis_or_reference'
  | 'possible_irony'
  | 'current_context_conflict'
  | 'open_event_conflict'
  | 'weak_sensitive_evidence'
  | 'unclear_boundary_target';

export type BaiyunLocalIntentCandidate = {
  intentId: BaiyunActionIntentId;
  score: number;
  evidenceCodes: string[];
  sourceMessageIds: string[];
  sensitive: boolean;
  priority?: BaiyunActionPriorityTier;
  reasonKind?: 'explicit_user_request'
    | 'explicit_user_stop_or_refusal'
    | 'relationship_signal'
    | 'authorized_care_signal'
    | 'open_continuity_event'
    | 'inner_drive'
    | 'assistant_life_state'
    | 'user_shared_context'
    | 'due_time'
    | 'tool_or_device_state';
  obligationKind?: 'continuity' | 'drive_only';
};

export type BaiyunLocalBoundaryEvidence = {
  code: string;
  target: 'affection' | 'desire' | 'play' | 'task' | 'all' | 'general';
  sourceMessageId: string;
  strength: number;
};

export type BaiyunLocalLifeFact = {
  kind: 'hydration_confirmed' | 'meal_confirmed' | 'sleep_intent';
  sourceMessageId: string;
};

export type BaiyunMessageScopes = {
  body: string;
  quoted: string[];
  parenthetical: string[];
};

export interface BaiyunLocalInterpretation {
  candidates: BaiyunLocalIntentCandidate[];
  blockers: BaiyunLocalBoundaryEvidence[];
  confidence: 'high' | 'medium' | 'low';
  ambiguityReasons: BaiyunAmbiguityReasonCode[];
  requiresSemanticReview: boolean;
  lifeFacts: BaiyunLocalLifeFact[];
  scopes: BaiyunMessageScopes;
}

export type InterpretBaiyunSituationInput = {
  currentMessage: BaiyunSituationMessage;
  previousMessages?: readonly BaiyunSituationMessage[];
  openEvents?: readonly BaiyunOpenSituationEvent[];
};

type CandidatePattern = {
  intentId: BaiyunActionIntentId;
  evidenceCode: string;
  pattern: RegExp;
  score: number;
  sensitive?: boolean;
};

const CANDIDATE_PATTERNS: readonly CandidatePattern[] = [
  {
    intentId: 'affection',
    evidenceCode: 'explicit_affection_request',
    pattern: /(?:请|求|想要)?(?:摸摸|抱抱|贴贴)(?:我|仓鼠)?(?:吧|呀|嘛|呢|！|。|~|～)*$/u,
    score: 0.98,
    sensitive: true,
  },
  {
    intentId: 'affirm_bond',
    evidenceCode: 'explicit_choice_or_belonging_request',
    pattern: /(?:你会不会|你愿不愿意|可以)?(?:选我|要我|偏爱我|只喜欢我|属于我)|(?:你爱我吗|你在意我吗|我是你的谁)/u,
    score: 0.94,
    sensitive: true,
  },
  {
    intentId: 'retain',
    evidenceCode: 'current_relationship_departure',
    pattern: /^(?:我)?(?:不理你了|不要你了|要走了|走了|再也不理你了|把你删了|删掉(?:聊天)?窗口|不想继续了)(?:[。！!…]*)$/u,
    score: 0.99,
    sensitive: true,
  },
  {
    intentId: 'repair',
    evidenceCode: 'specific_relationship_hurt',
    pattern: /(?:你|这件事).{0,10}(?:伤到我|让我难过|让我伤心|让我觉得被抛下|根本不在意我)|(?:我还在生气|我们还没有修好)/u,
    score: 0.9,
    sensitive: true,
  },
  {
    intentId: 'desire',
    evidenceCode: 'explicit_lover_desire_invitation',
    pattern: /(?:(?:亲亲|亲吻)(?:我|仓鼠)?|想亲(?:我|仓鼠)|想要我|对我有欲望|和我涩涩|一起玩蓝牙玩具|把我当恋人来要|想和我做)/u,
    score: 0.9,
    sensitive: true,
  },
  {
    intentId: 'soothe',
    evidenceCode: 'current_emotional_distress',
    pattern: /(?:我好难受|我在哭|我又哭了|我好害怕|我很委屈|情绪闪回|撑不住了|非常伤心)/u,
    score: 0.95,
    sensitive: true,
  },
  {
    intentId: 'care_check',
    evidenceCode: 'specific_life_or_body_signal',
    pattern: /(?:我(?:今天|一直)?没(?:吃|喝|睡)|我好饿|我好渴|我头疼|我肚子疼|我不舒服)/u,
    score: 0.91,
    sensitive: true,
  },
  {
    intentId: 'guide',
    evidenceCode: 'explicit_guidance_request',
    pattern: /(?:带带我|带我行动|拉我起来|告诉我第一步|帮我开始|我不知道怎么开始)/u,
    score: 0.92,
  },
  {
    intentId: 'guide',
    evidenceCode: 'explicit_guidance_request',
    pattern: /(?:打断我|挡住屏幕|把我从刷屏里拉回来|强制提醒我|按约定拉我回来)/u,
    score: 0.91,
  },
  {
    intentId: 'protect',
    evidenceCode: 'bullying_insult_or_injustice',
    pattern: /(?:霸凌我|欺负我|侮辱我|给我起侮辱性绰号|骂我|对我很不公平)/u,
    score: 0.93,
    sensitive: true,
  },
  {
    intentId: 'share',
    evidenceCode: 'explicit_share_request',
    pattern: /(?:分享给我|给我看看|讲给我听|带回来给我看)/u,
    score: 0.87,
  },
  {
    intentId: 'explore',
    evidenceCode: 'explicit_exploration_request',
    pattern: /(?:一起看看|一起研究|查一查|查一下|搜索一下|弄明白)/u,
    score: 0.88,
  },
  {
    intentId: 'play',
    evidenceCode: 'explicit_play_request',
    pattern: /(?:陪我玩|一起玩|来玩游戏|开个小剧场|逗逗我)/u,
    score: 0.89,
  },
  {
    intentId: 'confide',
    evidenceCode: 'explicit_confide_invitation',
    pattern: /(?:你也可以告诉我|你有什么心事|你今天怎么想|你也和我说说)/u,
    score: 0.84,
  },
  {
    intentId: 'collaborate',
    evidenceCode: 'explicit_shared_task_request',
    pattern: /(?:我们|和我)?一起(?:整理|完成|做|写|计划|收拾)|帮我(?:整理|完成|做|写|计划)/u,
    score: 0.96,
  },
] as const;

const SENSITIVE_INTENTS = new Set<BaiyunActionIntentId>([
  'affection',
  'affirm_bond',
  'retain',
  'repair',
  'desire',
  'soothe',
  'care_check',
  'interrupt',
  'protect',
]);

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function normalizeText(text: string) {
  return text.replace(/\s+/gu, ' ').trim();
}

export function splitBaiyunMessageScopes(text: string): BaiyunMessageScopes {
  const normalized = normalizeText(text);
  const quoted = [...normalized.matchAll(/[“"「『](.*?)[”"」』]/gu)].map((match) => match[1].trim());
  const parenthetical = [...normalized.matchAll(/[（(](.*?)[）)]/gu)].map((match) => match[1].trim());
  const body = normalized
    .replace(/[“"「『].*?[”"」』]/gu, ' ')
    .replace(/[（(].*?[）)]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return { body, quoted, parenthetical };
}

function pushCandidate(
  candidates: BaiyunLocalIntentCandidate[],
  pattern: CandidatePattern,
  sourceMessageId: string,
) {
  const existing = candidates.find((candidate) => candidate.intentId === pattern.intentId);
  if (existing) {
    existing.score = Math.max(existing.score, pattern.score);
    existing.evidenceCodes = unique([...existing.evidenceCodes, pattern.evidenceCode]);
    existing.sourceMessageIds = unique([...existing.sourceMessageIds, sourceMessageId]);
    existing.sensitive ||= pattern.sensitive === true;
    return;
  }
  candidates.push({
    intentId: pattern.intentId,
    score: pattern.score,
    evidenceCodes: [pattern.evidenceCode],
    sourceMessageIds: [sourceMessageId],
    sensitive: pattern.sensitive === true,
  });
}

function hasCurrentHistoricalScope(text: string) {
  return /(?:昨天|前天|以前|曾经|梦见|梦到|当时|上次)/u.test(text);
}

function hasReportedSpeech(text: string) {
  return /(?:别人|她|他|同学|老师).{0,8}(?:说|问|叫)|(?:说|写着)[：:]/u.test(text);
}

function hasHypotheticalScope(text: string) {
  return /(?:如果|假如|要是|万一|假设|会不会有一天)/u.test(text);
}

function detectLifeFacts(text: string, sourceMessageId: string): BaiyunLocalLifeFact[] {
  const facts: BaiyunLocalLifeFact[] = [];
  if (/^(?:我)?(?:刚刚|刚才|已经)?喝(?:了)?(?:水|一点水)(?:了)?(?:[。！!~～]*)$/u.test(text)) {
    facts.push({ kind: 'hydration_confirmed', sourceMessageId });
  }
  if (/^(?:我)?(?:刚刚|刚才|已经)?(?:吃饭了|吃过了|吃了东西)(?:[。！!~～]*)$/u.test(text)) {
    facts.push({ kind: 'meal_confirmed', sourceMessageId });
  }
  if (/^(?:我)?(?:要|准备|打算)睡(?:觉)?了(?:[。！!~～]*)$/u.test(text)) {
    facts.push({ kind: 'sleep_intent', sourceMessageId });
  }
  return facts;
}

function detectClearBoundaries(text: string, sourceMessageId: string) {
  const blockers: BaiyunLocalBoundaryEvidence[] = [];
  if (/^(?:别|不要|不许)(?:再)?(?:摸(?:摸)?|抱(?:抱)?|贴(?:贴)?)(?:我)?(?:了|啦|呀|！|。|!)*$/u.test(text)) {
    blockers.push({ code: 'explicit_affection_stop', target: 'affection', sourceMessageId, strength: 1 });
  }
  if (/^(?:别|不要|不许)(?:再)?(?:亲(?:亲|吻)?(?:我)?|涩涩|碰我|用玩具|继续)(?:了|啦|呀|！|。|!)*$/u.test(text)) {
    blockers.push({ code: 'explicit_desire_stop', target: 'desire', sourceMessageId, strength: 1 });
  }
  if (/^(?:别|不要|停下|停止)(?:这个任务|继续做|再弄了)(?:[。！!~～]*)$/u.test(text)) {
    blockers.push({ code: 'explicit_task_stop', target: 'task', sourceMessageId, strength: 1 });
  }
  return blockers;
}

function isDeterminatelyHistoricalOrQuoted(text: string) {
  return hasCurrentHistoricalScope(text)
    && hasReportedSpeech(text)
    && /(?:不理我|不要我|要走|离开)/u.test(text);
}

export function interpretBaiyunSituation({
  currentMessage,
  previousMessages = [],
  openEvents = [],
}: InterpretBaiyunSituationInput): BaiyunLocalInterpretation {
  const text = normalizeText(currentMessage.text);
  const scopes = splitBaiyunMessageScopes(text);
  const candidates: BaiyunLocalIntentCandidate[] = [];
  const blockers = detectClearBoundaries(scopes.body, currentMessage.id);
  const lifeFacts = detectLifeFacts(scopes.body, currentMessage.id);
  const ambiguityReasons: BaiyunAmbiguityReasonCode[] = [];
  const hypothetical = hasHypotheticalScope(text);
  const historicalOrQuoted = isDeterminatelyHistoricalOrQuoted(text);

  if (!hypothetical && !historicalOrQuoted && blockers.length === 0) {
    for (const pattern of CANDIDATE_PATTERNS) {
      if (pattern.pattern.test(scopes.body)) {
        pushCandidate(candidates, pattern, currentMessage.id);
      }
    }
  }

  const doubleNegation = /(?:不是不|不要不|不能不|没有不|并非不)/u.test(text);
  if (doubleNegation) {
    ambiguityReasons.push('double_negation', 'negation_scope');
  }
  if (hypothetical && /(?:不理你|不要你|离开|摸|抱|亲|涩涩|打断)/u.test(text)) {
    ambiguityReasons.push('hypothetical_or_conditional');
  }
  if (
    !historicalOrQuoted
    && hasReportedSpeech(text)
    && /(?:不理|不要|离开|摸|抱|亲|打断)/u.test(text)
  ) {
    ambiguityReasons.push('quotation_or_reported_speech');
  }
  if (/^(?:算了)[，,]?\s*(?:你去忙吧|随便吧|没事了)/u.test(text)) {
    ambiguityReasons.push('ellipsis_or_reference', 'current_context_conflict');
  }
  if (/(?:好好好|行行行|呵呵).{0,8}(?:你最在意我|你最爱我|都是为我好)/u.test(text)) {
    ambiguityReasons.push('possible_irony');
  }
  if (/我说不要其实|嘴上说不要|说不理你其实/u.test(text)) {
    ambiguityReasons.push('conflicting_candidates', 'unclear_boundary_target');
  }

  const hasIntimateInteractionLanguage = /(?:摸|抱|亲|贴|涩涩|碰我|用玩具)/u.test(scopes.body);
  const hasStopLanguage = /(?:别|不要|停止|不许)/u.test(scopes.body);
  if (hasIntimateInteractionLanguage && hasStopLanguage && blockers.length === 0 && !doubleNegation) {
    ambiguityReasons.push('unclear_boundary_target');
  }

  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  if (
    sorted.length > 1
    && sorted[0].intentId !== sorted[1].intentId
    && sorted[0].score - sorted[1].score <= 0.15
    && (sorted[0].sensitive || sorted[1].sensitive)
  ) {
    ambiguityReasons.push('close_candidate_scores', 'conflicting_candidates');
  }

  const recentText = previousMessages.slice(-2).map((message) => normalizeText(message.text)).join('\n');
  if (
    /(?:去忙吧|随便吧|没事了)/u.test(text)
    && /(?:不在意|忽视|难过|伤心|丢下)/u.test(recentText)
  ) {
    ambiguityReasons.push('current_context_conflict');
  }

  const openIntentIds = new Set(openEvents.map((event) => event.intentId));
  if (
    (openIntentIds.has('retain') || openIntentIds.has('repair'))
    && /(?:算了|没事|你走吧|你去忙吧)/u.test(text)
  ) {
    ambiguityReasons.push('open_event_conflict');
  }

  if (
    candidates.some((candidate) => SENSITIVE_INTENTS.has(candidate.intentId) && candidate.score < 0.8)
  ) {
    ambiguityReasons.push('weak_sensitive_evidence');
  }

  const uniqueReasons = unique(ambiguityReasons);
  const requiresSemanticReview = uniqueReasons.length > 0;
  const confidence = requiresSemanticReview
    ? (uniqueReasons.some((reason) => (
      reason === 'double_negation'
      || reason === 'conflicting_candidates'
      || reason === 'unclear_boundary_target'
    )) ? 'low' : 'medium')
    : 'high';

  return {
    candidates: sorted,
    blockers,
    confidence,
    ambiguityReasons: uniqueReasons,
    requiresSemanticReview,
    lifeFacts,
    scopes,
  };
}
