import { JunLuoToolRegistryError } from './toolErrors';
import { normalizeToolChatPolicy, validateToolChatPolicy } from './toolChatPolicy';
import type { JunLuoRegisteredToolDefinition, JunLuoToolPackage } from './toolTypes';

const packagesById = new Map<string, JunLuoToolPackage>();
const toolsById = new Map<string, JunLuoRegisteredToolDefinition>();

function assertNonEmptyId(value: string, label: string) {
  if (!value.trim()) {
    throw new JunLuoToolRegistryError('INVALID_TOOL_DEFINITION', `${label} 不能为空`);
  }
}

function validateToolPackage(packageDefinition: JunLuoToolPackage) {
  assertNonEmptyId(packageDefinition.id, '工具包 ID');
  if (!packageDefinition.tools.length) {
    throw new JunLuoToolRegistryError(
      'INVALID_TOOL_PACKAGE',
      `工具包 ${packageDefinition.id} 至少需要包含一个工具定义`,
    );
  }

  packageDefinition.tools.forEach((tool) => {
    assertNonEmptyId(tool.id, '工具 ID');
    assertNonEmptyId(tool.packageId, '工具所属包 ID');
    if (tool.packageId !== packageDefinition.id) {
      throw new JunLuoToolRegistryError(
        'INVALID_TOOL_DEFINITION',
        `工具 ${tool.id} 的 packageId 必须等于所属工具包 ${packageDefinition.id}`,
        { packageId: packageDefinition.id, toolPackageId: tool.packageId, toolId: tool.id },
      );
    }
    if (tool.inputSchema.type !== 'object') {
      throw new JunLuoToolRegistryError(
        'INVALID_TOOL_DEFINITION',
        `工具 ${tool.id} 的 inputSchema.type 必须为 object`,
      );
    }
    try {
      validateToolChatPolicy(tool as JunLuoRegisteredToolDefinition);
    } catch (error) {
      throw new JunLuoToolRegistryError(
        'INVALID_TOOL_DEFINITION',
        error instanceof Error ? error.message : String(error),
      );
    }
  });
}

export function registerToolPackage(packageDefinition: JunLuoToolPackage) {
  const normalizedPackage: JunLuoToolPackage = {
    ...packageDefinition,
    tools: packageDefinition.tools.map((tool) => normalizeToolChatPolicy(tool, packageDefinition.source)),
  };
  validateToolPackage(normalizedPackage);

  if (packagesById.has(normalizedPackage.id)) {
    throw new JunLuoToolRegistryError(
      'DUPLICATE_PACKAGE_ID',
      `工具包 ID 已存在：${normalizedPackage.id}`,
      { packageId: normalizedPackage.id },
    );
  }

  const seenToolIds = new Set<string>();
  normalizedPackage.tools.forEach((tool) => {
    if (seenToolIds.has(tool.id) || toolsById.has(tool.id)) {
      throw new JunLuoToolRegistryError(
        'DUPLICATE_TOOL_ID',
        `工具 ID 已存在：${tool.id}`,
        { packageId: normalizedPackage.id, toolId: tool.id },
      );
    }
    seenToolIds.add(tool.id);
  });

  packagesById.set(normalizedPackage.id, normalizedPackage);
  normalizedPackage.tools.forEach((tool) => toolsById.set(tool.id, tool as JunLuoRegisteredToolDefinition));
}

export function listToolPackages() {
  return Array.from(packagesById.values());
}

export function listTools(packageId?: string) {
  if (!packageId) return Array.from(toolsById.values());
  return packagesById.get(packageId)?.tools ?? [];
}

export function getToolDefinition(toolId: string) {
  return toolsById.get(toolId);
}

export function clearToolRegistryForTests() {
  packagesById.clear();
  toolsById.clear();
}
