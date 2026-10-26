import type { JunLuoToolDefinition, JunLuoToolInputSchema } from './toolTypes';

export type JunLuoChatToolMode = 'none' | 'prompt-json' | 'openai-tools';

export type JunLuoToolInvocationSource = 'prompt-json' | 'openai-tools';

export type JunLuoToolInvocation = {
  callId: string;
  input: Record<string, unknown>;
  rawArguments?: string;
  rawName?: string;
  source: JunLuoToolInvocationSource;
  toolId: string;
};

export type JunLuoToolInvocationParseError = {
  code:
    | 'DUPLICATE_CALL_ID'
    | 'INVALID_ARGUMENTS_JSON'
    | 'INVALID_ARGUMENTS_SHAPE'
    | 'INVALID_TOOL_CALL_SHAPE'
    | 'MISSING_CALL_ID'
    | 'UNKNOWN_TOOL_NAME';
  callId?: string;
  message: string;
  rawArguments?: string;
  rawName?: string;
  toolId?: string;
};

export type JunLuoToolInvocationParseResult = {
  errors: JunLuoToolInvocationParseError[];
  invocations: JunLuoToolInvocation[];
  rawCallCount: number;
};

export type OpenAiCompatibleTool = {
  function: {
    description?: string;
    name: string;
    parameters: OpenAiCompatibleJsonSchema;
    strict?: boolean;
  };
  type: 'function';
};

export type OpenAiCompatibleJsonSchema = {
  type?: JunLuoToolInputSchema['type'] | 'null';
  description?: string;
  properties?: Record<string, OpenAiCompatibleJsonSchema>;
  required?: string[];
  items?: OpenAiCompatibleJsonSchema;
  minItems?: number;
  enum?: Array<string | number | boolean>;
  anyOf?: OpenAiCompatibleJsonSchema[];
  additionalProperties?: boolean;
};

export type OpenAiCompatibleToolCall = {
  function?: {
    arguments?: string;
    name?: string;
  };
  id?: string;
  type?: string;
};

export type OpenAiCompatibleToolCallMessage = {
  tool_calls?: OpenAiCompatibleToolCall[];
};

function safeExternalToolName(toolId: string) {
  return toolId.replace(/[^a-zA-Z0-9_-]/g, '__');
}

export function toolIdToOpenAiToolName(toolId: string) {
  return safeExternalToolName(toolId);
}

export function openAiToolNameToToolId(name: string, tools: JunLuoToolDefinition[]) {
  return tools.find((tool) => toolIdToOpenAiToolName(tool.id) === name)?.id;
}

function nullableStrictProperty(schema: JunLuoToolInputSchema): OpenAiCompatibleJsonSchema {
  return {
    anyOf: [normalizeToolSchemaForStrict(schema), { type: 'null' }],
  };
}

export function normalizeToolSchemaForStrict(
  schema: JunLuoToolInputSchema,
): OpenAiCompatibleJsonSchema {
  if (schema.nullable) return { anyOf: [normalizeToolSchemaForStrict({ ...schema, nullable: false }), { type: 'null' }] };
  const common = {
    ...(schema.description ? { description: schema.description } : {}),
    ...(schema.enum ? { enum: [...schema.enum] } : {}),
  };
  if (schema.type === 'object') {
    const properties = schema.properties ?? {};
    const originallyRequired = new Set(schema.required ?? []);
    return {
      ...common,
      type: 'object',
      properties: Object.fromEntries(
        Object.entries(properties).map(([key, value]) => [
          key,
          originallyRequired.has(key)
            ? normalizeToolSchemaForStrict(value)
            : nullableStrictProperty(value),
        ]),
      ),
      required: Object.keys(properties),
      additionalProperties: false,
    };
  }
  if (schema.type === 'array') {
    if (!schema.items) throw new Error('strict 工具 Schema 的 array 必须声明 items');
    return {
      ...common,
      type: 'array',
      items: normalizeToolSchemaForStrict(schema.items),
      ...(schema.minItems === undefined ? {} : { minItems: schema.minItems }),
    };
  }
  if (!['string', 'number', 'boolean'].includes(schema.type)) {
    throw new Error(`strict 工具 Schema 不支持类型：${String(schema.type)}`);
  }
  return { ...common, type: schema.type };
}

function normalizeNullableToolSchema(schema: JunLuoToolInputSchema): OpenAiCompatibleJsonSchema {
  const { nullable, properties, items, ...base } = schema;
  const normalized: OpenAiCompatibleJsonSchema = { ...base,
    ...(properties ? { properties: Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, normalizeNullableToolSchema(value)])) } : {}),
    ...(items ? { items: normalizeNullableToolSchema(items) } : {}),
  };
  return nullable ? { anyOf: [normalized, { type: 'null' }] } : normalized;
}

export function toolDefinitionToOpenAiTool(
  tool: JunLuoToolDefinition,
  options: { strict?: boolean } = {},
): OpenAiCompatibleTool {
  const parameters = options.strict
    ? normalizeToolSchemaForStrict(tool.inputSchema)
    : normalizeNullableToolSchema(tool.inputSchema);
  return {
    type: 'function',
    function: {
      description: tool.description,
      name: toolIdToOpenAiToolName(tool.id),
      parameters,
      ...(options.strict ? { strict: true } : {}),
    },
  };
}

function parseArguments(
  rawArguments: string | undefined,
  rawName: string | undefined,
  callId: string,
  toolId: string,
  schema?: JunLuoToolInputSchema,
) {
  if (typeof rawArguments !== 'string') {
    return {
      error: {
        code: 'INVALID_ARGUMENTS_SHAPE' as const,
        callId,
        message: '工具调用 arguments 必须是 JSON 字符串',
        rawArguments,
        rawName,
        toolId,
      },
    };
  }

  try {
    const parsed = JSON.parse(rawArguments) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        error: {
          code: 'INVALID_ARGUMENTS_SHAPE' as const,
          callId,
          message: '工具调用 arguments 必须解析为 JSON object',
          rawArguments,
          rawName,
          toolId,
        },
      };
    }
    const omitNullProperties = (value: unknown, shape?: JunLuoToolInputSchema): unknown => {
      if (Array.isArray(value)) return value.map(item => omitNullProperties(item, shape?.items));
      if (!value || typeof value !== 'object') return value;
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([key, item]) => item !== null || shape?.properties?.[key]?.nullable === true)
          .map(([key, item]) => [key, omitNullProperties(item, shape?.properties?.[key])]),
      );
    };
    return { input: omitNullProperties(parsed, schema) as Record<string, unknown> };
  } catch {
    return {
      error: {
        code: 'INVALID_ARGUMENTS_JSON' as const,
        callId,
        message: '工具调用 arguments 不是有效 JSON',
        rawArguments,
        rawName,
        toolId,
      },
    };
  }
}

export function parseOpenAiToolCalls(
  message: OpenAiCompatibleToolCallMessage | undefined,
  tools: JunLuoToolDefinition[],
): JunLuoToolInvocationParseResult {
  const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  const result: JunLuoToolInvocationParseResult = {
    errors: [],
    invocations: [],
    rawCallCount: toolCalls.length,
  };
  const seenCallIds = new Set<string>();

  toolCalls.forEach((toolCall) => {
    const callId = typeof toolCall.id === 'string' ? toolCall.id : '';
    if (!callId.trim()) {
      result.errors.push({
        code: 'MISSING_CALL_ID',
        message: '工具调用缺少 callId',
        rawArguments: toolCall.function?.arguments,
        rawName: toolCall.function?.name,
      });
      return;
    }
    if (seenCallIds.has(callId)) {
      result.errors.push({
        callId,
        code: 'DUPLICATE_CALL_ID',
        message: '同一 assistant 消息出现重复 callId',
        rawArguments: toolCall.function?.arguments,
        rawName: toolCall.function?.name,
      });
      return;
    }
    seenCallIds.add(callId);
    if (toolCall.type && toolCall.type !== 'function') {
      result.errors.push({
        callId,
        code: 'INVALID_TOOL_CALL_SHAPE',
        message: '工具调用 type 必须是 function',
        rawArguments: toolCall.function?.arguments,
        rawName: toolCall.function?.name,
      });
      return;
    }
    const rawName = toolCall.function?.name;
    if (typeof rawName !== 'string' || !rawName.trim()) {
      result.errors.push({
        callId,
        code: 'INVALID_TOOL_CALL_SHAPE',
        message: '工具调用缺少 function.name',
      });
      return;
    }
    const toolId = openAiToolNameToToolId(rawName, tools);
    if (!toolId) {
      result.errors.push({
        callId,
        code: 'UNKNOWN_TOOL_NAME',
        message: `未知工具名称：${rawName}`,
        rawArguments: toolCall.function?.arguments,
        rawName,
      });
      return;
    }
    const parsed = parseArguments(toolCall.function?.arguments, rawName, callId, toolId, tools.find(tool => tool.id === toolId)?.inputSchema);
    if (parsed.error) {
      result.errors.push(parsed.error);
      return;
    }
    result.invocations.push({
      callId,
      input: parsed.input,
      rawArguments: toolCall.function?.arguments,
      rawName,
      source: 'openai-tools',
      toolId,
    });
  });

  return result;
}

function readPromptJsonCandidates(value: unknown): Array<{ input?: unknown; toolId?: unknown }> {
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.tool_calls)) {
    return record.tool_calls
      .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item))
      .map((item) => ({
        input: item.input ?? item.arguments,
        toolId: item.toolId ?? item.tool_id ?? item.name,
      }));
  }
  return [{ input: record.input ?? record.arguments, toolId: record.toolId ?? record.tool_id ?? record.name }];
}

export function parsePromptJsonToolInvocations(text: string): JunLuoToolInvocationParseResult {
  const result: JunLuoToolInvocationParseResult = { errors: [], invocations: [], rawCallCount: 0 };
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  if (!trimmed) return result;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    result.errors.push({
      code: 'INVALID_ARGUMENTS_JSON',
      message: 'prompt-json 工具请求不是有效 JSON',
      rawArguments: text,
    });
    return result;
  }

  const candidates = readPromptJsonCandidates(parsed);
  result.rawCallCount = candidates.length;
  candidates.forEach((candidate, index) => {
    if (typeof candidate.toolId !== 'string' || !candidate.toolId.trim()) {
      result.errors.push({ code: 'INVALID_TOOL_CALL_SHAPE', message: 'prompt-json 工具请求缺少 toolId' });
      return;
    }
    if (!candidate.input || typeof candidate.input !== 'object' || Array.isArray(candidate.input)) {
      result.errors.push({
        code: 'INVALID_ARGUMENTS_SHAPE',
        message: 'prompt-json 工具请求 input 必须是 JSON object',
        rawName: candidate.toolId,
      });
      return;
    }
    result.invocations.push({
      callId: `prompt-json-tool-${index}-${Date.now()}`,
      input: candidate.input as Record<string, unknown>,
      rawArguments: JSON.stringify(candidate.input),
      rawName: candidate.toolId,
      source: 'prompt-json',
      toolId: candidate.toolId.trim(),
    });
  });

  return result;
}

