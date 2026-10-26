import { createSubjectiveMessage, type SubjectiveMessage } from '../ai/subjectiveMessages';
import { getToolDefinition } from '../tools/toolRegistry';
import type { JunLuoToolAgentFrozenProposal } from '../tools/toolAgentFrozenProposal';
import type { JunLuoToolPermissionResolution } from '../tools/toolPermissions';
import type { JunLuoToolResult } from '../tools/toolTypes';
import type { JunLuoToolCallCard } from './toolCallMessageTypes';
import { isTextFileChatTool } from '../tools/textFileChatTools';
import { chatTextFileReferenceFromResult } from './chatTextFileReference';

export type ChatToolAgentCardTarget = {
  sourceSessionId: string;
  sourceMessageId: string;
  auditId: string;
  dataEpoch: number;
};

export function createToolAgentPermissionCard(input: {
  auditId: string;
  providerCallId: string;
  toolId: string;
  createdAt?: number;
}): JunLuoToolCallCard {
  const tool = getToolDefinition(input.toolId);
  return {
    callId: input.auditId,
    auditId: input.auditId,
    providerCallId: input.providerCallId,
    toolId: input.toolId,
    packageId: tool?.packageId ?? '',
    toolName: tool?.name ?? input.toolId,
    status: 'awaiting_permission',
    inputPreview: {},
    permissionDecision: 'not_checked',
    createdAt: input.createdAt ?? Date.now(),
  };
}

export function createToolAgentConfirmationCard(input: {
  proposal: JunLuoToolAgentFrozenProposal;
  permission: JunLuoToolPermissionResolution;
}): JunLuoToolCallCard {
  const { proposal, permission } = input;
  const tool = getToolDefinition(proposal.toolId);
  return {
    callId: proposal.auditId,
    auditId: proposal.auditId,
    providerCallId: proposal.providerCallId,
    toolId: proposal.toolId,
    packageId: tool?.packageId ?? '',
    toolName: tool?.name ?? proposal.toolId,
    status: 'awaiting_confirmation',
    inputPreview: {},
    permissionDecision: permission.permission === 'allow' ? 'allowed' : 'not_checked',
    permissionSource: permission.source,
    permissionGrantId: permission.grantId,
    permissionExpiresAt: permission.expiresAt,
    permissionSilent: permission.silent,
    proposalId: proposal.proposalId,
    confirmationExpiresAt: proposal.expiresAt,
    confirmationPresentation: proposal.presentation,
    confirmationDecision: 'pending',
    createdAt: proposal.createdAt,
  };
}

export function createToolAgentResultCard(input: {
  auditId: string;
  providerCallId: string;
  result: JunLuoToolResult;
  createdAt?: number;
}): JunLuoToolCallCard {
  const tool = getToolDefinition(input.result.toolId);
  const status = input.result.error?.code === 'TOOL_OUTCOME_UNKNOWN'
    ? 'outcome_unknown'
    : input.result.status === 'success'
      ? 'success'
      : input.result.status === 'permission_denied'
        ? 'permission_denied'
        : input.result.status === 'cancelled'
          ? 'cancelled'
          : 'error';
  return {
    callId: input.auditId,
    auditId: input.auditId,
    providerCallId: input.providerCallId,
    toolId: input.result.toolId,
    packageId: tool?.packageId ?? '',
    toolName: tool?.name ?? input.result.toolId,
    status,
    inputPreview: {},
    permissionDecision: status === 'permission_denied' ? 'denied' : 'allowed',
    resultSummary: input.result.summary,
    fileReference: chatTextFileReferenceFromResult(input.result),
    errorMessage: input.result.error?.message,
    createdAt: input.createdAt ?? input.result.startedAt,
    startedAt: input.result.startedAt,
    finishedAt: input.result.finishedAt,
  };
}

export function upsertToolAgentCardMessage(
  messages: readonly SubjectiveMessage[],
  card: JunLuoToolCallCard,
): SubjectiveMessage[] {
  const identity = card.auditId ?? card.callId;
  const messageIndex = messages.findIndex((message) => message.toolCallCards?.some((item) => (
    (item.auditId ?? item.callId) === identity
  )));
  if (messageIndex >= 0) {
    return messages.map((message, index) => {
      if (index !== messageIndex || !message.toolCallCards) return message;
      return {
        ...message,
        toolCallCards: message.toolCallCards.map((item) => (
          (item.auditId ?? item.callId) === identity ? { ...item, ...card,
            ...(card.toolId === 'wish.invite_discussion'
              ? { inputPreview: { ...item.inputPreview, ...card.inputPreview } } : {}),
          } : item
        )),
      };
    });
  }
  return [
    ...messages,
    { ...createSubjectiveMessage('I', '', {
      source: 'tool-call',
      toolCallCards: [card],
    }), ...(isTextFileChatTool(card.toolId) ? { id: `file-card-${identity}` }
      : card.toolId === 'image.describe_local' ? { id: `image-card-${identity}` } : {}) },
  ];
}

export function claimToolAgentCardForDomain(
  messages: readonly SubjectiveMessage[],
  auditId: string,
) {
  return messages.flatMap((message) => {
    if (!message.toolCallCards?.some((card) => (card.auditId ?? card.callId) === auditId)) {
      return [message];
    }
    const remaining = message.toolCallCards.filter((card) => (
      (card.auditId ?? card.callId) !== auditId
    ));
    if (remaining.length) return [{ ...message, toolCallCards: remaining }];
    return message.content || message.musicCard || message.schedulePlanCard ? [{ ...message, toolCallCards: undefined }] : [];
  });
}
