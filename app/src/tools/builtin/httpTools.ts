import { getFileImportRecord, writeTextFileToCache } from '../fileToolStore';
import {
  ensureBuiltinHttpNamedServices,
  getHttpNamedService,
  listHttpNamedServices,
} from '../httpNamedServiceRegistry';
import { createToolError } from '../toolErrors';
import { createToolErrorResult, createToolSuccessResult } from '../toolResult';
import type { JunLuoToolCall, JunLuoToolDefinition, JunLuoToolExecutorContext, JunLuoToolPackage, JunLuoToolResult } from '../toolTypes';
import { isOneOf, readNumberInput, readStringInput, validationFailed } from './builtinToolValidation';

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] as const;
const UPLOAD_METHODS = ['POST', 'PUT'] as const;
const MAX_INLINE_RESPONSE_CHARS = 12_000;
const RESPONSE_PREVIEW_CHARS = 4_000;
const MAX_BODY_CHARS = 80_000;
const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_TIMEOUT_MS = 30_000;
const SENSITIVE_HEADER_NAMES = [
  'authorization',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'x-api-key',
  'api-key',
  'apikey',
  'x-auth-token',
];

type HttpResponseData = {
  bodyCacheId?: string;
  bodyLength: number;
  bodyPreview: string;
  contentType: string;
  headersPreview: Record<string, string>;
  method: string;
  ok: boolean;
  status: number;
  truncated: boolean;
  url: string;
};

type HttpNamedServiceData = {
  allowedMethods: string[];
  baseUrlDescription: string;
  serviceId: string;
  serviceName: string;
  serviceResult: unknown;
};

type HttpCookieStatusData = {
  rawCookieAccess: false;
  supportedActions: string[];
  summary: string;
};

function clampTimeout(value: number | undefined) {
  if (typeof value !== 'number') return DEFAULT_TIMEOUT_MS;
  return Math.max(1000, Math.min(MAX_TIMEOUT_MS, Math.round(value)));
}

function normalizeMethod(value: unknown, fallback = 'GET') {
  const method = typeof value === 'string' ? value.trim().toUpperCase() : fallback;
  return isOneOf(method, HTTP_METHODS) ? method : undefined;
}

function normalizeUploadMethod(value: unknown) {
  const method = typeof value === 'string' ? value.trim().toUpperCase() : 'POST';
  return isOneOf(method, UPLOAD_METHODS) ? method : undefined;
}

export function isPublicHttpToolUrl(value: string) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    if (!host || host === 'localhost' || host.endsWith('.local') || host === '::1' || host === '[::1]') return false;
    if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.)/.test(host)) return false;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return false;
    return true;
  } catch {
    return false;
  }
}

function readUrl(call: JunLuoToolCall) {
  const url = readStringInput(call.input, 'url');
  if (!url) return { error: validationFailed<HttpResponseData>(call, '缺少 HTTP URL', '没有发起 HTTP 请求'), url: '' };
  if (!isPublicHttpToolUrl(url)) {
    return {
      error: validationFailed<HttpResponseData>(call, '只支持公开 http/https URL，不支持本地、局域网或文件 URL', '没有发起 HTTP 请求'),
      url: '',
    };
  }
  return { error: null, url };
}

function readHeaders(call: JunLuoToolCall) {
  const value = call.input.headers;
  const headers: Record<string, string> = {};
  if (value === undefined) return { error: null, headers };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: validationFailed(call, 'headers 必须是对象', '没有发起 HTTP 请求'), headers };
  }
  for (const [rawName, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const name = rawName.trim();
    if (!name) continue;
    const lowerName = name.toLowerCase();
    if (SENSITIVE_HEADER_NAMES.includes(lowerName)) {
      return {
        error: validationFailed(call, `普通 http.request/http.upload 不允许携带敏感 header：${name}`, '没有发起 HTTP 请求'),
        headers,
      };
    }
    if (typeof rawValue !== 'string' && typeof rawValue !== 'number' && typeof rawValue !== 'boolean') {
      return { error: validationFailed(call, `header ${name} 的值必须是字符串、数字或布尔`, '没有发起 HTTP 请求'), headers };
    }
    headers[name] = String(rawValue);
  }
  return { error: null, headers };
}

function objectRecord(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function buildRequestBody(call: JunLuoToolCall, method: string, headers: Record<string, string>) {
  const hasBodyText = typeof call.input.bodyText === 'string' && call.input.bodyText.length > 0;
  const jsonBody = objectRecord(call.input.jsonBody);
  const formFields = objectRecord(call.input.formFields);
  const bodyCount = [hasBodyText, Boolean(jsonBody), Boolean(formFields)].filter(Boolean).length;
  if (bodyCount > 1) {
    return { error: validationFailed(call, 'bodyText、jsonBody、formFields 只能选择一种', '没有发起 HTTP 请求'), body: undefined };
  }
  if ((method === 'GET' || method === 'HEAD') && bodyCount) {
    return { error: validationFailed(call, `${method} 请求不允许携带 body`, '没有发起 HTTP 请求'), body: undefined };
  }
  if (hasBodyText) {
    const body = String(call.input.bodyText);
    if (body.length > MAX_BODY_CHARS) return { error: validationFailed(call, '请求 body 太大', '没有发起 HTTP 请求'), body: undefined };
    return { error: null, body };
  }
  if (jsonBody) {
    const body = JSON.stringify(jsonBody);
    if (body.length > MAX_BODY_CHARS) return { error: validationFailed(call, '请求 JSON body 太大', '没有发起 HTTP 请求'), body: undefined };
    if (!Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/json';
    }
    return { error: null, body };
  }
  if (formFields) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(formFields)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        params.append(key, String(value));
      }
    }
    const body = params.toString();
    if (body.length > MAX_BODY_CHARS) return { error: validationFailed(call, '请求表单 body 太大', '没有发起 HTTP 请求'), body: undefined };
    if (!Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    return { error: null, body };
  }
  return { error: null, body: undefined };
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function headersPreview(headers: Headers) {
  const preview: Record<string, string> = {};
  const read = typeof headers.forEach === 'function'
    ? (callback: (value: string, key: string) => void) => headers.forEach(callback)
    : undefined;
  if (read) {
    read((value, key) => {
      const lowerKey = key.toLowerCase();
      if (SENSITIVE_HEADER_NAMES.includes(lowerKey)) return;
      if (Object.keys(preview).length < 12) preview[key] = value.slice(0, 160);
    });
  }
  return preview;
}

function responseFileName(contentType: string) {
  const extension = /json/i.test(contentType) ? 'json' : /csv/i.test(contentType) ? 'csv' : 'txt';
  return `http-response-${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`;
}

async function buildHttpResponseData(url: string, method: string, response: Response): Promise<HttpResponseData> {
  const contentType = response.headers.get('content-type') ?? '';
  const body = await response.text();
  const bodyLength = body.length;
  const truncated = bodyLength > MAX_INLINE_RESPONSE_CHARS;
  let bodyCacheId: string | undefined;
  if (truncated) {
    const record = await writeTextFileToCache({
      mimeType: contentType || 'text/plain',
      name: responseFileName(contentType),
      text: body,
    });
    bodyCacheId = record.cacheId;
  }
  return {
    bodyCacheId,
    bodyLength,
    bodyPreview: body.slice(0, truncated ? RESPONSE_PREVIEW_CHARS : MAX_INLINE_RESPONSE_CHARS),
    contentType,
    headersPreview: headersPreview(response.headers),
    method,
    ok: response.ok,
    status: response.status,
    truncated,
    url,
  };
}

function httpStatusResult(call: JunLuoToolCall, data: HttpResponseData) {
  if (data.ok) {
    return createToolSuccessResult(call, `HTTP 请求成功：${data.status}`, data);
  }
  const now = Date.now();
  return {
    callId: call.callId,
    data,
    error: createToolError('EXECUTION_FAILED', `HTTP 返回失败状态：${data.status}`, {
      status: data.status,
      url: data.url,
    }),
    finishedAt: now,
    ok: false,
    startedAt: now,
    status: 'error',
    summary: `HTTP 请求完成但服务器返回失败状态：${data.status}`,
    toolId: call.toolId,
  } satisfies JunLuoToolResult<HttpResponseData>;
}

async function executeHttpRequest(call: JunLuoToolCall): Promise<JunLuoToolResult<HttpResponseData>> {
  const urlResult = readUrl(call);
  if (urlResult.error) return urlResult.error;
  const method = normalizeMethod(call.input.method);
  if (!method) return validationFailed(call, '不支持的 HTTP method', '没有发起 HTTP 请求');
  const headerResult = readHeaders(call);
  if (headerResult.error) return headerResult.error as JunLuoToolResult<HttpResponseData>;
  const bodyResult = buildRequestBody(call, method, headerResult.headers);
  if (bodyResult.error) return bodyResult.error as JunLuoToolResult<HttpResponseData>;
  try {
    const response = await fetchWithTimeout(urlResult.url, {
      body: bodyResult.body,
      headers: headerResult.headers,
      method,
    }, clampTimeout(readNumberInput(call.input, 'timeoutMs')));
    return httpStatusResult(call, await buildHttpResponseData(urlResult.url, method, response));
  } catch (error) {
    return createToolErrorResult(
      call,
      createToolError('EXECUTION_FAILED', error instanceof Error ? error.message : String(error)),
      'HTTP 请求没有完成',
    );
  }
}

function readUploadFiles(call: JunLuoToolCall) {
  const files = call.input.files;
  if (!Array.isArray(files) || !files.length) {
    return { error: validationFailed<HttpResponseData>(call, '缺少要上传的 files cacheId 列表', '没有发起上传请求'), files: [] };
  }
  const normalized: Array<{ cacheId: string; fieldName: string; fileName?: string }> = [];
  for (const item of files) {
    const record = objectRecord(item);
    if (!record) {
      return { error: validationFailed<HttpResponseData>(call, '上传文件必须使用 files 缓存 cacheId', '没有发起上传请求'), files: [] };
    }
    const cacheId = typeof record.cacheId === 'string' ? record.cacheId.trim() : '';
    if (!cacheId) {
      return { error: validationFailed<HttpResponseData>(call, '上传文件必须使用 files 缓存 cacheId', '没有发起上传请求'), files: [] };
    }
    normalized.push({
      cacheId,
      fieldName: typeof record.fieldName === 'string' && record.fieldName.trim() ? record.fieldName.trim() : 'file',
      fileName: typeof record.fileName === 'string' && record.fileName.trim() ? record.fileName.trim() : undefined,
    });
  }
  return { error: null, files: normalized };
}

async function executeHttpUpload(call: JunLuoToolCall): Promise<JunLuoToolResult<HttpResponseData>> {
  const urlResult = readUrl(call);
  if (urlResult.error) return urlResult.error;
  const method = normalizeUploadMethod(call.input.method);
  if (!method) return validationFailed(call, '上传只支持 POST 或 PUT', '没有发起上传请求');
  const headerResult = readHeaders(call);
  if (headerResult.error) return headerResult.error as JunLuoToolResult<HttpResponseData>;
  const fileResult = readUploadFiles(call);
  if (fileResult.error) return fileResult.error;
  const formData = new FormData();
  const fields = objectRecord(call.input.fields) ?? {};
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      formData.append(key, String(value));
    }
  }
  for (const file of fileResult.files) {
    const record = await getFileImportRecord(file.cacheId);
    if (!record) return validationFailed(call, `文件缓存不存在：${file.cacheId}`, '没有发起上传请求');
    formData.append(file.fieldName || 'file', {
      name: file.fileName || record.name,
      type: record.mimeType || 'application/octet-stream',
      uri: record.uri,
    } as unknown as Blob);
  }
  try {
    const response = await fetchWithTimeout(urlResult.url, {
      body: formData,
      headers: headerResult.headers,
      method,
    }, clampTimeout(readNumberInput(call.input, 'timeoutMs')));
    return httpStatusResult(call, await buildHttpResponseData(urlResult.url, method, response));
  } catch (error) {
    return createToolErrorResult(
      call,
      createToolError('EXECUTION_FAILED', error instanceof Error ? error.message : String(error)),
      '上传请求没有完成',
    );
  }
}

async function executeHttpNamedService(call: JunLuoToolCall, context?: JunLuoToolExecutorContext): Promise<JunLuoToolResult<HttpNamedServiceData>> {
  if (call.requestedBy === 'chat') {
    if (Object.keys(call.input).length) {
      return createToolErrorResult(call, createToolError('INVALID_ARGUMENTS', 'INVALID_ARGUMENTS'), '');
    }
    if (!context?.backendOverviewChat) {
      return createToolErrorResult(call, createToolError('TOOL_DISABLED', 'TOOL_DISABLED'), '');
    }
    return { ...await context.backendOverviewChat(call), data: undefined };
  }
  ensureBuiltinHttpNamedServices();
  const serviceId = readStringInput(call.input, 'serviceId');
  if (!serviceId) return validationFailed(call, '缺少 serviceId', '没有调用命名服务');
  const service = getHttpNamedService(serviceId);
  if (!service) {
    return createToolErrorResult(
      call,
      createToolError('VALIDATION_FAILED', `未知命名服务：${serviceId}`),
      '没有调用命名服务',
    );
  }
  const serviceResult = await service.execute(call.input);
  const data: HttpNamedServiceData = {
    allowedMethods: service.allowedMethods,
    baseUrlDescription: service.baseUrlDescription,
    serviceId: service.id,
    serviceName: service.name,
    serviceResult,
  };
  if (serviceResult.ok) {
    return createToolSuccessResult(call, serviceResult.summary, data);
  }
  const now = Date.now();
  return {
    callId: call.callId,
    data,
    error: createToolError('EXECUTION_FAILED', serviceResult.summary, serviceResult),
    finishedAt: now,
    ok: false,
    startedAt: now,
    status: 'error',
    summary: serviceResult.summary,
    toolId: call.toolId,
  };
}

function executeCookieStatus(call: JunLuoToolCall): JunLuoToolResult<HttpCookieStatusData> {
  const services = listHttpNamedServices();
  return createToolSuccessResult(call, 'HTTP Cookie 原文读取/写入没有开放', {
    rawCookieAccess: false,
    supportedActions: ['status', 'list_named_services'],
    summary: `当前只允许查看 Cookie 能力边界和 ${services.length} 个命名服务；不读取、不设置、不清除原始 Cookie。`,
  });
}

const headersSchema = {
  type: 'object' as const,
  description: '普通非敏感 header；Authorization/Cookie/X-Api-Key 会被拒绝',
  properties: {},
};

export const httpRequestTool: JunLuoToolDefinition<Record<string, unknown>, HttpResponseData> = {
  id: 'http.request',
  chatExposure: 'explicit_only',
  proactiveEligible: false,
  packageId: 'http',
  name: '受控 HTTP 请求',
  description: '向公开 http/https URL 发起受控请求；拒绝本地/局域网地址和敏感 header，大响应写入文件缓存。',
  inputSchema: {
    type: 'object',
    required: ['url'],
    properties: {
      url: { type: 'string', description: '公开 http/https URL' },
      method: { type: 'string', description: 'GET/POST/PUT/PATCH/DELETE/HEAD', enum: [...HTTP_METHODS] },
      headers: headersSchema,
      bodyText: { type: 'string', description: '文本请求体' },
      jsonBody: { type: 'object', description: 'JSON 请求体' },
      formFields: { type: 'object', description: '表单字段' },
      timeoutMs: { type: 'number', description: '超时时间，1000-30000ms' },
    },
  },
  permission: 'ask',
  riskLevel: 'external_network',
  readOnly: false,
  executor: executeHttpRequest,
};

export const httpUploadTool: JunLuoToolDefinition<Record<string, unknown>, HttpResponseData> = {
  id: 'http.upload',
  chatExposure: 'explicit_only',
  proactiveEligible: false,
  packageId: 'http',
  name: '上传缓存文件',
  description: '把 files 工具缓存里的 cacheId 文件以 multipart 方式上传到公开 http/https URL；不接受任意路径。',
  inputSchema: {
    type: 'object',
    required: ['url', 'files'],
    properties: {
      url: { type: 'string', description: '公开 http/https URL' },
      method: { type: 'string', description: 'POST/PUT', enum: [...UPLOAD_METHODS] },
      headers: headersSchema,
      fields: { type: 'object', description: '普通表单字段' },
      files: {
        type: 'array',
        description: '上传文件列表，每项包含 cacheId、fieldName、fileName',
        items: {
          type: 'object',
          properties: {
            cacheId: { type: 'string' },
            fieldName: { type: 'string' },
            fileName: { type: 'string' },
          },
        },
      },
      timeoutMs: { type: 'number', description: '超时时间，1000-30000ms' },
    },
  },
  permission: 'ask',
  riskLevel: 'social_action',
  readOnly: false,
  executor: executeHttpUpload,
};

export const httpCallNamedServiceTool: JunLuoToolDefinition<Record<string, unknown>, HttpNamedServiceData> = {
  id: 'http.call_named_service',
  chatExposure: 'explicit_only',
  proactiveEligible: false,
  packageId: 'http',
  name: '调用命名服务',
  description: '调用代码白名单里注册过的命名 HTTP/API 服务，例如君落后端健康检查或状态查询。',
  inputSchema: {
    type: 'object',
    required: ['serviceId'],
    properties: {
      serviceId: { type: 'string', description: '命名服务 ID，例如 junluo_backend.health' },
    },
  },
  permission: 'ask',
  riskLevel: 'external_network',
  readOnly: true,
  executor: executeHttpNamedService,
};

export const httpManageCookieStatusTool: JunLuoToolDefinition<Record<string, unknown>, HttpCookieStatusData> = {
  id: 'http.manage_cookie_status',
  chatExposure: 'explicit_only',
  proactiveEligible: false,
  packageId: 'http',
  name: '查看 Cookie 能力边界',
  description: '只返回 Cookie 能力状态和边界说明；不读取、不设置、不清除、不暴露原始 Cookie。',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'status/list_named_services', enum: ['status', 'list_named_services'] },
    },
  },
  permission: 'allow',
  riskLevel: 'read',
  readOnly: true,
  executor: executeCookieStatus,
};

export const httpToolPackage: JunLuoToolPackage = {
  id: 'http',
  name: 'HTTP/API 连接',
  description: '受控 HTTP 请求、缓存文件上传、命名服务健康检查和 Cookie 能力边界查询。',
  category: 'external_network',
  tools: [
    httpRequestTool,
    httpUploadTool,
    httpCallNamedServiceTool,
    httpManageCookieStatusTool,
  ],
  defaultEnabled: true,
  riskLevel: 'external_network',
  source: 'builtin',
};
