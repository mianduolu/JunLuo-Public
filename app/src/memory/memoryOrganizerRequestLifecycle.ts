export const MEMORY_ORGANIZER_BACKGROUND_TIMEOUT_MS = 20_000;

export class MemoryOrganizerRequestTimeoutError extends Error {
  readonly code = 'memory-organizer-timeout';

  constructor(readonly timeoutMs = MEMORY_ORGANIZER_BACKGROUND_TIMEOUT_MS) {
    super('memory-organizer-timeout');
    this.name = 'MemoryOrganizerRequestTimeoutError';
  }
}

export function isMemoryOrganizerRequestTimeoutError(
  error: unknown,
): error is MemoryOrganizerRequestTimeoutError {
  return error instanceof MemoryOrganizerRequestTimeoutError
    || (
      error instanceof Error
      && (error as Error & { code?: unknown }).code === 'memory-organizer-timeout'
    );
}

export async function runMemoryOrganizerRequestWithDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? MEMORY_ORGANIZER_BACKGROUND_TIMEOUT_MS;
  const timeoutError = new MemoryOrganizerRequestTimeoutError(timeoutMs);
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const cancelled = () => Object.assign(new Error('memory-organizer-cancelled'), { name: 'AbortError' });
  if (options.signal?.aborted) throw cancelled();

  const operationPromise = Promise.resolve().then(() => {
    if (controller.signal.aborted) throw cancelled();
    return operation(controller.signal);
  });
  void operationPromise.catch(() => undefined);
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      try {
        controller.abort();
      } finally {
        reject(timeoutError);
      }
    }, timeoutMs);
    onAbort = () => {
      controller.abort();
      reject(cancelled());
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
  });

  try {
    return await Promise.race([operationPromise, timeoutPromise]);
  } catch (error) {
    if (timedOut) throw timeoutError;
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) options.signal?.removeEventListener('abort', onAbort);
  }
}
