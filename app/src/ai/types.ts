import { canPurposeFallbackToChat, doesPurposeRequireDedicatedCapability, type ModelPurposeId } from './modelPurposeRegistry';
import type { ConnectionPromptCacheMode } from './promptCacheRequest';

export type AiProvider = 'openai-compatible';
export type AiProviderPreset = 'deepseek' | 'qwen' | 'gemini' | 'ollama' | 'gateway' | 'custom';
export type AiConnectionPurpose = ModelPurposeId;
export type AiModelParameterKey = 'maxTokens' | 'temperature' | 'topP' | 'presencePenalty' | 'frequencyPenalty';

export type AiModelParameterValue = {
  enabled: boolean;
  value: number;
};

export type AiModelParameters = Partial<Record<AiModelParameterKey, AiModelParameterValue>>;

export type AiProfile = {
  corePersona?: string;
  systemPrompt: string;
  userNote: string;
  proactiveMemorySuggestions: boolean;
  automaticExplicitFactMemories: boolean;
};

export type AiConnection = {
  id: string;
  name: string;
  provider: AiProvider;
  preset: AiProviderPreset;
  baseUrl: string;
  model: string;
  chatJsonOutputEnabled?: boolean;
  modelParameters?: AiModelParameters;
  promptCacheMode?: ConnectionPromptCacheMode;
  contextWindowTokens?: number;
  contextCompressionEnabled?: boolean;
  contextCompressionThreshold?: number;
  contextCompressionByMessageCount?: boolean;
  contextCompressionMessageThreshold?: number;
};

export const defaultContextCompressionSettings = {
  contextWindowTokens: 65536,
  contextCompressionEnabled: true,
  contextCompressionThreshold: 0.7,
  contextCompressionByMessageCount: true,
  contextCompressionMessageThreshold: 16,
} as const;

export function normalizeAiConnection(connection: AiConnection): AiConnection {
  const { promptCacheMode, ...settings } = connection;
  return {
    ...settings,
    ...(promptCacheMode === 'ephemeral-first-system' ? { promptCacheMode } : {}),
    chatJsonOutputEnabled: connection.chatJsonOutputEnabled === true,
    contextWindowTokens: Math.max(4096, Math.round(connection.contextWindowTokens ?? 65536)),
    contextCompressionEnabled: connection.contextCompressionEnabled !== false,
    contextCompressionThreshold: Math.max(0.3, Math.min(0.95, connection.contextCompressionThreshold ?? 0.7)),
    contextCompressionByMessageCount: connection.contextCompressionByMessageCount !== false,
    contextCompressionMessageThreshold: Math.max(
      4,
      Math.min(100, Math.round(connection.contextCompressionMessageThreshold ?? 16)),
    ),
  };
}

export type AiConnectionSettings = {
  connections: AiConnection[];
  chatConnectionId?: string;
  baiyunBehaviorConnectionId?: string;
  visionConnectionId?: string;
  audioUnderstandingConnectionId?: string;
  utilityJsonConnectionId?: string;
  memoryOrganizerConnectionId?: string;
  memoryRerankerConnectionId?: string;
  imageGenerationConnectionId?: string;
  financeReasoningConnectionId?: string;
  lifeCreativeConnectionId?: string;
  asrConnectionId?: string;
};

export type AiConnectionIdSettingKey = Exclude<keyof AiConnectionSettings, 'connections'>;

export const aiConnectionIdKeyByPurpose: Record<AiConnectionPurpose, AiConnectionIdSettingKey> = {
  chat: 'chatConnectionId',
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

export function getConnectionIdForPurpose(settings: AiConnectionSettings, purpose: AiConnectionPurpose) {
  return settings[aiConnectionIdKeyByPurpose[purpose]];
}

export function canConnectionPurposeFallbackToChat(purpose: AiConnectionPurpose) {
  return canPurposeFallbackToChat(purpose);
}

export function doesConnectionPurposeRequireDedicatedCapability(purpose: AiConnectionPurpose) {
  return doesPurposeRequireDedicatedCapability(purpose);
}

export const defaultAiProfile: AiProfile = {
  systemPrompt: '',
  userNote: '',
  proactiveMemorySuggestions: false,
  automaticExplicitFactMemories: false,
};

export const defaultConnectionValues: Record<AiProviderPreset, Pick<AiConnection, 'name' | 'baseUrl' | 'model'>> = {
  deepseek: {
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
  },
  qwen: {
    name: 'Qwen',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
  },
  gemini: {
    name: 'Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.5-flash',
  },
  ollama: {
    name: 'Ollama 本地',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen3.5:9b',
  },
  gateway: {
    name: 'JunLuo Gateway',
    baseUrl: 'http://127.0.0.1:8787/api/ai',
    model: 'junluo-claude-cli',
  },
  custom: {
    name: '自定义连接',
    baseUrl: '',
    model: '',
  },
};
