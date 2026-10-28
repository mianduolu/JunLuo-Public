/** One deadline for transport and its body; never accepts a late result. */
export async function withRequestBodyDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const duration = Math.max(1, timeoutMs);
  const expiresAt = Date.now() + duration;
  const timeoutError = new Error('timeout');
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      reject(timeoutError);
      controller.abort();
    }, duration);
  });
  try {
    if (Date.now() >= expiresAt) throw timeoutError;
    const result = await Promise.race([work(controller.signal), timeout]);
    if (expired || Date.now() >= expiresAt) throw timeoutError;
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
