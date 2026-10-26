import { useMemo, useRef, useState } from 'react';
import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { createChatReminder, updateChatReminder, cancelChatReminder, loadAllChatReminders } from '../schedule/chatReminderStore';
import { canUseChatReminderMusic, resolveReminderSong } from '../schedule/chatReminderSong';
import { registerBuiltinTools } from '../tools/builtin/registerBuiltinTools';
import { getToolDefinition, listToolPackages } from '../tools/toolRegistry';
import { loadToolPermissionSettings } from '../tools/toolPermissionStore';
import { resolveToolPermissionForCall } from '../tools/toolPermissions';
import { claimChatReminderPlanFeedback, commitChatReminderPlanMutation, isStoredReminderPlanSourceCurrent,
  loadChatReminderPlanCard, patchChatReminderPlanCard } from './chatStorage';
import type { ChatReminderPlanCard, ReminderDraft, ReminderPlanRow } from './chatReminderPlan';
import { createChatReminderPlanController, type ReminderPlanMutationResult } from './useChatReminderPlanController';
import type { RunChatReplyOptions } from './chatReplyRuntime';
import { reminderPlanSaveReceipts } from './chatReminderMaterials';

const proposalId = { create: 'reminder.propose_reminders', update: 'reminder.propose_updates', cancel: 'reminder.propose_cancellations' };
export function useChatReminderPlanBridge(input: {
  getMessages: () => SubjectiveMessage[]; commitMessages: (messages: SubjectiveMessage[]) => void;
  isSending: () => boolean; requestReply: (options: RunChatReplyOptions) => Promise<boolean>;
  onError: (message: string) => void;
}) {
  const options = useRef(input); options.current = input;
  const epoch = useRef<number | null>(null);
  const [busy, setBusy] = useState(false);
  const controller = useMemo(() => {
    const refresh = (messageId: string, card: ChatReminderPlanCard | null) => {
      if (card) options.current.commitMessages(options.current.getMessages().map(message =>
        message.id === messageId ? { ...message, reminderPlanCard: card } : message));
      return card;
    };
    const canSave = async (row?: ReminderPlanRow) => {
      registerBuiltinTools();
      if (!canCommitBackupRestoreDataEpoch(epoch.current)
        || !listToolPackages().find(pack => pack.id === 'reminder')?.defaultEnabled) return false;
      try {
        await loadToolPermissionSettings({ strict: true });
        const ids = row ? [proposalId[row.action]] : ['reminder.propose_reminders'];
        for (const id of ids) {
          const tool = getToolDefinition(id);
          if (!tool || (await resolveToolPermissionForCall(tool, { requestedBy: 'chat', input: { reminders: [row?.draft ?? row?.expected ?? {}] } })).permission === 'deny') return false;
        }
        if (row?.draft?.mode === 'music' && !await canUseChatReminderMusic()) return false;
        return canCommitBackupRestoreDataEpoch(epoch.current);
      } catch { return false; }
    };
    return createChatReminderPlanController({
      readCard: loadChatReminderPlanCard,
      patchCard: async (id, revision, card) => refresh(id, await patchChatReminderPlanCard(id, revision, card)),
      claimFeedback: async id => refresh(id, await claimChatReminderPlanFeedback(id)),
      isSourceCurrent: isStoredReminderPlanSourceCurrent, canSave,
      resolveSong: async (row, current) => {
        if (!row.draft?.songRequest) throw new Error('MUSIC_UNRESOLVED');
        return resolveReminderSong(row.draft.songRequest, row.operationId, current);
      },
      applyMutation: async (row, guard, reconcileOnly): Promise<ReminderPlanMutationResult> => {
        if (!await canSave(row)) return { state: 'failed', code: 'PERMISSION_DENIED' };
        try {
          // Save confirms this exact card, without changing a global grant.
          return await commitChatReminderPlanMutation(guard.messageId, guard.revision, guard.source, epoch.current, async () => {
            const records = await loadAllChatReminders();
            const target = records.find(record => record.id === row.id);
            if (reconcileOnly) {
              const series = records.find(record => record.chatReminder.kind === 'series'
                && (record.id === row.id || target?.chatReminder.kind === 'occurrence' && record.id === target.chatReminder.seriesId)
                && record.chatReminder.lastOperationId === row.operationId);
              const actual = row.scope === 'future' && row.action === 'update' && series?.chatReminder.kind === 'series'
                ? records.find(record => record.chatReminder.kind === 'occurrence' && record.chatReminder.seriesId === series.id
                  && record.chatReminder.lastOperationId === row.operationId && record.chatReminder.scheduledAt === row.draft?.triggerAt) ?? series
                : row.action === 'create' || row.scope === 'future' && row.action === 'cancel' ? series : target;
              return actual && (target?.chatReminder.lastOperationId === row.operationId || series)
                ? { state: 'saved', result: actual } : { state: 'unknown', code: 'RESULT_NOT_CONFIRMED' };
            }
            if (row.action !== 'create' && (!row.expected?.chatReminder || !target)) return { state: 'conflict', code: 'REMINDER_READ_ONLY_OR_MISSING' };
            const saved = row.action === 'create'
              ? await createChatReminder({ ...row.draft!, id: row.id, operationId: row.operationId, sourceMessageId: guard.source.messageId })
              : row.action === 'cancel'
                ? await cancelChatReminder({ targetId: row.id, scope: row.scope, expectedRevision: row.expected!.chatReminder!.revision, operationId: row.operationId })
                : await updateChatReminder({ targetId: row.id, scope: row.scope, expectedRevision: row.expected!.chatReminder!.revision,
                  operationId: row.operationId, patch: row.scope === 'future' ? row.draft! : (() => { const { repeat: _repeat, ...patch } = row.draft!; return patch; })() });
            const actual = row.scope === 'future' && row.action === 'update' ? saved.occurrence ?? saved.series
              : row.action === 'create' || row.scope === 'future' && row.action === 'cancel' ? saved.series
                : (await loadAllChatReminders()).find(record => record.id === row.id) ?? saved.series;
            return { state: 'saved', result: actual };
          });
        } catch (error) {
          const code = error instanceof Error ? error.message : 'EXECUTION_INTERRUPTED';
          return { state: /stale-version|not-editable|not-found|id-conflict|READ_ONLY/.test(code) ? 'conflict' : 'unknown', code };
        }
      },
      onFeedback: async (messageId, results, source) => {
        const card = await loadChatReminderPlanCard(messageId);
        if (!card?.feedback.claimed || card.status !== 'active') throw new Error('REMINDER_FEEDBACK_UNCLAIMED');
        const current = async () => canCommitBackupRestoreDataEpoch(epoch.current) && await canSave()
          && await isStoredReminderPlanSourceCurrent(source) && (await loadChatReminderPlanCard(messageId))?.revision === card.revision;
        const replied = await options.current.requestReply({ sourceSessionId: source.sessionId, dataEpoch: epoch.current ?? undefined,
          preserveInteractionReplyDuringConcurrentInput: true, toolResults: reminderPlanSaveReceipts(messageId, results, card),
          reminderReceipt: { sourceMessageId: source.messageId, remainingRequests: 1, isCurrent: current } });
        if (!replied) throw new Error('REMINDER_FEEDBACK_NOT_DELIVERED');
      },
    });
  }, []);
  const edit = async (messageId: string, id: string, patch: Partial<ReminderDraft> | null) => {
    try { await controller.edit(messageId, id, patch); } catch { options.current.onError('提醒草稿修改未保存。'); }
  };
  const save = async (messageId: string) => {
    if (busy || options.current.isSending()) return;
    epoch.current = captureBackupRestoreDataEpoch(); setBusy(true);
    try {
      const result = await controller.save(messageId);
      if (result.blocked) options.current.onError(`提醒草稿未保存：${result.blocked}`);
      else if (result.feedback === 'failed') options.current.onError('提醒结果已保留，聊天反馈未送达。');
    } catch { options.current.onError('提醒保存结果需要核对。'); }
    finally { setBusy(false); }
  };
  return { busy, edit, save };
}
