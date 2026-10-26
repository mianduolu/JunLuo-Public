import type {
  JunLuoRegisteredToolDefinition,
  JunLuoToolDefinition,
  JunLuoToolPackage,
} from './toolTypes';
import { isPhoneLimitToolId, PHONE_LIMIT_PACKAGE_ID } from './phoneLimitContract';
import { isGiftToolId } from '../gifts/giftToolContract';

function defaultBuiltinConflictGroup(tool: JunLuoToolDefinition) {
  if (tool.packageId === 'device') return 'device-control';
  if (tool.packageId === 'browser') return 'browser-session';
  if (tool.packageId === 'music') return 'music-player';
  return tool.readOnly ? undefined : `${tool.packageId}-write`;
}

export function normalizeToolChatPolicy(
  tool: JunLuoToolDefinition,
  source: JunLuoToolPackage['source'],
): JunLuoRegisteredToolDefinition {
  if (
    source === 'builtin'
    && (tool.chatExposure === undefined || tool.proactiveEligible === undefined)
  ) {
    throw new Error(`内置工具 ${tool.id} 必须显式声明聊天暴露和主动性`);
  }
  return {
    ...tool,
    chatExposure: tool.chatExposure ?? 'internal_only',
    proactiveEligible: tool.proactiveEligible ?? false,
    conflictGroup: tool.conflictGroup ?? (
      source === 'builtin' ? defaultBuiltinConflictGroup(tool) : undefined
    ),
  };
}

export function validateToolChatPolicy(tool: JunLuoRegisteredToolDefinition) {
  if (tool.chatExposure === 'internal_only' || tool.chatExposure === 'disabled') {
    if (tool.proactiveEligible) {
      throw new Error(`工具 ${tool.id} 不可同时设为 ${tool.chatExposure} 和主动候选`);
    }
  }
  if (tool.proactiveEligible && !tool.readOnly
    && !['music.play', 'wish.propose', 'wish.pull', 'wish.invite_discussion'].includes(tool.id)
    && !(tool.packageId === 'gift' && isGiftToolId(tool.id))
    && !(tool.packageId === PHONE_LIMIT_PACKAGE_ID && isPhoneLimitToolId(tool.id))) {
    throw new Error(`非只读工具 ${tool.id} 不可设为主动候选`);
  }
  if (tool.proactiveEligible && tool.riskLevel === 'dangerous') {
    throw new Error(`危险工具 ${tool.id} 不可设为主动候选`);
  }
}
