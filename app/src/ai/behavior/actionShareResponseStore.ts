import { proactiveLedgerStorageBridge as AsyncStorage } from '../../sync/syncProactiveLedgerStorageBridge';
import {
  BAIYUN_PENDING_SHARE_EXCHANGES_KEY,
  buildBaiyunFixedPendingSharesPrompt,
  buildBaiyunPendingSharesPrompt,
  canRegisterBaiyunSelfDrivenShare,
  getBaiyunActiveShareExchanges,
  getBaiyunFixedPendingSharePromptItems,
  getBaiyunPendingSharePromptItems,
  getBaiyunPendingShareSettlementItems,
  normalizeBaiyunShareExcerpt,
  registerBaiyunShareExchangeInRecords,
  resolveBaiyunShareResponsesInRecords,
  type BaiyunPendingShareExchange,
  type BaiyunPendingShareInvitationKind,
  type BaiyunPendingShareOrigin,
  type BaiyunPendingShareResponseDriveKey,
  type BaiyunShareResponseResolution,
} from './actionShareResponse';

const MAX_STORED_TERMINAL_SHARES = 40;

function stableHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function normalizeStringArray(
  value: unknown,
  maximumCount: number,
  allowed?: readonly string[],
) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => (
    typeof item === 'string'
    && item.length > 0
    && (!allowed || allowed.includes(item))
  )))].slice(0, maximumCount);
}

export function normalizeBaiyunPendingShareExchange(
  value: unknown,
): BaiyunPendingShareExchange | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Partial<BaiyunPendingShareExchange>;
  if (
    typeof candidate.id !== 'string'
    || !candidate.id
    || typeof candidate.sessionId !== 'string'
    || !candidate.sessionId
    || !['chat_action', 'letter', 'web_voyage', 'social_share', 'life_project_share'].includes(candidate.origin ?? '')
    || !['self_driven', 'you_invited'].includes(candidate.invitationKind ?? '')
    || !['waiting', 'engaged', 'declined', 'unanswered'].includes(candidate.state ?? '')
    || typeof candidate.createdAt !== 'number'
    || !Number.isSafeInteger(candidate.createdAt)
    || typeof candidate.excerpt !== 'string'
  ) return undefined;
  const sourceMessageIds = normalizeStringArray(candidate.sourceMessageIds, 16);
  if (!sourceMessageIds.length) return undefined;
  const responseDriveKeys = normalizeStringArray(
    candidate.responseDriveKeys,
    2,
    ['reflection', 'social'],
  ) as BaiyunPendingShareResponseDriveKey[];
  return {
    id: candidate.id,
    sessionId: candidate.sessionId,
    origin: candidate.origin as BaiyunPendingShareOrigin,
    invitationKind: candidate.invitationKind as BaiyunPendingShareInvitationKind,
    sourceMessageIds,
    responseDriveKeys,
    excerpt: normalizeBaiyunShareExcerpt(candidate.excerpt),
    state: candidate.state as BaiyunPendingShareExchange['state'],
    createdAt: candidate.createdAt,
    resolvedAt: typeof candidate.resolvedAt === 'number' && Number.isSafeInteger(candidate.resolvedAt)
      ? candidate.resolvedAt
      : undefined,
    responseMessageId: typeof candidate.responseMessageId === 'string' && candidate.responseMessageId
      ? candidate.responseMessageId
      : undefined,
  };
}

function trimStoredRecords(records: readonly BaiyunPendingShareExchange[]) {
  const active = records.filter((record) => record.state === 'waiting');
  const terminal = records
    .filter((record) => record.state !== 'waiting')
    .sort((left, right) => (right.resolvedAt ?? right.createdAt) - (left.resolvedAt ?? left.createdAt))
    .slice(0, MAX_STORED_TERMINAL_SHARES);
  return [...active, ...terminal];
}

export async function loadBaiyunPendingShareExchanges() {
  const raw = await AsyncStorage.getItem(BAIYUN_PENDING_SHARE_EXCHANGES_KEY);
  if (!raw) return [] as BaiyunPendingShareExchange[];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeBaiyunPendingShareExchange)
      .filter((record): record is BaiyunPendingShareExchange => Boolean(record));
  } catch {
    return [];
  }
}

async function saveBaiyunPendingShareExchanges(
  records: readonly BaiyunPendingShareExchange[],
) {
  const normalized = trimStoredRecords(records);
  await AsyncStorage.setItem(
    BAIYUN_PENDING_SHARE_EXCHANGES_KEY,
    JSON.stringify(normalized),
  );
  return normalized;
}

let shareMutationQueue: Promise<unknown> = Promise.resolve();

function enqueueShareMutation<T>(mutate: () => Promise<T>) {
  let resolveResult: (value: T) => void;
  let rejectResult: (reason: unknown) => void;
  const result = new Promise<T>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  shareMutationQueue = shareMutationQueue.catch(() => undefined).then(async () => {
    try {
      resolveResult(await mutate());
    } catch (error) {
      rejectResult(error);
    }
  });
  return result;
}

export async function loadBaiyunPendingSharePromptContext(
  sessionId: string,
  replyToMessageId?: string,
) {
  const records = await loadBaiyunPendingShareExchanges();
  const items = getBaiyunPendingSharePromptItems(records, sessionId, replyToMessageId);
  const fixedItems = getBaiyunFixedPendingSharePromptItems(
    records,
    sessionId,
    replyToMessageId,
  );
  return {
    items,
    fixedItems,
    settlementItems: getBaiyunPendingShareSettlementItems(records, replyToMessageId),
    instruction: buildBaiyunPendingSharesPrompt(items),
    fixedInstruction: buildBaiyunFixedPendingSharesPrompt(fixedItems),
  };
}

export async function loadBaiyunShareResponsePresentation(sessionId?: string) {
  const records = await loadBaiyunPendingShareExchanges();
  const active = getBaiyunActiveShareExchanges(records, sessionId);
  const recentEnded = records
    .filter((record) => (
      record.state !== 'waiting'
      && (!sessionId || record.sessionId === sessionId)
    ))
    .sort((left, right) => (right.resolvedAt ?? 0) - (left.resolvedAt ?? 0))
    .slice(0, 4);
  return { active, recentEnded };
}

export async function canRegisterBaiyunSelfDrivenShareNow(now = Date.now()) {
  return canRegisterBaiyunSelfDrivenShare(
    await loadBaiyunPendingShareExchanges(),
    now,
  );
}

export async function registerBaiyunPendingShareExchange(input: {
  sessionId: string;
  origin: Exclude<BaiyunPendingShareOrigin, 'chat_action'>;
  invitationKind: BaiyunPendingShareInvitationKind;
  sourceMessageIds: readonly string[];
  responseDriveKeys: readonly BaiyunPendingShareResponseDriveKey[];
  excerpt: string;
  now?: number;
}) {
  return enqueueShareMutation(async () => {
    const now = input.now ?? Date.now();
    const sourceMessageIds = [...new Set(input.sourceMessageIds.filter(Boolean))];
    if (!sourceMessageIds.length) {
      return { created: false as const, record: undefined };
    }
    const records = await loadBaiyunPendingShareExchanges();
    const existing = records.find((record) => record.sessionId === input.sessionId
      && (record.origin === input.origin || (input.origin === 'letter' && record.origin === 'chat_action'))
      && record.sourceMessageIds.length === sourceMessageIds.length
      && sourceMessageIds.every((id) => record.sourceMessageIds.includes(id)));
    if (existing) return { created: false as const, record: existing };
    const idSeed = [
      input.sessionId,
      input.origin,
      ...sourceMessageIds,
    ].join('\u0000');
    const record: BaiyunPendingShareExchange = {
      id: `share-${input.origin}-${stableHash(idSeed)}`,
      sessionId: input.sessionId,
      origin: input.origin,
      invitationKind: input.invitationKind,
      sourceMessageIds,
      responseDriveKeys: [...new Set(input.responseDriveKeys)]
        .filter((key): key is BaiyunPendingShareResponseDriveKey => (
          key === 'reflection' || key === 'social'
        )),
      excerpt: normalizeBaiyunShareExcerpt(input.excerpt),
      state: 'waiting',
      createdAt: now,
    };
    const next = registerBaiyunShareExchangeInRecords({
      records,
      record,
      now,
    });
    if (!next.created) return { created: false as const, record: next.record };
    await saveBaiyunPendingShareExchanges(next.records);
    return { created: true as const, record };
  });
}

export async function resolveBaiyunPendingShareResponses(input: {
  responses: readonly BaiyunShareResponseResolution[];
  responseMessageId: string;
  sessionId: string;
  now?: number;
}) {
  return enqueueShareMutation(async () => {
    const next = resolveBaiyunShareResponsesInRecords({
      records: await loadBaiyunPendingShareExchanges(),
      responses: input.responses,
      responseMessageId: input.responseMessageId,
      sessionId: input.sessionId,
      now: input.now,
    });
    if (!next.resolved.length) return next.resolved;
    await saveBaiyunPendingShareExchanges(next.records);
    return next.resolved;
  });
}

export async function commitBaiyunFixedShareResponseLedger(input: {
  responses: readonly BaiyunShareResponseResolution[];
  responseMessageId: string;
  sessionId: string;
  now?: number;
}) {
  return enqueueShareMutation(async () => {
    const next = resolveBaiyunShareResponsesInRecords({
      records: await loadBaiyunPendingShareExchanges(),
      responses: input.responses,
      responseMessageId: input.responseMessageId,
      sessionId: input.sessionId,
      now: input.now,
    });
    if (!next.resolved.length) return next.resolved;
    await saveBaiyunPendingShareExchanges(next.records);
    return next.resolved;
  });
}
