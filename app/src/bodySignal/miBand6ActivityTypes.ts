export type MiBand6ActivityBatch = {
  requestedSinceAt: number;
  startedAt: number;
  observedAt: number;
  // Each [steps, intensity] tuple covers one minute from startedAt.
  samples: Array<[number, number]>;
  // Raw minute count from the device, including a possible current open minute.
  reportedSize: number;
  byteCount: number;
  packetCount: number;
};

export type MiBand6ActivitySyncTrigger =
  | 'manual'
  | 'connected'
  | 'foreground'
  | 'guardian_wakeup'
  | 'sampling_finished';

export type MiBand6ActivityEvidence = { metadata: number[]; firstRecords: number[]; completion: number[] };
export type MiBand6ActivityCandidate = MiBand6ActivityBatch & { evidence?: MiBand6ActivityEvidence };

export type MiBand6ActivitySaveResult = {
  savedCount: number;
  // Exclusive end of the stored complete-minute range; absent for empty/open-only batches.
  syncedThroughAt?: number;
  gap?: { startedAt: number; endedAt: number };
};
