import type { JunLuoToolCall, JunLuoToolError, JunLuoToolResult } from './toolTypes';

export function createToolSuccessResult<TData = unknown>(
  call: JunLuoToolCall,
  summary: string,
  data?: TData,
): JunLuoToolResult<TData> {
  const now = Date.now();
  return {
    callId: call.callId,
    toolId: call.toolId,
    ok: true,
    status: 'success',
    summary,
    ...(data === undefined ? {} : { data }),
    startedAt: now,
    finishedAt: now,
  };
}

export function createToolErrorResult<TData = unknown>(
  call: JunLuoToolCall,
  error: JunLuoToolError,
  summary = '工具执行失败',
): JunLuoToolResult<TData> {
  const now = Date.now();
  return {
    callId: call.callId,
    toolId: call.toolId,
    ok: false,
    status: error.code === 'PERMISSION_DENIED' ? 'permission_denied' : 'error',
    summary,
    error,
    startedAt: now,
    finishedAt: now,
  };
}
