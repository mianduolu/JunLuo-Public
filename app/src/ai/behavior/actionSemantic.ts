import type { BaiyunActionIntentId } from './actionIntent';
import type {
  BaiyunAmbiguityReasonCode,
  BaiyunSituationMessage,
} from './actionSituation';

export const BAIYUN_SEMANTIC_SIGNAL_KINDS = [
  'affection_request',
  'bond_request',
  'relationship_departure',
  'relationship_hurt',
  'desire_invitation',
  'emotional_distress',
  'care_need',
  'guidance_request',
  'interruption_request',
  'protection_need',
  'presence_request',
  'share_request',
  'exploration_request',
  'play_request',
  'confide_invitation',
  'collaboration_request',
  'playful_resistance',
  'stop_or_refusal',
] as const;

export type BaiyunSemanticSignalKind = typeof BAIYUN_SEMANTIC_SIGNAL_KINDS[number];

export interface BaiyunSemanticSignal {
  kind: BaiyunSemanticSignalKind;
  confidence: number;
  messageId: string;
  evidence: string;
  subject: 'you' | 'I' | 'other';
  temporality: 'current' | 'historical' | 'hypothetical' | 'quoted';
  target: 'relationship' | 'affection' | 'desire' | 'care' | 'task' | 'play' | 'general';
}

export interface BaiyunSemanticEvidenceResult {
  signals: BaiyunSemanticSignal[];
  careUrgency: 'none' | 'elevated' | 'urgent';
  uncertain: boolean;
}

export const BAIYUN_SEMANTIC_REVIEW_SYSTEM_PROMPT = `以下任务属于 I 的内部语义理解。只复核 currentMessageId 指向的当前消息，历史消息仅用于理解语境。

请结合完整句子和前两轮对话判断：

1. 当前消息是在表达此刻、回忆过去、提出假设，还是引用内容；
2. 其中的需要、感受或边界属于 you、I，还是消息中提到的 other；
3. 阻拦表达是真正希望停止、有语境支持的口是心非式邀请，还是暂时无法确定；
4. 从输入提供的标签中，选出当前消息真正表达出的需要、感受或边界；只有明确证据的标签才能选择。

不要根据单个词判断。仍无法确定当前消息含义时，返回 uncertain=true。

evidence 必须逐字来自当前消息。只提取语义；I 接下来做什么、是否已经做到，由后续程序根据真实状态处理。只输出指定 JSON。`;

const SIGNAL_KIND_SET = new Set<string>(BAIYUN_SEMANTIC_SIGNAL_KINDS);
const CARE_URGENCY_SET = new Set(['none', 'elevated', 'urgent']);
const SUBJECT_SET = new Set(['you', 'I', 'other']);
const TEMPORALITY_SET = new Set(['current', 'historical', 'hypothetical', 'quoted']);
const TARGET_SET = new Set(['relationship', 'affection', 'desire', 'care', 'task', 'play', 'general']);
const ROOT_KEYS = ['signals', 'careUrgency', 'uncertain'] as const;
const SIGNAL_KEYS = ['kind', 'confidence', 'messageId', 'evidence', 'subject', 'temporality', 'target'] as const;

const SIGNAL_TO_INTENT: Partial<Record<BaiyunSemanticSignalKind, BaiyunActionIntentId>> = {
  affection_request: 'affection',
  bond_request: 'affirm_bond',
  relationship_departure: 'retain',
  relationship_hurt: 'repair',
  desire_invitation: 'desire',
  emotional_distress: 'soothe',
  care_need: 'care_check',
  guidance_request: 'guide',
  interruption_request: 'guide',
  protection_need: 'protect',
  share_request: 'share',
  exploration_request: 'explore',
  play_request: 'play',
  confide_invitation: 'confide',
  collaboration_request: 'collaborate',
};

const HIGH_IMPACT_SIGNAL_KINDS = new Set<BaiyunSemanticSignalKind>([
  'relationship_departure',
  'relationship_hurt',
  'desire_invitation',
  'interruption_request',
  'playful_resistance',
]);

export type BaiyunSemanticPayload = {
  currentMessageId: string;
  localNow: string;
  localAmbiguityReasons: BaiyunAmbiguityReasonCode[];
  messages: Array<{
    id: string;
    role: 'you' | 'I';
    sentAt: string;
    text: string;
  }>;
  allowedSignalKinds: readonly BaiyunSemanticSignalKind[];
  requiredOutputSchema: {
    signals: Array<{
      kind: 'allowedSignalKind';
      confidence: 'number 0..1';
      messageId: 'currentMessageId';
      evidence: 'continuous current-message excerpt, at most 60 characters';
      subject: 'you | I | other';
      temporality: 'current | historical | hypothetical | quoted';
      target: 'relationship | affection | desire | care | task | play | general';
    }>;
    careUrgency: 'none | elevated | urgent';
    uncertain: 'boolean';
  };
};

function truncateUnicode(text: string, maximum: number, preserveEnds = false) {
  const characters = Array.from(text);
  if (characters.length <= maximum) return text;
  if (!preserveEnds) return characters.slice(0, maximum).join('');
  const headSize = Math.ceil(maximum / 2);
  const tailSize = Math.floor(maximum / 2);
  return `${characters.slice(0, headSize).join('')}…${characters.slice(-tailSize).join('')}`;
}

export function buildBaiyunSemanticPayload(input: {
  currentMessage: BaiyunSituationMessage;
  previousMessages?: readonly BaiyunSituationMessage[];
  ambiguityReasons: readonly BaiyunAmbiguityReasonCode[];
  localNow?: Date;
}): BaiyunSemanticPayload {
  const previous = (input.previousMessages ?? []).slice(-2).map((message) => ({
    id: message.id,
    role: message.role,
    sentAt: new Date(message.sentAt).toISOString(),
    text: truncateUnicode(message.text, 400),
  }));
  const current = {
    id: input.currentMessage.id,
    role: input.currentMessage.role,
    sentAt: new Date(input.currentMessage.sentAt).toISOString(),
    text: truncateUnicode(input.currentMessage.text, 2000, true),
  };
  return {
    currentMessageId: input.currentMessage.id,
    localNow: (input.localNow ?? new Date()).toISOString(),
    localAmbiguityReasons: [...input.ambiguityReasons],
    messages: [...previous, current],
    allowedSignalKinds: BAIYUN_SEMANTIC_SIGNAL_KINDS,
    requiredOutputSchema: {
      signals: [{
        kind: 'allowedSignalKind',
        confidence: 'number 0..1',
        messageId: 'currentMessageId',
        evidence: 'continuous current-message excerpt, at most 60 characters',
        subject: 'you | I | other',
        temporality: 'current | historical | hypothetical | quoted',
        target: 'relationship | affection | desire | care | task | play | general',
      }],
      careUrgency: 'none | elevated | urgent',
      uncertain: 'boolean',
    },
  };
}

export function buildBaiyunSemanticReviewMessages(payload: BaiyunSemanticPayload) {
  return [
    { role: 'system' as const, content: BAIYUN_SEMANTIC_REVIEW_SYSTEM_PROMPT },
    {
      role: 'user' as const,
      content: JSON.stringify(payload),
    },
  ];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

export type BaiyunSemanticParseResult =
  | { ok: true; value: BaiyunSemanticEvidenceResult }
  | { ok: false; error: string };

export function parseBaiyunSemanticEvidence(
  raw: string,
  messages: readonly BaiyunSituationMessage[],
  currentMessageId: string,
): BaiyunSemanticParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    return { ok: false, error: 'invalid_json' };
  }
  if (!isPlainObject(parsed) || !hasExactKeys(parsed, ROOT_KEYS)) {
    return { ok: false, error: 'invalid_root_shape' };
  }
  if (!Array.isArray(parsed.signals)) {
    return { ok: false, error: 'signals_not_array' };
  }
  if (typeof parsed.careUrgency !== 'string' || !CARE_URGENCY_SET.has(parsed.careUrgency)) {
    return { ok: false, error: 'invalid_care_urgency' };
  }
  if (typeof parsed.uncertain !== 'boolean') {
    return { ok: false, error: 'invalid_uncertain' };
  }

  const currentMessage = messages.find((message) => message.id === currentMessageId);
  if (!currentMessage) {
    return { ok: false, error: 'unknown_current_message_id' };
  }
  const signals: BaiyunSemanticSignal[] = [];
  for (const entry of parsed.signals) {
    if (!isPlainObject(entry) || !hasExactKeys(entry, SIGNAL_KEYS)) {
      return { ok: false, error: 'invalid_signal_shape' };
    }
    if (typeof entry.kind !== 'string' || !SIGNAL_KIND_SET.has(entry.kind)) {
      return { ok: false, error: 'invalid_signal_kind' };
    }
    if (typeof entry.confidence !== 'number' || !Number.isFinite(entry.confidence)
      || entry.confidence < 0 || entry.confidence > 1) {
      return { ok: false, error: 'invalid_signal_confidence' };
    }
    if (entry.messageId !== currentMessageId) {
      return { ok: false, error: 'non_current_message_id' };
    }
    if (typeof entry.evidence !== 'string' || !entry.evidence
      || Array.from(entry.evidence).length > 60
      || !currentMessage.text.includes(entry.evidence)) {
      return { ok: false, error: 'invalid_evidence_excerpt' };
    }
    if (typeof entry.subject !== 'string' || !SUBJECT_SET.has(entry.subject)) {
      return { ok: false, error: 'invalid_subject' };
    }
    if (typeof entry.temporality !== 'string' || !TEMPORALITY_SET.has(entry.temporality)) {
      return { ok: false, error: 'invalid_temporality' };
    }
    if (typeof entry.target !== 'string' || !TARGET_SET.has(entry.target)) {
      return { ok: false, error: 'invalid_target' };
    }
    if (
      entry.kind === 'playful_resistance'
      && entry.target !== 'affection'
      && entry.target !== 'desire'
      && entry.target !== 'play'
    ) {
      return { ok: false, error: 'invalid_playful_resistance_target' };
    }
    signals.push(entry as unknown as BaiyunSemanticSignal);
  }

  return {
    ok: true,
    value: {
      signals,
      careUrgency: parsed.careUrgency as BaiyunSemanticEvidenceResult['careUrgency'],
      uncertain: parsed.uncertain,
    },
  };
}

export function getIntentForBaiyunSemanticSignal(signal: BaiyunSemanticSignal) {
  if (signal.kind === 'playful_resistance') {
    if (signal.target === 'affection') return 'affection' as const;
    if (signal.target === 'desire') return 'desire' as const;
    if (signal.target === 'play') return 'play' as const;
    return undefined;
  }
  return SIGNAL_TO_INTENT[signal.kind];
}

export function canBaiyunSemanticSignalCreateCandidate(
  signal: BaiyunSemanticSignal,
  currentMessageId: string,
) {
  if (
    signal.messageId !== currentMessageId
    || signal.subject !== 'you'
    || signal.temporality !== 'current'
    || signal.kind === 'stop_or_refusal'
  ) {
    return false;
  }
  const threshold = HIGH_IMPACT_SIGNAL_KINDS.has(signal.kind) ? 0.85 : 0.8;
  return signal.confidence >= threshold;
}

export function canBaiyunSemanticSignalReinforceCandidate(
  signal: BaiyunSemanticSignal,
  currentMessageId: string,
) {
  return signal.messageId === currentMessageId
    && signal.subject === 'you'
    && signal.temporality === 'current'
    && signal.confidence >= 0.6;
}

export function isEffectiveBaiyunStopSignal(
  signal: BaiyunSemanticSignal,
  currentMessageId: string,
) {
  return signal.kind === 'stop_or_refusal'
    && signal.messageId === currentMessageId
    && signal.subject === 'you'
    && signal.temporality === 'current'
    && signal.confidence >= 0.7;
}
