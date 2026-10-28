import type {
  BaiyunActionIntentId,
  BaiyunRequiredBehaviorId,
} from './actionIntent';

export const BAIYUN_CONTINUITY_EVENT_KINDS = [
  'closeness_request',
  'relationship_rupture',
  'return_commitment',
  'proactive_intention',
  'care_process',
  'shared_task',
  'cross_day_life',
] as const;

export type BaiyunContinuityEventKind = typeof BAIYUN_CONTINUITY_EVENT_KINDS[number];

export const BAIYUN_CONTINUITY_EVENT_STATUSES = [
  'open',
  'waiting',
  'completed',
  'cancelled',
] as const;

export type BaiyunContinuityEventStatus = typeof BAIYUN_CONTINUITY_EVENT_STATUSES[number];

export const BAIYUN_CONTINUITY_EVENT_STAGES = {
  closeness_request: ['waiting_delivery'],
  relationship_rupture: [
    'rupture_detected',
    'retained',
    'paused_for_return',
    'returned',
    'repairing',
    'awaiting_confirmation',
  ],
  return_commitment: [
    'waiting_pause_delivery',
    'waiting_condition',
    'due',
    'waiting_return_delivery',
  ],
  proactive_intention: ['pending_expression', 'blocked'],
  care_process: [
    'signal_seen',
    'preparing_check',
    'reminded_or_interrupted',
    'awaiting_response',
    'follow_up_due',
    'intervention_paused',
  ],
  shared_task: ['waiting_shared_action', 'awaiting_shared_confirmation'],
  cross_day_life: ['recorded', 'follow_up_due', 'awaiting_response'],
} as const;

export type BaiyunContinuityEventStage =
  typeof BAIYUN_CONTINUITY_EVENT_STAGES[keyof typeof BAIYUN_CONTINUITY_EVENT_STAGES][number];

export type BaiyunContinuitySubject = 'I' | 'you';

const ORDINARY_REMINDER_CARE_SOURCE_PREFIXES = [
  'schedule-reminder:', 'schedule-companion:', 'todo-reminder:',
] as const;

/** Only the ordinary reminder producers use these source identities. */
export function isOrdinaryReminderCareSource(sourceId: string) {
  return ORDINARY_REMINDER_CARE_SOURCE_PREFIXES.some((prefix) => sourceId.startsWith(prefix));
}

/** Keep the original rows while excluding only these old automatic reminder cards. */
export function isOrdinaryReminderCareEvent(
  event: Pick<BaiyunContinuityEvent, 'schemaVersion' | 'kind' | 'source'>,
) {
  return event.schemaVersion === 2 && event.kind === 'care_process'
    && event.source.kind === 'real_care' && isOrdinaryReminderCareSource(event.source.sourceId);
}

export type BaiyunContinuityResumeCondition =
  | { kind: 'at_time'; dueAt: number }
  | { kind: 'after_duration'; dueAt: number; durationMs: number }
  | { kind: 'after_you_response'; sourceEventId?: string }
  | { kind: 'after_observed_change'; observationCode: string }
  | { kind: 'after_permission_restored'; permissionCode: string }
  | { kind: 'manual_resume' };

export const BAIYUN_CONTINUITY_EVIDENCE_KINDS = [
  'validated_action_content',
  'chat_message_persisted',
  'proactive_message_persisted',
  'return_message_persisted',
  'you_response_received',
  'you_confirmed_repair',
  'observed_relationship_repair',
  'you_confirmed_care_complete',
  'observed_care_recovery',
  'notification_dispatch_receipt',
  'ui_action_receipt',
  'tool_success_receipt',
  'device_success_receipt',
  'shared_task_progress',
  'scoped_shared_task_completion_receipt',
  'cross_day_follow_up_persisted',
  'you_explicit_progress',
  'you_explicit_completion',
  'you_explicit_cancellation',
  'manual_completion',
  'schedule_completion_receipt',
] as const;

export type BaiyunContinuityEvidenceKind = typeof BAIYUN_CONTINUITY_EVIDENCE_KINDS[number];

export type BaiyunContinuityEvidence = {
  id: string;
  kind: BaiyunContinuityEvidenceKind;
  sourceId: string;
  occurredAt: number;
  outcome: 'succeeded' | 'failed';
};

export type BaiyunContinuityCompletionRule = {
  allOf: readonly BaiyunContinuityEvidenceKind[];
  anyOf: readonly BaiyunContinuityEvidenceKind[];
};

export type BaiyunContinuityGlobalSource =
  | { kind: 'global_relationship'; sourceId: string }
  | { kind: 'real_care'; sourceId: string }
  | { kind: 'real_life'; sourceId: string }
  | { kind: 'real_tool_execution'; sourceId: string }
  | { kind: 'global_action_plan'; sourceId: string };

export type BaiyunContinuityEventSource =
  | BaiyunContinuityGlobalSource
  | { kind: 'bedtime_care'; sourceId: string }
  | { kind: 'theater'; sourceId: string; globalBasis?: BaiyunContinuityGlobalSource };

export type BaiyunContinuityEvent = {
  id: string;
  kind: BaiyunContinuityEventKind;
  status: BaiyunContinuityEventStatus;
  stage: BaiyunContinuityEventStage;
  subject: BaiyunContinuitySubject;
  returningSubject?: BaiyunContinuitySubject;
  /** Legacy schema 1 decoder only. New matters never carry action labels. */
  primaryIntent?: BaiyunActionIntentId;
  itemName?: string;
  progress?: BaiyunCareMatterProgress;
  durationMs?: number;
  careTimeSources?: BaiyunCareTimeSources;
  careEvidence?: BaiyunChatCareEvidence;
  parentEventId?: string;
  idempotencyKey: string;
  coalescingKey?: string;
  focusExcerpt?: string;
  source: BaiyunContinuityEventSource;
  occurredAt: number;
  occurredLocalDate: string;
  timezoneOffsetMinutes: number;
  nextActionAt?: number;
  resumeCondition?: BaiyunContinuityResumeCondition;
  requiredBehaviors?: readonly BaiyunRequiredBehaviorId[];
  completionRule: BaiyunContinuityCompletionRule;
  permissionRequirements: readonly string[];
  attemptCount: number;
  lastAttemptAt?: number;
  lastAttemptOutcome?: 'succeeded' | 'failed' | 'blocked';
  pauseReasonCode?: string;
  cancelledReason?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  cancelledAt?: number;
  revision: number;
  schemaVersion: 1 | 2 | 3;
};

export type BaiyunChatCareQuote = {
  sessionId: string;
  messageId: string;
  sentAt: number;
  quote: string;
};
export type BaiyunChatCareEvidence = {
  origin: BaiyunChatCareQuote;
  latest?: BaiyunChatCareQuote;
};

export type BaiyunCareMatterProgress = '未开始' | '进行中' | '稍后再做' | '暂停' | '完成' | '停止' | '准备休息';
export type BaiyunCareTimeSources = {
  duration?: { messageId: string; occurredAt: number };
  contact?: { messageId: string; occurredAt: number };
};

export type BaiyunContinuityEventPolicy = {
  kind: BaiyunContinuityEventKind;
  initialStatus: Extract<BaiyunContinuityEventStatus, 'open' | 'waiting'>;
  initialStage: BaiyunContinuityEventStage;
  allowedIntents: readonly BaiyunActionIntentId[];
  completionRule: BaiyunContinuityCompletionRule;
  defaultRequiredBehaviors: readonly BaiyunRequiredBehaviorId[];
};

export const BAIYUN_CONTINUITY_EVENT_POLICIES = {
  closeness_request: {
    kind: 'closeness_request',
    initialStatus: 'open',
    initialStage: 'waiting_delivery',
    allowedIntents: ['approach', 'affection', 'affirm_bond', 'desire', 'play', 'confide'],
    completionRule: {
      allOf: ['validated_action_content', 'chat_message_persisted'],
      anyOf: [],
    },
    defaultRequiredBehaviors: ['respond_with_concrete_presence'],
  },
  relationship_rupture: {
    kind: 'relationship_rupture',
    initialStatus: 'open',
    initialStage: 'rupture_detected',
    allowedIntents: ['retain', 'repair', 'rest_return'],
    completionRule: {
      allOf: [],
      anyOf: ['you_confirmed_repair', 'observed_relationship_repair'],
    },
    defaultRequiredBehaviors: ['directly_state_relationship_is_wanted', 'address_specific_hurt'],
  },
  return_commitment: {
    kind: 'return_commitment',
    initialStatus: 'waiting',
    initialStage: 'waiting_pause_delivery',
    allowedIntents: ['rest_return'],
    completionRule: {
      allOf: ['return_message_persisted'],
      anyOf: [],
    },
    defaultRequiredBehaviors: ['persist_return_condition', 'return_when_due'],
  },
  proactive_intention: {
    kind: 'proactive_intention',
    initialStatus: 'open',
    initialStage: 'pending_expression',
    allowedIntents: ['approach', 'affirm_bond', 'desire', 'share', 'confide', 'play'],
    completionRule: {
      allOf: ['proactive_message_persisted'],
      anyOf: [],
    },
    defaultRequiredBehaviors: ['send_longing_driven_contact'],
  },
  care_process: {
    kind: 'care_process',
    initialStatus: 'open',
    initialStage: 'signal_seen',
    allowedIntents: ['soothe', 'care_check', 'guide', 'interrupt', 'protect'],
    completionRule: {
      allOf: [],
      anyOf: ['you_confirmed_care_complete', 'observed_care_recovery'],
    },
    defaultRequiredBehaviors: ['communicate_continued_attention'],
  },
  shared_task: {
    kind: 'shared_task',
    initialStatus: 'open',
    initialStage: 'waiting_shared_action',
    allowedIntents: ['share', 'explore', 'collaborate'],
    completionRule: {
      allOf: ['validated_action_content', 'chat_message_persisted'],
      anyOf: [],
    },
    defaultRequiredBehaviors: ['advance_one_shared_task_step'],
  },
  cross_day_life: {
    kind: 'cross_day_life',
    initialStatus: 'waiting',
    initialStage: 'recorded',
    allowedIntents: ['care_check', 'share', 'explore', 'collaborate'],
    completionRule: {
      allOf: ['cross_day_follow_up_persisted'],
      anyOf: [],
    },
    defaultRequiredBehaviors: ['communicate_continued_attention'],
  },
} as const satisfies Readonly<Record<BaiyunContinuityEventKind, BaiyunContinuityEventPolicy>>;

type TransitionGraph = Readonly<Record<string, readonly BaiyunContinuityEventStage[]>>;

const BAIYUN_CONTINUITY_TRANSITIONS: Readonly<Record<BaiyunContinuityEventKind, TransitionGraph>> = {
  closeness_request: { waiting_delivery: [] },
  relationship_rupture: {
    rupture_detected: ['retained'],
    retained: ['paused_for_return', 'repairing'],
    paused_for_return: ['returned'],
    returned: ['repairing'],
    repairing: ['awaiting_confirmation'],
    awaiting_confirmation: ['repairing'],
  },
  return_commitment: {
    waiting_pause_delivery: ['waiting_condition'],
    waiting_condition: ['due'],
    due: ['waiting_return_delivery'],
    waiting_return_delivery: [],
  },
  proactive_intention: {
    pending_expression: ['blocked'],
    blocked: ['pending_expression'],
  },
  care_process: {
    signal_seen: ['preparing_check', 'intervention_paused'],
    preparing_check: ['reminded_or_interrupted', 'awaiting_response', 'intervention_paused'],
    reminded_or_interrupted: ['awaiting_response', 'intervention_paused'],
    awaiting_response: ['follow_up_due', 'intervention_paused'],
    follow_up_due: ['preparing_check', 'awaiting_response', 'intervention_paused'],
    intervention_paused: ['preparing_check', 'awaiting_response'],
  },
  shared_task: {
    waiting_shared_action: ['awaiting_shared_confirmation'],
    awaiting_shared_confirmation: ['waiting_shared_action'],
  },
  cross_day_life: {
    recorded: ['follow_up_due'],
    follow_up_due: ['awaiting_response'],
    awaiting_response: ['follow_up_due'],
  },
};

const TERMINAL_STATUSES = new Set<BaiyunContinuityEventStatus>(['completed', 'cancelled']);

function hasSuccessfulEvidence(
  evidence: readonly BaiyunContinuityEvidence[],
  kind: BaiyunContinuityEvidenceKind,
) {
  return evidence.some((item) => item.kind === kind && item.outcome === 'succeeded');
}

export function validateBaiyunContinuityEvent(event: BaiyunContinuityEvent) {
  const policy: BaiyunContinuityEventPolicy = BAIYUN_CONTINUITY_EVENT_POLICIES[event.kind];
  const stages = BAIYUN_CONTINUITY_EVENT_STAGES[event.kind] as readonly string[];
  if (!stages.includes(event.stage)) {
    throw new Error(`continuity_stage_not_allowed:${event.kind}:${event.stage}`);
  }
  if (event.schemaVersion === 1 && (!event.primaryIntent || !policy.allowedIntents.includes(event.primaryIntent))) {
    throw new Error(`continuity_intent_not_allowed:${event.kind}:${event.primaryIntent}`);
  }
  if (event.source.kind === 'theater' && !event.source.globalBasis) {
    throw new Error('continuity_theater_requires_global_basis');
  }
  if (!event.idempotencyKey.trim()) throw new Error('continuity_idempotency_key_required');
  if (
    event.focusExcerpt !== undefined
    && (!event.focusExcerpt.trim() || [...event.focusExcerpt].length > 60)
  ) {
    throw new Error('continuity_focus_excerpt_invalid');
  }
  if (event.kind === 'return_commitment') {
    if (event.schemaVersion === 1 && !event.parentEventId && event.source.kind !== 'global_action_plan') {
      throw new Error('continuity_standalone_return_requires_action_plan_source');
    }
    if (!event.returningSubject) throw new Error('continuity_return_subject_required');
    if (!event.resumeCondition) throw new Error('continuity_return_condition_required');
  }
  return event;
}

export function canTransitionBaiyunContinuityEvent(
  event: BaiyunContinuityEvent,
  nextStage: BaiyunContinuityEventStage,
) {
  if (TERMINAL_STATUSES.has(event.status)) return false;
  const allowed = BAIYUN_CONTINUITY_TRANSITIONS[event.kind][event.stage] ?? [];
  return allowed.includes(nextStage);
}

export function assertBaiyunContinuityTransition(
  event: BaiyunContinuityEvent,
  nextStage: BaiyunContinuityEventStage,
) {
  if (!canTransitionBaiyunContinuityEvent(event, nextStage)) {
    throw new Error(`continuity_transition_not_allowed:${event.kind}:${event.stage}:${nextStage}`);
  }
}

export function canCompleteBaiyunContinuityEvent(
  event: BaiyunContinuityEvent,
  evidence: readonly BaiyunContinuityEvidence[],
) {
  if (TERMINAL_STATUSES.has(event.status)) return false;
  if (
    hasSuccessfulEvidence(evidence, 'manual_completion')
    || hasSuccessfulEvidence(evidence, 'you_explicit_completion')
    || hasSuccessfulEvidence(evidence, 'schedule_completion_receipt')
  ) {
    return true;
  }
  const allSatisfied = event.completionRule.allOf.every((kind) => hasSuccessfulEvidence(evidence, kind));
  const anySatisfied = event.completionRule.anyOf.length === 0
    || event.completionRule.anyOf.some((kind) => hasSuccessfulEvidence(evidence, kind));
  if (!allSatisfied || !anySatisfied) return false;
  return event.kind !== 'relationship_rupture' || event.stage === 'awaiting_confirmation';
}

export const SHARED_TASK_CONFIRMATION_COMPLETION_RULE: BaiyunContinuityCompletionRule = {
  allOf: ['chat_message_persisted', 'scoped_shared_task_completion_receipt'],
  anyOf: [],
};

export function resolveBaiyunContinuityCompletionRule(input: {
  kind: BaiyunContinuityEventKind;
  primaryIntent: BaiyunActionIntentId;
  storedRule?: BaiyunContinuityCompletionRule;
  status?: BaiyunContinuityEventStatus;
}) {
  if (
    input.kind === 'shared_task'
    && (input.primaryIntent === 'explore' || input.primaryIntent === 'collaborate')
    && input.status !== 'completed'
    && input.status !== 'cancelled'
  ) {
    return SHARED_TASK_CONFIRMATION_COMPLETION_RULE;
  }
  return input.storedRule ?? BAIYUN_CONTINUITY_EVENT_POLICIES[input.kind].completionRule;
}

export type BaiyunContinuityTimingState = 'active' | 'waiting' | 'due' | 'completed' | 'cancelled';

export function deriveBaiyunContinuityTimingState(
  event: BaiyunContinuityEvent,
  now = Date.now(),
): BaiyunContinuityTimingState {
  if (event.status === 'completed' || event.status === 'cancelled') return event.status;
  if (event.stage === 'due' || event.stage === 'follow_up_due') return 'due';
  if (event.nextActionAt !== undefined && event.nextActionAt <= now) return 'due';
  if (event.status === 'waiting' || event.nextActionAt !== undefined) return 'waiting';
  return 'active';
}

export function buildBaiyunContinuityEvent(input: {
  id: string;
  kind: BaiyunContinuityEventKind;
  subject: BaiyunContinuitySubject;
  primaryIntent?: BaiyunActionIntentId;
  itemName?: string;
  idempotencyKey: string;
  source: BaiyunContinuityEventSource;
  occurredAt: number;
  occurredLocalDate: string;
  timezoneOffsetMinutes: number;
  parentEventId?: string;
  returningSubject?: BaiyunContinuitySubject;
  coalescingKey?: string;
  focusExcerpt?: string;
  nextActionAt?: number;
  resumeCondition?: BaiyunContinuityResumeCondition;
  requiredBehaviors?: readonly BaiyunRequiredBehaviorId[];
  permissionRequirements?: readonly string[];
}): BaiyunContinuityEvent {
  const policy: BaiyunContinuityEventPolicy = BAIYUN_CONTINUITY_EVENT_POLICIES[input.kind];
  return validateBaiyunContinuityEvent({
    id: input.id,
    kind: input.kind,
    status: policy.initialStatus,
    stage: policy.initialStage,
    subject: input.subject,
    returningSubject: input.returningSubject,
    itemName: input.itemName,
    parentEventId: input.parentEventId,
    idempotencyKey: input.idempotencyKey,
    coalescingKey: input.coalescingKey,
    focusExcerpt: input.focusExcerpt,
    source: input.source,
    occurredAt: input.occurredAt,
    occurredLocalDate: input.occurredLocalDate,
    timezoneOffsetMinutes: input.timezoneOffsetMinutes,
    nextActionAt: input.nextActionAt,
    resumeCondition: input.resumeCondition,
    completionRule: input.kind === 'shared_task' ? SHARED_TASK_CONFIRMATION_COMPLETION_RULE : policy.completionRule,
    permissionRequirements: input.permissionRequirements ?? [],
    attemptCount: 0,
    createdAt: input.occurredAt,
    updatedAt: input.occurredAt,
    revision: 1,
    schemaVersion: 2,
  });
}
