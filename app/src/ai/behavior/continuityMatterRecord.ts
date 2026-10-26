import { SHARED_TASK_CONFIRMATION_COMPLETION_RULE } from './continuityEvent';
/** The schema upgrade changes the business projection, never the signed history. */
export const CONTINUITY_MATTER_UPGRADE_FIELDS = {
  primary_intent: null, required_behaviors_json: null,
  item_name: null, progress: null, duration_ms: null, care_time_sources_json: null,
  schema_version: 2,
} as const;

export function canonicalizeContinuityMatterRecord<T extends Record<string, unknown>>(record: T): T {
  if (record.schema_version !== 1) return record;
  let completionRule = record.completion_rule_json;
  if (record.kind === 'shared_task' && ['open', 'waiting'].includes(String(record.status))) {
    const rule = JSON.parse(String(completionRule)) as { allOf: string[]; anyOf: string[] };
    if ([...rule.allOf, ...rule.anyOf].includes('validated_action_content')) completionRule = JSON.stringify(SHARED_TASK_CONFIRMATION_COMPLETION_RULE);
  }
  return { ...record, focus_excerpt: record.focus_excerpt ?? null, ...CONTINUITY_MATTER_UPGRADE_FIELDS, completion_rule_json: completionRule };
}

export function isRetiredContinuityCard(record: Record<string, unknown>) {
  return record.schema_version === 1 && (
    String(record.idempotency_key).startsWith('continuity-acceptance:')
    || [
      'continuity-event-msxav0jd-jppp8k6q', 'continuity-event-msxaw6r3-huijr9ar',
      'continuity-event-msxcf3a4-sltteyiq', 'continuity-event-mszswy5d-a3okgpcu',
      'continuity-event-mt61t8im-knh3x4cv', 'continuity-event-mt79ldck-sx0jj3l8',
    ].includes(String(record.id))
    || (['closeness_request', 'proactive_intention'].includes(String(record.kind))
      && !['real_care', 'real_tool_execution'].includes(String(record.source_kind)))
  );
}

export function legacyContinuityMatterNeedsEvidence(record: Record<string, unknown>) {
  return record.schema_version === 1 && record.source_kind === 'global_action_plan';
}

export const CONTINUITY_MATTER_REAL_EVIDENCE = [
  'chat_message_persisted', 'proactive_message_persisted', 'return_message_persisted',
  'tool_success_receipt', 'device_success_receipt', 'notification_dispatch_receipt', 'schedule_completion_receipt',
] as const;
