import type { BaiyunAmbiguityReasonCode } from './actionSituation';
import type { BaiyunSemanticSignalKind } from './actionSemantic';

export const BAIYUN_REMOTE_REVIEW_LIMIT_OPTIONS = [3, 8, 15, -1] as const;
export const DEFAULT_BAIYUN_REMOTE_REVIEW_DAILY_LIMIT = 8;

export type BaiyunSemanticReviewOutcome =
  | 'request_started'
  | 'accepted'
  | 'insufficient_evidence'
  | 'invalid_response'
  | 'request_failed'
  | 'budget_blocked';

export type BaiyunSemanticReviewEntry = {
  id: string;
  fingerprint: string;
  currentMessageId: string;
  attemptedAt: number;
  ambiguityReasons: BaiyunAmbiguityReasonCode[];
  connectionId?: string;
  connectionName?: string;
  model?: string;
  outcome: BaiyunSemanticReviewOutcome;
  summary?: string;
  signalKinds: BaiyunSemanticSignalKind[];
  confidences: number[];
  durationMs?: number;
};

export interface BaiyunSemanticReviewBudget {
  localDate: string;
  remoteAttemptsUsed: number;
  dailyLimit: number;
  entries: BaiyunSemanticReviewEntry[];
}

export const BAIYUN_AMBIGUITY_REASON_LABELS: Record<BaiyunAmbiguityReasonCode, string> = {
  conflicting_candidates: '多个行动互相冲突',
  close_candidate_scores: '候选分数过于接近',
  negation_scope: '否定范围不清楚',
  double_negation: '出现双重否定',
  hypothetical_or_conditional: '是假设或条件句',
  quotation_or_reported_speech: '含引用或转述',
  ellipsis_or_reference: '存在省略或指代',
  possible_irony: '可能是在说反话',
  current_context_conflict: '与最近对话冲突',
  open_event_conflict: '与未完成牵挂冲突',
  weak_sensitive_evidence: '高影响行动证据偏弱',
  unclear_boundary_target: '停止或边界目标不清楚',
};

export const BAIYUN_REVIEW_OUTCOME_LABELS: Record<BaiyunSemanticReviewOutcome, string> = {
  request_started: '请求中',
  accepted: '已采用',
  insufficient_evidence: '证据不足未采用',
  invalid_response: '返回非法',
  request_failed: '请求失败',
  budget_blocked: '额度阻止',
};

function normalizedDailyLimit(value: number) {
  if (value === -1) return -1;
  if (!Number.isFinite(value)) return DEFAULT_BAIYUN_REMOTE_REVIEW_DAILY_LIMIT;
  return Math.max(0, Math.round(value));
}

function trimSummary(value: string | undefined) {
  if (!value) return undefined;
  const characters = Array.from(value.replace(/\s+/gu, ' ').trim());
  return characters.slice(0, 20).join('') || undefined;
}

export function createBaiyunSemanticReviewBudget(
  localDate: string,
  dailyLimit = DEFAULT_BAIYUN_REMOTE_REVIEW_DAILY_LIMIT,
): BaiyunSemanticReviewBudget {
  return {
    localDate,
    remoteAttemptsUsed: 0,
    dailyLimit: normalizedDailyLimit(dailyLimit),
    entries: [],
  };
}

export function normalizeBaiyunSemanticReviewBudget(
  budget: BaiyunSemanticReviewBudget | undefined,
  localDate: string,
  dailyLimit: number,
) {
  const normalizedLimit = normalizedDailyLimit(dailyLimit);
  if (!budget || budget.localDate !== localDate) {
    return createBaiyunSemanticReviewBudget(localDate, normalizedLimit);
  }
  return {
    localDate,
    remoteAttemptsUsed: Math.max(0, Math.round(budget.remoteAttemptsUsed || 0)),
    dailyLimit: normalizedLimit,
    entries: Array.isArray(budget.entries) ? budget.entries.slice(-64) : [],
  } satisfies BaiyunSemanticReviewBudget;
}

export function getBaiyunSemanticReviewRemaining(budget: BaiyunSemanticReviewBudget) {
  if (budget.dailyLimit < 0) return Number.POSITIVE_INFINITY;
  return Math.max(0, budget.dailyLimit - budget.remoteAttemptsUsed);
}

export type StartBaiyunRemoteReviewInput = {
  budget: BaiyunSemanticReviewBudget;
  localDate: string;
  dailyLimit: number;
  fingerprint: string;
  currentMessageId: string;
  ambiguityReasons: readonly BaiyunAmbiguityReasonCode[];
  attemptedAt: number;
  connectionId?: string;
  connectionName?: string;
  model?: string;
  summary?: string;
};

export type StartBaiyunRemoteReviewResult =
  | {
    allowed: true;
    budget: BaiyunSemanticReviewBudget;
    entry: BaiyunSemanticReviewEntry;
  }
  | {
    allowed: false;
    reason: 'duplicate' | 'budget_exhausted';
    budget: BaiyunSemanticReviewBudget;
    entry?: BaiyunSemanticReviewEntry;
  };

export function startBaiyunRemoteReview(
  input: StartBaiyunRemoteReviewInput,
): StartBaiyunRemoteReviewResult {
  const budget = normalizeBaiyunSemanticReviewBudget(
    input.budget,
    input.localDate,
    input.dailyLimit,
  );
  const budgetStillExhausted = budget.dailyLimit >= 0
    && budget.remoteAttemptsUsed >= budget.dailyLimit;
  const duplicate = budget.entries.find((entry) => (
    entry.fingerprint === input.fingerprint
    && (entry.outcome !== 'budget_blocked' || budgetStillExhausted)
  ));
  if (duplicate) {
    return { allowed: false, reason: 'duplicate', budget };
  }

  const baseEntry = {
    id: `semantic-review-${input.attemptedAt}-${budget.entries.length}`,
    fingerprint: input.fingerprint,
    currentMessageId: input.currentMessageId,
    attemptedAt: input.attemptedAt,
    ambiguityReasons: [...input.ambiguityReasons],
    connectionId: input.connectionId,
    connectionName: input.connectionName,
    model: input.model,
    summary: trimSummary(input.summary),
    signalKinds: [],
    confidences: [],
  } satisfies Omit<BaiyunSemanticReviewEntry, 'outcome'>;

  if (budget.dailyLimit >= 0 && budget.remoteAttemptsUsed >= budget.dailyLimit) {
    const entry: BaiyunSemanticReviewEntry = { ...baseEntry, outcome: 'budget_blocked' };
    return {
      allowed: false,
      reason: 'budget_exhausted',
      entry,
      budget: {
        ...budget,
        entries: [...budget.entries, entry].slice(-64),
      },
    };
  }

  const entry: BaiyunSemanticReviewEntry = { ...baseEntry, outcome: 'request_started' };
  return {
    allowed: true,
    entry,
    budget: {
      ...budget,
      remoteAttemptsUsed: budget.remoteAttemptsUsed + 1,
      entries: [...budget.entries, entry].slice(-64),
    },
  };
}

export function finishBaiyunRemoteReview(
  budget: BaiyunSemanticReviewBudget,
  entryId: string,
  outcome: Exclude<BaiyunSemanticReviewOutcome, 'request_started' | 'budget_blocked'>,
  details: {
    signalKinds?: readonly BaiyunSemanticSignalKind[];
    confidences?: readonly number[];
    durationMs?: number;
  } = {},
): BaiyunSemanticReviewBudget {
  return {
    ...budget,
    entries: budget.entries.map((entry) => (
      entry.id === entryId
        ? {
          ...entry,
          outcome,
          signalKinds: [...(details.signalKinds ?? [])],
          confidences: [...(details.confidences ?? [])],
          durationMs: details.durationMs,
        }
        : entry
    )),
  };
}
