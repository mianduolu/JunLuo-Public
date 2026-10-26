import type { JunLuoToolDefinition, JunLuoToolInputSchema } from '../tools/toolTypes';
import { parseOpenAiToolCalls, type OpenAiCompatibleToolCallMessage } from '../tools/toolCallProtocol';
import { isWishToolId } from './wishToolContract';

// A transport-only entry. Execution, permissions and receipts retain the four real tool IDs.
export const WISH_PACKAGE_ENTRY_ID = 'wish.use';
const actions = ['propose', 'view', 'pull', 'invite_discussion'] as const;
const purposes = ['cast_coin', 'revise', 'progress', 'complete', 'release'];
const fields: Record<typeof actions[number], readonly string[]> = {
  propose: ['content'], view: ['query'], pull: ['wishId'], invite_discussion: ['wishId', 'purpose'],
};
const properties: Record<string, JunLuoToolInputSchema> = {
  action: { type: 'string', description: 'I 这次想做什么：propose 写下愿望；view 查看愿望；pull 捞取愿望；invite_discussion 邀请商量。', enum: [...actions] },
  content: { type: 'string', description: '写下时填愿望正文。' },
  query: { type: 'string', description: '查看时填愿望 ID 或线索。' },
  wishId: { type: 'string', description: '愿望 ID；邀请时必填，捞取时不填则随机。' },
  purpose: { type: 'string', description: '邀请时填：cast_coin 投币；revise 修改；progress 进展；complete 完成；release 放下。', enum: purposes },
};

export function projectWishPackageTools(tools: JunLuoToolDefinition[]): JunLuoToolDefinition[] {
  const available = actions.filter(action => tools.some(tool => tool.id === `wish.${action}`));
  if (!available.length) return tools;
  const needed = new Set(['action', ...available.flatMap(action => fields[action])]);
  const entry: JunLuoToolDefinition = {
    id: WISH_PACKAGE_ENTRY_ID, packageId: 'wish', name: '许愿池',
    description: '这里收着 I 和 you 的愿望。I 想写下、查看、捞起或商量一颗愿望时，就来这里。写下后先商量再投币；捞的是 you 的愿望；邀请等 you 点开再聊。',
    inputSchema: { type: 'object', additionalProperties: false, required: ['action'], properties: Object.fromEntries(
      Object.entries(properties).filter(([key]) => needed.has(key)).map(([key, value]) => [key,
        key === 'action' ? { ...value, enum: available } : value]),
    ) },
    permission: 'allow', riskLevel: available.every(action => action === 'view') ? 'read' : 'write_local',
    readOnly: available.every(action => action === 'view'),
  };
  let inserted = false;
  return tools.flatMap(tool => {
    if (!isWishToolId(tool.id)) return [tool];
    if (inserted) return [];
    inserted = true;
    return [entry];
  });
}

export function parseWishPackageToolCalls(message: OpenAiCompatibleToolCallMessage | undefined, tools: JunLuoToolDefinition[]) {
  const parsed = parseOpenAiToolCalls(message, projectWishPackageTools(tools));
  parsed.invocations = parsed.invocations.flatMap(invocation => {
    if (invocation.toolId !== WISH_PACKAGE_ENTRY_ID) return [invocation];
    const { action, ...input } = invocation.input;
    const actionKey = actions.find(value => value === action);
    const toolId = actionKey ? `wish.${actionKey}` : WISH_PACKAGE_ENTRY_ID;
    // Parse raw input as well: null is allowed only for optional schema fields, never for unknown keys.
    const raw = JSON.parse(invocation.rawArguments!) as Record<string, unknown>;
    const valid = actionKey && tools.some(tool => tool.id === toolId)
      && Object.keys(raw).every(key => key === 'action' || Object.hasOwn(properties, key)
        && (fields[actionKey].includes(key) || raw[key] === null))
      && Object.keys(input).every(key => fields[actionKey].includes(key))
      && Object.values(input).every(value => typeof value === 'string' && value.trim().length > 0)
      && (actionKey === 'pull' || fields[actionKey].every(key => typeof input[key] === 'string'))
      && (actionKey !== 'invite_discussion' || purposes.includes(input.purpose as string));
    if (!valid) {
      parsed.errors.push({ code: 'INVALID_ARGUMENTS_SHAPE', callId: invocation.callId, toolId,
        rawName: invocation.rawName, rawArguments: invocation.rawArguments, message: 'INVALID_WISH_ARGUMENTS' });
      return [];
    }
    return [{ ...invocation, toolId, input }];
  });
  return parsed;
}
