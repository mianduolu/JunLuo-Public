import type { ChatCoreMutationEnvelope } from './syncChatCore';
import {
  assertVaultSharedSecretMutationV1,
  VAULT_SHARED_SECRETS_ADAPTER_ID,
  VAULT_SHARED_SECRET_ENTITY_TYPE,
  type VaultSharedSecretRecordV1,
} from './syncVaultSharedSecrets';
import type {
  VaultSharedSecretDefinition,
} from './syncVaultSharedSecretRegistry';
import type { JsonValue, PlainMutationV1 } from './syncProtocol';

export type VaultSharedSecretProjection = {
  definition: VaultSharedSecretDefinition;
  secretValue: string;
};

export type VaultSharedSecretReadPort = {
  getItem(key: string): Promise<string | null>;
};

export type VaultSharedSecretEnvelopeFactory = (
  entity: {
    domain: 'vault';
    type: typeof VAULT_SHARED_SECRET_ENTITY_TYPE;
    id: string;
  },
) => Promise<ChatCoreMutationEnvelope>;

export type VaultSharedSecretWrapPort = (
  input: {
    definition: VaultSharedSecretDefinition;
    secretValue: string;
    updatedAt: number;
  },
) => Promise<VaultSharedSecretRecordV1>;

function normalizeSecretValue(value: string | null) {
  const normalized = value?.trim() ?? '';
  return normalized || null;
}

export async function readVaultSharedSecretProjection(
  reader: VaultSharedSecretReadPort,
  definitions: readonly VaultSharedSecretDefinition[],
) {
  const entries = await Promise.all(
    definitions.map(async (definition) => ({
      definition,
      secretValue: normalizeSecretValue(
        await reader.getItem(definition.storageKey),
      ),
    })),
  );
  return entries.flatMap((entry) => (
    entry.secretValue === null
      ? []
      : [{
          definition: entry.definition,
          secretValue: entry.secretValue,
        }]
  ));
}

function buildUpsertMutation(input: {
  envelope: ChatCoreMutationEnvelope;
  record: VaultSharedSecretRecordV1;
  operation?: 'upsert' | 'restore';
}) {
  const mutation: PlainMutationV1 = {
    protocolVersion: 1,
    mutationId: input.envelope.mutationId,
    vaultId: input.envelope.vaultId,
    sourceDeviceId: input.envelope.sourceDeviceId,
    sourceSequence: input.envelope.sourceSequence,
    createdAt: input.envelope.createdAt,
    entity: {
      domain: 'vault',
      type: VAULT_SHARED_SECRET_ENTITY_TYPE,
      id: input.record.secretId,
    },
    revision: {
      id: input.envelope.revisionId,
      parents: input.envelope.parentRevisionIds,
      operation: input.operation ?? 'upsert',
      schemaVersion: 1,
    },
    sensitivity: 'highest',
    payload: {
      kind: 'service-secret',
      secret: input.record as unknown as JsonValue,
    },
    objectRefs: [],
    retentionClass: 'vault-shared-secret',
  };
  assertVaultSharedSecretMutationV1(mutation);
  return mutation;
}

function buildDeleteMutation(input: {
  envelope: ChatCoreMutationEnvelope;
  definition: VaultSharedSecretDefinition;
  revokedAt: number;
}) {
  const mutation: PlainMutationV1 = {
    protocolVersion: 1,
    mutationId: input.envelope.mutationId,
    vaultId: input.envelope.vaultId,
    sourceDeviceId: input.envelope.sourceDeviceId,
    sourceSequence: input.envelope.sourceSequence,
    createdAt: input.envelope.createdAt,
    entity: {
      domain: 'vault',
      type: VAULT_SHARED_SECRET_ENTITY_TYPE,
      id: input.definition.secretId,
    },
    revision: {
      id: input.envelope.revisionId,
      parents: input.envelope.parentRevisionIds,
      operation: 'delete',
      schemaVersion: 1,
    },
    sensitivity: 'highest',
    payload: {
      kind: 'service-secret',
      secretId: input.definition.secretId,
      credentialType: input.definition.credentialType,
      deleteMode: 'vault-revoke',
      revokedAt: input.revokedAt,
    },
    objectRefs: [],
    retentionClass: 'vault-revoke-trash-30d',
  };
  assertVaultSharedSecretMutationV1(mutation);
  return mutation;
}

function projectionById(
  projection: readonly VaultSharedSecretProjection[],
) {
  return new Map(
    projection.map((entry) => [
      entry.definition.secretId,
      entry,
    ]),
  );
}

export async function deriveVaultSharedSecretMutations(input: {
  previous: readonly VaultSharedSecretProjection[];
  next: readonly VaultSharedSecretProjection[];
  capturedAt: number;
  envelopeFactory: VaultSharedSecretEnvelopeFactory;
  wrapSecret: VaultSharedSecretWrapPort;
}) {
  const previousById = projectionById(input.previous);
  const nextById = projectionById(input.next);
  const mutations: PlainMutationV1[] = [];
  for (const next of input.next) {
    const previous = previousById.get(next.definition.secretId);
    if (previous?.secretValue === next.secretValue) continue;
    const envelope = await input.envelopeFactory({
      domain: 'vault',
      type: VAULT_SHARED_SECRET_ENTITY_TYPE,
      id: next.definition.secretId,
    });
    const record = await input.wrapSecret({
      definition: next.definition,
      secretValue: next.secretValue,
      updatedAt: input.capturedAt,
    });
    mutations.push(buildUpsertMutation({
      envelope: { ...envelope, createdAt: input.capturedAt },
      record,
    }));
  }
  for (const previous of input.previous) {
    if (nextById.has(previous.definition.secretId)) continue;
    const envelope = await input.envelopeFactory({
      domain: 'vault',
      type: VAULT_SHARED_SECRET_ENTITY_TYPE,
      id: previous.definition.secretId,
    });
    mutations.push(buildDeleteMutation({
      envelope: { ...envelope, createdAt: input.capturedAt },
      definition: previous.definition,
      revokedAt: input.capturedAt,
    }));
  }
  return mutations;
}

export function isVaultSharedSecretsAdapter(adapterId: string) {
  return adapterId === VAULT_SHARED_SECRETS_ADAPTER_ID;
}
