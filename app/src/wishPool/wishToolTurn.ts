import { canCommitBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import { loadChatSessionMessage } from '../chat/chatStorage';
import { PRIMARY_CHAT_SESSION_ID } from '../chat/primaryChat';
import { createToolError } from '../tools/toolErrors';
import { createToolErrorResult, createToolSuccessResult } from '../tools/toolResult';
import type { JunLuoToolCall, JunLuoToolResult } from '../tools/toolTypes';
import { isWishDiscussionPurpose } from './wishPoolDiscussionState';
import { drawOppositeWish, loadWishPoolSnapshot, normalizeWishContent, saveWishCandidate, type WishItem } from './wishPoolStore';
import { isWishToolId, WISH_TOOL_SUMMARIES as summaries } from './wishToolContract';

/** The existing chat turn or validated contact opportunity owns identity, never final decisions. */
export function createWishToolTurn(input: {
  dataEpoch: number;
  sourceKind?: 'proactive';
  signal?: AbortSignal;
  sourceMessageId?: string;
  sourceSessionId?: string;
  isCurrent?: () => boolean | Promise<boolean>;
  deliverInvitation: (call: JunLuoToolCall, wish: WishItem) => Promise<boolean>;
}) {
  const results = new Map<string, Promise<JunLuoToolResult>>();
  const valid = async () => {
    if (input.signal?.aborted || !canCommitBackupRestoreDataEpoch(input.dataEpoch)
      || !input.sourceMessageId || input.sourceSessionId !== PRIMARY_CHAT_SESSION_ID) return false;
    if (input.sourceKind === 'proactive') return !!input.isCurrent && await input.isCurrent()
      && !input.signal?.aborted && canCommitBackupRestoreDataEpoch(input.dataEpoch);
    const source = await loadChatSessionMessage(input.sourceSessionId, input.sourceMessageId);
    return source?.id === input.sourceMessageId && source.role === 'you'
      && (!input.isCurrent || await input.isCurrent())
      && !input.signal?.aborted && canCommitBackupRestoreDataEpoch(input.dataEpoch);
  };
  const execute = async (call: JunLuoToolCall): Promise<JunLuoToolResult> => {
    const error = (code: Parameters<typeof createToolError>[0], detail: string, summary = '') =>
      createToolErrorResult(call, createToolError(code, detail), summary);
    let writing = false;
    try {
      if (call.requestedBy !== (input.sourceKind ?? 'chat') || !isWishToolId(call.toolId) || !call.callId.trim()
        || call.sourceMessageId !== input.sourceMessageId || !await valid()) {
        return error('STALE_DATA_EPOCH', 'wish-chat-turn-unavailable');
      }
      const commit = async <T>(work: () => Promise<T>) => {
        const outcome = await runBackupRestoreDataEpochCommit(input.dataEpoch, async () => {
          if (!await valid()) throw new Error('wish-chat-turn-unavailable');
          writing = true;
          return work();
        });
        if (!outcome.committed) throw new Error('wish-chat-turn-unavailable');
        return outcome.value;
      };
      if (call.toolId === 'wish.propose') {
        let content: string;
        try { content = normalizeWishContent(call.input.content); }
        catch { return error('VALIDATION_FAILED', 'invalid-wish-content', summaries.invalidContent); }
        await commit(() => saveWishCandidate({ owner: 'I', content, origin: input.sourceKind ?? 'chat',
          actionId: call.callId, sourceMessageId: input.sourceMessageId }));
        return createToolSuccessResult(call, summaries.proposed);
      }
      if (call.toolId === 'wish.view') {
        if (typeof call.input.query !== 'string' || !call.input.query.trim()) {
          return error('INVALID_ARGUMENTS', 'invalid-wish-query');
        }
        const query = call.input.query.normalize('NFKC').replace(/\s+/g, ' ').trim();
        const snapshot = await loadWishPoolSnapshot();
        if (!await valid()) return error('STALE_DATA_EPOCH', 'wish-chat-turn-unavailable');
        const exact = snapshot.wishes.find(wish => wish.id === query);
        const wishes = (exact ? [exact] : snapshot.wishes.filter(wish =>
          wish.content.toLocaleLowerCase().includes(query.toLocaleLowerCase())).slice(-3)).map(wish => ({
          wishId: wish.id, owner: wish.owner, content: wish.content, state: wish.status,
        }));
        return wishes.length ? createToolSuccessResult(call, `翻到了 ${wishes.length} 颗愿望。`, { wishes })
          : createToolSuccessResult(call, summaries.viewEmpty);
      }
      if (call.toolId === 'wish.pull') {
        if (call.input.wishId !== undefined && (typeof call.input.wishId !== 'string' || !call.input.wishId.trim())) {
          return error('INVALID_ARGUMENTS', 'invalid-wish-id');
        }
        const wish = await commit(() => drawOppositeWish('I', Date.now(), call.input.wishId as string | undefined, call.callId));
        return wish ? createToolSuccessResult(call, summaries.pulled, { wishId: wish.id, content: wish.content })
          : createToolSuccessResult(call, summaries.pullEmpty);
      }
      const snapshot = await loadWishPoolSnapshot();
      const wish = snapshot.wishes.find(item => item.id === call.input.wishId);
      const purpose = call.input.purpose;
      if (!wish || !isWishDiscussionPurpose(purpose)
        || (purpose === 'cast_coin' ? wish.status !== 'candidate' : !['active', 'in-progress', 'deferred'].includes(wish.status))) {
        return error('WISH_DISCUSSION_NOT_AVAILABLE', 'wish-discussion-unavailable', summaries.inviteUnavailable);
      }
      const delivered = await commit(() => input.deliverInvitation(call, wish));
      if (!delivered) return error('TOOL_OUTCOME_UNKNOWN', 'wish-invitation-unconfirmed', summaries.inviteUnknown);
      return createToolSuccessResult(call, summaries.invited);
    } catch {
      if (writing && call.toolId !== 'wish.view') {
        const summary = call.toolId === 'wish.propose' ? summaries.proposeUnknown
          : call.toolId === 'wish.pull' ? summaries.pullUnknown : summaries.inviteUnknown;
        return error('TOOL_OUTCOME_UNKNOWN', 'wish-write-unconfirmed', summary);
      }
      return error(call.toolId === 'wish.view' ? 'READ_FAILED' : 'EXECUTION_FAILED', 'wish-tool-unavailable');
    }
  };
  return (call: JunLuoToolCall): Promise<JunLuoToolResult> => {
    // One host action, including in-flight/unknown results, is never executed twice in this turn.
    const previous = results.get(call.callId);
    if (previous) return previous;
    const result = execute(call);
    results.set(call.callId, result);
    return result;
  };
}
