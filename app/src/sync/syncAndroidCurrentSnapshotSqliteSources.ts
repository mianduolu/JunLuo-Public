import * as SQLite from 'expo-sqlite';

import { getBodySignalDatabase } from '../bodySignal/bodySignalStore';
import { getExpenseDatabase } from '../expense/expenseStore';
import { getWalletDatabase } from '../expense/walletStore';
import { getFocusDatabase } from '../focus/focusDatabase';
import {
  getMemoryDatabase as ensureMemoryDatabaseReady,
} from '../memory/memoryStore';
import { getPeriodDatabase } from '../period/periodStore';
import { getPhoneActivityDatabase } from '../phoneActivity/phoneActivityStore';
import { getScheduleDatabase } from '../schedule/scheduleDatabase';
import { getTodoDatabase } from '../schedule/todoDatabase';
import { getTheaterDatabase } from '../theater/theaterStore';
import {
  ACTIVITY_OBSERVATIONS_CURRENT_SNAPSHOT_SELECT_SQL,
} from './syncActivityObservationsSql';
import {
  materializeActivityObservationsMutation,
} from './syncActivityObservationsOutbox';
import {
  BODY_SIGNAL_HEALTH_CURRENT_SNAPSHOT_SELECT_SQL,
} from './syncBodySignalHealthSql';
import {
  materializeBodySignalHealthMutation,
} from './syncBodySignalHealthOutbox';
import {
  EXPENSE_LEDGER_CURRENT_SNAPSHOT_SELECT_SQL,
} from './syncExpenseLedgerSql';
import {
  materializeExpenseLedgerMutation,
} from './syncExpenseLedgerOutbox';
import {
  FOCUS_SEMANTIC_CURRENT_SNAPSHOT_SELECT_SQL,
} from './syncFocusSemanticBootstrapSql';
import {
  materializeFocusSemanticMutation,
} from './syncFocusSemanticOutbox';
import {
  MEMORY_RECORDS_SCHEMA_VERSION,
  MEMORY_RECORD_ENTITY_SPECS,
  type MemoryRecordEntitySpec,
  readBaiyunPostImageAssets,
} from './syncMemoryRecords';
import {
  materializeMemoryRecordsMutation,
} from './syncMemoryRecordsOutbox';
import {
  buildMemoryRecordCurrentSnapshotEntityId,
  buildMemoryRecordCurrentSnapshotRecord,
} from './syncMemoryRecordsRuntime';
import { loadCurrentSyncDevice } from './syncCurrentDevice';
import { prepareBaiyunPostImagesPayload } from './syncBaiyunPostImagesRuntime';
import {
  projectPostReviewCurrentSnapshot,
  type PostReviewOwnerRebind,
} from './syncBaiyunPostReviewCurrentSnapshot';
import {
  createCollectedCurrentSnapshotMutationSource,
  type CurrentSnapshotMutationSourceV1,
} from './syncNewWorldBaseline';
import {
  CURRENT_SNAPSHOT_MODE,
} from './syncCurrentSnapshot';
import {
  PERIOD_HEALTH_CURRENT_SNAPSHOT_SELECT_SQL,
} from './syncPeriodHealthSql';
import {
  materializePeriodHealthMutation,
} from './syncPeriodHealthOutbox';
import {
  assertJsonValue,
  type JsonValue,
  type PlainMutationV1,
  type SyncOperation,
} from './syncProtocol';
import {
  SCHEDULE_SEMANTIC_CURRENT_SNAPSHOT_SELECT_SQL,
} from './syncScheduleSemanticSql';
import {
  materializeScheduleSemanticMutation,
} from './syncScheduleSemanticOutbox';
import {
  THEATER_ISOLATED_CURRENT_SNAPSHOT_SELECT_SQL,
} from './syncTheaterIsolatedSql';
import { THEATER_STORY_CURRENT_SNAPSHOT_SELECT_SQL } from './syncTheaterStorySql';
import {
  materializeTheaterIsolatedMutation,
} from './syncTheaterIsolatedOutbox';
import {
  TODO_SEMANTIC_CURRENT_SNAPSHOT_SELECT_SQL,
} from './syncTodoSemanticBootstrapSql';
import {
  materializeTodoSemanticMutation,
} from './syncTodoSemanticOutbox';
import {
  WALLET_LEDGER_CURRENT_SNAPSHOT_SELECT_SQL,
} from './syncWalletLedgerSql';
import {
  materializeWalletLedgerMutation,
} from './syncWalletLedgerOutbox';

const TEMPLATE_TIME = 1_786_400_000_000;
const TEMPLATE_VAULT_ID = '00000000-0000-4000-8000-000000000001';
const TEMPLATE_DEVICE_ID = '00000000-0000-4000-8000-000000000002';

type SnapshotSqlRow = {
  entity_type: string;
  entity_id: string;
  operation: SyncOperation;
  schema_version: number;
  payload_json: string;
  snapshot_cursor?: string;
};

type DomainOutboxEntry = {
  localSequence: number;
  mutationId: string;
  revisionId: string;
  parentRevisionIds: string[];
  vaultId: string;
  sourceDeviceId: string;
  sourceSequence: number;
  entityType: string;
  entityId: string;
  operation: SyncOperation;
  schemaVersion: number;
  payload: JsonValue;
  state: 'pending';
  attemptCount: number;
  availableAt: number;
  leaseId: null;
  leaseExpiresAt: null;
  createdAt: number;
  updatedAt: number;
};

type DomainMaterializer = (entry: DomainOutboxEntry) => PlainMutationV1;

function templateUuid(value: number) {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
}

function parsePayload(raw: string) {
  let payload: unknown;
  try {
    payload = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('current snapshot SQLite payload is not valid JSON');
  }
  assertJsonValue(payload);
  return payload;
}

function materializeRow(
  row: SnapshotSqlRow,
  rowIndex: number,
  materialize: DomainMaterializer,
) {
  if (
    typeof row.entity_type !== 'string'
    || typeof row.entity_id !== 'string'
    || !Number.isSafeInteger(row.schema_version)
  ) {
    throw new Error('current snapshot SQLite row is malformed');
  }
  return materialize({
    localSequence: rowIndex + 1,
    mutationId: templateUuid(rowIndex * 2 + 10),
    revisionId: templateUuid(rowIndex * 2 + 11),
    parentRevisionIds: [],
    vaultId: TEMPLATE_VAULT_ID,
    sourceDeviceId: TEMPLATE_DEVICE_ID,
    sourceSequence: rowIndex + 1,
    entityType: row.entity_type,
    entityId: row.entity_id,
    operation: row.operation,
    schemaVersion: row.schema_version,
    payload: parsePayload(row.payload_json),
    state: 'pending',
    attemptCount: 0,
    availableAt: TEMPLATE_TIME,
    leaseId: null,
    leaseExpiresAt: null,
    createdAt: TEMPLATE_TIME,
    updatedAt: TEMPLATE_TIME,
  });
}

async function withReadOnlyDatabase<T>(
  databaseName: string,
  read: (database: SQLite.SQLiteDatabase) => Promise<T>,
) {
  const database = await SQLite.openDatabaseAsync(
    databaseName,
    { useNewConnection: true },
  );
  try {
    await database.execAsync('PRAGMA query_only = ON;');
    return await read(database);
  } finally {
    await database.closeAsync();
  }
}

type SqlCurrentSnapshotCursor = Readonly<{
  statementIndex: number;
  rowOffset: number;
}>;

function parseSqlCurrentSnapshotCursor(
  pageToken: string | null,
): SqlCurrentSnapshotCursor {
  if (pageToken === null) return { statementIndex: 0, rowOffset: 0 };
  const match = /^q:(0|[1-9]\d{0,5}):(0|[1-9]\d{0,8})$/u.exec(pageToken);
  if (!match) throw new Error('SQLite current snapshot page token is invalid');
  return {
    statementIndex: Number(match[1]),
    rowOffset: Number(match[2]),
  };
}

function sqlCurrentSnapshotToken(cursor: SqlCurrentSnapshotCursor) {
  return `q:${cursor.statementIndex}:${cursor.rowOffset}`;
}

type SqlCurrentSnapshotKeysetCursor = Readonly<{
  statementIndex: number;
  rowCursor: string | null;
}>;

function parseSqlCurrentSnapshotKeysetCursor(
  pageToken: string | null,
): SqlCurrentSnapshotKeysetCursor {
  if (pageToken === null) return { statementIndex: 0, rowCursor: null };
  const match = /^k:(0|[1-9]\d{0,5}):(.*)$/u.exec(pageToken);
  if (!match) throw new Error('SQLite keyset snapshot page token is invalid');
  let rowCursor: string | null = null;
  if (match[2]) {
    try {
      rowCursor = decodeURIComponent(match[2]);
    } catch {
      throw new Error('SQLite keyset snapshot row cursor is invalid');
    }
    if (!rowCursor || rowCursor.length > 512) {
      throw new Error('SQLite keyset snapshot row cursor is invalid');
    }
  }
  return {
    statementIndex: Number(match[1]),
    rowCursor,
  };
}

function sqlCurrentSnapshotKeysetToken(
  cursor: SqlCurrentSnapshotKeysetCursor,
) {
  return `k:${cursor.statementIndex}:${
    cursor.rowCursor === null ? '' : encodeURIComponent(cursor.rowCursor)
  }`;
}

function assertCurrentSnapshotSelectSql(adapterId: string, sql: string) {
  const normalized = sql.trim().replace(/;+$/u, '');
  if (!/^SELECT\b/iu.test(normalized)) {
    throw new Error(`${adapterId} current snapshot SQL is not a SELECT`);
  }
  if (/sync_(?:domain_outbox|entity_heads|runtime|bootstrap_state)/iu.test(normalized)) {
    throw new Error(`${adapterId} current snapshot SQL reads old sync state`);
  }
  return normalized;
}

function keysetCurrentSnapshotSelectSql(input: {
  adapterId: string;
  sql: string;
  column: string;
  hasCursor: boolean;
}) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(input.column)) {
    throw new Error(`${input.adapterId} current snapshot keyset column is invalid`);
  }
  const sql = assertCurrentSnapshotSelectSql(input.adapterId, input.sql);
  const orderPattern = new RegExp(
    `\\s+ORDER BY CAST\\(ROW\\.${input.column} AS TEXT\\) ASC$`,
    'iu',
  );
  if (!orderPattern.test(sql)) {
    throw new Error(`${input.adapterId} current snapshot keyset order is invalid`);
  }
  const withoutOrder = sql.replace(orderPattern, '');
  const fromPattern = /(\n\s*)FROM\s+/u;
  if (!fromPattern.test(withoutOrder)) {
    throw new Error(`${input.adapterId} current snapshot SELECT has no FROM clause`);
  }
  const withCursorColumn = withoutOrder.replace(
    fromPattern,
    `,\n    CAST(ROW.${input.column} AS TEXT) AS snapshot_cursor$1FROM `,
  );
  const cursorPredicate = input.hasCursor
    ? `${/\bWHERE\b/iu.test(withCursorColumn) ? 'AND' : 'WHERE'} ROW.${input.column} > ?`
    : '';
  return `${withCursorColumn}\n  ${cursorPredicate}\n  ORDER BY ROW.${input.column} ASC\n  LIMIT ?`;
}

function createSqlCurrentSnapshotSource(input: {
  adapterId: string;
  databaseName: string;
  ensureReady: () => Promise<SQLite.SQLiteDatabase>;
  selectSql: readonly string[] | ((database: SQLite.SQLiteDatabase) => Promise<readonly string[]>);
  materialize: DomainMaterializer;
  keysetColumn?: string;
}): CurrentSnapshotMutationSourceV1 {
  return Object.freeze({
    adapterId: input.adapterId,
    readMutationPage: async ({ mode, pageToken, limit }: {
      mode: typeof CURRENT_SNAPSHOT_MODE;
      pageToken: string | null;
      limit: number;
    }) => {
      if (mode !== CURRENT_SNAPSHOT_MODE) {
        throw new Error(`${input.adapterId} current snapshot received an unknown mode`);
      }
      const offsetStart = input.keysetColumn
        ? null
        : parseSqlCurrentSnapshotCursor(pageToken);
      const keysetStart = input.keysetColumn
        ? parseSqlCurrentSnapshotKeysetCursor(pageToken)
        : null;
      const startStatementIndex = offsetStart?.statementIndex
        ?? keysetStart?.statementIndex
        ?? 0;
      const database = await input.ensureReady();
      const selectSql = typeof input.selectSql === 'function'
        ? await input.selectSql(database)
        : input.selectSql;
      if (startStatementIndex > selectSql.length) {
        throw new Error(`${input.adapterId} current snapshot statement cursor is out of range`);
      }
      let statementIndex = startStatementIndex;
      let rowOffset = offsetStart?.rowOffset ?? 0;
      let rowCursor = keysetStart?.rowCursor ?? null;
        const mutations: PlainMutationV1[] = [];
      while (
        mutations.length < limit
        && statementIndex < selectSql.length
      ) {
        const remaining = limit - mutations.length;
        const rows = input.keysetColumn
          ? await database.getAllAsync<SnapshotSqlRow>(
              keysetCurrentSnapshotSelectSql({
                adapterId: input.adapterId,
                sql: selectSql[statementIndex],
                column: input.keysetColumn,
                hasCursor: rowCursor !== null,
              }),
              ...(rowCursor === null
                ? [remaining + 1]
                : [rowCursor, remaining + 1]),
            )
          : await database.getAllAsync<SnapshotSqlRow>(
              `${assertCurrentSnapshotSelectSql(
                input.adapterId,
                selectSql[statementIndex],
              )}\nLIMIT ? OFFSET ?`,
              remaining + 1,
              rowOffset,
            );
        const accepted = rows.slice(0, remaining);
        for (const row of accepted) {
          mutations.push(materializeRow(
            row,
            mutations.length,
            input.materialize,
          ));
        }
        if (input.keysetColumn && accepted.length) {
          const nextCursor = accepted[accepted.length - 1].snapshot_cursor;
          if (typeof nextCursor !== 'string' || !nextCursor) {
            throw new Error(`${input.adapterId} current snapshot row cursor is missing`);
          }
          rowCursor = nextCursor;
        } else {
          rowOffset += accepted.length;
        }
        if (rows.length > remaining) break;
        statementIndex += 1;
        rowOffset = 0;
        rowCursor = null;
      }
      const nextPageToken = statementIndex >= selectSql.length
        ? null
        : input.keysetColumn
          ? sqlCurrentSnapshotKeysetToken({ statementIndex, rowCursor })
          : sqlCurrentSnapshotToken({ statementIndex, rowOffset });
      return Object.freeze({
        mutations: Object.freeze(mutations),
        nextPageToken,
      });
    },
  });
}

function createMemoryCurrentSnapshotSource(input: {
  adapterId: 'memory.records' | 'continuity.ledger';
  specs: readonly MemoryRecordEntitySpec[];
  postReviewOwnerRebind?: PostReviewOwnerRebind;
}) {
  return createCollectedCurrentSnapshotMutationSource({
    adapterId: input.adapterId,
    collect: async () => {
      await ensureMemoryDatabaseReady('sync_capture');
      return withReadOnlyDatabase(
        'junluo-memory.db',
        async (database) => {
        const mutations: PlainMutationV1[] = [];
        for (const spec of input.specs) {
          const orderBy = spec.idColumns
            .map((column) => `"${column}" ASC`)
            .join(', ');
          const tableName = spec.snapshotTableName ?? spec.tableName;
          const currentFilter = spec.entityType === 'continuity-candidate'
            ? ' WHERE 0'
            : spec.entityType === 'continuity-event'
              ? " WHERE primary_intent IS NOT 'stay'"
              : spec.entityType === 'continuity-link' || spec.entityType === 'continuity-transition'
                ? ` WHERE EXISTS (SELECT 1 FROM continuity_events AS current_event
                    WHERE current_event.id = "${tableName}".event_id
                      AND current_event.primary_intent IS NOT 'stay')`
                : '';
          const rows = await database.getAllAsync<Record<string, unknown>>(
            `SELECT * FROM "${tableName}"${currentFilter} ORDER BY ${orderBy}`,
          );
          for (const row of rows) {
            let record = buildMemoryRecordCurrentSnapshotRecord(spec, row);
            let sourceDeviceId = TEMPLATE_DEVICE_ID;
            if (spec.entityType === 'post-review' || spec.entityType === 'post-review-action') {
              const projected = projectPostReviewCurrentSnapshot(
                spec.entityType,
                record as Record<string, JsonValue>,
                input.postReviewOwnerRebind,
              );
              if (!projected) continue;
              record = projected.record;
              sourceDeviceId = projected.sourceDeviceId;
            }
            const entityId = buildMemoryRecordCurrentSnapshotEntityId(
              spec,
              record,
            );
            const schemaVersion = spec.schemaVersion ?? MEMORY_RECORDS_SCHEMA_VERSION;
            let payload: JsonValue = { schemaVersion, record };
            if ([6, 9].includes(schemaVersion) && readBaiyunPostImageAssets(record).length) {
              const current = await loadCurrentSyncDevice();
              if (!current) throw new Error('post image current snapshot requires active staging identity');
              payload = await prepareBaiyunPostImagesPayload({ payload, ...current, now: Date.now() });
            }
            mutations.push(materializeMemoryRecordsMutation({
              localSequence: mutations.length + 1,
              mutationId: templateUuid(mutations.length * 2 + 10),
              revisionId: templateUuid(mutations.length * 2 + 11),
              parentRevisionIds: [],
              vaultId: TEMPLATE_VAULT_ID,
              sourceDeviceId,
              sourceSequence: mutations.length + 1,
              entityType: spec.entityType,
              entityId,
              operation: spec.insertOperation,
              schemaVersion,
              payload,
              state: 'pending',
              attemptCount: 0,
              availableAt: TEMPLATE_TIME,
              leaseId: null,
              leaseExpiresAt: null,
              createdAt: TEMPLATE_TIME,
              updatedAt: TEMPLATE_TIME,
            }));
          }
        }
        return mutations;
        },
      );
    },
  });
}

function combineCurrentSnapshotSources(input: {
  adapterId: string;
  sources: readonly CurrentSnapshotMutationSourceV1[];
}) {
  return createCollectedCurrentSnapshotMutationSource({
    adapterId: input.adapterId,
    collect: async () => {
      const mutations: PlainMutationV1[] = [];
      for (const source of input.sources) {
        let pageToken: string | null = null;
        do {
          const page = await source.readMutationPage({
            mode: (await import('./syncCurrentSnapshot')).CURRENT_SNAPSHOT_MODE,
            pageToken,
            limit: 100,
          });
          mutations.push(...page.mutations);
          pageToken = page.nextPageToken;
        } while (pageToken !== null);
      }
      return mutations;
    },
  });
}

export function createAndroidCurrentSnapshotSqliteSources(input: {
  scheduleStorage: CurrentSnapshotMutationSourceV1;
  focusStorage: CurrentSnapshotMutationSourceV1;
  postReviewOwnerRebind?: PostReviewOwnerRebind;
}) {
  const memoryRecords = createMemoryCurrentSnapshotSource({
    adapterId: 'memory.records',
    postReviewOwnerRebind: input.postReviewOwnerRebind,
    specs: MEMORY_RECORD_ENTITY_SPECS.filter(
      (spec) => spec.bootstrapAdapterId === 'memory.records',
    ),
  });
  const continuityLedger = createMemoryCurrentSnapshotSource({
    adapterId: 'continuity.ledger',
    specs: MEMORY_RECORD_ENTITY_SPECS.filter(
      (spec) => spec.bootstrapAdapterId === 'continuity.ledger',
    ),
  });
  const scheduleSqlite = createSqlCurrentSnapshotSource({
    adapterId: 'schedule.semantic',
    databaseName: 'junluo-schedule.db',
    ensureReady: getScheduleDatabase,
    selectSql: SCHEDULE_SEMANTIC_CURRENT_SNAPSHOT_SELECT_SQL,
    materialize: (entry) => materializeScheduleSemanticMutation(
      entry as Parameters<typeof materializeScheduleSemanticMutation>[0],
    ),
  });
  const focusSqlite = createSqlCurrentSnapshotSource({
    adapterId: 'focus.semantic',
    databaseName: 'junluo-focus.db',
    ensureReady: getFocusDatabase,
    selectSql: FOCUS_SEMANTIC_CURRENT_SNAPSHOT_SELECT_SQL,
    materialize: (entry) => materializeFocusSemanticMutation(
      entry as Parameters<typeof materializeFocusSemanticMutation>[0],
    ),
  });
  return Object.freeze([
    memoryRecords,
    continuityLedger,
    combineCurrentSnapshotSources({
      adapterId: 'schedule.semantic',
      sources: [scheduleSqlite, input.scheduleStorage],
    }),
    createSqlCurrentSnapshotSource({
      adapterId: 'todo.semantic',
      databaseName: 'junluo-todo.db',
      ensureReady: getTodoDatabase,
      selectSql: TODO_SEMANTIC_CURRENT_SNAPSHOT_SELECT_SQL,
      materialize: (entry) => materializeTodoSemanticMutation(
        entry as Parameters<typeof materializeTodoSemanticMutation>[0],
      ),
    }),
    combineCurrentSnapshotSources({
      adapterId: 'focus.semantic',
      sources: [focusSqlite, input.focusStorage],
    }),
    createSqlCurrentSnapshotSource({
      adapterId: 'theater.isolated',
      databaseName: 'junluo-theater.db',
      ensureReady: getTheaterDatabase,
      selectSql: async (database) => {
        const installed = await database.getFirstAsync(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'theater_story_schema'",
        );
        if (!installed) return THEATER_ISOLATED_CURRENT_SNAPSHOT_SELECT_SQL;
        const marker = await database.getFirstAsync<{ version: number }>('SELECT version FROM theater_story_schema');
        if (marker?.version !== 2) throw new Error('theater-story-unsupported-schema');
        return THEATER_STORY_CURRENT_SNAPSHOT_SELECT_SQL;
      },
      materialize: (entry) => materializeTheaterIsolatedMutation(
        entry as Parameters<typeof materializeTheaterIsolatedMutation>[0],
      ),
    }),
    createSqlCurrentSnapshotSource({
      adapterId: 'expense.ledger',
      databaseName: 'junluo-expense.db',
      ensureReady: getExpenseDatabase,
      selectSql: EXPENSE_LEDGER_CURRENT_SNAPSHOT_SELECT_SQL,
      materialize: (entry) => materializeExpenseLedgerMutation(
        entry as Parameters<typeof materializeExpenseLedgerMutation>[0],
      ),
    }),
    createSqlCurrentSnapshotSource({
      adapterId: 'wallet.ledger',
      databaseName: 'junluo-expense.db',
      ensureReady: getWalletDatabase,
      selectSql: WALLET_LEDGER_CURRENT_SNAPSHOT_SELECT_SQL,
      materialize: (entry) => materializeWalletLedgerMutation(
        entry as Parameters<typeof materializeWalletLedgerMutation>[0],
      ),
    }),
    createSqlCurrentSnapshotSource({
      adapterId: 'period.health',
      databaseName: 'junluo-period.db',
      ensureReady: getPeriodDatabase,
      selectSql: PERIOD_HEALTH_CURRENT_SNAPSHOT_SELECT_SQL,
      materialize: (entry) => materializePeriodHealthMutation(
        entry as Parameters<typeof materializePeriodHealthMutation>[0],
      ),
    }),
    createSqlCurrentSnapshotSource({
      adapterId: 'body-signal.health',
      databaseName: 'junluo-body-signal.db',
      ensureReady: getBodySignalDatabase,
      selectSql: BODY_SIGNAL_HEALTH_CURRENT_SNAPSHOT_SELECT_SQL,
      keysetColumn: 'id',
      materialize: (entry) => materializeBodySignalHealthMutation(
        entry as Parameters<typeof materializeBodySignalHealthMutation>[0],
      ),
    }),
    createSqlCurrentSnapshotSource({
      adapterId: 'activity.observations',
      databaseName: 'junluo-phone-activity.db',
      ensureReady: getPhoneActivityDatabase,
      selectSql: ACTIVITY_OBSERVATIONS_CURRENT_SNAPSHOT_SELECT_SQL,
      keysetColumn: 'id',
      materialize: (entry) => materializeActivityObservationsMutation(
        entry as Parameters<typeof materializeActivityObservationsMutation>[0],
      ),
    }),
  ] satisfies readonly CurrentSnapshotMutationSourceV1[]);
}
