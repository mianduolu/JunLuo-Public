import type {
  JunLuoToolAuditStatus,
  JunLuoToolInputPreviewValue,
  JunLuoToolPermissionAuthorizationSource,
  JunLuoToolPermissionDecision,
} from '../tools/toolAuditTypes';
import type { JunLuoToolAgentConfirmationPresentation } from '../tools/toolAgentFrozenProposal';
import type { JunLuoToolResult } from '../tools/toolTypes';

export interface BaiyunChatToolReceiptContext {
  callId: string;
  toolId: string;
  sourceMessageId?: string;
  input: Readonly<Record<string, unknown>>;
  result: JunLuoToolResult;
}

export type JunLuoToolCallCard = {
  fileReference?: { cacheId: string; name: string; end?: number };
  callId: string;
  toolId: string;
  packageId: string;
  toolName: string;
  status: JunLuoToolAuditStatus;
  inputPreview: Record<string, JunLuoToolInputPreviewValue>;
  permissionDecision: JunLuoToolPermissionDecision;
  permissionSource?: JunLuoToolPermissionAuthorizationSource;
  permissionGrantId?: string;
  permissionExpiresAt?: number;
  permissionSilent?: boolean;
  resultSummary?: string;
  errorMessage?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  auditId?: string;
  providerCallId?: string;
  proposalId?: string;
  confirmationExpiresAt?: number;
  confirmationPresentation?: JunLuoToolAgentConfirmationPresentation;
  confirmationDecision?: 'pending' | 'confirmed' | 'declined' | 'expired';
};
