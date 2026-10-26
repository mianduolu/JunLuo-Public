import type { JunLuoToolInputPreviewValue } from './toolAuditTypes';
import type { JunLuoToolCall, JunLuoToolResult } from './toolTypes';

export type JunLuoToolHookType =
  | 'message_processing'
  | 'tool_lifecycle'
  | 'prompt_before_send'
  | 'prompt_tool_filter'
  | 'chat_input'
  | 'app_lifecycle';

export type JunLuoToolLifecycleEventType =
  | 'tool_call_requested'
  | 'tool_permission_checked'
  | 'tool_execution_started'
  | 'tool_execution_result'
  | 'tool_execution_error'
  | 'tool_execution_finished';

export type JunLuoToolLifecycleCallSnapshot = Omit<JunLuoToolCall, 'input'> & {
  inputPreview: Record<string, JunLuoToolInputPreviewValue>;
};

export type JunLuoToolLifecycleEvent = {
  eventId: string;
  eventType: JunLuoToolLifecycleEventType;
  call: JunLuoToolLifecycleCallSnapshot;
  toolId: string;
  packageId: string;
  executionId?: string;
  permissionDecision?: 'not_checked' | 'allowed' | 'denied' | 'cancelled';
  result?: Readonly<JunLuoToolResult>;
  error?: {
    message: string;
    code?: string;
    details?: unknown;
  };
  createdAt: number;
};

export type JunLuoToolLifecycleHook = (event: JunLuoToolLifecycleEvent) => void | Promise<void>;

export type JunLuoToolHookRegistration = {
  id: string;
  hookType: 'tool_lifecycle';
  name?: string;
  source?: 'builtin' | 'internal' | 'mcp' | 'local_plugin';
  handler: JunLuoToolLifecycleHook;
};

export type JunLuoToolHookDiagnostic = {
  hookId: string;
  hookType: JunLuoToolHookType;
  eventType?: JunLuoToolLifecycleEventType;
  message: string;
  createdAt: number;
};

export const JUNLUO_TOOL_HOOK_TYPES: readonly JunLuoToolHookType[] = [
  'message_processing',
  'tool_lifecycle',
  'prompt_before_send',
  'prompt_tool_filter',
  'chat_input',
  'app_lifecycle',
] as const;

export const JUNLUO_ENABLED_TOOL_HOOK_TYPES: readonly JunLuoToolHookType[] = [
  'tool_lifecycle',
] as const;
