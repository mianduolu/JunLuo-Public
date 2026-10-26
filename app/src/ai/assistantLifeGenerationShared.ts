export type AssistantLifeTransportDiagnostic = {
  offeredToolCount?: number;
  toolCapabilitySource?: import('./toolProviderCapabilities').ToolProviderCapabilitySource;
  startedAt: number;
  finishedAt?: number;
  outcome: 'started' | 'response' | 'http-error' | 'network-error' | 'timeout' | 'aborted';
  httpStatus?: number;
};

export type AssistantLifeGenerationDiagnostics = {
  transport?: AssistantLifeTransportDiagnostic;
  cachedPromptTokens?: number;
  finishReason?: string;
  outputChars: number;
  promptTokens?: number;
  completionTokens?: number;
  recoveredFromReasoning: boolean;
  responseFormatRequested: boolean;
};

export type AssistantLifeGenerationFailureReason =
  | 'empty-content'
  | 'invalid-json'
  | 'truncated-output'
  | 'invalid-mood'
  | 'invalid-title'
  | 'invalid-activity'
  | 'timeout'
  | 'rate-limited'
  | 'http-transient'
  | 'auth-or-config'
  | 'aborted';
