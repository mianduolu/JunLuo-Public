import {
  findVaultSharedSecretBySecretId,
  findVaultSharedSecretByStorageKey,
  VAULT_SHARED_SECRET_STATIC_DEFINITIONS,
  type VaultSharedSecretDefinition,
} from '../sync/syncVaultSharedSecretRegistry';
import {
  findVaultExportableSessionBySecretId,
  findVaultExportableSessionByStorageKey,
  VAULT_EXPORTABLE_SESSION_DEFINITIONS,
  type VaultExportableSessionDefinition,
} from '../sync/syncVaultExportableSessionRegistry';

export type SecretPackageEntryKindV1 =
  | 'service-credential'
  | 'exportable-session';

export type SecretPackageDefinitionV1 = {
  kind: SecretPackageEntryKindV1;
  secretId: string;
  credentialType: string;
  serviceId: string;
  storageKey: string;
  label: string;
  requiresRelatedConfiguration: boolean;
};

const STATIC_LABELS: Readonly<Record<string, string>> = Object.freeze({
  'service-secret:ai:legacy': '旧式 AI 连接',
  'service-secret:embedding:default': '记忆 Embedding',
  'service-secret:voice:minimax-api-key': 'MiniMax API Key',
  'service-secret:voice:minimax-group-id': 'MiniMax Group ID',
  'service-secret:voice:minimax-voice-id': 'MiniMax Voice ID',
  'service-secret:voice:backend-token': '君落语音后端 token',
  'service-secret:github:default': 'GitHub token',
  'service-secret:amap:default': '高德 API Key',
  'exportable-session:netease-music:default': '网易云登录态',
});

function labelForDefinition(secretId: string, serviceId: string) {
  const fixed = STATIC_LABELS[secretId];
  if (fixed) return fixed;
  if (serviceId.startsWith('ai:')) {
    return `AI 连接 · ${serviceId.slice(3)}`;
  }
  if (serviceId.startsWith('mcp:')) {
    return `MCP · ${serviceId.slice(4)}`;
  }
  return serviceId;
}

function fromSharedSecret(
  definition: VaultSharedSecretDefinition,
): SecretPackageDefinitionV1 {
  return {
    kind: 'service-credential',
    secretId: definition.secretId,
    credentialType: definition.credentialType,
    serviceId: definition.serviceId,
    storageKey: definition.storageKey,
    label: labelForDefinition(
      definition.secretId,
      definition.serviceId,
    ),
    requiresRelatedConfiguration:
      definition.secretId.startsWith('service-secret:ai-connection:')
      || definition.secretId.startsWith('service-secret:mcp:'),
  };
}

function fromExportableSession(
  definition: VaultExportableSessionDefinition,
): SecretPackageDefinitionV1 {
  return {
    kind: 'exportable-session',
    secretId: definition.secretId,
    credentialType: definition.sessionType,
    serviceId: definition.serviceId,
    storageKey: definition.storageKey,
    label: labelForDefinition(
      definition.secretId,
      definition.serviceId,
    ),
    requiresRelatedConfiguration: false,
  };
}

export const SECRET_PACKAGE_STATIC_DEFINITIONS_V1 = Object.freeze([
  ...VAULT_SHARED_SECRET_STATIC_DEFINITIONS.map(fromSharedSecret),
  ...VAULT_EXPORTABLE_SESSION_DEFINITIONS.map(fromExportableSession),
]);

export function findSecretPackageDefinitionBySecretIdV1(
  secretId: string,
) {
  const shared = findVaultSharedSecretBySecretId(secretId);
  if (shared) return fromSharedSecret(shared);
  const session = findVaultExportableSessionBySecretId(secretId);
  return session ? fromExportableSession(session) : undefined;
}

export function findSecretPackageDefinitionByStorageKeyV1(
  storageKey: string,
) {
  const shared = findVaultSharedSecretByStorageKey(storageKey);
  if (shared) return fromSharedSecret(shared);
  const session = findVaultExportableSessionByStorageKey(storageKey);
  return session ? fromExportableSession(session) : undefined;
}

export function collectSecretPackageDefinitionsV1(
  secretIds: readonly string[],
) {
  return Array.from(new Map([
    ...SECRET_PACKAGE_STATIC_DEFINITIONS_V1,
    ...secretIds.map(findSecretPackageDefinitionBySecretIdV1)
      .filter((item): item is SecretPackageDefinitionV1 => !!item),
  ].map((item) => [item.secretId, item])).values());
}
