import {
  beginRuntimeWorkload,
  type RuntimeWorkloadOutcome,
  type RuntimeWorkloadSpan,
  type RuntimeWorkloadStage,
} from './runtimeWorkloadDiagnostics';

export type DatabaseWorkloadStage = Extract<RuntimeWorkloadStage, `database.${string}`>;

type BeginDatabaseWorkload = (stage: DatabaseWorkloadStage) => RuntimeWorkloadSpan | null;

type SlowDatabaseWorkloadObserverOptions = {
  cancel?: (handle: unknown) => void;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  thresholdMs?: number;
};

export const DATABASE_SLOW_OPERATION_THRESHOLD_MS = 1_000;

export function isSqliteLockedError(error: unknown) {
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; current !== null && current !== undefined && depth < 5; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    if (typeof current === 'string') return /database is locked|SQLITE_BUSY/iu.test(current);
    if (typeof current !== 'object') break;
    const candidate = current as { cause?: unknown; code?: unknown; message?: unknown };
    const fixedFields = [candidate.code, candidate.message]
      .filter((value): value is string => typeof value === 'string')
      .join(' ');
    if (/database is locked|SQLITE_BUSY/iu.test(fixedFields)) return true;
    current = candidate.cause;
  }
  return false;
}

function outcomeForDatabaseError(error: unknown): RuntimeWorkloadOutcome {
  return isSqliteLockedError(error) ? 'locked' : 'failed';
}

export function createDatabaseWorkloadObserver(
  begin: BeginDatabaseWorkload,
) {
  return function observeDatabaseWorkload<T>(
    stage: DatabaseWorkloadStage,
    operation: () => Promise<T>,
  ): Promise<T> {
    const span = begin(stage);
    if (!span) return operation();
    let pending: Promise<T>;
    try {
      pending = operation();
    } catch (error) {
      span.finish(outcomeForDatabaseError(error));
      throw error;
    }
    return pending.then(
      (value) => {
        span.finish('ok');
        return value;
      },
      (error) => {
        span.finish(outcomeForDatabaseError(error));
        throw error;
      },
    );
  };
}

export function createSlowDatabaseWorkloadObserver(
  begin: BeginDatabaseWorkload,
  options: SlowDatabaseWorkloadObserverOptions = {},
) {
  const schedule = options.schedule ?? ((callback: () => void, delayMs: number) => (
    setTimeout(callback, delayMs)
  ));
  const cancel = options.cancel ?? ((handle: unknown) => clearTimeout(
    handle as ReturnType<typeof setTimeout>,
  ));
  const thresholdMs = options.thresholdMs ?? DATABASE_SLOW_OPERATION_THRESHOLD_MS;

  return function observeSlowDatabaseWorkload<T>(
    stage: DatabaseWorkloadStage,
    operation: () => Promise<T>,
  ): Promise<T> {
    let pending: Promise<T>;
    try {
      pending = operation();
    } catch (error) {
      throw error;
    }
    let span: RuntimeWorkloadSpan | null = null;
    const timer = schedule(() => {
      span = begin(stage);
    }, thresholdMs);
    return pending.then(
      (value) => {
        cancel(timer);
        span?.finish('ok');
        return value;
      },
      (error) => {
        cancel(timer);
        span?.finish(outcomeForDatabaseError(error));
        throw error;
      },
    );
  };
}

export const observeDatabaseWorkload = createDatabaseWorkloadObserver(
  beginRuntimeWorkload,
);

export const observeSlowDatabaseWorkload = createSlowDatabaseWorkloadObserver(
  beginRuntimeWorkload,
);
