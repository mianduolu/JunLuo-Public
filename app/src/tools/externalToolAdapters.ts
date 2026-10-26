import { JunLuoToolRegistryError, createToolError } from './toolErrors';
import { createToolErrorResult } from './toolResult';
import { registerToolPackage } from './toolRegistry';
import type {
  JunLuoToolCall,
  JunLuoToolDefinition,
  JunLuoToolPackage,
  JunLuoToolResult,
  JunLuoToolRiskLevel,
} from './toolTypes';

export type JunLuoExternalToolAdapterSource = 'mcp' | 'local_plugin';

export type JunLuoExternalToolPackageAdapter = {
  id: string;
  source: JunLuoExternalToolAdapterSource;
  listPackages(): Promise<JunLuoToolPackage[]>;
  listTools(packageId: string): Promise<JunLuoToolDefinition[]>;
  execute(call: JunLuoToolCall): Promise<JunLuoToolResult> | JunLuoToolResult;
};

const adaptersById = new Map<string, JunLuoExternalToolPackageAdapter>();

function assertAdapterSource(source: string): asserts source is JunLuoExternalToolAdapterSource {
  if (source !== 'mcp' && source !== 'local_plugin') {
    throw new JunLuoToolRegistryError(
      'INVALID_TOOL_PACKAGE',
      `外部工具 adapter source 无效：${source}`,
      { source },
    );
  }
}

function assertNonEmptyAdapterId(id: string) {
  if (!id.trim()) {
    throw new JunLuoToolRegistryError('INVALID_TOOL_PACKAGE', '外部工具 adapter id 不能为空');
  }
}

function normalizeRiskLevel(value: JunLuoToolRiskLevel | undefined): JunLuoToolRiskLevel {
  return value ?? 'external_network';
}

function normalizeExternalTool(
  adapter: JunLuoExternalToolPackageAdapter,
  tool: JunLuoToolDefinition,
  packageId: string,
): JunLuoToolDefinition {
  return {
    ...tool,
    packageId,
    permission: tool.permission ?? 'ask',
    riskLevel: normalizeRiskLevel(tool.riskLevel),
    readOnly: Boolean(tool.readOnly),
    executor: async (call) => {
      try {
        return await adapter.execute(call);
      } catch (error) {
        return createToolErrorResult(
          call,
          createToolError(
            'EXECUTION_FAILED',
            error instanceof Error ? error.message : String(error),
            { adapterId: adapter.id, source: adapter.source },
          ),
          '外部工具执行失败',
        );
      }
    },
  };
}

function normalizeExternalPackage(
  adapter: JunLuoExternalToolPackageAdapter,
  packageDefinition: JunLuoToolPackage,
  tools: JunLuoToolDefinition[],
): JunLuoToolPackage {
  assertAdapterSource(packageDefinition.source);
  return {
    ...packageDefinition,
    defaultEnabled: false,
    riskLevel: normalizeRiskLevel(packageDefinition.riskLevel),
    source: adapter.source,
    tools: tools.map((tool) => normalizeExternalTool(adapter, tool, packageDefinition.id)),
  };
}

export function registerExternalToolAdapter(adapter: JunLuoExternalToolPackageAdapter) {
  assertNonEmptyAdapterId(adapter.id);
  assertAdapterSource(adapter.source);
  if (adaptersById.has(adapter.id)) {
    throw new JunLuoToolRegistryError(
      'DUPLICATE_PACKAGE_ID',
      `外部工具 adapter ID 已存在：${adapter.id}`,
      { adapterId: adapter.id },
    );
  }
  adaptersById.set(adapter.id, adapter);
}

export function unregisterExternalToolAdapter(adapterId: string) {
  adaptersById.delete(adapterId);
}

export function listExternalToolAdapters() {
  return Array.from(adaptersById.values());
}

export function clearExternalToolAdaptersForTests() {
  adaptersById.clear();
}

export async function registerExternalToolPackages(adapterId: string) {
  const adapter = adaptersById.get(adapterId);
  if (!adapter) {
    throw new JunLuoToolRegistryError(
      'PACKAGE_NOT_FOUND',
      `外部工具 adapter 不存在：${adapterId}`,
      { adapterId },
    );
  }

  const packages = await adapter.listPackages();
  const registeredPackages: JunLuoToolPackage[] = [];
  for (const packageDefinition of packages) {
    const tools = await adapter.listTools(packageDefinition.id);
    const normalized = normalizeExternalPackage(adapter, packageDefinition, tools);
    registerToolPackage(normalized);
    registeredPackages.push(normalized);
  }
  return registeredPackages;
}
