import { promptForToolPermission, type JunLuoToolPermissionPrompt } from './toolPermissionPrompt';
import {
  listSessionToolPermissionGrants,
  loadToolPermissionSettings,
  hasStoredToolPermissionSettings,
  matchesToolPermissionInputRules,
} from './toolPermissionStore';
import type { JunLuoToolPermissionAuthorizationSource } from './toolAuditTypes';
import type {
  JunLuoToolCall,
  JunLuoToolDefinition,
  JunLuoToolPermissionLevel,
  JunLuoToolRiskLevel,
} from './toolTypes';
import { loadChatPreferences } from '../chat/chatPreferences';
import { isExpenseChatTool } from './expenseChatTools';
import { isReminderChatTool } from './chatReminderTools';
import { DIALER_TOOL_ID, dialerPermissionCall } from './chatDialer';
import { BACKEND_OVERVIEW_TOOL_ID, backendOverviewPermissionCall } from './chatBackendOverview';
import { isGiftToolId } from '../gifts/giftToolContract';

const MUSIC_PREFERENCE_AUTHORIZED_TOOL_IDS = new Set([
  'music.search_candidates',
  'music.play',
  'music.control',
]);

export type JunLuoToolPermissionDecisionResult = {
  decision: 'allowed' | 'denied' | 'cancelled';
  permission: JunLuoToolPermissionLevel;
  reason: string;
  source: JunLuoToolPermissionAuthorizationSource;
  grantId?: string;
  expiresAt?: number;
  silent: boolean;
};

export type JunLuoToolPermissionCheckOptions = {
  prompt?: JunLuoToolPermissionPrompt;
};

export type JunLuoToolPermissionResolution = {
  permission: JunLuoToolPermissionLevel;
  source: JunLuoToolPermissionDecisionResult['source'];
  grantId?: string;
  expiresAt?: number;
  silent: boolean;
};

export type JunLuoToolPermissionPreauthorizationReceipt = {
  callId: string;
  toolId: string;
  inputHash: string;
  decision: 'allowed';
  source: JunLuoToolPermissionDecisionResult['source'];
  grantId?: string;
  expiresAt?: number;
  silent: boolean;
  issuedAt: number;
};

export function getDefaultPermissionForRisk(riskLevel: JunLuoToolRiskLevel): JunLuoToolPermissionLevel {
  if (riskLevel === 'read') return 'allow';
  if (riskLevel === 'dangerous') return 'deny';
  return 'ask';
}

async function resolvePermission(tool: JunLuoToolDefinition): Promise<{
  permission: JunLuoToolPermissionLevel;
  source: JunLuoToolPermissionDecisionResult['source'];
  grantId?: string;
  expiresAt?: number;
  silent: boolean;
}> {
  return resolveToolPermissionForCall(tool, { input: {} });
}

export async function resolveToolPermissionForCall(
  tool: JunLuoToolDefinition,
  call: Pick<JunLuoToolCall, 'input'> & Partial<Pick<JunLuoToolCall, 'requestedBy'>>,
  readSettings?: () => Promise<string | null>,
): Promise<JunLuoToolPermissionResolution> {
  if (tool.id === DIALER_TOOL_ID) call = dialerPermissionCall(call);
  const backendOverviewChat = tool.id === BACKEND_OVERVIEW_TOOL_ID && call.requestedBy === 'chat';
  if (backendOverviewChat) call = backendOverviewPermissionCall(call);
  const riskDefault = getDefaultPermissionForRisk(tool.riskLevel);
  try {
    const settings = await loadToolPermissionSettings(backendOverviewChat || isExpenseChatTool(tool.id) || isReminderChatTool(tool.id) || tool.packageId === 'phone_limit' || tool.id === DIALER_TOOL_ID ? { strict: true } : undefined, readSettings);
    const toolOverride = settings.toolOverrides[tool.id];
    if (toolOverride) return { permission: toolOverride, source: 'tool_override', silent: true };
    const sessionToolGrant = listSessionToolPermissionGrants().find((grant) =>
      grant.scope === 'tool' &&
      grant.targetId === tool.id &&
      matchesToolPermissionInputRules(call.input, grant.inputRules)
    );
    if (sessionToolGrant) {
      return {
        permission: sessionToolGrant.permission,
        source: 'session_grant',
        grantId: sessionToolGrant.id,
        expiresAt: sessionToolGrant.expiresAt,
        silent: true,
      };
    }
    const todayToolGrant = settings.temporaryGrants.find((grant) =>
      grant.duration === 'today' &&
      grant.scope === 'tool' &&
      grant.targetId === tool.id &&
      matchesToolPermissionInputRules(call.input, grant.inputRules)
    );
    if (todayToolGrant) {
      return {
        permission: todayToolGrant.permission,
        source: 'today_grant',
        grantId: todayToolGrant.id,
        expiresAt: todayToolGrant.expiresAt,
        silent: true,
      };
    }
    const parameterGrant = settings.parameterGrants.find((grant) =>
      grant.toolId === tool.id &&
      matchesToolPermissionInputRules(call.input, grant.inputRules)
    );
    if (parameterGrant) {
      return {
        permission: parameterGrant.permission,
        source: 'parameter_grant',
        grantId: parameterGrant.id,
        expiresAt: parameterGrant.expiresAt,
        silent: true,
      };
    }
    const packageOverride = settings.packageOverrides[tool.packageId];
    if (packageOverride) return { permission: packageOverride, source: 'package_override', silent: true };
    const sessionPackageGrant = listSessionToolPermissionGrants().find((grant) =>
      grant.scope === 'package' &&
      grant.targetId === tool.packageId
    );
    if (sessionPackageGrant) {
      return {
        permission: sessionPackageGrant.permission,
        source: 'session_grant',
        grantId: sessionPackageGrant.id,
        expiresAt: sessionPackageGrant.expiresAt,
        silent: true,
      };
    }
    const todayPackageGrant = settings.temporaryGrants.find((grant) =>
      grant.duration === 'today' &&
      grant.scope === 'package' &&
      grant.targetId === tool.packageId
    );
    if (todayPackageGrant) {
      return {
        permission: todayPackageGrant.permission,
        source: 'today_grant',
        grantId: todayPackageGrant.id,
        expiresAt: todayPackageGrant.expiresAt,
        silent: true,
      };
    }
    if (MUSIC_PREFERENCE_AUTHORIZED_TOOL_IDS.has(tool.id)) {
      const preferences = await loadChatPreferences();
      if (preferences.musicEnabled) {
        return {
          permission: 'allow',
          source: 'music_preference',
          silent: true,
        };
      }
    }
    // Camera is internal-only and requires the current standby host to execute.
    // That explicit standby replaces the generic default prompt, never an explicit deny/override.
    if (tool.id === 'camera.look_once' && settings.globalDefault !== 'deny') {
      return { permission: tool.permission ?? riskDefault, source: 'tool_definition', silent: true };
    }
    if (tool.packageId === 'proactive_contact' && !await hasStoredToolPermissionSettings(readSettings)) {
      return { permission: tool.permission, source: 'tool_definition', silent: true };
    }
    // Chapter 7 authorizes I's candidates/pulls/invitations, never a final shared decision.
    // Explicit tool/package choices above and a global deny still take precedence.
    if (tool.packageId === 'wish' && settings.globalDefault !== 'deny') {
      return { permission: tool.permission, source: 'tool_definition', silent: true };
    }
    if (tool.packageId === 'gift' && isGiftToolId(tool.id) && settings.globalDefault !== 'deny') {
      return { permission: tool.permission, source: 'tool_definition', silent: true };
    }
    if (tool.id === 'image.describe_local' && typeof call.input.image === 'number' && !await hasStoredToolPermissionSettings(readSettings)) {
      return { permission: 'allow', source: 'tool_definition', silent: true };
    }
    if (['files.pick_document', 'files.write_text'].includes(tool.id) && !await hasStoredToolPermissionSettings(readSettings)) {
      return { permission: tool.permission, source: 'tool_definition', silent: true };
    }
    if ((isExpenseChatTool(tool.id) || isReminderChatTool(tool.id)) && !await hasStoredToolPermissionSettings(readSettings)) {
      return { permission: tool.permission, source: 'tool_definition', silent: true };
    }
    if (call.requestedBy === 'chat' && ['schedule.complete_occurrence', 'todo.complete'].includes(tool.id)
      && !await hasStoredToolPermissionSettings(readSettings)) return { permission: 'allow', source: 'tool_definition', silent: true };
    // The phone executor rechecks the actual saved I scope; explicit overrides
    // above and a global deny retain precedence over that standing authorization.
    if (tool.packageId === 'phone_limit' && settings.globalDefault !== 'deny') {
      return { permission: tool.permission, source: 'tool_definition', silent: true };
    }
    if (settings.globalDefault) return { permission: settings.globalDefault, source: 'global_default', silent: true };
  } catch {
    if (backendOverviewChat || tool.id === DIALER_TOOL_ID || tool.packageId === 'phone_limit' || ['files.pick_document', 'files.write_text', 'image.describe_local'].includes(tool.id) || isExpenseChatTool(tool.id) || isReminderChatTool(tool.id)) {
      return { permission: 'deny', source: 'tool_definition', silent: true };
    }
    // Broken permission storage should fall back to static tool metadata.
  }
  if (tool.permission) return { permission: tool.permission, source: 'tool_definition', silent: true };
  return { permission: riskDefault, source: 'risk_default', silent: true };
}

export async function checkToolPermission(
  tool: JunLuoToolDefinition,
  call: JunLuoToolCall,
  options: JunLuoToolPermissionCheckOptions = {},
): Promise<JunLuoToolPermissionDecisionResult> {
  const resolved = await resolveToolPermissionForCall(tool, call);
  if (resolved.permission === 'allow') {
    return {
      decision: 'allowed',
      permission: resolved.permission,
      reason: '工具权限允许执行',
      source: resolved.source,
      grantId: resolved.grantId,
      expiresAt: resolved.expiresAt,
      silent: resolved.silent,
    };
  }
  if (resolved.permission === 'deny') {
    return {
      decision: 'denied',
      permission: resolved.permission,
      reason: '工具权限已拒绝执行',
      source: resolved.source,
      grantId: resolved.grantId,
      expiresAt: resolved.expiresAt,
      silent: resolved.silent,
    };
  }

  try {
    const promptDecision = await (options.prompt ?? promptForToolPermission)(tool, call);
    if (promptDecision === 'allowed') {
      return {
        decision: 'allowed',
        permission: 'ask',
        reason: '用户允许本次工具执行',
        source: 'prompt',
        silent: false,
      };
    }
    return {
      decision: 'cancelled',
      permission: 'ask',
      reason: '用户取消本次工具执行',
      source: 'prompt',
      silent: false,
    };
  } catch (error) {
    return {
      decision: 'denied',
      permission: 'ask',
      reason: error instanceof Error ? error.message : '权限确认失败',
      source: 'prompt',
      silent: false,
    };
  }
}
