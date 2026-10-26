import { AppState, Platform } from 'react-native';
import { canCommitBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { loadChatSessionMessage } from '../chat/chatStorage';
import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import { getFileImportRecord } from './fileToolStore';
import { isChatTextFileReference } from '../chat/chatTextFileReference';
import { getToolDefinition, listToolPackages } from './toolRegistry';
import { resolveToolPermissionForCall } from './toolPermissions';
import { isTextFileChatTool } from './textFileChatTools';
import { createToolAgentHostCallId } from './toolAgentHostIdentity';

export async function createTextFileChatHost(input: {
  sourceSessionId: string; sourceMessageId: string; dataEpoch: number;
  signal?: AbortSignal; isReplyCurrent?: () => Promise<boolean>;
  messages: readonly SubjectiveMessage[];
  sourceMessage?: Pick<SubjectiveMessage, 'id' | 'role' | 'content' | 'createdAt'>;
  isExecuting?: () => boolean;
}) {
  const source = input.sourceMessage;
  const refs = new Map<string, { message: SubjectiveMessage; callId: string; name: string; end?: number }>();
  if (Platform.OS === 'android' || Platform.OS === 'ios') {
    for (const message of input.messages) {
      for (const card of message.toolCallCards ?? []) {
        if (card.status !== 'success' || !isTextFileChatTool(card.toolId) || !isChatTextFileReference(card.fileReference)) continue;
        const previous = refs.get(card.fileReference.cacheId);
        if (previous?.end !== undefined && card.fileReference.end === undefined) continue;
        refs.set(card.fileReference.cacheId, { message, callId: card.callId, name: card.fileReference.name, end: card.fileReference.end });
      }
    }
  }
  const local = new Set<string>();
  let used = false;
  const current = async () => {
    if (!source || input.signal?.aborted || !canCommitBackupRestoreDataEpoch(input.dataEpoch)
      || input.isReplyCurrent && !await input.isReplyCurrent()) return false;
    const actual = await loadChatSessionMessage(input.sourceSessionId, input.sourceMessageId);
    return !!actual && actual.role === 'you' && actual.content === source.content && actual.createdAt === source.createdAt
      && !input.signal?.aborted && canCommitBackupRestoreDataEpoch(input.dataEpoch);
  };
  const validRef = async (cacheId: string) => {
    if (!await current()) return false;
    const record = await getFileImportRecord(cacheId);
    if (!record) return false;
    if (local.has(cacheId)) return true;
    const ref = refs.get(cacheId);
    if (!ref || record.name !== ref.name) return false;
    const message = await loadChatSessionMessage(input.sourceSessionId, ref.message.id);
    return !!message?.toolCallCards?.some(card => card.callId === ref.callId && card.status === 'success'
      && card.fileReference?.cacheId === cacheId && card.fileReference.name === ref.name);
  };
  // Historical tool facts, not new speech or a new tool invocation. No file content here.
  const material = refs.size ? JSON.stringify({ files: [...refs].map(([cacheId, ref]) => ({
    cacheId, name: ref.name, ...(ref.end === undefined ? {} : { start: ref.end }),
  })) }) : '';
  return {
    material,
    async checkMaterial() {
      if (used && !await current()) throw new Error('FILE_SOURCE_CHANGED');
      for (const cacheId of refs.keys()) if (!await validRef(cacheId)) throw new Error('FILE_SOURCE_CHANGED');
    },
    remember(cacheId: string) { local.add(cacheId); },
    context(toolId: string, executionId: string, signal: AbortSignal, values: Record<string, unknown> = {}) {
      used = true;
      const tool = getToolDefinition(toolId);
      const permissionAtStart = tool ? resolveToolPermissionForCall(tool, { input: values }) : Promise.resolve(null);
      return {
        cacheId: `file-${createToolAgentHostCallId(input.sourceSessionId, executionId)}`,
        canRead: (cacheId: string) => signal.aborted ? Promise.resolve(false) : validRef(cacheId),
        isCurrent: async () => {
          if (signal.aborted || input.isExecuting && !input.isExecuting() || Platform.OS !== 'android' && Platform.OS !== 'ios'
            || AppState.currentState !== 'active' || !await current()) return false;
          if (!tool || !listToolPackages().some(pack => pack.id === tool.packageId && pack.defaultEnabled)) return false;
          const before = await permissionAtStart;
          const now = await resolveToolPermissionForCall(tool, { input: values });
          return now.permission !== 'deny' && now.permission === before?.permission && now.source === before.source;
        },
      };
    },
  };
}
