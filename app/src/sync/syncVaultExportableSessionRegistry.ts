export const NETEASE_MUSIC_U_SECRET_KEY =
  'private.junluo.netease.musicU' as const;

export const VAULT_EXPORTABLE_SESSION_TYPES = [
  'netease-music-cookie',
] as const;

export type VaultExportableSessionType =
  (typeof VAULT_EXPORTABLE_SESSION_TYPES)[number];

export type VaultExportableSessionDefinition = {
  secretId: string;
  sessionType: VaultExportableSessionType;
  serviceId: string;
  storageKey: string;
};

export const VAULT_EXPORTABLE_SESSION_DEFINITIONS:
readonly VaultExportableSessionDefinition[] = Object.freeze([
  Object.freeze({
    secretId: 'exportable-session:netease-music:default',
    sessionType: 'netease-music-cookie',
    serviceId: 'netease-music',
    storageKey: NETEASE_MUSIC_U_SECRET_KEY,
  }),
]);

export const VAULT_EXPORTABLE_SESSION_SECRET_KEYS = Object.freeze(
  VAULT_EXPORTABLE_SESSION_DEFINITIONS.map(
    (definition) => definition.storageKey,
  ),
);

export function findVaultExportableSessionByStorageKey(
  storageKey: string,
) {
  return VAULT_EXPORTABLE_SESSION_DEFINITIONS.find(
    (definition) => definition.storageKey === storageKey,
  );
}

export function findVaultExportableSessionBySecretId(
  secretId: string,
) {
  return VAULT_EXPORTABLE_SESSION_DEFINITIONS.find(
    (definition) => definition.secretId === secretId,
  );
}
