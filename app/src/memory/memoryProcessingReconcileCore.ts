export const MEMORY_RECONCILE_PAGE_SIZE = 10;
export const MEMORY_RECONCILE_SLICE_DELAY_MS = 5_000;
export const MEMORY_RECONCILE_START_DELAY_MS = 60_000;

export type MemoryProcessingReconcileCursor = {
  targetKind?: 'memory' | 'current_state' | 'shiying_record' | 'post_source';
  id: string;
  updatedAt: number;
};

export type MemoryProcessingReconcileReason =
  | 'app_started'
  | 'configuration_changed'
  | 'manual_retry'
  | 'restore_completed'
  | 'data_epoch_changed';

export type MemoryProcessingReconcileState = {
  cleanupPending: boolean;
  cursor: MemoryProcessingReconcileCursor | null;
  dataEpoch: number;
  generation: number;
  nextSliceAt: number;
  pending: boolean;
  reason: MemoryProcessingReconcileReason | null;
  repairCount: number;
  scannedCount: number;
};

export function createMemoryProcessingReconcileState(): MemoryProcessingReconcileState {
  return {
    cleanupPending: false,
    cursor: null,
    dataEpoch: -1,
    generation: 0,
    nextSliceAt: 0,
    pending: false,
    reason: null,
    repairCount: 0,
    scannedCount: 0,
  };
}

export function requestMemoryProcessingReconcileState(
  state: MemoryProcessingReconcileState,
  input: {
    dataEpoch: number;
    notBeforeAt?: number;
    now: number;
    reason: MemoryProcessingReconcileReason;
  },
): MemoryProcessingReconcileState {
  return {
    cleanupPending: true,
    cursor: null,
    dataEpoch: input.dataEpoch,
    generation: state.generation + 1,
    nextSliceAt: Math.max(input.now, input.notBeforeAt ?? input.now),
    pending: true,
    reason: input.reason,
    repairCount: 0,
    scannedCount: 0,
  };
}

export function canRunMemoryProcessingReconcileSlice(
  state: MemoryProcessingReconcileState,
  input: { foreground: boolean; now: number },
) {
  return state.pending && input.foreground && input.now >= state.nextSliceAt;
}

export function isMemoryProcessingKeyAfterCursor(
  key: MemoryProcessingReconcileCursor,
  cursor: MemoryProcessingReconcileCursor | null,
) {
  return cursor === null
    || key.updatedAt > cursor.updatedAt
    || (key.updatedAt === cursor.updatedAt && (key.id > cursor.id
      || key.id === cursor.id && (key.targetKind ?? 'memory') > (cursor.targetKind ?? 'memory')));
}

export function recordMemoryProcessingReconcileItem(
  state: MemoryProcessingReconcileState,
  input: {
    cursor: MemoryProcessingReconcileCursor;
    generation: number;
    repairCount: number;
  },
): MemoryProcessingReconcileState {
  if (!state.pending || state.generation !== input.generation) return state;
  return {
    ...state,
    cleanupPending: false,
    cursor: input.cursor,
    repairCount: state.repairCount + Math.max(0, Math.trunc(input.repairCount)),
    scannedCount: state.scannedCount + 1,
  };
}

export function finishMemoryProcessingReconcileSlice(
  state: MemoryProcessingReconcileState,
  input: { complete: boolean; generation: number; now: number },
): MemoryProcessingReconcileState {
  if (!state.pending || state.generation !== input.generation) return state;
  return {
    ...state,
    nextSliceAt: input.complete ? 0 : input.now + MEMORY_RECONCILE_SLICE_DELAY_MS,
    pending: !input.complete,
  };
}

export function deferMemoryProcessingReconcileAfterFailure(
  state: MemoryProcessingReconcileState,
  input: { generation: number; now: number },
): MemoryProcessingReconcileState {
  if (!state.pending || state.generation !== input.generation) return state;
  return {
    ...state,
    nextSliceAt: input.now + MEMORY_RECONCILE_SLICE_DELAY_MS,
  };
}

export function memoryProcessingReconcileDelayMs(
  state: MemoryProcessingReconcileState,
  now: number,
) {
  return state.pending ? Math.max(0, state.nextSliceAt - now) : 0;
}
