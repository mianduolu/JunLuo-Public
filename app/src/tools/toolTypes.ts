export type JunLuoToolPermissionLevel = 'allow' | 'ask' | 'deny';

export type JunLuoToolRiskLevel =
  | 'read'
  | 'write_local'
  | 'external_network'
  | 'device_control'
  | 'social_action'
  | 'dangerous';

export type JunLuoToolSource = 'builtin' | 'backend' | 'mcp' | 'local_plugin';

export type JunLuoToolAgentEpochMode =
  | 'read_only_outside_lease'
  | 'bounded_local_commits'
  | 'whole_execution_lease';

export type JunLuoToolChatExposure =
  | 'candidate'
  | 'explicit_only'
  | 'internal_only'
  | 'disabled';

export type JunLuoToolCallSource =
  | 'chat'
  | 'proactive'
  | 'life_agent'
  | 'social_agent'
  | 'background'
  | 'manual';

export type JunLuoToolResultStatus = 'success' | 'error' | 'permission_denied' | 'cancelled';

export type JunLuoToolInputSchemaType = 'string' | 'number' | 'boolean' | 'object' | 'array';

export type JunLuoToolInputSchema = {
  type: JunLuoToolInputSchemaType;
  nullable?: boolean;
  description?: string;
  properties?: Record<string, JunLuoToolInputSchema>;
  required?: string[];
  items?: JunLuoToolInputSchema;
  minItems?: number;
  enum?: Array<string | number | boolean>;
  additionalProperties?: boolean;
};

export type JunLuoToolError = {
  code: JunLuoToolErrorCode;
  message: string;
  details?: unknown;
};

export type JunLuoToolCall = {
  callId: string;
  toolId: string;
  input: Record<string, unknown>;
  requestedBy: JunLuoToolCallSource;
  createdAt: number;
  sourceMessageId?: string;
  executionIntentId?: string;
  executionIntentSource?: string;
};

export type JunLuoToolResult<TData = unknown> = {
  callId: string;
  toolId: string;
  ok: boolean;
  status: JunLuoToolResultStatus;
  summary: string;
  data?: TData;
  error?: JunLuoToolError;
  startedAt: number;
  finishedAt: number;
};

export type JunLuoToolExecutorContext = {
  backendOverviewChat?: (call: JunLuoToolCall) => Promise<JunLuoToolResult>;
  dialerChat?: (call: JunLuoToolCall) => Promise<JunLuoToolResult>;
  appLaunchChat?: (call: JunLuoToolCall) => Promise<JunLuoToolResult>;
  chatReminder?: (call: JunLuoToolCall) => Promise<JunLuoToolResult>;
  chatExpense?: (call: JunLuoToolCall) => Promise<JunLuoToolResult>;
  chatSchedule?: (call: JunLuoToolCall) => Promise<JunLuoToolResult>;
  chatImage?: (call: JunLuoToolCall) => Promise<JunLuoToolResult>;
  textFileChat?: { cacheId: string; isCurrent: () => Promise<boolean>; canRead: (cacheId: string) => Promise<boolean> };
  backupRestoreLeaseHeld: boolean;
  /** Current voyage source/settings/restore epoch; supplied by the host, never model input. */
  githubVoyageIsCurrent?: () => Promise<boolean>;
  diagnosticParentToken?: number;
  runBackupRestoreDataEpochCommit?: <T>(work: () => Promise<T> | T) => Promise<T>;
  /** Supplied only by the dedicated sleep opportunity host, never from tool arguments. */
  sleepScheduleDecision?: (input: Record<string, unknown>, callId: string) => Promise<import('../life/sleepPlanPolicy').SleepScheduleResult>;
  /** Only the prepared camera host can supply this current-session authorization. */
  cameraObservation?: (call: JunLuoToolCall) => Promise<JunLuoToolResult>;
  /** Ordinary chat's per-turn numbered memory binding; never supplied by model arguments. */
  memoryRead?: (call: JunLuoToolCall) => Promise<JunLuoToolResult>;
  proactiveContact?: (call: JunLuoToolCall) => Promise<JunLuoToolResult>;
  readingControl?: (call: JunLuoToolCall) => Promise<JunLuoToolResult>;
  readingMaterial?: (call: JunLuoToolCall) => Promise<JunLuoToolResult>;
  mapSearch?: import('./mapSearchSession').MapSearchHostContext;
  ownSchedule?: (call: JunLuoToolCall) => Promise<JunLuoToolResult>;
  userRoutine?: (call: JunLuoToolCall) => Promise<JunLuoToolResult>;
  ownScheduleScope?: 'near-status';
  wishPool?: (call: JunLuoToolCall) => Promise<JunLuoToolResult>;
  giftCabinet?: (call: JunLuoToolCall) => Promise<JunLuoToolResult>;
  phoneLimit?: (call: JunLuoToolCall) => Promise<JunLuoToolResult>;
};

export type JunLuoToolExecutor<TInput extends Record<string, unknown> = Record<string, unknown>, TData = unknown> = (
  call: JunLuoToolCall & { input: TInput },
  context?: JunLuoToolExecutorContext,
) => Promise<JunLuoToolResult<TData>> | JunLuoToolResult<TData>;

export type JunLuoToolDefinition<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TData = unknown,
> = {
  id: string;
  packageId: string;
  name: string;
  description: string;
  inputSchema: JunLuoToolInputSchema & { type: 'object' };
  permission: JunLuoToolPermissionLevel;
  riskLevel: JunLuoToolRiskLevel;
  readOnly: boolean;
  chatExposure?: JunLuoToolChatExposure;
  proactiveEligible?: boolean;
  conflictGroup?: string;
  executionScope?: 'local_device' | 'sync_once';
  agentEpochMode?: JunLuoToolAgentEpochMode;
  agentSettlementDeadlineMs?: number;
  backupRestoreSafeOutsideLease?: boolean;
  executor?: JunLuoToolExecutor<TInput, TData>;
};

export type JunLuoRegisteredToolDefinition<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TData = unknown,
> = JunLuoToolDefinition<TInput, TData> & {
  chatExposure: JunLuoToolChatExposure;
  proactiveEligible: boolean;
};

export type JunLuoToolPackage = {
  id: string;
  name: string;
  description: string;
  category: string;
  tools: JunLuoToolDefinition[];
  defaultEnabled: boolean;
  riskLevel: JunLuoToolRiskLevel;
  source: JunLuoToolSource;
};

export type JunLuoToolErrorCode =
  | 'TOOL_NOT_FOUND'
  | 'PACKAGE_NOT_FOUND'
  | 'VALIDATION_FAILED'
  | 'WISH_DISCUSSION_NOT_AVAILABLE'
  | 'PERMISSION_DENIED'
  | 'CANCELLED_BY_YOU'
  | 'TOOL_DISABLED'
  | 'TOOL_LIMIT_EXCEEDED'
  | 'DUPLICATE_TOOL_CALL'
  | 'INVALID_ARGUMENTS'
  | 'STALE_DATA_EPOCH'
  | 'TOOL_TIMEOUT'
  | 'TOOL_OUTCOME_UNKNOWN'
  | 'TOOL_NOT_STARTED'
  | 'TOOL_EXECUTION_PENDING'
  | 'TOOL_INPUT_REQUIRED'
  | 'EXECUTION_FAILED'
  | 'READ_FAILED'
  | 'CAMERA_OBSERVATION_FAILED'
  | 'DUPLICATE_PACKAGE_ID'
  | 'DUPLICATE_TOOL_ID'
  | 'INVALID_TOOL_PACKAGE'
  | 'INVALID_TOOL_DEFINITION';
