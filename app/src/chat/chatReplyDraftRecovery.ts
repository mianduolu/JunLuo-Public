import { Platform } from 'react-native';
import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import { canCommitBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import { isBodySignalCareDoorbellCurrent, commitBodySignalCareDoorbell } from '../bodySignal/bodySignalCareDoorbell';
import { isChatSleepReplyCurrent } from '../life/sleepPlanStore';
import { isPostRecallCurrent } from '../posts/baiyunPostKnown';
import { isUnifiedContactChatHandoffCurrent, contactSourcesCurrent, commitUnifiedContactChatHandoff } from '../proactive/unifiedContactHandoff';
import { readUnifiedContactState, noteOrdinaryContactReply } from '../proactive/unifiedContactStore';
import { isWebVoyageChatHandoffCurrent, commitWebVoyageChatHandoff } from '../proactive/webVoyageChatHandoff';
import { getToolDefinition, listToolPackages } from '../tools/toolRegistry';
import { resolveToolPermissionForCall } from '../tools/toolPermissions';
import { CHAT_IMAGE_TOOL_ID } from './chatImageMaterials';
import { chatImageQuestionRevision, chatImageSourceRevision } from './chatImageRecord';
import { readingMessageSourcesCurrent } from './chatReadingReferences';
import { chatReplyDraftBodyState, isChatReplyDraftSourceCurrent, type ChatReplyDraft } from './chatReplyDraft';
import { holdChatReplyMessageIds } from './chatPersistenceCoordinator';
import { appendPendingChatReplyDraft, discardPendingChatReplyDraft, loadPendingChatReplyDraft,
  loadChatSessionMessage, loadChatSessionMessageOrder, recordTheaterBackstageReplySource } from './chatStorage';
import { completeSleepingMessages } from './sleepInteraction';

async function readDraftMessages(draft: ChatReplyDraft, includeSourceTail = false) {
  const order = await loadChatSessionMessageOrder(draft.sessionId, { strict: true });
  const ids = new Set(draft.messages.map(message => message.id));
  if (includeSourceTail) {
    ids.add(draft.source.messageId);
    draft.turnSources.forEach(source => ids.add(source.messageId));
    const sourceIndex = order.findIndex(entry => entry.id === draft.source.messageId);
    if (sourceIndex >= 0) order.slice(sourceIndex).forEach(entry => ids.add(entry.id));
  }
  const records = await Promise.all(order.filter(entry => ids.has(entry.id))
    .map(entry => loadChatSessionMessage(draft.sessionId, entry.id)));
  return records.filter((message): message is SubjectiveMessage => message !== null);
}

/** Read the original source versions; never prepare a new turn or invoke a tool. */
export async function areChatReplyDraftSourcesCurrent(draft: ChatReplyDraft, writingMessages?: readonly SubjectiveMessage[]): Promise<boolean> {
  const read = (id: string) => writingMessages
    ? Promise.resolve(writingMessages.find(message => message.id === id) ?? null)
    : loadChatSessionMessage(draft.sessionId, id);
  const sources = draft.sources;
  if (Platform.OS === 'android' && !await isChatSleepReplyCurrent({ sessionId: draft.sessionId,
    turnId: draft.source.messageId, sourceMessageIds: draft.turnSources.map(source => source.messageId),
    startedAt: draft.startedAt })) return false;
  if (!await readingMessageSourcesCurrent(sources.reading ?? [], read, sources.readingCommand)) return false;
  if (sources.post && !await isPostRecallCurrent(sources.post, true)) return false;
  if (sources.bodyCare && !await isBodySignalCareDoorbellCurrent(sources.bodyCare)) return false;
  if (sources.contact) {
    if (writingMessages && sources.contact.opportunityId) {
      const op = (await readUnifiedContactState()).current;
      if (!op || op.id !== sources.contact.opportunityId || op.status === 'finished'
        || !await contactSourcesCurrent(op, writingMessages)) return false;
    } else if (!await isUnifiedContactChatHandoffCurrent(sources.contact)) return false;
  }
  if (sources.web && !await isWebVoyageChatHandoffCurrent(sources.web)) return false;
  if (sources.image) {
    const { sources: image, imageNumber, accessAtUse, initiallyUnavailable } = sources.image;
    for (const ref of [image.question, ...image.reviewQuestions]) {
      const message = await read(ref.messageId);
      if (!message || chatImageQuestionRevision(message) !== ref.revision) return false;
    }
    for (const ref of image.images) {
      const message = await read(ref.messageId);
      const picture = message?.images?.find(value => value.id === ref.imageId);
      if (!message || !picture || chatImageSourceRevision(message, picture) !== ref.revision) return false;
    }
    const question = await read(image.question.messageId);
    if (!question) return false;
    const tool = getToolDefinition(CHAT_IMAGE_TOOL_ID);
    const permission = tool && listToolPackages().some(pack => pack.id === 'image' && pack.defaultEnabled)
      ? await resolveToolPermissionForCall(tool, { requestedBy: 'chat', input: { image: imageNumber, question: question.content } }) : null;
    if ((!permission || permission.permission === 'deny') && !initiallyUnavailable) return false;
    const signature = JSON.stringify(permission ? [permission.permission, permission.source, permission.grantId] : ['disabled']);
    if (accessAtUse !== undefined && signature !== accessAtUse) return false;
  }
  return true;
}

export async function isPendingChatReplyDraftCurrent(draft: ChatReplyDraft): Promise<boolean> {
  if ((await loadPendingChatReplyDraft(draft.sessionId))?.replyId !== draft.replyId) return false;
  const saved = await readDraftMessages(draft, true);
  return isChatReplyDraftSourceCurrent(draft, saved)
    && chatReplyDraftBodyState(draft, saved) !== 'changed'
    && await areChatReplyDraftSourcesCurrent(draft);
}

/** Only delivery receipts. Model-derived notebook/care/tool operations are not replayed. */
export type ChatReplyDraftReceipt = 'sleep' | 'backstage' | 'ordinaryContact' | 'contact' | 'web' | 'body';
export async function completeChatReplyDraft(draft: ChatReplyDraft, dataEpoch: number,
  alreadyDone: ReadonlySet<ChatReplyDraftReceipt> = new Set(), retryMissing = true): Promise<boolean> {
  const saved = await readDraftMessages(draft);
  if (chatReplyDraftBodyState(draft, saved) !== 'complete') return false;
  const messages = draft.messages.map(message => saved.find(value => value.id === message.id)!);
  const at = messages.at(-1)!.createdAt;
  const backstage = messages.find(message => message.theaterBackstagePending)?.theaterBackstage;
  const needsBodyReceipt = !!draft.sources.bodyCare
    && !!(draft.sources.bodyCare.eventIds.length || draft.sources.bodyCare.periodIds?.length);
  const required: ChatReplyDraftReceipt[] = ['ordinaryContact'];
  if (draft.sleepingSourceIds.length) required.push('sleep');
  if (backstage) required.push('backstage');
  if (draft.sources.contact) required.push('contact');
  if (draft.sources.web) required.push('web');
  if (needsBodyReceipt) required.push('body');
  // The normal turn has already spent its receipt retries. Keep unfinished work
  // for a later local recovery instead of doubling that turn's retry count.
  if (!retryMissing && required.some(receipt => !alreadyDone.has(receipt))) return false;
  let receiptsComplete = true;
  const committed = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
    if (draft.sleepingSourceIds.length && !alreadyDone.has('sleep')) await completeSleepingMessages(draft.sessionId, draft.sleepingSourceIds);
    if (backstage && !alreadyDone.has('backstage')) await recordTheaterBackstageReplySource(draft.sessionId, messages.map(message => message.id), backstage);
    if (!alreadyDone.has('ordinaryContact')) await noteOrdinaryContactReply(at);
    if (draft.sources.contact) {
      if (!alreadyDone.has('contact')) await commitUnifiedContactChatHandoff(draft.sources.contact, at, messages, draft.sessionId);
      const state = await readUnifiedContactState();
      // A share can be delivered before its opportunity receipt fails. The existing
      // next preparation settles that stale source; saved prose must not block it.
      if (state.current && state.current.id === draft.sources.contact.opportunityId && state.current.status !== 'finished') receiptsComplete = false;
      if (draft.sources.contact.failureId && state.failure?.opportunityId === draft.sources.contact.failureId
        && state.failureAcknowledgedId !== draft.sources.contact.failureId) receiptsComplete = false;
    }
    if (draft.sources.web && !alreadyDone.has('web')) await commitWebVoyageChatHandoff({ handoff: draft.sources.web, messages,
      sessionId: draft.sessionId, deliveredAt: at, canCommit: () => canCommitBackupRestoreDataEpoch(dataEpoch) });
    if (draft.sources.bodyCare && needsBodyReceipt && !alreadyDone.has('body')) {
      await commitBodySignalCareDoorbell(draft.sources.bodyCare, at);
    }
  });
  if (!committed.committed || !canCommitBackupRestoreDataEpoch(dataEpoch) || !receiptsComplete) return false;
  await discardPendingChatReplyDraft(draft.sessionId, draft.replyId);
  return true;
}

type RecoveryPorts = {
  dataEpoch: number;
  current(): boolean;
  interruptedForLifecycle?(): boolean;
  deliver(draft: ChatReplyDraft, current: () => Promise<boolean>): Promise<SubjectiveMessage[]>;
  removeTentative(ids: readonly string[]): void;
  receiptPending?(): void;
};

/** The only recovery path: same IDs/body, existing bubble cadence, zero model/tool calls. */
export async function recoverChatReplyDraft(draft: ChatReplyDraft, ports: RecoveryPorts): Promise<'saved' | 'stale' | 'pending'> {
  let bodySaved = false;
  let release: (() => void) | undefined;
  let originallySaved = new Set<string>();
  const current = () => ports.current() && canCommitBackupRestoreDataEpoch(ports.dataEpoch);
  const sourceCurrent = async () => current() && await isPendingChatReplyDraftCurrent(draft) && current();
  const interrupted = async (): Promise<'pending' | 'stale'> => {
    if (ports.interruptedForLifecycle?.() && canCommitBackupRestoreDataEpoch(ports.dataEpoch)) {
      try { if (await isPendingChatReplyDraftCurrent(draft) && canCommitBackupRestoreDataEpoch(ports.dataEpoch)) return 'pending'; }
      catch { if (canCommitBackupRestoreDataEpoch(ports.dataEpoch)) return 'pending'; } // Recheck a closing host on activation.
    }
    await discardPendingChatReplyDraft(draft.sessionId, draft.replyId);
    return 'stale';
  };
  try {
    const saved = await readDraftMessages(draft);
    originallySaved = new Set(saved.map(message => message.id));
    const state = chatReplyDraftBodyState(draft, saved);
    if (state === 'changed') {
      await discardPendingChatReplyDraft(draft.sessionId, draft.replyId);
      return 'stale';
    }
    bodySaved = state === 'complete';
    if (!bodySaved) {
      if (!await sourceCurrent()) {
        return await interrupted();
      }
      release = holdChatReplyMessageIds(draft.sessionId, draft.messages.map(message => message.id));
      const displayed = await ports.deliver(draft, sourceCurrent);
      if (!current() || displayed.length !== draft.messages.length || !await sourceCurrent()) {
        return await interrupted();
      }
      for (let attempt = 0; attempt < 4; attempt += 1) {
        if (!await sourceCurrent()) {
          return await interrupted();
        }
        try {
          const result = await appendPendingChatReplyDraft(draft, { dataEpoch: ports.dataEpoch, canCommit: current,
            sourcesCurrent: messages => areChatReplyDraftSourcesCurrent(draft, messages) });
          if (result && chatReplyDraftBodyState(draft, result) === 'complete') { bodySaved = true; break; }
          return await interrupted();
        } catch (error) {
          if (attempt === 3) throw error;
        }
      }
    }
    // The delivery path already updated the UI. An already durable body belongs
    // to history loading; replaying this cached copy could undo a concurrent edit/delete.
    if (!current() || (await loadPendingChatReplyDraft(draft.sessionId))?.replyId !== draft.replyId) return await interrupted();
    try {
      if (!await completeChatReplyDraft(draft, ports.dataEpoch)) ports.receiptPending?.();
    } catch { ports.receiptPending?.(); }
    return 'saved';
  } finally {
    if (!bodySaved) ports.removeTentative(draft.messages.map(message => message.id).filter(id => !originallySaved.has(id)));
    release?.();
  }
}
