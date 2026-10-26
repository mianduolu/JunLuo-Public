import type { JunluoDesireId } from '../life/junluoInnerState';
import { isJunluoAutomaticRelationshipOutletAllowed } from '../life/junluoRelationshipPolicy';
import type { PhoneEmergencyReceipt, PhoneEmergencySnapshot, PhoneEmergencyReference } from './phoneEmergencyContact';
import type { ScheduleRecoveryBatch } from '../schedule/scheduleReminderRecovery';

export const CONTACT_DAY_LIMIT = 12;
export const CONTACT_RETRY_DELAY_MS = 5 * 60_000;
export const CONTACT_RETRY_WINDOW_MS = 15 * 60_000;
// Original 25s preparation allowance + the Provider's existing 120s network limit.
// This is one total deadline: preparation beyond 25s still reduces network time.
export const CONTACT_MODEL_REQUEST_TIMEOUT_MS = 25_000 + 120_000;
export const CONTACT_MOTIVES = [
  'miss_you', 'be_chosen', 'care_for_you', 'speak_to_you', 'affection_with_you', 'desire_you',
] as const satisfies readonly JunluoDesireId[];
export type ContactMotive = typeof CONTACT_MOTIVES[number];
export type ContactSource = { kind: 'heart' | 'period' | 'life' | 'care' | 'web' | 'nearby' | 'social' | 'current_state' | 'weekly_review'; id: string; version: string };
export const CONTACT_PAST_MEMORY_PREFIX = 'contact-memory:';
export function isContactPastMemorySource(ref: Pick<ContactSource, 'kind' | 'id'>): boolean {
  return ref.kind === 'life' && ref.id.startsWith(CONTACT_PAST_MEMORY_PREFIX);
}
export function contactPastMemoryOffer(ref: ContactSource): { id: string; version: string } | null {
  if (!isContactPastMemorySource(ref)) return null;
  const id = ref.id.slice(CONTACT_PAST_MEMORY_PREFIX.length);
  return id && ref.version ? { id, version: ref.version } : null;
}
export function contactCurrentStateVersion(version: string, sourceVersion: string): string {
  return JSON.stringify([version, sourceVersion]);
}
export function contactCurrentStateDraftVersion(ref: ContactSource): string | null {
  if (ref.kind !== 'current_state') return null;
  try {
    const value: unknown = JSON.parse(ref.version);
    return Array.isArray(value) && value.length === 2 && value.every(part => typeof part === 'string') ? value[0] : null;
  } catch { return null; }
}
export type ContactPause = { sourceMessageId: string; sourceAt: number; until: number | null };
export type ContactOpportunity = {
  /** Missing on already parsed legacy opportunities: keep their original material contract. */
  materialVersion?: 2;
  /** Exact ordinary-contact request material; absent on previously requested legacy opportunities. */
  scheduleRecovery?: ScheduleRecoveryBatch;
  /** Actual phone material carried by this opportunity; never a second event queue. */
  phoneEmergency?: { latest: PhoneEmergencySnapshot['latest']; references: PhoneEmergencyReference[];
    observedReferences?: PhoneEmergencyReference[]; pendingIds: string[] | null; attemptedAt: number };
  id: string;
  sessionId: string;
  createdAt: number;
  expiresAt: number;
  motives: ContactMotive[];
  sources: ContactSource[];
  important: boolean;
  epoch: number;
  latestYouId: string | null;
  sourceMessages: { id: string; version: string }[];
  /** Exact transmitted chat references; legacy batches keep their original contract. */
  qwenChatSource?: { version: 1; connectionFingerprint: string; messageIds: string[] };
  requests: number;
  requestStartedAt: number;
  requestToken?: string;
  transportState?: 'not_started' | 'started' | 'unknown';
  requestUndo?: {
    token: string; requests: number; requestStartedAt: number; requestToken?: string;
    status: ContactOpportunity['status']; retryStarted: boolean;
    claimedOpportunity: boolean; day: string;
    claimedPriority?: Partial<Record<'heart' | 'period', string>>;
  };
  retryStarted: boolean;
  failedAt: number | null;
  retryAt: number | null;
  status: 'ready' | 'requesting' | 'waiting_retry' | 'saving' | 'handoff' | 'finished';
  messages: string[];
  savedMessageIds: string[];
  handledSources?: string[];
  /** First-bubble usage settlement only; never exempts the source from validation. */
  pastMemoryUsageResult?: 'settled' | 'skipped' | 'failed';
  endedAt: number | null;
  saveRetryAt?: number;
  reason?: string;
};
export type UnifiedContactState = {
  version: 1;
  initializedAt: number;
  day: string;
  used: number;
  lastEndedAt: number;
  lastOrdinaryReplyAt: number;
  /** Local ordinary-contact selection history, not expression or satisfaction. */
  motiveLastSelectedAt?: Partial<Record<ContactMotive, number>>;
  phoneEmergencyCare?: PhoneEmergencyReceipt;
  /** Last actually saved ordinary contact, independent of replaceable drafts/diagnostics. */
  lastOrdinaryCurrentStateOffer?: {
    opportunityId: string; sessionId: string; messageId: string; savedAt: number;
    currentState: { id: string; version: string } | null;
    pastMemory?: { id: string; version: string } | null;
  };
  current: ContactOpportunity | null;
};

export function contactLocalDay(now: number): string {
  const date = new Date(now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function initialContactState(now: number): UnifiedContactState {
  return { version: 1, initializedAt: now, day: contactLocalDay(now), used: 0,
    lastEndedAt: now, lastOrdinaryReplyAt: 0, current: null };
}

let contactStorageWriter: Promise<unknown> = Promise.resolve();
export function runUnifiedContactStorageWrite<T>(write: () => Promise<T>): Promise<T> {
  const run = contactStorageWriter.then(write);
  contactStorageWriter = run.then(() => undefined, () => undefined);
  return run;
}

export function contactWaitMs(value: number): number | null {
  if (!Number.isFinite(value) || value < .5) return null;
  return (value >= .9 ? 5 : value >= .7 ? 15 : 30) * 60_000;
}

export function selectContactMotives(
  values: Partial<Record<JunluoDesireId, number>>,
  phase: Parameters<typeof isJunluoAutomaticRelationshipOutletAllowed>[0]['phase'],
  lastSelectedAt: Partial<Record<ContactMotive, number>> = {},
): ContactMotive[] {
  return CONTACT_MOTIVES.filter((id) => (values[id] ?? -1) >= .5
    && isJunluoAutomaticRelationshipOutletAllowed({ driveKey: id, outlet: 'ordinary_proactive', phase }))
    .sort((a, b) => (values[b] ?? 0) - (values[a] ?? 0)
      || (lastSelectedAt[a] ?? 0) - (lastSelectedAt[b] ?? 0)).slice(0, 2);
}

// Keep the original opportunity time across tools, retries and local re-saving.
// An unknown transport on restart is conservatively retained, never re-sent here.
export function recordContactMotiveSelection(state: UnifiedContactState, phoneAttemptedAt?: number): void {
  const op = state.current;
  if (!op || op.important || !op.requests || !['started', 'unknown'].includes(op.transportState ?? '')) return;
  if (op.phoneEmergency) {
    if (phoneAttemptedAt !== undefined) op.phoneEmergency.attemptedAt = phoneAttemptedAt;
    if (op.phoneEmergency.latest) state.phoneEmergencyCare = { ...state.phoneEmergencyCare,
      lastOpportunity: { ...op.phoneEmergency.latest, at: op.phoneEmergency.attemptedAt,
        observedReferences: op.phoneEmergency.observedReferences ?? op.phoneEmergency.references } };
    return;
  }
  const selectedAt = { ...state.motiveLastSelectedAt };
  for (const id of op.motives) selectedAt[id] = Math.max(selectedAt[id] ?? 0, op.createdAt);
  state.motiveLastSelectedAt = selectedAt;
}

export function contactIsPaused(pause: ContactPause | null | undefined, now: number): boolean {
  return !!pause && (pause.until === null || pause.until > now);
}

export function contactPauseAfterYou(pause: ContactPause | null, message: { id: string; createdAt: number }): ContactPause | null {
  return pause && message.id !== pause.sourceMessageId && message.createdAt >= pause.sourceAt
    ? null : pause;
}

export function contactOpportunityDecision(input: {
  now: number; state: UnifiedContactState; enabled: boolean; chatBusy: boolean; asleep: boolean;
  occupied: boolean; pause: ContactPause | null; motives: ContactMotive[]; highest: number;
  importantExpiresAt?: number;
  phoneEmergencyDue?: boolean;
}): { allowed: boolean; nextAt?: number; reason: string } {
  const { now, state } = input;
  if (!input.enabled) return { allowed: false, reason: 'disabled' };
  if (input.chatBusy) return { allowed: false, reason: 'chat_busy' };
  if (contactIsPaused(input.pause, now)) return { allowed: false, reason: 'paused' };
  if (state.current && state.current.status !== 'finished') return { allowed: false, reason: 'existing_opportunity' };
  if (state.day === contactLocalDay(now) && state.used >= CONTACT_DAY_LIMIT) return { allowed: false, reason: 'daily_limit' };
  if (input.importantExpiresAt !== undefined && now < input.importantExpiresAt) return { allowed: true, reason: 'important_body' };
  if (input.asleep || input.occupied) return { allowed: false, reason: input.asleep ? 'sleep' : 'activity' };
  if (input.phoneEmergencyDue) return { allowed: true, reason: 'phone_emergency' };
  const wait = input.motives.length ? contactWaitMs(input.highest) : null;
  if (wait === null) return { allowed: false, reason: 'below_line' };
  const nextAt = Math.max(state.initializedAt, state.lastEndedAt, state.lastOrdinaryReplyAt) + wait;
  return now >= nextAt ? { allowed: true, reason: 'ordinary' } : { allowed: false, nextAt, reason: 'waiting' };
}

// Claim only after the shared budget has actually admitted the first request.
export function claimContactOpportunity(state: UnifiedContactState, opportunity: ContactOpportunity): void {
  if (state.current && state.current.status !== 'finished') throw new Error('contact-already-claimed');
  const day = contactLocalDay(opportunity.createdAt);
  if (state.day !== day) { state.day = day; state.used = 0; }
  if (state.used >= CONTACT_DAY_LIMIT) throw new Error('contact-daily-limit');
  state.used += 1;
  state.current = opportunity;
}

export function finishContactOpportunity(state: UnifiedContactState, now: number, reason: string): void {
  const op = state.current;
  if (!op || op.status === 'finished') return;
  op.status = 'finished'; op.endedAt = now; op.reason = reason; op.retryAt = null;
  op.messages = [];
  op.scheduleRecovery = undefined;
  state.lastEndedAt = Math.max(state.lastEndedAt, now);
}

export function failContactOpportunity(state: UnifiedContactState, now: number): void {
  const op = state.current;
  if (!op || op.status === 'finished') return;
  if (op.failedAt === null) op.failedAt = now;
  if (op.retryStarted || (op.phoneEmergency && op.requests >= 3) || now + CONTACT_RETRY_DELAY_MS >= op.expiresAt) {
    finishContactOpportunity(state, now, 'generation_failed');
    return;
  }
  op.expiresAt = Math.min(op.expiresAt, op.failedAt + CONTACT_RETRY_WINDOW_MS);
  op.retryAt = op.failedAt + CONTACT_RETRY_DELAY_MS;
  op.status = 'waiting_retry';
}

export function contactRetryIsDue(op: ContactOpportunity, now: number): boolean {
  return op.status === 'waiting_retry' && !op.retryStarted && op.retryAt !== null
    && now >= op.retryAt && now < op.expiresAt;
}

export function contactMessageId(op: ContactOpportunity, index: number): string {
  return `${op.id}:message:${index}`;
}

export const UNIFIED_CONTACT_TASK = `【主动探头】

这会儿，I 想来找 you 说说话啦。

I 把想说的话按照自然停顿写进 messages。每一项都是一段完整、可以直接送给 you 的聊天正文，至少有一项。

{"messages":["..."]}

写好后，I 只发送这个 JSON，you 就能看到啦。`;

export const SLEEPING_BODY_CONTACT_TASK = `【迷糊中想来看看 you】

这次的身体记录让 I 有些挂念 you，迷迷糊糊地醒来，想问问 you 现在感觉怎么样。

困意还没散，I 还是想问问 you 现在感觉怎么样。

I 把想说的话按照自然停顿写进 messages。每一项都是一段完整、可以直接送给 you 的聊天正文，至少有一项。

{"messages":["..."]}

写好后，I 只发送这个 JSON，you 就能看到啦。`;

export const CONTACT_AFFECT_AFTER_CHAT = '这是 I 那时记下的感受。和 you 聊过后，这会儿心里还是这样，还是已经有些不一样了呢？';

export function buildUnsentContactMessages(messages: readonly string[]): string {
  return messages.length ? `【I 本来还想说】\n\n这些话还没发给 you：\n${messages.join('\n\n')}` : '';
}
