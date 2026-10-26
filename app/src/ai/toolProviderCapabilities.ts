import type { AiConnection } from './types';

export interface ToolProviderCapabilities {
  nativeTools: boolean;
  thinkingTools: boolean;
  toolChoiceMode: 'supported' | 'omit_when_thinking' | 'omit_always';
  reasoningReplay: 'required_for_tool_calls' | 'optional' | 'unsupported';
  assistantToolCallContent: 'required_non_null' | 'optional';
  strictMode: 'unsupported' | 'beta_endpoint' | 'standard_endpoint';
  prefixWithTools: boolean;
}

export type ToolProviderCapabilitySource =
  | 'official_profile'
  | 'verified_probe'
  | 'protocol_default'
  | 'disabled_default';

export interface ToolProviderCapabilityReport {
  version: 1;
  connectionId: string;
  connectionFingerprint: string;
  capabilities: ToolProviderCapabilities;
  source: 'verified_probe';
  verifiedAt: number;
}

export interface ResolvedToolProviderCapabilities {
  capabilities: ToolProviderCapabilities;
  connectionFingerprint: string;
  source: ToolProviderCapabilitySource;
}

export interface ToolProviderProbeEvidence {
  requestCount: number;
  nativeTools: boolean;
  thinkingTools: boolean;
  thinkingRequestOmittedToolChoice: boolean;
  reasoningReplayExact: boolean;
  assistantContentNonNull: boolean;
  strictBetaEndpoint: boolean;
  prefixWithTools: boolean;
  nonThinkingToolChoice: boolean;
}

const TOOL_PROVIDER_CAPABILITY_REPORTS_KEY = 'junluo:tool-provider-capability-reports:v1';
const MAX_STORED_REPORTS = 32;
const MAX_PROBE_REQUESTS = 6;

const OFFICIAL_DEEPSEEK_V4_CAPABILITIES: ToolProviderCapabilities = {
  nativeTools: true,
  thinkingTools: true,
  toolChoiceMode: 'omit_when_thinking',
  reasoningReplay: 'required_for_tool_calls',
  assistantToolCallContent: 'required_non_null',
  // Strict and prefix remain closed until this exact connection passes the probe.
  strictMode: 'unsupported',
  prefixWithTools: false,
};

const PROTOCOL_DEFAULT_CAPABILITIES: ToolProviderCapabilities = {
  nativeTools: true,
  thinkingTools: true,
  toolChoiceMode: 'supported',
  reasoningReplay: 'optional',
  assistantToolCallContent: 'required_non_null',
  strictMode: 'unsupported',
  prefixWithTools: false,
};

function sanitizedBaseUrl(baseUrl: string) {
  const trimmed = baseUrl.trim().replace(/\/+$/u, '');
  try {
    const url = new URL(trimmed);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/+$/u, '').toLowerCase();
  } catch {
    return trimmed.toLowerCase();
  }
}

function hashFingerprint(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function buildToolProviderConnectionFingerprint(connection: AiConnection) {
  return `tool-provider-v1-${hashFingerprint([
    connection.id.trim(),
    sanitizedBaseUrl(connection.baseUrl),
    connection.model.trim(),
  ].join('\n'))}`;
}

function isOfficialDeepSeekBaseUrl(baseUrl: string) {
  try {
    const url = new URL(baseUrl.trim());
    const path = url.pathname.replace(/\/+$/u, '') || '/';
    return url.protocol === 'https:'
      && url.hostname.toLowerCase() === 'api.deepseek.com'
      && (path === '/' || path === '/v1' || path === '/beta');
  } catch {
    return false;
  }
}

export function isOfficialDeepSeekV4Connection(connection: AiConnection) {
  const model = connection.model.trim();
  return connection.preset === 'deepseek'
    && isOfficialDeepSeekBaseUrl(connection.baseUrl)
    && (model === 'deepseek-v4-flash' || model === 'deepseek-v4-pro');
}

function isToolProviderCapabilities(value: unknown): value is ToolProviderCapabilities {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<ToolProviderCapabilities>;
  return typeof item.nativeTools === 'boolean'
    && typeof item.thinkingTools === 'boolean'
    && ['supported', 'omit_when_thinking', 'omit_always'].includes(item.toolChoiceMode ?? '')
    && ['required_for_tool_calls', 'optional', 'unsupported'].includes(item.reasoningReplay ?? '')
    && ['required_non_null', 'optional'].includes(item.assistantToolCallContent ?? '')
    && ['unsupported', 'beta_endpoint', 'standard_endpoint'].includes(item.strictMode ?? '')
    && typeof item.prefixWithTools === 'boolean'
    && (!item.thinkingTools || item.nativeTools)
    && (!item.prefixWithTools || item.nativeTools)
    && (item.strictMode === 'unsupported' || item.nativeTools);
}

function isCapabilityReport(value: unknown): value is ToolProviderCapabilityReport {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<ToolProviderCapabilityReport>;
  return item.version === 1
    && item.source === 'verified_probe'
    && typeof item.connectionId === 'string'
    && typeof item.connectionFingerprint === 'string'
    && typeof item.verifiedAt === 'number'
    && Number.isFinite(item.verifiedAt)
    && isToolProviderCapabilities(item.capabilities);
}

export function resolveToolProviderCapabilities(
  connection: AiConnection,
  report?: ToolProviderCapabilityReport | null,
): ResolvedToolProviderCapabilities {
  const connectionFingerprint = buildToolProviderConnectionFingerprint(connection);
  if (
    report
    && isCapabilityReport(report)
    && report.connectionId === connection.id
    && report.connectionFingerprint === connectionFingerprint
    && (report.capabilities.strictMode !== 'beta_endpoint' || isOfficialDeepSeekV4Connection(connection))
  ) {
    return {
      capabilities: { ...report.capabilities },
      connectionFingerprint,
      source: 'verified_probe',
    };
  }
  if (isOfficialDeepSeekV4Connection(connection)) {
    return {
      capabilities: { ...OFFICIAL_DEEPSEEK_V4_CAPABILITIES },
      connectionFingerprint,
      source: 'official_profile',
    };
  }
  return {
    capabilities: { ...PROTOCOL_DEFAULT_CAPABILITIES },
    connectionFingerprint,
    source: 'protocol_default',
  };
}

export function buildCapabilityReportFromProbe(
  connection: AiConnection,
  evidence: ToolProviderProbeEvidence,
  verifiedAt = Date.now(),
): ToolProviderCapabilityReport {
  if (!Number.isInteger(evidence.requestCount) || evidence.requestCount < 1 || evidence.requestCount > MAX_PROBE_REQUESTS) {
    throw new Error(`工具 capability 探针请求数必须位于 1—${MAX_PROBE_REQUESTS}。`);
  }
  if (!evidence.nativeTools) {
    throw new Error('工具 capability 探针没有验证原生 tools。');
  }
  if (evidence.thinkingTools && !evidence.thinkingRequestOmittedToolChoice) {
    throw new Error('thinking + tools 尚未验证省略 tool_choice。');
  }
  if (evidence.thinkingTools && (!evidence.reasoningReplayExact || !evidence.assistantContentNonNull)) {
    throw new Error('thinking 工具连续轮次证据不完整。');
  }
  if (evidence.strictBetaEndpoint && !isOfficialDeepSeekV4Connection(connection)) {
    throw new Error('DeepSeek strict beta 证据只适用于官方 V4 连接。');
  }
  return {
    version: 1,
    connectionId: connection.id,
    connectionFingerprint: buildToolProviderConnectionFingerprint(connection),
    capabilities: {
      nativeTools: true,
      thinkingTools: evidence.thinkingTools,
      toolChoiceMode: evidence.thinkingTools
        ? 'omit_when_thinking'
        : evidence.nonThinkingToolChoice
          ? 'supported'
          : 'omit_always',
      reasoningReplay: evidence.reasoningReplayExact
        ? 'required_for_tool_calls'
        : 'optional',
      assistantToolCallContent: evidence.assistantContentNonNull
        ? 'required_non_null'
        : 'optional',
      strictMode: evidence.strictBetaEndpoint ? 'beta_endpoint' : 'unsupported',
      prefixWithTools: evidence.prefixWithTools,
    },
    source: 'verified_probe',
    verifiedAt,
  };
}

type AsyncStorageLike = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
};

async function getAsyncStorage(): Promise<AsyncStorageLike> {
  const module = await import('@react-native-async-storage/async-storage');
  return module.default;
}

async function readStoredReports(storage?: AsyncStorageLike) {
  const target = storage ?? await getAsyncStorage();
  const raw = await target.getItem(TOOL_PROVIDER_CAPABILITY_REPORTS_KEY).catch(() => null);
  if (!raw) return [] as ToolProviderCapabilityReport[];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isCapabilityReport) : [];
  } catch {
    return [];
  }
}

export async function loadToolProviderCapabilities(
  connection: AiConnection,
  storage?: AsyncStorageLike,
) {
  const reports = await readStoredReports(storage);
  const fingerprint = buildToolProviderConnectionFingerprint(connection);
  const report = reports.find((item) => (
    item.connectionId === connection.id && item.connectionFingerprint === fingerprint
  ));
  return resolveToolProviderCapabilities(connection, report);
}

export async function saveToolProviderCapabilityReport(
  report: ToolProviderCapabilityReport,
  storage?: AsyncStorageLike,
) {
  if (!isCapabilityReport(report)) throw new Error('工具 capability 报告无效。');
  const target = storage ?? await getAsyncStorage();
  const reports = await readStoredReports(target);
  const next = [
    report,
    ...reports.filter((item) => item.connectionId !== report.connectionId),
  ].slice(0, MAX_STORED_REPORTS);
  await target.setItem(TOOL_PROVIDER_CAPABILITY_REPORTS_KEY, JSON.stringify(next));
}

export function getDeepSeekV4MigrationProposal(connection: AiConnection) {
  const isExactLegacyDefault = connection.provider === 'openai-compatible'
    && connection.preset === 'deepseek'
    && connection.baseUrl.trim().replace(/\/+$/u, '') === 'https://api.deepseek.com/v1'
    && connection.model.trim() === 'deepseek-chat';
  if (!isExactLegacyDefault) return null;
  return {
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
  } as const;
}

export function getDeepSeekBetaConnection(connection: AiConnection): AiConnection {
  const url = new URL(connection.baseUrl.trim());
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'api.deepseek.com') {
    throw new Error('DeepSeek strict beta 只允许官方 api.deepseek.com 连接。');
  }
  url.pathname = '/beta';
  url.search = '';
  url.hash = '';
  return { ...connection, baseUrl: url.toString().replace(/\/+$/u, '') };
}

export function getDeepSeekStandardConnection(connection: AiConnection): AiConnection {
  if (!isOfficialDeepSeekV4Connection(connection)) return connection;
  const url = new URL(connection.baseUrl.trim());
  url.pathname = '';
  url.search = '';
  url.hash = '';
  return { ...connection, baseUrl: url.toString().replace(/\/+$/u, '') };
}
