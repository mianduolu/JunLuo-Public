import type {
  LifeResearchPage,
  LifeResearchEvidence,
  LifeResearchSearchDiagnostic,
  LifeResearchSearchResult,
} from '../backend/backendClient';
import { executeAgentToolCall } from '../tools/toolAgentExecution';

export type WebSearchProviderId =
  | 'builtin_life_research'
  | 'github_voyage'
  | 'simple_web_search_mcp'
  | 'zero_api_key_web_search';

export type WebSearchProviderStatus = {
  detail: string;
  id: WebSearchProviderId;
  label: string;
  status: 'ready' | 'unavailable';
};

export type WebSearchProviderSearchResponse = {
  diagnostics: LifeResearchSearchDiagnostic[];
  providerId: WebSearchProviderId;
  providerLabel: string;
  results: LifeResearchSearchResult[];
};

export type WebSearchProviderPageResponse = {
  page: LifeResearchPage | null;
  providerId: WebSearchProviderId;
  providerLabel: string;
};

export type WebSearchProviderSearchResult = LifeResearchSearchResult;
export type WebSearchProviderPage = LifeResearchPage;
export type WebSearchProviderEvidence = LifeResearchEvidence;

export type WebVoyageProviderExecutionOptions = {
  backupRestoreLeaseHeld?: boolean;
};

const builtinProviderStatus: WebSearchProviderStatus = {
  detail: '当前链路已改为手机端多源优先；电脑后端作为增强补充，主要用于后续证据验证和深度读取。',
  id: 'builtin_life_research',
  label: '君落公开网页搜索',
  status: 'ready',
};

export function getWebSearchProviderStatus(): WebSearchProviderStatus {
  return builtinProviderStatus;
}

function lifeAgentSourceMessageId(kind: string, value: string) {
  return `life-web-voyage:${kind}:${value.slice(0, 80)}`;
}

export async function searchWebVoyageProvider(
  query: string,
  options: WebVoyageProviderExecutionOptions = {},
): Promise<WebSearchProviderSearchResponse> {
  const provider = getWebSearchProviderStatus();
  if (provider.status !== 'ready') throw new Error(`provider_unavailable:${provider.id}`);
  const result = await executeAgentToolCall({
    input: { query },
    requestedBy: 'life_agent',
    sourceMessageId: lifeAgentSourceMessageId('search', query),
    toolId: 'research.search_with_diagnostics',
  }, {
    backupRestoreLeaseHeld: options.backupRestoreLeaseHeld,
  });
  if (!result.ok) throw new Error(result.error?.message || result.summary);
  const data = result.data as { diagnostics?: LifeResearchSearchDiagnostic[]; results?: LifeResearchSearchResult[] };
  return {
    diagnostics: data.diagnostics ?? [],
    providerId: provider.id,
    providerLabel: provider.label,
    results: data.results ?? [],
  };
}

export async function fetchWebVoyageProviderPage(
  url: string,
  options: WebVoyageProviderExecutionOptions = {},
): Promise<WebSearchProviderPageResponse> {
  const provider = getWebSearchProviderStatus();
  if (provider.status !== 'ready') throw new Error(`provider_unavailable:${provider.id}`);
  const result = await executeAgentToolCall({
    input: { url },
    requestedBy: 'life_agent',
    sourceMessageId: lifeAgentSourceMessageId('fetch', url),
    toolId: 'research.fetch_page',
  }, {
    backupRestoreLeaseHeld: options.backupRestoreLeaseHeld,
  });
  if (!result.ok) throw new Error(result.error?.message || result.summary);
  return {
    page: result.data as LifeResearchPage,
    providerId: provider.id,
    providerLabel: provider.label,
  };
}

export async function verifyWebVoyageProviderEvidence(
  query: string,
  claim: string,
  options: WebVoyageProviderExecutionOptions = {},
): Promise<WebSearchProviderEvidence | null> {
  const result = await executeAgentToolCall({
    input: { claim, query },
    requestedBy: 'life_agent',
    sourceMessageId: lifeAgentSourceMessageId('verify', query),
    toolId: 'research.verify_claim',
  }, {
    backupRestoreLeaseHeld: options.backupRestoreLeaseHeld,
  });
  if (!result.ok) return null;
  return result.data as WebSearchProviderEvidence;
}
