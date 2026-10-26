import {
  activityObservationsEntityId,
  assertActivityObservationsRecord,
  type ActivityFocusTriggerRecord,
  type ActivityRuleEventStage,
  type ActivityRuleKind,
  type ActivityTriggerKind,
  type ActivityTriggerReason,
} from './syncActivityObservations';
import { loadCurrentSyncDevice } from './syncCurrentDevice';

export type ActivityFocusTriggerFactInput = {
  triggerId?: string;
  ruleId: string;
  ruleKind?: ActivityRuleKind;
  kind: ActivityTriggerKind;
  reason?: ActivityTriggerReason;
  eventStage?: ActivityRuleEventStage;
  appSource: string;
  appTitle: string;
  durationMs: number;
  stage: 1 | 2 | 3;
  triggeredAt?: number;
};

function normalizedRuleKind(input: ActivityFocusTriggerFactInput) {
  if (
    input.ruleKind === 'blacklist'
    || input.ruleKind === 'jealousy'
    || input.ruleKind === 'whitelist'
  ) {
    return input.ruleKind;
  }
  if (input.kind === 'jealousy') return 'jealousy';
  if (input.kind === 'whitelist') return 'whitelist';
  return 'blacklist';
}

function normalizedReason(input: ActivityFocusTriggerFactInput) {
  if (input.reason) return input.reason;
  if (input.kind === 'blacklist-return') return 'return';
  if (input.kind === 'jealousy') return 'jealousy';
  return 'unknown';
}

export async function captureActivityFocusTriggerFact(input: {
  trigger: ActivityFocusTriggerFactInput;
  outcome: 'message-sent' | 'observed';
  updatedAt?: number;
}) {
  const currentDevice = await loadCurrentSyncDevice();
  if (
    !currentDevice
    || currentDevice.identity.state !== 'active'
    || currentDevice.identity.revokedAt !== null
  ) {
    return { status: 'no-current-device' as const };
  }
  const updatedAt = input.updatedAt ?? Date.now();
  const triggeredAt = input.trigger.triggeredAt ?? updatedAt;
  const id = input.trigger.triggerId?.trim()
    || `${input.trigger.ruleId}:${input.trigger.kind}:${triggeredAt}`;
  const record: ActivityFocusTriggerRecord = {
    id,
    ruleId: input.trigger.ruleId,
    ruleKind: normalizedRuleKind(input.trigger),
    triggerKind: input.trigger.kind,
    reason: normalizedReason(input.trigger),
    eventStage: input.trigger.eventStage ?? null,
    appSource: input.trigger.appSource,
    appTitle: input.trigger.appTitle || input.trigger.appSource || 'unknown',
    durationMs: Math.max(0, Math.round(input.trigger.durationMs)),
    stage: input.trigger.stage,
    outcome: input.outcome,
    originDeviceId: currentDevice.identity.deviceId,
    originPlatform: currentDevice.identity.platform,
    sourceScope: 'origin-device',
    triggeredAt,
    updatedAt,
  };
  const entityId = activityObservationsEntityId(
    'activity-focus-trigger',
    record.id,
  );
  assertActivityObservationsRecord(
    'activity-focus-trigger',
    entityId,
    record,
  );
  const { getPhoneActivityDatabase } =
    await import('../phoneActivity/phoneActivityStore');
  const database = await getPhoneActivityDatabase();
  await database.runAsync(
    `INSERT INTO activity_focus_triggers (
       id, rule_id, rule_kind, trigger_kind, reason, event_stage,
       app_source, app_title, duration_ms, stage, outcome,
       origin_device_id, origin_platform, triggered_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       outcome = CASE
         WHEN activity_focus_triggers.outcome = 'message-sent'
         THEN 'message-sent'
         ELSE excluded.outcome
       END,
       updated_at = CASE
         WHEN activity_focus_triggers.outcome = 'message-sent'
              AND excluded.outcome = 'observed'
         THEN activity_focus_triggers.updated_at
         ELSE MAX(activity_focus_triggers.updated_at, excluded.updated_at)
       END
     WHERE activity_focus_triggers.outcome IS NOT excluded.outcome`,
    record.id,
    record.ruleId,
    record.ruleKind,
    record.triggerKind,
    record.reason,
    record.eventStage,
    record.appSource,
    record.appTitle,
    record.durationMs,
    record.stage,
    record.outcome,
    record.originDeviceId,
    record.originPlatform,
    record.triggeredAt,
    record.updatedAt,
  );
  return { status: 'captured' as const, entityId };
}
