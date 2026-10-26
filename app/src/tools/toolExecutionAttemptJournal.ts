import { bytesToBase64Url } from '../sync/syncBase64Url';
import { sha256BytesV1 } from '../sync/syncCrypto';
import type { JunLuoToolResult } from './toolTypes';

export const TOOL_EXECUTION_ATTEMPT_STORAGE_KEY =
  'junluo.tools.executionAttempts.local.v1' as const;
export const TOOL_EXECUTION_ATTEMPT_MAX_RECORDS = 200;

export type JunLuoToolExecutionAttemptState =
  | 'dispatching'
  | 'outcome_unknown'
  | 'settled_pending_delivery'
  | 'stale_epoch';

export type JunLuoToolExecutionAttemptOutcome =
  | 'completed'
  | 'failed'
  | 'cancelled';

export type JunLuoToolExecutionAttemptRecord = {
  hostExecutionId: string;
  turnId: string;
  sourceMessageId: string;
  sourceSessionId: string;
  providerCallId: string;
  toolId: string;
  conflictKey: string;
  dataEpoch: number;
  state: JunLuoToolExecutionAttemptState;
  createdAt: number;
  dispatchedAt: number;
  deadlineAt: number;
  updatedAt: number;
  outcome?: JunLuoToolExecutionAttemptOutcome;
  executionId?: string;
  auditId?: string;
  proposalId?: string;
};

export type JunLuoToolExecutionAttemptPreparation = Omit<
  JunLuoToolExecutionAttemptRecord,
  'state' | 'updatedAt' | 'outcome'
>;

export type JunLuoToolExecutionAttemptPrepareResult =
  | { status: 'prepared'; record: JunLuoToolExecutionAttemptRecord }
  | { status: 'pending'; record: JunLuoToolExecutionAttemptRecord }
  | { status: 'capacity_exceeded' };

export type JunLuoToolExecutionAttemptStorage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
};

export type JunLuoToolExecutionAttemptJournal = {
  acknowledgeDelivery(hostExecutionId: string): Promise<boolean>;
  findPendingByConflict(conflictKey: string): Promise<JunLuoToolExecutionAttemptRecord | null>;
  findPendingByProviderCall(providerCallId: string): Promise<JunLuoToolExecutionAttemptRecord | null>;
  list(): Promise<JunLuoToolExecutionAttemptRecord[]>;
  markOutcomeUnknown(hostExecutionId: string, updatedAt?: number): Promise<boolean>;
  markSettled(
    hostExecutionId: string,
    outcome: JunLuoToolExecutionAttemptOutcome,
    updatedAt?: number,
  ): Promise<boolean>;
  markAllUnsettledStale(updatedAt?: number): Promise<number>;
  markStaleEpoch(currentDataEpoch: number, updatedAt?: number): Promise<number>;
  prepare(input: JunLuoToolExecutionAttemptPreparation): Promise<JunLuoToolExecutionAttemptPrepareResult>;
  remove(hostExecutionId: string): Promise<boolean>;
};

export type JunLuoToolExecutionReconciliationOutcome =
  | {
      state: 'settled';
      outcome: JunLuoToolExecutionAttemptOutcome;
      result?: JunLuoToolResult;
    }
  | { state: 'not_performed' }
  | { state: 'still_pending' }
  | { state: 'unknown' };

export type JunLuoToolExecutionReconciler = {
  reconcile(
    attempt: JunLuoToolExecutionAttemptRecord,
  ): Promise<JunLuoToolExecutionReconciliationOutcome>;
};

function isSafeId(value: unknown, maximumLength = 512): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maximumLength
    && value === value.trim()
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function optionalSafeId(value: unknown, maximumLength = 512) {
  return value === undefined || isSafeId(value, maximumLength)
    ? value as string | undefined
    : undefined;
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function normalizeRecord(value: unknown): JunLuoToolExecutionAttemptRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Partial<JunLuoToolExecutionAttemptRecord>;
  if (
    !isSafeId(item.hostExecutionId, 128)
    || !isSafeId(item.turnId)
    || !isSafeId(item.sourceMessageId)
    || !isSafeId(item.sourceSessionId)
    || !isSafeId(item.providerCallId)
    || !isSafeId(item.toolId, 256)
    || !isSafeId(item.conflictKey, 256)
    || !isTimestamp(item.dataEpoch)
    || !isTimestamp(item.createdAt)
    || !isTimestamp(item.dispatchedAt)
    || !isTimestamp(item.deadlineAt)
    || !isTimestamp(item.updatedAt)
    || !['dispatching', 'outcome_unknown', 'settled_pending_delivery', 'stale_epoch']
      .includes(String(item.state))
  ) return null;
  const outcome = item.outcome === 'completed'
    || item.outcome === 'failed'
    || item.outcome === 'cancelled'
    ? item.outcome
    : undefined;
  if (item.state === 'settled_pending_delivery' && !outcome) return null;
  return {
    hostExecutionId: item.hostExecutionId,
    turnId: item.turnId,
    sourceMessageId: item.sourceMessageId,
    sourceSessionId: item.sourceSessionId,
    providerCallId: item.providerCallId,
    toolId: item.toolId,
    conflictKey: item.conflictKey,
    dataEpoch: item.dataEpoch,
    state: item.state as JunLuoToolExecutionAttemptState,
    createdAt: item.createdAt,
    dispatchedAt: item.dispatchedAt,
    deadlineAt: item.deadlineAt,
    updatedAt: item.updatedAt,
    ...(outcome ? { outcome } : {}),
    ...(optionalSafeId(item.executionId) ? { executionId: item.executionId } : {}),
    ...(optionalSafeId(item.auditId) ? { auditId: item.auditId } : {}),
    ...(optionalSafeId(item.proposalId) ? { proposalId: item.proposalId } : {}),
  };
}

function normalizeRecords(value: unknown) {
  if (!Array.isArray(value)) return [];
  const byId = new Map<string, JunLuoToolExecutionAttemptRecord>();
  value.forEach((item) => {
    const record = normalizeRecord(item);
    if (record) byId.set(record.hostExecutionId, record);
  });
  return [...byId.values()]
    .sort((left, right) => left.createdAt - right.createdAt)
    .slice(-TOOL_EXECUTION_ATTEMPT_MAX_RECORDS);
}

function cloneRecord(record: JunLuoToolExecutionAttemptRecord) {
  return { ...record };
}

function outcomeFromResult(result: JunLuoToolResult): JunLuoToolExecutionAttemptOutcome {
  if (result.ok) return 'completed';
  return result.status === 'cancelled' ? 'cancelled' : 'failed';
}

export function createToolAgentHostExecutionId(semanticExecutionKey: string) {
  return bytesToBase64Url(sha256BytesV1(new TextEncoder().encode(
    `junluo.tool-agent.execution.v1\n${semanticExecutionKey}`,
  )));
}

export function createToolExecutionAttemptJournal(input: {
  storage: JunLuoToolExecutionAttemptStorage;
  now?: () => number;
}): JunLuoToolExecutionAttemptJournal {
  const now = input.now ?? Date.now;
  let queue = Promise.resolve();
  const read = async () => {
    const raw = await input.storage.getItem(TOOL_EXECUTION_ATTEMPT_STORAGE_KEY);
    if (!raw) return [];
    try {
      return normalizeRecords(JSON.parse(raw) as unknown);
    } catch {
      return [];
    }
  };
  const write = (records: readonly JunLuoToolExecutionAttemptRecord[]) => (
    input.storage.setItem(
      TOOL_EXECUTION_ATTEMPT_STORAGE_KEY,
      JSON.stringify(normalizeRecords(records)),
    )
  );
  const mutate = <T>(work: (records: JunLuoToolExecutionAttemptRecord[]) => Promise<T> | T) => {
    const current = queue.catch(() => undefined).then(async () => {
      const records = await read();
      const result = await work(records);
      await write(records);
      return result;
    });
    queue = current.then(() => undefined, () => undefined);
    return current;
  };

  return {
    async list() {
      await queue.catch(() => undefined);
      return (await read()).map(cloneRecord);
    },
    async findPendingByConflict(conflictKey) {
      return (await this.list()).find((record) => (
        record.conflictKey === conflictKey
        && record.state !== 'settled_pending_delivery'
      )) ?? null;
    },
    async findPendingByProviderCall(providerCallId) {
      return (await this.list()).find((record) => (
        record.providerCallId === providerCallId
        && record.state !== 'settled_pending_delivery'
      )) ?? null;
    },
    prepare(preparation) {
      return mutate((records) => {
        const duplicate = records.find((record) => (
          record.hostExecutionId === preparation.hostExecutionId
          || (
            record.conflictKey === preparation.conflictKey
            && record.state !== 'settled_pending_delivery'
          )
        ));
        if (duplicate) return { status: 'pending', record: cloneRecord(duplicate) } as const;
        if (records.length >= TOOL_EXECUTION_ATTEMPT_MAX_RECORDS) {
          return { status: 'capacity_exceeded' } as const;
        }
        const record: JunLuoToolExecutionAttemptRecord = {
          ...preparation,
          state: 'dispatching',
          updatedAt: now(),
        };
        records.push(record);
        return { status: 'prepared', record: cloneRecord(record) } as const;
      });
    },
    markOutcomeUnknown(hostExecutionId, updatedAt = now()) {
      return mutate((records) => {
        const record = records.find((item) => item.hostExecutionId === hostExecutionId);
        if (!record || record.state === 'settled_pending_delivery') return false;
        Object.assign(record, { state: 'outcome_unknown', updatedAt });
        return true;
      });
    },
    markSettled(hostExecutionId, outcome, updatedAt = now()) {
      return mutate((records) => {
        const record = records.find((item) => item.hostExecutionId === hostExecutionId);
        if (!record) return false;
        Object.assign(record, {
          state: 'settled_pending_delivery',
          outcome,
          updatedAt,
        });
        return true;
      });
    },
    markAllUnsettledStale(updatedAt = now()) {
      return mutate((records) => {
        let changed = 0;
        records.forEach((record) => {
          if (
            record.state !== 'settled_pending_delivery'
            && record.state !== 'stale_epoch'
          ) {
            Object.assign(record, { state: 'stale_epoch', updatedAt });
            changed += 1;
          }
        });
        return changed;
      });
    },
    markStaleEpoch(currentDataEpoch, updatedAt = now()) {
      return mutate((records) => {
        let changed = 0;
        records.forEach((record) => {
          if (
            record.dataEpoch !== currentDataEpoch
            && record.state !== 'settled_pending_delivery'
            && record.state !== 'stale_epoch'
          ) {
            Object.assign(record, { state: 'stale_epoch', updatedAt });
            changed += 1;
          }
        });
        return changed;
      });
    },
    acknowledgeDelivery(hostExecutionId) {
      return this.remove(hostExecutionId);
    },
    remove(hostExecutionId) {
      return mutate((records) => {
        const index = records.findIndex((item) => item.hostExecutionId === hostExecutionId);
        if (index < 0) return false;
        records.splice(index, 1);
        return true;
      });
    },
  };
}

export function createMemoryToolExecutionAttemptJournal(
  now: () => number = Date.now,
) {
  let raw: string | null = null;
  return createToolExecutionAttemptJournal({
    now,
    storage: {
      getItem: async () => raw,
      setItem: async (_key, value) => { raw = value; },
    },
  });
}

export async function reconcileToolExecutionAttempts(input: {
  journal: JunLuoToolExecutionAttemptJournal;
  currentDataEpoch: number;
  reconcilers: ReadonlyMap<string, JunLuoToolExecutionReconciler>;
  onSettled: (input: {
    attempt: JunLuoToolExecutionAttemptRecord;
    result?: JunLuoToolResult;
    outcome: JunLuoToolExecutionAttemptOutcome;
  }) => Promise<void>;
}) {
  await input.journal.markStaleEpoch(input.currentDataEpoch);
  const attempts = await input.journal.list();
  const results: Array<{
    hostExecutionId: string;
    state: JunLuoToolExecutionReconciliationOutcome['state'] | 'stale_epoch';
  }> = [];
  for (const attempt of attempts) {
    if (attempt.dataEpoch !== input.currentDataEpoch || attempt.state === 'stale_epoch') {
      results.push({ hostExecutionId: attempt.hostExecutionId, state: 'stale_epoch' });
      continue;
    }
    if (attempt.state === 'settled_pending_delivery' && attempt.outcome) {
      try {
        await input.onSettled({ attempt, outcome: attempt.outcome });
        await input.journal.acknowledgeDelivery(attempt.hostExecutionId);
      } catch {
        // Keep the receipt so startup can retry delivery without re-executing the tool.
      }
      results.push({ hostExecutionId: attempt.hostExecutionId, state: 'settled' });
      continue;
    }
    const reconciler = input.reconcilers.get(attempt.toolId);
    let outcome: JunLuoToolExecutionReconciliationOutcome;
    try {
      outcome = reconciler
        ? await reconciler.reconcile(cloneRecord(attempt))
        : { state: 'unknown' };
    } catch {
      outcome = { state: 'unknown' };
    }
    if (outcome.state === 'settled') {
      await input.journal.markSettled(attempt.hostExecutionId, outcome.outcome);
      try {
        await input.onSettled({
          attempt,
          outcome: outcome.outcome,
          result: outcome.result,
        });
        await input.journal.acknowledgeDelivery(attempt.hostExecutionId);
      } catch {
        // Keep settled_pending_delivery for a later delivery pass.
      }
    } else if (outcome.state === 'not_performed') {
      await input.journal.remove(attempt.hostExecutionId);
    } else {
      await input.journal.markOutcomeUnknown(attempt.hostExecutionId);
    }
    results.push({ hostExecutionId: attempt.hostExecutionId, state: outcome.state });
  }
  return results;
}

export function toolExecutionAttemptOutcomeFromResult(result: JunLuoToolResult) {
  return outcomeFromResult(result);
}
