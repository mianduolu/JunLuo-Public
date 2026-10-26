import { BACKEND_OVERVIEW_SERVICE_ID } from '../backend/backendOverview';
import type { JunLuoRegisteredToolDefinition, JunLuoToolCall, JunLuoToolResult } from './toolTypes';
import type { OpenAiCompatibleContinuationMessage } from '../ai/openAiCompatibleProvider';

export const BACKEND_OVERVIEW_TOOL_ID = 'http.call_named_service';
export const BACKEND_OVERVIEW_CATALOG_DESCRIPTION = '查看君落后端状况。';
export const BACKEND_OVERVIEW_TOOL_NAME = '查看后端状况';
export const BACKEND_OVERVIEW_TOOL_DESCRIPTION = '检查君落后端能否连接，查看已有的运行信息和错误记录。';

/** Narrow ordinary-chat projection; the old manual named-service contract stays intact. */
export function backendOverviewChatDefinition(tool: JunLuoRegisteredToolDefinition): JunLuoRegisteredToolDefinition {
  if (tool.id !== BACKEND_OVERVIEW_TOOL_ID) return tool;
  return { ...tool, name: BACKEND_OVERVIEW_TOOL_NAME, description: BACKEND_OVERVIEW_TOOL_DESCRIPTION,
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false } };
}

export function backendOverviewPermissionCall<T extends Pick<JunLuoToolCall, 'input'> & Partial<Pick<JunLuoToolCall, 'requestedBy'>>>(call: T): T {
  return call.requestedBy === 'chat' && Object.keys(call.input).length === 0
    ? { ...call, input: { serviceId: BACKEND_OVERVIEW_SERVICE_ID } } : call;
}

/** The short text is the only payload. No raw response/error fallback after trimming. */
export function projectBackendOverviewResult(result: JunLuoToolResult): JunLuoToolResult {
  if (result.toolId !== BACKEND_OVERVIEW_TOOL_ID) return result;
  return { ...result, data: undefined, error: result.error
    ? { code: result.error.code, message: result.error.code } : undefined };
}

/** A recovered result has no reliable connection snapshot; do not recheck or replay it. */
export function invalidateBackendOverviewReplay<T extends {
  completedResults: readonly JunLuoToolResult[];
  continuationMessages: readonly OpenAiCompatibleContinuationMessage[];
}>(replay: T): T {
  const callIds = new Set(replay.completedResults.filter(result => result.toolId === BACKEND_OVERVIEW_TOOL_ID)
    .map(result => result.callId));
  for (const message of replay.continuationMessages) {
    if (message.kind === 'tool_result' && message.toolId === BACKEND_OVERVIEW_TOOL_ID) callIds.add(message.callId);
  }
  const invalid = { ok: false, status: 'error' as const, summary: '',
    error: { code: 'STALE_DATA_EPOCH' as const, message: 'STALE_DATA_EPOCH' } };
  return { ...replay,
    completedResults: replay.completedResults.map(result => result.toolId === BACKEND_OVERVIEW_TOOL_ID
      ? { callId: result.callId, toolId: result.toolId, startedAt: result.startedAt, finishedAt: result.finishedAt, ...invalid } : result),
    continuationMessages: replay.continuationMessages.map(message => {
      if (message.kind === 'tool_result' && message.toolId === BACKEND_OVERVIEW_TOOL_ID) {
        return { ...message, content: JSON.stringify({ ok: false, status: 'error', errorCode: 'STALE_DATA_EPOCH' }) };
      }
      return message.kind === 'tool_request' ? { ...message, toolCalls: message.toolCalls.map(call => callIds.has(call.callId)
        ? { ...call, rawArguments: '{}' } : call) } : message;
    }),
  };
}
