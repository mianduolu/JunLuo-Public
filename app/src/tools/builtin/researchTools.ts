import {
  fetchLifeResearchPage,
  searchLifeResearchWithDiagnostics,
  verifyLifeResearchEvidence,
  type LifeResearchEvidence,
  type LifeResearchPage,
  type LifeResearchSearchContext,
  type LifeResearchSearchDiagnostic,
  type LifeResearchSearchResult,
} from '../../backend/backendClient';
import { AVAILABLE_MOBILE_SEARCH_ENGINE_IDS, searchMobileLifeResearch } from '../../backend/lifeResearchMobileSearch';
import { createToolSuccessResult } from '../toolResult';
import type { JunLuoToolCall, JunLuoToolDefinition, JunLuoToolExecutorContext, JunLuoToolPackage, JunLuoToolResult } from '../toolTypes';
import {
  readNumberInput,
  readStringArrayInput,
  readStringInput,
  validationFailed,
} from './builtinToolValidation';

type ResearchSearchData = {
  context?: LifeResearchSearchContext;
  query: string;
  results: LifeResearchSearchResult[];
};

type ResearchSearchWithDiagnosticsData = ResearchSearchData & {
  diagnostics: LifeResearchSearchDiagnostic[];
};

type ResearchFetchPageData = LifeResearchPage;

type ResearchVerifyClaimData = LifeResearchEvidence & {
  claim: string;
  query: string;
};

type ResearchSearchMultiData = {
  diagnostics: LifeResearchSearchDiagnostic[];
  query: string;
  results: LifeResearchSearchResult[];
  sourceCoverage: {
    engineCount: number;
    engines: string[];
    hostCount: number;
    providers: string[];
    resultCount: number;
  };
};

type ResearchImageCandidate = {
  author?: string;
  license?: string;
  originalUrl?: string;
  pageUrl: string;
  provider: string;
  thumbnailUrl?: string;
  title: string;
};

type ResearchImageSearchData = {
  candidates: ResearchImageCandidate[];
  providers: string[];
  query: string;
};

type ResearchAcademicWork = {
  authors: string[];
  containerTitle?: string;
  doi?: string;
  publishedYear?: number;
  publisher?: string;
  title: string;
  type?: string;
  url?: string;
};

type ResearchAcademicSearchData = {
  mode: 'keyword' | 'title' | 'author';
  query: string;
  works: ResearchAcademicWork[];
};

type ResearchDoiData = {
  doi: string;
  work: ResearchAcademicWork;
};

type ResearchCompareSourcesData = {
  diagnostics: LifeResearchSearchDiagnostic[];
  duplicateUrls: Array<{ count: number; url: string }>;
  hostCoverage: Array<{ count: number; host: string }>;
  providerCoverage: Array<{ count: number; provider: string }>;
  query: string;
  results: LifeResearchSearchResult[];
  warnings: string[];
};

const IMAGE_PROVIDER_IDS = ['wikimedia', 'openverse'] as const;
const ACADEMIC_SEARCH_MODES = ['keyword', 'title', 'author'] as const;

function limitResults<T>(items: T[], limit: number | undefined) {
  const normalizedLimit = Math.max(1, Math.min(10, Math.round(limit ?? 6)));
  return items.slice(0, normalizedLimit);
}

function limitExtendedResults<T>(items: T[], limit: number | undefined, max = 12) {
  const normalizedLimit = Math.max(1, Math.min(max, Math.round(limit ?? 8)));
  return items.slice(0, normalizedLimit);
}

function isHttpUrl(value: string) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function emptySearchResult(call: JunLuoToolCall, query: string, summary: string) {
  return validationFailed<ResearchSearchData>(call, `没有搜索到公开结果：${query}`, summary);
}

function normalizeEngineIds(input: Record<string, unknown>) {
  const requested = readStringArrayInput(input, 'engineIds');
  const allowed = new Set(AVAILABLE_MOBILE_SEARCH_ENGINE_IDS);
  if (!requested?.length) return AVAILABLE_MOBILE_SEARCH_ENGINE_IDS.slice(0, 3);
  const normalized = requested.map((item) => item.trim()).filter((item) => allowed.has(item));
  return normalized.length ? normalized : AVAILABLE_MOBILE_SEARCH_ENGINE_IDS.slice(0, 3);
}

function normalizeImageProviders(input: Record<string, unknown>) {
  const requested = readStringArrayInput(input, 'providers');
  if (!requested?.length) return [...IMAGE_PROVIDER_IDS];
  const allowed = new Set<string>(IMAGE_PROVIDER_IDS);
  const normalized = requested.map((item) => item.toLowerCase()).filter((item) => allowed.has(item));
  return normalized.length ? (normalized as Array<(typeof IMAGE_PROVIDER_IDS)[number]>) : [...IMAGE_PROVIDER_IDS];
}

function normalizeAcademicMode(input: Record<string, unknown>): (typeof ACADEMIC_SEARCH_MODES)[number] {
  const value = readStringInput(input, 'mode');
  return ACADEMIC_SEARCH_MODES.includes(value as (typeof ACADEMIC_SEARCH_MODES)[number])
    ? (value as (typeof ACADEMIC_SEARCH_MODES)[number])
    : 'keyword';
}

function getHost(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function countValues(values: string[]) {
  const counts = new Map<string, number>();
  values.filter(Boolean).forEach((value) => counts.set(value, (counts.get(value) ?? 0) + 1));
  return [...counts.entries()]
    .map(([value, count]) => ({ count, value }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

function firstString(value: unknown) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.find((item): item is string => typeof item === 'string');
  return undefined;
}

function getCrossrefYear(item: Record<string, unknown>) {
  const issued = item.issued as { ['date-parts']?: unknown } | undefined;
  const parts = issued?.['date-parts'];
  if (!Array.isArray(parts) || !Array.isArray(parts[0])) return undefined;
  const year = parts[0][0];
  return typeof year === 'number' && Number.isFinite(year) ? year : undefined;
}

function getCrossrefAuthors(item: Record<string, unknown>) {
  const authors = item.author;
  if (!Array.isArray(authors)) return [];
  return authors
    .map((author) => {
      if (!author || typeof author !== 'object') return '';
      const record = author as { family?: unknown; given?: unknown; name?: unknown };
      if (typeof record.name === 'string') return record.name;
      return [record.given, record.family].filter((part): part is string => typeof part === 'string' && !!part).join(' ');
    })
    .filter(Boolean);
}

function mapCrossrefWork(item: Record<string, unknown>): ResearchAcademicWork | null {
  const title = firstString(item.title)?.trim();
  if (!title) return null;
  const doi = typeof item.DOI === 'string' ? item.DOI : undefined;
  const url = typeof item.URL === 'string' ? item.URL : doi ? `https://doi.org/${encodeURIComponent(doi)}` : undefined;
  return {
    authors: getCrossrefAuthors(item),
    containerTitle: firstString(item['container-title']),
    doi,
    publishedYear: getCrossrefYear(item),
    publisher: typeof item.publisher === 'string' ? item.publisher : undefined,
    title,
    type: typeof item.type === 'string' ? item.type : undefined,
    url,
  };
}

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'JunLuoResearchTools/1.0 (metadata lookup)',
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function executeResearchSearch(call: JunLuoToolCall): Promise<JunLuoToolResult<ResearchSearchData>> {
  const query = readStringInput(call.input, 'query');
  if (!query) return validationFailed(call, '缺少搜索词', '没有执行搜索');
  const response = await searchLifeResearchWithDiagnostics(query);
  const results = limitResults(response.results, readNumberInput(call.input, 'limit'));
  if (!results.length) return emptySearchResult(call, query, `没有查到公开网页结果：${query}`);
  return createToolSuccessResult(call, `查到 ${results.length} 条公开网页结果：${query}`, {
    context: response.context,
    query,
    results,
  });
}

async function executeResearchSearchWithDiagnostics(
  call: JunLuoToolCall,
): Promise<JunLuoToolResult<ResearchSearchWithDiagnosticsData>> {
  const query = readStringInput(call.input, 'query');
  if (!query) return validationFailed(call, '缺少搜索词', '没有执行搜索');
  const response = await searchLifeResearchWithDiagnostics(query);
  const results = limitResults(response.results, readNumberInput(call.input, 'limit'));
  if (!results.length) {
    return createToolSuccessResult(call, `没有查到公开网页结果：${query}`, {
      context: response.context,
      diagnostics: response.diagnostics,
      query,
      results,
    });
  }
  return createToolSuccessResult(call, `查到 ${results.length} 条公开网页结果：${query}`, {
    context: response.context,
    diagnostics: response.diagnostics,
    query,
    results,
  });
}

async function executeResearchSearchMulti(call: JunLuoToolCall): Promise<JunLuoToolResult<ResearchSearchMultiData>> {
  const query = readStringInput(call.input, 'query');
  if (!query) return validationFailed(call, '缺少搜索词', '没有执行多源搜索');
  const limit = readNumberInput(call.input, 'limit');
  const maxEngines = Math.max(1, Math.min(5, Math.round(readNumberInput(call.input, 'maxEngines') ?? 3)));
  const engineIds = normalizeEngineIds(call.input).slice(0, maxEngines);
  const diagnostics: LifeResearchSearchDiagnostic[] = [];
  const results: LifeResearchSearchResult[] = [];
  for (const engineId of engineIds) {
    try {
      const response = await searchMobileLifeResearch(query, {
        engineIds: [engineId],
        maxEngines: 1,
        maxResults: Math.max(1, Math.min(10, Math.round(limit ?? 6))),
        minHostDelayMs: 0,
        maxRetries: 0,
      });
      diagnostics.push(...response.diagnostics.map((diagnostic) => ({ ...diagnostic, scope: 'phone' as const })));
      results.push(...response.results.map((result) => ({ ...result, foundVia: [engineId] })));
    } catch (error) {
      diagnostics.push({
        engines: [engineId],
        id: engineId,
        label: engineId,
        lastFailure: error instanceof Error ? error.message : String(error),
        resultCount: 0,
        scope: 'phone',
        status: 'error',
      });
    }
  }
  const uniqueByUrl = new Map<string, LifeResearchSearchResult>();
  for (const result of results) {
    const existing = uniqueByUrl.get(result.url);
    if (existing) {
      uniqueByUrl.set(result.url, { ...existing, foundVia: [...new Set([...(existing.foundVia ?? []), ...(result.foundVia ?? [])])] });
    } else {
      uniqueByUrl.set(result.url, result);
    }
  }
  const mergedResults = limitExtendedResults([...uniqueByUrl.values()], limit, 12);
  if (!mergedResults.length) return validationFailed(call, `没有搜索到多源结果：${query}`, `没有查到多源公开网页结果：${query}`);
  const hosts = [...new Set(mergedResults.map((result) => getHost(result.url)).filter(Boolean))];
  const providers = [...new Set(mergedResults.map((result) => result.provider || result.engine || '').filter(Boolean))];
  return createToolSuccessResult(call, `多源搜索查到 ${mergedResults.length} 条结果：${query}`, {
    diagnostics,
    query,
    results: mergedResults,
    sourceCoverage: {
      engineCount: engineIds.length,
      engines: engineIds,
      hostCount: hosts.length,
      providers,
      resultCount: mergedResults.length,
    },
  });
}

async function executeResearchFetchPage(
  call: JunLuoToolCall,
  context?: JunLuoToolExecutorContext,
): Promise<JunLuoToolResult<ResearchFetchPageData>> {
  const url = readStringInput(call.input, 'url');
  if (!url) return validationFailed(call, '缺少网页 URL', '没有读取网页');
  if (!isHttpUrl(url)) return validationFailed(call, '只支持 http/https 网页 URL', '没有读取网页');
  const page = await fetchLifeResearchPage(url, {
    runMobileCacheCommit: context?.runBackupRestoreDataEpochCommit,
  });
  if (!page) return validationFailed(call, `没有读取到网页：${url}`, '没有读取到网页内容');
  return createToolSuccessResult(call, `已读取网页：${page.title}`, page);
}

async function searchWikimediaImages(query: string, limit: number): Promise<ResearchImageCandidate[]> {
  const url = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrnamespace=6&gsrlimit=${limit}&gsrsearch=${encodeURIComponent(query)}&prop=imageinfo&iiprop=url|user|extmetadata&iiurlwidth=320&format=json&origin=*`;
  const payload = (await fetchJson(url)) as { query?: { pages?: Record<string, Record<string, unknown>> } };
  const pages = Object.values(payload.query?.pages ?? {});
  return pages.flatMap((page) => {
    const imageInfo = Array.isArray(page.imageinfo) ? (page.imageinfo[0] as Record<string, unknown> | undefined) : undefined;
    if (!imageInfo) return [];
    const metadata = imageInfo.extmetadata as Record<string, { value?: string }> | undefined;
    const originalUrl = typeof imageInfo.url === 'string' ? imageInfo.url : undefined;
    const pageUrl = typeof page.fullurl === 'string' ? page.fullurl : originalUrl;
    if (!pageUrl) return [];
    return [{
      author: typeof imageInfo.user === 'string' ? imageInfo.user : undefined,
      license: metadata?.LicenseShortName?.value || metadata?.UsageTerms?.value,
      originalUrl,
      pageUrl,
      provider: 'wikimedia',
      thumbnailUrl: typeof imageInfo.thumburl === 'string' ? imageInfo.thumburl : originalUrl,
      title: typeof page.title === 'string' ? page.title.replace(/^File:/, '') : query,
    }];
  });
}

async function searchOpenverseImages(query: string, limit: number): Promise<ResearchImageCandidate[]> {
  const url = `https://api.openverse.engineering/v1/images/?q=${encodeURIComponent(query)}&page_size=${limit}`;
  const payload = (await fetchJson(url)) as { results?: Array<Record<string, unknown>> };
  return (payload.results ?? []).flatMap((item) => {
    const pageUrl = typeof item.foreign_landing_url === 'string' ? item.foreign_landing_url : undefined;
    if (!pageUrl) return [];
    return [{
      author: typeof item.creator === 'string' ? item.creator : undefined,
      license: typeof item.license === 'string' ? item.license : undefined,
      originalUrl: typeof item.url === 'string' ? item.url : undefined,
      pageUrl,
      provider: 'openverse',
      thumbnailUrl: typeof item.thumbnail === 'string' ? item.thumbnail : undefined,
      title: typeof item.title === 'string' ? item.title : query,
    }];
  });
}

async function executeResearchSearchImages(call: JunLuoToolCall): Promise<JunLuoToolResult<ResearchImageSearchData>> {
  const query = readStringInput(call.input, 'query');
  if (!query) return validationFailed(call, '缺少图片搜索词', '没有执行图片搜索');
  const limit = Math.max(1, Math.min(10, Math.round(readNumberInput(call.input, 'limit') ?? 8)));
  const providers = normalizeImageProviders(call.input);
  const candidates: ResearchImageCandidate[] = [];
  for (const provider of providers) {
    try {
      if (provider === 'wikimedia') candidates.push(...await searchWikimediaImages(query, limit));
      if (provider === 'openverse') candidates.push(...await searchOpenverseImages(query, limit));
    } catch {
      // 单个图片来源失败时继续尝试其他公开来源。
    }
  }
  const uniqueByPage = new Map<string, ResearchImageCandidate>();
  candidates.forEach((candidate) => uniqueByPage.set(candidate.pageUrl, candidate));
  const limited = limitExtendedResults([...uniqueByPage.values()], limit, 10);
  if (!limited.length) return validationFailed(call, `没有找到图片候选：${query}`, `没有查到图片候选：${query}`);
  return createToolSuccessResult(call, `找到 ${limited.length} 个图片候选：${query}`, {
    candidates: limited,
    providers,
    query,
  });
}

async function executeResearchSearchAcademic(call: JunLuoToolCall): Promise<JunLuoToolResult<ResearchAcademicSearchData>> {
  const query = readStringInput(call.input, 'query');
  if (!query) return validationFailed(call, '缺少学术检索词', '没有执行学术检索');
  const mode = normalizeAcademicMode(call.input);
  const rows = Math.max(1, Math.min(10, Math.round(readNumberInput(call.input, 'rows') ?? 5)));
  const queryParam = mode === 'title' ? 'query.title' : mode === 'author' ? 'query.author' : 'query';
  const url = `https://api.crossref.org/works?${queryParam}=${encodeURIComponent(query)}&rows=${rows}`;
  const payload = (await fetchJson(url)) as { message?: { items?: Array<Record<string, unknown>> } };
  const works = (payload.message?.items ?? []).map(mapCrossrefWork).filter((item): item is ResearchAcademicWork => !!item);
  if (!works.length) return validationFailed(call, `没有查到 Crossref 学术元数据：${query}`, `没有查到学术元数据：${query}`);
  return createToolSuccessResult(call, `查到 ${works.length} 条 Crossref 学术元数据：${query}`, { mode, query, works });
}

async function executeResearchSearchDoi(call: JunLuoToolCall): Promise<JunLuoToolResult<ResearchDoiData>> {
  const doi = readStringInput(call.input, 'doi').replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '');
  if (!doi) return validationFailed(call, '缺少 DOI', '没有执行 DOI 检索');
  const payload = (await fetchJson(`https://api.crossref.org/works/${encodeURIComponent(doi)}`)) as { message?: Record<string, unknown> };
  const work = payload.message ? mapCrossrefWork(payload.message) : null;
  if (!work) return validationFailed(call, `没有查到 DOI 元数据：${doi}`, `没有查到 DOI 元数据：${doi}`);
  return createToolSuccessResult(call, `查到 DOI 元数据：${work.title}`, { doi, work });
}

async function executeResearchCompareSources(call: JunLuoToolCall): Promise<JunLuoToolResult<ResearchCompareSourcesData>> {
  const query = readStringInput(call.input, 'query');
  if (!query) return validationFailed(call, '缺少来源对比搜索词', '没有执行来源对比');
  const response = await searchLifeResearchWithDiagnostics(query);
  const results = limitExtendedResults(response.results, readNumberInput(call.input, 'limit'), 12);
  if (!results.length) return validationFailed(call, `没有可对比的公开来源：${query}`, `没有查到可对比来源：${query}`);
  const hostCoverage = countValues(results.map((result) => getHost(result.url))).map(({ value, count }) => ({ host: value, count }));
  const providerCoverage = countValues(results.map((result) => result.provider || result.engine || '')).map(({ value, count }) => ({ provider: value, count }));
  const duplicateUrls = countValues(results.map((result) => result.url)).filter((item) => item.count > 1).map(({ value, count }) => ({ url: value, count }));
  const warnings = [
    '来源对比只描述搜索结果分布，不提供真假判定。',
    duplicateUrls.length ? '存在重复 URL，说明不同来源覆盖并不完全独立。' : '',
    hostCoverage.length <= 1 ? '来源 host 较少，交叉验证强度有限。' : '',
  ].filter(Boolean);
  return createToolSuccessResult(call, `完成 ${results.length} 条公开来源的轻量对比：${query}`, {
    diagnostics: response.diagnostics,
    duplicateUrls,
    hostCoverage,
    providerCoverage,
    query,
    results,
    warnings,
  });
}

async function executeResearchVerifyClaim(call: JunLuoToolCall): Promise<JunLuoToolResult<ResearchVerifyClaimData>> {
  const query = readStringInput(call.input, 'query');
  const claim = readStringInput(call.input, 'claim');
  if (!query) return validationFailed(call, '缺少考证搜索词', '没有执行证据验证');
  if (!claim) return validationFailed(call, '缺少要验证的说法', '没有执行证据验证');
  const evidence = await verifyLifeResearchEvidence(query, claim);
  if (!evidence || evidence.status === 'failed' || evidence.status === 'skipped') {
    return validationFailed<ResearchVerifyClaimData>(
      call,
      evidence?.summary || '没有拿到有效证据验证结果',
      evidence?.summary || '没有完成证据验证',
    );
  }
  return createToolSuccessResult(call, `已完成证据验证：${evidence.verdict}`, {
    ...evidence,
    claim,
    query,
  });
}

export const researchSearchTool: JunLuoToolDefinition<Record<string, unknown>, ResearchSearchData> = {
  id: 'research.search',
  chatExposure: 'candidate',
  proactiveEligible: true,
  packageId: 'research',
  name: '公开网页搜索',
  description: '查找公开网页，返回标题、链接和摘要。适合小仓鼠明确要查资料，或 I 的公开网页远游需要一个普通公开主题时使用。',
  inputSchema: {
    type: 'object',
    required: ['query'],
    properties: {
      query: { type: 'string', description: '搜索词' },
      limit: { type: 'number', description: '最多返回结果数，默认 6，最大 10' },
    },
  },
  permission: 'ask',
  riskLevel: 'external_network',
  readOnly: true,
  executor: executeResearchSearch,
  agentEpochMode: 'read_only_outside_lease',
  backupRestoreSafeOutsideLease: true,
};

export const researchSearchWithDiagnosticsTool: JunLuoToolDefinition<Record<string, unknown>, ResearchSearchWithDiagnosticsData> = {
  id: 'research.search_with_diagnostics',
  chatExposure: 'candidate',
  proactiveEligible: true,
  packageId: 'research',
  name: '公开网页搜索（带诊断）',
  description: '查找公开网页，并返回搜索来源诊断。适合时效性问题、事实核对，或需要知道搜索链路是否可靠时使用。',
  inputSchema: researchSearchTool.inputSchema,
  permission: 'ask',
  riskLevel: 'external_network',
  readOnly: true,
  executor: executeResearchSearchWithDiagnostics,
};

export const researchSearchMultiTool: JunLuoToolDefinition<Record<string, unknown>, ResearchSearchMultiData> = {
  id: 'research.search_multi',
  chatExposure: 'candidate',
  proactiveEligible: true,
  packageId: 'research',
  name: '多源公开网页搜索',
  description: '用多个公开搜索来源查找网页结果，并返回来源覆盖情况。只用于公开网页，不代表事实已被验证。',
  inputSchema: {
    type: 'object',
    required: ['query'],
    properties: {
      query: { type: 'string', description: '搜索词' },
      engineIds: { type: 'array', description: '可选搜索引擎 ID 列表' },
      limit: { type: 'number', description: '最多返回结果数，默认 8，最大 12' },
      maxEngines: { type: 'number', description: '最多尝试来源数，默认 3，最大 5' },
    },
  },
  permission: 'ask',
  riskLevel: 'external_network',
  readOnly: true,
  executor: executeResearchSearchMulti,
};

export const researchFetchPageTool: JunLuoToolDefinition<Record<string, unknown>, ResearchFetchPageData> = {
  id: 'research.fetch_page',
  chatExposure: 'candidate',
  proactiveEligible: true,
  packageId: 'research',
  name: '读取公开网页',
  description: '读取一个 http/https 公开网页，返回标题、摘要、缓存 ID 和读取方式。',
  inputSchema: {
    type: 'object',
    required: ['url'],
    properties: {
      url: { type: 'string', description: 'http/https 网页 URL' },
    },
  },
  permission: 'ask',
  riskLevel: 'external_network',
  readOnly: true,
  backupRestoreSafeOutsideLease: true,
  executor: executeResearchFetchPage,
  // The query is read-only, but its existing local cache write must use the epoch commit callback.
  agentEpochMode: 'bounded_local_commits',
};

export const researchSearchImagesTool: JunLuoToolDefinition<Record<string, unknown>, ResearchImageSearchData> = {
  id: 'research.search_images',
  chatExposure: 'candidate',
  proactiveEligible: true,
  packageId: 'research',
  name: '公开图片候选搜索',
  description: '查找公开图片候选和来源页面，只返回元数据，不下载、不保存、不承诺可商用。',
  inputSchema: {
    type: 'object',
    required: ['query'],
    properties: {
      query: { type: 'string', description: '图片搜索词' },
      providers: { type: 'array', description: '可选图片来源，例如 wikimedia/openverse' },
      limit: { type: 'number', description: '最多返回候选数，默认 8，最大 10' },
    },
  },
  permission: 'ask',
  riskLevel: 'external_network',
  readOnly: true,
  executor: executeResearchSearchImages,
};

export const researchSearchAcademicTool: JunLuoToolDefinition<Record<string, unknown>, ResearchAcademicSearchData> = {
  id: 'research.search_academic',
  chatExposure: 'candidate',
  proactiveEligible: true,
  packageId: 'research',
  name: 'Crossref 学术元数据检索',
  description: '通过 Crossref 查询论文、书籍或期刊文章元数据；不读取论文全文，也不代表论文结论已验证。',
  inputSchema: {
    type: 'object',
    required: ['query'],
    properties: {
      query: { type: 'string', description: '学术检索词' },
      rows: { type: 'number', description: '最多返回条数，默认 5，最大 10' },
      mode: { type: 'string', enum: ['keyword', 'title', 'author'], description: '检索模式' },
    },
  },
  permission: 'ask',
  riskLevel: 'external_network',
  readOnly: true,
  executor: executeResearchSearchAcademic,
};

export const researchSearchDoiTool: JunLuoToolDefinition<Record<string, unknown>, ResearchDoiData> = {
  id: 'research.search_doi',
  chatExposure: 'candidate',
  proactiveEligible: true,
  packageId: 'research',
  name: 'DOI 元数据检索',
  description: '通过 Crossref 查询 DOI 元数据；不读取论文全文。',
  inputSchema: {
    type: 'object',
    required: ['doi'],
    properties: {
      doi: { type: 'string', description: 'DOI 或 DOI URL' },
    },
  },
  permission: 'ask',
  riskLevel: 'external_network',
  readOnly: true,
  executor: executeResearchSearchDoi,
};

export const researchCompareSourcesTool: JunLuoToolDefinition<Record<string, unknown>, ResearchCompareSourcesData> = {
  id: 'research.compare_sources',
  chatExposure: 'candidate',
  proactiveEligible: true,
  packageId: 'research',
  name: '公开来源轻量对比',
  description: '对公开搜索结果做 host、provider、重复 URL 和摘要分布对比；不输出真假判定。',
  inputSchema: {
    type: 'object',
    required: ['query'],
    properties: {
      query: { type: 'string', description: '来源对比搜索词' },
      limit: { type: 'number', description: '最多对比结果数，默认 8，最大 12' },
    },
  },
  permission: 'ask',
  riskLevel: 'external_network',
  readOnly: true,
  executor: executeResearchCompareSources,
};

export const researchVerifyClaimTool: JunLuoToolDefinition<Record<string, unknown>, ResearchVerifyClaimData> = {
  id: 'research.verify_claim',
  chatExposure: 'candidate',
  proactiveEligible: true,
  packageId: 'research',
  name: '证据验证',
  description: '搜索公开资料验证一个说法，返回证据强度、结论、来源摘要和提示。',
  inputSchema: {
    type: 'object',
    required: ['query', 'claim'],
    properties: {
      query: { type: 'string', description: '用于查证的搜索词' },
      claim: { type: 'string', description: '需要验证的说法' },
    },
  },
  permission: 'ask',
  riskLevel: 'external_network',
  readOnly: true,
  executor: executeResearchVerifyClaim,
};

export const researchToolPackage: JunLuoToolPackage = {
  id: 'research',
  name: '公开资料研究',
  description: '查找公开网页、读取网页内容、搜索图片候选、查询 Crossref 学术元数据，并在需要时验证外部事实。',
  category: 'external_research',
  tools: [
    researchSearchTool,
    researchSearchWithDiagnosticsTool,
    researchSearchMultiTool,
    researchFetchPageTool,
    researchSearchImagesTool,
    researchSearchAcademicTool,
    researchSearchDoiTool,
    researchCompareSourcesTool,
    researchVerifyClaimTool,
  ],
  defaultEnabled: true,
  riskLevel: 'external_network',
  source: 'builtin',
};
