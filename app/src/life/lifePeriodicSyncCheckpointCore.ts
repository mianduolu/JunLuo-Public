export const LIFE_PERIODIC_SYNC_INTERVAL_MS = 60 * 60 * 1000;

export const LIFE_PERIODIC_SYNC_COMPONENTS = Object.freeze([
  'drive',
  'rhythm',
  'desire',
] as const);

export type LifePeriodicSyncComponent =
  typeof LIFE_PERIODIC_SYNC_COMPONENTS[number];

export type LifePeriodicSyncCheckpointV1 = {
  version: 1;
  lastSharedAt: number | null;
  pending: {
    startedAt: number;
    completed: LifePeriodicSyncComponent[];
  } | null;
};

export const emptyLifePeriodicSyncCheckpoint =
(): LifePeriodicSyncCheckpointV1 => ({
  version: 1,
  lastSharedAt: null,
  pending: null,
});

function timestampOrNull(value: unknown) {
  return value === null
    || (Number.isSafeInteger(value) && Number(value) >= 0)
    ? value as number | null
    : null;
}

export function normalizeLifePeriodicSyncCheckpoint(
  value: unknown,
): LifePeriodicSyncCheckpointV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return emptyLifePeriodicSyncCheckpoint();
  }
  const candidate = value as Partial<LifePeriodicSyncCheckpointV1>;
  if (candidate.version !== 1) return emptyLifePeriodicSyncCheckpoint();
  const lastSharedAt = timestampOrNull(candidate.lastSharedAt);
  if (candidate.pending === null || candidate.pending === undefined) {
    return { version: 1, lastSharedAt, pending: null };
  }
  if (
    typeof candidate.pending !== 'object'
    || Array.isArray(candidate.pending)
    || !Number.isSafeInteger(candidate.pending.startedAt)
    || candidate.pending.startedAt < 0
    || !Array.isArray(candidate.pending.completed)
  ) {
    return emptyLifePeriodicSyncCheckpoint();
  }
  const completed = [...new Set(candidate.pending.completed)].filter(
    (entry): entry is LifePeriodicSyncComponent => (
      LIFE_PERIODIC_SYNC_COMPONENTS.includes(
        entry as LifePeriodicSyncComponent,
      )
    ),
  );
  return {
    version: 1,
    lastSharedAt,
    pending: {
      startedAt: candidate.pending.startedAt,
      completed,
    },
  };
}

export function beginLifePeriodicSyncCheckpoint(
  checkpoint: LifePeriodicSyncCheckpointV1,
  now: number,
) {
  const due = checkpoint.pending !== null
    || checkpoint.lastSharedAt === null
    || now - checkpoint.lastSharedAt >= LIFE_PERIODIC_SYNC_INTERVAL_MS;
  if (!due) return checkpoint;
  return checkpoint.pending
    ? checkpoint
    : {
        ...checkpoint,
        pending: { startedAt: now, completed: [] },
      };
}

export function shouldSynchronizeLifePeriodicComponent(
  checkpoint: LifePeriodicSyncCheckpointV1,
  component: LifePeriodicSyncComponent,
) {
  return checkpoint.pending !== null
    && !checkpoint.pending.completed.includes(component);
}

export function completeLifePeriodicSyncComponent(
  checkpoint: LifePeriodicSyncCheckpointV1,
  component: LifePeriodicSyncComponent,
  completedAt: number,
): LifePeriodicSyncCheckpointV1 {
  if (!checkpoint.pending) return checkpoint;
  const completed = [...new Set([
    ...checkpoint.pending.completed,
    component,
  ])];
  if (
    LIFE_PERIODIC_SYNC_COMPONENTS.every((entry) => completed.includes(entry))
  ) {
    return {
      version: 1,
      lastSharedAt: completedAt,
      pending: null,
    };
  }
  return {
    ...checkpoint,
    pending: { ...checkpoint.pending, completed },
  };
}
