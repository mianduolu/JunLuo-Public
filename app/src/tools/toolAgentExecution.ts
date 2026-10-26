import { registerBuiltinTools } from './builtin/registerBuiltinTools';
import { createToolError } from './toolErrors';
import { executeToolCall, type JunLuoToolExecutionOptions } from './toolExecution';
import {
  recordToolCallRequested,
  recordToolExecutionResult,
  recordToolPermissionDecision,
} from './toolAuditStore';
import { getToolDefinition } from './toolRegistry';
import { createToolErrorResult } from './toolResult';
import type { JunLuoToolCall, JunLuoToolCallSource, JunLuoToolDefinition, JunLuoToolResult } from './toolTypes';

export type JunLuoAgentToolCallSource = Exclude<JunLuoToolCallSource, 'chat' | 'manual'>;

export type JunLuoAgentToolCallRequest = {
  callId?: string;
  createdAt?: number;
  input?: Record<string, unknown>;
  requestedBy: JunLuoAgentToolCallSource;
  sourceMessageId?: string;
  toolId: string;
};

export type JunLuoAgentToolExecutionOptions = Omit<JunLuoToolExecutionOptions, 'bypassPermission'> & {
  allowToolIds?: string[];
  executionId?: string;
};

function createAgentId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeAgentToolCall(request: JunLuoAgentToolCallRequest): JunLuoToolCall {
  return {
    callId: request.callId ?? createAgentId(`agent-tool-${request.requestedBy}`),
    createdAt: request.createdAt ?? Date.now(),
    input: request.input ?? {},
    requestedBy: request.requestedBy,
    sourceMessageId: request.sourceMessageId,
    toolId: request.toolId,
  };
}

function isLifeAgentAllowed(tool: JunLuoToolDefinition) {
  return tool.readOnly && (tool.riskLevel === 'read' || tool.riskLevel === 'external_network');
}

function isProactiveAllowed(tool: JunLuoToolDefinition) {
  return (
    (tool.readOnly && tool.riskLevel === 'read') ||
    (tool.id === 'device.get_accessibility_snapshot' && tool.readOnly)
  );
}

function isBackgroundAllowed(tool: JunLuoToolDefinition) {
  return tool.readOnly && tool.riskLevel === 'read';
}

export function canAgentExecuteTool(source: JunLuoAgentToolCallSource, tool: JunLuoToolDefinition) {
  switch (source) {
    case 'life_agent':
      return isLifeAgentAllowed(tool);
    case 'proactive':
      return isProactiveAllowed(tool);
    case 'background':
      return isBackgroundAllowed(tool);
    case 'social_agent':
      return false;
    default:
      return false;
  }
}

async function recordAgentDenied(call: JunLuoToolCall, result: JunLuoToolResult, executionId?: string) {
  try {
    await recordToolCallRequested(call, executionId);
    await recordToolPermissionDecision(call.callId, 'denied', executionId);
    await recordToolExecutionResult(call.callId, result, executionId);
  } catch {
    // Agent audit must not break proactive/background flows.
  }
}

export async function executeAgentToolCall(
  request: JunLuoAgentToolCallRequest,
  options: JunLuoAgentToolExecutionOptions = {},
): Promise<JunLuoToolResult> {
  registerBuiltinTools();
  const call = normalizeAgentToolCall(request);
  const executionId = options.executionId ?? createAgentId(`agent-execution-${call.requestedBy}`);
  const tool = getToolDefinition(call.toolId);
  if (!tool) {
    return executeToolCall(call, { ...options, bypassPermission: true, executionId });
  }
  const explicitlyAllowed = options.allowToolIds?.includes(tool.id) ?? false;
  if (!explicitlyAllowed && !canAgentExecuteTool(call.requestedBy as JunLuoAgentToolCallSource, tool)) {
    const result = createToolErrorResult(
      call,
      createToolError('PERMISSION_DENIED', `非聊天来源不允许执行工具：${call.requestedBy} -> ${call.toolId}`, {
        requestedBy: call.requestedBy,
        riskLevel: tool.riskLevel,
        readOnly: tool.readOnly,
      }),
      '没有执行工具',
    );
    await recordAgentDenied(call, result, executionId);
    return result;
  }
  return executeToolCall(call, { ...options, bypassPermission: true, executionId });
}
