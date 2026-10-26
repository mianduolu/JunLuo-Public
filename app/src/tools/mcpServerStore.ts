import { toolsWorkspaceStorageBridge as AsyncStorage } from '../sync/syncToolsWorkspaceStorageBridge';

import { getSecretItem } from '../storage/secretStore';
import {
  deleteVaultSharedSecret,
  setVaultSharedSecret,
} from '../sync/syncVaultSharedSecretsStorageBridge';

const MCP_SERVER_STORE_KEY = 'junluo.tool.mcp.servers.v1';
const MCP_SECRET_PREFIX = 'mcp.server.';

export type JunLuoMcpSkippedTool = {
  name: string;
  reason: string;
  description?: string;
};

export type JunLuoMcpServerConfig = {
  serverId: string;
  name: string;
  endpoint: string;
  enabled: boolean;
  readOnlyOnly: boolean;
  createdAt: number;
  updatedAt: number;
  lastSyncedAt?: number;
  lastError?: string;
  registeredPackageIds?: string[];
  skippedTools?: JunLuoMcpSkippedTool[];
};

export type JunLuoMcpServerStatus = JunLuoMcpServerConfig & {
  hasToken: boolean;
  tokenTail?: string;
};

export type AddMcpServerInput = {
  endpoint: string;
  enabled?: boolean;
  name?: string;
  readOnlyOnly?: boolean;
};

function mcpServerSecretKey(serverId: string) {
  return `${MCP_SECRET_PREFIX}${serverId}.token`;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

export function sanitizeMcpServerId(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
}

function isPrivateHostname(hostname: string) {
  const host = hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host === '[::1]' ||
    host.endsWith('.local')
  ) {
    return true;
  }

  const parts = host.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = parts;
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

export function validateMcpEndpoint(endpoint: string) {
  const trimmed = endpoint.trim();
  if (!trimmed) {
    return { ok: false as const, reason: 'MCP endpoint 不能为空' };
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false as const, reason: 'MCP endpoint 不是有效 URL' };
  }
  if (url.protocol !== 'https:') {
    return { ok: false as const, reason: 'MCP endpoint 第一版只允许 https://' };
  }
  if (isPrivateHostname(url.hostname)) {
    return { ok: false as const, reason: 'MCP endpoint 第一版拒绝 localhost、局域网和本机地址' };
  }
  return { ok: true as const, endpoint: url.toString() };
}

function normalizeConfig(value: unknown): JunLuoMcpServerConfig | null {
  const record = readRecord(value);
  if (!record) return null;
  const endpoint = readString(record.endpoint);
  const serverId = sanitizeMcpServerId(readString(record.serverId));
  const name = readString(record.name) || serverId;
  if (!serverId || !endpoint || !validateMcpEndpoint(endpoint).ok) return null;
  const now = Date.now();
  const skippedTools = Array.isArray(record.skippedTools)
    ? record.skippedTools
      .map((item) => {
        const skipped = readRecord(item);
        const skippedName = readString(skipped?.name);
        const reason = readString(skipped?.reason);
        if (!skippedName || !reason) return null;
        return {
          name: skippedName,
          reason,
          ...(readString(skipped?.description) ? { description: readString(skipped?.description) } : {}),
        };
      })
      .filter((item): item is JunLuoMcpSkippedTool => !!item)
    : undefined;
  return {
    serverId,
    name,
    endpoint,
    enabled: Boolean(record.enabled),
    readOnlyOnly: record.readOnlyOnly !== false,
    createdAt: typeof record.createdAt === 'number' ? record.createdAt : now,
    updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : now,
    ...(typeof record.lastSyncedAt === 'number' ? { lastSyncedAt: record.lastSyncedAt } : {}),
    ...(readString(record.lastError) ? { lastError: readString(record.lastError) } : {}),
    ...(Array.isArray(record.registeredPackageIds)
      ? { registeredPackageIds: record.registeredPackageIds.filter((item): item is string => typeof item === 'string') }
      : {}),
    ...(skippedTools ? { skippedTools } : {}),
  };
}

export async function loadMcpServerConfigs() {
  const raw = await AsyncStorage.getItem(MCP_SERVER_STORE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.map(normalizeConfig).filter((item): item is JunLuoMcpServerConfig => !!item)
      : [];
  } catch {
    return [];
  }
}

async function saveAll(configs: JunLuoMcpServerConfig[]) {
  await AsyncStorage.setItem(MCP_SERVER_STORE_KEY, JSON.stringify(configs));
}

export async function loadMcpServerConfig(serverId: string) {
  const normalizedId = sanitizeMcpServerId(serverId);
  const configs = await loadMcpServerConfigs();
  return configs.find((config) => config.serverId === normalizedId) ?? null;
}

export async function addMcpServerConfig(input: AddMcpServerInput) {
  const validation = validateMcpEndpoint(input.endpoint);
  if (!validation.ok) {
    throw new Error(validation.reason);
  }
  const url = new URL(validation.endpoint);
  const fallbackId = sanitizeMcpServerId(`${url.hostname}${url.pathname}`) || `mcp_${Date.now()}`;
  const serverId = fallbackId;
  const now = Date.now();
  const config: JunLuoMcpServerConfig = {
    serverId,
    name: input.name?.trim() || url.hostname,
    endpoint: validation.endpoint,
    enabled: Boolean(input.enabled),
    readOnlyOnly: input.readOnlyOnly !== false,
    createdAt: now,
    updatedAt: now,
  };
  const configs = (await loadMcpServerConfigs()).filter((item) => item.serverId !== serverId);
  configs.push(config);
  await saveAll(configs);
  return config;
}

export async function removeMcpServerConfig(serverId: string) {
  const normalizedId = sanitizeMcpServerId(serverId);
  const configs = await loadMcpServerConfigs();
  const next = configs.filter((item) => item.serverId !== normalizedId);
  await saveAll(next);
  await deleteVaultSharedSecret(mcpServerSecretKey(normalizedId));
  return configs.length !== next.length;
}

export async function updateMcpServerConfig(serverId: string, patch: Partial<JunLuoMcpServerConfig>) {
  const normalizedId = sanitizeMcpServerId(serverId);
  const configs = await loadMcpServerConfigs();
  const index = configs.findIndex((item) => item.serverId === normalizedId);
  if (index < 0) return null;
  const nextConfig: JunLuoMcpServerConfig = {
    ...configs[index],
    ...patch,
    serverId: normalizedId,
    endpoint: configs[index].endpoint,
    updatedAt: Date.now(),
  };
  configs[index] = nextConfig;
  await saveAll(configs);
  return nextConfig;
}

export async function setMcpServerToken(serverId: string, token: string) {
  const normalizedId = sanitizeMcpServerId(serverId);
  if (!token.trim()) {
    await deleteVaultSharedSecret(mcpServerSecretKey(normalizedId));
    return;
  }
  await setVaultSharedSecret(mcpServerSecretKey(normalizedId), token);
}

export async function getMcpServerToken(serverId: string) {
  return getSecretItem(mcpServerSecretKey(sanitizeMcpServerId(serverId)));
}

export function maskMcpToken(token: string | null | undefined) {
  if (!token) return { hasToken: false as const };
  return {
    hasToken: true as const,
    tokenTail: token.length <= 4 ? token : token.slice(-4),
  };
}

export async function listMcpServerStatuses(): Promise<JunLuoMcpServerStatus[]> {
  const configs = await loadMcpServerConfigs();
  return Promise.all(configs.map(async (config) => ({
    ...config,
    ...maskMcpToken(await getMcpServerToken(config.serverId)),
  })));
}

export async function clearMcpServerConfigsForTests() {
  const configs = await loadMcpServerConfigs();
  await Promise.all(configs.map((config) => (
    deleteVaultSharedSecret(mcpServerSecretKey(config.serverId))
  )));
  await AsyncStorage.removeItem(MCP_SERVER_STORE_KEY);
}
