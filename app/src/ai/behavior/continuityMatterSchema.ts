import { MEMORY_RECORDS_AUXILIARY_TABLE_SCHEMA_SQL } from '../../sync/syncMemoryRecordsSql';
import { CONTINUITY_MATTER_UPGRADE_FIELDS } from './continuityMatterRecord';
import { SHARED_TASK_CONFIRMATION_COMPLETION_RULE } from './continuityEvent';

/** Runs during database initialization, before capture triggers are installed. */
export function buildContinuityMatterUpgradeSql(existingColumns: readonly string[]) {
  if (existingColumns.includes('care_time_sources_json')) {
    return existingColumns.includes('care_evidence_json')
      ? ''
      : 'ALTER TABLE continuity_events ADD COLUMN care_evidence_json TEXT;';
  }
  const declaration = MEMORY_RECORDS_AUXILIARY_TABLE_SCHEMA_SQL.match(
    /CREATE TABLE IF NOT EXISTS continuity_events \([\s\S]*?\n\);/,
  )![0].replace('IF NOT EXISTS continuity_events', 'continuity_events_v2');
  const upgradedFields = Object.keys(CONTINUITY_MATTER_UPGRADE_FIELDS);
  const retainedColumns = existingColumns.filter((column) => !upgradedFields.includes(column));
  if (retainedColumns.some((column) => !/^[a-z_]+$/.test(column))) {
    throw new Error('continuity_schema_column_invalid');
  }
  const selectedColumns = retainedColumns.map(column => column === 'completion_rule_json'
    ? `CASE WHEN schema_version = 1 AND kind = 'shared_task' AND status IN ('open', 'waiting')
      AND EXISTS (SELECT 1 FROM json_tree(completion_rule_json) WHERE type = 'text' AND value = 'validated_action_content')
      THEN '${JSON.stringify(SHARED_TASK_CONFIRMATION_COMPLETION_RULE)}' ELSE completion_rule_json END`
    : column);
  return `
DROP TRIGGER IF EXISTS memory_sync_capture_continuity_events_insert;
DROP TRIGGER IF EXISTS memory_sync_capture_continuity_events_update;
DROP TRIGGER IF EXISTS memory_sync_capture_continuity_events_delete;
DROP TRIGGER IF EXISTS memory_sync_capture_continuity_event_transitions_delete;
DROP TRIGGER IF EXISTS memory_sync_capture_continuity_event_links_delete;
DROP TRIGGER IF EXISTS memory_sync_capture_continuity_event_candidates_insert;
DROP TRIGGER IF EXISTS memory_sync_capture_continuity_event_candidates_update;
DROP TRIGGER IF EXISTS memory_sync_capture_continuity_event_candidates_delete;
${declaration}
INSERT INTO continuity_events_v2 (${[...retainedColumns, ...upgradedFields].join(', ')})
SELECT ${selectedColumns.join(', ')}, ${Object.values(CONTINUITY_MATTER_UPGRADE_FIELDS).map((value) => value === null ? 'NULL' : value).join(', ')} FROM continuity_events
WHERE idempotency_key NOT LIKE 'continuity-acceptance:%'
  AND id NOT IN (
    'continuity-event-msxav0jd-jppp8k6q', 'continuity-event-msxaw6r3-huijr9ar',
    'continuity-event-msxcf3a4-sltteyiq', 'continuity-event-mszswy5d-a3okgpcu',
    'continuity-event-mt61t8im-knh3x4cv', 'continuity-event-mt79ldck-sx0jj3l8'
  )
  AND NOT (
    kind IN ('closeness_request', 'proactive_intention')
    AND source_kind NOT IN ('real_care', 'real_tool_execution')
  )
  AND NOT (
    source_kind = 'global_action_plan'
    AND NOT EXISTS (
      SELECT 1 FROM continuity_event_transitions evidence
      WHERE evidence.event_id = continuity_events.id
        AND evidence.evidence_outcome = 'succeeded'
        AND evidence.evidence_kind IN (
          'chat_message_persisted', 'proactive_message_persisted',
          'return_message_persisted', 'tool_success_receipt', 'device_success_receipt',
          'notification_dispatch_receipt', 'schedule_completion_receipt'
        )
    )
  );
DROP TABLE continuity_events;
ALTER TABLE continuity_events_v2 RENAME TO continuity_events;
DELETE FROM continuity_event_links WHERE event_id NOT IN (SELECT id FROM continuity_events);
DELETE FROM continuity_event_transitions WHERE event_id NOT IN (SELECT id FROM continuity_events);
DELETE FROM continuity_event_candidates;
`;
}
