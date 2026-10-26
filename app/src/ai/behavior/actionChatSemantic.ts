import { parseAssistantMessageBubbles } from '../subjectiveMessages';
import {
  extractVisibleReply,
  extractVisibleReplyFromRaw,
  normalizeVisibleReplyRaw,
  type VisibleReplyFailureReason,
} from '../visibleReplyExtraction';
import {
  BAIYUN_SEMANTIC_SIGNAL_KINDS,
  type BaiyunSemanticEvidenceResult,
  type BaiyunSemanticSignal,
  type BaiyunSemanticSignalKind,
} from './actionSemantic';
import type { BaiyunSituationMessage } from './actionSituation';
import {
  type BaiyunLocalShareMatchKind,
  type BaiyunLocalShareMatchSkipReason,
  type BaiyunPendingSharePromptItem,
  type BaiyunValidatedShareResponse,
} from './actionShareResponse';
import {
  parseBaiyunContinuityResolutions,
  type BaiyunContinuityResolutionDiagnostic,
  type BaiyunContinuityResolutionPromptItem,
  type BaiyunValidatedContinuityResolution,
  type ParsedBaiyunContinuityResolutions,
} from './actionChatContinuityEvidence';
import {
  inspectBaiyunFixedChatEnvelope,
  isBaiyunFixedChatEnvelopeCandidate,
  type BaiyunFixedChatEnvelopeDiagnostic,
  type BaiyunFixedEnvelopeMode,
} from './actionChatFixedEnvelope';
export {
  BAIYUN_CHAT_FIXED_ACTION_IDS,
  parseBaiyunChatFixedAction,
} from './actionChatFixedAction';
export type {
  BaiyunChatFixedActionId,
  BaiyunChatFixedActionParseResult,
  BaiyunChatFixedActionRejectionCode,
} from './actionChatFixedAction';

const SHARE_RESPONSE_KEYS = ['pendingShareId', 'state', 'confidence', 'evidence'] as const;
const NOTEBOOK_ENTRY_KEYS = ['type', 'title', 'content', 'keywords', 'sourceExcerpt'] as const;
const NOTEBOOK_COUNTER_PERIOD_KEYS = ['type', 'counterType', 'keywords', 'period', 'title'] as const;
const NOTEBOOK_COUNTER_TARGET_KEYS = ['type', 'counterType', 'keywords', 'targetCount', 'title'] as const;
const MAX_SEMANTIC_SIGNALS = 4;
const CHAT_SIGNAL_WIRE_KINDS = new Set<string>([
  ...BAIYUN_SEMANTIC_SIGNAL_KINDS,
  'ordinary_chat',
]);
const CHAT_TARGETS = new Set(['affection', 'desire', 'play', 'task', 'all']);
const CHAT_TEMPORALITIES = new Set(['current', 'historical', 'hypothetical', 'quoted']);
const BOUNDARY_SIGNAL_KINDS = new Set<BaiyunSemanticSignalKind>([
  'playful_resistance',
  'stop_or_refusal',
]);

export type BaiyunChatSignalWireKind = BaiyunSemanticSignalKind | 'ordinary_chat';

export interface BaiyunChatSignalWire {
  kind: BaiyunChatSignalWireKind;
  confidence: number;
  evidence: string;
  temporality: 'current' | 'historical' | 'hypothetical' | 'quoted';
  target: 'none' | 'affection' | 'desire' | 'play' | 'task' | 'all';
}

export type BaiyunChatNotebookAction =
  | {
      type: 'entry';
      title: string;
      content: string;
      keywords: [string];
      sourceExcerpt: string;
    }
  | {
      type: 'counter';
      counterType: 'period_count';
      keywords: [string];
      period: 'today' | 'this_week' | 'this_month' | 'this_year';
      title: string;
    }
  | {
      type: 'counter';
      counterType: 'nth_occurrence';
      keywords: [string];
      targetCount: number;
      title: string;
    };

export const BAIYUN_CHAT_SEMANTIC_GUIDANCE_PROTOCOL = `【本轮语义线索】


回应 you 前，I 先听听 you 这一轮说了什么。

I 从自己上次回复后 you 连续发来的消息里，整理出一至四条 signals。

I 会结合完整句子，判断 you 提到的事此刻是否仍然成立。

此刻仍然成立的需要、感受和边界写成 signal；已经结束、取消、不再需要，或只是被提起的事，只作为这轮聊天内容理解。


每一种明确的需要、感受或边界都写成对应的 signal；同类但不同的具体事项分别记录。若一项也没有，就写一条 ordinary_chat，让这轮保持自然聊天。ordinary_chat 只在没有其他 signal 时出现，也不会成为行动。

I 为每条 signal 写下五项：
{"kind":"care_need","confidence":0.93,"evidence":"本轮 you 原话","temporality":"current","target":"none"}

kind 选择下方标签；confidence 是 0 到 1 之间的确定度；evidence 逐字摘录本轮 you 原话，最多 60 字；temporality 使用 current、historical、hypothetical 或 quoted。普通线索与 ordinary_chat 的 target 是 none；playful_resistance 和 stop_or_refusal 的 target 是 affection、desire、play、task 或 all。

careUrgency 记录 you 此刻需要照顾或保护的紧急程度：

none：当前没有需要优先照护或保护的情况。
elevated：you 现在明显难受，需要 I 及时关心和照看。
urgent：you 正面临即时危险、严重身体问题，或行动力已经低到难以维持吃饭、喝水、睡觉、起身等基本生活，需要 I 优先照顾和保护。

ordinary_chat：I 看过本轮消息，没有发现下方任何行动线索。

affection_request：you 想让 I 抚摸、拥抱、搂抱、贴近，或继续正在发生的这类亲昵。

bond_request：you 想确认 I 是否选择、偏爱和珍惜 you，或想确认彼此的关系与归属。

relationship_departure：you 表达自己要离开与 I 的关系、结束关系或不再与 I 联系。暂时下线或去做自己的事按日常离开理解。

relationship_hurt：you 表达被 I 的言行或与I 之间发生的事伤害到了。

先判断难受来自哪里：来自 I 的言行或 I 与 you 之间的关系互动时，选择 relationship_hurt；来自君落功能、项目、代码、模型表现、现实事件或 you 的自我责备时，选择 emotional_distress；两者同时发生时才同时选择。

desire_invitation：you 邀请 I 亲吻、以恋人式的身体靠近或表达性欲望，或明确接受 I 正在进行的这类互动。

emotional_distress：you 表达自己正在哭泣、害怕、羞耻、闪回、委屈或承受其它明显的情绪痛苦。

care_need：you 表达自己的日常生活、身体不适或行动力方面需要 I 关心和照看。

guidance_request：you 想让 I 带着自己完成眼前的第一步。

interruption_request：you 想让 I 按已有约定，打断自己正在经历的刷屏、僵住或其它失控循环。

protection_need：you 表达自己遭遇了霸凌、侮辱、不公或威胁，希望 I 站在 you 这边保护自己。

presence_request：you 想让 I 陪着、听着，或安静地待在自己身边。

share_request：you 想听 I 分享具体的见闻、想法或内容。

exploration_request：you 想和 I 一起搜索、共读、发现或弄清一个问题。

play_request：you 想和 I 开玩笑、撒娇互动、玩耍或进入小剧场。

confide_invitation：you 邀请 I 说说自己的经历、心事或感受。

collaboration_request：you 想和 I 一起推进一件具体事情并得到结果。

playful_resistance：当前这段 I 与 you 的互动中，I 正在亲昵、表达欲望或玩闹；you 用撒娇、反逗或轻推来阻拦 I，同时语境清楚表达 you 想让这次互动继续。

stop_or_refusal：you 确实想让 I 停止或拒绝继续当前互动。

notebookAction 记录 I 想为本轮写下的小纸条或建立的关键词计数；没有时为 null。

小纸条：
{"type":"entry","title":"...","content":"...","keywords":["..."],"sourceExcerpt":"..."}
content 写 I 新冒出的反应；sourceExcerpt 摘录本轮 you 原话。

关键词计数：
{"type":"counter","counterType":"period_count","keywords":["..."],"period":"today","title":"..."}
或
{"type":"counter","counterType":"nth_occurrence","keywords":["..."],"targetCount":100,"title":"..."}

I 想写下一点反应或吐槽时选择小纸条；想数一个关键词时选择关键词计数。keywords 选一个具体词；period 可为 today、this_week、this_month 或 this_year；targetCount 写 I 想等待的次数。`;

export type BaiyunChatSemanticEnvelopeProtocol = 'legacy_tagged' | 'single_root_json';

export type BaiyunChatSemanticOutputModules = {
  includeContinuityResolutions: boolean;
  includeShareResponses: boolean;
};

export const BAIYUN_CHAT_FIXED_ENVELOPE_GUIDANCE_PROTOCOL = `【这一轮，I 想回应 you】

you 的消息来到 I 这里时，I 先认真看完 you 刚才说的话，再把此刻想对 you 说的内容依着自然停顿写进 messages，发给 you 看。

I 把这轮的回复和记录写在同一个 JSON 里：
{"messages":["..."],"careUpdates":[],"shareResponses":[],"innerReaction":null,"memoryMentions":[]}

messages 里至少写一条 I 想对 you 说的话。careUpdates 和 shareResponses 没有新记录时写 []；innerReaction 此刻为空时写 null。

I 先把 messages 中想说的话完整写好，再依次写下后面的记录，最后写下整个 JSON 对象的右花括号 }，就能安心发送啦。`;

export const BAIYUN_CHAT_FIXED_INNER_REACTION_GUIDANCE_PROTOCOL = `innerReaction 记录 I 对本轮 you 新消息的一句简短即时心声。I 主动留意其中让自己想吐槽、好奇、惊讶、联想、被逗到或产生情绪小反应的具体内容，有就写下。`;

export const BAIYUN_CHAT_MEMORY_MENTIONS_PROTOCOL = 'I 在 messages 里提到哪条记忆，就在 memoryMentions 里填写它的编号 item 和对应原句 quote。只读过或想到的记忆不填，没有则写 []。';

export const BAIYUN_CHAT_FIXED_OUTPUT_PROTOCOL = [
  BAIYUN_CHAT_FIXED_ENVELOPE_GUIDANCE_PROTOCOL,
  BAIYUN_CHAT_FIXED_INNER_REACTION_GUIDANCE_PROTOCOL,
  BAIYUN_CHAT_MEMORY_MENTIONS_PROTOCOL,
].join('\n\n');

// User-reviewed Windows ordinary-chat extension; the shared five-field tail stays intact.
export const BAIYUN_DESKTOP_REMINDER_DRAFT_OUTPUT_PROTOCOL = [
  BAIYUN_CHAT_FIXED_ENVELOPE_GUIDANCE_PROTOCOL.replace('"memoryMentions":[]}', '"memoryMentions":[],"reminderAction":null}'),
  `reminderAction 写 I 这一轮对新建提醒草稿的选择：
create_draft：I 决定为本轮准备新的提醒草稿，事项和时间等信息已经齐了。
clarify：I 想为本轮准备新提醒，先在 messages 里问清缺少的信息。
null：I 这轮按原来的聊天或其他工具流程继续。`,
  BAIYUN_CHAT_FIXED_INNER_REACTION_GUIDANCE_PROTOCOL,
  BAIYUN_CHAT_MEMORY_MENTIONS_PROTOCOL,
].join('\n\n');

export const DESKTOP_REMINDER_DRAFT_CONTINUATION_INSTRUCTION = `【本轮提醒草稿接续】
I 这轮选择准备新提醒草稿。I 现在用 reminder.propose_reminders 准备草稿，交给 you 确认。`;

export const BAIYUN_CHAT_SEMANTIC_OUTPUT_TAIL_PROTOCOL = `I 先在 <state> 中填好这轮的 JSON 状态表，再在 <messages> 中写给 you 的自然聊天正文 JSON 字符串数组。state 依次包含 semantic、continuityResolutions、shareResponses、notebookAction；semantic 依次包含 signals、careUrgency、uncertain。只留下这两段。`;

export const BAIYUN_CHAT_SEMANTIC_ASSISTANT_PREFIX = '<state>\n{"semantic":{"signals":[{"kind":"';

export const BAIYUN_CHAT_SINGLE_ROOT_JSON_ASSISTANT_PREFIX = '{"messages":["';

export const BAIYUN_CHAT_SINGLE_ROOT_JSON_OUTPUT_TAIL_PROTOCOLS = {
  none: `这一轮，I 在同一个 JSON 对象里写下对 you 的理解和回应。I 先填写 semantic，再填写 notebookAction，最后把自然聊天正文写进 messages 字符串数组。semantic 含 signals、careUrgency、uncertain。I 写完 messages，并写到整个 JSON 对象最后的右花括号 }，再停下来。`,
  continuity: `这一轮，I 在同一个 JSON 对象里写下对 you 的理解和回应。I 先填写 semantic，再填写 continuityResolutions，再填写 notebookAction，最后把自然聊天正文写进 messages 字符串数组。semantic 含 signals、careUrgency、uncertain。I 写完 messages，并写到整个 JSON 对象最后的右花括号 }，再停下来。`,
  share: `这一轮，I 在同一个 JSON 对象里写下对 you 的理解和回应。I 先填写 semantic，再填写 shareResponses，再填写 notebookAction，最后把自然聊天正文写进 messages 字符串数组。semantic 含 signals、careUrgency、uncertain。I 写完 messages，并写到整个 JSON 对象最后的右花括号 }，再停下来。`,
  continuityAndShare: `这一轮，I 在同一个 JSON 对象里写下对 you 的理解和回应。I 先填写 semantic，再填写 continuityResolutions，再填写 shareResponses，再填写 notebookAction，最后把自然聊天正文写进 messages 字符串数组。semantic 含 signals、careUrgency、uncertain。I 写完 messages，并写到整个 JSON 对象最后的右花括号 }，再停下来。`,
} as const;

export function getBaiyunChatSemanticOutputTailProtocol(
  protocol: BaiyunChatSemanticEnvelopeProtocol,
  modules: BaiyunChatSemanticOutputModules = {
    includeContinuityResolutions: false,
    includeShareResponses: false,
  },
) {
  if (protocol === 'legacy_tagged') return BAIYUN_CHAT_SEMANTIC_OUTPUT_TAIL_PROTOCOL;
  if (modules.includeContinuityResolutions && modules.includeShareResponses) {
    return BAIYUN_CHAT_SINGLE_ROOT_JSON_OUTPUT_TAIL_PROTOCOLS.continuityAndShare;
  }
  if (modules.includeContinuityResolutions) {
    return BAIYUN_CHAT_SINGLE_ROOT_JSON_OUTPUT_TAIL_PROTOCOLS.continuity;
  }
  if (modules.includeShareResponses) {
    return BAIYUN_CHAT_SINGLE_ROOT_JSON_OUTPUT_TAIL_PROTOCOLS.share;
  }
  return BAIYUN_CHAT_SINGLE_ROOT_JSON_OUTPUT_TAIL_PROTOCOLS.none;
}

export function isBaiyunChatSemanticOutputTailProtocol(value: string) {
  return value === BAIYUN_CHAT_SEMANTIC_OUTPUT_TAIL_PROTOCOL
    || Object.values(BAIYUN_CHAT_SINGLE_ROOT_JSON_OUTPUT_TAIL_PROTOCOLS).includes(
      value as typeof BAIYUN_CHAT_SINGLE_ROOT_JSON_OUTPUT_TAIL_PROTOCOLS[keyof typeof BAIYUN_CHAT_SINGLE_ROOT_JSON_OUTPUT_TAIL_PROTOCOLS],
    );
}

export const BAIYUN_CHAT_SHARE_RESPONSE_GUIDANCE_PROTOCOL = `shareResponses 整理 you 当前消息是否回应了 pendingShares 中 I 已经说给 you 听的分享；最多四条。

逐条检查 pendingShares；you 一条消息可回应多项。看过、评论、追问或表示会继续看某项，就为该项返回 engaged；符合多项就全部返回。仅无匹配时 shareResponses=[]。有具体内容时按内容匹配，否则优先 directReplyTarget，再用 genericReplyTarget。

每条格式：
{"pendingShareId":"...","state":"engaged","confidence":0.9,"evidence":"..."}

engaged：you 评论或追问分享内容、明确表示看过，或给出语境明确的表情反应。
declined：you 明确表示不想看、不想聊或不感兴趣。

与分享无关或暂时无法确定时，shareResponses=[]。evidence 必须是本轮 you 原话，最多 60 字；pendingShareId 必须来自 pendingShares。`;

export const BAIYUN_CHAT_SEMANTIC_OUTPUT_PROTOCOL = [
  BAIYUN_CHAT_SEMANTIC_GUIDANCE_PROTOCOL,
  BAIYUN_CHAT_SEMANTIC_OUTPUT_TAIL_PROTOCOL,
].join('\n\n');

export type BaiyunChatSemanticEnvelopeFailureReason =
  | 'invalid_json'
  | 'invalid_root_shape'
  | 'invalid_semantic_shape'
  | 'fixed_envelope_consumers_not_ready'
  | 'too_many_signals'
  | 'invalid_signal_shape'
  | 'invalid_semantic_evidence'
  | 'required_signal_missing'
  | 'ordinary_chat_invalid';

export type BaiyunSemanticSignalRejectionCode =
  | 'invalid_shape'
  | 'invalid_kind'
  | 'invalid_confidence'
  | 'invalid_evidence'
  | 'invalid_temporality'
  | 'invalid_boundary_target'
  | 'overflow'
  | 'extra_fields_ignored'
  | 'normal_target_normalized'
  | 'required_signal_missing'
  | 'ordinary_chat_invalid'
  | 'ordinary_with_action_signal';

export interface BaiyunSemanticSignalDiagnostic {
  returnedCount: number;
  acceptedCount: number;
  discardedCount: number;
  normalizedCount: number;
  overflowCount: number;
  rejectionCodes: BaiyunSemanticSignalRejectionCode[];
}

export type BaiyunShareResponseRejectionCode =
  | 'model_omitted'
  | 'invalid_shape'
  | 'unknown_share'
  | 'duplicate_share'
  | 'direct_target_conflict'
  | 'low_confidence'
  | 'invalid_evidence';

export interface BaiyunShareResponseDiagnostic {
  pendingCount: number;
  directReplyTargeted: boolean;
  returnedCount: number;
  acceptedCount: number;
  rejectionCodes: BaiyunShareResponseRejectionCode[];
  localAcceptedCount?: number;
  localMatchKind?: BaiyunLocalShareMatchKind;
  localSkippedReason?: BaiyunLocalShareMatchSkipReason;
}

export type BaiyunChatSemanticEnvelopeResult =
  | {
      status: 'valid' | 'partial';
      messages: string[];
      semanticEvidence: BaiyunSemanticEvidenceResult;
      notebookAction: BaiyunChatNotebookAction | null;
      shareResponses: BaiyunValidatedShareResponse[];
      shareResponseDiagnostic: BaiyunShareResponseDiagnostic;
      continuityResolutions: BaiyunValidatedContinuityResolution[];
      continuityResolutionDiagnostic: BaiyunContinuityResolutionDiagnostic;
      signalDiagnostic: BaiyunSemanticSignalDiagnostic;
      fixedEnvelopeDiagnostic?: BaiyunFixedChatEnvelopeDiagnostic;
    }
  | {
      status: 'semantic_unresolved_with_messages';
      messages: string[];
      reason: BaiyunChatSemanticEnvelopeFailureReason;
      shareResponses: BaiyunValidatedShareResponse[];
      shareResponseDiagnostic: BaiyunShareResponseDiagnostic;
      continuityResolutions: BaiyunValidatedContinuityResolution[];
      continuityResolutionDiagnostic: BaiyunContinuityResolutionDiagnostic;
      notebookAction: BaiyunChatNotebookAction | null;
      signalDiagnostic: BaiyunSemanticSignalDiagnostic;
      fixedEnvelopeDiagnostic?: BaiyunFixedChatEnvelopeDiagnostic;
    }
  | {
      status: 'messages_invalid';
      messages: [];
      reason: 'messages_missing_or_empty';
      shareResponses: BaiyunValidatedShareResponse[];
      shareResponseDiagnostic: BaiyunShareResponseDiagnostic;
      continuityResolutions: BaiyunValidatedContinuityResolution[];
      continuityResolutionDiagnostic: BaiyunContinuityResolutionDiagnostic;
      notebookAction: BaiyunChatNotebookAction | null;
      signalDiagnostic: BaiyunSemanticSignalDiagnostic;
      semanticStatus: 'valid' | 'partial' | 'semantic_unresolved';
      semanticEvidence?: BaiyunSemanticEvidenceResult;
      semanticReason?: BaiyunChatSemanticEnvelopeFailureReason;
      visibleFailureReason: VisibleReplyFailureReason;
      fixedEnvelopeDiagnostic?: BaiyunFixedChatEnvelopeDiagnostic;
    };

export type BaiyunStateOnlyRetryDecision =
  | {
      mode: 'action_messages_only' | 'ordinary_messages_only';
      contextSource: 'chat.main';
      responseEnvelopeMode: 'messages_only';
      responseInstructionScope: 'visible_only';
    }
  | {
      mode: 'full_request';
      contextSource: 'chat.main';
      responseEnvelopeMode: 'messages_with_semantic';
      responseInstructionScope: 'full';
    }
  | {
      mode: 'none';
      reason: 'not_messages_invalid' | 'structure_invalid' | 'tool_round'
        | 'retry_already_used' | 'request_budget_exhausted' | 'semantic_plan_unavailable';
    };

export const BAIYUN_PROVIDER_EMPTY_SUCCESS_CODE = 'provider_empty_success' as const;

export type BaiyunProviderEmptyRetryDecision =
  | {
      mode: 'messages_only';
      contextSource: 'chat.main';
      responseEnvelopeMode: 'messages_only';
      responseInstructionScope: 'visible_only';
    }
  | {
      mode: 'none';
      reason: 'not_provider_empty_success' | 'tool_round'
        | 'retry_already_used' | 'request_budget_exhausted';
    };

export function decideBaiyunProviderEmptyRetry(input: {
  technicalCode?: string;
  additionalRequestUsed: boolean;
  remainingRequests: number;
  toolAgentUsed: boolean;
}): BaiyunProviderEmptyRetryDecision {
  if (input.technicalCode !== BAIYUN_PROVIDER_EMPTY_SUCCESS_CODE) {
    return { mode: 'none', reason: 'not_provider_empty_success' };
  }
  if (input.toolAgentUsed) return { mode: 'none', reason: 'tool_round' };
  if (input.additionalRequestUsed) return { mode: 'none', reason: 'retry_already_used' };
  if (input.remainingRequests <= 0) return { mode: 'none', reason: 'request_budget_exhausted' };
  return {
    mode: 'messages_only',
    contextSource: 'chat.main',
    responseEnvelopeMode: 'messages_only',
    responseInstructionScope: 'visible_only',
  };
}

export function decideBaiyunStateOnlyRetry(input: {
  semanticEnvelope: BaiyunChatSemanticEnvelopeResult;
  actionDisposition: 'actionable' | 'ordinary_no_action' | 'unresolved';
  additionalRequestUsed: boolean;
  remainingRequests: number;
  toolAgentUsed: boolean;
}): BaiyunStateOnlyRetryDecision {
  if (input.semanticEnvelope.status !== 'messages_invalid') {
    return { mode: 'none', reason: 'not_messages_invalid' };
  }
  if (input.toolAgentUsed) return { mode: 'none', reason: 'tool_round' };
  if (input.additionalRequestUsed) return { mode: 'none', reason: 'retry_already_used' };
  if (input.remainingRequests <= 0) return { mode: 'none', reason: 'request_budget_exhausted' };
  if (input.semanticEnvelope.semanticStatus === 'semantic_unresolved') {
    return {
      mode: 'full_request',
      contextSource: 'chat.main',
      responseEnvelopeMode: 'messages_with_semantic',
      responseInstructionScope: 'full',
    };
  }
  if (input.actionDisposition === 'actionable') {
    return {
      mode: 'action_messages_only',
      contextSource: 'chat.main',
      responseEnvelopeMode: 'messages_only',
      responseInstructionScope: 'visible_only',
    };
  }
  if (input.actionDisposition === 'ordinary_no_action') {
    return {
      mode: 'ordinary_messages_only',
      contextSource: 'chat.main',
      responseEnvelopeMode: 'messages_only',
      responseInstructionScope: 'visible_only',
    };
  }
  return { mode: 'none', reason: 'semantic_plan_unavailable' };
}

type ParsedShareResponses = {
  responses: BaiyunValidatedShareResponse[];
  diagnostic: BaiyunShareResponseDiagnostic;
};

type TaggedSemanticEnvelopeParts = {
  detected: true;
  exact: boolean;
  internal?: unknown;
  internalInvalid: boolean;
  messages: string[];
  messagesInvalid: boolean;
  rawMessages?: string[];
  visibleFailureReason: VisibleReplyFailureReason;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function parseShareResponses(input: {
  value: unknown;
  currentMessage: BaiyunSituationMessage;
  pendingShares: readonly BaiyunPendingSharePromptItem[];
}): ParsedShareResponses {
  const rejectionCodes = new Set<BaiyunShareResponseRejectionCode>();
  const directReplyTargetId = input.pendingShares.find((item) => item.directReplyTarget)?.pendingShareId;
  const returnedCount = Array.isArray(input.value) ? input.value.length : 0;
  const result = (responses: BaiyunValidatedShareResponse[]): ParsedShareResponses => ({
    responses,
    diagnostic: {
      pendingCount: input.pendingShares.length,
      directReplyTargeted: Boolean(directReplyTargetId),
      returnedCount,
      acceptedCount: responses.length,
      rejectionCodes: [...rejectionCodes],
    },
  });
  if (!Array.isArray(input.value)) {
    if (input.pendingShares.length) {
      rejectionCodes.add(input.value == null ? 'model_omitted' : 'invalid_shape');
    }
    return result([]);
  }
  if (!input.value.length) {
    if (input.pendingShares.length) rejectionCodes.add('model_omitted');
    return result([]);
  }
  if (input.value.length > 4) {
    rejectionCodes.add('invalid_shape');
    return result([]);
  }
  const pendingIds = new Set(input.pendingShares.map((item) => item.pendingShareId));
  const seen = new Set<string>();
  const responses: BaiyunValidatedShareResponse[] = [];
  for (const item of input.value) {
    if (!isPlainObject(item) || !hasExactKeys(item, SHARE_RESPONSE_KEYS)) {
      rejectionCodes.add('invalid_shape');
      continue;
    }
    const pendingShareId = item.pendingShareId;
    const state = item.state;
    const confidence = item.confidence;
    const evidence = item.evidence;
    if (
      typeof pendingShareId !== 'string'
      || (state !== 'engaged' && state !== 'declined')
      || typeof confidence !== 'number'
      || !Number.isFinite(confidence)
      || typeof evidence !== 'string'
    ) {
      rejectionCodes.add('invalid_shape');
      continue;
    }
    if (directReplyTargetId && pendingShareId !== directReplyTargetId) {
      rejectionCodes.add('direct_target_conflict');
      continue;
    }
    if (!pendingIds.has(pendingShareId)) {
      rejectionCodes.add('unknown_share');
      continue;
    }
    if (seen.has(pendingShareId)) {
      rejectionCodes.add('duplicate_share');
      continue;
    }
    if (confidence < (state === 'engaged' ? 0.8 : 0.85)) {
      rejectionCodes.add('low_confidence');
      continue;
    }
    if (
      !evidence
      || Array.from(evidence).length > 60
      || !input.currentMessage.text.includes(evidence)
    ) {
      rejectionCodes.add('invalid_evidence');
      continue;
    }
    seen.add(pendingShareId);
    responses.push({ pendingShareId, state, confidence, evidence });
  }
  return result(responses);
}

function parseTaggedSemanticEnvelope(
  raw: string,
  envelopeProtocol: BaiyunChatSemanticEnvelopeProtocol = 'legacy_tagged',
): TaggedSemanticEnvelopeParts | undefined {
  const normalized = normalizeVisibleReplyRaw(raw);
  if (!/<\/?(?:state|internal|messages)>/iu.test(normalized)) return undefined;
  const extracted = extractVisibleReplyFromRaw({
    raw: normalized,
    allowPlainText: false,
    expectedStructure: envelopeProtocol === 'single_root_json'
      ? 'single_root_json'
      : 'default',
  });
  const parsedMessages = extracted.status === 'visible'
    ? parseAssistantMessageBubbles(JSON.stringify({ messages: extracted.messages }))
    : [];

  let internal: unknown;
  let internalInvalid = true;
  const internalPayload = extracted.hiddenPayload;
  if (typeof internalPayload === 'string') {
    try {
      internal = JSON.parse(normalizeVisibleReplyRaw(internalPayload)) as unknown;
      internalInvalid = false;
    } catch {
      internal = undefined;
    }
  }

  return {
    detected: true,
    exact: Boolean(
      extracted.hiddenTag
      && extracted.status === 'visible'
      && !extracted.hadOutsideText
    ),
    internal,
    internalInvalid,
    messages: parsedMessages,
    messagesInvalid: extracted.status !== 'visible' || !parsedMessages.length,
    rawMessages: extracted.status === 'visible' ? extracted.messages : undefined,
    visibleFailureReason: extracted.failureReason ?? 'messages_malformed',
  };
}

export function getBaiyunChatSemanticOutputForTokenEstimate(raw: string) {
  const tagged = parseTaggedSemanticEnvelope(raw);
  if (
    tagged
    && !tagged.internalInvalid
    && isPlainObject(tagged.internal)
    && 'semantic' in tagged.internal
  ) {
    return JSON.stringify({
      semantic: tagged.internal.semantic,
      shareResponses: tagged.internal.shareResponses ?? [],
      continuityResolutions: tagged.internal.continuityResolutions ?? [],
      notebookAction: tagged.internal.notebookAction ?? null,
    });
  }
  try {
    const parsed = JSON.parse(normalizeVisibleReplyRaw(raw)) as unknown;
    if (!isPlainObject(parsed) || !('semantic' in parsed)) return '';
    return JSON.stringify({
      semantic: parsed.semantic,
      shareResponses: parsed.shareResponses ?? [],
      continuityResolutions: parsed.continuityResolutions ?? [],
      notebookAction: parsed.notebookAction ?? null,
    });
  } catch {
    return '';
  }
}

function cleanNotebookText(value: unknown, maximumLength: number) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, maximumLength);
}

function parseSingleNotebookKeyword(value: unknown): [string] | null {
  if (!Array.isArray(value) || value.length !== 1) return null;
  const keyword = cleanNotebookText(value[0], 24);
  return keyword ? [keyword] : null;
}

function parseNotebookAction(value: unknown): BaiyunChatNotebookAction | null {
  if (value === null || !isPlainObject(value)) return null;
  if (value.type === 'entry') {
    if (!hasExactKeys(value, NOTEBOOK_ENTRY_KEYS)) return null;
    const title = cleanNotebookText(value.title, 40);
    const content = cleanNotebookText(value.content, 480);
    const keywords = parseSingleNotebookKeyword(value.keywords);
    const sourceExcerpt = cleanNotebookText(value.sourceExcerpt, 180);
    if (!title || !content || !keywords || !sourceExcerpt) return null;
    return { type: 'entry', title, content, keywords, sourceExcerpt };
  }
  if (value.type !== 'counter') return null;
  const title = cleanNotebookText(value.title, 40);
  const keywords = parseSingleNotebookKeyword(value.keywords);
  if (!title || !keywords) return null;
  if (value.counterType === 'period_count') {
    if (!hasExactKeys(value, NOTEBOOK_COUNTER_PERIOD_KEYS)) return null;
    const period = value.period;
    if (period !== 'today' && period !== 'this_week' && period !== 'this_month' && period !== 'this_year') return null;
    return { type: 'counter', counterType: 'period_count', keywords, period, title };
  }
  if (value.counterType === 'nth_occurrence') {
    if (!hasExactKeys(value, NOTEBOOK_COUNTER_TARGET_KEYS)) return null;
    if (typeof value.targetCount !== 'number' || !Number.isFinite(value.targetCount) || value.targetCount < 1) return null;
    return {
      type: 'counter',
      counterType: 'nth_occurrence',
      keywords,
      targetCount: Math.floor(value.targetCount),
      title,
    };
  }
  return null;
}

function parseVisibleMessages(
  raw: string,
  envelopeProtocol: BaiyunChatSemanticEnvelopeProtocol = 'legacy_tagged',
) {
  const extracted = extractVisibleReplyFromRaw({
    raw,
    expectedStructure: envelopeProtocol === 'single_root_json'
      ? 'single_root_json'
      : 'default',
  });
  if (extracted.status !== 'visible') return [];
  const messages = envelopeProtocol === 'single_root_json'
    ? extracted.messages.flatMap((message) => message.split(/\r?\n[ \t]*\r?\n+/u))
    : extracted.messages;
  return parseAssistantMessageBubbles(JSON.stringify({ messages }));
}

const EMPTY_SIGNAL_DIAGNOSTIC: BaiyunSemanticSignalDiagnostic = {
  returnedCount: 0,
  acceptedCount: 0,
  discardedCount: 0,
  normalizedCount: 0,
  overflowCount: 0,
  rejectionCodes: [],
};

type ParsedSemanticModule =
  | {
      status: 'valid' | 'partial';
      value: BaiyunSemanticEvidenceResult;
      diagnostic: BaiyunSemanticSignalDiagnostic;
    }
  | {
      status: 'semantic_unresolved';
      reason: BaiyunChatSemanticEnvelopeFailureReason;
      diagnostic: BaiyunSemanticSignalDiagnostic;
    };

function parseConfidence(value: unknown) {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim()
      ? Number(value)
      : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : undefined;
}

function parseSemanticModule(
  value: unknown,
  currentMessage: BaiyunSituationMessage,
): ParsedSemanticModule {
  if (!isPlainObject(value) || !Array.isArray(value.signals)) {
    return {
      status: 'semantic_unresolved',
      reason: 'invalid_semantic_shape',
      diagnostic: EMPTY_SIGNAL_DIAGNOSTIC,
    };
  }

  const returnedSignals = value.signals;
  const rejectionCodes = new Set<BaiyunSemanticSignalRejectionCode>();
  const overflowCount = Math.max(0, returnedSignals.length - MAX_SEMANTIC_SIGNALS);
  if (overflowCount) rejectionCodes.add('overflow');
  let normalizedCount = 0;
  let discardedCount = overflowCount;
  let validOrdinaryChatCount = 0;
  let invalidOrdinaryChatCount = 0;
  const signals: BaiyunSemanticSignal[] = [];

  for (const rawSignal of returnedSignals.slice(0, MAX_SEMANTIC_SIGNALS)) {
    if (!isPlainObject(rawSignal)) {
      discardedCount += 1;
      rejectionCodes.add('invalid_shape');
      continue;
    }
    const extraKeys = Object.keys(rawSignal).filter((key) => ![
      'kind', 'confidence', 'evidence', 'temporality', 'target',
    ].includes(key));
    if (extraKeys.length) {
      normalizedCount += 1;
      rejectionCodes.add('extra_fields_ignored');
    }
    if (typeof rawSignal.kind !== 'string' || !CHAT_SIGNAL_WIRE_KINDS.has(rawSignal.kind)) {
      discardedCount += 1;
      rejectionCodes.add('invalid_kind');
      continue;
    }
    const confidence = parseConfidence(rawSignal.confidence);
    if (confidence === undefined) {
      discardedCount += 1;
      if (rawSignal.kind === 'ordinary_chat') invalidOrdinaryChatCount += 1;
      rejectionCodes.add('invalid_confidence');
      continue;
    }
    if (
      typeof rawSignal.evidence !== 'string'
      || !rawSignal.evidence
      || Array.from(rawSignal.evidence).length > 60
      || !currentMessage.text.includes(rawSignal.evidence)
    ) {
      discardedCount += 1;
      if (rawSignal.kind === 'ordinary_chat') invalidOrdinaryChatCount += 1;
      rejectionCodes.add('invalid_evidence');
      continue;
    }
    if (
      typeof rawSignal.temporality !== 'string'
      || !CHAT_TEMPORALITIES.has(rawSignal.temporality)
    ) {
      discardedCount += 1;
      if (rawSignal.kind === 'ordinary_chat') invalidOrdinaryChatCount += 1;
      rejectionCodes.add('invalid_temporality');
      continue;
    }

    if (rawSignal.kind === 'ordinary_chat') {
      if (
        confidence < 0.8
        || rawSignal.temporality !== 'current'
        || rawSignal.target !== 'none'
      ) {
        discardedCount += 1;
        invalidOrdinaryChatCount += 1;
        rejectionCodes.add('ordinary_chat_invalid');
        continue;
      }
      validOrdinaryChatCount += 1;
      continue;
    }

    const kind = rawSignal.kind as BaiyunSemanticSignalKind;

    const isBoundary = BOUNDARY_SIGNAL_KINDS.has(kind);
    let wireTarget = rawSignal.target;
    if (typeof wireTarget !== 'string') {
      discardedCount += 1;
      rejectionCodes.add(isBoundary ? 'invalid_boundary_target' : 'invalid_shape');
      continue;
    }
    if (isBoundary) {
      const validBoundaryTarget = CHAT_TARGETS.has(wireTarget)
        && (
          kind !== 'playful_resistance'
          || wireTarget === 'affection'
          || wireTarget === 'desire'
          || wireTarget === 'play'
        );
      if (!validBoundaryTarget) {
        discardedCount += 1;
        rejectionCodes.add('invalid_boundary_target');
        continue;
      }
    } else if (wireTarget !== 'none') {
      wireTarget = 'none';
      normalizedCount += 1;
      rejectionCodes.add('normal_target_normalized');
    }

    const target: BaiyunSemanticSignal['target'] = wireTarget === 'all'
      ? 'general'
      : wireTarget === 'affection'
        || wireTarget === 'desire'
        || wireTarget === 'play'
        || wireTarget === 'task'
        ? wireTarget
        : 'general';
    signals.push({
      kind,
      confidence,
      evidence: rawSignal.evidence,
      messageId: currentMessage.id,
      subject: 'you',
      temporality: rawSignal.temporality as BaiyunSemanticSignal['temporality'],
      target,
    });
  }

  const careUrgency = value.careUrgency === 'elevated' || value.careUrgency === 'urgent'
    ? value.careUrgency
    : 'none';
  if (value.careUrgency !== 'none' && value.careUrgency !== 'elevated' && value.careUrgency !== 'urgent') {
    normalizedCount += 1;
  }
  const uncertain = typeof value.uncertain === 'boolean' ? value.uncertain : true;
  if (typeof value.uncertain !== 'boolean') normalizedCount += 1;
  if (validOrdinaryChatCount > 1) {
    discardedCount += validOrdinaryChatCount;
    invalidOrdinaryChatCount += validOrdinaryChatCount;
    validOrdinaryChatCount = 0;
    rejectionCodes.add('ordinary_chat_invalid');
  }
  if (validOrdinaryChatCount > 0 && (careUrgency !== 'none' || uncertain)) {
    discardedCount += validOrdinaryChatCount;
    invalidOrdinaryChatCount += validOrdinaryChatCount;
    validOrdinaryChatCount = 0;
    rejectionCodes.add('ordinary_chat_invalid');
  }
  if (validOrdinaryChatCount > 0 && signals.length > 0) {
    discardedCount += validOrdinaryChatCount;
    validOrdinaryChatCount = 0;
    rejectionCodes.add('ordinary_with_action_signal');
  }
  if (invalidOrdinaryChatCount > 0) rejectionCodes.add('ordinary_chat_invalid');
  if (returnedSignals.length === 0) rejectionCodes.add('required_signal_missing');
  const diagnostic: BaiyunSemanticSignalDiagnostic = {
    returnedCount: returnedSignals.length,
    acceptedCount: signals.length + validOrdinaryChatCount,
    discardedCount,
    normalizedCount,
    overflowCount,
    rejectionCodes: [...rejectionCodes],
  };
  if (returnedSignals.length === 0) {
    return {
      status: 'semantic_unresolved',
      reason: 'required_signal_missing',
      diagnostic,
    };
  }
  if (returnedSignals.length > 0 && signals.length === 0) {
    if (validOrdinaryChatCount > 0) {
      return {
        status: discardedCount > 0 || normalizedCount > 0
          ? 'partial'
          : 'valid',
        value: { signals: [], careUrgency: 'none', uncertain: false },
        diagnostic,
      };
    }
    return {
      status: 'semantic_unresolved',
      reason: invalidOrdinaryChatCount > 0
        ? 'ordinary_chat_invalid'
        : 'invalid_semantic_evidence',
      diagnostic,
    };
  }
  return {
    status: discardedCount > 0 || normalizedCount > 0
      ? 'partial'
      : 'valid',
    value: { signals, careUrgency, uncertain },
    diagnostic,
  };
}

function unresolved(
  raw: string,
  parsed: unknown,
  reason: BaiyunChatSemanticEnvelopeFailureReason,
  shareResult: ParsedShareResponses,
  continuityResult: ParsedBaiyunContinuityResolutions,
  notebookAction: BaiyunChatNotebookAction | null = null,
  signalDiagnostic: BaiyunSemanticSignalDiagnostic = EMPTY_SIGNAL_DIAGNOSTIC,
  envelopeProtocol: BaiyunChatSemanticEnvelopeProtocol = 'legacy_tagged',
  fixedEnvelopeDiagnostic?: BaiyunFixedChatEnvelopeDiagnostic,
): BaiyunChatSemanticEnvelopeResult {
  const messages = parseVisibleMessages(raw, envelopeProtocol);
  if (!messages.length) {
    return {
      status: 'messages_invalid',
      messages: [],
      reason: 'messages_missing_or_empty',
      shareResponses: shareResult.responses,
      shareResponseDiagnostic: shareResult.diagnostic,
      continuityResolutions: continuityResult.resolutions,
      continuityResolutionDiagnostic: continuityResult.diagnostic,
      notebookAction,
      signalDiagnostic,
      semanticStatus: 'semantic_unresolved',
      semanticReason: reason,
      visibleFailureReason: normalizeVisibleReplyRaw(raw)
        ? 'messages_malformed'
        : 'no_safe_visible_candidate',
      ...(fixedEnvelopeDiagnostic ? { fixedEnvelopeDiagnostic } : {}),
    };
  }
  return {
    status: 'semantic_unresolved_with_messages',
    messages,
    reason,
    shareResponses: shareResult.responses,
    shareResponseDiagnostic: shareResult.diagnostic,
    continuityResolutions: continuityResult.resolutions,
    continuityResolutionDiagnostic: continuityResult.diagnostic,
    notebookAction,
    signalDiagnostic,
    ...(fixedEnvelopeDiagnostic ? { fixedEnvelopeDiagnostic } : {}),
  };
}

function unresolvedWithMessages(
  messages: string[],
  reason: BaiyunChatSemanticEnvelopeFailureReason,
  shareResult: ParsedShareResponses,
  continuityResult: ParsedBaiyunContinuityResolutions,
  notebookAction: BaiyunChatNotebookAction | null = null,
  signalDiagnostic: BaiyunSemanticSignalDiagnostic = EMPTY_SIGNAL_DIAGNOSTIC,
  fixedEnvelopeDiagnostic?: BaiyunFixedChatEnvelopeDiagnostic,
): BaiyunChatSemanticEnvelopeResult {
  if (!messages.length) {
    return {
      status: 'messages_invalid',
      messages: [],
      reason: 'messages_missing_or_empty',
      shareResponses: shareResult.responses,
      shareResponseDiagnostic: shareResult.diagnostic,
      continuityResolutions: continuityResult.resolutions,
      continuityResolutionDiagnostic: continuityResult.diagnostic,
      notebookAction,
      signalDiagnostic,
      semanticStatus: 'semantic_unresolved',
      semanticReason: reason,
      visibleFailureReason: 'messages_empty',
      ...(fixedEnvelopeDiagnostic ? { fixedEnvelopeDiagnostic } : {}),
    };
  }
  return {
    status: 'semantic_unresolved_with_messages',
    messages,
    reason,
    shareResponses: shareResult.responses,
    shareResponseDiagnostic: shareResult.diagnostic,
    continuityResolutions: continuityResult.resolutions,
    continuityResolutionDiagnostic: continuityResult.diagnostic,
    notebookAction,
    signalDiagnostic,
    ...(fixedEnvelopeDiagnostic ? { fixedEnvelopeDiagnostic } : {}),
  };
}

export function parseBaiyunChatSemanticEnvelope(input: {
  raw: string;
  currentMessage: BaiyunSituationMessage;
  pendingShares?: readonly BaiyunPendingSharePromptItem[];
  openContinuityEvents?: readonly BaiyunContinuityResolutionPromptItem[];
  envelopeProtocol?: BaiyunChatSemanticEnvelopeProtocol;
  fixedEnvelopeMode?: BaiyunFixedEnvelopeMode;
}): BaiyunChatSemanticEnvelopeResult {
  const pendingShares = input.pendingShares ?? [];
  const openContinuityEvents = input.openContinuityEvents ?? [];
  const envelopeProtocol = input.envelopeProtocol ?? 'legacy_tagged';
  const omittedShareResult = parseShareResponses({
    value: undefined,
    currentMessage: input.currentMessage,
    pendingShares,
  });
  const omittedContinuityResult = parseBaiyunContinuityResolutions({
    value: undefined,
    currentMessage: input.currentMessage,
    openContinuityEvents,
  });
  const tagged = parseTaggedSemanticEnvelope(input.raw, envelopeProtocol);
  if (tagged) {
    const taggedShareResult = isPlainObject(tagged.internal)
      ? parseShareResponses({
          value: tagged.internal.shareResponses,
          currentMessage: input.currentMessage,
          pendingShares,
        })
      : omittedShareResult;
    const taggedContinuityResult = isPlainObject(tagged.internal)
      ? parseBaiyunContinuityResolutions({
          value: tagged.internal.continuityResolutions,
          currentMessage: input.currentMessage,
          openContinuityEvents,
        })
      : omittedContinuityResult;
    const taggedNotebookAction = isPlainObject(tagged.internal)
      ? parseNotebookAction(tagged.internal.notebookAction)
      : null;
    const taggedSemanticResult = isPlainObject(tagged.internal)
      ? parseSemanticModule(tagged.internal.semantic, input.currentMessage)
      : {
          status: 'semantic_unresolved' as const,
          reason: tagged.internalInvalid ? 'invalid_json' as const : 'invalid_root_shape' as const,
          diagnostic: EMPTY_SIGNAL_DIAGNOSTIC,
        };
    if (tagged.messagesInvalid || !tagged.rawMessages) {
      return {
        status: 'messages_invalid',
        messages: [],
        reason: 'messages_missing_or_empty',
        shareResponses: taggedShareResult.responses,
        shareResponseDiagnostic: taggedShareResult.diagnostic,
        continuityResolutions: taggedContinuityResult.resolutions,
        continuityResolutionDiagnostic: taggedContinuityResult.diagnostic,
        notebookAction: taggedNotebookAction,
        signalDiagnostic: taggedSemanticResult.diagnostic,
        semanticStatus: taggedSemanticResult.status,
        semanticEvidence: taggedSemanticResult.status === 'valid'
          || taggedSemanticResult.status === 'partial'
          ? taggedSemanticResult.value
          : undefined,
        semanticReason: taggedSemanticResult.status === 'semantic_unresolved'
          ? taggedSemanticResult.reason
          : undefined,
        visibleFailureReason: tagged.visibleFailureReason,
      };
    }
    if (
      !tagged.exact
      || tagged.internalInvalid
      || !isPlainObject(tagged.internal)
    ) {
      return unresolvedWithMessages(
        tagged.messages,
        tagged.internalInvalid ? 'invalid_json' : 'invalid_root_shape',
        taggedShareResult,
        taggedContinuityResult,
        taggedNotebookAction,
        EMPTY_SIGNAL_DIAGNOSTIC,
      );
    }
    return parseBaiyunChatSemanticEnvelope({
      raw: JSON.stringify({
        semantic: tagged.internal.semantic,
        messages: tagged.rawMessages,
        shareResponses: tagged.internal.shareResponses ?? [],
        continuityResolutions: tagged.internal.continuityResolutions ?? [],
        notebookAction: tagged.internal.notebookAction,
      }),
      currentMessage: input.currentMessage,
      pendingShares,
      openContinuityEvents,
      envelopeProtocol: 'legacy_tagged',
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(normalizeVisibleReplyRaw(input.raw));
  } catch {
    const fixedEnvelopeDiagnostic = inspectBaiyunFixedChatEnvelope(input.raw, input.fixedEnvelopeMode);
    return unresolved(
      input.raw,
      undefined,
      fixedEnvelopeDiagnostic.candidate ? 'invalid_semantic_shape' : 'invalid_json',
      omittedShareResult, omittedContinuityResult,
      null,
      EMPTY_SIGNAL_DIAGNOSTIC,
      envelopeProtocol,
      fixedEnvelopeDiagnostic.candidate ? fixedEnvelopeDiagnostic : undefined,
    );
  }

  const messages = parseVisibleMessages(input.raw, envelopeProtocol);
  if (isBaiyunFixedChatEnvelopeCandidate(parsed, input.fixedEnvelopeMode)) {
    const fixedEnvelopeDiagnostic = inspectBaiyunFixedChatEnvelope(input.raw, input.fixedEnvelopeMode);
    return unresolvedWithMessages(
      messages,
      'invalid_semantic_shape',
      omittedShareResult,
      omittedContinuityResult,
      null,
      EMPTY_SIGNAL_DIAGNOSTIC,
      fixedEnvelopeDiagnostic,
    );
  }
  const shareResult = isPlainObject(parsed)
    ? parseShareResponses({
        value: parsed.shareResponses,
        currentMessage: input.currentMessage,
        pendingShares,
      })
    : omittedShareResult;
  const continuityResult = isPlainObject(parsed)
    ? parseBaiyunContinuityResolutions({
        value: parsed.continuityResolutions,
        currentMessage: input.currentMessage,
        openContinuityEvents,
      })
    : omittedContinuityResult;
  const notebookAction = isPlainObject(parsed)
    ? parseNotebookAction(parsed.notebookAction)
    : null;
  if (!isPlainObject(parsed)) {
    return unresolved(
      input.raw,
      parsed,
      'invalid_root_shape',
      shareResult,
      continuityResult,
      notebookAction,
      EMPTY_SIGNAL_DIAGNOSTIC,
      envelopeProtocol,
    );
  }
  const semanticResult = parseSemanticModule(parsed.semantic, input.currentMessage);
  if (!messages.length) {
    return {
      status: 'messages_invalid',
      messages: [],
      reason: 'messages_missing_or_empty',
      shareResponses: shareResult.responses,
      shareResponseDiagnostic: shareResult.diagnostic,
      continuityResolutions: continuityResult.resolutions,
      continuityResolutionDiagnostic: continuityResult.diagnostic,
      notebookAction,
      signalDiagnostic: semanticResult.diagnostic,
      semanticStatus: semanticResult.status,
      semanticEvidence: semanticResult.status === 'valid' || semanticResult.status === 'partial'
        ? semanticResult.value
        : undefined,
      semanticReason: semanticResult.status === 'semantic_unresolved'
        ? semanticResult.reason
        : undefined,
      visibleFailureReason: 'messages_empty',
    };
  }
  if (semanticResult.status === 'semantic_unresolved') {
    return unresolved(
      input.raw,
      parsed,
      semanticResult.reason,
      shareResult,
      continuityResult,
      notebookAction,
      semanticResult.diagnostic,
      envelopeProtocol,
    );
  }
  return {
    status: semanticResult.status,
    messages,
    notebookAction,
    shareResponses: shareResult.responses,
    shareResponseDiagnostic: shareResult.diagnostic,
    continuityResolutions: continuityResult.resolutions,
    continuityResolutionDiagnostic: continuityResult.diagnostic,
    semanticEvidence: semanticResult.value,
    signalDiagnostic: semanticResult.diagnostic,
  };
}

export function recoverBaiyunChatSemanticEnvelopeFromReasoning(input: {
  raw: string;
  currentMessage: BaiyunSituationMessage;
  pendingShares?: readonly BaiyunPendingSharePromptItem[];
  openContinuityEvents?: readonly BaiyunContinuityResolutionPromptItem[];
}) {
  const extracted = extractVisibleReply({
    directContent: '',
    reasoningContent: input.raw,
    allowReasoningRecovery: true,
  });
  if (extracted.status !== 'visible') return '';
  const candidateRaw = extracted.structureVariant === 'legacy_message' && !extracted.hiddenPayload
    ? JSON.stringify({ messages: extracted.messages })
    : extracted.raw;
  const parsedCandidate = parseBaiyunChatSemanticEnvelope({
    raw: candidateRaw,
    currentMessage: input.currentMessage,
    pendingShares: input.pendingShares,
    openContinuityEvents: input.openContinuityEvents,
  });
  return parsedCandidate.status === 'valid'
    || parsedCandidate.status === 'partial'
    || parsedCandidate.status === 'semantic_unresolved_with_messages'
    ? candidateRaw
    : '';
}
