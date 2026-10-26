export const AUTOMATIC_DATA_SYNC_POLICY_KEY =
  'junluo.sync.automaticDataSyncPolicy.v1' as const;
export const AUTOMATIC_DATA_SYNC_RUNTIME_STATUS_KEY =
  'junluo.sync.automaticDataSyncRuntimeStatus.v1' as const;

export type AutomaticDataSyncPolicyV1 = {
  enabled: boolean;
  version: 1;
};

export type AutomaticDataSyncRuntimeStateV1 =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'syncing'
  | 'waiting-relay'
  | 'waiting-large-file-conditions'
  | 'attention-required';

export type AutomaticDataSyncRuntimeStatusV1 = {
  state: AutomaticDataSyncRuntimeStateV1;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  nextAttemptAt: number | null;
  consecutiveFailures: number;
  workRemaining: boolean;
};

export const defaultAutomaticDataSyncPolicy: AutomaticDataSyncPolicyV1 =
  Object.freeze({ enabled: false, version: 1 });

export const defaultAutomaticDataSyncRuntimeStatus:
Readonly<AutomaticDataSyncRuntimeStatusV1> = Object.freeze({
  state: 'disabled',
  lastAttemptAt: null,
  lastSuccessAt: null,
  nextAttemptAt: null,
  consecutiveFailures: 0,
  workRemaining: false,
});

const STATES = new Set<AutomaticDataSyncRuntimeStateV1>([
  'disabled',
  'idle',
  'checking',
  'syncing',
  'waiting-relay',
  'waiting-large-file-conditions',
  'attention-required',
]);
const FAILURE_BACKOFF_MS = [60_000, 120_000, 300_000, 900_000, 1_800_000];
export const MEMORY_CLEANUP_DRAIN_MINIMUM_INTERVAL_MS = 60_000;

function timestampOrNull(value: unknown) {
  return value === null
    || (Number.isSafeInteger(value) && Number(value) >= 0)
    ? value as number | null
    : null;
}

export function normalizeAutomaticDataSyncPolicy(
  value: unknown,
): AutomaticDataSyncPolicyV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return defaultAutomaticDataSyncPolicy;
  }
  const candidate = value as Partial<AutomaticDataSyncPolicyV1>;
  return candidate.version === 1 && typeof candidate.enabled === 'boolean'
    ? { version: 1, enabled: candidate.enabled }
    : defaultAutomaticDataSyncPolicy;
}

export function parseAutomaticDataSyncPolicy(raw: string | null) {
  if (!raw) return defaultAutomaticDataSyncPolicy;
  try {
    return normalizeAutomaticDataSyncPolicy(JSON.parse(raw) as unknown);
  } catch {
    return defaultAutomaticDataSyncPolicy;
  }
}

export function normalizeAutomaticDataSyncRuntimeStatus(
  value: unknown,
): AutomaticDataSyncRuntimeStatusV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...defaultAutomaticDataSyncRuntimeStatus };
  }
  const candidate = value as Partial<AutomaticDataSyncRuntimeStatusV1>;
  if (
    !STATES.has(candidate.state as AutomaticDataSyncRuntimeStateV1)
    || !Number.isSafeInteger(candidate.consecutiveFailures)
    || Number(candidate.consecutiveFailures) < 0
    || typeof candidate.workRemaining !== 'boolean'
  ) {
    return { ...defaultAutomaticDataSyncRuntimeStatus };
  }
  return {
    state: candidate.state as AutomaticDataSyncRuntimeStateV1,
    lastAttemptAt: timestampOrNull(candidate.lastAttemptAt),
    lastSuccessAt: timestampOrNull(candidate.lastSuccessAt),
    nextAttemptAt: timestampOrNull(candidate.nextAttemptAt),
    consecutiveFailures: Number(candidate.consecutiveFailures),
    workRemaining: candidate.workRemaining,
  };
}

export function parseAutomaticDataSyncRuntimeStatus(raw: string | null) {
  if (!raw) return { ...defaultAutomaticDataSyncRuntimeStatus };
  try {
    return normalizeAutomaticDataSyncRuntimeStatus(JSON.parse(raw) as unknown);
  } catch {
    return { ...defaultAutomaticDataSyncRuntimeStatus };
  }
}

export function automaticDataSyncFailureBackoffMs(
  consecutiveFailures: number,
) {
  const normalized = Math.max(1, Math.trunc(consecutiveFailures));
  return FAILURE_BACKOFF_MS[
    Math.min(normalized, FAILURE_BACKOFF_MS.length) - 1
  ];
}

export function automaticDataSyncCooldownAllowsRun(input: {
  now: number;
  source:
    | 'background'
    | 'cold-start'
    | 'foreground'
    | 'interval'
    | 'local-change'
    | 'resume';
  status: AutomaticDataSyncRuntimeStatusV1;
}) {
  return input.source === 'resume'
    || input.status.nextAttemptAt === null
    || input.status.nextAttemptAt <= input.now
    || (
      input.source === 'local-change'
      && !input.status.workRemaining
    );
}

export function memoryCleanupDrainCooldownAllowsRun(input: {
  now: number;
  status: AutomaticDataSyncRuntimeStatusV1;
}) {
  const lastAttemptAt = input.status.lastAttemptAt;
  if (lastAttemptAt === null) return true;
  const nextAttemptAt = input.status.nextAttemptAt ?? 0;
  return input.now >= Math.max(
    lastAttemptAt + MEMORY_CLEANUP_DRAIN_MINIMUM_INTERVAL_MS,
    nextAttemptAt,
  );
}
