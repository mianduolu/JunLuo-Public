import type { AiConnection, AiModelParameterKey, AiModelParameters } from './types';

type ModelParameterDefinition = {
  apiName: string;
  defaultValue: number;
  integer?: boolean;
  max: number;
  min: number;
};

export const chatModelParameterDefinitions: Record<AiModelParameterKey, ModelParameterDefinition> = {
  maxTokens: { apiName: 'max_tokens', defaultValue: 4096, integer: true, min: 1, max: 32000 },
  temperature: { apiName: 'temperature', defaultValue: 1, min: 0, max: 2 },
  topP: { apiName: 'top_p', defaultValue: 1, min: 0, max: 1 },
  presencePenalty: { apiName: 'presence_penalty', defaultValue: 0, min: -2, max: 2 },
  frequencyPenalty: { apiName: 'frequency_penalty', defaultValue: 0, min: -2, max: 2 },
};

export const chatModelParameterOrder: AiModelParameterKey[] = [
  'maxTokens',
  'temperature',
  'topP',
  'presencePenalty',
  'frequencyPenalty',
];

export const chatModelParameterDefaults: AiModelParameters = Object.fromEntries(
  chatModelParameterOrder.map((key) => [
    key,
    {
      enabled: false,
      value: chatModelParameterDefinitions[key].defaultValue,
    },
  ]),
) as AiModelParameters;

export const companionRecommendedModelParameters: AiModelParameters = {
  maxTokens: { enabled: false, value: 4096 },
  temperature: { enabled: true, value: 0.55 },
  topP: { enabled: true, value: 0.9 },
  presencePenalty: { enabled: true, value: 0.25 },
  frequencyPenalty: { enabled: true, value: 0.35 },
};

export function normalizeChatModelParameters(parameters?: AiModelParameters): AiModelParameters {
  return Object.fromEntries(
    chatModelParameterOrder.map((key) => {
      const definition = chatModelParameterDefinitions[key];
      const current = parameters?.[key];
      return [
        key,
        {
          enabled: current?.enabled === true,
          value: normalizeParameterValue(key, current?.value ?? definition.defaultValue),
        },
      ];
    }),
  ) as AiModelParameters;
}

export function normalizeParameterValue(key: AiModelParameterKey, value: number) {
  const definition = chatModelParameterDefinitions[key];
  const numericValue = Number.isFinite(value) ? value : definition.defaultValue;
  const clamped = Math.min(definition.max, Math.max(definition.min, numericValue));
  return definition.integer ? Math.round(clamped) : Number(clamped.toFixed(2));
}

export function buildChatModelParameterPayload(parameters?: AiModelParameters) {
  const normalized = normalizeChatModelParameters(parameters);
  const payload: Record<string, number> = {};

  for (const key of chatModelParameterOrder) {
    const parameter = normalized[key];
    if (!parameter?.enabled) continue;
    payload[chatModelParameterDefinitions[key].apiName] = parameter.value;
  }

  return payload;
}

export function buildOpenAiCompatibilityPayload(connection: AiConnection) {
  return connection.preset === 'ollama' ? { reasoning_effort: 'none' as const } : {};
}

function toolProviderHost(connection: AiConnection): string {
  try { const url = new URL(connection.baseUrl); return url.protocol === 'https:' ? url.hostname.toLowerCase() : ''; }
  catch { return ''; }
}

export function isOfficialQwen27bConnection(connection: AiConnection): boolean {
  const host = toolProviderHost(connection);
  return connection.model.trim() === 'qwen3.8-27b'
    && (host === 'dashscope.aliyuncs.com' || host === 'dashscope-intl.aliyuncs.com'
      || /^[a-z0-9-]+\.(cn-beijing|ap-southeast-1|us-east-1|eu-central-1|ap-northeast-1|cn-hongkong)\.maas\.aliyuncs\.com$/.test(host));
}

export function isOfficialQwen397bConnection(connection: AiConnection): boolean {
  const host = toolProviderHost(connection);
  return connection.model.trim() === 'qwen3.5-397b-a17b'
    && (host === 'dashscope.aliyuncs.com' || host === 'dashscope-intl.aliyuncs.com'
      || /^[a-z0-9-]+\.(cn-beijing|ap-southeast-1|us-east-1|eu-central-1|ap-northeast-1|cn-hongkong)\.maas\.aliyuncs\.com$/.test(host));
}

export function isOfficialQwenFlashConnection(connection: AiConnection): boolean {
  const host = toolProviderHost(connection);
  return connection.model.trim() === 'qwen-flash'
    && (host === 'dashscope.aliyuncs.com' || host === 'dashscope-intl.aliyuncs.com'
      || /^[a-z0-9-]+\.(cn-beijing|ap-southeast-1|us-east-1|eu-central-1|ap-northeast-1|cn-hongkong)\.maas\.aliyuncs\.com$/.test(host));
}

export function isOfficialQwenMaxConnection(connection: AiConnection): boolean {
  const host = toolProviderHost(connection);
  return connection.model.trim() === 'qwen-max'
    && (host === 'dashscope.aliyuncs.com' || host === 'dashscope-intl.aliyuncs.com'
      || /^[a-z0-9-]+\.(cn-beijing|ap-southeast-1|us-east-1|eu-central-1|ap-northeast-1|cn-hongkong)\.maas\.aliyuncs\.com$/.test(host));
}

export function isToolProviderAlwaysThinking(connection: AiConnection): boolean {
  return ['api.moonshot.cn', 'api.moonshot.ai'].includes(toolProviderHost(connection))
    && ['kimi-k3', 'kimi-k2.7-code', 'kimi-k2.7-code-highspeed'].includes(connection.model.trim());
}

export function buildToolProviderTransportParameters(
  connection: AiConnection,
  thinkingMode?: 'enabled' | 'disabled',
  reasoningEffort?: 'low' | 'high' | 'xhigh' | 'max',
): Record<string, unknown> {
  const host = toolProviderHost(connection);
  if (host === 'api.deepseek.com') return {
    ...(thinkingMode ? { thinking: { type: thinkingMode } } : {}),
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
  };
  if (host === 'api.siliconflow.cn' || host === 'api.siliconflow.com') return {
    ...(thinkingMode ? { enable_thinking: thinkingMode === 'enabled' } : {}),
  };
  if (isOfficialQwen27bConnection(connection)) return {
    ...(thinkingMode ? { enable_thinking: thinkingMode === 'enabled' } : {}),
    ...(thinkingMode !== 'disabled' && reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
  };
  if (isOfficialQwen397bConnection(connection)) {
    return thinkingMode ? { enable_thinking: thinkingMode === 'enabled' } : {};
  }
  if (connection.model.trim() === 'deepseek-v4.1-flash'
    && (host === 'dashscope.aliyuncs.com' || host === 'dashscope-intl.aliyuncs.com'
      || /^[a-z0-9-]+\.(cn-beijing|ap-southeast-1|us-east-1|eu-central-1|ap-northeast-1)\.maas\.aliyuncs\.com$/.test(host))) {
    return thinkingMode ? { enable_thinking: thinkingMode === 'enabled' } : {};
  }
  if (host === 'api.moonshot.cn' || host === 'api.moonshot.ai') {
    const model = connection.model.trim();
    if (isToolProviderAlwaysThinking(connection)) {
      if (thinkingMode === 'disabled') throw new Error('TOOL_PROVIDER_THINKING_DISABLE_UNSUPPORTED');
      if (model === 'kimi-k3' && reasoningEffort) {
        if (reasoningEffort === 'xhigh') throw new Error('TOOL_PROVIDER_REASONING_EFFORT_UNSUPPORTED');
        return { reasoning_effort: reasoningEffort };
      }
      return {};
    }
    if (model === 'kimi-k2.6') return thinkingMode ? { thinking: { type: thinkingMode } } : {};
  }
  // Unknown connections receive standard tools, not guessed private controls.
  return {};
}
