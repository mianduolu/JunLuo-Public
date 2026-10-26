import {
  FOCUS_SEMANTIC_SCHEMA_VERSION,
} from './syncFocusSemantic';
import {
  FOCUS_SEMANTIC_CAPTURE_SPECS,
} from './syncFocusSemanticSql';

function sqlString(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

function uuidV4Expression() {
  return `(
    lower(hex(randomblob(4))) || '-' ||
    lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2, 3) || '-' ||
    substr('89ab', (random() & 3) + 1, 1) ||
    substr(lower(hex(randomblob(2))), 2, 3) || '-' ||
    lower(hex(randomblob(6)))
  )`;
}

function sourceAlias(expression: string) {
  return expression.replace(/\bNEW\./g, 'SOURCE.');
}

export const FOCUS_SEMANTIC_BOOTSTRAP_INSERT_SQL =
  FOCUS_SEMANTIC_CAPTURE_SPECS.map((spec) => {
    const entityId = sourceAlias(spec.idExpression('NEW'));
    const record = sourceAlias(spec.recordExpression('NEW'));
    const parents = `COALESCE((
      SELECT json_group_array(revision_id)
      FROM (
        SELECT revision_id
        FROM focus_sync_entity_heads
        WHERE entity_type = ${sqlString(spec.entityType)}
          AND entity_id = ${entityId}
        ORDER BY revision_id ASC
      )
    ), json('[]'))`;
    return `INSERT INTO focus_sync_domain_outbox (
      mutation_id, revision_id, parent_revision_ids_json,
      vault_id, source_device_id, entity_type, entity_id,
      operation, schema_version, payload_json, state,
      available_at, created_at, updated_at
    )
    SELECT
      ${uuidV4Expression()},
      ${uuidV4Expression()},
      ${parents},
      runtime.vault_id,
      runtime.source_device_id,
      ${sqlString(spec.entityType)},
      ${entityId},
      'upsert',
      ${FOCUS_SEMANTIC_SCHEMA_VERSION},
      json_object(
        'schemaVersion', ${FOCUS_SEMANTIC_SCHEMA_VERSION},
        'kind', ${sqlString(spec.kind)},
        'record', ${record}
      ),
      'pending',
      ?,
      ?,
      ?
    FROM ${spec.tableName} AS SOURCE
    CROSS JOIN focus_sync_runtime AS runtime
    WHERE runtime.singleton_id = 1
      AND runtime.capture_enabled = 0
      AND runtime.suppress_capture = 0
      AND runtime.vault_id IS NOT NULL
      AND runtime.source_device_id IS NOT NULL;`;
  });

export const FOCUS_SEMANTIC_BOOTSTRAP_SPEC_COUNT =
  FOCUS_SEMANTIC_BOOTSTRAP_INSERT_SQL.length;

export const FOCUS_SEMANTIC_CURRENT_SNAPSHOT_SELECT_SQL =
  FOCUS_SEMANTIC_CAPTURE_SPECS.map((spec) => {
    const entityId = sourceAlias(spec.idExpression('NEW'));
    const record = sourceAlias(spec.recordExpression('NEW'));
    return `SELECT
      ${sqlString(spec.entityType)} AS entity_type,
      ${entityId} AS entity_id,
      'upsert' AS operation,
      ${FOCUS_SEMANTIC_SCHEMA_VERSION} AS schema_version,
      json_object(
        'schemaVersion', ${FOCUS_SEMANTIC_SCHEMA_VERSION},
        'kind', ${sqlString(spec.kind)},
        'record', ${record}
      ) AS payload_json
    FROM ${spec.tableName} AS SOURCE
    ORDER BY entity_id ASC`;
  });
