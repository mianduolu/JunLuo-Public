import type { JunLuoExternalToolPackageAdapter } from './externalToolAdapters';
import { mcpToolToJunLuoToolDefinition } from './mcpToolAdapter';
import { callMcpTool, listMcpTools, type JunLuoMcpHttpTool } from './mcpHttpClient';
import type { JunLuoMcpServerConfig, JunLuoMcpSkippedTool } from './mcpServerStore';
import { createToolSuccessResult } from './toolResult';
import type { JunLuoToolDefinition, JunLuoToolPackage } from './toolTypes';

type McpHttpAdapterCache = {
  packageDefinition: JunLuoToolPackage;
  rawNameByToolId: Map<string, string>;
  skippedTools: JunLuoMcpSkippedTool[];
  tools: JunLuoToolDefinition[];
};

export type JunLuoMcpHttpAdapter = JunLuoExternalToolPackageAdapter & {
  getSkippedTools(): JunLuoMcpSkippedTool[];
};

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function isReadOnlyMcpTool(tool: JunLuoMcpHttpTool) {
  if (tool.readOnly === true) return true;
  const annotations = readRecord(tool.annotations);
  return annotations?.readOnlyHint === true;
}

function summarizeMcpToolResult(result: unknown) {
  const record = readRecord(result);
  const content = Array.isArray(record?.content) ? record?.content : [];
  const textItem = content
    .map(readRecord)
    .map((item) => readString(item?.text))
    .find(Boolean);
  return textItem ? `MCP 工具返回：${textItem.slice(0, 80)}` : 'MCP 工具调用完成';
}

export function createMcpHttpAdapter(config: JunLuoMcpServerConfig): JunLuoMcpHttpAdapter {
  let cachePromise: Promise<McpHttpAdapterCache> | null = null;
  let latestSkippedTools: JunLuoMcpSkippedTool[] = [];

  async function loadCache(): Promise<McpHttpAdapterCache> {
    if (cachePromise) return cachePromise;
    cachePromise = (async () => {
      const listed = await listMcpTools(config);
      const skippedTools: JunLuoMcpSkippedTool[] = [];
      const rawNameByToolId = new Map<string, string>();
      const packageId = `mcp.${config.serverId}`;
      const tools = listed.tools
        .map((tool) => {
          const rawName = readString(tool.name);
          if (!rawName) {
            skippedTools.push({ name: '(empty)', reason: 'empty_name' });
            return null;
          }
          if (config.readOnlyOnly && !isReadOnlyMcpTool(tool)) {
            skippedTools.push({
              name: rawName,
              reason: 'not_read_only',
              ...(readString(tool.description) ? { description: readString(tool.description) } : {}),
            });
            return null;
          }
          const definition = mcpToolToJunLuoToolDefinition({
            packageId,
            serverId: config.serverId,
            tool,
            riskLevel: 'external_network',
          });
          if (!definition) {
            skippedTools.push({ name: rawName, reason: 'invalid_tool_definition' });
            return null;
          }
          rawNameByToolId.set(definition.id, rawName);
          return {
            ...definition,
            permission: 'ask' as const,
            riskLevel: 'external_network' as const,
            readOnly: true,
          };
        })
        .filter(Boolean) as JunLuoToolDefinition[];

      const packageDefinition: JunLuoToolPackage = {
        id: packageId,
        name: config.name,
        description: `HTTPS MCP 只读试点：${config.name}`,
        category: 'MCP',
        tools,
        defaultEnabled: false,
        riskLevel: 'external_network',
        source: 'mcp',
      };

      latestSkippedTools = skippedTools;
      return { packageDefinition, rawNameByToolId, skippedTools, tools };
    })();
    return cachePromise;
  }

  return {
    id: `mcp-http:${config.serverId}`,
    source: 'mcp',
    async listPackages() {
      const cache = await loadCache();
      return cache.tools.length ? [cache.packageDefinition] : [];
    },
    async listTools(packageId: string) {
      const cache = await loadCache();
      if (packageId !== `mcp.${config.serverId}`) return [];
      return cache.tools;
    },
    async execute(call) {
      const cache = await loadCache();
      const rawName = cache.rawNameByToolId.get(call.toolId);
      if (!rawName) {
        throw new Error(`MCP tool mapping not found: ${call.toolId}`);
      }
      const result = await callMcpTool(config, rawName, call.input);
      return createToolSuccessResult(call, summarizeMcpToolResult(result), {
        result,
        serverId: config.serverId,
        toolName: rawName,
      });
    },
    getSkippedTools() {
      return latestSkippedTools;
    },
  };
}
