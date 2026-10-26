export async function resolvePromiseWithFallback<T>(
  promise: Promise<T>,
  fallback: T,
  timeoutMs: number,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timeoutId = setTimeout(() => resolve(fallback), Math.max(1, timeoutMs));
  });

  try {
    return await Promise.race([promise, timeout]);
  } catch {
    return fallback;
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}
