import { loadAiConfigPreferencesSnapshot, type AiConfigSnapshot } from '../../ai/AiConfigPreferences';
import type { AiConnection, AiConnectionPurpose } from '../../ai/types';
import { createToolSuccessResult } from '../toolResult';
import type { JunLuoToolCall, JunLuoToolDefinition, JunLuoToolPackage, JunLuoToolResult } from '../toolTypes';
import { readOptionalStringInput, readStringInput, validationFailed } from './builtinToolValidation';

type CredentialConnectionStatus = {
  id: string;
  name: string;
  provider: string;
  preset: string;
  baseUrlHost: string;
  model: string;
  purposes: AiConnectionPurpose[];
  hasApiKey: boolean;
  apiKeyLast4?: string;
  apiKeyLengthRange: string;
};

type CredentialListStatusData = {
  configuredConnections: number;
  connections: CredentialConnectionStatus[];
  purposeConnections: Partial<Record<AiConnectionPurpose, string>>;
  totalConnections: number;
};

type CredentialCheckConfiguredData = {
  baseUrlHost?: string;
  configured: boolean;
  connectionId?: string;
  connectionName?: string;
  hasApiKey: boolean;
  hasBaseUrl: boolean;
  hasConnection: boolean;
  hasModel: boolean;
  model?: string;
  purpose: AiConnectionPurpose;
};

type CredentialRevealData = {
  apiKey: string;
  connectionId: string;
  connectionName: string;
  reason?: string;
  revealedAt: number;
};

const PURPOSES: readonly AiConnectionPurpose[] = ['chat', 'memoryOrganizer', 'memoryReranker'];

function readPurpose(input: Record<string, unknown>): AiConnectionPurpose {
  const purpose = readOptionalStringInput(input, 'purpose');
  return PURPOSES.includes(purpose as AiConnectionPurpose) ? purpose as AiConnectionPurpose : 'chat';
}

function getPurposeConnection(snapshot: AiConfigSnapshot, purpose: AiConnectionPurpose) {
  if (purpose === 'memoryOrganizer') {
    return { connection: snapshot.memoryOrganizerConnection, apiKey: snapshot.memoryOrganizerKey };
  }
  if (purpose === 'memoryReranker') {
    return { connection: snapshot.memoryRerankerConnection, apiKey: snapshot.memoryRerankerKey };
  }
  return { connection: snapshot.chatConnection, apiKey: snapshot.chatKey };
}

function getBaseUrlHost(baseUrl: string) {
  try {
    return new URL(baseUrl).host;
  } catch {
    return '';
  }
}

function getKeyLengthRange(apiKey: string) {
  const length = apiKey.trim().length;
  if (!length) return '0';
  if (length <= 20) return '1-20';
  if (length <= 40) return '21-40';
  if (length <= 80) return '41-80';
  return '80+';
}

function getPurposesForConnection(snapshot: AiConfigSnapshot, connectionId: string) {
  return PURPOSES.filter((purpose) => getPurposeConnection(snapshot, purpose).connection?.id === connectionId);
}

function toConnectionStatus(snapshot: AiConfigSnapshot, connection: AiConnection): CredentialConnectionStatus {
  const apiKey = snapshot.apiKeys[connection.id] ?? '';
  const hasApiKey = Boolean(apiKey.trim());
  return {
    id: connection.id,
    name: connection.name,
    provider: connection.provider,
    preset: connection.preset,
    baseUrlHost: getBaseUrlHost(connection.baseUrl),
    model: connection.model,
    purposes: getPurposesForConnection(snapshot, connection.id),
    hasApiKey,
    ...(hasApiKey ? { apiKeyLast4: apiKey.trim().slice(-4) } : {}),
    apiKeyLengthRange: getKeyLengthRange(apiKey),
  };
}

async function executeCredentialListStatus(
  call: JunLuoToolCall,
): Promise<JunLuoToolResult<CredentialListStatusData>> {
  const snapshot = await loadAiConfigPreferencesSnapshot({ maxAgeMs: 0 });
  const connections = snapshot.connections.map((connection) => toConnectionStatus(snapshot, connection));
  const configuredConnections = connections.filter((connection) => connection.hasApiKey).length;
  const purposeConnections = Object.fromEntries(
    PURPOSES.map((purpose) => [purpose, getPurposeConnection(snapshot, purpose).connection?.id]).filter(([, id]) => id),
  ) as Partial<Record<AiConnectionPurpose, string>>;
  return createToolSuccessResult(call, `已读取 AI 连接状态：${configuredConnections}/${connections.length} 个连接配置了密钥`, {
    configuredConnections,
    connections,
    purposeConnections,
    totalConnections: connections.length,
  });
}

async function executeCredentialCheckConfigured(
  call: JunLuoToolCall,
): Promise<JunLuoToolResult<CredentialCheckConfiguredData>> {
  const purpose = readPurpose(call.input);
  const snapshot = await loadAiConfigPreferencesSnapshot({ maxAgeMs: 0 });
  const { connection, apiKey } = getPurposeConnection(snapshot, purpose);
  const data: CredentialCheckConfiguredData = {
    baseUrlHost: connection ? getBaseUrlHost(connection.baseUrl) : undefined,
    configured: Boolean(connection && connection.baseUrl.trim() && connection.model.trim() && apiKey.trim()),
    connectionId: connection?.id,
    connectionName: connection?.name,
    hasApiKey: Boolean(apiKey.trim()),
    hasBaseUrl: Boolean(connection?.baseUrl.trim()),
    hasConnection: Boolean(connection),
    hasModel: Boolean(connection?.model.trim()),
    model: connection?.model,
    purpose,
  };
  if (!data.configured) {
    const missing = [
      data.hasConnection ? '' : 'connection',
      data.hasBaseUrl ? '' : 'baseUrl',
      data.hasModel ? '' : 'model',
      data.hasApiKey ? '' : 'apiKey',
    ].filter(Boolean).join('、');
    return validationFailed(call, `AI 连接未配置完整：${missing || 'unknown'}`, `模型配置还不完整：缺少 ${missing || '必要信息'}`);
  }
  return createToolSuccessResult(call, `模型配置已就绪：${connection!.name} / ${connection!.model}`, data);
}

async function executeCredentialReveal(call: JunLuoToolCall): Promise<JunLuoToolResult<CredentialRevealData>> {
  const connectionId = readStringInput(call.input, 'connectionId');
  if (!connectionId) return validationFailed(call, '缺少 connectionId', '没有读取密钥原文');
  const reason = readOptionalStringInput(call.input, 'reason');
  const snapshot = await loadAiConfigPreferencesSnapshot({ maxAgeMs: 0 });
  const connection = snapshot.connections.find((item) => item.id === connectionId);
  if (!connection) return validationFailed(call, `没有找到连接：${connectionId}`, '没有读取密钥原文');
  const apiKey = snapshot.apiKeys[connection.id] ?? '';
  if (!apiKey.trim()) return validationFailed(call, `连接没有配置 API Key：${connectionId}`, '没有读取密钥原文');
  return createToolSuccessResult(call, `已读取危险凭据：${connection.name} 的 API Key 原文`, {
    apiKey,
    connectionId,
    connectionName: connection.name,
    reason,
    revealedAt: Date.now(),
  });
}

export const credentialListStatusTool: JunLuoToolDefinition<Record<string, unknown>, CredentialListStatusData> = {
  id: 'credential.list_status',
  chatExposure: 'internal_only',
  proactiveEligible: false,
  packageId: 'credential',
  name: '查看凭据配置状态',
  description: '读取 AI 连接与密钥的脱敏配置状态，只返回是否配置、末尾四位、长度区间、模型名和连接地址域名。',
  inputSchema: { type: 'object' },
  permission: 'allow',
  riskLevel: 'read',
  readOnly: true,
  executor: executeCredentialListStatus,
};

export const credentialCheckConfiguredTool: JunLuoToolDefinition<Record<string, unknown>, CredentialCheckConfiguredData> = {
  id: 'credential.check_configured',
  chatExposure: 'internal_only',
  proactiveEligible: false,
  packageId: 'credential',
  name: '检查模型配置是否完整',
  description: '检查指定用途是否有 AI 连接、baseUrl、模型名和 API Key。',
  inputSchema: {
    type: 'object',
    properties: {
      purpose: { type: 'string', enum: ['chat', 'memoryOrganizer', 'memoryReranker'], description: '检查用途，默认 chat' },
    },
  },
  permission: 'allow',
  riskLevel: 'read',
  readOnly: true,
  executor: executeCredentialCheckConfigured,
};

export const credentialRevealTool: JunLuoToolDefinition<Record<string, unknown>, CredentialRevealData> = {
  id: 'credential.reveal',
  chatExposure: 'internal_only',
  proactiveEligible: false,
  packageId: 'credential',
  name: '显示密钥原文',
  description: '读取指定 AI 连接的 API Key 原文；只有显式授权并成功回执时才展示。',
  inputSchema: {
    type: 'object',
    required: ['connectionId'],
    properties: {
      connectionId: { type: 'string', description: 'AI 连接 ID' },
      reason: { type: 'string', description: '读取原文密钥的原因' },
    },
  },
  permission: 'deny',
  riskLevel: 'dangerous',
  readOnly: true,
  executor: executeCredentialReveal,
};

export const credentialToolPackage: JunLuoToolPackage = {
  id: 'credential',
  name: '凭据状态',
  description: '查看 AI 连接和密钥配置状态；密钥原文只在 credential.reveal 显式授权并成功后展示。',
  category: 'account',
  tools: [
    credentialListStatusTool,
    credentialCheckConfiguredTool,
    credentialRevealTool,
  ],
  defaultEnabled: true,
  riskLevel: 'dangerous',
  source: 'builtin',
};

