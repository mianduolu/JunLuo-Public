import { getToolDefinition } from './toolRegistry';
import { getToolChatAgentReadiness } from './toolChatAgentMigration';
import type { JunLuoToolChatAgentReadiness } from './toolChatAgentMigration';
import {
  getToolAgentConfirmationPresenter,
} from './toolAgentConfirmationPresenter';
import {
  toolAgentFrozenProposalStore,
  type JunLuoToolAgentFrozenProposal,
  type JunLuoToolAgentFrozenProposalStore,
  type JunLuoToolAgentConfirmationPresentation,
} from './toolAgentFrozenProposal';
import { createToolAgentHostCallId, createToolAgentInputHash } from './toolAgentHostIdentity';
import type {
  JunLuoToolAgentInvocationExecutionContext,
  JunLuoToolAgentInvocationGate,
  JunLuoToolAgentInvocationGateReceipt,
} from './toolAgentLoop';
import {
  resolveToolPermissionForCall,
  type JunLuoToolPermissionResolution,
} from './toolPermissions';
import type { JunLuoToolInvocation } from './toolCallProtocol';
import type { JunLuoToolCall, JunLuoToolCallSource, JunLuoToolResult } from './toolTypes';

export type JunLuoToolAgentGateRejectionKind =
  | 'permission_denied'
  | 'cancelled';

export function createToolAgentGateRejectedResult(
  invocation: JunLuoToolInvocation,
  kind: JunLuoToolAgentGateRejectionKind,
): JunLuoToolResult {
  const now = Date.now();
  const errorCode = kind === 'permission_denied'
    ? 'PERMISSION_DENIED' as const
    : 'CANCELLED_BY_YOU' as const;
  return {
    callId: invocation.callId,
    toolId: invocation.toolId,
    ok: false,
    status: kind,
    summary: '',
    error: { code: errorCode, message: errorCode },
    startedAt: now,
    finishedAt: now,
  };
}

export type JunLuoToolAgentPermissionGateOptions = {
  confirmationPresentation?: JunLuoToolAgentConfirmationPresentation;
  proposalStore?: JunLuoToolAgentFrozenProposalStore;
  now?: () => number;
  requestedBy?: JunLuoToolCallSource;
  createRejectedResult: (
    invocation: JunLuoToolInvocation,
    kind: JunLuoToolAgentGateRejectionKind,
  ) => JunLuoToolResult;
  promptForReadPermission: (
    toolId: string,
    call: JunLuoToolCall,
    signal: AbortSignal,
  ) => Promise<'allowed' | 'cancelled'>;
  onProposal?: (
    proposal: JunLuoToolAgentFrozenProposal,
    permission: JunLuoToolPermissionResolution,
  ) => void | Promise<void>;
  onHostCancellation?: (reason: 'confirmation_expired') => void;
  onGateStatus?: (event: {
    invocation: JunLuoToolInvocation;
    auditId: string;
    status:
      | 'awaiting_permission'
      | 'awaiting_confirmation'
      | 'permission_denied'
      | 'cancelled'
      | 'host_cancelled'
      | 'confirmation_expired';
    permission: JunLuoToolPermissionResolution;
    proposal?: JunLuoToolAgentFrozenProposal;
  }) => void | Promise<void>;
  resolveReadiness?: (toolId: string) => JunLuoToolChatAgentReadiness | undefined;
  allowSideEffectWithoutConfirmation?: (input: {
    policyId: string;
    invocation: JunLuoToolInvocation;
    context: Omit<JunLuoToolAgentInvocationExecutionContext, 'gateReceipt'>;
  }) => boolean;
};

function receipt(input: {
  invocation: JunLuoToolInvocation;
  context: Omit<JunLuoToolAgentInvocationExecutionContext, 'gateReceipt'>;
  permission: JunLuoToolPermissionResolution;
  frozenInput: Record<string, unknown>;
  proposalId?: string;
  now: number;
}): JunLuoToolAgentInvocationGateReceipt {
  const auditId = createToolAgentHostCallId(input.context.turnId, input.context.providerCallId);
  const inputHash = createToolAgentInputHash(input.frozenInput);
  return {
    auditId,
    frozenInput: { ...input.frozenInput },
    inputHash,
    proposalId: input.proposalId,
    permission: {
      callId: auditId,
      toolId: input.invocation.toolId,
      inputHash,
      decision: 'allowed',
      source: input.permission.source,
      grantId: input.permission.grantId,
      expiresAt: input.permission.expiresAt,
      silent: input.permission.silent,
      issuedAt: input.now,
    },
  };
}

export async function resolveNativeChatToolInvocationGate(
  invocation: JunLuoToolInvocation,
  context: Omit<JunLuoToolAgentInvocationExecutionContext, 'gateReceipt'>,
  options: JunLuoToolAgentPermissionGateOptions,
): Promise<JunLuoToolAgentInvocationGate> {
  const tool = getToolDefinition(invocation.toolId);
  if (!tool) throw new Error('TOOL_AGENT_GATE_TOOL_NOT_FOUND');
  const now = options.now ?? Date.now;
  const proposalStore = options.proposalStore ?? toolAgentFrozenProposalStore;
  const call: JunLuoToolCall = {
    callId: createToolAgentHostCallId(context.turnId, context.providerCallId),
    toolId: invocation.toolId,
    input: invocation.input,
    requestedBy: options.requestedBy ?? 'chat',
    createdAt: now(),
    sourceMessageId: context.sourceMessageId,
  };
  const permission = await resolveToolPermissionForCall(tool, call);
  if (permission.permission === 'deny') {
    await options.onGateStatus?.({
      invocation,
      auditId: call.callId,
      status: 'permission_denied',
      permission,
    });
    return {
      kind: 'permission',
      wait: async () => ({
        decision: 'result',
        result: options.createRejectedResult(invocation, 'permission_denied'),
      }),
    };
  }

  if (tool.readOnly) {
    if (permission.permission === 'allow') {
      return {
        kind: 'none',
        receipt: receipt({
          invocation,
          context,
          permission,
          frozenInput: invocation.input,
          now: now(),
        }),
      };
    }
    return {
      kind: 'permission',
      wait: async (signal) => {
        await options.onGateStatus?.({
          invocation,
          auditId: call.callId,
          status: 'awaiting_permission',
          permission,
        });
        const decision = await options.promptForReadPermission(tool.id, call, signal);
        if (decision !== 'allowed') {
          await options.onGateStatus?.({
            invocation,
            auditId: call.callId,
            status: 'cancelled',
            permission,
          });
          return {
            decision: 'result',
            result: options.createRejectedResult(invocation, 'cancelled'),
          };
        }
        return {
          decision: 'execute',
          receipt: receipt({
            invocation,
            context,
            permission: {
              permission: 'ask',
              source: 'prompt',
              silent: false,
            },
            frozenInput: invocation.input,
            now: now(),
          }),
        };
      },
    };
  }

  const readiness = (options.resolveReadiness ?? getToolChatAgentReadiness)(tool.id);
  const sideEffectPolicyId = readiness?.sideEffectGatePolicyId;
  const sideEffectPolicyAccepted = !!sideEffectPolicyId
    && options.allowSideEffectWithoutConfirmation?.({
      policyId: sideEffectPolicyId,
      invocation,
      context,
    }) === true;
  if (readiness?.mode === 'agent_primary' && sideEffectPolicyAccepted) {
    if (permission.permission === 'allow') {
      return {
        kind: 'none',
        receipt: receipt({
          invocation,
          context,
          permission,
          frozenInput: invocation.input,
          now: now(),
        }),
      };
    }
    return {
      kind: 'permission',
      wait: async (signal) => {
        await options.onGateStatus?.({
          invocation,
          auditId: call.callId,
          status: 'awaiting_permission',
          permission,
        });
        const decision = await options.promptForReadPermission(tool.id, call, signal);
        if (decision !== 'allowed') {
          await options.onGateStatus?.({
            invocation,
            auditId: call.callId,
            status: 'cancelled',
            permission,
          });
          return {
            decision: 'result',
            result: options.createRejectedResult(invocation, 'cancelled'),
          };
        }
        return {
          decision: 'execute',
          receipt: receipt({
            invocation,
            context,
            permission: { permission: 'ask', source: 'prompt', silent: false },
            frozenInput: invocation.input,
            now: now(),
          }),
        };
      },
    };
  }
  const presenter = getToolAgentConfirmationPresenter(readiness?.confirmationPresenterId);
  if (!readiness || readiness.mode !== 'agent_primary' || !presenter) {
    throw new Error('TOOL_AGENT_CONFIRMATION_PRESENTER_REQUIRED');
  }
  const auditId = createToolAgentHostCallId(context.turnId, context.providerCallId);
  const proposal = proposalStore.freeze({
    turnId: context.turnId,
    providerCallId: context.providerCallId,
    auditId,
    toolId: tool.id,
    rawInput: invocation.input,
    dataEpoch: context.dataEpoch,
    presentation: options.confirmationPresentation ?? presenter({ tool, arguments: invocation.input }),
    createdAt: now(),
  });
  await options.onProposal?.(proposal, permission);
  await options.onGateStatus?.({
    invocation,
    auditId,
    status: 'awaiting_confirmation',
    permission,
    proposal,
  });
  return {
    kind: 'confirmation',
    proposalId: proposal.proposalId,
    expiresAt: proposal.expiresAt,
    wait: async (signal) => {
      const decision = await proposalStore.wait(proposal.proposalId, signal);
      if (decision === 'expired') {
        await options.onGateStatus?.({
          invocation,
          auditId,
          status: 'confirmation_expired',
          permission,
          proposal,
        });
        options.onHostCancellation?.('confirmation_expired');
        throw new Error('TOOL_AGENT_CONFIRMATION_EXPIRED');
      }
      if (decision === 'aborted') {
        await options.onGateStatus?.({
          invocation,
          auditId,
          status: 'host_cancelled',
          permission,
          proposal,
        });
        throw new Error('TOOL_AGENT_CONFIRMATION_ABORTED');
      }
      if (decision === 'declined') {
        await options.onGateStatus?.({
          invocation,
          auditId,
          status: 'cancelled',
          permission,
          proposal,
        });
        return {
          decision: 'result',
          result: options.createRejectedResult(invocation, 'cancelled'),
        };
      }
      const confirmedProposal = proposalStore.get(proposal.proposalId);
      if (!confirmedProposal) throw new Error('TOOL_AGENT_CONFIRMATION_MISMATCH');
      const frozenInput = proposalStore.consumeConfirmed({
        proposalId: proposal.proposalId,
        turnId: context.turnId,
        providerCallId: context.providerCallId,
        auditId,
        toolId: tool.id,
        inputHash: confirmedProposal.inputHash,
        dataEpoch: confirmedProposal.dataEpoch,
        now: now(),
      });
      if (!frozenInput) throw new Error('TOOL_AGENT_CONFIRMATION_MISMATCH');
      return {
        decision: 'execute',
        receipt: receipt({
          invocation,
          context,
          permission: permission.permission === 'ask'
            ? { permission: 'ask', source: 'prompt', silent: false }
            : permission,
          frozenInput,
          proposalId: proposal.proposalId,
          now: now(),
        }),
      };
    },
  };
}
