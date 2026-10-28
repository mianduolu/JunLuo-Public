import { readUnifiedContactState, changeUnifiedContactState, recoverStoredUnifiedContactMessages } from './unifiedContactStore';
import { buildContactFailureMaterial } from './unifiedContactMaterials';
import { buildUnsentContactMessages, contactMessageId, finishContactOpportunity, isContactPastMemorySource, type ContactOpportunity } from './unifiedContact';
import { canCommitBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { loadChatSessionMessage } from '../chat/chatStorage';
import { fingerprintPromptText } from '../ai/promptCacheMetrics';
import { readQwenChatSource, QwenChatSourceInvalid, type QwenChatSource, type QwenChatLayoutMode } from '../ai/qwenChatLayout';
import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import { commitUnifiedContactShares, validateUnifiedContactShare, type UnifiedContactShareRef } from './unifiedContactShares';
import { loadPriorityHeartContact } from '../bodySignal/bodySignalProactiveCareRuntime';
import { loadPriorityPeriodContact } from '../period/periodCareEvents';
import { getBaiyunContinuityEvent } from '../ai/behavior/continuityLedger';
import { buildNearStatusLifeMaterialSnapshot, loadReferencedToolLifeMaterial,
  isFocusSummaryLifeMaterialId, loadReferencedFocusSummaryLifeMaterial } from '../ai/lifeMaterialHub';
import { isWishProactiveSource, wishProactiveSourcesCurrent } from '../wishPool/wishProactiveMaterials';
import { isContactOwnLifeId, loadContactOwnLife } from './unifiedContactOwnLife';
import { recoverUnifiedContactSavedMessages } from './unifiedContactRuntime';

export function contactQwenChatMode(op: ContactOpportunity): QwenChatLayoutMode | undefined {
  return op.qwenChatSource ? op.important ? 'important_raw' : 'ordinary' : undefined;
}

export function contactQwenChatSource(op: ContactOpportunity): QwenChatSource {
  const source = op.qwenChatSource;
  if (!source || source.version !== 1 || typeof source.connectionFingerprint !== 'string' || !source.connectionFingerprint
    || Object.keys(source).length !== 3
    || !Array.isArray(source.messageIds) || !source.messageIds.length
    || new Set(source.messageIds).size !== source.messageIds.length) throw new QwenChatSourceInvalid();
  const refs = source.messageIds.map(id => {
    const ref = op.sourceMessages.find(entry => entry.id === id);
    if (typeof id !== 'string' || !id || typeof ref?.version !== 'string' || !ref.version) throw new QwenChatSourceInvalid();
    return { id, revision: ref.version };
  });
  return { version: 1, connectionFingerprint: source.connectionFingerprint, sessionId: op.sessionId, refs };
}

export async function contactSourcesCurrent(
  op: NonNullable<Awaited<ReturnType<typeof readUnifiedContactState>>['current']>,
  writingMessages?: readonly SubjectiveMessage[],
) {
  const invalid = (reason: string, sourceKind?: ContactOpportunity['sources'][number]['kind']) => {
    console.info('[unified-contact-check]', { stage: 'source', reason, sourceKind,
      important: op.important, status: op.status, requests: op.requests, createdAt: op.createdAt });
    return false;
  };
  if (!canCommitBackupRestoreDataEpoch(op.epoch)) return invalid('epoch');
  if (Date.now() >= op.expiresAt) return invalid('deadline');
  if (op.qwenChatSource) {
    try {
      await readQwenChatSource(contactQwenChatSource(op), (sessionId, id) => writingMessages
        ? Promise.resolve(writingMessages.find(message => message.id === id) ?? null)
        : loadChatSessionMessage(sessionId, id), undefined, contactQwenChatMode(op));
    } catch (error) {
      if (error instanceof QwenChatSourceInvalid) return invalid('qwen_source_unknown_subreason');
      throw error; // A temporary read outage is waiting, never confirmed deletion.
    }
  }
  if (!await wishProactiveSourcesCurrent(op.sources)) return invalid('wish_source', 'life');
  for (const ref of op.sourceMessages) {
    if (op.qwenChatSource?.messageIds.includes(ref.id)) continue; // Already checked against the original above.
    const message = writingMessages ? writingMessages.find(message => message.id === ref.id)
      : await loadChatSessionMessage(op.sessionId, ref.id);
    if (!message) return invalid('chat_missing');
    if (fingerprintPromptText(JSON.stringify([message.role, message.content, message.createdAt])) !== ref.version) return invalid('chat_version');
  }
  const handled = new Set(op.handledSources ?? []);
  for (const ref of op.sources) {
    if (isContactPastMemorySource(ref)) {
      const { loadContactPastMemory } = await import('./unifiedContactMemory');
      if (!await loadContactPastMemory(ref, writingMessages ? { sessionId: op.sessionId, messages: writingMessages } : undefined)) return invalid('past_memory_source', ref.kind);
      continue;
    }
    if (handled.has(`${ref.kind}:${ref.id}`)) continue;
    if (ref.kind === 'heart' || ref.kind === 'period') {
      const live = ref.kind === 'heart' ? await loadPriorityHeartContact() : await loadPriorityPeriodContact();
      if (!live) return invalid(`${ref.kind}_missing`, ref.kind);
      if (live.id !== ref.id) return invalid(`${ref.kind}_identity`, ref.kind);
      if (live.version !== ref.version) return invalid(`${ref.kind}_version`, ref.kind);
      if (Date.now() >= live.expiresAt) return invalid(`${ref.kind}_deadline`, ref.kind);
    } else if (ref.kind === 'care') {
      const event = await getBaiyunContinuityEvent(ref.id, true);
      if (!event) return invalid('care_missing', ref.kind);
      if (String(event.revision) !== ref.version) return invalid('care_version', ref.kind);
      if (!['open', 'waiting'].includes(event.status)) return invalid('care_status', ref.kind);
    } else if (ref.kind === 'web' || ref.kind === 'nearby' || ref.kind === 'social') {
      if (!await validateUnifiedContactShare(ref as UnifiedContactShareRef)) return invalid(`${ref.kind}_source`, ref.kind);
    } else if (ref.kind === 'current_state') {
      const { loadContactCurrentState } = await import('./unifiedContactCurrentState');
      if (!await loadContactCurrentState(ref, writingMessages ? { sessionId: op.sessionId, messages: writingMessages } : undefined)) return invalid('current_state_source', ref.kind);
    } else if (ref.kind === 'weekly_review') {
      const { loadContactWeeklyReview } = await import('./unifiedContactWeeklyReview');
      if (!await loadContactWeeklyReview(ref)) return invalid('weekly_review_source', ref.kind);
    }
  }
  // Phone/weather are dated passive observations, not editable instructions or
  // cancellation sources. A fresh sample (or cache expiry) cannot cancel contact.
  const lifeRefs = op.sources.filter(ref => ref.kind === 'life' && !isContactPastMemorySource(ref) && !isWishProactiveSource(ref) && !handled.has(`${ref.kind}:${ref.id}`)
    && ref.id !== 'ambient:phone' && ref.id !== 'ambient:weather');
  if (lifeRefs.length) {
    const progress = lifeRefs.some(ref => ref.id.startsWith('schedule-progress:'))
      ? await import('../schedule/chatScheduleUnknownProgress') : null;
    const life = lifeRefs.some(ref => !ref.id.startsWith('tool:') && !isContactOwnLifeId(ref.id) && !progress?.isChatScheduleProgressId(ref.id))
      ? await buildNearStatusLifeMaterialSnapshot(Date.now(), { includeAssistantSchedule: true,
        nearStatusFocusSummaries: op.materialVersion === 2,
        includeWearableSleep: lifeRefs.some(ref => ref.id.startsWith('body-signal:sleep:')),
        includeWearableSteps: lifeRefs.some(ref => ref.id.startsWith('body-signal:steps:')) }) : null;
    for (const ref of lifeRefs) {
      if (progress?.isChatScheduleProgressId(ref.id)) {
        if (!await progress.loadChatScheduleProgress(ref)) return invalid('life_schedule_progress', ref.kind);
        continue;
      }
      if (isContactOwnLifeId(ref.id)) {
        const item = await loadContactOwnLife(ref);
        if (!item) return invalid('life_own_missing', ref.kind);
        if (item.version !== ref.version) return invalid('life_own_version', ref.kind);
        continue;
      }
      if (isFocusSummaryLifeMaterialId(ref.id)) {
        const item = await loadReferencedFocusSummaryLifeMaterial(ref.id);
        if (!item) return invalid('life_focus_missing', ref.kind);
        if (item.fingerprint !== ref.version) return invalid('life_focus_version', ref.kind);
        continue;
      }
      const tool = ref.id.startsWith('tool:');
      const item = tool ? await loadReferencedToolLifeMaterial(ref.id.slice('tool:'.length))
        : life?.items.find(item => item.id === ref.id);
      if (!tool && !item && life?.debug?.dropped.length) throw Error('contact-life-source-read-unavailable');
      if (!item) return invalid(tool ? 'life_tool_missing' : 'life_snapshot_missing', ref.kind);
      if (item.fingerprint !== ref.version) return invalid(tool ? 'life_tool_version' : 'life_snapshot_version', ref.kind);
    }
  }
  if (!canCommitBackupRestoreDataEpoch(op.epoch)) return invalid('epoch_after_read');
  return Date.now() < op.expiresAt || invalid('deadline_after_read');
}

export type ContactChatHandoff = { opportunityId?: string; failureId?: string; material: string };
export async function isUnifiedContactChatHandoffCurrent(handoff: ContactChatHandoff): Promise<boolean> {
  if (!handoff.opportunityId) return true;
  const op = (await readUnifiedContactState()).current;
  return !!op && op.id === handoff.opportunityId && op.status !== 'finished' && await contactSourcesCurrent(op);
}
export async function prepareUnifiedContactChatHandoff(readOnly = false): Promise<ContactChatHandoff | null> {
  if (!readOnly) await recoverStoredUnifiedContactMessages();
  let state = await readUnifiedContactState();
  if (readOnly) await recoverUnifiedContactSavedMessages({ read: async () => state,
    change: async work => work(state), readSaved: loadChatSessionMessage,
    isEpochCurrent: canCommitBackupRestoreDataEpoch });
  let op = state.current;
  if (!readOnly && op && op.status !== 'finished' && canCommitBackupRestoreDataEpoch(op.epoch)
    && !await contactSourcesCurrent(op)) {
    // A confirmed missing/changed source cannot be handed off. Read errors propagate
    // and leave the opportunity untouched so a temporary outage is not deletion.
    const stale = op;
    await changeUnifiedContactState(current => {
      if (current.current?.id === stale.id) finishContactOpportunity(current, Date.now(),
        Date.now() >= stale.expiresAt ? 'expired' : 'stale');
    }, stale.epoch);
    state = await readUnifiedContactState(); op = state.current;
  }
  const remaining = op && !op.sleepGreeting && op.status !== 'finished' && await contactSourcesCurrent(op)
    ? op.messages.filter((_text, index) => !op.savedMessageIds.includes(contactMessageId(op, index))) : [];
  const failureMaterial = buildContactFailureMaterial(state);
  const material = [failureMaterial, buildUnsentContactMessages(remaining)].filter(Boolean).join('\n\n');
  return material ? { opportunityId: remaining.length ? op!.id : undefined,
    failureId: failureMaterial ? state.failure!.opportunityId : undefined, material } : null;
}

export async function commitUnifiedContactChatHandoff(handoff: ContactChatHandoff, savedAt: number, reply: readonly SubjectiveMessage[] = [], replySessionId?: string): Promise<void> {
  await recoverStoredUnifiedContactMessages();
  const op = (await readUnifiedContactState()).current;
  if (handoff.opportunityId && (!op || op.id !== handoff.opportunityId || !await contactSourcesCurrent(op))) return;
  if (op && op.id === handoff.opportunityId) {
    const original = await Promise.all(op.savedMessageIds.map(id => loadChatSessionMessage(op.sessionId, id)));
    if (!await contactSourcesCurrent(op)) return;
    const refs = op.sources.filter((source): source is UnifiedContactShareRef => source.kind === 'web' || source.kind === 'nearby' || source.kind === 'social');
    for (const [messages, sessionId] of [
      [original.filter((message): message is SubjectiveMessage => message !== null), op.sessionId],
      [reply, replySessionId ?? op.sessionId],
    ] as const) {
      const consumed = await commitUnifiedContactShares(refs, messages, sessionId, savedAt,
        () => canCommitBackupRestoreDataEpoch(op.epoch));
      if (consumed.length) await changeUnifiedContactState(state => {
        if (state.current?.id === op.id) state.current.handledSources = [...new Set([
          ...(state.current.handledSources ?? []), ...refs.filter(ref => consumed.includes(ref.id)).map(ref => `${ref.kind}:${ref.id}`),
        ])];
      }, op.epoch);
    }
  }
  if (handoff.opportunityId) {
    const current = (await readUnifiedContactState()).current;
    if (!current || current.id !== handoff.opportunityId || !await contactSourcesCurrent(current)) return;
  }
  await changeUnifiedContactState(state => {
    if (handoff.failureId && state.failure?.opportunityId === handoff.failureId) {
      state.failureAcknowledgedId = handoff.failureId;
    }
    if (state.current && (state.current.id === handoff.opportunityId || state.current.id === handoff.failureId)) {
      finishContactOpportunity(state, savedAt, 'chat_handoff_delivered');
      state.current.messages = [];
      state.toolReceipt = undefined;
    }
  }, op?.epoch);
}
