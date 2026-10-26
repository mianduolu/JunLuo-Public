import type {
  JunLuoToolDefinition,
  JunLuoToolInputSchema,
  JunLuoToolInputSchemaType,
  JunLuoToolPackage,
  JunLuoToolRiskLevel,
} from './toolTypes';

export type JunLuoMcpToolLike = {
  name?: unknown;
  description?: unknown;
  inputSchema?: unknown;
  [key: string]: unknown;
};

export type JunLuoMcpServerLike = {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  tools?: unknown;
  [key: string]: unknown;
};

const ALLOWED_SCHEMA_TYPES = new Set<JunLuoToolInputSchemaType>([
  'string',
  'number',
  'boolean',
  'object',
  'array',
]);

function sanitizeIdPart(value: string) {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function readString(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeSchema(value: unknown): JunLuoToolInputSchema {
  const record = readObject(value);
  const rawType = readString(record?.type);
  const type = ALLOWED_SCHEMA_TYPES.has(rawType as JunLuoToolInputSchemaType)
    ? rawType as JunLuoToolInputSchemaType
    : 'string';
  const schema: JunLuoToolInputSchema = {
    type,
    ...(typeof record?.description === 'string' ? { description: record.description } : {}),
  };

  if (type === 'object') {
    const properties = readObject(record?.properties);
    if (properties) {
      schema.properties = Object.fromEntries(
        Object.entries(properties).map(([key, nested]) => [key, normalizeSchema(nested)]),
      );
    }
    if (Array.isArray(record?.required)) {
      schema.required = record.required.filter((item): item is string => typeof item === 'string');
    }
  }

  if (type === 'array') {
    schema.items = normalizeSchema(record?.items);
  }

  if (Array.isArray(record?.enum)) {
    schema.enum = record.enum.filter((item): item is string | number | boolean =>
      typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean');
  }

  return schema;
}

export function mcpToolToJunLuoToolDefinition(options: {
  packageId: string;
  serverId: string;
  tool: JunLuoMcpToolLike;
  riskLevel?: JunLuoToolRiskLevel;
}): JunLuoToolDefinition | null {
  const rawName = readString(options.tool.name);
  const safeServerId = sanitizeIdPart(options.serverId);
  const safeToolName = sanitizeIdPart(rawName);
  if (!safeServerId || !safeToolName) return null;

  const inputSchemaRecord = readObject(options.tool.inputSchema);
  const inputSchema = normalizeSchema(inputSchemaRecord ?? { type: 'object' });
  const objectInputSchema: JunLuoToolDefinition['inputSchema'] = inputSchema.type === 'object'
    ? { ...inputSchema, type: 'object' }
    : { type: 'object', properties: {}, required: [] };

  return {
    id: `mcp.${safeServerId}.${safeToolName}`,
    packageId: options.packageId,
    name: rawName,
    description: readString(options.tool.description) || `MCP 工具：${rawName}`,
    inputSchema: objectInputSchema,
    permission: 'ask',
    riskLevel: options.riskLevel ?? 'external_network',
    readOnly: false,
  };
}

export function mcpServerToJunLuoToolPackage(options: {
  server: JunLuoMcpServerLike;
  riskLevel?: JunLuoToolRiskLevel;
}): JunLuoToolPackage | null {
  const rawServerId = readString(options.server.id) || readString(options.server.name);
  const serverId = sanitizeIdPart(rawServerId);
  if (!serverId) return null;

  const packageId = `mcp.${serverId}`;
  const tools = Array.isArray(options.server.tools)
    ? options.server.tools
      .map((tool) => mcpToolToJunLuoToolDefinition({
        packageId,
        riskLevel: options.riskLevel,
        serverId,
        tool: readObject(tool) ?? {},
      }))
      .filter((tool): tool is JunLuoToolDefinition => !!tool)
    : [];

  return {
    id: packageId,
    name: readString(options.server.name) || rawServerId,
    description: readString(options.server.description) || `MCP Server：${rawServerId}`,
    category: 'MCP',
    tools,
    defaultEnabled: false,
    riskLevel: options.riskLevel ?? 'external_network',
    source: 'mcp',
  };
}
