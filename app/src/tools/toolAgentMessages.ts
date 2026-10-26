export type JunLuoToolAgentAssistantMessage = {
  subject: 'I';
  kind: 'tool_request';
  content: string;
  reasoningContent?: string;
  toolCalls: Array<{
    callId: string;
    type: 'function';
    rawName: string;
    rawArguments: string;
  }>;
};

export type JunLuoToolAgentResultMessage = {
  subject: 'I';
  kind: 'tool_result';
  callId: string;
  toolId: string;
  content: string;
};

export type JunLuoToolAgentContinuationMessage =
  | JunLuoToolAgentAssistantMessage
  | JunLuoToolAgentResultMessage;

