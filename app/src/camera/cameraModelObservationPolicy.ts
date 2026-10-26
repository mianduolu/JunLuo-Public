/** Request preparation only: no native calls, timers, storage or model text. */
export type CameraModelObservationOfferInput = {
  entry:
    | { kind: 'chat_reply'; enforceMinimumInterval: boolean }
    | { kind: 'proactive_contact'; contactOpportunityAvailable: boolean };
  now: number;
  sessionRunning: boolean;
  standbyEnabled: boolean;
  /** Permission, source, vision configuration, network, budget and cleanup are ready. */
  prerequisitesReady: boolean;
  quiet: boolean;
  observationInProgress: boolean;
  alreadySelectedInTurn: boolean;
  minimumIntervalMinutes: number;
  lastAttemptAt?: number;
  lastSuccessfulObservationAt?: number;
};

function isTimestamp(value: number) {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Both the tool definition and its capability text must use this same decision.
 * An immediate retry belongs to the selected operation, not to this offer path.
 * The contact owner decides opportunity availability, including an owned 12th
 * opportunity; this module must not introduce a second daily counter.
 */
export function shouldOfferCameraModelObservation(input: CameraModelObservationOfferInput): boolean {
  if (!isTimestamp(input.now)
    || input.sessionRunning !== true || input.standbyEnabled !== true
    || input.prerequisitesReady !== true || input.quiet
    || input.observationInProgress || input.alreadySelectedInTurn) return false;

  let enforceInterval: boolean;
  if (input.entry.kind === 'proactive_contact') {
    if (input.entry.contactOpportunityAvailable !== true) return false;
    enforceInterval = true;
  } else if (input.entry.kind === 'chat_reply') {
    if (typeof input.entry.enforceMinimumInterval !== 'boolean') return false;
    enforceInterval = input.entry.enforceMinimumInterval;
  } else return false;

  if (!enforceInterval) return true;
  const intervalMs = input.minimumIntervalMinutes * 60_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) return false;
  const anchors = [input.lastAttemptAt, input.lastSuccessfulObservationAt]
    .filter((value): value is number => value !== undefined);
  if (anchors.some(value => !isTimestamp(value))) return false;
  if (anchors.length === 0) return true;
  return input.now - Math.max(...anchors) >= intervalMs;
}
