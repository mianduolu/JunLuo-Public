export const AI_CALL_BUDGET_KEY = 'junluo.aiCallBudget.v1' as const;
export const AI_CALL_BUDGET_WINDOW_MS = 24 * 60 * 60 * 1000;
export const AI_CALL_BUDGET_MAX_RECORDS = 160;
export const AI_COST_WINDOW_MS = 60 * 60 * 1000;
export const AI_COST_MAX_PAPER_REQUESTS = 4;
export const AI_CALL_PURPOSES = ['proactive-contact', 'inner-wants', 'inner-affect', 'home-status',
  'dream', 'life-diary', 'web-voyage', 'manual-chat', 'day-plan', 'sleep-decision', 'other'] as const;
export type AiCallPurpose = typeof AI_CALL_PURPOSES[number];

export const AI_CALL_KINDS = Object.freeze([
  'affectState',
  'sleepNearStatus',
  'afterglow',
  'cameraVision',
  'chatVision',
  'reading',
  'dayPlan',
  'postReply',
  'postVision',
  'giftReception',
  'giftUnderstanding',
  'giftReply',
  'giftCreation',
  'contextualLetter',
  'dream',
  'embeddingBackfill',
  'lifeDiary',
  'loveSummary',
  'lifeStatePolish',
  'proactive',
  'userParse',
  'memoryWeeklyRefresh',
  'memoryPostOrganize',
] as const);

export const AI_CALL_PRIORITIES = Object.freeze([
  'background',
  'critical',
  'night',
  'normal',
  'urgent',
] as const);

export type AiCallBudgetKind = typeof AI_CALL_KINDS[number];
export type AiCallBudgetPriority = typeof AI_CALL_PRIORITIES[number];
export type AiCallBudgetRecordScope =
  | 'device'
  | 'legacy-device'
  | 'remote-account';

export type AiCallBudgetRecord = {
  id: string;
  endedAt: number;
  kind: AiCallBudgetKind;
  priority: AiCallBudgetPriority;
  scope: AiCallBudgetRecordScope;
  startedAt: number;
  remoteAccountId?: string;
  purpose?: AiCallPurpose;
  costRestricted?: true;
};

export type AiCallBudgetState = {
  records: AiCallBudgetRecord[];
  version: 2;
};

function isEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is T {
  return typeof value === 'string' && allowed.includes(value as T);
}

function timestamp(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : null;
}

function legacyRecordId(input: {
  endedAt: number;
  index: number;
  kind: string;
  priority: string;
  startedAt: number;
}) {
  return [
    'legacy-ai-call',
    input.startedAt,
    input.endedAt,
    input.kind,
    input.priority,
    input.index,
  ].join('-');
}

function normalizeRecord(
  value: unknown,
  index: number,
): AiCallBudgetRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<AiCallBudgetRecord>;
  const startedAt = timestamp(candidate.startedAt);
  const endedAt = timestamp(candidate.endedAt);
  if (
    startedAt === null
    || endedAt === null
    || endedAt < startedAt
    || !isEnum(candidate.kind, AI_CALL_KINDS)
    || !isEnum(candidate.priority, AI_CALL_PRIORITIES)
  ) {
    return null;
  }
  const scope = isEnum(
    candidate.scope,
    ['device', 'legacy-device', 'remote-account'] as const,
  )
    ? candidate.scope
    : 'legacy-device';
  const purpose = isEnum(candidate.purpose, AI_CALL_PURPOSES) ? candidate.purpose : undefined;
  const cost = {
    ...(purpose ? { purpose } : {}),
    ...(candidate.costRestricted === true && purpose && ['inner-wants', 'inner-affect', 'home-status'].includes(purpose)
      ? { costRestricted: true as const } : {}),
  };
  const id = typeof candidate.id === 'string' && candidate.id.length > 0
    && candidate.id.length <= 256
    ? candidate.id
    : legacyRecordId({
        endedAt,
        index,
        kind: candidate.kind,
        priority: candidate.priority,
        startedAt,
      });
  if (scope === 'remote-account') {
    if (
      typeof candidate.remoteAccountId !== 'string'
      || candidate.remoteAccountId.length < 1
      || candidate.remoteAccountId.length > 256
    ) {
      return null;
    }
    return {
      ...cost,
      id,
      endedAt,
      kind: candidate.kind,
      priority: candidate.priority,
      remoteAccountId: candidate.remoteAccountId,
      scope,
      startedAt,
    };
  }
  return {
    ...cost,
    id,
    endedAt,
    kind: candidate.kind,
    priority: candidate.priority,
    scope,
    startedAt,
  };
}

export function normalizeAiCallBudgetState(
  value: unknown,
  now = Date.now(),
): AiCallBudgetState {
  const candidate = value && typeof value === 'object' && !Array.isArray(value)
    ? value as { records?: unknown }
    : {};
  const seen = new Set<string>();
  const records = Array.isArray(candidate.records)
    ? candidate.records
        .map(normalizeRecord)
        .filter((record): record is AiCallBudgetRecord => (
          record !== null
          && now - record.endedAt < AI_CALL_BUDGET_WINDOW_MS
          && !seen.has(record.id)
          && Boolean(seen.add(record.id))
        ))
    : [];
  // A busy chat/connection must not evict still-live peak usage before its hour expires.
  const ordinary = new Set(records.filter(record => !isRecentCostRecord(record, now)).slice(-AI_CALL_BUDGET_MAX_RECORDS).map(record => record.id));
  return { records: records.filter(record => isRecentCostRecord(record, now) || ordinary.has(record.id)), version: 2 };
}

export function isRecentCostRecord(record: AiCallBudgetRecord, now: number) {
  return record.costRestricted === true && now - record.startedAt < AI_COST_WINDOW_MS;
}

export function getCostRequestRetryAt(records: readonly AiCallBudgetRecord[], now: number) {
  const live = records.filter(record => isRecentCostRecord(record, now)).sort((a, b) => a.startedAt - b.startedAt);
  return live.length >= AI_COST_MAX_PAPER_REQUESTS ? live[live.length - AI_COST_MAX_PAPER_REQUESTS].startedAt + AI_COST_WINDOW_MS : undefined;
}

export function parseAiCallBudgetState(
  raw: string | null,
  now = Date.now(),
) {
  if (!raw) return { records: [], version: 2 } satisfies AiCallBudgetState;
  try {
    return normalizeAiCallBudgetState(JSON.parse(raw) as unknown, now);
  } catch {
    return { records: [], version: 2 } satisfies AiCallBudgetState;
  }
}

export function serializeAiCallBudgetState(
  state: AiCallBudgetState,
  now = Date.now(),
) {
  return JSON.stringify(normalizeAiCallBudgetState(state, now));
}

export function isRemoteAiCallBudgetRecord(
  record: AiCallBudgetRecord,
): record is AiCallBudgetRecord & {
  scope: 'remote-account';
  remoteAccountId: string;
} {
  return record.scope === 'remote-account'
    && typeof record.remoteAccountId === 'string';
}
