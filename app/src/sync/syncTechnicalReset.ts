import {
  ACTIVITY_OBSERVATIONS_RESET_TECHNICAL_STATE_SQL,
} from './syncActivityObservationsSql';
import {
  BODY_SIGNAL_HEALTH_RESET_TECHNICAL_STATE_SQL,
} from './syncBodySignalHealthSql';
import {
  EXPENSE_LEDGER_RESET_TECHNICAL_STATE_SQL,
  EXPENSE_LEDGER_PRESERVED_REFUND_RELATION_SQL,
} from './syncExpenseLedgerSql';
import {
  FOCUS_SEMANTIC_RESET_TECHNICAL_STATE_SQL,
} from './syncFocusSemanticSql';
import {
  MEMORY_RECORDS_RESET_TECHNICAL_STATE_SQL,
} from './syncMemoryRecordsSql';
import {
  PERIOD_HEALTH_RESET_TECHNICAL_STATE_SQL,
} from './syncPeriodHealthSql';
import {
  SCHEDULE_SEMANTIC_RESET_TECHNICAL_STATE_SQL,
} from './syncScheduleSemanticSql';
import {
  THEATER_ISOLATED_RESET_TECHNICAL_STATE_SQL,
} from './syncTheaterIsolatedSql';
import {
  TODO_SEMANTIC_RESET_TECHNICAL_STATE_SQL,
} from './syncTodoSemanticSql';
import {
  WALLET_LEDGER_RESET_TECHNICAL_STATE_SQL,
} from './syncWalletLedgerSql';

export type SyncTechnicalResetDatabaseId =
  | 'activity'
  | 'body-signal'
  | 'expense-wallet'
  | 'focus'
  | 'memory'
  | 'period'
  | 'schedule'
  | 'theater'
  | 'todo';

export type SyncTechnicalResetManifestEntry = Readonly<{
  databaseId: SyncTechnicalResetDatabaseId;
  databaseName: string;
  deleteTables: readonly string[];
  runtimeTables: readonly string[];
  runtimeHasSourcePlatform: boolean;
  resetSql: string;
}>;

const manifest = (
  entry: SyncTechnicalResetManifestEntry,
): SyncTechnicalResetManifestEntry => Object.freeze({
  ...entry,
  deleteTables: Object.freeze([...entry.deleteTables]),
  runtimeTables: Object.freeze([...entry.runtimeTables]),
});

export const SYNC_TECHNICAL_RESET_MANIFEST:
readonly SyncTechnicalResetManifestEntry[] = Object.freeze([
  manifest({
    databaseId: 'activity',
    databaseName: 'junluo-phone-activity.db',
    deleteTables: [
      'activity_sync_domain_outbox',
      'activity_sync_entity_heads',
      'activity_sync_conflicts',
      'activity_sync_bootstrap_state',
      'activity_sync_summary_checkpoints',
    ],
    runtimeTables: ['activity_sync_runtime'],
    runtimeHasSourcePlatform: true,
    resetSql: ACTIVITY_OBSERVATIONS_RESET_TECHNICAL_STATE_SQL,
  }),
  manifest({
    databaseId: 'body-signal',
    databaseName: 'junluo-body-signal.db',
    deleteTables: [
      'body_signal_sync_domain_outbox',
      'body_signal_sync_entity_heads',
      'body_signal_sync_conflicts',
      'body_signal_sync_bootstrap_state',
      'body_signal_sync_summary_checkpoints',
    ],
    runtimeTables: ['body_signal_sync_runtime'],
    runtimeHasSourcePlatform: true,
    resetSql: BODY_SIGNAL_HEALTH_RESET_TECHNICAL_STATE_SQL,
  }),
  manifest({
    databaseId: 'expense-wallet',
    databaseName: 'junluo-expense.db',
    deleteTables: [
      'expense_sync_domain_outbox',
      'expense_sync_entity_heads',
      'expense_sync_conflicts',
      'expense_sync_bootstrap_state',
      'wallet_sync_domain_outbox',
      'wallet_sync_entity_heads',
      'wallet_sync_conflicts',
      'wallet_sync_bootstrap_state',
    ],
    runtimeTables: ['expense_sync_runtime', 'wallet_sync_runtime'],
    runtimeHasSourcePlatform: false,
    resetSql: `${EXPENSE_LEDGER_RESET_TECHNICAL_STATE_SQL}\n${WALLET_LEDGER_RESET_TECHNICAL_STATE_SQL}`,
  }),
  manifest({
    databaseId: 'focus',
    databaseName: 'junluo-focus.db',
    deleteTables: [
      'focus_sync_domain_outbox',
      'focus_sync_entity_heads',
      'focus_sync_conflicts',
      'focus_sync_bootstrap_state',
    ],
    runtimeTables: ['focus_sync_runtime'],
    runtimeHasSourcePlatform: false,
    resetSql: FOCUS_SEMANTIC_RESET_TECHNICAL_STATE_SQL,
  }),
  manifest({
    databaseId: 'memory',
    databaseName: 'junluo-memory.db',
    deleteTables: [
      'memory_sync_domain_outbox',
      'memory_sync_entity_heads',
      'memory_sync_conflicts',
      'memory_sync_bootstrap_state',
      'memory_sync_revision_log',
      'memory_sync_applied_mutations',
    ],
    runtimeTables: ['memory_sync_runtime'],
    runtimeHasSourcePlatform: false,
    resetSql: MEMORY_RECORDS_RESET_TECHNICAL_STATE_SQL,
  }),
  manifest({
    databaseId: 'period',
    databaseName: 'junluo-period.db',
    deleteTables: [
      'period_sync_domain_outbox',
      'period_sync_entity_heads',
      'period_sync_conflicts',
      'period_sync_pending_notification_cancellations',
      'period_sync_bootstrap_state',
    ],
    runtimeTables: ['period_sync_runtime'],
    runtimeHasSourcePlatform: false,
    resetSql: PERIOD_HEALTH_RESET_TECHNICAL_STATE_SQL,
  }),
  manifest({
    databaseId: 'schedule',
    databaseName: 'junluo-schedule.db',
    deleteTables: [
      'schedule_sync_domain_outbox',
      'schedule_sync_entity_heads',
      'schedule_sync_conflicts',
      'schedule_sync_pending_delivery_apply',
      'schedule_sync_bootstrap_state',
    ],
    runtimeTables: ['schedule_sync_runtime'],
    runtimeHasSourcePlatform: false,
    resetSql: SCHEDULE_SEMANTIC_RESET_TECHNICAL_STATE_SQL,
  }),
  manifest({
    databaseId: 'theater',
    databaseName: 'junluo-theater.db',
    deleteTables: [
      'theater_sync_domain_outbox',
      'theater_sync_entity_heads',
      'theater_sync_conflicts',
      'theater_sync_bootstrap_state',
    ],
    runtimeTables: ['theater_sync_runtime'],
    runtimeHasSourcePlatform: false,
    resetSql: THEATER_ISOLATED_RESET_TECHNICAL_STATE_SQL,
  }),
  manifest({
    databaseId: 'todo',
    databaseName: 'junluo-todo.db',
    deleteTables: [
      'todo_sync_domain_outbox',
      'todo_sync_entity_heads',
      'todo_sync_conflicts',
      'todo_sync_bootstrap_state',
    ],
    runtimeTables: ['todo_sync_runtime'],
    runtimeHasSourcePlatform: false,
    resetSql: TODO_SEMANTIC_RESET_TECHNICAL_STATE_SQL,
  }),
]);

export interface SyncTechnicalResetQueryPort {
  getFirstAsync<T>(source: string): Promise<T | null>;
  execAsync(source: string): Promise<void>;
}

export interface SyncTechnicalResetDatabasePort
extends SyncTechnicalResetQueryPort {
  withExclusiveTransactionAsync(
    task: (transaction: SyncTechnicalResetQueryPort) => Promise<void>,
  ): Promise<void>;
}

export type SyncTechnicalResetInspection = Readonly<{
  databaseId: SyncTechnicalResetDatabaseId;
  databaseName: string;
  deleteRowCounts: Readonly<Record<string, number>>;
  boundRuntimeRows: Readonly<Record<string, number>>;
  totalDeleteRows: number;
  totalBoundRuntimeRows: number;
}>;

function quoteIdentifier(value: string) {
  if (!/^[a-z0-9_]+$/u.test(value)) {
    throw new Error(`unsafe sync technical identifier: ${value}`);
  }
  return `"${value}"`;
}

export function resolveSyncTechnicalResetManifest(
  databaseId: SyncTechnicalResetDatabaseId,
) {
  const entry = SYNC_TECHNICAL_RESET_MANIFEST.find(
    (candidate) => candidate.databaseId === databaseId,
  );
  if (!entry) {
    throw new Error(`unknown sync technical reset database: ${databaseId}`);
  }
  return entry;
}

export async function inspectSyncTechnicalReset(input: {
  databaseId: SyncTechnicalResetDatabaseId;
  database: SyncTechnicalResetQueryPort;
}): Promise<SyncTechnicalResetInspection> {
  const entry = resolveSyncTechnicalResetManifest(input.databaseId);
  const deleteRowCounts: Record<string, number> = {};
  for (const table of entry.deleteTables) {
    const removableRows = entry.databaseId === 'expense-wallet' && table === 'expense_sync_conflicts'
      ? ` WHERE NOT (${EXPENSE_LEDGER_PRESERVED_REFUND_RELATION_SQL})` : '';
    const row = await input.database.getFirstAsync<{ count: number }>(
      `SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}${removableRows}`,
    );
    deleteRowCounts[table] = Number(row?.count ?? 0);
  }
  const boundRuntimeRows: Record<string, number> = {};
  for (const table of entry.runtimeTables) {
    const sourcePlatformClause = entry.runtimeHasSourcePlatform
      ? ' OR source_platform IS NOT NULL'
      : '';
    const row = await input.database.getFirstAsync<{ count: number }>(
      `SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}
       WHERE capture_enabled <> 0
          OR suppress_capture <> 0
          OR vault_id IS NOT NULL
          OR source_device_id IS NOT NULL
          OR updated_at <> 0${sourcePlatformClause}`,
    );
    boundRuntimeRows[table] = Number(row?.count ?? 0);
  }
  return Object.freeze({
    databaseId: entry.databaseId,
    databaseName: entry.databaseName,
    deleteRowCounts: Object.freeze(deleteRowCounts),
    boundRuntimeRows: Object.freeze(boundRuntimeRows),
    totalDeleteRows: Object.values(deleteRowCounts)
      .reduce((sum, count) => sum + count, 0),
    totalBoundRuntimeRows: Object.values(boundRuntimeRows)
      .reduce((sum, count) => sum + count, 0),
  });
}

export async function resetSyncTechnicalState(input: {
  databaseId: SyncTechnicalResetDatabaseId;
  database: SyncTechnicalResetDatabasePort;
}) {
  const entry = resolveSyncTechnicalResetManifest(input.databaseId);
  const result: {
    before: SyncTechnicalResetInspection | null;
    after: SyncTechnicalResetInspection | null;
  } = { before: null, after: null };
  await input.database.withExclusiveTransactionAsync(async (transaction) => {
    result.before = await inspectSyncTechnicalReset({
      databaseId: input.databaseId,
      database: transaction,
    });
    await transaction.execAsync(entry.resetSql);
    result.after = await inspectSyncTechnicalReset({
      databaseId: input.databaseId,
      database: transaction,
    });
    if (
      result.after.totalDeleteRows !== 0
      || result.after.totalBoundRuntimeRows !== 0
    ) {
      throw new Error(
        `${entry.databaseName} sync technical reset did not reach zero`,
      );
    }
  });
  if (!result.before || !result.after) {
    throw new Error(`${entry.databaseName} sync technical reset did not run`);
  }
  return Object.freeze({
    before: result.before,
    after: result.after,
  });
}
