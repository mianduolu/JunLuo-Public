import { AppState } from 'react-native';
import { loadChatSessionMessage } from '../chat/chatStorage';
import { PRIMARY_CHAT_SESSION_ID } from '../chat/primaryChat';
import { canCommitBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { readPhoneLaunchableAppEntries, launchPhoneAppEntry, type PhoneLaunchableAppEntry } from '../backend/phoneActivityNative';
import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import type { JunLuoToolCall, JunLuoToolResult } from './toolTypes';
import type { JunLuoToolInvocation } from './toolCallProtocol';
import { resolveToolPermissionForCall } from './toolPermissions';
import { loadToolPermissionSettings } from './toolPermissionStore';
import { getToolDefinition, listToolPackages } from './toolRegistry';
import { createToolError } from './toolErrors';
import { createToolErrorResult, createToolSuccessResult } from './toolResult';
import { APP_LAUNCH_TOOL_ID, APP_LAUNCH_UNAVAILABLE, APP_LAUNCH_READ_FAILED, appLaunchEntryKey,
  resolveAppLaunchEntries, type AppLaunchOpportunity } from './chatAppLaunch';

export type AppLaunchPicker = (request: { entries: PhoneLaunchableAppEntry[]; ask: boolean }, signal: AbortSignal) => Promise<PhoneLaunchableAppEntry | null>;
export type AppLaunchChatHostInput = {
  sourceSessionId: string; sourceMessageId: string;
  sourceMessage?: Pick<SubjectiveMessage, 'id' | 'role' | 'content' | 'createdAt'>;
  dataEpoch: number; signal?: AbortSignal; isReplyCurrent?: () => Promise<boolean>; isChatForeground?: () => boolean;
  opportunity?: AppLaunchOpportunity; pick?: AppLaunchPicker;
};
export function createAppLaunchChatHost(input: AppLaunchChatHostInput, overrides: Partial<{
  isForeground: () => boolean;
  loadSource: typeof loadChatSessionMessage;
  isEpochCurrent: typeof canCommitBackupRestoreDataEpoch;
  listEntries: typeof readPhoneLaunchableAppEntries;
  launchEntry: typeof launchPhoneAppEntry;
  permissionAllowed: (asked: boolean, call: JunLuoToolCall) => Promise<boolean>;
}> = {}) {
  const ports = {
    isForeground: () => AppState.currentState === 'active',
    loadSource: loadChatSessionMessage, isEpochCurrent: canCommitBackupRestoreDataEpoch,
    listEntries: readPhoneLaunchableAppEntries, launchEntry: launchPhoneAppEntry,
    permissionAllowed: async (asked: boolean, call: JunLuoToolCall) => {
      await loadToolPermissionSettings({ strict: true });
      const tool = getToolDefinition(APP_LAUNCH_TOOL_ID);
      if (!tool || !listToolPackages().find(item => item.id === 'device')?.defaultEnabled) return false;
      const { permission } = await resolveToolPermissionForCall(tool, call);
      return permission === 'allow' || asked && permission === 'ask';
    }, ...overrides,
  };
  let appName: string | undefined;
  let selected: PhoneLaunchableAppEntry | undefined;
  let selectedCallId: string | undefined;
  let asked = false;
  let executed = false;
  let failure: JunLuoToolResult | undefined;
  const foreground = () => ports.isForeground() && input.isChatForeground?.() !== false;
  const failed = (call: JunLuoToolCall, summary = APP_LAUNCH_UNAVAILABLE, code: Parameters<typeof createToolError>[0] = 'EXECUTION_FAILED') =>
    createToolErrorResult(call, createToolError(code, code), summary);
  const sourceCurrent = async () => {
    try {
      if (input.signal?.aborted || !ports.isEpochCurrent(input.dataEpoch) || input.sourceSessionId !== PRIMARY_CHAT_SESSION_ID
        || input.sourceMessage?.id !== input.sourceMessageId || input.sourceMessage.role !== 'you'
        || input.isReplyCurrent && !await input.isReplyCurrent()) return false;
      const current = await ports.loadSource(input.sourceSessionId, input.sourceMessageId);
      return !!current && current.role === 'you' && current.content === input.sourceMessage.content && current.createdAt === input.sourceMessage.createdAt;
    } catch {
      return false;
    }
  };
  const available = () => !!input.opportunity && input.opportunity.sourceMessageId === input.sourceMessageId
    && input.opportunity.available() && !input.signal?.aborted && ports.isEpochCurrent(input.dataEpoch);
  return {
    available,
    isSourceCurrent: sourceCurrent,
    prepare: (invocation: JunLuoToolInvocation) => {
      const call = { ...invocation, requestedBy: 'chat' as const, createdAt: Date.now() };
      if (!available() || !input.opportunity!.consume()) return { kind: 'rejected' as const,
        result: failed(call, APP_LAUNCH_UNAVAILABLE, 'DUPLICATE_TOOL_CALL') };
      const keys = Object.keys(invocation.input);
      if (typeof invocation.input.appName !== 'string' || !invocation.input.appName.trim()
        || keys.some(key => key !== 'appName')) return { kind: 'rejected' as const,
        result: failed(call, APP_LAUNCH_UNAVAILABLE, 'INVALID_ARGUMENTS') };
      appName = invocation.input.appName;
      return { kind: 'ready' as const, input: { appName } };
    },
    select: async (call: JunLuoToolCall, signal: AbortSignal, requiresAsk: boolean): Promise<'allowed' | 'cancelled'> => {
      if (selectedCallId || !appName || call.input.appName !== appName) return 'cancelled';
      selectedCallId = call.callId;
      asked = requiresAsk;
      if (signal.aborted || !foreground() || !await sourceCurrent() || !await ports.permissionAllowed(asked, call)) {
        failure = failed(call); return 'cancelled';
      }
      const resolution = resolveAppLaunchEntries(appName, await ports.listEntries());
      if (resolution.kind !== 'selected' && resolution.kind !== 'choose') {
        failure = failed(call, resolution.kind === 'not_found' ? `没有找到可打开的应用：${appName}。`
          : resolution.kind === 'read_failed' ? APP_LAUNCH_READ_FAILED : APP_LAUNCH_UNAVAILABLE);
        return 'cancelled';
      }
      const entries = resolution.kind === 'choose' ? resolution.entries : [resolution.entry];
      if (resolution.kind === 'choose' || asked) {
        if (!input.pick) { failure = failed(call); return 'cancelled'; }
        const choice = await input.pick({ entries, ask: asked }, signal);
        if (!choice) return 'cancelled';
        selected = entries.find(entry => appLaunchEntryKey(entry) === appLaunchEntryKey(choice));
      } else selected = resolution.entry;
      if (!selected || signal.aborted || !foreground() || !await sourceCurrent() || !await ports.permissionAllowed(asked, call)) {
        failure = failed(call); selected = undefined; return 'cancelled';
      }
      return 'allowed';
    },
    failure: (callId: string) => failure ? { ...failure, callId } : undefined,
    execute: async (call: JunLuoToolCall, signal?: AbortSignal): Promise<JunLuoToolResult> => {
      if (failure) return { ...failure, callId: call.callId };
      if (executed || !selected || call.callId !== selectedCallId || call.input.appName !== appName) return failed(call);
      executed = true;
      if (signal?.aborted || !foreground() || !await sourceCurrent() || !await ports.permissionAllowed(asked, call)) return failed(call);
      // Permission reads can yield; recheck the real source, then the synchronous gates immediately before dispatch.
      if (!await sourceCurrent() || !foreground() || signal?.aborted || input.signal?.aborted || !ports.isEpochCurrent(input.dataEpoch)) return failed(call);
      const result = await ports.launchEntry(selected);
      // Do not require foreground here: a successful launch intentionally backgrounds JunLuo.
      let permissionCurrent = false;
      try { permissionCurrent = await ports.permissionAllowed(asked, call); } catch { /* A dispatched action cannot be replayed after a failed read. */ }
      if (!permissionCurrent || !await sourceCurrent() || signal?.aborted || result.reason === 'LAUNCH_OUTCOME_UNKNOWN') return failed(call, '', 'TOOL_OUTCOME_UNKNOWN');
      return result.launched ? createToolSuccessResult(call, `已发起打开：${selected.title}。`)
        : failed(call, !result.available ? APP_LAUNCH_UNAVAILABLE : `这次没能打开应用：${selected.title}。`);
    },
  };
}
