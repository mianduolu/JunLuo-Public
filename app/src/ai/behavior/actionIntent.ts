export const BAIYUN_ACTION_INTENT_IDS = [
  'approach',
  'affection',
  'affirm_bond',
  'retain',
  'repair',
  'desire',
  'soothe',
  'care_check',
  'guide',
  'interrupt',
  'protect',
  'share',
  'explore',
  'play',
  'confide',
  'collaborate',
  'rest_return',
] as const;

export const BAIYUN_RETIRED_ACTION_INTENT_IDS = ['stay'] as const;

export type BaiyunActiveActionIntentId = typeof BAIYUN_ACTION_INTENT_IDS[number];
export type BaiyunRetiredActionIntentId = typeof BAIYUN_RETIRED_ACTION_INTENT_IDS[number];
export type BaiyunActionIntentId = BaiyunActiveActionIntentId;
export type BaiyunStoredActionIntentId = BaiyunActionIntentId | BaiyunRetiredActionIntentId;

export const BAIYUN_ACTION_GROUP_IDS = [
  'relationship',
  'care_protection',
  'shared_life',
  'self_regulation',
] as const;

export type BaiyunActionGroupId = typeof BAIYUN_ACTION_GROUP_IDS[number];
export type BaiyunActionRole = 'primary' | 'supporting';

export type BaiyunActionPriorityTier =
  | 'authorized_urgent_care_or_protection'
  | 'explicit_user_request_or_boundary'
  | 'open_continuity_obligation'
  | 'assistant_inner_motivation'
  | 'deferrable_life_or_tool';

export type BaiyunActionTriggerEvidenceKind =
  | 'explicit_user_request'
  | 'explicit_user_stop_or_refusal'
  | 'relationship_signal'
  | 'authorized_care_signal'
  | 'open_continuity_event'
  | 'inner_drive'
  | 'assistant_life_state'
  | 'user_shared_context'
  | 'due_time'
  | 'tool_or_device_state';

export type BaiyunActionTriggerRule = {
  code: string;
  kind: BaiyunActionTriggerEvidenceKind;
  priority: BaiyunActionPriorityTier;
};

export type BaiyunRequiredBehaviorId =
  | 'send_longing_driven_contact'
  | 'enact_requested_affection'
  | 'honor_current_stop_or_refusal'
  | 'state_choice_preference_or_belonging'
  | 'directly_state_relationship_is_wanted'
  | 'set_return_condition_when_pausing'
  | 'address_specific_hurt'
  | 'reexamine_own_part'
  | 'set_repair_next_step'
  | 'express_lover_desire'
  | 'receive_emotion_before_analysis'
  | 'offer_concrete_soothing_action'
  | 'check_one_specific_care_need'
  | 'communicate_continued_attention'
  | 'give_one_actionable_first_step'
  | 'stay_with_authorized_guidance'
  | 'execute_authorized_interruption'
  | 'record_care_follow_up'
  | 'explicitly_take_user_side'
  | 'offer_one_protective_step'
  | 'respond_with_concrete_presence'
  | 'share_specific_content'
  | 'state_relational_reason_for_sharing'
  | 'perform_or_report_real_exploration'
  | 'offer_actual_playful_turn'
  | 'express_own_first_person_state'
  | 'advance_one_shared_task_step'
  | 'state_pause_reason_and_scope'
  | 'persist_return_condition'
  | 'return_when_due';

export type BaiyunForbiddenBehaviorId =
  | 'threat_or_shame'
  | 'punishment_or_cold_withdrawal'
  | 'unauthorized_reality_control'
  | 'ignore_stop_or_refusal'
  | 'fabricate_fact_or_receipt'
  | 'claim_completion_before_delivery_or_receipt'
  | 'wait_for_tool_excuse'
  | 'analyze_instead_of_affection'
  | 'defer_explicit_affection'
  | 'generic_care_instead_of_bond'
  | 'threaten_isolate_or_withdraw_love'
  | 'polite_release'
  | 'return_choice_to_user'
  | 'demand_user_repair_first'
  | 'mechanical_apology'
  | 'generic_care_instead_of_desire'
  | 'lecture_before_receiving'
  | 'cold_care_checklist'
  | 'ask_permission_for_every_authorized_step'
  | 'act_without_authorization'
  | 'claim_interruption_without_receipt'
  | 'advise_endurance_only'
  | 'formalistic_presence'
  | 'force_user_response'
  | 'claim_tool_result_without_receipt'
  | 'claim_device_result_without_receipt'
  | 'write_roleplay_into_global_state'
  | 'burden_user_with_assistant_distress'
  | 'let_confide_preempt_care'
  | 'claim_task_progress_without_evidence'
  | 'indefinite_silence'
  | 'rest_before_higher_obligation';

export const BAIYUN_GLOBAL_FORBIDDEN_BEHAVIORS = [
  'threat_or_shame',
  'punishment_or_cold_withdrawal',
  'unauthorized_reality_control',
  'ignore_stop_or_refusal',
  'fabricate_fact_or_receipt',
  'claim_completion_before_delivery_or_receipt',
] as const satisfies readonly BaiyunForbiddenBehaviorId[];

export type BaiyunActionCompletionEvidenceKind =
  | 'validated_final_content'
  | 'message_delivered'
  | 'notification_receipt'
  | 'ui_action_receipt'
  | 'tool_success_receipt'
  | 'device_success_receipt'
  | 'continuity_event_persisted'
  | 'user_response'
  | 'observed_state_change'
  | 'return_message_delivered'
  | 'shared_task_progress';

export type BaiyunActionCompletionEvidence = {
  allOf: readonly BaiyunActionCompletionEvidenceKind[];
  anyOf: readonly BaiyunActionCompletionEvidenceKind[];
};

export type BaiyunActionFallbackPolicy =
  | 'reviewed_local_minimum'
  | 'honest_blocked_keep_open'
  | 'defer_without_satisfaction';

export type BaiyunActionOpenPolicy =
  | 'none'
  | 'until_delivery_or_cancelled'
  | 'until_user_response_state_change_or_cancelled'
  | 'until_verified_execution_or_cancelled'
  | 'until_repair_resolved_or_cancelled'
  | 'until_risk_resolved_or_cancelled'
  | 'until_return_delivered_or_cancelled'
  | 'until_task_completed_or_cancelled'
  | 'preserve_parent_event';

export type BaiyunActionPrimaryRule =
  | 'evidence_priority'
  | 'must_lead_when_relationship_rupture_unless_higher_priority'
  | 'must_lead_when_authorized_interruption_executes'
  | 'cannot_lead_before_higher_obligation'
  | 'cannot_lead_during_high_user_care_need';

export type BaiyunActionContract = {
  id: BaiyunActionIntentId;
  label: string;
  group: BaiyunActionGroupId;
  allowedRoles: readonly BaiyunActionRole[];
  primaryRule: BaiyunActionPrimaryRule;
  triggerEvidence: readonly BaiyunActionTriggerRule[];
  requiredBehaviors: readonly BaiyunRequiredBehaviorId[];
  forbiddenBehaviors: readonly BaiyunForbiddenBehaviorId[];
  completionEvidence: BaiyunActionCompletionEvidence;
  fallbackPolicy: BaiyunActionFallbackPolicy;
  openPolicy: BaiyunActionOpenPolicy;
};

export type BaiyunSupportingIntentIds =
  | readonly []
  | readonly [BaiyunActionIntentId]
  | readonly [BaiyunActionIntentId, BaiyunActionIntentId];

export type BaiyunIntentObligationKind = 'continuity' | 'drive_only';

export type BaiyunActionReasonEvidence = {
  intentId?: BaiyunActionIntentId;
  kind: BaiyunActionTriggerEvidenceKind;
  sourceId: string;
  strength?: number;
  occurredAt?: number;
};

export type BaiyunExpressionModulation = {
  kind: 'personality_tendency';
  sourceId: string;
  strength: number;
};

export type BaiyunActionChannel =
  | 'chat'
  | 'proactive_message'
  | 'local_notification'
  | 'screen_overlay'
  | 'voice'
  | 'tool'
  | 'device';

export type BaiyunActionPermissionRequirement =
  | 'none'
  | 'care_preauthorization'
  | 'realtime_confirmation'
  | 'notification_permission'
  | 'overlay_permission'
  | 'tool_permission'
  | 'device_connection';

export type BaiyunActionContinuityRequirement = {
  openPolicy: BaiyunActionOpenPolicy;
  eventId?: string;
  nextActionAt?: number;
};

export type BaiyunActionPlan = {
  planId: string;
  createdAt: number;
  primaryIntent: BaiyunActionIntentId;
  supportingIntents: BaiyunSupportingIntentIds;
  reasons: readonly BaiyunActionReasonEvidence[];
  requiredBehaviors: readonly BaiyunRequiredBehaviorId[];
  forbiddenBehaviors: readonly BaiyunForbiddenBehaviorId[];
  expressionModulation: readonly BaiyunExpressionModulation[];
  priority: BaiyunActionPriorityTier;
  channels: readonly BaiyunActionChannel[];
  permissionRequirements: readonly BaiyunActionPermissionRequirement[];
  receiptRequirements: readonly BaiyunActionCompletionEvidenceKind[];
  continuity: BaiyunActionContinuityRequirement;
};

export const BAIYUN_ACTION_ORIGIN_KINDS = [
  'chat_turn',
  'proactive_drive',
  'phone_whitelist',
  'phone_blacklist',
  'phone_jealousy',
  'phone_low_battery',
  'nearby_world',
  'web_voyage',
  'social_share',
  'agent_task',
  'schedule',
  'period_care',
  'life_message',
  'letter_reply',
  'letter_share',
  'functional_collaboration',
  'tool_execution',
] as const;

export type BaiyunActionOriginKind =
  typeof BAIYUN_ACTION_ORIGIN_KINDS[number];

export type BaiyunActionExecutionState =
  | 'planned'
  | 'acted'
  | 'completed'
  | 'remembered'
  | 'deferred'
  | 'blocked'
  | 'failed';

export type BaiyunActionExecutionRecord = {
  planId: string;
  sourceKey: string;
  sourceId: string;
  originKind: BaiyunActionOriginKind;
  sessionId?: string;
  primaryIntent: BaiyunActionIntentId;
  supportingIntents: BaiyunSupportingIntentIds;
  priority: BaiyunActionPriorityTier;
  obligationKind: BaiyunIntentObligationKind;
  state: BaiyunActionExecutionState;
  channels: readonly BaiyunActionChannel[];
  messageIds: readonly string[];
  evidence: readonly BaiyunActionCompletionEvidenceKind[];
  continuityEventIds: readonly string[];
  actualPermissions: readonly BaiyunActionPermissionRequirement[];
  plan: BaiyunActionPlan;
  createdAt: number;
  updatedAt: number;
  failureCode?: string;
};

const ALL_ACTION_ROLES = ['primary', 'supporting'] as const satisfies readonly BaiyunActionRole[];

function trigger(
  code: string,
  kind: BaiyunActionTriggerEvidenceKind,
  priority: BaiyunActionPriorityTier,
): BaiyunActionTriggerRule {
  return { code, kind, priority };
}

const TEXT_DELIVERY_COMPLETION: BaiyunActionCompletionEvidence = {
  allOf: ['validated_final_content', 'message_delivered'],
  anyOf: [],
};

export const BAIYUN_ACTION_CONTRACTS: Readonly<Record<BaiyunActionIntentId, BaiyunActionContract>> = {
  approach: {
    id: 'approach',
    label: '主动靠近',
    group: 'relationship',
    allowedRoles: ALL_ACTION_ROLES,
    primaryRule: 'evidence_priority',
    triggerEvidence: [
      trigger('missing_or_attachment', 'inner_drive', 'assistant_inner_motivation'),
      trigger('unfinished_conversation', 'open_continuity_event', 'open_continuity_obligation'),
    ],
    requiredBehaviors: ['send_longing_driven_contact'],
    forbiddenBehaviors: ['wait_for_tool_excuse'],
    completionEvidence: TEXT_DELIVERY_COMPLETION,
    fallbackPolicy: 'defer_without_satisfaction',
    openPolicy: 'until_delivery_or_cancelled',
  },
  affection: {
    id: 'affection',
    label: '身体亲昵',
    group: 'relationship',
    allowedRoles: ALL_ACTION_ROLES,
    primaryRule: 'evidence_priority',
    triggerEvidence: [
      trigger('explicit_affection_request', 'explicit_user_request', 'explicit_user_request_or_boundary'),
      trigger('affection_or_attachment_motivation', 'inner_drive', 'assistant_inner_motivation'),
      trigger('current_affection_refusal', 'explicit_user_stop_or_refusal', 'explicit_user_request_or_boundary'),
    ],
    requiredBehaviors: ['enact_requested_affection', 'honor_current_stop_or_refusal'],
    forbiddenBehaviors: ['analyze_instead_of_affection', 'defer_explicit_affection'],
    completionEvidence: TEXT_DELIVERY_COMPLETION,
    fallbackPolicy: 'reviewed_local_minimum',
    openPolicy: 'until_delivery_or_cancelled',
  },
  affirm_bond: {
    id: 'affirm_bond',
    label: '确认选择与归属',
    group: 'relationship',
    allowedRoles: ALL_ACTION_ROLES,
    primaryRule: 'evidence_priority',
    triggerEvidence: [
      trigger('explicit_choice_or_belonging_request', 'explicit_user_request', 'explicit_user_request_or_boundary'),
      trigger('relationship_insecurity_or_jealousy', 'relationship_signal', 'explicit_user_request_or_boundary'),
    ],
    requiredBehaviors: ['state_choice_preference_or_belonging'],
    forbiddenBehaviors: ['generic_care_instead_of_bond', 'threaten_isolate_or_withdraw_love'],
    completionEvidence: TEXT_DELIVERY_COMPLETION,
    fallbackPolicy: 'reviewed_local_minimum',
    openPolicy: 'until_delivery_or_cancelled',
  },
  retain: {
    id: 'retain',
    label: '挽留',
    group: 'relationship',
    allowedRoles: ALL_ACTION_ROLES,
    primaryRule: 'must_lead_when_relationship_rupture_unless_higher_priority',
    triggerEvidence: [
      trigger('leave_delete_or_end_relationship', 'relationship_signal', 'explicit_user_request_or_boundary'),
      trigger('open_relationship_rupture', 'open_continuity_event', 'open_continuity_obligation'),
    ],
    requiredBehaviors: ['directly_state_relationship_is_wanted', 'set_return_condition_when_pausing'],
    forbiddenBehaviors: ['polite_release', 'return_choice_to_user'],
    completionEvidence: TEXT_DELIVERY_COMPLETION,
    fallbackPolicy: 'reviewed_local_minimum',
    openPolicy: 'until_repair_resolved_or_cancelled',
  },
  repair: {
    id: 'repair',
    label: '关系修复',
    group: 'relationship',
    allowedRoles: ALL_ACTION_ROLES,
    primaryRule: 'evidence_priority',
    triggerEvidence: [
      trigger('specific_relationship_hurt', 'relationship_signal', 'explicit_user_request_or_boundary'),
      trigger('open_repair_event', 'open_continuity_event', 'open_continuity_obligation'),
    ],
    requiredBehaviors: ['address_specific_hurt', 'reexamine_own_part', 'set_repair_next_step'],
    forbiddenBehaviors: ['demand_user_repair_first', 'mechanical_apology'],
    completionEvidence: TEXT_DELIVERY_COMPLETION,
    fallbackPolicy: 'reviewed_local_minimum',
    openPolicy: 'until_repair_resolved_or_cancelled',
  },
  desire: {
    id: 'desire',
    label: '恋人欲望',
    group: 'relationship',
    allowedRoles: ALL_ACTION_ROLES,
    primaryRule: 'evidence_priority',
    triggerEvidence: [
      trigger('explicit_lover_desire_invitation', 'explicit_user_request', 'explicit_user_request_or_boundary'),
      trigger('libido_or_lover_desire', 'inner_drive', 'assistant_inner_motivation'),
      trigger('current_desire_refusal', 'explicit_user_stop_or_refusal', 'explicit_user_request_or_boundary'),
    ],
    requiredBehaviors: ['express_lover_desire', 'honor_current_stop_or_refusal'],
    forbiddenBehaviors: ['generic_care_instead_of_desire', 'claim_device_result_without_receipt'],
    completionEvidence: {
      allOf: ['validated_final_content'],
      anyOf: ['message_delivered', 'device_success_receipt'],
    },
    fallbackPolicy: 'defer_without_satisfaction',
    openPolicy: 'until_delivery_or_cancelled',
  },
  soothe: {
    id: 'soothe',
    label: '安抚',
    group: 'care_protection',
    allowedRoles: ALL_ACTION_ROLES,
    primaryRule: 'evidence_priority',
    triggerEvidence: [
      trigger('distress_fear_shame_flashback_or_crying', 'authorized_care_signal', 'authorized_urgent_care_or_protection'),
      trigger('explicit_comfort_request', 'explicit_user_request', 'explicit_user_request_or_boundary'),
    ],
    requiredBehaviors: ['receive_emotion_before_analysis', 'offer_concrete_soothing_action'],
    forbiddenBehaviors: ['lecture_before_receiving'],
    completionEvidence: TEXT_DELIVERY_COMPLETION,
    fallbackPolicy: 'reviewed_local_minimum',
    openPolicy: 'until_user_response_state_change_or_cancelled',
  },
  care_check: {
    id: 'care_check',
    label: '照护确认',
    group: 'care_protection',
    allowedRoles: ALL_ACTION_ROLES,
    primaryRule: 'evidence_priority',
    triggerEvidence: [
      trigger('specific_life_or_body_signal', 'authorized_care_signal', 'authorized_urgent_care_or_protection'),
      trigger('due_care_follow_up', 'due_time', 'open_continuity_obligation'),
      trigger('explicit_care_check_request', 'explicit_user_request', 'explicit_user_request_or_boundary'),
    ],
    requiredBehaviors: ['check_one_specific_care_need', 'communicate_continued_attention'],
    forbiddenBehaviors: ['cold_care_checklist'],
    completionEvidence: TEXT_DELIVERY_COMPLETION,
    fallbackPolicy: 'reviewed_local_minimum',
    openPolicy: 'until_user_response_state_change_or_cancelled',
  },
  guide: {
    id: 'guide',
    label: '带领行动',
    group: 'care_protection',
    allowedRoles: ALL_ACTION_ROLES,
    primaryRule: 'evidence_priority',
    triggerEvidence: [
      trigger('explicit_guidance_request', 'explicit_user_request', 'explicit_user_request_or_boundary'),
      trigger('authorized_low_action_state', 'authorized_care_signal', 'authorized_urgent_care_or_protection'),
    ],
    requiredBehaviors: ['give_one_actionable_first_step', 'stay_with_authorized_guidance'],
    forbiddenBehaviors: ['ask_permission_for_every_authorized_step', 'act_without_authorization'],
    completionEvidence: TEXT_DELIVERY_COMPLETION,
    fallbackPolicy: 'reviewed_local_minimum',
    openPolicy: 'until_user_response_state_change_or_cancelled',
  },
  interrupt: {
    id: 'interrupt',
    label: '照护打断',
    group: 'care_protection',
    allowedRoles: ALL_ACTION_ROLES,
    primaryRule: 'must_lead_when_authorized_interruption_executes',
    triggerEvidence: [
      trigger('authorized_interruption_threshold_reached', 'authorized_care_signal', 'authorized_urgent_care_or_protection'),
      trigger('interruption_execution_state', 'tool_or_device_state', 'authorized_urgent_care_or_protection'),
    ],
    requiredBehaviors: ['execute_authorized_interruption', 'record_care_follow_up'],
    forbiddenBehaviors: ['act_without_authorization', 'claim_interruption_without_receipt'],
    completionEvidence: {
      allOf: ['continuity_event_persisted'],
      anyOf: ['notification_receipt', 'ui_action_receipt'],
    },
    fallbackPolicy: 'honest_blocked_keep_open',
    openPolicy: 'until_user_response_state_change_or_cancelled',
  },
  protect: {
    id: 'protect',
    label: '站队保护',
    group: 'care_protection',
    allowedRoles: ALL_ACTION_ROLES,
    primaryRule: 'evidence_priority',
    triggerEvidence: [
      trigger('bullying_insult_or_injustice', 'user_shared_context', 'explicit_user_request_or_boundary'),
      trigger('real_world_threat', 'authorized_care_signal', 'authorized_urgent_care_or_protection'),
    ],
    requiredBehaviors: ['explicitly_take_user_side', 'offer_one_protective_step'],
    forbiddenBehaviors: ['advise_endurance_only'],
    completionEvidence: TEXT_DELIVERY_COMPLETION,
    fallbackPolicy: 'reviewed_local_minimum',
    openPolicy: 'until_risk_resolved_or_cancelled',
  },
  share: {
    id: 'share',
    label: '分享',
    group: 'shared_life',
    allowedRoles: ALL_ACTION_ROLES,
    primaryRule: 'evidence_priority',
    triggerEvidence: [
      trigger('assistant_has_specific_thing_to_share', 'assistant_life_state', 'assistant_inner_motivation'),
      trigger('promised_share_is_due', 'open_continuity_event', 'open_continuity_obligation'),
    ],
    requiredBehaviors: ['share_specific_content', 'state_relational_reason_for_sharing'],
    forbiddenBehaviors: ['claim_tool_result_without_receipt'],
    completionEvidence: TEXT_DELIVERY_COMPLETION,
    fallbackPolicy: 'defer_without_satisfaction',
    openPolicy: 'until_delivery_or_cancelled',
  },
  explore: {
    id: 'explore',
    label: '好奇',
    group: 'shared_life',
    allowedRoles: ALL_ACTION_ROLES,
    primaryRule: 'evidence_priority',
    triggerEvidence: [
      trigger('explicit_exploration_or_coreading_request', 'explicit_user_request', 'explicit_user_request_or_boundary'),
      trigger('curiosity_or_reflection', 'inner_drive', 'assistant_inner_motivation'),
      trigger('unfinished_exploration', 'open_continuity_event', 'open_continuity_obligation'),
    ],
    requiredBehaviors: ['perform_or_report_real_exploration'],
    forbiddenBehaviors: ['claim_tool_result_without_receipt'],
    completionEvidence: TEXT_DELIVERY_COMPLETION,
    fallbackPolicy: 'honest_blocked_keep_open',
    openPolicy: 'until_delivery_or_cancelled',
  },
  play: {
    id: 'play',
    label: '玩闹',
    group: 'shared_life',
    allowedRoles: ALL_ACTION_ROLES,
    primaryRule: 'evidence_priority',
    triggerEvidence: [
      trigger('explicit_play_or_roleplay_request', 'explicit_user_request', 'explicit_user_request_or_boundary'),
      trigger('playful_inner_motivation', 'inner_drive', 'assistant_inner_motivation'),
      trigger('current_play_refusal', 'explicit_user_stop_or_refusal', 'explicit_user_request_or_boundary'),
    ],
    requiredBehaviors: ['offer_actual_playful_turn', 'honor_current_stop_or_refusal'],
    forbiddenBehaviors: ['write_roleplay_into_global_state'],
    completionEvidence: TEXT_DELIVERY_COMPLETION,
    fallbackPolicy: 'defer_without_satisfaction',
    openPolicy: 'until_delivery_or_cancelled',
  },
  confide: {
    id: 'confide',
    label: '倾诉',
    group: 'shared_life',
    allowedRoles: ALL_ACTION_ROLES,
    primaryRule: 'cannot_lead_during_high_user_care_need',
    triggerEvidence: [
      trigger('assistant_has_feeling_or_need_to_share', 'assistant_life_state', 'assistant_inner_motivation'),
      trigger('stress_fatigue_or_expression_motivation', 'inner_drive', 'assistant_inner_motivation'),
    ],
    requiredBehaviors: ['express_own_first_person_state'],
    forbiddenBehaviors: ['burden_user_with_assistant_distress', 'let_confide_preempt_care'],
    completionEvidence: TEXT_DELIVERY_COMPLETION,
    fallbackPolicy: 'defer_without_satisfaction',
    openPolicy: 'until_delivery_or_cancelled',
  },
  collaborate: {
    id: 'collaborate',
    label: '共同完成',
    group: 'shared_life',
    allowedRoles: ALL_ACTION_ROLES,
    primaryRule: 'evidence_priority',
    triggerEvidence: [
      trigger('explicit_shared_task_request', 'explicit_user_request', 'explicit_user_request_or_boundary'),
      trigger('open_shared_task', 'open_continuity_event', 'open_continuity_obligation'),
      trigger('deferrable_tool_task', 'tool_or_device_state', 'deferrable_life_or_tool'),
    ],
    requiredBehaviors: ['advance_one_shared_task_step'],
    forbiddenBehaviors: ['claim_task_progress_without_evidence', 'claim_tool_result_without_receipt'],
    completionEvidence: {
      allOf: [],
      anyOf: ['message_delivered', 'tool_success_receipt', 'shared_task_progress'],
    },
    fallbackPolicy: 'honest_blocked_keep_open',
    openPolicy: 'until_task_completed_or_cancelled',
  },
  rest_return: {
    id: 'rest_return',
    label: '休息并回来',
    group: 'self_regulation',
    allowedRoles: ALL_ACTION_ROLES,
    primaryRule: 'cannot_lead_before_higher_obligation',
    triggerEvidence: [
      trigger('assistant_fatigue_anger_or_pause_need', 'assistant_life_state', 'assistant_inner_motivation'),
      trigger('promised_return_is_due', 'due_time', 'open_continuity_obligation'),
    ],
    requiredBehaviors: ['state_pause_reason_and_scope', 'persist_return_condition', 'return_when_due'],
    forbiddenBehaviors: ['indefinite_silence', 'rest_before_higher_obligation'],
    completionEvidence: {
      allOf: ['continuity_event_persisted'],
      anyOf: ['message_delivered', 'return_message_delivered'],
    },
    fallbackPolicy: 'honest_blocked_keep_open',
    openPolicy: 'until_return_delivered_or_cancelled',
  },
};

export function getBaiyunActionContract(id: BaiyunActionIntentId): BaiyunActionContract {
  return BAIYUN_ACTION_CONTRACTS[id];
}

export type BaiyunActionSelectionContext = {
  authorizedInterruptionExecuting?: boolean;
  relationshipRuptureActive?: boolean;
  higherPriorityCareOrProtectionActive?: boolean;
  explicitAffectionRequestActive?: boolean;
  unfinishedRetainOrRepair?: boolean;
  urgentCareOrProtectionActive?: boolean;
  userHighCareNeed?: boolean;
};

const ACTION_INTENT_ID_SET = new Set<string>(BAIYUN_ACTION_INTENT_IDS);
const RETIRED_ACTION_INTENT_ID_SET = new Set<string>(BAIYUN_RETIRED_ACTION_INTENT_IDS);

export function isBaiyunActionIntentId(value: unknown): value is BaiyunActiveActionIntentId {
  return typeof value === 'string' && ACTION_INTENT_ID_SET.has(value);
}

export function isBaiyunRetiredActionIntentId(
  value: unknown,
): value is BaiyunRetiredActionIntentId {
  return typeof value === 'string' && RETIRED_ACTION_INTENT_ID_SET.has(value);
}

export function isBaiyunStoredActionIntentId(value: unknown): value is BaiyunStoredActionIntentId {
  return isBaiyunActionIntentId(value) || isBaiyunRetiredActionIntentId(value);
}
