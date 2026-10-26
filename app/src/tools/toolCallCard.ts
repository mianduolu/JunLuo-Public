import type { JunLuoToolCallCard } from '../chat/toolCallMessageTypes';
import { chatTextFileReferenceFromResult } from '../chat/chatTextFileReference';
import { buildToolInputPreview } from './toolInputPreview';
import { getToolDefinition } from './toolRegistry';
import type {
  JunLuoToolAuditStatus,
  JunLuoToolPermissionAuthorizationSource,
  JunLuoToolPermissionDecision,
} from './toolAuditTypes';
import type { JunLuoToolCall, JunLuoToolResult } from './toolTypes';

export type JunLuoToolStatusChangeEvent = {
  call: JunLuoToolCall;
  card: JunLuoToolCallCard;
  executionId?: string;
  result?: JunLuoToolResult;
};

export function createToolCallCard(call: JunLuoToolCall): JunLuoToolCallCard {
  const tool = getToolDefinition(call.toolId);
  return {
    callId: call.callId,
    toolId: call.toolId,
    packageId: tool?.packageId ?? '',
    toolName: tool?.name ?? call.toolId,
    status: 'requested',
    inputPreview: buildToolInputPreview(call.input),
    permissionDecision: 'not_checked',
    createdAt: call.createdAt,
  };
}

export function updateToolCallCardStatus(
  card: JunLuoToolCallCard,
  status: JunLuoToolAuditStatus,
  options: {
    permissionDecision?: JunLuoToolPermissionDecision;
    permissionSource?: JunLuoToolPermissionAuthorizationSource;
    permissionGrantId?: string;
    permissionExpiresAt?: number;
    permissionSilent?: boolean;
    result?: JunLuoToolResult;
    now?: number;
  } = {},
): JunLuoToolCallCard {
  const now = options.now ?? Date.now();
  const result = options.result;
  return {
    ...card,
    status,
    permissionDecision: options.permissionDecision ?? card.permissionDecision,
    permissionSource: options.permissionSource ?? card.permissionSource,
    permissionGrantId: options.permissionGrantId ?? card.permissionGrantId,
    permissionExpiresAt: options.permissionExpiresAt ?? card.permissionExpiresAt,
    permissionSilent: options.permissionSilent ?? card.permissionSilent,
    startedAt: status === 'running' ? now : card.startedAt ?? result?.startedAt,
    finishedAt: result?.finishedAt ?? (status === 'success' || status === 'error' || status === 'permission_denied' || status === 'cancelled' || status === 'outcome_unknown' ? now : card.finishedAt),
    resultSummary: result?.summary ?? card.resultSummary,
    fileReference: result ? chatTextFileReferenceFromResult(result) : card.fileReference,
    errorMessage: result?.error?.message ?? card.errorMessage,
  };
}

export function updateToolCallCardWithResult(card: JunLuoToolCallCard, result: JunLuoToolResult): JunLuoToolCallCard {
  const status: JunLuoToolAuditStatus = result.status === 'success'
    ? 'success'
    : result.status === 'permission_denied'
      ? 'permission_denied'
      : result.status === 'cancelled'
        ? 'cancelled'
        : 'error';
  return updateToolCallCardStatus(card, status, {
    permissionDecision: card.permissionDecision,
    result,
  });
}
