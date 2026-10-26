import { loadChatSessionMessage } from '../chat/chatStorage';
import { PRIMARY_CHAT_SESSION_ID } from '../chat/primaryChat';
import { getChatDataRevision } from '../chat/chatDataChanges';
import { canCommitBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { BACKEND_OVERVIEW_DEADLINE_MS, checkBackendOverview, sameBackendOverviewConnection, type BackendOverviewConnection,
  type BackendOverviewPorts, type BackendOverviewResult } from '../backend/backendOverview';
import { readBackendOverviewConnection, readBackendOverviewLocalInfo } from '../backend/backendOverviewReadOnly';
import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import { getToolDefinition, listToolPackages } from './toolRegistry';
import { resolveToolPermissionForCall } from './toolPermissions';
import { BACKEND_OVERVIEW_TOOL_ID, backendOverviewPermissionCall } from './chatBackendOverview';
import { createToolError } from './toolErrors';
import { createToolErrorResult, createToolSuccessResult } from './toolResult';
import type { JunLuoToolCall, JunLuoToolResult } from './toolTypes';

type HostInput = {
  sourceSessionId: string; sourceMessageId: string;
  sourceMessage?: Pick<SubjectiveMessage, 'id' | 'role' | 'content' | 'createdAt'>;
  dataEpoch: number; signal?: AbortSignal; isReplyCurrent?: () => Promise<boolean>;
};
export function createBackendOverviewChatHost(input: HostInput, overrides: Partial<{
  loadSource: typeof loadChatSessionMessage;
  isEpochCurrent: typeof canCommitBackupRestoreDataEpoch;
  chatRevision: typeof getChatDataRevision;
  permission: (call: JunLuoToolCall) => Promise<string | null>;
  readConnection: BackendOverviewPorts['readConnection'];
  readLocalInfo: BackendOverviewPorts['readLocalInfo'];
  fetch: typeof fetch;
}> = {}) {
  const ports = {
    loadSource: loadChatSessionMessage, isEpochCurrent: canCommitBackupRestoreDataEpoch, chatRevision: getChatDataRevision,
    readConnection: readBackendOverviewConnection, readLocalInfo: readBackendOverviewLocalInfo,
    fetch: ((...args: Parameters<typeof fetch>) => fetch(...args)) as typeof fetch,
    permission: async (call: JunLuoToolCall) => {
      const tool = getToolDefinition(BACKEND_OVERVIEW_TOOL_ID);
      if (!tool || !listToolPackages().find(item => item.id === 'http')?.defaultEnabled) return null;
      const resolution = await resolveToolPermissionForCall(tool, backendOverviewPermissionCall(call));
      return resolution.permission === 'deny' ? null : JSON.stringify(resolution);
    }, ...overrides,
  };
  let check: Promise<BackendOverviewResult> | undefined;
  let usedConnection: BackendOverviewConnection | null | undefined;
  let permissionBasis: string | undefined;
  let firstCall: JunLuoToolCall | undefined;
  const sourceCurrent = async () => {
    if (input.signal?.aborted || !ports.isEpochCurrent(input.dataEpoch)
      || input.sourceSessionId !== PRIMARY_CHAT_SESSION_ID || input.sourceMessage?.id !== input.sourceMessageId
      || input.sourceMessage.role !== 'you' || input.isReplyCurrent && !await input.isReplyCurrent()) return false;
    const revision = ports.chatRevision();
    const source = await ports.loadSource(input.sourceSessionId, input.sourceMessageId);
    return !!source && source.role === 'you' && source.content === input.sourceMessage.content
      && source.createdAt === input.sourceMessage.createdAt && !input.signal?.aborted
      && ports.isEpochCurrent(input.dataEpoch)
      && (!input.isReplyCurrent || await input.isReplyCurrent())
      && revision === ports.chatRevision() && !input.signal?.aborted && ports.isEpochCurrent(input.dataEpoch);
  };
  const boundedCurrent = async (signal?: AbortSignal) => {
    if (signal?.aborted || input.signal?.aborted) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stop!: () => void;
    const stopped = new Promise<false>(resolve => {
      stop = () => resolve(false);
      timer = setTimeout(stop, BACKEND_OVERVIEW_DEADLINE_MS);
    });
    signal?.addEventListener('abort', stop);
    input.signal?.addEventListener('abort', stop);
    try { return await Promise.race([current(), stopped]); }
    finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      input.signal?.removeEventListener('abort', stop);
    }
  };
  const current = async (connection = usedConnection) => {
    try {
      if (!firstCall || !await sourceCurrent()) return false;
      const permission = await ports.permission(firstCall);
      if (!permission) return false;
      if (permissionBasis === undefined) permissionBasis = permission;
      if (permission !== permissionBasis) return false;
      if (connection !== undefined && !sameBackendOverviewConnection(connection, await ports.readConnection())) return false;
      if (!await sourceCurrent()) return false;
      const revision = ports.chatRevision();
      // These narrow rereads close changes made while the final source read was waiting.
      if (await ports.permission(firstCall) !== permissionBasis) return false;
      if (connection !== undefined && !sameBackendOverviewConnection(connection, await ports.readConnection())) return false;
      return !input.signal?.aborted && ports.isEpochCurrent(input.dataEpoch)
        && (!input.isReplyCurrent || await input.isReplyCurrent())
        && revision === ports.chatRevision() && !input.signal?.aborted && ports.isEpochCurrent(input.dataEpoch);
    } catch { return false; }
  };
  const failed = (call: JunLuoToolCall, code: Parameters<typeof createToolError>[0]) =>
    createToolErrorResult(call, createToolError(code, code), '');
  return {
    hasResult: () => check !== undefined,
    isCurrent: () => check === undefined ? Promise.resolve(true) : boundedCurrent(),
    execute: async (call: JunLuoToolCall, signal?: AbortSignal, authorized = false): Promise<JunLuoToolResult> => {
      if (!authorized) return failed(call, 'PERMISSION_DENIED');
      if (call.requestedBy !== 'chat' || call.sourceMessageId !== input.sourceMessageId
        || call.toolId !== BACKEND_OVERVIEW_TOOL_ID || Object.keys(call.input).length !== 0) return failed(call, 'INVALID_ARGUMENTS');
      firstCall ??= call;
      try {
        const reused = check !== undefined;
        if (!check) {
          const controller = new AbortController();
          const abort = () => controller.abort();
          signal?.addEventListener('abort', abort);
          input.signal?.addEventListener('abort', abort);
          if (signal?.aborted || input.signal?.aborted) abort();
          check = checkBackendOverview({
            readConnection: async () => { usedConnection = await ports.readConnection(); return usedConnection; },
            readLocalInfo: ports.readLocalInfo, isCurrent: current, fetch: ports.fetch,
            signal: controller.signal,
          }).finally(() => {
            signal?.removeEventListener('abort', abort);
            input.signal?.removeEventListener('abort', abort);
          });
        }
        const result = await check;
        // The first check already includes its final source read inside the twelve-second deadline.
        if (signal?.aborted || input.signal?.aborted) return failed(call, 'CANCELLED_BY_YOU');
        if (reused && !await boundedCurrent(signal)) return failed(call, 'STALE_DATA_EPOCH');
        return result.ok ? createToolSuccessResult(call, result.text)
          : createToolErrorResult(call, createToolError('EXECUTION_FAILED', 'EXECUTION_FAILED'), result.text);
      } catch (error) {
        return failed(call, signal?.aborted || input.signal?.aborted ? 'CANCELLED_BY_YOU'
          : error instanceof Error && error.message === 'stale' ? 'STALE_DATA_EPOCH' : 'READ_FAILED');
      }
    },
  };
}
