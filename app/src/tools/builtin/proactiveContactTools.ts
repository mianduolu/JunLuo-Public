import type { JunLuoToolDefinition, JunLuoToolPackage } from '../toolTypes';
import { createToolErrorResult } from '../toolResult';
import { createToolError } from '../toolErrors';

const tools: JunLuoToolDefinition[] = [
  { id: 'get_status', name: '查看主动联系状态', description: '查看主动联系是否暂停，以及暂停的结束时间。',
    chatExposure: 'candidate' as const, proactiveEligible: false },
  { id: 'pause', name: '暂停主动联系', description: 'you 希望暂时不收到主动消息时使用。暂停期间不主动发送消息；you 发来新消息时提前解除暂停。',
    chatExposure: 'candidate' as const, proactiveEligible: false },
  { id: 'resume', name: '恢复主动联系', description: '解除主动联系的暂停。恢复后沿用原有主动联系条件，不立即发送消息。',
    chatExposure: 'candidate' as const, proactiveEligible: false },
].map((tool): JunLuoToolDefinition => ({
  ...tool, id: `proactive_contact.${tool.id}`, packageId: 'proactive_contact',
  inputSchema: { type: 'object', additionalProperties: false, properties: tool.id === 'pause' ? {
    durationMinutes: { type: 'number', description: '暂停的分钟数，填写正数；从本轮 you 消息的发送时间开始计算。不填则持续到 you 发来新消息或主动联系被恢复。到期只解除暂停，不触发发送。' },
  } : {} },
  permission: 'allow', riskLevel: tool.id === 'get_status' ? 'read' : 'write_local',
  readOnly: tool.id === 'get_status',
  executionScope: 'local_device', agentEpochMode: 'bounded_local_commits',
  conflictGroup: 'proactive_contact',
  executor: (call, context) => context?.proactiveContact ? context.proactiveContact(call)
    : createToolErrorResult(call, createToolError('PERMISSION_DENIED', 'contact-chat-host-required')),
}));

export const proactiveContactToolPackage: JunLuoToolPackage = {
  id: 'proactive_contact', name: '主动联系管理', description: '主动联系管理', category: 'life',
  tools, defaultEnabled: true, riskLevel: 'write_local', source: 'builtin',
};
