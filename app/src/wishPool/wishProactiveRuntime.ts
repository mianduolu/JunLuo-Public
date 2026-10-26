import { canCommitBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { createSubjectiveMessage, type SubjectiveMessage } from '../ai/subjectiveMessages';
import { appendMessagesToChatSession, loadChatSessionMessage } from '../chat/chatStorage';
import { emitChatMessagesAppended } from '../chat/chatMessageEvents';
import { PRIMARY_CHAT_SESSION_ID } from '../chat/primaryChat';
import { createToolAgentResultCard } from '../chat/toolAgentCardDelivery';
import { readUnifiedContactState } from '../proactive/unifiedContactStore';
import type { ContactOpportunity } from '../proactive/unifiedContact';
import { createToolSuccessResult } from '../tools/toolResult';
import { createWishToolTurn } from './wishToolTurn';
import { WISH_TOOL_SUMMARIES } from './wishToolContract';

export type WishContactValidity = (op: ContactOpportunity, messages?: readonly SubjectiveMessage[]) => Promise<boolean>;

/** Reuse the real ordinary opportunity and chat card store; no synthetic you message or new queue. */
export function createProactiveWishTurn(input: {
  dataEpoch: number; sourceMessageId: string; sourceSessionId: string; signal?: AbortSignal;
  valid: WishContactValidity;
}) {
  const current = async (messages?: readonly SubjectiveMessage[]) => {
    if (input.signal?.aborted || !canCommitBackupRestoreDataEpoch(input.dataEpoch)
      || input.sourceSessionId !== PRIMARY_CHAT_SESSION_ID) return false;
    const op = (await readUnifiedContactState()).current;
    return !!op && op.id === input.sourceMessageId && op.sessionId === input.sourceSessionId
      && op.epoch === input.dataEpoch && op.status === 'requesting' && !op.important
      && Date.now() < op.expiresAt && await input.valid(op, messages)
      && !input.signal?.aborted && canCommitBackupRestoreDataEpoch(input.dataEpoch);
  };
  return createWishToolTurn({ ...input, sourceKind: 'proactive', isCurrent: current,
    deliverInvitation: async (call, wish) => {
      const id = `wish-invite:${call.callId}`;
      const existing = await loadChatSessionMessage(input.sourceSessionId, id);
      if (!await current()) return false;
      const matches = (message: SubjectiveMessage) => message.id === id && message.role === 'I'
        && message.source === 'tool-call' && message.toolCallCards?.some(card => card.callId === call.callId
          && card.toolId === 'wish.invite_discussion' && card.status === 'success'
          && card.inputPreview.wishId === wish.id && card.inputPreview.purpose === call.input.purpose);
      if (existing) return !!matches(existing);
      const card = createToolAgentResultCard({ auditId: call.callId, providerCallId: call.callId,
        result: createToolSuccessResult(call, WISH_TOOL_SUMMARIES.invited) });
      card.inputPreview = { wishId: wish.id, purpose: String(call.input.purpose), content: wish.content };
      const message = { ...createSubjectiveMessage('I', '', { source: 'tool-call', toolCallCards: [card] }), id };
      const saved = await appendMessagesToChatSession(input.sourceSessionId, [message], {
        requireActiveSession: true, beforeAppend: current,
      });
      const delivered = saved.messages.find(matches);
      if (!delivered) return false;
      emitChatMessagesAppended({ sessionId: input.sourceSessionId, messages: [delivered], source: 'wish-invitation' });
      return true;
    },
  });
}
