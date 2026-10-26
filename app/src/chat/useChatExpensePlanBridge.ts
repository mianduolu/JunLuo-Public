import { useMemo, useRef, useState } from 'react';
import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { applyExpenseMutation, type ExpenseDraft } from '../expense/expenseStore';
import { registerBuiltinTools } from '../tools/builtin/registerBuiltinTools';
import { getToolDefinition, listToolPackages } from '../tools/toolRegistry';
import { loadToolPermissionSettings } from '../tools/toolPermissionStore';
import { resolveToolPermissionForCall } from '../tools/toolPermissions';
import { claimChatExpensePlanFeedback, commitChatExpensePlanMutation, isStoredExpensePlanSourceCurrent, loadChatExpensePlanCard, patchChatExpensePlanCard } from './chatStorage';
import type { ChatExpensePlanCard, ExpensePlanAction } from './chatExpensePlan';
import { createChatExpensePlanController } from './useChatExpensePlanController';
import type { RunChatReplyOptions } from './chatReplyRuntime';
import { expensePlanSaveReceipts } from './chatExpenseMaterials';

const proposalId: Record<ExpensePlanAction, string> = {
  create: 'expense.propose_entries', update: 'expense.propose_updates',
  delete: 'expense.propose_deletions', refund: 'expense.propose_refunds',
};
export function useChatExpensePlanBridge(input: {
  getMessages: () => SubjectiveMessage[]; commitMessages: (messages: SubjectiveMessage[]) => void;
  isSending: () => boolean; requestReply: (options: RunChatReplyOptions) => Promise<boolean>;
  onError: (message: string) => void;
}) {
  const options = useRef(input); options.current = input;
  const epoch = useRef<number | null>(null);
  const [busy, setBusy] = useState(false);
  const controller = useMemo(() => {
    const refresh = (messageId: string, card: ChatExpensePlanCard | null) => {
      if (card) options.current.commitMessages(options.current.getMessages().map(message =>
        message.id === messageId ? { ...message, expensePlanCard: card } : message));
      return card;
    };
    return createChatExpensePlanController({
      readCard: loadChatExpensePlanCard,
      patchCard: async (id, revision, card) => refresh(id, await patchChatExpensePlanCard(id, revision, card)),
      claimFeedback: async id => refresh(id, await claimChatExpensePlanFeedback(id)),
      isSourceCurrent: isStoredExpensePlanSourceCurrent,
      canSave: async () => {
        registerBuiltinTools();
        if (!canCommitBackupRestoreDataEpoch(epoch.current)
          || !listToolPackages().find(pack => pack.id === 'expense')?.defaultEnabled) return false;
        try { await loadToolPermissionSettings({ strict: true }); return true; } catch { return false; }
      },
      applyMutation: async (row, guard) => {
        const tool = getToolDefinition(proposalId[row.action]);
        if (!tool || (await resolveToolPermissionForCall(tool, { input: { entries: [row.draft ?? row.expected ?? {}] }, requestedBy: 'chat' })).permission === 'deny') {
          return { status: 'failed', code: 'PERMISSION_DENIED' };
        }
        // Save confirms only this card's exact rows; no global grant is changed.
        return commitChatExpensePlanMutation(guard.messageId, guard.revision, guard.source, epoch.current,
          () => applyExpenseMutation(row));
      },
      onFeedback: async (messageId, results, source) => {
        const claimed = await loadChatExpensePlanCard(messageId);
        if (!claimed?.feedback.claimed || claimed.status !== 'active') throw new Error('expense-feedback-unclaimed');
        const current = async () => canCommitBackupRestoreDataEpoch(epoch.current)
          && await isStoredExpensePlanSourceCurrent(source)
          && (await loadChatExpensePlanCard(messageId))?.revision === claimed.revision;
        const receipts = expensePlanSaveReceipts(messageId, results, claimed);
        const replied = await options.current.requestReply({ sourceSessionId: source.sessionId, dataEpoch: epoch.current ?? undefined,
          preserveInteractionReplyDuringConcurrentInput: true, toolResults: receipts,
          expenseReceipt: { sourceMessageId: source.messageId, remainingRequests: 1, isCurrent: current } });
        if (!replied) throw new Error('expense-feedback-not-delivered');
      },
    });
  }, []);
  const edit = async (messageId: string, id: string, patch: Partial<ExpenseDraft> | null) => {
    try { await controller.edit(messageId, id, patch); } catch { input.onError('账单草稿修改未保存。'); }
  };
  const save = async (messageId: string) => {
    if (busy || input.isSending()) return;
    epoch.current = captureBackupRestoreDataEpoch(); setBusy(true);
    try {
      const result = await controller.save(messageId);
      if (result.blocked) input.onError(`账单草稿未保存：${result.blocked}`);
      else if (result.feedback === 'failed') input.onError('账单结果已保留，聊天反馈未送达。');
    } catch { input.onError('账单保存结果需要核对。'); }
    finally { setBusy(false); }
  };
  return { busy, edit, save };
}

