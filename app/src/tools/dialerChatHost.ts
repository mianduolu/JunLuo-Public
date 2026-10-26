import { AppState } from 'react-native';
import { loadChatSessionMessage } from '../chat/chatStorage';
import { PRIMARY_CHAT_SESSION_ID } from '../chat/primaryChat';
import { getChatDataRevision } from '../chat/chatDataChanges';
import { canCommitBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { isChatDialerNativeAvailable, requestDialerContactsPermission, queryPhoneDialerContacts,
  openPhoneDialer, type DialerContactEntry } from '../backend/dialerNative';
import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import type { JunLuoToolCall, JunLuoToolResult, JunLuoToolPermissionLevel } from './toolTypes';
import type { JunLuoToolInvocation } from './toolCallProtocol';
import { resolveToolPermissionForCall } from './toolPermissions';
import { loadToolPermissionSettings } from './toolPermissionStore';
import { getToolDefinition, listToolPackages } from './toolRegistry';
import { createToolError } from './toolErrors';
import { createToolErrorResult, createToolSuccessResult } from './toolResult';
import { DIALER_TOOL_ID, DIALER_OPEN_FAILED, DIALER_READ_FAILED, DIALER_PERMISSION_MISSING,
  parseDialerTarget, resolveDialerContacts, dialerEntryKey, dialerPermissionCall, type DialerOpportunity } from './chatDialer';

export type DialerPicker = (request: { entries: DialerContactEntry[]; ask: boolean }, signal: AbortSignal) => Promise<DialerContactEntry | null>;
type Input = {
  sourceSessionId: string; sourceMessageId: string;
  sourceMessage?: Pick<SubjectiveMessage, 'id' | 'role' | 'content' | 'createdAt'>;
  dataEpoch: number; signal?: AbortSignal; isReplyCurrent?: () => Promise<boolean>; isReplyActive?: () => boolean; isChatForeground?: () => boolean;
  opportunity?: DialerOpportunity; pick?: DialerPicker;
};
export function createDialerChatHost(input: Input, overrides: Partial<{
  isForeground: () => boolean; loadSource: typeof loadChatSessionMessage;
  isEpochCurrent: typeof canCommitBackupRestoreDataEpoch;
  chatRevision: typeof getChatDataRevision;
  nativeAvailable: typeof isChatDialerNativeAvailable;
  requestContactPermission: typeof requestDialerContactsPermission;
  queryContacts: typeof queryPhoneDialerContacts; openDialer: typeof openPhoneDialer;
  resolvePermission: (call: JunLuoToolCall) => Promise<JunLuoToolPermissionLevel>;
}> = {}) {
  const ports = {
    isForeground: () => AppState.currentState === 'active', loadSource: loadChatSessionMessage,
    isEpochCurrent: canCommitBackupRestoreDataEpoch, nativeAvailable: isChatDialerNativeAvailable,
    chatRevision: getChatDataRevision,
    requestContactPermission: requestDialerContactsPermission, queryContacts: queryPhoneDialerContacts,
    openDialer: openPhoneDialer,
    resolvePermission: async (call: JunLuoToolCall): Promise<JunLuoToolPermissionLevel> => {
      await loadToolPermissionSettings({ strict: true });
      const tool = getToolDefinition(DIALER_TOOL_ID);
      if (!tool || !listToolPackages().find(item => item.id === 'communication')?.defaultEnabled) return 'deny';
      return (await resolveToolPermissionForCall(tool, call)).permission;
    }, ...overrides,
  };
  let target: string | undefined;
  let selected: DialerContactEntry | undefined;
  let selectedCallId: string | undefined;
  let asked = false; let executed = false; let contact = false; let selectedAllowed = false;
  let failure: JunLuoToolResult | undefined;
  const failed = (call: JunLuoToolCall, summary = DIALER_OPEN_FAILED,
    code: Parameters<typeof createToolError>[0] = 'EXECUTION_FAILED') => createToolErrorResult(call, createToolError(code, code), summary);
  const foreground = () => ports.isForeground() && input.isChatForeground?.() !== false;
  const sourceCurrent = async () => {
    try {
      if (input.signal?.aborted || input.isReplyActive?.() === false || !ports.isEpochCurrent(input.dataEpoch) || input.sourceSessionId !== PRIMARY_CHAT_SESSION_ID
        || input.sourceMessage?.id !== input.sourceMessageId || input.sourceMessage.role !== 'you'
        || input.isReplyCurrent && !await input.isReplyCurrent()) return false;
      const current = await ports.loadSource(input.sourceSessionId, input.sourceMessageId);
      if (input.isReplyCurrent && !await input.isReplyCurrent()) return false;
      return !input.signal?.aborted && input.isReplyActive?.() !== false && ports.isEpochCurrent(input.dataEpoch) && !!current && current.role === 'you'
        && current.content === input.sourceMessage.content && current.createdAt === input.sourceMessage.createdAt;
    } catch { return false; }
  };
  const available = () => !!input.opportunity && input.opportunity.sourceMessageId === input.sourceMessageId
    && input.opportunity.available() && !input.signal?.aborted && ports.isEpochCurrent(input.dataEpoch);
  const permission = (call: JunLuoToolCall) => ports.resolvePermission(dialerPermissionCall(call, selected?.phoneNumber));
  const valid = async (signal?: AbortSignal, afterDispatch = false) => !signal?.aborted
    && (afterDispatch || foreground()) && await sourceCurrent() && !signal?.aborted && (afterDispatch || foreground());
  return {
    available, isSourceCurrent: sourceCurrent,
    prepare: (invocation: JunLuoToolInvocation) => {
      const call = { ...invocation, requestedBy: 'chat' as const, createdAt: Date.now() };
      if (!available() || !input.opportunity!.consume()) return { kind: 'rejected' as const,
        result: failed(call, '', 'DUPLICATE_TOOL_CALL') };
      if (Object.keys(invocation.input).some(key => key !== 'target') || parseDialerTarget(invocation.input.target).kind === 'invalid')
        return { kind: 'rejected' as const, result: failed(call, '', 'INVALID_ARGUMENTS') };
      target = (invocation.input.target as string).trim();
      return { kind: 'ready' as const, input: { target } };
    },
    select: async (call: JunLuoToolCall, signal: AbortSignal, _requiresAsk: boolean): Promise<'allowed' | 'cancelled'> => {
      if (selectedCallId || !target || call.input.target !== target) return 'cancelled';
      selectedCallId = call.callId;
      try {
        if (!await valid(signal)) { failure = failed(call, '', 'CANCELLED_BY_YOU'); return 'cancelled'; }
        if (await permission(call) === 'deny') { failure = failed(call, '', 'PERMISSION_DENIED'); return 'cancelled'; }
        if (!ports.nativeAvailable()) { failure = failed(call); return 'cancelled'; }
        const parsed = parseDialerTarget(target);
        let entries: DialerContactEntry[]; let choose = false;
        if (parsed.kind === 'number') entries = [{ contactId: '', phoneRowId: '', displayName: parsed.phoneNumber, phoneNumber: parsed.phoneNumber }];
        else if (parsed.kind === 'contact') {
          contact = true;
          if (!await valid(signal)) { failure = failed(call, '', 'CANCELLED_BY_YOU'); return 'cancelled'; }
          if (!await ports.requestContactPermission()) { failure = failed(call, DIALER_PERMISSION_MISSING); return 'cancelled'; }
          if (!await valid(signal)) { failure = failed(call, '', 'CANCELLED_BY_YOU'); return 'cancelled'; }
          if (await permission(call) === 'deny') { failure = failed(call, '', 'PERMISSION_DENIED'); return 'cancelled'; }
          if (!await valid(signal)) { failure = failed(call, '', 'CANCELLED_BY_YOU'); return 'cancelled'; }
          const resolution = resolveDialerContacts(parsed.name, await ports.queryContacts(parsed.name));
          if (resolution.kind !== 'selected' && resolution.kind !== 'choose') {
            failure = failed(call, resolution.kind === 'not_found' ? '没有找到对应联系人。'
              : resolution.kind === 'read_failed' ? DIALER_READ_FAILED
              : resolution.kind === 'permission_missing' ? DIALER_PERMISSION_MISSING : DIALER_OPEN_FAILED);
            return 'cancelled';
          }
          entries = resolution.kind === 'choose' ? resolution.entries : [resolution.entry];
          choose = resolution.kind === 'choose';
        } else { failure = failed(call, '', 'INVALID_ARGUMENTS'); return 'cancelled'; }
        // Only the actual number may qualify for old number-scoped grants.
        if (!choose) selected = entries[0];
        const level = await permission(call);
        if (level === 'deny') { failure = failed(call, '', 'PERMISSION_DENIED'); return 'cancelled'; }
        asked = level === 'ask';
        if (!await valid(signal)) { failure = failed(call, '', 'CANCELLED_BY_YOU'); return 'cancelled'; }
        if (choose || asked) {
          if (!input.pick) { failure = failed(call); return 'cancelled'; }
          const choice = await input.pick({ entries, ask: asked }, signal);
          if (!choice) return 'cancelled';
          selected = entries.find(entry => dialerEntryKey(entry) === dialerEntryKey(choice)
            && entry.phoneNumber === choice.phoneNumber && entry.displayName === choice.displayName);
          if (!selected) { failure = failed(call); return 'cancelled'; }
          // Selection itself confirms this opening, including a selected number's ask rule.
          asked = true;
        }
        const finalLevel = await permission(call);
        if (finalLevel === 'deny' || finalLevel === 'ask' && !asked) { failure = failed(call, '', 'PERMISSION_DENIED'); return 'cancelled'; }
        if (!await valid(signal)) { failure = failed(call, '', 'CANCELLED_BY_YOU'); return 'cancelled'; }
        selectedAllowed = true;
        return 'allowed';
      } catch { failure = failed(call, contact ? DIALER_READ_FAILED : DIALER_OPEN_FAILED); return 'cancelled'; }
    },
    failure: (callId: string) => failure ? { ...failure, callId } : undefined,
    execute: async (call: JunLuoToolCall, signal?: AbortSignal): Promise<JunLuoToolResult> => {
      if (failure) return { ...failure, callId: call.callId };
      if (executed || !selectedAllowed || !selected || call.callId !== selectedCallId || call.input.target !== target) return failed(call, '', 'DUPLICATE_TOOL_CALL');
      executed = true;
      try {
        const revision = ports.chatRevision();
        if (!await valid(signal)) return failed(call, '', 'CANCELLED_BY_YOU');
        // Resolve permissions last; use the existing synchronous chat revision to
        // reject a source write during that final read without another async gap.
        const level = await permission(call);
        if (level === 'deny' || level === 'ask' && !asked) return failed(call, '', 'PERMISSION_DENIED');
        if (ports.chatRevision() !== revision || input.isReplyActive?.() === false || !foreground() || signal?.aborted || input.signal?.aborted
          || !ports.isEpochCurrent(input.dataEpoch)) return failed(call, '', 'CANCELLED_BY_YOU');
        const result = await ports.openDialer(selected.phoneNumber, contact ? selected : undefined);
        let permissionCurrent = false;
        try { const currentLevel = await permission(call); permissionCurrent = currentLevel === 'allow' || currentLevel === 'ask' && asked; } catch { /* dispatched actions are never replayed */ }
        if (!permissionCurrent || !await valid(signal, true) || result.reason === 'DIAL_OUTCOME_UNKNOWN') return failed(call, '', 'TOOL_OUTCOME_UNKNOWN');
        if (result.opened) return createToolSuccessResult(call, `已发起打开拨号页：${selected.displayName}。`);
        return failed(call, result.reason === 'CONTACT_PERMISSION_MISSING' ? DIALER_PERMISSION_MISSING
          : result.reason === 'CONTACT_READ_FAILED' ? DIALER_READ_FAILED : DIALER_OPEN_FAILED);
      } catch { return failed(call, '', 'TOOL_OUTCOME_UNKNOWN'); }
    },
  };
}
