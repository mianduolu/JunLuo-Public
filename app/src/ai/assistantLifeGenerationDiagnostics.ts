import AsyncStorage from '@react-native-async-storage/async-storage';

import type { AssistantLifeGenerationFailureReason, AssistantLifeTransportDiagnostic } from './assistantLifeGenerationShared';
import type { NearStatusPart } from './assistantNearStatusPaper';

export const ASSISTANT_LIFE_GENERATION_DIAGNOSTICS_KEY = 'junluo.assistant.lifeGenerationDiagnostics.v1';
export const MAX_ASSISTANT_LIFE_DIAGNOSTICS_PER_CONTEXT = 20;

let diagnosticWriteQueue: Promise<void> = Promise.resolve();

export type AssistantLifeGenerationDiagnostic = {
  flow?: 'wants' | 'affect' | 'near-status' | 'sleep-status';
  /** A transport attempt, not a material batch. Local updates keep this identity. */
  requestId?: string;
  attemptOrdinal?: number;
  stage?: 'request' | 'local';
  attemptedAt: number;
  basketStatus?: {
    affect: 'absent' | 'adopted' | 'invalid';
    desire: 'absent' | 'adopted' | 'invalid';
    thought: 'absent' | 'adopted' | 'invalid';
    counterIdea?: 'absent' | 'adopted' | 'invalid';
  };
  cachedPromptTokens?: number;
  completionTokens?: number;
  contextSource: 'state' | 'afterglow';
  extraFields?: string[];
  failureReason?: AssistantLifeGenerationFailureReason;
  interruptionReason?: string;
  persistenceStatus?: 'saved' | 'pending' | 'interrupted';
  savedParts?: NearStatusPart[];
  /** Positive save confirmation; omitted means unknown, never an assertion of loss. */
  visibleTextSaved?: true;
  finishReason?: string;
  lastOccurredAt?: number;
  materialFingerprint?: string;
  occurrenceCount?: number;
  generationKey: string;
  model: string;
  outputChars?: number;
  operationIds?: string[];
  promptTokens?: number;
  responseFormatRequested: boolean;
  requests?: Array<{
    transport?: AssistantLifeTransportDiagnostic;
    cachedPromptTokens?: number;
    completionTokens?: number;
    finishReason?: string;
    outputChars: number;
    promptTokens?: number;
    reason?: string;
    status: 'success' | 'failure' | 'not-started';
    paper: 'visible' | 'inner';
  }>;
  scheduleSlot?: string;
  status: 'success' | 'failure' | 'budget-skipped';
};

function normalizeTransport(value: AssistantLifeTransportDiagnostic | undefined): AssistantLifeTransportDiagnostic | undefined {
  if (!value || !Number.isFinite(value.startedAt)
    || !['started', 'response', 'http-error', 'network-error', 'timeout', 'aborted'].includes(value.outcome)) return undefined;
  return { startedAt: value.startedAt, outcome: value.outcome,
    ...(Number.isFinite(value.finishedAt) ? { finishedAt: value.finishedAt } : {}),
    ...(Number.isInteger(value.httpStatus) ? { httpStatus: value.httpStatus } : {}),
    ...(Number.isInteger(value.offeredToolCount) && value.offeredToolCount! >= 0 ? { offeredToolCount: value.offeredToolCount } : {}),
    ...(['official_profile', 'verified_probe', 'disabled_default', 'protocol_default'].includes(value.toolCapabilitySource ?? '')
      ? { toolCapabilitySource: value.toolCapabilitySource } : {}) };
}

export function normalizeAssistantLifeGenerationDiagnostic(value: unknown): AssistantLifeGenerationDiagnostic | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<AssistantLifeGenerationDiagnostic>;
  if (
    typeof candidate.attemptedAt !== 'number'
    || typeof candidate.contextSource !== 'string'
    || typeof candidate.generationKey !== 'string'
    || typeof candidate.model !== 'string'
    || typeof candidate.responseFormatRequested !== 'boolean'
    || (candidate.status !== 'success' && candidate.status !== 'failure' && candidate.status !== 'budget-skipped')
  ) return null;
  const basketStatus = candidate.basketStatus
    && ['absent', 'adopted', 'invalid'].includes(candidate.basketStatus.affect)
    && ['absent', 'adopted', 'invalid'].includes(candidate.basketStatus.desire)
    && ['absent', 'adopted', 'invalid'].includes(candidate.basketStatus.thought)
    ? candidate.basketStatus
    : undefined;
  const requests = Array.isArray(candidate.requests)
    ? candidate.requests.slice(0, candidate.flow === 'near-status' ? 3 : 2).flatMap((request) => {
        if (!request || (request.paper !== 'visible' && request.paper !== 'inner')) return [];
        if (request.status !== 'success' && request.status !== 'failure' && request.status !== 'not-started') return [];
        return [{
          ...(normalizeTransport(request.transport) ? { transport: normalizeTransport(request.transport) } : {}),
          cachedPromptTokens: typeof request.cachedPromptTokens === 'number' ? request.cachedPromptTokens : undefined,
          completionTokens: typeof request.completionTokens === 'number' ? request.completionTokens : undefined,
          finishReason: typeof request.finishReason === 'string' ? request.finishReason.slice(0, 80) : undefined,
          outputChars: typeof request.outputChars === 'number' ? request.outputChars : 0,
          paper: request.paper,
          promptTokens: typeof request.promptTokens === 'number' ? request.promptTokens : undefined,
          reason: typeof request.reason === 'string' ? request.reason.slice(0, 80) : undefined,
          status: request.status,
        }];
      })
    : undefined;
  return {
    ...(['wants', 'affect', 'near-status', 'sleep-status'].includes(candidate.flow ?? '') ? { flow: candidate.flow } : {}),
    ...(typeof candidate.requestId === 'string' && candidate.requestId ? { requestId: candidate.requestId.slice(0, 400) } : {}),
    ...(Number.isSafeInteger(candidate.attemptOrdinal) && candidate.attemptOrdinal! > 0 ? { attemptOrdinal: candidate.attemptOrdinal } : {}),
    ...(candidate.stage === 'request' || candidate.stage === 'local' ? { stage: candidate.stage } : {}),
    attemptedAt: candidate.attemptedAt,
    basketStatus,
    cachedPromptTokens: typeof candidate.cachedPromptTokens === 'number' ? candidate.cachedPromptTokens : undefined,
    completionTokens: typeof candidate.completionTokens === 'number' ? candidate.completionTokens : undefined,
    contextSource: candidate.contextSource === 'afterglow' ? 'afterglow' : 'state',
    extraFields: Array.isArray(candidate.extraFields)
      ? candidate.extraFields.filter((entry): entry is string => typeof entry === 'string').slice(0, 8).map((entry) => entry.slice(0, 80))
      : undefined,
    failureReason: candidate.failureReason,
    interruptionReason: typeof candidate.interruptionReason === 'string' ? candidate.interruptionReason.slice(0, 80) : undefined,
    persistenceStatus: candidate.persistenceStatus === 'saved' || candidate.persistenceStatus === 'pending' || candidate.persistenceStatus === 'interrupted'
      ? candidate.persistenceStatus : undefined,
    savedParts: Array.isArray(candidate.savedParts) ? [...new Set(candidate.savedParts.filter(part =>
      ['nearStatus', 'thoughtNew', 'thoughtDecision', 'counterIdea'].includes(part)))].slice(0, 4) : undefined,
    visibleTextSaved: candidate.visibleTextSaved === true ? true : undefined,
    finishReason: typeof candidate.finishReason === 'string' ? candidate.finishReason.slice(0, 80) : undefined,
    lastOccurredAt: typeof candidate.lastOccurredAt === 'number'
      ? Math.max(candidate.attemptedAt, candidate.lastOccurredAt)
      : candidate.attemptedAt,
    materialFingerprint: typeof candidate.materialFingerprint === 'string'
      ? candidate.materialFingerprint.slice(0, 160)
      : undefined,
    occurrenceCount: typeof candidate.occurrenceCount === 'number'
      ? Math.max(1, Math.min(1_000_000, Math.floor(candidate.occurrenceCount))) : 1,
    generationKey: candidate.generationKey.slice(0, 320),
    model: candidate.model.slice(0, 160),
    outputChars: typeof candidate.outputChars === 'number' ? candidate.outputChars : undefined,
    operationIds: Array.isArray(candidate.operationIds)
      ? candidate.operationIds.filter((entry): entry is string => typeof entry === 'string').slice(0, 8).map((entry) => entry.slice(0, 320))
      : undefined,
    promptTokens: typeof candidate.promptTokens === 'number' ? candidate.promptTokens : undefined,
    responseFormatRequested: candidate.responseFormatRequested,
    requests,
    status: candidate.status,
    scheduleSlot: typeof candidate.scheduleSlot === 'string' ? candidate.scheduleSlot.slice(0, 160) : undefined,
  };
}

function diagnosticOrderTime(diagnostic: AssistantLifeGenerationDiagnostic) {
  return diagnostic.lastOccurredAt ?? diagnostic.attemptedAt;
}

export function shouldBlockAssistantLifeGenerationFromDiagnostics(input: {
  contextSource: AssistantLifeGenerationDiagnostic['contextSource'];
  diagnostics: AssistantLifeGenerationDiagnostic[];
  generationKey: string;
  now: number;
}) {
  const latest = input.diagnostics
    .filter((diagnostic) => (
      diagnostic.contextSource === input.contextSource
      && diagnostic.generationKey === input.generationKey
      && diagnostic.status !== 'budget-skipped'
    ))
    .sort((left, right) => diagnosticOrderTime(right) - diagnosticOrderTime(left))[0];
  if (!latest) return false;
  return true;
}

export function retainAssistantLifeGenerationDiagnostics(
  diagnostics: AssistantLifeGenerationDiagnostic[],
) {
  const contexts: AssistantLifeGenerationDiagnostic['contextSource'][] = ['state', 'afterglow'];
  return contexts
    .flatMap((contextSource) => diagnostics
      .filter((item) => item.contextSource === contextSource)
      .sort((left, right) => diagnosticOrderTime(left) - diagnosticOrderTime(right))
      .slice(-MAX_ASSISTANT_LIFE_DIAGNOSTICS_PER_CONTEXT))
    .sort((left, right) => diagnosticOrderTime(left) - diagnosticOrderTime(right));
}

export function mergeAssistantLifeGenerationDiagnostic(
  current: AssistantLifeGenerationDiagnostic[],
  diagnostic: AssistantLifeGenerationDiagnostic,
) {
  const normalized = normalizeAssistantLifeGenerationDiagnostic(diagnostic);
  if (!normalized) return retainAssistantLifeGenerationDiagnostics(current);
  const next = current.slice();
  const sameRequest = normalized.requestId ? next.findIndex(item => item.requestId === normalized.requestId) : -1;
  if (sameRequest >= 0) {
    next[sameRequest] = { ...next[sameRequest], ...normalized };
    return retainAssistantLifeGenerationDiagnostics(next);
  }
  if (normalized.stage === 'local') {
    const index = next.findLastIndex(item => item.generationKey === normalized.generationKey && item.flow === normalized.flow);
    if (index >= 0) {
      next[index] = { ...next[index], persistenceStatus: normalized.persistenceStatus,
        interruptionReason: normalized.interruptionReason, lastOccurredAt: normalized.attemptedAt,
        ...(normalized.savedParts ? { savedParts: [...new Set([...(next[index].savedParts ?? []), ...normalized.savedParts])] } : {}),
        ...(normalized.visibleTextSaved ? { visibleTextSaved: true } : {}) };
      return retainAssistantLifeGenerationDiagnostics(next);
    }
  }
  let latestContextIndex = -1;
  for (let index = 0; index < next.length; index += 1) {
    if (next[index].contextSource !== normalized.contextSource) continue;
    if (
      latestContextIndex < 0
      || diagnosticOrderTime(next[index]) > diagnosticOrderTime(next[latestContextIndex])
    ) latestContextIndex = index;
  }
  const latest = latestContextIndex >= 0 ? next[latestContextIndex] : undefined;
  if (
    normalized.status === 'budget-skipped'
    && latest?.status === 'budget-skipped'
    && latest.generationKey === normalized.generationKey
  ) {
    next[latestContextIndex] = {
      ...latest,
      lastOccurredAt: Math.max(
        diagnosticOrderTime(latest),
        diagnosticOrderTime(normalized),
      ),
      materialFingerprint: normalized.materialFingerprint ?? latest.materialFingerprint,
      occurrenceCount: (latest.occurrenceCount ?? 1) + (normalized.occurrenceCount ?? 1),
      scheduleSlot: normalized.scheduleSlot ?? latest.scheduleSlot,
    };
  } else {
    next.push(normalized);
  }
  return retainAssistantLifeGenerationDiagnostics(next);
}

export async function loadAssistantLifeGenerationDiagnostics() {
  const raw = await AsyncStorage.getItem(ASSISTANT_LIFE_GENERATION_DIAGNOSTICS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? retainAssistantLifeGenerationDiagnostics(parsed
        .map(normalizeAssistantLifeGenerationDiagnostic)
        .filter((item): item is AssistantLifeGenerationDiagnostic => !!item))
      : [];
  } catch {
    return [];
  }
}

export async function appendAssistantLifeGenerationDiagnostic(
  diagnostic: AssistantLifeGenerationDiagnostic,
) {
  const write = async () => {
    const current = await loadAssistantLifeGenerationDiagnostics();
    const next = mergeAssistantLifeGenerationDiagnostic(current, diagnostic);
    await AsyncStorage.setItem(ASSISTANT_LIFE_GENERATION_DIAGNOSTICS_KEY, JSON.stringify(next));
  };
  diagnosticWriteQueue = diagnosticWriteQueue.then(write, write);
  return diagnosticWriteQueue;
}

/** Best-effort technical observation; callers retain all business write ownership. */
export function recordAssistantLifeTransport(
  input: Pick<AssistantLifeGenerationDiagnostic, 'generationKey' | 'requestId' | 'flow' | 'attemptOrdinal' | 'model' | 'contextSource' | 'responseFormatRequested'>,
  transport: AssistantLifeTransportDiagnostic,
) {
  return appendAssistantLifeGenerationDiagnostic({ ...input, stage: 'request', attemptedAt: transport.startedAt,
    status: transport.outcome === 'response' ? 'success' : 'failure',
    requests: [{ paper: input.flow === 'wants' || input.flow === 'affect' ? 'inner' : 'visible',
      status: transport.outcome === 'response' ? 'success' : 'failure', outputChars: 0, transport }],
  }).catch(() => undefined);
}

/** Local journal completion amends the same request, never adds an API-call record. */
export function updateAssistantLifePersistenceDiagnostic(
  generationKey: string,
  result: { status: 'saved' | 'pending' | 'interrupted'; savedParts: NearStatusPart[]; visibleTextSaved?: true; interruptionReason?: string; flow?: AssistantLifeGenerationDiagnostic['flow'] },
) {
  const write = async () => {
    const current = await loadAssistantLifeGenerationDiagnostics();
    if (!current.some(item => item.generationKey === generationKey)) return;
    const index = current.findLastIndex(item => item.generationKey === generationKey && (!result.flow || item.flow === result.flow));
    const next = current.map((item, i) => i !== index ? item : {
      ...item,
      persistenceStatus: result.status, savedParts: [...new Set([...(item.savedParts ?? []), ...result.savedParts])], interruptionReason: result.interruptionReason,
      visibleTextSaved: result.visibleTextSaved === true || item.visibleTextSaved === true ? true : undefined,
    });
    await AsyncStorage.setItem(ASSISTANT_LIFE_GENERATION_DIAGNOSTICS_KEY, JSON.stringify(next));
  };
  diagnosticWriteQueue = diagnosticWriteQueue.then(write, write);
  return diagnosticWriteQueue;
}
