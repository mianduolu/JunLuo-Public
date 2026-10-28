import type { ChatCoreMutationEnvelope } from './syncChatCore';
import type { PlainMutationV1 } from './syncProtocol';
import {
  AI_LOGICAL_CONFIG_ALIAS_IDS,
  aiLogicalConfigEntityId,
  buildAiLogicalConfigDeleteMutation,
  buildAiLogicalConfigUpsertMutation,
  type AiLogicalConfigAliasId,
  type AiLogicalConfigRecordKind,
  type AiLogicalConfigRecordValue,
  type AiLogicalConnection,
  type AiLogicalModelParameters,
  type AiLogicalModelRoute,
  type AiLogicalProfile,
  type AiLogicalServiceAlias,
  type AiLogicalVoiceSetting,
} from './syncAiLogicalConfig';

export const AI_LOGICAL_CONFIG_PROFILE_KEY =
  'junluo.aiProfile' as const;
export const AI_LOGICAL_CONFIG_CONNECTIONS_KEY =
  'junluo.aiConnections' as const;
export const AI_LOGICAL_CONFIG_EMBEDDING_KEY =
  'junluo.memoryEmbedding.settings' as const;
export const AI_LOGICAL_CONFIG_RERANKER_KEY =
  'junluo.memoryReranker.settings' as const;
export const AI_LOGICAL_CONFIG_VOICE_KEY =
  'junluo.voiceCall.settings.v1' as const;
export const AI_LOGICAL_CONFIG_BACKEND_KEY =
  'junluo.backend.settings' as const;

export const AI_LOGICAL_CONFIG_GLOBAL_KEYS = [
  AI_LOGICAL_CONFIG_PROFILE_KEY,
  AI_LOGICAL_CONFIG_CONNECTIONS_KEY,
  AI_LOGICAL_CONFIG_EMBEDDING_KEY,
  AI_LOGICAL_CONFIG_RERANKER_KEY,
  AI_LOGICAL_CONFIG_VOICE_KEY,
  AI_LOGICAL_CONFIG_BACKEND_KEY,
] as const;

export const AI_LOGICAL_CONFIG_DELEGATED_SERVICE_KEYS = {
  github: 'junluo.tools.github.settings.v1',
  mcp: 'junluo.tool.mcp.servers.v1',
} as const;

export type AiLogicalConfigStorageChange =
  | { kind: 'set'; key: string; value: string }
  | { kind: 'remove'; key: string };

export type AiLogicalConfigStorageReadPort = {
  getItem(key: string): Promise<string | null>;
};

export type AiLogicalConfigEnvelopeFactory = (
  entity: {
    domain: 'ai-config';
    type: AiLogicalConfigRecordKind;
    id: string;
  },
) => Promise<ChatCoreMutationEnvelope>;

export type AiLogicalConfigProjection = {
  kind: AiLogicalConfigRecordKind;
  localId: string;
  entityId: string;
  value: AiLogicalConfigRecordValue;
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

function recordOf(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function parseJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function cleanText(value: unknown, maximum: number) {
  return typeof value === 'string'
    ? value
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      .trim()
      .slice(0, maximum)
    : '';
}

function safeTimestamp(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : 0;
}

function finiteNumber(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, value))
    : fallback;
}

function integer(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  return Math.round(finiteNumber(value, fallback, minimum, maximum));
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

export function portableLogicalConfigUrl(value: unknown) {
  const candidate = typeof value === 'string'
    ? value.trim().replace(/\/+$/, '')
    : '';
  if (!candidate) {
    return { requiresDeviceBinding: true as const };
  }
  try {
    const url = new URL(candidate);
    if (
      (url.protocol !== 'https:' && url.protocol !== 'http:')
      || privateHost(url.hostname)
      || url.username
      || url.password
      || [...url.searchParams.keys()].some(
        (key) => URL_SECRET_PARAMETER.test(key),
      )
    ) {
      return { requiresDeviceBinding: true as const };
    }
    return {
      requiresDeviceBinding: false as const,
      portableBaseUrl: url.toString().replace(/\/+$/, ''),
    };
  } catch {
    return { requiresDeviceBinding: true as const };
  }
}

function normalizeModelParameters(
  value: unknown,
): AiLogicalModelParameters | undefined {
  const record = recordOf(value);
  if (!record) return undefined;
  const allowed = [
    'maxTokens',
    'temperature',
    'topP',
    'presencePenalty',
    'frequencyPenalty',
  ] as const;
  const result: AiLogicalModelParameters = {};
  for (const key of allowed) {
    const setting = recordOf(record[key]);
    if (
      !setting
      || typeof setting.enabled !== 'boolean'
      || typeof setting.value !== 'number'
      || !Number.isFinite(setting.value)
    ) {
      continue;
    }
    result[key] = {
      enabled: setting.enabled,
      value: Math.max(-1_000_000, Math.min(1_000_000, setting.value)),
    };
  }
  return Object.keys(result).length ? result : undefined;
}

function projection(
  kind: AiLogicalConfigRecordKind,
  localId: string,
  value: AiLogicalConfigRecordValue,
): AiLogicalConfigProjection {
  return {
    kind,
    localId,
    entityId: aiLogicalConfigEntityId(kind, localId),
    value,
  };
}

export function projectAiLogicalConnections(raw: string | null) {
  const root = recordOf(parseJson(raw));
  if (!root || !Array.isArray(root.connections)) {
    return [] as AiLogicalConfigProjection[];
  }
  const result: AiLogicalConfigProjection[] = [];
  const connectionIds = new Set<string>();
  for (const candidateValue of root.connections.slice(0, 200)) {
    const candidate = recordOf(candidateValue);
    const connectionId = cleanText(candidate?.id, 128);
    const name = cleanText(candidate?.name, 512);
    const model = cleanText(candidate?.model, 512);
    if (
      !candidate
      || !/^[A-Za-z0-9._:-]{1,128}$/.test(connectionId)
      || !name
      || !model
    ) {
      continue;
    }
    const preset = [
      'deepseek',
      'qwen',
      'gemini',
      'ollama',
      'gateway',
      'custom',
    ].includes(String(candidate.preset))
      ? candidate.preset as AiLogicalConnection['preset']
      : 'custom';
    const address = portableLogicalConfigUrl(candidate.baseUrl);
    const value: AiLogicalConnection = {
      connectionId,
      name,
      provider: 'openai-compatible',
      preset,
      model,
      ...address,
      chatJsonOutputEnabled: candidate.chatJsonOutputEnabled === true,
      ...(normalizeModelParameters(candidate.modelParameters)
        ? { modelParameters: normalizeModelParameters(candidate.modelParameters) }
        : {}),
      ...(candidate.promptCacheMode === 'ephemeral-first-system'
        ? { promptCacheMode: 'ephemeral-first-system' as const } : {}),
      contextWindowTokens: integer(
        candidate.contextWindowTokens,
        65_536,
        4_096,
        10_000_000,
      ),
      contextCompressionEnabled:
        candidate.contextCompressionEnabled !== false,
      contextCompressionThreshold: finiteNumber(
        candidate.contextCompressionThreshold,
        0.7,
        0.3,
        0.95,
      ),
      contextCompressionByMessageCount:
        candidate.contextCompressionByMessageCount !== false,
      contextCompressionMessageThreshold: integer(
        candidate.contextCompressionMessageThreshold,
        16,
        4,
        100,
      ),
    };
    connectionIds.add(connectionId);
    result.push(projection('connection', connectionId, value));
  }
  for (const aliasId of AI_LOGICAL_CONFIG_ALIAS_IDS) {
    const connectionId = cleanText(root[ALIAS_STORAGE_KEYS[aliasId]], 128);
    if (!connectionIds.has(connectionId)) continue;
    const value: AiLogicalServiceAlias = { aliasId, connectionId };
    result.push(projection('service-alias', aliasId, value));
  }
  return result;
}

export function projectAiLogicalProfile(raw: string | null) {
  if (!raw) return [] as AiLogicalConfigProjection[];
  const candidate = recordOf(parseJson(raw));
  if (
    !candidate
    || typeof candidate.systemPrompt !== 'string'
    || typeof candidate.userNote !== 'string'
    || candidate.systemPrompt.length > 1_000_000
    || candidate.userNote.length > 1_000_000
    || candidate.corePersona !== undefined && (typeof candidate.corePersona !== 'string'
      || candidate.corePersona.length > 1_000_000)
  ) {
    return [];
  }
  const value: AiLogicalProfile = {
    profileId: 'default',
    ...(typeof candidate.corePersona === 'string' && candidate.corePersona.trim()
      ? { corePersona: candidate.corePersona } : {}),
    systemPrompt: candidate.systemPrompt,
    userNote: candidate.userNote,
    proactiveMemorySuggestions:
      candidate.proactiveMemorySuggestions === true,
    automaticExplicitFactMemories:
      candidate.automaticExplicitFactMemories === true,
  };
  return [projection('profile', 'default', value)];
}

export function projectAiLogicalEmbedding(raw: string | null) {
  if (!raw) return [] as AiLogicalConfigProjection[];
  const candidate = recordOf(parseJson(raw));
  const model = cleanText(candidate?.model, 512);
  if (!candidate || !model) return [];
  const value: AiLogicalModelRoute = {
    routeId: 'embedding',
    routeType: 'embedding',
    enabled: candidate.enabled === true,
    model,
    ...portableLogicalConfigUrl(candidate.baseUrl),
    updatedAt: safeTimestamp(candidate.updatedAt),
  };
  return [projection('model-route', 'embedding', value)];
}

export function projectAiLogicalReranker(raw: string | null) {
  if (!raw) return [] as AiLogicalConfigProjection[];
  const candidate = recordOf(parseJson(raw));
  if (!candidate) return [];
  const mode = candidate.mode === 'manual' || candidate.mode === 'always'
    ? candidate.mode
    : 'conditional';
  const value: AiLogicalModelRoute = {
    routeId: 'reranker',
    routeType: 'reranker',
    enabled: candidate.enabled === true,
    mode,
    candidateLimit: integer(candidate.candidateLimit, 12, 8, 20),
    timeoutMs: integer(candidate.timeoutMs, 2_500, 1_200, 10_000),
    updatedAt: safeTimestamp(candidate.updatedAt),
  };
  return [projection('model-route', 'reranker', value)];
}

export function projectAiLogicalBackend(raw: string | null) {
  if (!raw) return [] as AiLogicalConfigProjection[];
  const candidate = recordOf(parseJson(raw));
  if (!candidate) return [];
  const value: AiLogicalModelRoute = {
    routeId: 'backend',
    routeType: 'backend',
    desiredEnabled: candidate.enabled === true,
    ...portableLogicalConfigUrl(candidate.baseUrl),
  };
  return [projection('model-route', 'backend', value)];
}

export function projectAiLogicalVoice(raw: string | null) {
  if (!raw) return [] as AiLogicalConfigProjection[];
  const candidate = recordOf(parseJson(raw));
  const minimaxModel = cleanText(candidate?.minimaxModel, 512);
  if (!candidate || !minimaxModel) return [];
  const address = portableLogicalConfigUrl(candidate.minimaxBaseUrl);
  const value: AiLogicalVoiceSetting = {
    voiceId: 'default',
    dailyCharacterLimit: integer(
      candidate.dailyCharacterLimit,
      3_000,
      100,
      200_000,
    ),
    emotion2vecEnabled: candidate.emotion2vecEnabled === true,
    enabled: candidate.enabled === true,
    maxCallMinutes: integer(candidate.maxCallMinutes, 10, 1, 180),
    maxNewSynthesesPerCall: integer(candidate.maxNewSynthesesPerCall, 4, 1, 20),
    requiresDeviceBinding: address.requiresDeviceBinding,
    ...(address.portableBaseUrl
      ? { portableMinimaxBaseUrl: address.portableBaseUrl }
      : {}),
    minimaxModel,
    saveCallSummary: candidate.saveCallSummary !== false,
    sttProvider: candidate.sttProvider === 'cloud' ? 'cloud' : 'funasr',
  };
  return [projection('voice-setting', 'default', value)];
}

export async function readAiLogicalConfigProjection(input: {
  reader: AiLogicalConfigStorageReadPort;
  overrides?: ReadonlyMap<string, string | null>;
}) {
  const get = (key: string) => input.overrides?.has(key)
    ? Promise.resolve(input.overrides.get(key) ?? null)
    : input.reader.getItem(key);
  const [
    profile,
    connections,
    embedding,
    reranker,
    voice,
    backend,
  ] = await Promise.all([
    get(AI_LOGICAL_CONFIG_PROFILE_KEY),
    get(AI_LOGICAL_CONFIG_CONNECTIONS_KEY),
    get(AI_LOGICAL_CONFIG_EMBEDDING_KEY),
    get(AI_LOGICAL_CONFIG_RERANKER_KEY),
    get(AI_LOGICAL_CONFIG_VOICE_KEY),
    get(AI_LOGICAL_CONFIG_BACKEND_KEY),
  ]);
  return [
    ...projectAiLogicalConnections(connections),
    ...projectAiLogicalProfile(profile),
    ...projectAiLogicalEmbedding(embedding),
    ...projectAiLogicalReranker(reranker),
    ...projectAiLogicalVoice(voice),
    ...projectAiLogicalBackend(backend),
  ];
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  return `{${Object.entries(value as UnknownRecord)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
}

function projectionKey(value: AiLogicalConfigProjection) {
  return `${value.kind}\u0000${value.entityId}`;
}

export async function deriveAiLogicalConfigMutations(input: {
  previous: readonly AiLogicalConfigProjection[];
  next: readonly AiLogicalConfigProjection[];
  capturedAt: number;
  envelopeFactory: AiLogicalConfigEnvelopeFactory;
}) {
  const previous = new Map(
    input.previous.map((record) => [projectionKey(record), record]),
  );
  const next = new Map(
    input.next.map((record) => [projectionKey(record), record]),
  );
  const keys = [...new Set([...previous.keys(), ...next.keys()])].sort();
  const mutations: PlainMutationV1[] = [];
  for (const key of keys) {
    const before = previous.get(key);
    const after = next.get(key);
    if (
      before
      && after
      && canonicalJson(before.value) === canonicalJson(after.value)
    ) {
      continue;
    }
    const identity = after ?? before;
    if (!identity) continue;
    const envelope = await input.envelopeFactory({
      domain: 'ai-config',
      type: identity.kind,
      id: identity.entityId,
    });
    if (after) {
      mutations.push(buildAiLogicalConfigUpsertMutation({
        envelope: { ...envelope, createdAt: input.capturedAt },
        kind: after.kind,
        value: after.value,
      }));
    } else {
      mutations.push(buildAiLogicalConfigDeleteMutation({
        envelope: { ...envelope, createdAt: input.capturedAt },
        kind: before!.kind,
        localId: before!.localId,
        deletedAt: input.capturedAt,
      }));
    }
  }
  return mutations;
}

export function isAiLogicalConfigStorageKey(key: string) {
  return (AI_LOGICAL_CONFIG_GLOBAL_KEYS as readonly string[]).includes(key);
}

export function aiLogicalConfigStorageOverrides(
  changes: readonly AiLogicalConfigStorageChange[],
) {
  const overrides = new Map<string, string | null>();
  for (const change of changes) {
    if (!isAiLogicalConfigStorageKey(change.key)) continue;
    overrides.set(change.key, change.kind === 'set' ? change.value : null);
  }
  return overrides;
}
