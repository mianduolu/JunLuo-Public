import {
  collectVaultSharedSecretDefinitions,
} from './syncVaultSharedSecretRegistry';

export const VAULT_SHARED_SECRET_AI_SETTINGS_KEY =
  'junluo.aiConnections' as const;
export const VAULT_SHARED_SECRET_MCP_SETTINGS_KEY =
  'junluo.tool.mcp.servers.v1' as const;

type StorageRecord = Record<string, string | null | undefined>;

function parseArray(raw: string | null | undefined) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function readId(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return '';
  }
  const id = (value as { id?: unknown; serverId?: unknown });
  if (typeof id.id === 'string') return id.id;
  return typeof id.serverId === 'string' ? id.serverId : '';
}

export function vaultSharedSecretDefinitionsFromStorage(
  storage: StorageRecord,
) {
  let aiConnections: unknown[] = [];
  const aiRaw = storage[VAULT_SHARED_SECRET_AI_SETTINGS_KEY];
  if (aiRaw) {
    try {
      const parsed = JSON.parse(aiRaw) as { connections?: unknown };
      aiConnections = Array.isArray(parsed?.connections)
        ? parsed.connections
        : [];
    } catch {
      aiConnections = [];
    }
  }
  const mcpServers = parseArray(
    storage[VAULT_SHARED_SECRET_MCP_SETTINGS_KEY],
  );
  return collectVaultSharedSecretDefinitions({
    aiConnectionIds: aiConnections.map(readId).filter(Boolean),
    mcpServerIds: mcpServers.map(readId).filter(Boolean),
  });
}

export async function discoverVaultSharedSecretDefinitions(
  reader: {
    getItem(key: string): Promise<string | null>;
  },
) {
  const [aiSettings, mcpSettings] = await Promise.all([
    reader.getItem(VAULT_SHARED_SECRET_AI_SETTINGS_KEY),
    reader.getItem(VAULT_SHARED_SECRET_MCP_SETTINGS_KEY),
  ]);
  return vaultSharedSecretDefinitionsFromStorage({
    [VAULT_SHARED_SECRET_AI_SETTINGS_KEY]: aiSettings,
    [VAULT_SHARED_SECRET_MCP_SETTINGS_KEY]: mcpSettings,
  });
}
