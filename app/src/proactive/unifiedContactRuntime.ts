import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import {
  claimContactOpportunity, contactMessageId, contactRetryIsDue, failContactOpportunity,
  finishContactOpportunity, contactCurrentStateDraftVersion, recordContactMotiveSelection, type ContactOpportunity,
  CONTACT_MODEL_REQUEST_TIMEOUT_MS, contactPastMemoryOffer, isContactPastMemorySource,
} from './unifiedContact';
import type { ContactToolReceipt, StoredUnifiedContactState } from './unifiedContactStore';
import { recordPhoneEmergencyHandled } from './phoneEmergencyContact';

export type UnifiedContactPorts = {
  now(): number;
  read(): Promise<StoredUnifiedContactState>;
  change<T>(work: (state: StoredUnifiedContactState) => T): Promise<T>;
  /** Data-restore epoch only; this must not depend on temporarily unreadable sources. */
  isEpochCurrent?(epoch: number): boolean;
  releaseRequestBudget?(requestToken: string): Promise<void>;
  isRequestDeferred?(error: unknown): boolean;
  /** Checks actual settings, sleep/activity, target session and current source versions. */
  valid(opportunity: ContactOpportunity): Promise<'valid' | 'chat' | 'stale' | 'paused' | 'disabled' | 'sleep' | 'activity'>;
  generate(input: {
    opportunity: ContactOpportunity;
    retry?: ContactToolReceipt;
    beforeRequest(): Promise<string>;
    beforeTransport(): Promise<void>;
    onTransportStarted(): void;
    onTransportFinished(outcome: 'response_received' | 'http_error' | 'network_error' | 'timeout' | 'aborted'): void;
    onTools(receipt: ContactToolReceipt): Promise<void>;
  }): Promise<string[] | { kind: 'silent' }>;
  save(message: SubjectiveMessage, opportunity: ContactOpportunity): Promise<boolean>;
  /** Reads a fixed message ID from its actual session, without generating/delivering again. */
  readSaved?(sessionId: string, messageId: string): Promise<SubjectiveMessage | null>;
  recordSavedMaterials?(opportunity: ContactOpportunity, message: SubjectiveMessage): Promise<void>;
  delivered(message: SubjectiveMessage, opportunity: ContactOpportunity): Promise<void>;
  completed(opportunity: ContactOpportunity): Promise<void>;
  waitBetweenBubbles(): Promise<void>;
};

const localSave = async <T>(work: () => Promise<T>): Promise<T> => {
  let failure: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try { return await work(); } catch (error) { failure = error; }
  }
  throw failure;
};

// Like the three internal papers, keep an already parsed answer while its journal
// is temporarily unwritable. This is not another network retry or persisted copy.
const unsavedAnswers = new Map<string, { epoch: number; messages: string[]; silent?: true; phoneAttemptedAt?: number }>();
let requestSerial = 0;

export function contactBudgetDeferredUntil(error: unknown): number | undefined {
  if (!(error instanceof Error) || error.name !== 'ProactiveBudgetDeferredError') return undefined;
  const retryAfter = (error as Error & { retryAfter?: unknown }).retryAfter;
  return typeof retryAfter === 'number' && Number.isSafeInteger(retryAfter) && retryAfter > 0 ? retryAfter : undefined;
}

function unknownContactFailureReason(error: unknown): string {
  let failure: Error;
  try {
    if (!(error instanceof Error)) return 'generation_failed:non_error';
    failure = error;
  }
  catch { return 'generation_failed:non_error'; }
  let name = 'Error';
  try {
    const candidate = failure.name;
    if (['TypeError', 'SyntaxError', 'RangeError', 'ReferenceError', 'Error', 'JunLuoToolAgentTurnError'].includes(candidate)) name = candidate;
  } catch { /* An inaccessible diagnostic field cannot replace the original failure. */ }
  const parts = ['generation_failed', name];
  if (name === 'JunLuoToolAgentTurnError') try {
    const code = (failure as Error & { code?: unknown }).code;
    if (typeof code === 'string' && ['TURN_ALREADY_ACTIVE', 'TURN_NOT_ACTIVE', 'TURN_ID_MISMATCH',
      'INVALID_TURN_TRANSITION', 'TURN_CANCELLED', 'STALE_DATA_EPOCH', 'SOURCE_SESSION_REMOVED',
      'SOURCE_MESSAGE_REMOVED'].includes(code)) parts.push(code);
  } catch { /* Keep the finite class without an unreadable code. */ }
  try {
    const stack = failure.stack;
    if (typeof stack === 'string') {
      let frames = 0;
      // RN parseHermesStack: bytecode offsets are zero-based; source columns are one-based.
      // Skip the exception header; accept only the fixed release bundle, never paths or URLs.
      for (const line of stack.slice(0, 16_384).split(/\r?\n/).slice(1)) {
        const match = /^ {4}at [^\r\n]+ \((address at )?index\.android\.bundle:(\d{1,10}):(\d{1,10})\)$/.exec(line);
        if (!match) continue;
        const sourceLine = Number(match[2]), column = Number(match[3]) - (match[1] ? 0 : 1);
        if (sourceLine < 1 || column < 0) continue;
        parts.push(match[1] ? 'hbc' : 'src', String(sourceLine), String(column));
        if (++frames === 3) break;
      }
    }
  } catch { /* No raw stack or substitute coordinates when access fails. */ }
  return parts.join(':');
}

// Only this contact-empty snapshot is accepted; never serialize the source object or invoke its getters.
export function normalizeContactBodyDiagnostics(value: unknown): Record<string, string | number | boolean> {
  const shapes = ['empty', 'messages_strings', 'messages_empty', 'messages_mixed', 'message_string', 'object_other',
    'root_strings', 'root_empty_array', 'root_mixed_array', 'root_string', 'scalar_other', 'tagged', 'non_json'];
  const enums: Record<string, readonly string[]> = {
    visible: ['visible', 'model_empty', 'structure_invalid'],
    format: ['empty', 'json_object', 'json_value', 'fenced_content', 'tagged_content', 'non_json'],
    rawShape: shapes, loopShape: shapes,
    state: ['idle', 'deciding', 'awaiting_permission', 'awaiting_confirmation', 'executing', 'feeding_result',
      'finalizing', 'completed', 'failed', 'cancelled'],
    failure: ['PROVIDER_ERROR', 'PROTOCOL_ERROR', 'HOST_ERROR', 'MODEL_REQUEST_LIMIT'],
    cancel: ['you_stopped', 'source_session_cleared', 'source_session_deleted', 'source_message_removed',
      'confirmation_expired', 'stale_data_epoch', 'controller_disposed'],
  };
  const snapshot: Record<string, string | number | boolean> = {};
  for (const key of ['visible', 'format', 'direct', 'reasoning', 'projected', 'rawChars', 'rawShape', 'loopChars',
    'loopShape', 'parsed', 'kept', 'state', 'failure', 'cancel', 'requests', 'rounds', 'card']) {
    let candidate: unknown;
    try {
      if (value && typeof value === 'object') candidate = Object.getOwnPropertyDescriptor(value, key)?.value;
    } catch { /* Missing, accessor and inaccessible fields stay unknown, never zero. */ }
    snapshot[key] = key === 'card' ? typeof candidate === 'boolean' ? candidate : 'unknown'
      : enums[key] ? typeof candidate === 'string' && enums[key].includes(candidate) ? candidate : 'unknown'
        : typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 0 && candidate < 1_000_000_000
          ? candidate : 'unknown';
  }
  return snapshot;
}

function contactBodyFailureReason(reason: string, error: Error): string {
  try {
    const value = Object.getOwnPropertyDescriptor(error, 'contactBodyDiagnostics')?.value;
    if (!value || typeof value !== 'object') return reason;
    const snapshot = normalizeContactBodyDiagnostics(value);
    const summary = `${reason}|body1:${Object.entries(snapshot).map(([key, field]) => `${key}=${field}`).join(',')}`;
    // Fixed keys, enums and nine-digit counts fit this limit; never truncate a field into a different value.
    return summary.length <= 512 ? summary : reason;
  } catch { return reason; }
}

function contactGenerationFailureReason(error: unknown, transportOutcome?: string): string {
  try {
    if (error instanceof Error && error.message === 'contact-empty') {
      const reason = (error as Error & { contactFailureReason?: unknown }).contactFailureReason;
      if (reason === 'body_protocol_failed') {
        const code = (error as Error & { contactProtocolFailureCode?: unknown }).contactProtocolFailureCode;
        const prefix = typeof code === 'string' && [
          'DUPLICATE_CALL_ID', 'FINISH_REASON_MISMATCH', 'INVALID_TOOL_CALL_BATCH', 'INVALID_REPLY_FORMAT',
          'MISSING_CALL_ID', 'MODEL_REQUEST_LIMIT', 'TOOL_NOT_ALLOWED',
        ].includes(code) ? `body_protocol_failed:${code}` : 'body_protocol_failed';
        return contactBodyFailureReason(prefix, error);
      }
      return typeof reason === 'string' && [
        'body_truncated', 'body_protocol_failed', 'body_parse_empty', 'body_cleaned_empty', 'body_action_filtered',
      ].includes(reason) ? contactBodyFailureReason(reason, error) : 'empty_body';
    }
    const technicalCode = error instanceof Error && [
      'TOOL_AGENT_MODEL_REQUEST_TIMEOUT', 'UNIFIED_CONTACT_CONTEXT_TOO_LONG', 'UNIFIED_CONTACT_REQUEST_ABORTED',
      'TOOL_PROVIDER_NATIVE_TOOLS_UNSUPPORTED', 'TOOL_PROVIDER_THINKING_TOOLS_UNSUPPORTED',
      'TOOL_REQUIRED_CHOICE_UNSUPPORTED', 'CHAT_MODEL_REQUEST_BUDGET_EXHAUSTED',
    ].includes(error.message) ? error.message : undefined;
    const transportReason = transportOutcome && ['http_error', 'network_error', 'timeout', 'aborted'].includes(transportOutcome)
      ? `transport_${transportOutcome}` : undefined;
    const requestError = error instanceof Error && error.name === 'AiRequestError'
      ? error as Error & { kind?: unknown; httpStatus?: unknown } : undefined;
    const kind = requestError?.kind;
    const requestReason = typeof kind === 'string'
      && ['authentication', 'timeout', 'network', 'provider_http', 'empty_response'].includes(kind) ? `ai_${kind}` : undefined;
    const reasons = [technicalCode, transportReason, requestReason].filter(Boolean);
    if (!reasons.length) return unknownContactFailureReason(error);
    const httpStatus = requestError?.httpStatus;
    if (typeof httpStatus === 'number' && Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599) {
      reasons.push(`http_${httpStatus}`);
    }
    return reasons.join(':');
  } catch { return unknownContactFailureReason(error); }
}

function recordPhoneEmergencyReturn(state: StoredUnifiedContactState, op: ContactOpportunity) {
  if (op.phoneEmergency) state.phoneEmergencyCare = recordPhoneEmergencyHandled(state.phoneEmergencyCare ?? {},
    op.phoneEmergency.references, op.phoneEmergency.pendingIds);
}

function recordSavedContactMessage(state: StoredUnifiedContactState, op: ContactOpportunity, message: SubjectiveMessage) {
  const index = op.messages.findIndex((_text, index) => contactMessageId(op, index) === message.id);
  if (index < 0 || message.role !== 'I' || message.source !== 'proactive-message'
    || message.deliveryStatus === 'failed' || message.content !== op.messages[index]) return;
  if (!op.savedMessageIds.includes(message.id)) op.savedMessageIds.push(message.id);
  if (index !== 0 || op.important || op.phoneEmergency || state.lastOrdinaryCurrentStateOffer?.opportunityId === op.id
    || (state.lastOrdinaryCurrentStateOffer?.savedAt ?? -1) > message.createdAt) return;
  const ref = op.sources.find(source => source.kind === 'current_state');
  const version = ref && contactCurrentStateDraftVersion(ref);
  const pastRef = op.sources.find(isContactPastMemorySource);
  state.lastOrdinaryCurrentStateOffer = { opportunityId: op.id, sessionId: op.sessionId,
    messageId: message.id, savedAt: message.createdAt,
    currentState: ref && version ? { id: ref.id, version } : null,
    pastMemory: pastRef ? contactPastMemoryOffer(pastRef) : null };
}

async function recordSavedContactMaterials(
  p: Pick<UnifiedContactPorts, 'change' | 'isEpochCurrent' | 'recordSavedMaterials'>,
  op: ContactOpportunity, message: SubjectiveMessage,
): Promise<void> {
  await localSave(() => p.recordSavedMaterials?.(op, message) ?? Promise.resolve());
  const result = op.pastMemoryUsageResult;
  if (!result || message.id !== contactMessageId(op, 0) || !op.sources.some(isContactPastMemorySource)) return;
  await localSave(() => p.change(state => {
    const live = state.current;
    if (!live || live.id !== op.id || live.epoch !== op.epoch || p.isEpochCurrent && !p.isEpochCurrent(live.epoch)) return;
    live.pastMemoryUsageResult = result;
  }));
}

/** Recover the existing chat write before any caller can discard its draft. */
export async function recoverUnifiedContactSavedMessages(
  p: Pick<UnifiedContactPorts, 'read' | 'change' | 'isEpochCurrent' | 'readSaved' | 'recordSavedMaterials'>,
): Promise<void> {
  if (!p.readSaved) return;
  const state = await p.read(); const op = state.current;
  if (!op?.messages.length || p.isEpochCurrent && !p.isEpochCurrent(op.epoch)) return;
  for (let index = 0; index < op.messages.length; index += 1) {
    const id = contactMessageId(op, index);
    const pendingPastMemoryUsage = index === 0 && op.sources.some(isContactPastMemorySource) && !op.pastMemoryUsageResult;
    if (!op.scheduleRecovery?.events.length && !op.sources.some(ref => ref.kind === 'weekly_review') && op.savedMessageIds.includes(id)
      && !pendingPastMemoryUsage && (op.important || state.lastOrdinaryCurrentStateOffer?.opportunityId === op.id)) continue;
    const message = await p.readSaved(op.sessionId, id);
    if (!message) continue;
    await localSave(() => p.change(current => {
      const live = current.current;
      if (!live || live.id !== op.id || live.epoch !== op.epoch || p.isEpochCurrent && !p.isEpochCurrent(live.epoch)) return;
      recordSavedContactMessage(current, live, message);
    }));
    if (!p.isEpochCurrent || p.isEpochCurrent(op.epoch)) await recordSavedContactMaterials(p, op, message);
  }
}

/** One check handles one opportunity. Existing foreground / Headless entry owns waking. */
export async function processUnifiedContact(p: UnifiedContactPorts, candidate?: ContactOpportunity): Promise<number> {
  await recoverUnifiedContactSavedMessages(p);
  let state = await p.read();
  let op = state.current && state.current.status !== 'finished' ? state.current : candidate;
  if (!op) return 0;
  const id = op.id;
  if (p.isEpochCurrent && !p.isEpochCurrent(op.epoch)) { unsavedAnswers.delete(id); return 0; }
  const change = <T>(work: (state: StoredUnifiedContactState, op: ContactOpportunity) => T) =>
    localSave(() => p.change(current => {
      if (current.current?.id !== id) throw new Error('contact-opportunity-replaced');
      return work(current, current.current);
    }));
  const existing = state.current?.id === id;
  const releaseUnstarted = async (token: string, preserveOpportunity = false): Promise<boolean> => {
    const actual = (await p.read()).current;
    if (actual?.id !== id || actual.requestToken !== token || actual.requestUndo?.token !== token
      || actual.transportState !== 'not_started') return false;
    try {
      await localSave(() => p.releaseRequestBudget?.(token) ?? Promise.resolve());
      await change((current, value) => {
        const undo = value.requestUndo;
        if (value.requestToken !== token || undo?.token !== token || value.transportState !== 'not_started') return;
        value.requests = undo.requests;
        value.requestStartedAt = undo.requestStartedAt;
        value.requestToken = undo.requestToken;
        value.retryStarted = undo.retryStarted;
        value.status = undo.status;
        value.transportState = undo.requests ? 'started' : 'not_started';
        if (undo.claimedOpportunity) {
          if (current.day === undo.day) current.used = Math.max(0, current.used - 1);
          current.claimedPriority = undo.claimedPriority;
          value.status = preserveOpportunity ? 'ready' : 'finished';
          if (!preserveOpportunity) value.endedAt = p.now();
        }
        value.reason = 'request_not_started';
        value.requestUndo = undefined;
      });
      return true;
    } catch { return false; } // Persisted not_started keeps only local cleanup pending.
  };
  if (existing && op.transportState === 'not_started' && op.requestUndo) {
    if (!await releaseUnstarted(op.requestUndo.token)) return 0;
    state = await p.read(); op = state.current!;
    if (op.status === 'finished') return 0;
  }
  const unsaved = unsavedAnswers.get(id);
  if (existing && unsaved?.epoch === op.epoch) {
    try {
      // Journal a paid answer before touching temporarily unreadable source stores.
      // This is not delivery: the normal validity checks below still gate every bubble.
      await change((state, current) => { current.messages = unsaved.messages; current.status = 'saving';
        current.reason = unsaved.silent ? 'silent_ready' : 'body_ready';
        current.transportState = 'started'; current.requestUndo = undefined;
        recordContactMotiveSelection(state, unsaved.phoneAttemptedAt); recordPhoneEmergencyReturn(state, current); });
      unsavedAnswers.delete(id);
      state = await p.read(); op = state.current!;
    } catch { return 0; }
  }
  if (existing && op.status === 'requesting') {
    if (p.now() < op.requestStartedAt + CONTACT_MODEL_REQUEST_TIMEOUT_MS) return 0;
    await change(current => {
      current.current!.transportState = 'unknown';
      recordContactMotiveSelection(current);
      current.current!.requestUndo = undefined;
      current.current!.reason = 'request_outcome_unknown';
      if (current.current!.failedAt === null) current.failure = { opportunityId: id,
        attemptedAt: current.current!.createdAt, motives: current.current!.motives };
      failContactOpportunity(current, p.now());
    });
    state = await p.read(); op = state.current!;
  }
  // A verified quiet return has no pending bubble to validate or hand off.
  // Finish its local receipts even when you spoke while the journal was offline.
  if (op.phoneEmergency && op.status === 'saving' && op.reason === 'silent_ready') {
    await localSave(() => p.completed(op!));
    await change(current => finishContactOpportunity(current, p.now(), 'silent'));
    return 0;
  }
  if (p.now() >= op.expiresAt) {
    if (existing) await change(current => finishContactOpportunity(current, p.now(), 'expired'));
    return 0;
  }
  const validity = await p.valid(op);
  if (validity !== 'valid') {
    if (existing && validity === 'chat') {
      await change((_current, value) => { if (value.messages.length || value.failedAt !== null) value.status = 'handoff'; });
    } else if (existing) {
      await change(current => finishContactOpportunity(current, p.now(), validity));
    }
    return 0;
  }
  if (op.status === 'handoff' || op.status === 'finished') return 0;
  if ((!existing || op.reason === 'proactive-budget-deferred') && p.now() < (state.checkAfterAt ?? 0)) return 0;
  if (op.status === 'saving' && op.saveRetryAt && p.now() < op.saveRetryAt) return 0;
  if (op.status === 'waiting_retry' && !contactRetryIsDue(op, p.now())) return 0;
  if (!op.messages.length) {
    const retry = op.status === 'waiting_retry';
    let started = false;
    let requestToken: string | undefined;
    let transportStarted = false;
    let transportOutcome: string | undefined;
    let phoneAttemptedAt: number | undefined;
    try {
      const answer = await p.generate({
        opportunity: op,
        ...(retry || op.reason === 'cost-window' || op.reason === 'cost-limit'
          || op.reason === 'proactive-budget-deferred' && op.requests > 0
          || op.reason === 'QWEN_CHAT_SOURCE_UNAVAILABLE' && !!state.toolReceipt
          ? { retry: state.toolReceipt ?? { continuationMessages: [], completedResults: [] } } : {}),
        beforeRequest: async () => {
          if (p.now() >= op!.expiresAt || await p.valid(op!) !== 'valid') throw new Error('contact-before-request-invalid');
          const token = `${id}:${p.now()}:${++requestSerial}`;
          requestToken = token;
          transportStarted = false;
          transportOutcome = undefined;
          await localSave(() => p.change(current => {
            if (!started && !existing && current.current?.id === id && current.current.requestToken !== token) {
              throw new Error('contact-already-claimed');
            }
            const deferredFirstRequest = !started && existing && current.current?.requests === 0
              && current.current.transportState === 'not_started'
              && ['cost-window', 'cost-limit', 'QWEN_CHAT_SOURCE_UNAVAILABLE', 'proactive-budget-deferred'].includes(current.current.reason ?? '');
            const claimedOpportunity = !started && !existing && current.current?.id !== id || deferredFirstRequest;
            const claimedPriority = current.claimedPriority;
            if (claimedOpportunity) {
              if (deferredFirstRequest) current.current!.status = 'finished';
              claimContactOpportunity(current, { ...op!, createdAt: p.now(), status: 'requesting', requests: 0,
                messages: [], savedMessageIds: [] });
              current.toolReceipt = undefined;
              for (const source of op!.sources) if (source.kind === 'heart' || source.kind === 'period') {
                current.claimedPriority = { ...current.claimedPriority, [source.kind]: `${source.id}:${source.version}` };
              }
            }
            const actual = current.current;
            if (!actual || actual.id !== id || actual.status === 'finished') throw new Error('contact-request-invalid');
            if (actual.requestToken === token) return;
            if (retry && actual.retryStarted) throw new Error('contact-retry-already-used');
            if ((!retry || actual.phoneEmergency) && actual.requests >= 3) throw new Error('contact-tool-request-limit');
            actual.requestUndo = { token, requests: actual.requests, requestStartedAt: actual.requestStartedAt,
              requestToken: actual.requestToken, status: actual.status, retryStarted: actual.retryStarted,
              claimedOpportunity, day: current.day, ...(claimedOpportunity ? { claimedPriority } : {}) };
            actual.requests += 1;
            actual.requestToken = token;
            actual.transportState = 'not_started'; actual.reason = 'request_preparing';
            actual.requestStartedAt = p.now(); actual.status = 'requesting';
            if (retry) actual.retryStarted = true;
          }));
          started = true;
          return token;
        },
        beforeTransport: async () => {
          if (p.now() >= op!.expiresAt || await p.valid(op!) !== 'valid') throw Error('contact-before-transport-invalid');
          await change((_state, value) => {
            if (value.requestToken !== requestToken || value.status === 'finished') throw Error('contact-request-replaced');
            // After this durable boundary, a process crash has an unknown transport outcome.
            value.transportState = 'unknown'; value.reason = 'request_prepared';
          });
        },
        onTransportStarted: () => { transportStarted = true; phoneAttemptedAt ??= p.now(); },
        onTransportFinished: outcome => { transportOutcome = outcome; },
        onTools: async receipt => {
          await change((current, value) => {
            if (value.epoch !== op!.epoch || value.status === 'finished') throw new Error('contact-tool-stale');
            current.toolReceipt = receipt;
            if (transportStarted && value.requestToken === requestToken) {
              value.transportState = 'started'; value.requestUndo = undefined;
              recordContactMotiveSelection(current, phoneAttemptedAt);
            }
          });
        },
      });
      if (!started) return 0;
      const silent = !Array.isArray(answer) && answer.kind === 'silent' && !!op.phoneEmergency;
      const messages = Array.isArray(answer) ? answer : [];
      if (!silent && (!messages.length || messages.some(text => !text.trim()))) throw new Error('contact-empty');
      if (op.phoneEmergency && (!transportStarted || transportOutcome !== 'response_received')) throw new Error('contact-phone-return-unverified');
      if (p.isEpochCurrent && !p.isEpochCurrent(op.epoch)) return 0;
      unsavedAnswers.set(id, { epoch: op.epoch, messages, phoneAttemptedAt, ...(silent ? { silent: true as const } : {}) });
      await change((current, value) => { value.messages = messages; value.status = 'saving';
        value.transportState = 'started'; value.requestUndo = undefined; value.reason = silent ? 'silent_ready' : 'body_ready';
        recordContactMotiveSelection(current, phoneAttemptedAt); recordPhoneEmergencyReturn(current, value); });
      unsavedAnswers.delete(id);
      if (!silent) {
        const current = (await p.read()).current!;
        let resultValidity: Awaited<ReturnType<UnifiedContactPorts['valid']>>;
        try { resultValidity = await p.valid(current); }
        catch { return 0; } // Paid body is durable; next existing check only revalidates and saves it.
        if (resultValidity !== 'valid' || p.now() >= current.expiresAt) {
          await change(value => finishContactOpportunity(value, p.now(), p.now() >= current.expiresAt ? 'expired' : resultValidity));
          return 0;
        }
      }
    } catch (error) {
      if (p.isRequestDeferred?.(error)) {
        // An admission wait is not a failed body retry. Keep the original paid
        // tool receipts and request count, without claiming a fresh opportunity.
        let actual = (await p.read()).current;
        const budgetUntil = contactBudgetDeferredUntil(error);
        if (requestToken && !transportStarted && actual?.requestUndo?.token === requestToken) {
          await change((_state, value) => { value.transportState = 'not_started'; });
          if (!await releaseUnstarted(requestToken, true)) return 0;
          actual = (await p.read()).current;
        }
        if (actual?.id === id && actual.status !== 'finished') await change((state, value) => {
          if (transportStarted) recordContactMotiveSelection(state, phoneAttemptedAt);
          value.status = retry ? 'waiting_retry' : 'ready';
          value.reason = budgetUntil !== undefined ? 'proactive-budget-deferred' : error instanceof Error ? error.message : 'cost-window';
          if (budgetUntil !== undefined) state.checkAfterAt = Math.min(value.expiresAt, budgetUntil);
        });
        else if ((!actual || actual.status === 'finished') && budgetUntil !== undefined) await localSave(() => p.change(state => {
          if (!state.current || state.current.status === 'finished') state.checkAfterAt = Math.min(op!.expiresAt, budgetUntil);
        }));
        return 0;
      }
      if (requestToken && !transportStarted) {
        const actual = (await p.read()).current;
        if (actual?.id === id && actual.requestToken === requestToken && actual.requestUndo?.token === requestToken) {
          if (actual.transportState !== 'not_started') {
            try { await change((_state, value) => {
              if (value.requestToken === requestToken) value.transportState = 'not_started';
            }); } catch { return 0; }
          }
          if (!await releaseUnstarted(requestToken)) return 0;
          const restored = (await p.read()).current;
          if (!restored?.requests || restored.status === 'waiting_retry') return 0;
        }
      }
      if (!started) return 0; // Budget or preflight failure does not spend an opportunity.
      if (unsavedAnswers.has(id)) return 0; // Only resume local saving of this paid answer.
      const actual = (await p.read()).current;
      if (actual?.id === id && actual.status !== 'finished' && !actual.messages.length) {
        await change(value => {
          value.current!.transportState = 'started'; value.current!.requestUndo = undefined;
          recordContactMotiveSelection(value, phoneAttemptedAt);
          const failureReason = contactGenerationFailureReason(error, transportOutcome);
          value.current!.reason = failureReason;
          if (value.current!.failedAt === null) value.failure = { opportunityId: id,
            attemptedAt: value.current!.createdAt, motives: value.current!.motives };
          failContactOpportunity(value, p.now());
          // Closing the original retry must not erase its safe failure cause.
          value.current!.reason = failureReason;
        });
      }
      return 0;
    }
  }
  state = await p.read(); op = state.current!;
  let inserted = 0;
  for (let index = 0; index < op.messages.length; index += 1) {
    const messageId = contactMessageId(op, index);
    if (op.savedMessageIds.includes(messageId)) continue;
    const currentValidity = await p.valid(op);
    if (p.now() >= op.expiresAt || currentValidity !== 'valid') {
      if (currentValidity === 'chat') await change((_state, current) => { current.status = 'handoff'; });
      else {
        await change(current => finishContactOpportunity(current, p.now(), p.now() >= op!.expiresAt ? 'expired' : currentValidity));
      }
      return inserted;
    }
    const message: SubjectiveMessage = { id: messageId, role: 'I', content: op.messages[index],
      createdAt: p.now(), source: 'proactive-message' };
    let savedMessage = message;
    try {
      await localSave(async () => {
        if (p.now() >= op!.expiresAt || await p.valid(op!) !== 'valid') throw new Error('contact-save-invalid');
        if (!await p.save(message, op!)) throw new Error('contact-save-deferred');
      });
      const saved = p.readSaved ? await p.readSaved(op.sessionId, messageId) : message;
      if (!saved) throw new Error('contact-saved-message-missing');
      savedMessage = saved;
      await change((state, current) => {
        recordSavedContactMessage(state, current, saved);
        if (!current.savedMessageIds.includes(messageId)) throw new Error('contact-saved-message-mismatch');
        current.saveRetryAt = undefined;
      });
    } catch {
      // append may have committed before the runtime record failed. Recover that
      // fact before a later source change/expiry can clear the retained answer.
      try { await recoverUnifiedContactSavedMessages(p); } catch { return inserted; }
      const validity = await p.valid(op);
      await change((state, current) => {
        if (validity === 'chat') current.status = 'handoff';
        else if (validity !== 'valid') finishContactOpportunity(state, p.now(), validity);
        else current.saveRetryAt = p.now() + 60_000;
      }).catch(() => undefined);
      return inserted;
    }
    inserted += 1;
    await p.delivered(message, op).catch(() => undefined); // Notification is not generation or saving.
    try { await recordSavedContactMaterials(p, op, savedMessage); }
    catch {
      // The bubble is already saved. Keep only the existing opportunity for local
      // receipt recovery; do not report delivery failure or regenerate/re-send it.
      await change((_state, current) => { current.saveRetryAt = p.now() + 60_000; }).catch(() => undefined);
      return inserted;
    }
    if (index + 1 < op.messages.length) await p.waitBetweenBubbles();
  }
  op = (await p.read()).current!;
  await localSave(() => p.completed(op!));
  await change(current => finishContactOpportunity(current, p.now(), op!.reason === 'silent_ready' ? 'silent' : 'delivered'));
  return inserted;
}
