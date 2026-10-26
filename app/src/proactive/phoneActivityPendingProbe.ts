export async function runPhoneActivityPendingProbe<T>({
  consumeOverlayExit,
  peekPendingTrigger,
  processPendingTrigger,
}: {
  consumeOverlayExit: () => Promise<void>;
  peekPendingTrigger: () => Promise<T | null>;
  processPendingTrigger: (trigger: T) => Promise<number>;
}) {
  await consumeOverlayExit();
  const pendingTrigger = await peekPendingTrigger();
  if (pendingTrigger === null) return 0;
  return processPendingTrigger(pendingTrigger);
}
