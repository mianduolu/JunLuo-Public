import { inspectBaiyunFixedChatEnvelope } from '../ai/behavior/actionChatFixedEnvelope';
import {
  buildChatCareGuidance, buildChatCareContext, numberCareMessages,
  parseChatCareUpdates, selectChatCareItems, type CareSourceMessage, type ChatCareItem,
} from '../ai/behavior/chatCareUpdates';
import {
  applyBaiyunCareMatterUpdates, listChatCareMatters, listBaiyunContinuityLinks,
} from '../ai/behavior/continuityLedger';
import {
  BAIYUN_CHAT_FIXED_SHARE_RESPONSE_GUIDANCE_PROTOCOL, parseBaiyunFixedShareResponses,
} from '../ai/behavior/actionShareResponse';
import {
  commitBaiyunFixedShareResponseLedger, loadBaiyunPendingSharePromptContext,
} from '../ai/behavior/actionShareResponseStore';
import { commitPreparedNotebookAction, prepareNotebookAction } from '../chat/notebookActionPlanner';
import { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { recordChatCareRejection, runChatAuxiliaryOperation } from '../chat/chatAuxiliaryDiagnostics';
import type { FocusLogEntry } from './focusStore';
import { isFocusSleepReplyReceipt } from './focusSleepReplyPolicy';
import { isFocusOrganizationLog } from './focusSummaryRecord';
import { prepareUnifiedContactChatHandoff, commitUnifiedContactChatHandoff,
  type ContactChatHandoff } from '../proactive/unifiedContactHandoff';

type RuntimeFocusLog = Omit<FocusLogEntry, 'sessionId'>;

export type PreparedJunluoFocusChatTurn = {
  currentMessage: CareSourceMessage;
  currentMessages?: CareSourceMessage[];
  careItems: ChatCareItem[];
  messages: CareSourceMessage[];
  fixedShareItems: Awaited<ReturnType<typeof loadBaiyunPendingSharePromptContext>>['fixedItems'];
  responseInstruction: string;
  sessionId: string;
  dataEpoch: ReturnType<typeof captureBackupRestoreDataEpoch>;
  unifiedContactHandoff?: ContactChatHandoff | null;
  careCommitted?: boolean;
  careAvailable?: boolean;
};

export async function prepareJunluoFocusChatTurn(input: {
  logs: readonly RuntimeFocusLog[];
  sessionId: string;
  youMessage: RuntimeFocusLog;
  youMessages?: readonly RuntimeFocusLog[];
}): Promise<PreparedJunluoFocusChatTurn> {
  const dataEpoch = captureBackupRestoreDataEpoch();
  const handoffRead = await runChatAuxiliaryOperation({ phase: 'prepare', stage: 'continuity_ledger' }, prepareUnifiedContactChatHandoff);
  const unifiedContactHandoff = handoffRead.ok ? handoffRead.value : null;
  const messages: CareSourceMessage[] = input.logs.flatMap((log) => (
    !isFocusSleepReplyReceipt(log) && !isFocusOrganizationLog(log) && (log.role === 'I' || log.role === 'you')
      ? [{ id: log.id, role: log.role, sentAt: log.createdAt, text: log.content }] : []
  ));
  const [careRead, pendingShares] = await Promise.all([
    runChatAuxiliaryOperation({ phase: 'prepare', stage: 'continuity_ledger' }, listChatCareMatters),
    loadBaiyunPendingSharePromptContext(input.sessionId),
  ]);
  const events = careRead.ok ? careRead.value : [];
  const links = (await Promise.all(events.map((event) => listBaiyunContinuityLinks(event.id)))).flat();
  const careItems = selectChatCareItems({ events, links, messages, now: Date.now() });
  const currentMessages = input.youMessages?.map(log => {
    const actual = messages.find(message => message.id === log.id);
    if (!actual || actual.role !== 'you' || actual.text !== log.content || actual.sentAt !== log.createdAt) {
      throw new Error('Focus reply source is absent from request history');
    }
    return actual;
  });
  return {
    currentMessage: { id: input.youMessage.id, role: 'you', sentAt: input.youMessage.createdAt, text: input.youMessage.content },
    careItems, messages, dataEpoch, unifiedContactHandoff, careAvailable: careRead.ok, currentMessages,
    fixedShareItems: pendingShares.fixedItems,
    responseInstruction: [
      unifiedContactHandoff?.material ?? '',
      buildChatCareContext(careItems), buildChatCareGuidance(careItems),
      pendingShares.fixedItems.length
        ? `${BAIYUN_CHAT_FIXED_SHARE_RESPONSE_GUIDANCE_PROTOCOL}\n\n${pendingShares.fixedInstruction}` : '',
    ].filter(Boolean).join('\n\n'),
    sessionId: input.sessionId,
  };
}

export function buildFocusCareRequestMessages(logs: readonly RuntimeFocusLog[]) {
  const numbered = numberCareMessages(logs.flatMap((log) => (
    !isFocusSleepReplyReceipt(log) && !isFocusOrganizationLog(log) && (log.role === 'I' || log.role === 'you')
      ? [{ id: log.id, role: log.role, sentAt: log.createdAt, text: log.content }] : []
  )));
  return numbered.map((message) => ({
    id: message.id, role: message.role, content: message.content, createdAt: message.sentAt,
  }));
}

export async function commitJunluoFocusChatTurn(input: {
  assistantLogs: readonly RuntimeFocusLog[];
  prepared: PreparedJunluoFocusChatTurn;
  rawEnvelope: string;
  canCommit?: () => boolean;
}) {
  const current = () => canCommitBackupRestoreDataEpoch(input.prepared.dataEpoch) && input.canCommit?.() !== false;
  const inspected = inspectBaiyunFixedChatEnvelope(input.rawEnvelope);
  if (!current() || inspected.fields.messages.status !== 'valid' || !input.assistantLogs.length) return;
  if (inspected.fields.messages.value.length !== input.assistantLogs.length
    || inspected.fields.messages.value.some((message, index) => message.trim() !== input.assistantLogs[index].content.trim())) return;
  const now = Date.now();
  await runChatAuxiliaryOperation({ phase: 'commit', stage: 'continuity_ledger', retryLocalSave: true }, async () => {
    if (!current()) return;
    const { noteOrdinaryContactReply } = await import('../proactive/unifiedContactStore');
    if (!current()) return;
    await noteOrdinaryContactReply(input.assistantLogs.at(-1)!.createdAt);
    if (input.prepared.unifiedContactHandoff && current()) {
      await commitUnifiedContactChatHandoff(input.prepared.unifiedContactHandoff, Date.now(),
        input.assistantLogs.map(log => ({ id: log.id, role: 'I', content: log.content, createdAt: log.createdAt })), input.prepared.sessionId);
    }
  });
  const careUpdates = parseChatCareUpdates({
    value: input.prepared.careAvailable !== false && inspected.fields.careUpdates.status === 'valid' ? inspected.fields.careUpdates.value : [],
    items: input.prepared.careItems, messages: input.prepared.messages,
    newMessages: input.prepared.currentMessages ?? [input.prepared.currentMessage],
  });
  for (const reason of careUpdates.diagnostic.rejectionCodes) void recordChatCareRejection(reason);
  const pendingCare = input.prepared.careCommitted ? [] : careUpdates.updates;
  input.prepared.careCommitted = true;
  for (const update of pendingCare) {
    if (!current()) return;
    await runChatAuxiliaryOperation({ phase: 'commit', stage: 'continuity_ledger', step: 'care_updates_commit', retryLocalSave: true }, async () => {
      if (!current()) return;
      return applyBaiyunCareMatterUpdates({ updates: [update], sessionId: input.prepared.sessionId, now,
        allowNew: input.prepared.careItems.length < 6, canCommit: current });
    });
  }
  const shares = parseBaiyunFixedShareResponses({
    value: inspected.fields.shareResponses.status === 'valid' ? inspected.fields.shareResponses.value : undefined,
    pendingShares: input.prepared.fixedShareItems,
  }).responses;
  if (!current()) return;
  if (shares.length) await runChatAuxiliaryOperation({ phase: 'commit', stage: 'share_ledger', retryLocalSave: true }, async () => {
    if (!current()) return;
    return commitBaiyunFixedShareResponseLedger({
      now, responseMessageId: input.prepared.currentMessages ? input.assistantLogs.at(-1)!.id : input.prepared.currentMessage.id,
      responses: shares, sessionId: input.prepared.sessionId,
    });
  });
  const reaction = inspected.fields.innerReaction.status === 'valid' ? inspected.fields.innerReaction.value : null;
  if (!current() || !reaction) return;
  const preparation = await prepareNotebookAction({
    assistantContents: input.assistantLogs.map((log) => log.content),
    hiddenRequests: [{ content: reaction }], mode: 'inner_reaction',
    sourceMessageId: input.prepared.currentMessages ? input.assistantLogs.at(-1)!.id : input.prepared.currentMessage.id,
    userText: input.prepared.currentMessages?.map(message => message.text).join('\n\n') ?? input.prepared.currentMessage.text,
  });
  if (current()) await runChatAuxiliaryOperation({ phase: 'commit', stage: 'notebook', retryLocalSave: true }, async () => {
    if (current()) return commitPreparedNotebookAction(preparation);
  });
}
