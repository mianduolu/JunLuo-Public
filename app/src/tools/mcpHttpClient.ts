import { getMcpServerToken, type JunLuoMcpServerConfig } from './mcpServerStore';

export type JunLuoMcpHttpTool = {
  name?: unknown;
  description?: unknown;
  inputSchema?: unknown;
  annotations?: unknown;
  readOnly?: unknown;
  [key: string]: unknown;
};

export type JunLuoMcpToolsListResult = {
  tools: JunLuoMcpHttpTool[];
};

type JsonRpcSuccess<T> = {
  jsonrpc?: string;
  id?: string | number | null;
  result: T;
};

type JsonRpcError = {
  jsonrpc?: string;
  id?: string | number | null;
  error: {
    code?: number;
    message?: string;
    data?: unknown;
  };
};

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isJsonRpcError(value: unknown): value is JsonRpcError {
  const record = readRecord(value);
  return !!readRecord(record?.error);
}

function isJsonRpcSuccess<T>(value: unknown): value is JsonRpcSuccess<T> {
  const record = readRecord(value);
  return record ? 'result' in record : false;
}

function sanitizeMcpErrorMessage(message: string) {
  return message.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]');
}

export async function callMcpJsonRpc<T>(
  config: JunLuoMcpServerConfig,
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  const token = await getMcpServerToken(config.serverId);
  const response = await fetch(config.endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      method,
      ...(params ? { params } : {}),
    }),
  });

  const text = await response.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`MCP 返回了非 JSON 响应：HTTP ${response.status}`);
  }

  if (!response.ok) {
    throw new Error(`MCP HTTP 请求失败：${response.status}`);
  }
  if (isJsonRpcError(payload)) {
    const message = payload.error.message || `MCP JSON-RPC error ${payload.error.code ?? ''}`.trim();
    throw new Error(sanitizeMcpErrorMessage(message));
  }
  if (!isJsonRpcSuccess<T>(payload)) {
    throw new Error('MCP JSON-RPC 响应缺少 result');
  }
  return payload.result;
}

export async function listMcpTools(config: JunLuoMcpServerConfig) {
  const result = await callMcpJsonRpc<JunLuoMcpToolsListResult>(config, 'tools/list');
  return {
    tools: Array.isArray(result.tools) ? result.tools : [],
  };
}

export async function callMcpTool(config: JunLuoMcpServerConfig, name: string, args: Record<string, unknown>) {
  return callMcpJsonRpc<unknown>(config, 'tools/call', {
    name,
    arguments: args,
  });
}
