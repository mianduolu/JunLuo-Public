import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

import type { ChatCoreMutationEnvelope } from './syncChatCore';
import { bytesToBase64Url } from './syncBase64Url';
import {
  assertPlainMutationV1,
  type JsonValue,
  type PlainMutationV1,
} from './syncProtocol';

export const AI_LOGICAL_CONFIG_ADAPTER_ID = 'ai.logical-config' as const;
export const AI_LOGICAL_CONFIG_SCHEMA_VERSION = 1 as const;
export const AI_LOGICAL_CONFIG_RETENTION =
  'ai-logical-config-long-term' as const;

export const AI_LOGICAL_CONFIG_RECORD_KINDS = [
  'connection',
  'service-alias',
  'profile',
  'model-route',
  'voice-setting',
] as const;

export type AiLogicalConfigRecordKind =
  typeof AI_LOGICAL_CONFIG_RECORD_KINDS[number];

export const AI_LOGICAL_CONFIG_ALIAS_IDS = [
  'chat',
  'baiyunBehavior',
  'vision',
  'audioUnderstanding',
  'utilityJson',
  'memoryOrganizer',
  'memoryReranker',
  'imageGeneration',
  'financeReasoning',
  'lifeCreative',
  'asr',
] as const;

export type AiLogicalConfigAliasId =
  typeof AI_LOGICAL_CONFIG_ALIAS_IDS[number];

export type AiLogicalModelParameter = {
  enabled: boolean;
  value: number;
};

export type AiLogicalModelParameters = Partial<Record<
  | 'maxTokens'
  | 'temperature'
  | 'topP'
  | 'presencePenalty'
  | 'frequencyPenalty',
  AiLogicalModelParameter
>>;

export type AiLogicalConnection = {
  connectionId: string;
  name: string;
  provider: 'openai-compatible';
  preset: 'deepseek' | 'qwen' | 'gemini' | 'ollama' | 'gateway' | 'custom';
  model: string;
  requiresDeviceBinding: boolean;
  portableBaseUrl?: string;
  chatJsonOutputEnabled: boolean;
  modelParameters?: AiLogicalModelParameters;
  contextWindowTokens: number;
  contextCompressionEnabled: boolean;
  contextCompressionThreshold: number;
  contextCompressionByMessageCount: boolean;
  contextCompressionMessageThreshold: number;
};

export type AiLogicalServiceAlias = {
  aliasId: AiLogicalConfigAliasId;
  connectionId: string;
};

export type AiLogicalProfile = {
  profileId: 'default';
  corePersona?: string;
  systemPrompt: string;
  userNote: string;
  proactiveMemorySuggestions: boolean;
  automaticExplicitFactMemories: boolean;
};

export type AiLogicalEmbeddingRoute = {
  routeId: 'embedding';
  routeType: 'embedding';
  enabled: boolean;
  model: string;
  requiresDeviceBinding: boolean;
  portableBaseUrl?: string;
  updatedAt: number;
};

export type AiLogicalRerankerRoute = {
  routeId: 'reranker';
  routeType: 'reranker';
  enabled: boolean;
  mode: 'manual' | 'conditional' | 'always';
  candidateLimit: number;
  timeoutMs: number;
  updatedAt: number;
};

export type AiLogicalBackendRoute = {
  routeId: 'backend';
  routeType: 'backend';
  desiredEnabled: boolean;
  requiresDeviceBinding: boolean;
  portableBaseUrl?: string;
};

export type AiLogicalModelRoute =
  | AiLogicalEmbeddingRoute
  | AiLogicalRerankerRoute
  | AiLogicalBackendRoute;

export type AiLogicalVoiceSetting = {
  voiceId: 'default';
  dailyCharacterLimit: number;
  emotion2vecEnabled: boolean;
  enabled: boolean;
  maxCallMinutes: number;
  maxNewSynthesesPerCall?: number;
  requiresDeviceBinding: boolean;
  portableMinimaxBaseUrl?: string;
  minimaxModel: string;
  saveCallSummary: boolean;
  sttProvider: 'cloud' | 'funasr';
};

export type AiLogicalConfigRecordValue =
  | AiLogicalConnection
  | AiLogicalServiceAlias
  | AiLogicalProfile
  | AiLogicalModelRoute
  | AiLogicalVoiceSetting;

type UnknownRecord = Record<string, unknown>;

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function recordOf(value: unknown, label: string): UnknownRecord {
  expect(
    !!value && typeof value === 'object' && !Array.isArray(value),
    `${label} 必须是对象。`,
  );
  return value as UnknownRecord;
}

function assertKeys(
  value: UnknownRecord,
  required: readonly string[],
  optional: readonly string[],
  label: string,
) {
  const allowed = new Set([...required, ...optional]);
  expect(
    required.every((key) => key in value)
      && Object.keys(value).every((key) => allowed.has(key)),
    `${label} 字段集合无效。`,
  );
}

function assertString(
  value: unknown,
  label: string,
  maximum: number,
  allowEmpty = false,
) {
  expect(
    typeof value === 'string'
      && (allowEmpty || value.length > 0)
      && value.length <= maximum
      && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value),
    `${label} 无效。`,
  );
}

function assertBoolean(value: unknown, label: string) {
  expect(typeof value === 'boolean', `${label} 必须是 boolean。`);
}

function assertOpaqueText(value: unknown, label: string) {
  expect(
    typeof value === 'string' && value.length <= 1_000_000,
    `${label} 无效。`,
  );
}

function assertInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
) {
  expect(
    Number.isSafeInteger(value)
      && Number(value) >= minimum
      && Number(value) <= maximum,
    `${label} 无效。`,
  );
}

function assertFinite(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
) {
  expect(
    typeof value === 'number'
      && Number.isFinite(value)
      && value >= minimum
      && value <= maximum,
    `${label} 无效。`,
  );
}

function privateHost(hostname: string) {
  const host = hostname.toLowerCase();
  return host === 'localhost'
    || host === '0.0.0.0'
    || host === '::1'
    || host.endsWith('.local')
    || /^(127\.|10\.|169\.254\.|192\.168\.)/.test(host)
    || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host);
}

const URL_SECRET_PARAMETER =
  /^(token|access_token|auth|authorization|key|api_key|apikey|secret|password|signature|sig)$/i;

function assertPortableUrl(value: unknown, label: string) {
  assertString(value, label, 2_000);
  const url = new URL(String(value));
  expect(
    url.protocol === 'https:' || url.protocol === 'http:',
    `${label} 只允许 http(s)。`,
  );
  expect(
    !privateHost(url.hostname),
    `${label} 不能携带 localhost 或局域网 binding。`,
  );
  expect(
    !url.username
      && !url.password
      && [...url.searchParams.keys()].every(
        (key) => !URL_SECRET_PARAMETER.test(key),
      ),
    `${label} 不能携带凭据。`,
  );
}

function assertConnectionId(value: unknown, label: string) {
  expect(
    typeof value === 'string'
      && /^[A-Za-z0-9._:-]{1,128}$/.test(value),
    `${label} 无效。`,
  );
}

function assertModelParameters(value: unknown) {
  const parameters = recordOf(value, 'connection.modelParameters');
  const allowed = new Set([
    'maxTokens',
    'temperature',
    'topP',
    'presencePenalty',
    'frequencyPenalty',
  ]);
  expect(
    Object.keys(parameters).every((key) => allowed.has(key)),
    'connection.modelParameters 含未知字段。',
  );
  for (const [key, raw] of Object.entries(parameters)) {
    const parameter = recordOf(raw, `connection.modelParameters.${key}`);
    assertKeys(
      parameter,
      ['enabled', 'value'],
      [],
      `connection.modelParameters.${key}`,
    );
    assertBoolean(parameter.enabled, `${key}.enabled`);
    assertFinite(parameter.value, `${key}.value`, -1_000_000, 1_000_000);
  }
}

function assertConnection(value: unknown) {
  const record = recordOf(value, 'ai.logical-config connection');
  assertKeys(
    record,
    [
      'connectionId',
      'name',
      'provider',
      'preset',
      'model',
      'requiresDeviceBinding',
      'chatJsonOutputEnabled',
      'contextWindowTokens',
      'contextCompressionEnabled',
      'contextCompressionThreshold',
      'contextCompressionByMessageCount',
      'contextCompressionMessageThreshold',
    ],
    ['portableBaseUrl', 'modelParameters'],
    'ai.logical-config connection',
  );
  assertConnectionId(record.connectionId, 'connection.connectionId');
  assertString(record.name, 'connection.name', 512);
  expect(
    record.provider === 'openai-compatible',
    'connection.provider 无效。',
  );
  expect(
    ['deepseek', 'qwen', 'gemini', 'ollama', 'gateway', 'custom']
      .includes(String(record.preset)),
    'connection.preset 无效。',
  );
  assertString(record.model, 'connection.model', 512);
  assertBoolean(
    record.requiresDeviceBinding,
    'connection.requiresDeviceBinding',
  );
  if (record.portableBaseUrl !== undefined) {
    assertPortableUrl(record.portableBaseUrl, 'connection.portableBaseUrl');
  }
  expect(
    record.requiresDeviceBinding !== (record.portableBaseUrl !== undefined),
    'connection 地址分区无效。',
  );
  assertBoolean(
    record.chatJsonOutputEnabled,
    'connection.chatJsonOutputEnabled',
  );
  if (record.modelParameters !== undefined) {
    assertModelParameters(record.modelParameters);
  }
  assertInteger(
    record.contextWindowTokens,
    'connection.contextWindowTokens',
    4_096,
    10_000_000,
  );
  assertBoolean(
    record.contextCompressionEnabled,
    'connection.contextCompressionEnabled',
  );
  assertFinite(
    record.contextCompressionThreshold,
    'connection.contextCompressionThreshold',
    0.3,
    0.95,
  );
  assertBoolean(
    record.contextCompressionByMessageCount,
    'connection.contextCompressionByMessageCount',
  );
  assertInteger(
    record.contextCompressionMessageThreshold,
    'connection.contextCompressionMessageThreshold',
    4,
    100,
  );
}

function assertServiceAlias(value: unknown) {
  const record = recordOf(value, 'ai.logical-config service-alias');
  assertKeys(
    record,
    ['aliasId', 'connectionId'],
    [],
    'ai.logical-config service-alias',
  );
  expect(
    (AI_LOGICAL_CONFIG_ALIAS_IDS as readonly unknown[])
      .includes(record.aliasId),
    'service-alias.aliasId 无效。',
  );
  assertConnectionId(record.connectionId, 'service-alias.connectionId');
}

function assertProfile(value: unknown) {
  const record = recordOf(value, 'ai.logical-config profile');
  assertKeys(
    record,
    [
      'profileId',
      'systemPrompt',
      'userNote',
      'proactiveMemorySuggestions',
      'automaticExplicitFactMemories',
    ],
    ['corePersona'],
    'ai.logical-config profile',
  );
  expect(record.profileId === 'default', 'profile.profileId 无效。');
  if ('corePersona' in record) assertOpaqueText(record.corePersona, 'profile.corePersona');
  assertOpaqueText(record.systemPrompt, 'profile.systemPrompt');
  assertOpaqueText(record.userNote, 'profile.userNote');
  assertBoolean(
    record.proactiveMemorySuggestions,
    'profile.proactiveMemorySuggestions',
  );
  assertBoolean(
    record.automaticExplicitFactMemories,
    'profile.automaticExplicitFactMemories',
  );
}

function assertAddressPartition(
  record: UnknownRecord,
  portableKey: string,
  label: string,
) {
  assertBoolean(record.requiresDeviceBinding, `${label}.requiresDeviceBinding`);
  if (record[portableKey] !== undefined) {
    assertPortableUrl(record[portableKey], `${label}.${portableKey}`);
  }
  expect(
    record.requiresDeviceBinding !== (record[portableKey] !== undefined),
    `${label} 地址分区无效。`,
  );
}

function assertModelRoute(value: unknown) {
  const record = recordOf(value, 'ai.logical-config model-route');
  if (record.routeType === 'embedding') {
    assertKeys(
      record,
      [
        'routeId',
        'routeType',
        'enabled',
        'model',
        'requiresDeviceBinding',
        'updatedAt',
      ],
      ['portableBaseUrl'],
      'embedding route',
    );
    expect(record.routeId === 'embedding', 'embedding routeId 无效。');
    assertBoolean(record.enabled, 'embedding.enabled');
    assertString(record.model, 'embedding.model', 512);
    assertAddressPartition(record, 'portableBaseUrl', 'embedding');
    assertInteger(record.updatedAt, 'embedding.updatedAt', 0, Number.MAX_SAFE_INTEGER);
    return;
  }
  if (record.routeType === 'reranker') {
    assertKeys(
      record,
      [
        'routeId',
        'routeType',
        'enabled',
        'mode',
        'candidateLimit',
        'timeoutMs',
        'updatedAt',
      ],
      [],
      'reranker route',
    );
    expect(record.routeId === 'reranker', 'reranker routeId 无效。');
    assertBoolean(record.enabled, 'reranker.enabled');
    expect(
      ['manual', 'conditional', 'always'].includes(String(record.mode)),
      'reranker.mode 无效。',
    );
    assertInteger(record.candidateLimit, 'reranker.candidateLimit', 8, 20);
    assertInteger(record.timeoutMs, 'reranker.timeoutMs', 1_200, 10_000);
    assertInteger(record.updatedAt, 'reranker.updatedAt', 0, Number.MAX_SAFE_INTEGER);
    return;
  }
  assertKeys(
    record,
    ['routeId', 'routeType', 'desiredEnabled', 'requiresDeviceBinding'],
    ['portableBaseUrl'],
    'backend route',
  );
  expect(
    record.routeType === 'backend' && record.routeId === 'backend',
    'backend route metadata 无效。',
  );
  assertBoolean(record.desiredEnabled, 'backend.desiredEnabled');
  assertAddressPartition(record, 'portableBaseUrl', 'backend');
}

function assertVoiceSetting(value: unknown) {
  const record = recordOf(value, 'ai.logical-config voice-setting');
  assertKeys(
    record,
    [
      'voiceId',
      'dailyCharacterLimit',
      'emotion2vecEnabled',
      'enabled',
      'maxCallMinutes',
      'requiresDeviceBinding',
      'minimaxModel',
      'saveCallSummary',
      'sttProvider',
    ],
    ['maxNewSynthesesPerCall', 'portableMinimaxBaseUrl'],
    'ai.logical-config voice-setting',
  );
  expect(record.voiceId === 'default', 'voice-setting.voiceId 无效。');
  assertInteger(
    record.dailyCharacterLimit,
    'voice-setting.dailyCharacterLimit',
    100,
    200_000,
  );
  assertBoolean(
    record.emotion2vecEnabled,
    'voice-setting.emotion2vecEnabled',
  );
  assertBoolean(record.enabled, 'voice-setting.enabled');
  assertInteger(
    record.maxCallMinutes,
    'voice-setting.maxCallMinutes',
    1,
    180,
  );
  if (record.maxNewSynthesesPerCall !== undefined) {
    assertInteger(
      record.maxNewSynthesesPerCall,
      'voice-setting.maxNewSynthesesPerCall',
      1,
      20,
    );
  }
  assertAddressPartition(
    record,
    'portableMinimaxBaseUrl',
    'voice-setting',
  );
  assertString(record.minimaxModel, 'voice-setting.minimaxModel', 512);
  assertBoolean(record.saveCallSummary, 'voice-setting.saveCallSummary');
  expect(
    record.sttProvider === 'cloud' || record.sttProvider === 'funasr',
    'voice-setting.sttProvider 无效。',
  );
}

export function assertAiLogicalConfigRecord(
  kind: AiLogicalConfigRecordKind,
  value: unknown,
): asserts value is AiLogicalConfigRecordValue {
  if (kind === 'connection') return assertConnection(value);
  if (kind === 'service-alias') return assertServiceAlias(value);
  if (kind === 'profile') return assertProfile(value);
  if (kind === 'model-route') return assertModelRoute(value);
  assertVoiceSetting(value);
}

export function aiLogicalConfigLocalId(
  kind: AiLogicalConfigRecordKind,
  value: AiLogicalConfigRecordValue,
) {
  if (kind === 'connection') {
    return (value as AiLogicalConnection).connectionId;
  }
  if (kind === 'service-alias') {
    return (value as AiLogicalServiceAlias).aliasId;
  }
  if (kind === 'profile') return (value as AiLogicalProfile).profileId;
  if (kind === 'model-route') {
    return (value as AiLogicalModelRoute).routeId;
  }
  return (value as AiLogicalVoiceSetting).voiceId;
}

export function aiLogicalConfigEntityId(
  kind: AiLogicalConfigRecordKind,
  localId: string,
) {
  return bytesToBase64Url(sha256(utf8ToBytes(
    `${AI_LOGICAL_CONFIG_ADAPTER_ID}\u0000${kind}\u0000${localId}`,
  )));
}

export function assertAiLogicalConfigMutationV1(
  value: unknown,
): asserts value is PlainMutationV1 {
  assertPlainMutationV1(value);
  expect(
    value.entity.domain === 'ai-config'
      && (AI_LOGICAL_CONFIG_RECORD_KINDS as readonly string[])
        .includes(value.entity.type),
    'ai.logical-config mutation entity 无效。',
  );
  expect(
    value.revision.schemaVersion === AI_LOGICAL_CONFIG_SCHEMA_VERSION
      && value.sensitivity === 'high'
      && value.retentionClass === AI_LOGICAL_CONFIG_RETENTION
      && value.objectRefs.length === 0,
    'ai.logical-config protocol metadata 无效。',
  );
  const kind = value.entity.type as AiLogicalConfigRecordKind;
  const payload = recordOf(value.payload, 'ai.logical-config payload');
  assertKeys(
    payload,
    value.revision.operation === 'delete'
      ? ['schemaVersion', 'kind', 'deletedAt']
      : ['schemaVersion', 'kind', 'value'],
    [],
    'ai.logical-config payload',
  );
  expect(
    payload.schemaVersion === AI_LOGICAL_CONFIG_SCHEMA_VERSION
      && payload.kind === kind,
    'ai.logical.config payload metadata 无效。',
  );
  if (value.revision.operation === 'delete') {
    assertInteger(
      payload.deletedAt,
      'ai.logical-config deletedAt',
      0,
      Number.MAX_SAFE_INTEGER,
    );
    return;
  }
  expect(
    value.revision.operation === 'upsert'
      || value.revision.operation === 'restore',
    'ai.logical-config 只允许 upsert、restore 或 delete。',
  );
  assertAiLogicalConfigRecord(kind, payload.value);
  const record = payload.value as AiLogicalConfigRecordValue;
  expect(
    value.entity.id === aiLogicalConfigEntityId(
      kind,
      aiLogicalConfigLocalId(kind, record),
    ),
    'ai.logical-config entity id 与记录不一致。',
  );
}

export function aiLogicalConfigMutationValue(
  mutation: PlainMutationV1,
) {
  assertAiLogicalConfigMutationV1(mutation);
  const payload = mutation.payload as UnknownRecord;
  return {
    kind: payload.kind as AiLogicalConfigRecordKind,
    value: payload.value as AiLogicalConfigRecordValue | undefined,
    deletedAt: payload.deletedAt as number | undefined,
  };
}

export function buildAiLogicalConfigUpsertMutation(input: {
  envelope: ChatCoreMutationEnvelope;
  kind: AiLogicalConfigRecordKind;
  value: AiLogicalConfigRecordValue;
}) {
  assertAiLogicalConfigRecord(input.kind, input.value);
  const mutation: PlainMutationV1 = {
    protocolVersion: 1,
    mutationId: input.envelope.mutationId,
    vaultId: input.envelope.vaultId,
    sourceDeviceId: input.envelope.sourceDeviceId,
    sourceSequence: input.envelope.sourceSequence,
    createdAt: input.envelope.createdAt,
    entity: {
      domain: 'ai-config',
      type: input.kind,
      id: aiLogicalConfigEntityId(
        input.kind,
        aiLogicalConfigLocalId(input.kind, input.value),
      ),
    },
    revision: {
      id: input.envelope.revisionId,
      parents: input.envelope.parentRevisionIds,
      operation: 'upsert',
      schemaVersion: AI_LOGICAL_CONFIG_SCHEMA_VERSION,
    },
    sensitivity: 'high',
    payload: {
      schemaVersion: AI_LOGICAL_CONFIG_SCHEMA_VERSION,
      kind: input.kind,
      value: input.value as JsonValue,
    },
    objectRefs: [],
    retentionClass: AI_LOGICAL_CONFIG_RETENTION,
  };
  assertAiLogicalConfigMutationV1(mutation);
  return mutation;
}

export function buildAiLogicalConfigDeleteMutation(input: {
  envelope: ChatCoreMutationEnvelope;
  kind: AiLogicalConfigRecordKind;
  localId: string;
  deletedAt: number;
}) {
  const mutation: PlainMutationV1 = {
    protocolVersion: 1,
    mutationId: input.envelope.mutationId,
    vaultId: input.envelope.vaultId,
    sourceDeviceId: input.envelope.sourceDeviceId,
    sourceSequence: input.envelope.sourceSequence,
    createdAt: input.envelope.createdAt,
    entity: {
      domain: 'ai-config',
      type: input.kind,
      id: aiLogicalConfigEntityId(input.kind, input.localId),
    },
    revision: {
      id: input.envelope.revisionId,
      parents: input.envelope.parentRevisionIds,
      operation: 'delete',
      schemaVersion: AI_LOGICAL_CONFIG_SCHEMA_VERSION,
    },
    sensitivity: 'high',
    payload: {
      schemaVersion: AI_LOGICAL_CONFIG_SCHEMA_VERSION,
      kind: input.kind,
      deletedAt: input.deletedAt,
    },
    objectRefs: [],
    retentionClass: AI_LOGICAL_CONFIG_RETENTION,
  };
  assertAiLogicalConfigMutationV1(mutation);
  return mutation;
}
