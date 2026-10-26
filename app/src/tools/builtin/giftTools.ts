import type { JunLuoToolDefinition, JunLuoToolPackage } from '../toolTypes';
import { createToolError } from '../toolErrors';
import { createToolErrorResult } from '../toolResult';
import { GIFT_PACKAGE_DESCRIPTION, GIFT_TOOL_DEFINITIONS } from '../../gifts/giftToolContract';

const tools = GIFT_TOOL_DEFINITIONS.map((definition): JunLuoToolDefinition => ({
  ...definition, packageId: 'gift', chatExposure: 'candidate', proactiveEligible: true,
  permission: 'allow', riskLevel: definition.id === 'gift.view' ? 'read' : 'write_local', readOnly: definition.id === 'gift.view',
  executionScope: 'local_device', agentEpochMode: 'bounded_local_commits', conflictGroup: 'gift',
  executor: (call, context) => ['chat', 'proactive', 'life_agent'].includes(call.requestedBy) && context?.giftCabinet
    ? context.giftCabinet(call)
    : createToolErrorResult(call, createToolError('PERMISSION_DENIED', 'gift-host-required'), ''),
}));

export const giftToolPackage: JunLuoToolPackage = { id: 'gift', name: '礼物柜', description: GIFT_PACKAGE_DESCRIPTION,
  category: 'life', defaultEnabled: true, source: 'builtin', riskLevel: 'write_local', tools };
