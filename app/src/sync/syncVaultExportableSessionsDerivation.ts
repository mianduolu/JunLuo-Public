import type { ChatCoreMutationEnvelope } from './syncChatCore';
import {
  assertVaultExportableSessionMutationV1,
  VAULT_EXPORTABLE_SESSIONS_ADAPTER_ID,
  VAULT_EXPORTABLE_SESSION_ENTITY_TYPE,
  type VaultExportableSessionRecordV1,
} from './syncVaultExportableSessions';
import {
  VAULT_EXPORTABLE_SESSION_DEFINITIONS,
  type VaultExportableSessionDefinition,
} from './syncVaultExportableSessionRegistry';
import type { JsonValue, PlainMutationV1 } from './syncProtocol';

export type VaultExportableSessionProjection = {
  definition: VaultExportableSessionDefinition;
  secretValue: string;
};

export type VaultExportableSessionReadPort = {
  getItem(key: string): Promise<string | null>;
};

export type VaultExportableSessionEnvelopeFactory = (
  entity: {
    domain: 'vault';
    type: typeof VAULT_EXPORTABLE_SESSION_ENTITY_TYPE;
    id: string;
  },
) => Promise<ChatCoreMutationEnvelope>;

export type VaultExportableSessionWrapPort = (
  input: {
    definition: VaultExportableSessionDefinition;
    secretValue: string;
    updatedAt: number;
  },
) => Promise<VaultExportableSessionRecordV1>;

function normalizeSecretValue(value: string | null) {
  const normalized = value?.trim() ?? '';
  return normalized || null;
}

export async function readVaultExportableSessionProjection(
  reader: VaultExportableSessionReadPort,
) {
  const entries = await Promise.all(
    VAULT_EXPORTABLE_SESSION_DEFINITIONS.map(async (definition) => ({
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
  record: VaultExportableSessionRecordV1;
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
      type: VAULT_EXPORTABLE_SESSION_ENTITY_TYPE,
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
      kind: 'exportable-session',
      session: input.record as unknown as JsonValue,
    },
    objectRefs: [],
    retentionClass: 'vault-exportable-session',
  };
  assertVaultExportableSessionMutationV1(mutation);
  return mutation;
}

function buildDeleteMutation(input: {
  envelope: ChatCoreMutationEnvelope;
  definition: VaultExportableSessionDefinition;
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
      type: VAULT_EXPORTABLE_SESSION_ENTITY_TYPE,
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
      kind: 'exportable-session',
      secretId: input.definition.secretId,
      sessionType: input.definition.sessionType,
      deleteMode: 'vault-revoke',
      revokedAt: input.revokedAt,
    },
    objectRefs: [],
    retentionClass: 'vault-revoke-trash-30d',
  };
  assertVaultExportableSessionMutationV1(mutation);
  return mutation;
}

function projectionById(
  projection: readonly VaultExportableSessionProjection[],
) {
  return new Map(
    projection.map((entry) => [
      entry.definition.secretId,
      entry,
    ]),
  );
}

export async function deriveVaultExportableSessionMutations(input: {
  previous: readonly VaultExportableSessionProjection[];
  next: readonly VaultExportableSessionProjection[];
  capturedAt: number;
  envelopeFactory: VaultExportableSessionEnvelopeFactory;
  wrapSecret: VaultExportableSessionWrapPort;
}) {
  const previousById = projectionById(input.previous);
  const nextById = projectionById(input.next);
  const mutations: PlainMutationV1[] = [];
  for (const next of input.next) {
    const previous = previousById.get(next.definition.secretId);
    if (previous?.secretValue === next.secretValue) continue;
    const envelope = await input.envelopeFactory({
      domain: 'vault',
      type: VAULT_EXPORTABLE_SESSION_ENTITY_TYPE,
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
      type: VAULT_EXPORTABLE_SESSION_ENTITY_TYPE,
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

export function isVaultExportableSessionAdapter(
  adapterId: string,
) {
  return adapterId === VAULT_EXPORTABLE_SESSIONS_ADAPTER_ID;
}
