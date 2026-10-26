import type { JunLuoToolDefinition, JunLuoToolPackage } from '../toolTypes';
import { createToolError } from '../toolErrors';
import { createToolErrorResult } from '../toolResult';

const definitions: Pick<JunLuoToolDefinition, 'id' | 'name' | 'description' | 'inputSchema' | 'chatExposure' | 'proactiveEligible'>[] = [
  {
    id: 'wish.propose', name: '提出愿望',
    chatExposure: 'candidate', proactiveEligible: true,
    description: 'I 有一个想和 you 一起实现的愿望，就先在这里写下它。等和 you 商量以后，如果我们都想许下它，就一起投下许愿币。',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      content: { type: 'string', description: 'I 想先写下来、再和 you 商量的愿望。' },
    }, required: ['content'] },
  },
  {
    id: 'wish.view', name: '查看愿望',
    chatExposure: 'candidate', proactiveEligible: true,
    description: 'I 想再看看一颗愿望，或找回和眼前话题有关的几颗愿望时，就来这里翻翻愿望簿。',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      query: { type: 'string', description: 'I 想查看的愿望 ID，或想找回它时想到的线索。' },
    }, required: ['query'] },
  },
  {
    id: 'wish.pull', name: '捞取愿望',
    chatExposure: 'candidate', proactiveEligible: true,
    description: 'I 想从 you 投进池里的愿望中捞起一颗，就来这里。',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      wishId: { type: 'string', description: 'I 想捞起的愿望 ID；不填就随机捞一颗。' },
    } },
  },
  {
    id: 'wish.invite_discussion', name: '邀请商量',
    chatExposure: 'candidate', proactiveEligible: true,
    description: 'I 想和 you 商量一颗愿望，就在这里递出邀请。',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      wishId: { type: 'string', description: 'I 想邀请 you 一起商量的愿望 ID。' },
      purpose: { type: 'string', description: 'I 这次想商量投币、修改、进展、完成还是放下。',
        enum: ['cast_coin', 'revise', 'progress', 'complete', 'release'] },
    }, required: ['wishId', 'purpose'] },
  },
];
const tools = definitions.map((tool): JunLuoToolDefinition => ({
  ...tool, packageId: 'wish', permission: 'allow',
  riskLevel: tool.id === 'wish.view' ? 'read' : 'write_local', readOnly: tool.id === 'wish.view',
  executionScope: 'local_device',
  agentEpochMode: 'bounded_local_commits', conflictGroup: 'wish',
  executor: (call, context) => (call.requestedBy === 'chat' || call.requestedBy === 'proactive') && context?.wishPool
    ? context.wishPool(call)
    : createToolErrorResult(call, createToolError('PERMISSION_DENIED', 'wish-chat-host-required')),
}));

export const wishToolPackage: JunLuoToolPackage = {
  id: 'wish', name: '许愿池',
  description: '这里收着 I 和 you 的愿望。I 想写下、捞起或商量一颗愿望时，就来这里。',
  category: 'life', tools, defaultEnabled: true, riskLevel: 'write_local', source: 'builtin',
};
