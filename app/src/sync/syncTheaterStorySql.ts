import { buildCaptureTrigger, buildCaptureUpsertBody, captureEnabledPredicate, bootstrapInsertStatement, currentSnapshotSelectSql, type CaptureSpec } from './syncTheaterIsolatedSql';

// Ordered selections reference shared versions. Do not ship an entire story as one document.
const projections = [
  { kind: 'story', table: 'theater_conversations', fields: `
    'title', r.title, 'settings', json(r.settings_json), 'summaryInterval', r.summary_interval,
    'isDraft', json(CASE WHEN r.is_draft = 1 THEN 'true' ELSE 'false' END),
    'isPinned', json(CASE WHEN r.is_pinned = 1 THEN 'true' ELSE 'false' END)`,
    columns: ['title', 'settings_json', 'summary_interval', 'is_draft', 'is_pinned', 'created_at', 'updated_at'] },
  { kind: 'text-version', table: 'theater_text_versions', fields: `
    'conversationId', r.conversation_id, 'positionId', r.position_id, 'kind', r.kind,
    'subject', r.subject, 'content', r.content, 'origin', r.origin`,
    columns: ['content', 'updated_at', 'co_creation_json'] },
  { kind: 'branch', table: 'theater_branches', fields: `
    'conversationId', r.conversation_id, 'name', r.name, 'forkBoundary', r.fork_boundary,
    'adoptions', json(COALESCE((SELECT json_group_array(json(item)) FROM (
      SELECT json_object('positionId', position_id, 'versionId', version_id) AS item
      FROM theater_branch_positions WHERE branch_id = r.id ORDER BY ordinal)), '[]'))`,
    columns: ['name', 'fork_boundary', 'created_at', 'updated_at'] },
  { kind: 'checkpoint', table: 'theater_checkpoints', fields: `
    'conversationId', r.conversation_id, 'branchId', r.branch_id, 'content', r.content,
    'coveredPositionId', r.covered_position_id, 'basis', json(r.basis_json), 'status', r.status,
    'active', json(CASE WHEN EXISTS (SELECT 1 FROM theater_branches b WHERE b.id = r.branch_id
      AND b.active_checkpoint_id = r.id) THEN 'true' ELSE 'false' END),
    'needsReview', json(CASE WHEN EXISTS (SELECT 1 FROM theater_branches b WHERE b.id = r.branch_id
      AND b.stale_checkpoint_id = r.id) THEN 'true' ELSE 'false' END)`,
    columns: ['content', 'covered_position_id', 'basis_json', 'status', 'created_at', 'updated_at'] },
  { kind: 'anchor', table: 'theater_anchors', fields: `
    'conversationId', r.conversation_id, 'branchId', r.branch_id, 'positionId', r.position_id,
    'sourceVersionId', r.source_version_id, 'source', r.source, 'content', r.content,
    'confirmed', json(CASE WHEN r.confirmed = 1 THEN 'true' ELSE 'false' END)`,
    columns: ['position_id', 'source_version_id', 'source', 'content', 'confirmed', 'created_at', 'updated_at'] },
] as const;

export const THEATER_STORY_RECORD_SELECT_SQL = projections.map((item) => `
  SELECT '${item.kind}' AS kind, '${item.kind}:' || r.id AS entity_id,
    ${item.kind === 'text-version' ? 'json_patch(' : ''}json_object('id', r.id, 'createdAt', r.created_at, 'updatedAt', r.updated_at, ${item.fields})${item.kind === 'text-version' ? ", CASE WHEN r.co_creation_json IS NULL THEN '{}' ELSE json_object('coCreation', json(r.co_creation_json)) END)" : ''} AS record_json
  FROM ${item.table} r`);
export const THEATER_STORY_SYNC_VIEW_SQL = `DROP VIEW IF EXISTS theater_story_sync_records;
CREATE VIEW theater_story_sync_records AS ${THEATER_STORY_RECORD_SELECT_SQL.join(' UNION ALL ')};`;

export const THEATER_STORY_CAPTURE_SPECS: CaptureSpec[] = projections.map((item) => ({
  name: item.kind.replaceAll('-', '_'), tableName: item.table, schemaVersion: 2,
  kindExpression: () => `'${item.kind}'`, entityIdExpression: (row) => `'${item.kind}:' || ${row}.id`,
  recordExpression: (row) => `(SELECT json(record_json) FROM theater_story_sync_records WHERE entity_id = '${item.kind}:' || ${row}.id)`,
  updateColumns: item.columns,
}));
const positions: CaptureSpec = {
  name: 'positions', tableName: 'theater_branch_positions', schemaVersion: 2,
  kindExpression: () => "'branch'", entityIdExpression: (row) => `'branch:' || ${row}.branch_id`,
  recordExpression: (row) => `(SELECT json(record_json) FROM theater_story_sync_records WHERE entity_id = 'branch:' || ${row}.branch_id)`,
  updateColumns: ['ordinal', 'version_id'],
  predicate: (row) => `EXISTS (SELECT 1 FROM theater_branches WHERE id = ${row}.branch_id)`,
};

// Convey active selection on checkpoints to avoid a branch/checkpoint dependency cycle.
const activeUpdates = (selector: string, retired = false) => buildCaptureUpsertBody({
  ...THEATER_STORY_CAPTURE_SPECS.find((spec) => spec.name === 'checkpoint')!,
  name: 'active', tableName: 'theater_branches',
  entityIdExpression: () => `'checkpoint:' || ${selector}`,
  recordExpression: () => `(SELECT ${retired ? "json_set(record_json, '$.active', json('false'), '$.needsReview', json('false'))" : 'json(record_json)'}
    FROM theater_story_sync_records WHERE entity_id = 'checkpoint:' || ${selector})`,
  updateColumns: ['active_checkpoint_id'],
}, `${selector} IS NOT NULL AND EXISTS (SELECT 1 FROM theater_checkpoints WHERE id = ${selector})`);

// The transport sends records in capture order, not whole business transactions.
// Writers must retire an affected checkpoint BEFORE changing its adopted prefix.
// Reject a bad order atomically instead of queuing a branch that no receiver can apply.
const adoptionOrderGuards = (['insert', 'update', 'delete'] as const).map((action) => {
  const row = action === 'delete' ? 'OLD' : 'NEW';
  return `CREATE TRIGGER IF NOT EXISTS theater_sync_capture_adoption_guard_${action}
    AFTER ${action.toUpperCase()} ON theater_branch_positions
    WHEN ${captureEnabledPredicate()} AND EXISTS (
      SELECT 1 FROM theater_branches b JOIN theater_checkpoints c ON c.id = b.active_checkpoint_id,
        json_each(c.basis_json) basis
      WHERE b.id = ${row}.branch_id AND NOT EXISTS (
        SELECT 1 FROM (
          SELECT p.position_id, p.version_id, ROW_NUMBER() OVER (ORDER BY p.ordinal) - 1 AS sequence
          FROM theater_branch_positions p JOIN theater_text_versions v ON v.id = p.version_id
          WHERE p.branch_id = b.id AND v.kind = 'dialogue'
        ) adopted WHERE adopted.sequence = CAST(basis.key AS INTEGER)
          AND adopted.position_id = json_extract(basis.value, '$.positionId')
          AND adopted.version_id = json_extract(basis.value, '$.versionId')
      )
    ) BEGIN SELECT RAISE(ABORT, 'theater-story-deactivate-checkpoint-before-adoptions'); END;`;
}).join('\n');

export const THEATER_STORY_CAPTURE_TRIGGER_COUNT = 22;
export const THEATER_STORY_CAPTURE_SQL = `
${THEATER_STORY_SYNC_VIEW_SQL}
DROP TRIGGER IF EXISTS theater_sync_capture_branch_update;
DROP TRIGGER IF EXISTS theater_sync_capture_active_update;
DROP TRIGGER IF EXISTS theater_sync_capture_text_version_update;
${['persona', 'conversation', 'message'].flatMap((name) => ['insert', 'update', 'delete'].map((action) => `DROP TRIGGER IF EXISTS theater_sync_capture_${name}_${action};`)).join('\n')}
${THEATER_STORY_CAPTURE_SPECS.flatMap((spec) => (['insert', 'update', 'delete'] as const).map((action) => buildCaptureTrigger(spec, action))).join('\n')}
${(['insert', 'update', 'delete'] as const).map((action) => buildCaptureTrigger(positions, action, true)).join('\n')}
${adoptionOrderGuards}
CREATE TRIGGER IF NOT EXISTS theater_sync_capture_active_update
AFTER UPDATE OF active_checkpoint_id, stale_checkpoint_id ON theater_branches
WHEN ${captureEnabledPredicate()} AND (OLD.active_checkpoint_id IS NOT NEW.active_checkpoint_id
  OR OLD.stale_checkpoint_id IS NOT NEW.stale_checkpoint_id)
BEGIN
  ${activeUpdates('OLD.active_checkpoint_id', true)}
  ${activeUpdates('OLD.stale_checkpoint_id', true)}
  ${activeUpdates('NEW.stale_checkpoint_id')}
  ${activeUpdates('NEW.active_checkpoint_id')}
END;
UPDATE theater_sync_schema_meta SET capture_schema_version = 2, trigger_count = ${THEATER_STORY_CAPTURE_TRIGGER_COUNT} WHERE singleton_id = 1;
`;

export const THEATER_STORY_BOOTSTRAP_INSERT_SQL = THEATER_STORY_CAPTURE_SPECS.map(bootstrapInsertStatement);
export const THEATER_STORY_CURRENT_SNAPSHOT_SELECT_SQL = THEATER_STORY_CAPTURE_SPECS.map(currentSnapshotSelectSql);
