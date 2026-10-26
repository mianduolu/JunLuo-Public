import type { ScreenName } from '../types/navigation';

export type AutomaticDataSyncTierV1 =
  | 'gentle'
  | 'balanced'
  | 'catch-up';

export type AutomaticDataSyncBudgetV1 = {
  tier: AutomaticDataSyncTierV1;
  maxSendBatches: number;
  maxReceivePages: number;
  maxConsumedEntries: number;
  runtimeLimitMs: number;
  maximumObjectChunks: number;
};

export type AutomaticDataSyncProgressV1 = {
  phase:
    | 'idle'
    | 'checking'
    | 'sending'
    | 'receiving'
    | 'materializing'
    | 'files'
    | 'paused'
    | 'waiting-relay'
    | 'attention-required';
  tier: AutomaticDataSyncTierV1;
  queues: {
    pendingOutgoing: number;
    waitingAtRelay: number;
    receivedAwaitingApply: number;
    conflicts: number;
    quarantined: number;
    objectJobs: number;
    blockedObjectJobs: number;
    completedObjectChunks: number;
    totalObjectChunks: number;
  };
  lastRound: {
    sent: number;
    received: number;
    materialized: number;
    durationMs: number;
    stoppedBy:
      | 'complete'
      | 'item-limit'
      | 'time-limit'
      | 'paused'
      | 'error';
  } | null;
  updatedAt: number;
};

export const EMPTY_AUTOMATIC_DATA_SYNC_QUEUES:
AutomaticDataSyncProgressV1['queues'] = Object.freeze({
  pendingOutgoing: 0,
  waitingAtRelay: 0,
  receivedAwaitingApply: 0,
  conflicts: 0,
  quarantined: 0,
  objectJobs: 0,
  blockedObjectJobs: 0,
  completedObjectChunks: 0,
  totalObjectChunks: 0,
});

export function selectAutomaticDataSyncBudget(
  ordinaryBacklog: number,
  input: { background?: boolean; maximumObjectChunks?: number } = {},
): AutomaticDataSyncBudgetV1 {
  const normalized = Math.max(0, Math.trunc(ordinaryBacklog));
  const maximumObjectChunks = Math.max(
    0,
    Math.trunc(input.maximumObjectChunks ?? 2),
  );
  if (input.background || normalized <= 64) {
    return {
      tier: 'gentle',
      maxSendBatches: 1,
      maxReceivePages: 1,
      maxConsumedEntries: 16,
      runtimeLimitMs: 15_000,
      maximumObjectChunks,
    };
  }
  if (normalized <= 512) {
    return {
      tier: 'balanced',
      maxSendBatches: 2,
      maxReceivePages: 2,
      maxConsumedEntries: 32,
      runtimeLimitMs: 20_000,
      maximumObjectChunks,
    };
  }
  return {
    tier: 'catch-up',
    maxSendBatches: 3,
    maxReceivePages: 3,
    maxConsumedEntries: 48,
    runtimeLimitMs: 25_000,
    maximumObjectChunks,
  };
}

const HEAVY_AUTOMATIC_SYNC_SCREENS = new Set<ScreenName>([
  'camera-perception',
  'focus',
  'co-reading',
  'backup',
]);

export function automaticDataSyncScreenAllowsFullRun(input: {
  screen: ScreenName;
  chatBusy: boolean;
  exclusiveBusy: boolean;
  voiceCallActive: boolean;
}) {
  if (input.exclusiveBusy || input.voiceCallActive) return false;
  if (HEAVY_AUTOMATIC_SYNC_SCREENS.has(input.screen)) return false;
  if (input.screen === 'chat') return !input.chatBusy;
  return true;
}

export function automaticDataSyncOrdinaryBacklog(
  queues: AutomaticDataSyncProgressV1['queues'],
) {
  return queues.pendingOutgoing
    + queues.waitingAtRelay
    + queues.receivedAwaitingApply;
}
