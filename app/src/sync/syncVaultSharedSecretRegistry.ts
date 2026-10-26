import { voiceCallSecretKeys } from '../voiceCall/voiceCallSecretKeys';

export const VAULT_SHARED_SECRET_AMAP_KEY =
  'junluo.nearbyWorld.amap.apiKey' as const;
export const VAULT_SHARED_SECRET_GITHUB_TOKEN_KEY =
  'github.token' as const;
export const VAULT_SHARED_SECRET_LEGACY_AI_KEY =
  'junluo.aiApiKey' as const;
export const VAULT_SHARED_SECRET_EMBEDDING_KEY =
  'junluo.memoryEmbedding.apiKey' as const;
export const VAULT_SHARED_SECRET_AI_KEY_PREFIX =
  'junluo.aiApiKey.' as const;
export const VAULT_SHARED_SECRET_MCP_KEY_PREFIX =
  'mcp.server.' as const;
export const VAULT_SHARED_SECRET_MCP_KEY_SUFFIX =
  '.token' as const;

export const VAULT_SHARED_SECRET_CREDENTIAL_TYPES = [
  'ai-api-key',
  'embedding-api-key',
  'voice-api-key',
  'voice-group-id',
  'voice-id',
  'voice-backend-token',
  'github-token',
  'mcp-token',
  'amap-api-key',
] as const;

export type VaultSharedSecretCredentialType =
  (typeof VAULT_SHARED_SECRET_CREDENTIAL_TYPES)[number];

export type VaultSharedSecretDefinition = {
  credentialType: VaultSharedSecretCredentialType;
  secretId: string;
  serviceId: string;
  storageKey: string;
};

const STATIC_DEFINITIONS: readonly VaultSharedSecretDefinition[] =
  Object.freeze([
    Object.freeze({
      credentialType: 'ai-api-key',
      secretId: 'service-secret:ai:legacy',
      serviceId: 'ai:legacy',
      storageKey: VAULT_SHARED_SECRET_LEGACY_AI_KEY,
    }),
    Object.freeze({
      credentialType: 'embedding-api-key',
      secretId: 'service-secret:embedding:default',
      serviceId: 'embedding:default',
      storageKey: VAULT_SHARED_SECRET_EMBEDDING_KEY,
    }),
    Object.freeze({
      credentialType: 'voice-api-key',
      secretId: 'service-secret:voice:minimax-api-key',
      serviceId: 'voice:minimax',
      storageKey: voiceCallSecretKeys.minimaxApiKey,
    }),
    Object.freeze({
      credentialType: 'voice-group-id',
      secretId: 'service-secret:voice:minimax-group-id',
      serviceId: 'voice:minimax',
      storageKey: voiceCallSecretKeys.minimaxGroupId,
    }),
    Object.freeze({
      credentialType: 'voice-id',
      secretId: 'service-secret:voice:minimax-voice-id',
      serviceId: 'voice:minimax',
      storageKey: voiceCallSecretKeys.minimaxVoiceId,
    }),
    Object.freeze({
      credentialType: 'voice-backend-token',
      secretId: 'service-secret:voice:backend-token',
      serviceId: 'voice:backend',
      storageKey: voiceCallSecretKeys.voiceCallApiToken,
    }),
    Object.freeze({
      credentialType: 'github-token',
      secretId: 'service-secret:github:default',
      serviceId: 'github:default',
      storageKey: VAULT_SHARED_SECRET_GITHUB_TOKEN_KEY,
    }),
    Object.freeze({
      credentialType: 'amap-api-key',
      secretId: 'service-secret:amap:default',
      serviceId: 'amap:default',
      storageKey: VAULT_SHARED_SECRET_AMAP_KEY,
    }),
  ]);

const AI_CONNECTION_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const MCP_SERVER_ID = /^[a-z0-9_.-]{1,64}$/;

function dynamicAiDefinition(
  connectionId: string,
): VaultSharedSecretDefinition | undefined {
  if (!AI_CONNECTION_ID.test(connectionId)) return undefined;
  return {
    credentialType: 'ai-api-key',
    secretId: `service-secret:ai-connection:${connectionId}`,
    serviceId: `ai:${connectionId}`,
    storageKey: `${VAULT_SHARED_SECRET_AI_KEY_PREFIX}${connectionId}`,
  };
}

function dynamicMcpDefinition(
  serverId: string,
): VaultSharedSecretDefinition | undefined {
  if (!MCP_SERVER_ID.test(serverId)) return undefined;
  return {
    credentialType: 'mcp-token',
    secretId: `service-secret:mcp:${serverId}`,
    serviceId: `mcp:${serverId}`,
    storageKey:
      `${VAULT_SHARED_SECRET_MCP_KEY_PREFIX}${serverId}` +
      VAULT_SHARED_SECRET_MCP_KEY_SUFFIX,
  };
}

export const VAULT_SHARED_SECRET_STATIC_DEFINITIONS =
  STATIC_DEFINITIONS;

export function vaultSharedSecretDefinitionForAiConnection(
  connectionId: string,
) {
  return dynamicAiDefinition(connectionId);
}

export function vaultSharedSecretDefinitionForMcpServer(
  serverId: string,
) {
  return dynamicMcpDefinition(serverId);
}

export function findVaultSharedSecretByStorageKey(
  storageKey: string,
): VaultSharedSecretDefinition | undefined {
  const staticDefinition = STATIC_DEFINITIONS.find(
    (definition) => definition.storageKey === storageKey,
  );
  if (staticDefinition) return staticDefinition;
  if (storageKey.startsWith(VAULT_SHARED_SECRET_AI_KEY_PREFIX)) {
    return dynamicAiDefinition(
      storageKey.slice(VAULT_SHARED_SECRET_AI_KEY_PREFIX.length),
    );
  }
  if (
    storageKey.startsWith(VAULT_SHARED_SECRET_MCP_KEY_PREFIX)
    && storageKey.endsWith(VAULT_SHARED_SECRET_MCP_KEY_SUFFIX)
  ) {
    return dynamicMcpDefinition(
      storageKey.slice(
        VAULT_SHARED_SECRET_MCP_KEY_PREFIX.length,
        -VAULT_SHARED_SECRET_MCP_KEY_SUFFIX.length,
      ),
    );
  }
  return undefined;
}

export function findVaultSharedSecretBySecretId(
  secretId: string,
): VaultSharedSecretDefinition | undefined {
  const staticDefinition = STATIC_DEFINITIONS.find(
    (definition) => definition.secretId === secretId,
  );
  if (staticDefinition) return staticDefinition;
  const aiPrefix = 'service-secret:ai-connection:';
  if (secretId.startsWith(aiPrefix)) {
    return dynamicAiDefinition(secretId.slice(aiPrefix.length));
  }
  const mcpPrefix = 'service-secret:mcp:';
  if (secretId.startsWith(mcpPrefix)) {
    return dynamicMcpDefinition(secretId.slice(mcpPrefix.length));
  }
  return undefined;
}

export function collectVaultSharedSecretDefinitions(input: {
  aiConnectionIds?: readonly string[];
  mcpServerIds?: readonly string[];
}) {
  const dynamic = [
    ...(input.aiConnectionIds ?? []).map(dynamicAiDefinition),
    ...(input.mcpServerIds ?? []).map(dynamicMcpDefinition),
  ].filter(
    (definition): definition is VaultSharedSecretDefinition =>
      definition !== undefined,
  );
  return Array.from(new Map(
    [...STATIC_DEFINITIONS, ...dynamic].map(
      (definition) => [definition.secretId, definition],
    ),
  ).values());
}
