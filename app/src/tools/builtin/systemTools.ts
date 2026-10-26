import { createToolError } from '../toolErrors';
import { createToolErrorResult, createToolSuccessResult } from '../toolResult';
import { listToolPackages, listTools } from '../toolRegistry';
import type {
  JunLuoToolCall,
  JunLuoToolDefinition,
  JunLuoToolInputSchema,
  JunLuoToolPackage,
  JunLuoToolResult,
} from '../toolTypes';
import { readOptionalStringInput, readStringInput, validationFailed } from './builtinToolValidation';

type SafeToolSchema = JunLuoToolInputSchema;

export type JunLuoUsePackageToolSummary = {
  id: string;
  name: string;
  description: string;
  inputSchema: SafeToolSchema & { type: 'object' };
  permission: JunLuoToolDefinition['permission'];
  readOnly: boolean;
  riskLevel: JunLuoToolDefinition['riskLevel'];
};

export type JunLuoUsePackageData = {
  defaultEnabled: boolean;
  package: {
    category: string;
    description: string;
    id: string;
    name: string;
    riskLevel: JunLuoToolPackage['riskLevel'];
    source: JunLuoToolPackage['source'];
  };
  permissionSummary: string;
  reason?: string;
  usageGuidance: string[];
  tools: JunLuoUsePackageToolSummary[];
};

function cloneInputSchema(schema: JunLuoToolInputSchema): JunLuoToolInputSchema {
  return {
    ...schema,
    items: schema.items ? cloneInputSchema(schema.items) : undefined,
    properties: schema.properties
      ? Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [key, cloneInputSchema(value)]))
      : undefined,
  };
}

function summarizePermission(tools: JunLuoToolDefinition[]) {
  const counts = tools.reduce<Record<string, number>>((summary, tool) => {
    const key = `${tool.permission}/${tool.riskLevel}`;
    summary[key] = (summary[key] ?? 0) + 1;
    return summary;
  }, {});
  return Object.entries(counts)
    .map(([key, count]) => `${key} ${count} 个`)
    .join('；');
}

function buildUsageGuidance(toolPackage: JunLuoToolPackage, tools: JunLuoToolDefinition[]) {
  const guidance = [
    '包已激活只表示本轮可以理解这些工具的用途，不表示任何工具已经执行。',
    '只有具体工具返回 ok=true，才能声明对应动作已经完成。',
  ];
  if (tools.some((tool) => !tool.readOnly)) {
    guidance.push('本包包含写入或操作类工具，执行前必须遵守工具权限结果。');
  }
  if (toolPackage.id === 'music') {
    guidance.push('music.search_candidates 只表示找到候选；只有 music.play 成功才表示已经播放。');
  }
  if (toolPackage.id === 'research') {
    guidance.push('research 工具没有成功结果时，不得说查到了、资料显示或来源说。');
  }
  if (toolPackage.id === 'device') {
    guidance.push('device 工具没有成功结果时，不得说已经读取、点击、滑动、返回或打开。');
  }
  if (toolPackage.id === 'location') {
    guidance.push('location 工具没有成功结果时，不得说定位到了、当前位置是某地或给出坐标。');
  }
  return guidance;
}

async function executeUsePackage(call: JunLuoToolCall): Promise<JunLuoToolResult<JunLuoUsePackageData>> {
  const packageId = readStringInput(call.input, 'packageId');
  if (!packageId) return validationFailed(call, '缺少工具包 ID', '没有激活工具包');
  const toolPackage = listToolPackages().find((candidate) => candidate.id === packageId);
  if (!toolPackage) {
    return createToolErrorResult(
      call,
      createToolError('PACKAGE_NOT_FOUND', `工具包不存在：${packageId}`, { packageId }),
      `没有激活工具包：${packageId}`,
    );
  }
  const tools = listTools(packageId).filter((tool) => tool.id !== 'life.set_sleep_schedule' && tool.id !== 'github.get_readme');
  return createToolSuccessResult(call, `已激活工具包：${toolPackage.name}`, {
    defaultEnabled: toolPackage.defaultEnabled,
    package: {
      category: toolPackage.category,
      description: toolPackage.description,
      id: toolPackage.id,
      name: toolPackage.name,
      riskLevel: toolPackage.riskLevel,
      source: toolPackage.source,
    },
    permissionSummary: summarizePermission(tools),
    reason: readOptionalStringInput(call.input, 'reason'),
    usageGuidance: buildUsageGuidance(toolPackage, tools),
    tools: tools.map((tool) => ({
      description: tool.description,
      id: tool.id,
      inputSchema: cloneInputSchema(tool.inputSchema) as SafeToolSchema & { type: 'object' },
      name: tool.name,
      permission: tool.permission,
      readOnly: tool.readOnly,
      riskLevel: tool.riskLevel,
    })),
  });
}

export const systemUsePackageTool: JunLuoToolDefinition<Record<string, unknown>, JunLuoUsePackageData> = {
  id: 'system.use_package',
  chatExposure: 'internal_only',
  proactiveEligible: false,
  packageId: 'system',
  name: '激活工具包',
  description: 'I 想使用某个工具包里的能力时，打开一至三个相关工具包。\n\n下一轮，I 会看到包内的具体工具，再选择需要的一项继续行动。',
  inputSchema: {
    type: 'object',
    required: ['packageId'],
    properties: {
      packageId: { type: 'string', description: '要激活的工具包 ID' },
      reason: { type: 'string', description: '宿主激活这个包的原因' },
    },
  },
  permission: 'allow',
  riskLevel: 'read',
  readOnly: true,
  executor: executeUsePackage,
};

export const systemToolPackage: JunLuoToolPackage = {
  id: 'system',
  name: '系统工具',
  description: '君落内部工具包，用于读取工具包说明和维护工具执行边界。',
  category: 'system',
  tools: [systemUsePackageTool],
  defaultEnabled: true,
  riskLevel: 'read',
  source: 'builtin',
};
