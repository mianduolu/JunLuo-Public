import { executeToolCall, type JunLuoToolExecutionOptions } from './toolExecution';
import { recordToolAgentAuditMetadata } from './toolAuditStore';
import { createToolAgentHostCallId, createToolAgentInputHash } from './toolAgentHostIdentity';
import type {
  JunLuoToolAgentInvocationExecutionContext,
} from './toolAgentLoop';
import { getToolChatAgentReadiness, type JunLuoToolChatAgentReadiness } from './toolChatAgentMigration';
import type { JunLuoToolInvocation } from './toolCallProtocol';
import type { JunLuoToolCall, JunLuoToolCallSource, JunLuoToolResult } from './toolTypes';

export type JunLuoNativeChatToolExecutionOptions = {
  candidateSource?: string;
  authorityKind?: string;
  providerFinishReason?: string;
  requestedBy?: JunLuoToolCallSource;
  readiness?: (toolId: string) => JunLuoToolChatAgentReadiness | undefined;
  execute?: typeof executeToolCall;
  executionOptions?: Omit<
    JunLuoToolExecutionOptions,
    | 'bypassPermission'
    | 'permissionPreauthorization'
    | 'toolAgentInputHash'
    | 'toolAgentHostExecutionId'
    | 'agentAuditMetadata'
  >;
  now?: () => number;
};

export async function executeNativeChatToolInvocation(
  invocation: JunLuoToolInvocation,
  context: JunLuoToolAgentInvocationExecutionContext,
  options: JunLuoNativeChatToolExecutionOptions = {},
): Promise<JunLuoToolResult> {
  const gateReceipt = context.gateReceipt;
  if (!gateReceipt) throw new Error('TOOL_AGENT_GATE_RECEIPT_REQUIRED');
  const readiness = (options.readiness ?? getToolChatAgentReadiness)(invocation.toolId);
  if (readiness?.mode !== 'agent_primary') throw new Error('TOOL_AGENT_MIGRATION_NOT_PRIMARY');

  const auditId = createToolAgentHostCallId(context.turnId, context.providerCallId);
  const inputHash = createToolAgentInputHash(gateReceipt.frozenInput);
  if (
    gateReceipt.auditId !== auditId
    || gateReceipt.inputHash !== inputHash
    || gateReceipt.permission.callId !== auditId
    || gateReceipt.permission.toolId !== invocation.toolId
    || gateReceipt.permission.inputHash !== inputHash
  ) {
    throw new Error('TOOL_AGENT_GATE_RECEIPT_MISMATCH');
  }

  const now = options.now ?? Date.now;
  const call: JunLuoToolCall = {
    callId: auditId,
    toolId: invocation.toolId,
    input: { ...gateReceipt.frozenInput },
    requestedBy: options.requestedBy ?? 'chat',
    createdAt: now(),
    sourceMessageId: context.sourceMessageId,
  };
  const startedAt = now();
  const result = await (options.execute ?? executeToolCall)(call, {
    ...options.executionOptions,
    executionId: options.executionOptions?.executionId ?? `tool-agent:${auditId}`,
    permissionPreauthorization: gateReceipt.permission,
    toolAgentInputHash: inputHash,
    toolAgentHostExecutionId: context.hostExecutionId,
    agentAuditMetadata: {
      auditId,
      turnId: context.turnId,
      providerCallId: context.providerCallId,
      toolRound: context.round,
      candidateSource: options.candidateSource,
      authorityKind: options.authorityKind,
      providerFinishReason: options.providerFinishReason,
      proposalId: gateReceipt.proposalId,
      confirmationDecision: gateReceipt.proposalId ? 'confirmed' : undefined,
      dataEpoch: context.dataEpoch,
    },
  });
  await recordToolAgentAuditMetadata(auditId, {
    executionDurationMs: Math.max(0, now() - startedAt),
  }).catch(() => undefined);
  return {
    ...result,
    callId: context.providerCallId,
    toolId: invocation.toolId,
  };
}
