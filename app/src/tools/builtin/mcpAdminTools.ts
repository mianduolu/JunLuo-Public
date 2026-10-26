import { createToolError } from '../toolErrors';
import { createToolErrorResult, createToolSuccessResult } from '../toolResult';
import { getToolDefinition, listToolPackages } from '../toolRegistry';
import {
  registerExternalToolAdapter,
  registerExternalToolPackages,
  unregisterExternalToolAdapter,
} from '../externalToolAdapters';
import { createMcpHttpAdapter } from '../mcpHttpAdapter';
import {
  addMcpServerConfig,
  listMcpServerStatuses,
  loadMcpServerConfig,
  removeMcpServerConfig,
  updateMcpServerConfig,
  validateMcpEndpoint,
  type JunLuoMcpSkippedTool,
} from '../mcpServerStore';
import type { JunLuoToolCall, JunLuoToolDefinition, JunLuoToolPackage, JunLuoToolResult } from '../toolTypes';

type McpAdminData = Record<string, unknown>;

const emptySchema = { type: 'object' as const, properties: {} };

function readString(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function readBoolean(value: unknown, fallback: boolean) {
  return typeof value === 'boolean' ? value : fallback;
}

function error(call: JunLuoToolCall, code: 'VALIDATION_FAILED' | 'EXECUTION_FAILED' | 'PACKAGE_NOT_FOUND', message: string) {
  return createToolErrorResult<McpAdminData>(call, createToolError(code, message), message);
}

async function listServers(call: JunLuoToolCall): Promise<JunLuoToolResult<McpAdminData>> {
  const servers = await listMcpServerStatuses();
  return createToolSuccessResult(call, servers.length ? `已配置 ${servers.length} 个 MCP server` : '还没有配置 MCP server', {
    servers,
    externalPackages: listToolPackages().filter((item) => item.source === 'mcp').map((item) => ({
      id: item.id,
      name: item.name,
      toolCount: item.tools.length,
      defaultEnabled: item.defaultEnabled,
      riskLevel: item.riskLevel,
    })),
  });
}

async function addServer(call: JunLuoToolCall): Promise<JunLuoToolResult<McpAdminData>> {
  const endpoint = readString(call.input.endpoint);
  const validation = validateMcpEndpoint(endpoint);
  if (!validation.ok) return error(call, 'VALIDATION_FAILED', validation.reason);
  try {
    const config = await addMcpServerConfig({
      endpoint: validation.endpoint,
      name: readString(call.input.name),
      enabled: readBoolean(call.input.enabled, false),
      readOnlyOnly: readBoolean(call.input.readOnlyOnly, true),
    });
    return createToolSuccessResult(call, `已登记 HTTPS MCP server：${config.name}`, { server: config });
  } catch (caught) {
    return error(call, 'EXECUTION_FAILED', caught instanceof Error ? caught.message : String(caught));
  }
}

async function removeServer(call: JunLuoToolCall): Promise<JunLuoToolResult<McpAdminData>> {
  const serverId = readString(call.input.serverId);
  if (!serverId) return error(call, 'VALIDATION_FAILED', 'serverId 不能为空');
  const removed = await removeMcpServerConfig(serverId);
  if (!removed) return error(call, 'PACKAGE_NOT_FOUND', `MCP server 不存在：${serverId}`);
  unregisterExternalToolAdapter(`mcp-http:${serverId}`);
  return createToolSuccessResult(call, `已移除 MCP server：${serverId}`, { serverId });
}

async function syncServer(call: JunLuoToolCall): Promise<JunLuoToolResult<McpAdminData>> {
  const serverId = readString(call.input.serverId);
  if (!serverId) return error(call, 'VALIDATION_FAILED', 'serverId 不能为空');
  const config = await loadMcpServerConfig(serverId);
  if (!config) return error(call, 'PACKAGE_NOT_FOUND', `MCP server 不存在：${serverId}`);

  const adapter = createMcpHttpAdapter(config);
  try {
    unregisterExternalToolAdapter(adapter.id);
    registerExternalToolAdapter(adapter);
    const previewPackages = await adapter.listPackages();
    const skippedTools: JunLuoMcpSkippedTool[] = adapter.getSkippedTools();
    const alreadyRegistered = previewPackages.every((toolPackage) =>
      toolPackage.tools.every((tool) => getToolDefinition(tool.id)));
    const registeredPackages = alreadyRegistered ? previewPackages : await registerExternalToolPackages(adapter.id);
    const updated = await updateMcpServerConfig(config.serverId, {
      lastSyncedAt: Date.now(),
      lastError: '',
      registeredPackageIds: registeredPackages.map((item) => item.id),
      skippedTools,
    });
    const toolCount = registeredPackages.reduce((sum, item) => sum + item.tools.length, 0);
    return createToolSuccessResult(
      call,
      toolCount ? `已同步 MCP server：注册 ${toolCount} 个只读工具` : '已同步 MCP server，但没有可注册的只读工具',
      {
        packages: registeredPackages.map((item) => ({
          id: item.id,
          name: item.name,
          toolCount: item.tools.length,
          defaultEnabled: item.defaultEnabled,
          source: item.source,
        })),
        server: updated ?? config,
        skippedTools,
      },
    );
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    await updateMcpServerConfig(config.serverId, { lastError: message });
    return error(call, 'EXECUTION_FAILED', message);
  }
}

async function packagePreview(call: JunLuoToolCall): Promise<JunLuoToolResult<McpAdminData>> {
  const serverId = readString(call.input.serverId);
  if (!serverId) return error(call, 'VALIDATION_FAILED', 'serverId 不能为空');
  const config = await loadMcpServerConfig(serverId);
  if (!config) return error(call, 'PACKAGE_NOT_FOUND', `MCP server 不存在：${serverId}`);
  const packages = listToolPackages()
    .filter((item) => item.source === 'mcp' && item.id === `mcp.${config.serverId}`)
    .map((item) => ({
      id: item.id,
      name: item.name,
      defaultEnabled: item.defaultEnabled,
      riskLevel: item.riskLevel,
      tools: item.tools.map((tool) => ({
        id: tool.id,
        name: tool.name,
        readOnly: tool.readOnly,
        riskLevel: tool.riskLevel,
        permission: tool.permission,
      })),
    }));
  return createToolSuccessResult(call, `已读取 MCP package 预览：${config.name}`, {
    packages,
    server: config,
    skippedTools: config.skippedTools ?? [],
  });
}

function adminTool(definition: Omit<JunLuoToolDefinition, 'packageId'>): JunLuoToolDefinition {
  return { ...definition, packageId: 'mcp_admin' };
}

export const mcpAdminToolPackage: JunLuoToolPackage = {
  id: 'mcp_admin',
  name: 'MCP 外部工具试验区',
  description: '管理 HTTPS 只读 MCP 试点 server；不接 stdio、电脑 MCP 或 ToolPkg 执行。',
  category: 'tools',
  source: 'builtin',
  defaultEnabled: true,
  riskLevel: 'external_network',
  tools: [
    adminTool({
      id: 'mcp_admin.list_servers',
      chatExposure: 'internal_only',
      proactiveEligible: false,
      name: '列出 MCP server',
      description: '列出已配置的 HTTPS MCP server、同步状态和外部包摘要。',
      inputSchema: emptySchema,
      permission: 'allow',
      riskLevel: 'read',
      readOnly: true,
      executor: listServers,
    }),
    adminTool({
      id: 'mcp_admin.add_server',
      chatExposure: 'internal_only',
      proactiveEligible: false,
      name: '添加 MCP server',
      description: '登记一个 HTTPS MCP endpoint。Token 不通过工具 input 传入，避免审计泄露。',
      inputSchema: {
        type: 'object',
        required: ['endpoint'],
        properties: {
          endpoint: { type: 'string', description: 'HTTPS MCP JSON-RPC endpoint' },
          name: { type: 'string' },
          enabled: { type: 'boolean' },
          readOnlyOnly: { type: 'boolean' },
        },
      },
      permission: 'ask',
      riskLevel: 'write_local',
      readOnly: false,
      executor: addServer,
    }),
    adminTool({
      id: 'mcp_admin.remove_server',
      chatExposure: 'internal_only',
      proactiveEligible: false,
      name: '移除 MCP server',
      description: '移除 MCP server 配置和对应 token。',
      inputSchema: {
        type: 'object',
        required: ['serverId'],
        properties: { serverId: { type: 'string' } },
      },
      permission: 'ask',
      riskLevel: 'write_local',
      readOnly: false,
      executor: removeServer,
    }),
    adminTool({
      id: 'mcp_admin.sync_server',
      chatExposure: 'internal_only',
      proactiveEligible: false,
      name: '同步 MCP server',
      description: '调用 tools/list，同步低风险只读 MCP 工具到君落工具注册表。',
      inputSchema: {
        type: 'object',
        required: ['serverId'],
        properties: { serverId: { type: 'string' } },
      },
      permission: 'ask',
      riskLevel: 'external_network',
      readOnly: false,
      executor: syncServer,
    }),
    adminTool({
      id: 'mcp_admin.get_package_preview',
      chatExposure: 'internal_only',
      proactiveEligible: false,
      name: '查看 MCP 包预览',
      description: '查看某个 MCP server 已注册包和 skipped 工具诊断。',
      inputSchema: {
        type: 'object',
        required: ['serverId'],
        properties: { serverId: { type: 'string' } },
      },
      permission: 'allow',
      riskLevel: 'read',
      readOnly: true,
      executor: packagePreview,
    }),
  ],
};

