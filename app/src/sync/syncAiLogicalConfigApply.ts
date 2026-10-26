import RawAsyncStorage from '@react-native-async-storage/async-storage';

import {
  AI_LOGICAL_CONFIG_ALIAS_IDS,
  aiLogicalConfigEntityId,
  aiLogicalConfigMutationValue,
  assertAiLogicalConfigMutationV1,
  assertAiLogicalConfigRecord,
  type AiLogicalConfigAliasId,
  type AiLogicalConfigRecordKind,
  type AiLogicalConfigRecordValue,
  type AiLogicalConnection,
  type AiLogicalModelRoute,
  type AiLogicalProfile,
  type AiLogicalServiceAlias,
  type AiLogicalVoiceSetting,
} from './syncAiLogicalConfig';
import {
  AI_LOGICAL_CONFIG_BACKEND_KEY,
  AI_LOGICAL_CONFIG_CONNECTIONS_KEY,
  AI_LOGICAL_CONFIG_EMBEDDING_KEY,
  AI_LOGICAL_CONFIG_PROFILE_KEY,
  AI_LOGICAL_CONFIG_RERANKER_KEY,
  AI_LOGICAL_CONFIG_VOICE_KEY,
} from './syncAiLogicalConfigDerivation';
import type {
  SyncMutationBatchCapturePolicy,
  SyncMutationBusinessApplier,
} from './syncMutationBatchCapture';
import type { PlainMutationV1 } from './syncProtocol';

export type AiLogicalConfigRevisionContext = {
  revisionId: string;
  parentRevisionIds: string[];
  sourceDeviceId: string;
  sourceSequence: number;
  createdAt: number;
};

export interface AiLogicalConfigBusinessPort {
  upsert(input: {
    kind: AiLogicalConfigRecordKind;
    value: AiLogicalConfigRecordValue;
    revision: AiLogicalConfigRevisionContext;
  }): Promise<void>;
  tombstone(input: {
    kind: AiLogicalConfigRecordKind;
    entityId: string;
    deletedAt: number;
    revision: AiLogicalConfigRevisionContext;
  }): Promise<void>;
}

function revisionContext(
  mutation: PlainMutationV1,
): AiLogicalConfigRevisionContext {
  return {
    revisionId: mutation.revision.id,
    parentRevisionIds: [...mutation.revision.parents],
    sourceDeviceId: mutation.sourceDeviceId,
    sourceSequence: mutation.sourceSequence,
    createdAt: mutation.createdAt,
  };
}

export class AiLogicalConfigBusinessApplier
implements SyncMutationBusinessApplier {
  constructor(private readonly port: AiLogicalConfigBusinessPort) {}

  async applySyncMutation(mutation: PlainMutationV1) {
    assertAiLogicalConfigMutationV1(mutation);
    const decoded = aiLogicalConfigMutationValue(mutation);
    const revision = revisionContext(mutation);
    if (mutation.revision.operation === 'delete') {
      await this.port.tombstone({
        kind: decoded.kind,
        entityId: mutation.entity.id,
        deletedAt: decoded.deletedAt!,
        revision,
      });
      return;
    }
    await this.port.upsert({
      kind: decoded.kind,
      value: decoded.value!,
      revision,
    });
  }
}

export const AI_LOGICAL_CONFIG_BATCH_CAPTURE_POLICY:
SyncMutationBatchCapturePolicy = {
  adapterId: 'ai.logical-config',
  isMutationAllowed(mutation) {
    try {
      assertAiLogicalConfigMutationV1(mutation);
      return true;
    } catch {
      return false;
    }
  },
};

type UnknownRecord = Record<string, unknown>;

const ALIAS_STORAGE_KEYS: Readonly<Record<
  AiLogicalConfigAliasId,
  string
>> = {
  chat: 'chatConnectionId',
  baiyunBehavior: 'baiyunBehaviorConnectionId',
  vision: 'visionConnectionId',
  audioUnderstanding: 'audioUnderstandingConnectionId',
  utilityJson: 'utilityJsonConnectionId',
  memoryOrganizer: 'memoryOrganizerConnectionId',
  memoryReranker: 'memoryRerankerConnectionId',
  imageGeneration: 'imageGenerationConnectionId',
  financeReasoning: 'financeReasoningConnectionId',
  lifeCreative: 'lifeCreativeConnectionId',
  asr: 'asrConnectionId',
};

let applyQueue = Promise.resolve();

function enqueueApply<T>(callback: () => Promise<T>) {
  const current = applyQueue.catch(() => undefined).then(callback);
  applyQueue = current.then(
    () => undefined,
    () => undefined,
  );
  return current;
}

function parseObject(raw: string | null) {
  if (!raw) return {} as UnknownRecord;
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as UnknownRecord
      : {};
  } catch {
    return {};
  }
}

function parseConnections(root: UnknownRecord) {
  return Array.isArray(root.connections)
    ? root.connections.filter(
        (value): value is UnknownRecord =>
          !!value && typeof value === 'object' && !Array.isArray(value),
      )
    : [];
}

function materializedAddress(input: {
  current: unknown;
  portable?: string;
  requiresDeviceBinding: boolean;
}) {
  if (!input.requiresDeviceBinding && input.portable) return input.portable;
  return typeof input.current === 'string' ? input.current : '';
}

async function invalidateAiSnapshot() {
  const { invalidateAiConfigPreferencesSnapshot } = await import(
    '../ai/AiConfigPreferences'
  );
  invalidateAiConfigPreferencesSnapshot();
}

async function upsertConnection(value: AiLogicalConnection) {
  const root = parseObject(
    await RawAsyncStorage.getItem(AI_LOGICAL_CONFIG_CONNECTIONS_KEY),
  );
  const connections = parseConnections(root);
  const existing = connections.find((entry) => entry.id === value.connectionId);
  const nextValue: UnknownRecord = {
    ...(existing ?? {}),
    id: value.connectionId,
    name: value.name,
    provider: value.provider,
    preset: value.preset,
    baseUrl: materializedAddress({
      current: existing?.baseUrl,
      portable: value.portableBaseUrl,
      requiresDeviceBinding: value.requiresDeviceBinding,
    }),
    model: value.model,
    chatJsonOutputEnabled: value.chatJsonOutputEnabled,
    contextWindowTokens: value.contextWindowTokens,
    contextCompressionEnabled: value.contextCompressionEnabled,
    contextCompressionThreshold: value.contextCompressionThreshold,
    contextCompressionByMessageCount:
      value.contextCompressionByMessageCount,
    contextCompressionMessageThreshold:
      value.contextCompressionMessageThreshold,
  };
  if (value.modelParameters) {
    nextValue.modelParameters = value.modelParameters;
  } else {
    delete nextValue.modelParameters;
  }
  await RawAsyncStorage.setItem(
    AI_LOGICAL_CONFIG_CONNECTIONS_KEY,
    JSON.stringify({
      ...root,
      connections: [
        ...connections.filter((entry) => entry.id !== value.connectionId),
        nextValue,
      ],
    }),
  );
  await invalidateAiSnapshot();
}

async function upsertAlias(value: AiLogicalServiceAlias) {
  const root = parseObject(
    await RawAsyncStorage.getItem(AI_LOGICAL_CONFIG_CONNECTIONS_KEY),
  );
  await RawAsyncStorage.setItem(
    AI_LOGICAL_CONFIG_CONNECTIONS_KEY,
    JSON.stringify({
      ...root,
      [ALIAS_STORAGE_KEYS[value.aliasId]]: value.connectionId,
    }),
  );
  await invalidateAiSnapshot();
}

async function upsertProfile(value: AiLogicalProfile) {
  await RawAsyncStorage.setItem(
    AI_LOGICAL_CONFIG_PROFILE_KEY,
    JSON.stringify({
      ...(typeof value.corePersona === 'string' && value.corePersona.trim()
        ? { corePersona: value.corePersona } : {}),
      systemPrompt: value.systemPrompt,
      userNote: value.userNote,
      proactiveMemorySuggestions: value.proactiveMemorySuggestions,
      automaticExplicitFactMemories:
        value.automaticExplicitFactMemories,
    }),
  );
  await invalidateAiSnapshot();
}

async function upsertModelRoute(value: AiLogicalModelRoute) {
  if (value.routeType === 'reranker') {
    await RawAsyncStorage.setItem(
      AI_LOGICAL_CONFIG_RERANKER_KEY,
      JSON.stringify({
        enabled: value.enabled,
        mode: value.mode,
        candidateLimit: value.candidateLimit,
        timeoutMs: value.timeoutMs,
        updatedAt: value.updatedAt,
      }),
    );
    return;
  }
  const storageKey = value.routeType === 'embedding'
    ? AI_LOGICAL_CONFIG_EMBEDDING_KEY
    : AI_LOGICAL_CONFIG_BACKEND_KEY;
  const current = parseObject(await RawAsyncStorage.getItem(storageKey));
  if (value.routeType === 'embedding') {
    await RawAsyncStorage.setItem(
      storageKey,
      JSON.stringify({
        enabled: value.enabled,
        baseUrl: materializedAddress({
          current: current.baseUrl,
          portable: value.portableBaseUrl,
          requiresDeviceBinding: value.requiresDeviceBinding,
        }),
        model: value.model,
        updatedAt: value.updatedAt,
      }),
    );
    return;
  }
  await RawAsyncStorage.setItem(
    storageKey,
    JSON.stringify({
      enabled: value.desiredEnabled,
      baseUrl: materializedAddress({
        current: current.baseUrl,
        portable: value.portableBaseUrl,
        requiresDeviceBinding: value.requiresDeviceBinding,
      }),
    }),
  );
}

async function upsertVoice(value: AiLogicalVoiceSetting) {
  const current = parseObject(
    await RawAsyncStorage.getItem(AI_LOGICAL_CONFIG_VOICE_KEY),
  );
  const uplinkMode = current.uplinkMode === 'livekit'
    || current.uplinkMode === 'native'
    ? current.uplinkMode
    : 'auto';
  await RawAsyncStorage.setItem(
    AI_LOGICAL_CONFIG_VOICE_KEY,
    JSON.stringify({
      autonomousIncomingCallsEnabled: current.autonomousIncomingCallsEnabled === true,
      dailyCharacterLimit: value.dailyCharacterLimit,
      emotion2vecEnabled: value.emotion2vecEnabled,
      enabled: value.enabled,
      maxCallMinutes: value.maxCallMinutes,
      maxNewSynthesesPerCall: value.maxNewSynthesesPerCall ?? 4,
      minimaxBaseUrl: materializedAddress({
        current: current.minimaxBaseUrl,
        portable: value.portableMinimaxBaseUrl,
        requiresDeviceBinding: value.requiresDeviceBinding,
      }),
      minimaxModel: value.minimaxModel,
      saveCallSummary: value.saveCallSummary,
      saveRawAudio: false,
      sttProvider: value.sttProvider,
      uplinkMode,
    }),
  );
}

async function upsertRecord(
  kind: AiLogicalConfigRecordKind,
  value: AiLogicalConfigRecordValue,
) {
  assertAiLogicalConfigRecord(kind, value);
  if (kind === 'connection') {
    return upsertConnection(value as AiLogicalConnection);
  }
  if (kind === 'service-alias') {
    return upsertAlias(value as AiLogicalServiceAlias);
  }
  if (kind === 'profile') return upsertProfile(value as AiLogicalProfile);
  if (kind === 'model-route') {
    return upsertModelRoute(value as AiLogicalModelRoute);
  }
  return upsertVoice(value as AiLogicalVoiceSetting);
}

async function tombstoneConnection(entityId: string) {
  const root = parseObject(
    await RawAsyncStorage.getItem(AI_LOGICAL_CONFIG_CONNECTIONS_KEY),
  );
  const connections = parseConnections(root);
  const target = connections.find((entry) => (
    typeof entry.id === 'string'
    && aiLogicalConfigEntityId('connection', entry.id) === entityId
  ));
  if (!target || typeof target.id !== 'string') return;
  const next: UnknownRecord = {
    ...root,
    connections: connections.filter((entry) => entry.id !== target.id),
  };
  for (const aliasId of AI_LOGICAL_CONFIG_ALIAS_IDS) {
    const key = ALIAS_STORAGE_KEYS[aliasId];
    if (next[key] === target.id) delete next[key];
  }
  await RawAsyncStorage.setItem(
    AI_LOGICAL_CONFIG_CONNECTIONS_KEY,
    JSON.stringify(next),
  );
  await invalidateAiSnapshot();
}

async function tombstoneAlias(entityId: string) {
  const aliasId = AI_LOGICAL_CONFIG_ALIAS_IDS.find((candidate) =>
    aiLogicalConfigEntityId('service-alias', candidate) === entityId);
  if (!aliasId) return;
  const root = parseObject(
    await RawAsyncStorage.getItem(AI_LOGICAL_CONFIG_CONNECTIONS_KEY),
  );
  delete root[ALIAS_STORAGE_KEYS[aliasId]];
  await RawAsyncStorage.setItem(
    AI_LOGICAL_CONFIG_CONNECTIONS_KEY,
    JSON.stringify(root),
  );
  await invalidateAiSnapshot();
}

async function tombstoneRecord(
  kind: AiLogicalConfigRecordKind,
  entityId: string,
) {
  if (kind === 'connection') return tombstoneConnection(entityId);
  if (kind === 'service-alias') return tombstoneAlias(entityId);
  if (
    kind === 'profile'
    && aiLogicalConfigEntityId(kind, 'default') === entityId
  ) {
    await RawAsyncStorage.removeItem(AI_LOGICAL_CONFIG_PROFILE_KEY);
    await invalidateAiSnapshot();
    return;
  }
  if (kind === 'model-route') {
    for (const [routeId, storageKey] of [
      ['embedding', AI_LOGICAL_CONFIG_EMBEDDING_KEY],
      ['reranker', AI_LOGICAL_CONFIG_RERANKER_KEY],
      ['backend', AI_LOGICAL_CONFIG_BACKEND_KEY],
    ] as const) {
      if (aiLogicalConfigEntityId(kind, routeId) === entityId) {
        await RawAsyncStorage.removeItem(storageKey);
        return;
      }
    }
  }
  if (
    kind === 'voice-setting'
    && aiLogicalConfigEntityId(kind, 'default') === entityId
  ) {
    const current = parseObject(
      await RawAsyncStorage.getItem(AI_LOGICAL_CONFIG_VOICE_KEY),
    );
    await RawAsyncStorage.setItem(
      AI_LOGICAL_CONFIG_VOICE_KEY,
      JSON.stringify({
        autonomousIncomingCallsEnabled: current.autonomousIncomingCallsEnabled === true,
        minimaxBaseUrl: materializedAddress({
          current: current.minimaxBaseUrl,
          requiresDeviceBinding: true,
        }),
        uplinkMode: current.uplinkMode === 'livekit' || current.uplinkMode === 'native'
          ? current.uplinkMode
          : 'auto',
      }),
    );
  }
}

export const aiLogicalConfigAsyncStorageBusinessPort:
AiLogicalConfigBusinessPort = {
  upsert: (input) => enqueueApply(
    () => upsertRecord(input.kind, input.value),
  ),
  tombstone: (input) => enqueueApply(
    () => tombstoneRecord(input.kind, input.entityId),
  ),
};
