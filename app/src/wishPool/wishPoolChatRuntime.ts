import { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import { PRIMARY_CHAT_SESSION_ID } from '../chat/primaryChat';
import { loadChatSessionMessage } from '../chat/chatStorage';
import { applyWishDiscussionResult, confirmWishDiscussion, drawOppositeWish, loadCurrentWishDiscussion, loadWishPoolSnapshot, markWishConfirmationsDelivered, prepareWishDiscussion, reviseWishDiscussion, saveWishCandidate, type WishItem } from './wishPoolStore';
import type { WishDiscussion, WishDiscussionPurpose, WishSavedReply } from './wishPoolDiscussionState';
import { buildWishChatMaterials } from './wishPoolChatContract';
import { inspectBaiyunFixedChatEnvelope } from '../ai/behavior/actionChatFixedEnvelope';

const listeners = new Set<() => void>();
const activeTurns = new Set<object>();
let pageWrite = false;
function changed() { for (const listener of listeners) { try { listener(); } catch { /* Display observers cannot undo storage. */ } } }
export function subscribeWishChatChanges(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function isWishChatBusy() { return activeTurns.size > 0 || pageWrite; }
// Held for every normal chat request, including requests without a wish. A page
// cannot change the selected discussion underneath a prepared ordinary request.
export function holdWishChatTurn() {
  if (pageWrite) throw new Error('wish_page_write_in_progress');
  const token = {}; activeTurns.add(token); changed();
  return () => { activeTurns.delete(token); changed(); };
}
async function pageMutation<T>(operation: () => Promise<T>): Promise<T> {
  if (isWishChatBusy()) throw new Error('wish_chat_busy');
  const epoch = captureBackupRestoreDataEpoch();
  if (epoch === null) throw new Error('wish_restore_busy');
  pageWrite = true; changed();
  try {
    const commit = await runBackupRestoreDataEpochCommit(epoch, operation);
    if (!commit.committed) throw new Error('wish_restore_changed');
    return commit.value;
  } finally { pageWrite = false; changed(); }
}
export function beginWishFromPool(input: { wishId?: string; content?: string; purpose: WishDiscussionPurpose; sourceId: string }) {
  return pageMutation(() => prepareWishFromPool(input));
}
async function prepareWishFromPool(input: { wishId?: string; content?: string; purpose: WishDiscussionPurpose; sourceId: string }) {
    const current = await loadCurrentWishDiscussion();
    if (current) {
      if (current.conversationId === PRIMARY_CHAT_SESSION_ID && current.wishId === input.wishId && current.purpose === input.purpose) return current;
      // Same draft's retry after a successful save resumes, never creates a copy.
      if (current.sourceId === input.sourceId && current.conversationId === PRIMARY_CHAT_SESSION_ID
        && (!input.wishId || current.wishId === input.wishId)) return current;
      throw new Error('wish_discussion_busy');
    }
    const wishId = input.wishId ?? (await saveWishCandidate({ owner: 'you', content: input.content ?? '', origin: 'manual', actionId: input.sourceId })).id;
    return prepareWishDiscussion({ wishId, purpose: input.purpose, sourceId: input.sourceId, conversationId: PRIMARY_CHAT_SESSION_ID });
}
export function openWishInvitation(sessionId: string, messageId: string, callId: string) {
  return pageMutation(async () => {
    if (sessionId !== PRIMARY_CHAT_SESSION_ID) throw new Error('wish_conversation_missing');
    const message = await loadChatSessionMessage(sessionId, messageId);
    const card = message?.role === 'I' ? message.toolCallCards?.find(item => item.callId === callId) : undefined;
    const wishId = card?.inputPreview.wishId;
    const purpose = card?.inputPreview.purpose;
    if (card?.toolId !== 'wish.invite_discussion' || card.status !== 'success' || typeof wishId !== 'string'
      || !['cast_coin', 'revise', 'progress', 'complete', 'release'].includes(String(purpose))) throw new Error('wish_invitation_missing');
    return prepareWishFromPool({ wishId, purpose: purpose as WishDiscussionPurpose, sourceId: `wish-invite:${callId}` });
  });
}
export function continueWishChat(discussion: WishDiscussion) {
  return pageMutation(() => reviseWishDiscussion({ discussionId: discussion.id, expectedRevision: discussion.revision }));
}
export function editWishFromChat(discussion: WishDiscussion) {
  return pageMutation(async () => {
    if (discussion.conversationId !== PRIMARY_CHAT_SESSION_ID || discussion.purpose === 'cast_coin') throw new Error('wish_edit_unavailable');
    const snapshot = await loadWishPoolSnapshot();
    const wish = snapshot.wishes.find(item => item.id === discussion.wishId);
    if (!wish) throw new Error('wish_not_found');
    return reviseWishDiscussion({ discussionId: discussion.id, expectedRevision: discussion.revision,
      purpose: 'revise', pendingText: wish.content });
  });
}
export function confirmWishFromChat(discussion: WishDiscussion) {
  return pageMutation(async () => {
    if (discussion.conversationId !== PRIMARY_CHAT_SESSION_ID || !discussion.reply) throw new Error('wish_reply_missing');
    const reply = await loadChatSessionMessage(discussion.conversationId, discussion.reply.messageId);
    if (reply?.role !== 'I' || !reply.content.trim()) throw new Error('wish_reply_missing');
    return confirmWishDiscussion({ discussionId: discussion.id, expectedRevision: discussion.revision, sourceId: `wish-click:${discussion.id}:${discussion.revision}` });
  });
}
export function drawWishFromPool(wishId?: string): Promise<WishItem | null> {
  return pageMutation(() => drawOppositeWish('you', Date.now(), wishId));
}

export async function prepareWishChatTurn(sessionId: string, interaction = false, readOnly = false) {
  const epoch = captureBackupRestoreDataEpoch();
  if (epoch === null) throw new Error('wish_restore_busy');
  const snapshot = await loadWishPoolSnapshot();
  if (!canCommitBackupRestoreDataEpoch(epoch)) throw new Error('wish_restore_changed');
  const previous = snapshot.collaboration?.discussions.find(item => item.closedAt === undefined);
  if (previous && previous.conversationId !== sessionId) throw new Error('wish_conversation_missing');
  const wish = previous ? snapshot.wishes.find(item => item.id === previous.wishId) : undefined;
  if (previous && !wish) throw new Error('wish_not_found');
  const confirmations = interaction ? [] : (snapshot.collaboration?.confirmations ?? []).filter(item => !item.deliveredWithReply);
  let discussion = previous;
  if (previous && !interaction && !readOnly) {
    const commit = await runBackupRestoreDataEpochCommit(epoch, () => reviseWishDiscussion({ discussionId: previous.id, expectedRevision: previous.revision }));
    if (!commit.committed) throw new Error('wish_restore_changed');
    discussion = commit.value; changed();
  }
  // D1 uses the last saved reply, before revision invalidates its agreement.
  const material = buildWishChatMaterials({ confirmations,
    current: wish && previous ? { wish, discussion: previous, progressNotes: snapshot.collaboration?.progressNotes } : null });
  return { discussion, interaction, epoch, sessionId, material, confirmationIds: confirmations.map(item => item.id) };
}
export type WishChatTurn = Awaited<ReturnType<typeof prepareWishChatTurn>>;

// Called only after the normal visible reply persistence barrier. A malformed
// wish field stays unconfirmed; it never retracts the successfully saved prose.
export async function commitWishChatReply(turn: WishChatTurn, raw: string | undefined, savedReply: WishSavedReply, canCommit: () => boolean) {
  if (!canCommit() || !canCommitBackupRestoreDataEpoch(turn.epoch)) return;
  const reply = await loadChatSessionMessage(turn.sessionId, savedReply.messageId);
  if (reply?.role !== 'I' || !reply.content.trim() || !canCommit()) return;
  const commit = await runBackupRestoreDataEpochCommit(turn.epoch, async () => {
    if (!canCommit()) return;
    // These were actually carried in this request; unrelated later facts remain queued.
    if (turn.confirmationIds.length) await markWishConfirmationsDelivered(turn.confirmationIds, savedReply);
    if (!turn.discussion || turn.interaction || !canCommit()) return;
    const envelope = inspectBaiyunFixedChatEnvelope(raw ?? '', 'wish');
    if (!envelope.candidate || envelope.rootStatus !== 'valid' || !envelope.messagesFirst
      || envelope.unexpectedRootKeys.length || envelope.fields.messages.status !== 'valid'
      || envelope.fields.wishDiscussion?.status !== 'valid') return;
    const value = envelope.fields.wishDiscussion.value;
    await applyWishDiscussionResult({ discussionId: turn.discussion.id, expectedRevision: turn.discussion.revision,
      pendingText: value.pendingText, decision: value.decision, savedReply });
  });
  if (commit.committed) changed();
}
