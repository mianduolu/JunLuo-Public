const SQLITE_LOCK_RETRY_DELAYS_MS = [250, 750, 1_500] as const;
const PATIENT_SQLITE_LOCK_RETRY_DELAYS_MS = [
  500,
  1_500,
  3_000,
  5_000,
  8_000,
] as const;

type WaitForRetry = (delayMs: number) => Promise<void>;

function defaultWaitForRetry(delayMs: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

export function isTransientSqliteLockError(error: unknown) {
  const seen = new Set<unknown>();
  let current: unknown = error;

  for (let depth = 0; depth < 6 && current !== null; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);

    if (typeof current === 'string') {
      if (/database is locked|SQLITE_BUSY/iu.test(current)) return true;
      break;
    }
    if (typeof current !== 'object') break;

    const candidate = current as {
      cause?: unknown;
      code?: unknown;
      message?: unknown;
    };
    const detail = [candidate.code, candidate.message]
      .filter((value): value is string => typeof value === 'string')
      .join(' ');
    if (/database is locked|SQLITE_BUSY/iu.test(detail)) return true;
    current = candidate.cause;
  }

  return false;
}

async function runWithSqliteLockRetryDelays<T>(
  operation: () => Promise<T>,
  waitForRetry: WaitForRetry,
  retryDelaysMs: readonly number[],
) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const delayMs = retryDelaysMs[attempt];
      if (!isTransientSqliteLockError(error) || delayMs === undefined) {
        throw error;
      }
      await waitForRetry(delayMs);
    }
  }
}

export function runWithTransientSqliteLockRetry<T>(
  operation: () => Promise<T>,
  waitForRetry: WaitForRetry = defaultWaitForRetry,
) {
  return runWithSqliteLockRetryDelays(
    operation,
    waitForRetry,
    SQLITE_LOCK_RETRY_DELAYS_MS,
  );
}

export function runWithPatientTransientSqliteLockRetry<T>(
  operation: () => Promise<T>,
  waitForRetry: WaitForRetry = defaultWaitForRetry,
) {
  return runWithSqliteLockRetryDelays(
    operation,
    waitForRetry,
    PATIENT_SQLITE_LOCK_RETRY_DELAYS_MS,
  );
}
