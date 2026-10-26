export type JunLuoToolExecutionSessionStatus =
  | 'created'
  | 'running'
  | 'committed'
  | 'rolled_back';

export type JunLuoToolExecutionSession = {
  executionId: string;
  status: JunLuoToolExecutionSessionStatus;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  sourceMessageId?: string;
  toolCallIds: string[];
  rollbackReason?: string;
};

export type JunLuoToolExecutionSessionContext = {
  executionId?: string;
  sourceMessageId?: string;
  toolCallIds?: string[];
};

function createExecutionId() {
  return `tool-exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function uniqueToolCallIds(ids: string[]) {
  return Array.from(new Set(ids.filter((id) => typeof id === 'string' && !!id.trim())));
}

export function createToolExecutionSession(
  context: JunLuoToolExecutionSessionContext = {},
): JunLuoToolExecutionSession {
  return {
    executionId: context.executionId || createExecutionId(),
    status: 'created',
    createdAt: Date.now(),
    sourceMessageId: context.sourceMessageId,
    toolCallIds: uniqueToolCallIds(context.toolCallIds ?? []),
  };
}

export function markToolExecutionSessionRunning(
  session: JunLuoToolExecutionSession,
  toolCallId?: string,
): JunLuoToolExecutionSession {
  const now = Date.now();
  return {
    ...session,
    status: session.status === 'committed' || session.status === 'rolled_back' ? session.status : 'running',
    startedAt: session.startedAt ?? now,
    toolCallIds: uniqueToolCallIds([...session.toolCallIds, ...(toolCallId ? [toolCallId] : [])]),
  };
}

export function markToolExecutionSessionCommitted(
  session: JunLuoToolExecutionSession,
): JunLuoToolExecutionSession {
  return {
    ...session,
    status: session.status === 'rolled_back' ? session.status : 'committed',
    finishedAt: session.finishedAt ?? Date.now(),
  };
}

export function markToolExecutionSessionRolledBack(
  session: JunLuoToolExecutionSession,
  reason: string,
): JunLuoToolExecutionSession {
  return {
    ...session,
    status: session.status === 'committed' ? session.status : 'rolled_back',
    finishedAt: session.finishedAt ?? Date.now(),
    rollbackReason: session.rollbackReason ?? reason,
  };
}
