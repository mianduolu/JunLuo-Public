export type EmbeddingRequestBudget = 'interactive' | 'connection-test' | 'background';

export const EMBEDDING_REQUEST_TIMEOUT_MS: Record<EmbeddingRequestBudget, number> = {
  interactive: 8_000,
  'connection-test': 10_000,
  background: 20_000,
};

export class EmbeddingRequestTimeoutError extends Error {
  readonly code = 'embedding-timeout';

  constructor(
    readonly budget: EmbeddingRequestBudget,
    readonly timeoutMs: number,
  ) {
    super('embedding-timeout');
    this.name = 'EmbeddingRequestTimeoutError';
  }
}

export function isEmbeddingRequestTimeoutError(
  error: unknown,
): error is EmbeddingRequestTimeoutError {
  return error instanceof EmbeddingRequestTimeoutError
    || (
      error instanceof Error
      && (error as Error & { code?: unknown }).code === 'embedding-timeout'
    );
}

function createEmbeddingRequestCancelledError() {
  const error = new Error('embedding-cancelled');
  error.name = 'AbortError';
  return error;
}

export function isEmbeddingRequestCancelledError(error: unknown) {
  return error instanceof Error && error.name === 'AbortError';
}

export async function runEmbeddingRequestWithDeadline<T>(
  budget: EmbeddingRequestBudget,
  operation: (signal: AbortSignal) => Promise<T>,
  upstreamSignal?: AbortSignal,
): Promise<T> {
  const timeoutMs = EMBEDDING_REQUEST_TIMEOUT_MS[budget];
  const timeoutError = new EmbeddingRequestTimeoutError(budget, timeoutMs);
  const controller = new AbortController();
  let timedOut = false;
  let upstreamAborted = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectUpstream: ((error: Error) => void) | undefined;

  const abortFromUpstream = () => {
    upstreamAborted = true;
    controller.abort();
    rejectUpstream?.(createEmbeddingRequestCancelledError());
  };
  if (upstreamSignal?.aborted) abortFromUpstream();
  else upstreamSignal?.addEventListener('abort', abortFromUpstream, { once: true });

  const operationPromise = Promise.resolve().then(() => operation(controller.signal));
  void operationPromise.catch(() => undefined);
  const upstreamPromise = new Promise<never>((_, reject) => {
    rejectUpstream = reject;
    if (upstreamAborted) reject(createEmbeddingRequestCancelledError());
  });
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      try {
        controller.abort();
      } finally {
        reject(timeoutError);
      }
    }, timeoutMs);
  });

  try {
    return await Promise.race([operationPromise, timeoutPromise, upstreamPromise]);
  } catch (error) {
    if (timedOut) throw timeoutError;
    if (upstreamAborted) throw createEmbeddingRequestCancelledError();
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    upstreamSignal?.removeEventListener('abort', abortFromUpstream);
  }
}

export async function resolveOptionalEmbedding<T>(
  operation: () => Promise<T[]>,
  upstreamSignal?: AbortSignal,
): Promise<T[]> {
  try {
    return await operation();
  } catch (error) {
    if (upstreamSignal?.aborted) throw createEmbeddingRequestCancelledError();
    return [];
  }
}
