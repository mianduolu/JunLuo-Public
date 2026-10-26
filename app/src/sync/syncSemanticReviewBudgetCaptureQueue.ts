let semanticReviewBudgetCaptureQueue = Promise.resolve();

export function runSemanticReviewBudgetCaptureExclusive<T>(
  callback: () => Promise<T>,
) {
  const current = semanticReviewBudgetCaptureQueue
    .catch(() => undefined)
    .then(callback);
  semanticReviewBudgetCaptureQueue = current.then(
    () => undefined,
    () => undefined,
  );
  return current;
}
