import * as FileSystem from 'expo-file-system/legacy';

import { writeStringFileSafely } from '../../storage/safeFileWrite';
import { BAIYUN_CHAT_SINGLE_ROOT_JSON_ASSISTANT_PREFIX } from './actionChatSemantic';
import {
  inspectBaiyunFixedChatEnvelope,
  type BaiyunFixedEnvelopeFieldStatus,
} from './actionChatFixedEnvelope';

const BAD_ENVELOPE_CACHE_VERSION = 3 as const;
const BAD_ENVELOPE_CACHE_FILE = 'junluo-latest-bad-chat-envelope-v3.json';
const LEGACY_BAD_ENVELOPE_CACHE_FILES = [
  'junluo-latest-bad-chat-envelope-v1.json',
  'junluo-latest-bad-chat-envelope-v2.json',
];

export type BaiyunBadEnvelopeRetryOutcome = 'not_attempted' | 'recovered' | 'failed';

export type ProactiveBadEnvelopeSource = {
  opportunityId: string;
  sessionId: string;
  requestToken: string;
  requestNumber: number;
  phase: 'initial' | 'body_continuation' | 'failure_retry';
};

export type BaiyunBadEnvelopeBasketStatuses = {
  messages: BaiyunFixedEnvelopeFieldStatus;
  careUpdates: BaiyunFixedEnvelopeFieldStatus;
  shareResponses: BaiyunFixedEnvelopeFieldStatus;
  innerReaction: BaiyunFixedEnvelopeFieldStatus;
};

export type BaiyunLatestBadEnvelopeSnapshot = {
  version: typeof BAD_ENVELOPE_CACHE_VERSION;
  capturedAt: number;
  connectionName: string;
  model: string;
  requestType: 'initial' | 'retry';
  failureSummary: string;
  failureReasons: string[];
  basketStatuses: BaiyunBadEnvelopeBasketStatuses;
  finishReason?: string;
  semanticPrefixCompletionRequested: boolean;
  retryOutcome: BaiyunBadEnvelopeRetryOutcome;
  rawDirectContent?: string;
  rawDirectContentChars: number;
  /** Absent on original v3 manual-chat evidence. Proactive does not use the four-basket inspection. */
  proactiveSource?: ProactiveBadEnvelopeSource;
};

type StrictTicketResult = {
  status?: 'valid' | 'partial' | 'unresolved';
  rejectionCodes?: readonly string[];
};

type BuildBadEnvelopeSnapshotInput = {
  capturedAt?: number;
  connectionName: string;
  model: string;
  requestType: 'initial' | 'retry';
  envelopeRaw: string;
  rawDirectContent?: string;
  finishReason?: string;
  semanticPrefixCompletionRequested: boolean;
  retryOutcome?: BaiyunBadEnvelopeRetryOutcome;
  careUpdates?: StrictTicketResult;
  shareResponses?: StrictTicketResult;
};

const DIAGNOSTIC_BASKET_KEYS = ['messages', 'careUpdates', 'shareResponses', 'innerReaction'] as const;

function normalizeDirectForInspection(input: BuildBadEnvelopeSnapshotInput) {
  if (input.rawDirectContent === undefined) return input.envelopeRaw;
  const direct = input.rawDirectContent;
  if (!direct.trim()) return direct;
  const trimmedStart = direct.trimStart();
  if (
    input.semanticPrefixCompletionRequested
    && !trimmedStart.startsWith('{')
  ) {
    return `${BAIYUN_CHAT_SINGLE_ROOT_JSON_ASSISTANT_PREFIX}${trimmedStart}`;
  }
  return direct;
}

function addTicketFailure(
  reasons: string[],
  label: string,
  result: StrictTicketResult | undefined,
) {
  if (!result || result.status === 'valid') return;
  const details = result.rejectionCodes?.length
    ? `（${result.rejectionCodes.join('、')}）`
    : '';
  reasons.push(`${label}有票被拒绝${details}`);
}

export function buildBaiyunLatestBadEnvelopeSnapshot(
  input: BuildBadEnvelopeSnapshotInput,
): BaiyunLatestBadEnvelopeSnapshot | undefined {
  const inspectionRaw = normalizeDirectForInspection(input);
  const inspection = inspectBaiyunFixedChatEnvelope(inspectionRaw);
  const reasons: string[] = [];

  if (!inspection.candidate) reasons.push('不是固定四格答卷');
  if (inspection.rootStatus === 'malformed') reasons.push('根 JSON 损坏');
  const basketStatuses: BaiyunBadEnvelopeBasketStatuses = {
    messages: inspection.fields.messages.status,
    careUpdates: inspection.fields.careUpdates.status,
    shareResponses: inspection.fields.shareResponses.status,
    innerReaction: inspection.fields.innerReaction.status,
  };
  Object.entries(basketStatuses).forEach(([field, status]) => {
    if (status !== 'valid') reasons.push(`${field}：${status}`);
  });

  if (inspection.candidate) {
    addTicketFailure(reasons, '事项变化', input.careUpdates);
    addTicketFailure(reasons, '分享票', input.shareResponses);
  }
  if (!reasons.length) return undefined;

  const rawDirectContent = input.rawDirectContent ?? '';
  return {
    version: BAD_ENVELOPE_CACHE_VERSION,
    capturedAt: input.capturedAt ?? Date.now(),
    connectionName: input.connectionName,
    model: input.model,
    requestType: input.requestType,
    failureSummary: reasons.slice(0, 2).join('；'),
    failureReasons: reasons,
    basketStatuses,
    ...(input.finishReason ? { finishReason: input.finishReason } : {}),
    semanticPrefixCompletionRequested: input.semanticPrefixCompletionRequested,
    retryOutcome: input.retryOutcome ?? 'not_attempted',
    ...(rawDirectContent ? { rawDirectContent } : {}),
    rawDirectContentChars: rawDirectContent.length,
  };
}

export function buildProactiveBadEnvelopeSnapshot(input: {
  capturedAt?: number;
  connectionName: string;
  model: string;
  rawDirectContent: string;
  finishReason?: string;
  failureReason: string;
  source: ProactiveBadEnvelopeSource;
}): BaiyunLatestBadEnvelopeSnapshot {
  const source = input.source;
  return {
    version: BAD_ENVELOPE_CACHE_VERSION,
    capturedAt: input.capturedAt ?? Date.now(),
    connectionName: input.connectionName,
    model: input.model,
    requestType: source.phase === 'failure_retry' ? 'retry' : 'initial',
    failureSummary: `主动联系正文未保存：${input.failureReason}`,
    failureReasons: [input.failureReason],
    basketStatuses: { messages: 'unavailable', careUpdates: 'unavailable', shareResponses: 'unavailable', innerReaction: 'unavailable' },
    ...(input.finishReason ? { finishReason: input.finishReason } : {}),
    semanticPrefixCompletionRequested: false,
    retryOutcome: source.phase === 'failure_retry' ? 'failed' : 'not_attempted',
    rawDirectContent: input.rawDirectContent,
    rawDirectContentChars: input.rawDirectContent.length,
    proactiveSource: { opportunityId: source.opportunityId, sessionId: source.sessionId,
      requestToken: source.requestToken, requestNumber: source.requestNumber, phase: source.phase },
  };
}

export function withBaiyunBadEnvelopeRetryOutcome(
  snapshot: BaiyunLatestBadEnvelopeSnapshot,
  retryOutcome: BaiyunBadEnvelopeRetryOutcome,
): BaiyunLatestBadEnvelopeSnapshot {
  return { ...snapshot, retryOutcome };
}

function cacheUri(file = BAD_ENVELOPE_CACHE_FILE) {
  if (!FileSystem.cacheDirectory) return undefined;
  const directory = FileSystem.cacheDirectory.endsWith('/')
    ? FileSystem.cacheDirectory
    : `${FileSystem.cacheDirectory}/`;
  return `${directory}${file}`;
}

function isSnapshot(value: unknown): value is BaiyunLatestBadEnvelopeSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const snapshot = value as Partial<BaiyunLatestBadEnvelopeSnapshot>;
  const statuses = snapshot.basketStatuses as Partial<BaiyunBadEnvelopeBasketStatuses> | undefined;
  const fieldStatusValues = new Set(['valid', 'missing', 'malformed', 'unavailable']);
  const source = snapshot.proactiveSource;
  return snapshot.version === BAD_ENVELOPE_CACHE_VERSION
    && (source === undefined || !!source && typeof source === 'object'
      && typeof source.opportunityId === 'string' && source.opportunityId.length > 0
      && typeof source.sessionId === 'string' && source.sessionId.length > 0
      && typeof source.requestToken === 'string' && source.requestToken.length > 0
      && Number.isInteger(source.requestNumber) && source.requestNumber > 0
      && ['initial', 'body_continuation', 'failure_retry'].includes(source.phase))
    && typeof snapshot.capturedAt === 'number'
    && typeof snapshot.connectionName === 'string'
    && typeof snapshot.model === 'string'
    && typeof snapshot.failureSummary === 'string'
    && Array.isArray(snapshot.failureReasons)
    && snapshot.failureReasons.every((reason) => typeof reason === 'string')
    && statuses !== undefined
    && Object.keys(statuses).length === DIAGNOSTIC_BASKET_KEYS.length
    && DIAGNOSTIC_BASKET_KEYS.every((key) => fieldStatusValues.has(String(statuses[key])))
    && (snapshot.requestType === 'initial' || snapshot.requestType === 'retry')
    && (
      snapshot.retryOutcome === 'not_attempted'
      || snapshot.retryOutcome === 'recovered'
      || snapshot.retryOutcome === 'failed'
    )
    && typeof snapshot.semanticPrefixCompletionRequested === 'boolean'
    && typeof snapshot.rawDirectContentChars === 'number'
    && (snapshot.rawDirectContent === undefined || typeof snapshot.rawDirectContent === 'string');
}

export async function saveBaiyunLatestBadEnvelopeSnapshot(
  snapshot: BaiyunLatestBadEnvelopeSnapshot,
) {
  const uri = cacheUri();
  if (!uri) return;
  const serialized = JSON.stringify(snapshot);
  await writeStringFileSafely(uri, serialized, { minimumBytes: 2 });
}

export async function loadBaiyunLatestBadEnvelopeSnapshot(options: { strict?: boolean } = {}) {
  const currentUri = cacheUri();
  if (!currentUri) return null;
  if (options.strict && !(await FileSystem.getInfoAsync(currentUri)).exists) return null;
  try {
    const parsed = JSON.parse(await FileSystem.readAsStringAsync(currentUri)) as unknown;
    if (isSnapshot(parsed)) return parsed;
    if (options.strict) throw new Error('invalid-baiyun-bad-envelope-snapshot');
  } catch (error) {
    if (options.strict) throw error;
    return null;
  }
  return null;
}

export async function deleteBaiyunLatestBadEnvelopeSnapshot() {
  const currentUri = cacheUri();
  if (currentUri) await FileSystem.deleteAsync(currentUri, { idempotent: true });
  for (const file of LEGACY_BAD_ENVELOPE_CACHE_FILES) {
    const legacyUri = cacheUri(file);
    if (legacyUri) await FileSystem.deleteAsync(legacyUri, { idempotent: true });
  }
}
