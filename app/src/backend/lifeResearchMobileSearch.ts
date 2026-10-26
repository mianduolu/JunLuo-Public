export type MobileSearchEngineRole = 'primary' | 'fallback';

export type MobileSearchResult = {
  engine?: string;
  provider?: string;
  title: string;
  url: string;
  snippet: string;
};

export type MobileSearchDiagnostic = {
  attemptCount?: number;
  elapsedMs?: number;
  engine: string;
  engines: string[];
  httpStatus?: number;
  id: string;
  label: string;
  lastFailure?: string;
  lastFailureAt?: number | null;
  resultCount: number;
  role: MobileSearchEngineRole;
  scope: 'phone';
  skippedReason?: string;
  status: string;
  triedAt?: number;
};

export type MobileSearchEngine = {
  id: string;
  name: string;
  providerId: string;
  role: MobileSearchEngineRole;
  buildSearchUrl(query: string): string;
  parseResults(html: string, maxResults: number): MobileSearchResult[];
};

export type MobileSearchClient = {
  search(query: string, options?: MobileSearchOptions): Promise<MobileSearchResponse>;
};

export type MobileSearchResponse = {
  diagnostics: MobileSearchDiagnostic[];
  results: MobileSearchResult[];
};

export type MobileSearchFetch = (url: string, init?: RequestInit) => Promise<Response>;
export type MobileSearchSleep = (ms: number) => Promise<void>;

export type MobileSearchOptions = {
  engineIds?: string[];
  maxEngines?: number;
  fetcher?: MobileSearchFetch;
  maxRetries?: number;
  maxResults?: number;
  minHostDelayMs?: number;
  sleep?: MobileSearchSleep;
  timeoutMs?: number;
};

const MOBILE_SEARCH_ACCEPT_HEADER = 'text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.5';
const MOBILE_SEARCH_ACCEPT_LANGUAGE = 'zh-CN,zh;q=0.9,en;q=0.7';
const MOBILE_SEARCH_DEFAULT_MAX_RETRIES = 1;
const MOBILE_SEARCH_DEFAULT_MIN_HOST_DELAY_MS = 1200;
const MOBILE_SEARCH_DEFAULT_TIMEOUT_MS = 8000;
const MOBILE_SEARCH_USER_AGENT = 'Mozilla/5.0 (Linux; Android 13; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Mobile Safari/537.36';
const mobileSearchLastRequestAt = new Map<string, number>();

type MobileSearchFetchResult = {
  attemptCount: number;
  elapsedMs: number;
  html?: string;
  httpStatus?: number;
  lastFailure?: string;
  ok: boolean;
  triedAt: number;
};

type MobileSearchDiagnosticMeta = {
  attemptCount?: number;
  elapsedMs?: number;
  httpStatus?: number;
  triedAt?: number;
};

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function decodeHtmlEntities(value: string) {
  return value
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function compactText(value: string, limit = 2400) {
  return decodeHtmlEntities(value).replace(/\s+/g, ' ').trim().slice(0, limit);
}

function stripHtmlTags(value: string, limit = 2400) {
  return compactText(value.replace(/<[^>]+>/g, ' '), limit);
}

function compactDiagnosticText(value: unknown, limit = 160) {
  const text = value instanceof Error ? value.message : typeof value === 'string' ? value : String(value ?? '');
  return text.replace(/\s+/g, ' ').trim().slice(0, limit);
}

function backoffMs(attempt: number) {
  return Math.min(1000 * 2 ** attempt, 2000);
}

function retryAfterMs(response: Response, attempt: number) {
  const raw = response.headers.get('retry-after');
  if (!raw) return backoffMs(attempt);
  const seconds = Number.parseInt(raw, 10);
  return Number.isFinite(seconds) ? Math.min(Math.max(seconds, 0) * 1000, 10000) : backoffMs(attempt);
}

function classifyFetchError(error: unknown) {
  const name = error && typeof error === 'object' && 'name' in error ? String((error as { name?: unknown }).name ?? '') : '';
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (/AbortError/i.test(name) || /timeout|aborted/i.test(message)) return 'timeout';
  return `network error: ${compactDiagnosticText(message || 'request failed')}`;
}

async function throttleMobileSearchHost(url: string, minHostDelayMs: number, wait: MobileSearchSleep) {
  if (minHostDelayMs <= 0) return;
  let hostname = '';
  try {
    hostname = new URL(url).hostname;
  } catch {
    return;
  }
  const now = Date.now();
  const last = mobileSearchLastRequestAt.get(hostname) ?? 0;
  const delay = minHostDelayMs - (now - last);
  if (delay > 0) await wait(delay);
  mobileSearchLastRequestAt.set(hostname, Date.now());
}

function buildMobileSearchRequestInit(init: RequestInit = {}, signal?: AbortSignal): RequestInit {
  const hasHeadersClass = typeof Headers !== 'undefined';
  return {
    ...init,
    headers: {
      Accept: MOBILE_SEARCH_ACCEPT_HEADER,
      'Accept-Language': MOBILE_SEARCH_ACCEPT_LANGUAGE,
      'User-Agent': MOBILE_SEARCH_USER_AGENT,
      ...(init.headers && !(hasHeadersClass && init.headers instanceof Headers) && !Array.isArray(init.headers) ? init.headers : {}),
    },
    signal,
  };
}

async function fetchWithMobileSearchTimeout(
  fetcher: MobileSearchFetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
) {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Response>((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new Error('timeout'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      fetcher(url, buildMobileSearchRequestInit(init, controller.signal)),
      timeout,
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export async function fetchMobileSearchHtml(
  url: string,
  options: MobileSearchOptions = {},
): Promise<MobileSearchFetchResult> {
  const fetcher = options.fetcher ?? fetch;
  const maxRetries = Math.max(0, Math.min(2, Math.round(options.maxRetries ?? MOBILE_SEARCH_DEFAULT_MAX_RETRIES)));
  const timeoutMs = Math.max(100, Math.round(options.timeoutMs ?? MOBILE_SEARCH_DEFAULT_TIMEOUT_MS));
  const minHostDelayMs = Math.max(0, Math.round(options.minHostDelayMs ?? MOBILE_SEARCH_DEFAULT_MIN_HOST_DELAY_MS));
  const wait = options.sleep ?? sleep;
  const startedAt = Date.now();
  const triedAt = startedAt;
  let attemptCount = 0;
  let lastFailure = 'request failed';
  let httpStatus: number | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    attemptCount = attempt + 1;
    await throttleMobileSearchHost(url, minHostDelayMs, wait);
    try {
      const response = await fetchWithMobileSearchTimeout(fetcher, url, {}, timeoutMs);
      httpStatus = response.status;
      if (response.ok) {
        return {
          attemptCount,
          elapsedMs: Date.now() - startedAt,
          html: await response.text(),
          httpStatus,
          ok: true,
          triedAt,
        };
      }
      lastFailure = `HTTP ${response.status}`;
      if ((response.status === 429 || response.status === 503) && attempt < maxRetries) {
        await wait(retryAfterMs(response, attempt));
        continue;
      }
      break;
    } catch (error) {
      lastFailure = classifyFetchError(error);
      if (attempt < maxRetries) {
        await wait(backoffMs(attempt));
        continue;
      }
      break;
    }
  }

  return {
    attemptCount,
    elapsedMs: Date.now() - startedAt,
    httpStatus,
    lastFailure,
    ok: false,
    triedAt,
  };
}

function isPublicHttpUrl(url: string) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    if (!host || host === 'localhost' || host.endsWith('.local')) return false;
    if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.)/.test(host)) return false;
    const private172 = /^172\.(1[6-9]|2\d|3[0-1])\./.test(host);
    return !private172;
  } catch {
    return false;
  }
}

function unwrapDuckDuckGoUrl(rawUrl: string) {
  const decoded = decodeHtmlEntities(rawUrl);
  try {
    const parsed = new URL(decoded, 'https://duckduckgo.com');
    const wrapped = parsed.hostname.endsWith('duckduckgo.com') && parsed.searchParams.has('uddg')
      ? parsed.searchParams.get('uddg')
      : '';
    return wrapped ? decodeURIComponent(wrapped) : decoded;
  } catch {
    return decoded;
  }
}

function unwrapYahooUrl(rawUrl: string) {
  const decoded = decodeHtmlEntities(rawUrl);
  if (!decoded.includes('r.search.yahoo.com')) return decoded;
  const match = decoded.match(/\/RU=([^/]+)\//);
  return match ? decodeURIComponent(match[1] ?? '') : decoded;
}

function attrValue(attrs: string, name: string) {
  const quoted = attrs.match(new RegExp(`\\b${name}\\s*=\\s*(['"])(.*?)\\1`, 'i'));
  if (quoted) return decodeHtmlEntities(quoted[2] ?? '');
  const unquoted = attrs.match(new RegExp(`\\b${name}\\s*=\\s*([^\\s"'=<>\\x60]+)`, 'i'));
  return decodeHtmlEntities(unquoted?.[1] ?? '');
}

function findContainers(raw: string, tag: string, classPattern: RegExp) {
  const containers: string[] = [];
  const pattern = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  for (const match of raw.matchAll(pattern)) {
    const classes = attrValue(match[1] ?? '', 'class');
    if (classPattern.test(classes)) containers.push(match[2] ?? '');
  }
  return containers;
}

function findFirstLink(block: string, classPattern?: RegExp) {
  for (const match of block.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = match[1] ?? '';
    if (classPattern && !classPattern.test(attrValue(attrs, 'class'))) continue;
    return {
      href: attrValue(attrs, 'href'),
      title: stripHtmlTags(match[2] ?? '', 160),
    };
  }
  return { href: '', title: '' };
}

function firstText(block: string, patterns: RegExp[], limit = 240) {
  for (const pattern of patterns) {
    const match = block.match(pattern);
    const text = stripHtmlTags(match?.[1] ?? '', limit);
    if (text) return text;
  }
  return '';
}

function firstUrlText(block: string, patterns: RegExp[]) {
  const text = firstText(block, patterns, 240);
  if (!text) return '';
  return /^https?:\/\//i.test(text) ? text : `https://${text}`;
}

function resultUrlIsAllowed(url: string, blockedDomains: string[] = []) {
  if (!isPublicHttpUrl(url)) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return !blockedDomains.some((domain) => host === domain || host.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

function dedupeResults(results: MobileSearchResult[], maxResults: number) {
  const deduped: MobileSearchResult[] = [];
  const seen = new Set<string>();
  for (const result of results) {
    const url = result.url.trim();
    if (seen.has(url)) continue;
    seen.add(url);
    deduped.push(result);
    if (deduped.length >= maxResults) break;
  }
  return deduped;
}

function parseContainerResults(
  raw: string,
  maxResults: number,
  engine: string,
  provider: string,
  containers: string[],
  options: {
    blockedDomains?: string[];
    fallbackUrlPatterns?: RegExp[];
    linkClassPattern?: RegExp;
    snippetPatterns?: RegExp[];
    urlTransform?: (url: string) => string;
  } = {},
): MobileSearchResult[] {
  const results: MobileSearchResult[] = [];
  for (const block of containers) {
    const link = findFirstLink(block, options.linkClassPattern);
    const href = link.href && link.href !== '#' ? link.href : firstUrlText(block, options.fallbackUrlPatterns ?? []);
    const url = options.urlTransform ? options.urlTransform(href) : href;
    if (!link.title || !resultUrlIsAllowed(url, options.blockedDomains)) continue;
    results.push({
      engine,
      provider,
      snippet: firstText(block, options.snippetPatterns ?? []),
      title: link.title,
      url,
    });
    if (results.length >= maxResults) break;
  }
  return dedupeResults(results, maxResults);
}

function parseGenericAnchorResults(
  raw: string,
  maxResults: number,
  engine: string,
  provider: string,
  options: {
    blockedDomains?: string[];
    urlTransform?: (url: string) => string;
  } = {},
): MobileSearchResult[] {
  const results: MobileSearchResult[] = [];
  for (const match of raw.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = attrValue(match[1] ?? '', 'href');
    const url = options.urlTransform ? options.urlTransform(href) : href;
    const title = stripHtmlTags(match[2] ?? '', 160);
    if (!title || !resultUrlIsAllowed(url, options.blockedDomains)) continue;
    results.push({ engine, provider, snippet: '', title, url });
    if (results.length >= maxResults) break;
  }
  return dedupeResults(results, maxResults);
}

export function parseBraveMobileResults(html: string, maxResults: number): MobileSearchResult[] {
  try {
    const containers = findContainers(html, 'div', /\bsnippet\b/i);
    const results = parseContainerResults(html, maxResults, 'Brave', 'mobile_brave', containers, {
      blockedDomains: ['brave.com'],
      linkClassPattern: /\b(?:heading-serpresult|result-header)\b/i,
      snippetPatterns: [
        /<[^>]*class\s*=\s*['"][^'"]*snippet-description[^'"]*['"][^>]*>([\s\S]*?)<\/[^>]+>/i,
        /<[^>]*class\s*=\s*['"][^'"]*snippet-content[^'"]*['"][^>]*>([\s\S]*?)<\/[^>]+>/i,
      ],
    });
    return results.length
      ? results
      : parseGenericAnchorResults(html, maxResults, 'Brave', 'mobile_brave', { blockedDomains: ['brave.com'] });
  } catch {
    return [];
  }
}

export function parseBingMobileResults(html: string, maxResults: number): MobileSearchResult[] {
  try {
    const containers = findContainers(html, 'li', /\bb_algo\b/i);
    const results = parseContainerResults(html, maxResults, 'Bing', 'mobile_bing', containers, {
      blockedDomains: ['bing.com'],
      snippetPatterns: [
        /<[^>]*class\s*=\s*['"][^'"]*b_caption[^'"]*['"][^>]*>[\s\S]*?<p\b[^>]*>([\s\S]*?)<\/p>/i,
        /<p\b[^>]*>([\s\S]*?)<\/p>/i,
      ],
    });
    return results.length
      ? results
      : parseGenericAnchorResults(html, maxResults, 'Bing', 'mobile_bing', { blockedDomains: ['bing.com'] });
  } catch {
    return [];
  }
}

export function parseQwantMobileResults(html: string, maxResults: number): MobileSearchResult[] {
  try {
    const containers = [...html.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/gi)].map((match) => match[1] ?? '');
    const results = parseContainerResults(html, maxResults, 'Qwant', 'mobile_qwant', containers, {
      blockedDomains: ['qwant.com'],
      fallbackUrlPatterns: [
        /<span\b[^>]*class\s*=\s*['"][^'"]*(?:url|partner)[^'"]*['"][^>]*>([\s\S]*?)<\/span>/i,
      ],
      snippetPatterns: [
        /<p\b[^>]*>([\s\S]*?)<\/p>/i,
        /<[^>]*class\s*=\s*['"][^'"]*description[^'"]*['"][^>]*>([\s\S]*?)<\/[^>]+>/i,
      ],
    });
    return results.length
      ? results
      : parseGenericAnchorResults(html, maxResults, 'Qwant', 'mobile_qwant', { blockedDomains: ['qwant.com'] });
  } catch {
    return [];
  }
}

export function parseYahooMobileResults(html: string, maxResults: number): MobileSearchResult[] {
  try {
    const containers = [
      ...findContainers(html, 'li', /\balgo\b/i),
      ...findContainers(html, 'div', /\balgo\b/i),
    ];
    const results = parseContainerResults(html, maxResults, 'Yahoo', 'mobile_yahoo', containers, {
      blockedDomains: ['yahoo.com', 'yahoo.net'],
      snippetPatterns: [
        /<[^>]*class\s*=\s*['"][^'"]*compText[^'"]*['"][^>]*>([\s\S]*?)<\/[^>]+>/i,
        /<p\b[^>]*>([\s\S]*?)<\/p>/i,
      ],
      urlTransform: unwrapYahooUrl,
    });
    return results.length
      ? results
      : parseGenericAnchorResults(html, maxResults, 'Yahoo', 'mobile_yahoo', {
        blockedDomains: ['yahoo.com', 'yahoo.net'],
        urlTransform: unwrapYahooUrl,
      });
  } catch {
    return [];
  }
}

export function parseStartpageMobileResults(html: string, maxResults: number): MobileSearchResult[] {
  try {
    const containers = findContainers(html, 'div', /\b(?:w-gl__result|search-result|result)\b/i);
    const results = parseContainerResults(html, maxResults, 'Startpage', 'mobile_startpage', containers, {
      blockedDomains: ['startpage.com'],
      snippetPatterns: [
        /<[^>]*class\s*=\s*['"][^'"]*(?:w-gl__description|search-item__body|result-description)[^'"]*['"][^>]*>([\s\S]*?)<\/[^>]+>/i,
        /<p\b[^>]*>([\s\S]*?)<\/p>/i,
      ],
    });
    return results.length
      ? results
      : parseGenericAnchorResults(html, maxResults, 'Startpage', 'mobile_startpage', { blockedDomains: ['startpage.com'] });
  } catch {
    return [];
  }
}

export function parseDuckDuckGoMobileResults(html: string, maxResults: number): MobileSearchResult[] {
  try {
    const containers = findContainers(html, 'div', /\bresult\b/i);
    const results = parseContainerResults(html, maxResults, 'DuckDuckGo', 'mobile_duckduckgo', containers, {
      linkClassPattern: /\b(?:result__a|result-link)\b/i,
      snippetPatterns: [
        /<[^>]*class\s*=\s*['"][^'"]*result__snippet[^'"]*['"][^>]*>([\s\S]*?)<\/[^>]+>/i,
      ],
      urlTransform: unwrapDuckDuckGoUrl,
    });
    return results.length
      ? results
      : parseGenericAnchorResults(html, maxResults, 'DuckDuckGo', 'mobile_duckduckgo', { urlTransform: unwrapDuckDuckGoUrl });
  } catch {
    return [];
  }
}

function makeEngine(
  id: string,
  name: string,
  buildSearchUrl: (query: string) => string,
  parseResults: MobileSearchEngine['parseResults'] = () => [],
  role: MobileSearchEngineRole = 'primary',
): MobileSearchEngine {
  return {
    buildSearchUrl,
    id,
    name,
    parseResults(html: string, maxResults: number) {
      try {
        return parseResults(html, maxResults);
      } catch {
        return [];
      }
    },
    providerId: `mobile_${id}`,
    role,
  };
}

export const MOBILE_SEARCH_ENGINE_REGISTRY: Record<string, MobileSearchEngine> = {
  bing: makeEngine('bing', 'Bing', (query) => `https://www.bing.com/search?q=${encodeURIComponent(query)}`, parseBingMobileResults),
  brave: makeEngine('brave', 'Brave', (query) => `https://search.brave.com/search?q=${encodeURIComponent(query)}`, parseBraveMobileResults),
  duckduckgo: makeEngine(
    'duckduckgo',
    'DuckDuckGo',
    (query) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    parseDuckDuckGoMobileResults,
    'fallback',
  ),
  qwant: makeEngine('qwant', 'Qwant', (query) => `https://lite.qwant.com/?q=${encodeURIComponent(query)}`, parseQwantMobileResults),
  startpage: makeEngine(
    'startpage',
    'Startpage',
    (query) => `https://www.startpage.com/sp/search?query=${encodeURIComponent(query)}`,
    parseStartpageMobileResults,
  ),
  yahoo: makeEngine('yahoo', 'Yahoo', (query) => `https://search.yahoo.com/search?p=${encodeURIComponent(query)}`, parseYahooMobileResults),
};

export const DEFAULT_MOBILE_SEARCH_ENGINE_ORDER = [
  'brave',
  'bing',
  'qwant',
  'yahoo',
  'startpage',
  'duckduckgo',
] as const;

export const AVAILABLE_MOBILE_SEARCH_ENGINE_IDS = Object.keys(MOBILE_SEARCH_ENGINE_REGISTRY);

export function resolveMobileSearchEngines(ids: readonly string[] = DEFAULT_MOBILE_SEARCH_ENGINE_ORDER): MobileSearchEngine[] {
  const engines: MobileSearchEngine[] = [];
  for (const id of ids) {
    const engine = MOBILE_SEARCH_ENGINE_REGISTRY[id.toLowerCase()];
    if (engine) engines.push(engine);
  }
  return engines;
}

export function createMobileSearchDiagnostic(
  engine: MobileSearchEngine,
  status: string,
  resultCount: number,
  lastFailure?: string,
  meta: MobileSearchDiagnosticMeta = {},
): MobileSearchDiagnostic {
  return {
    attemptCount: meta.attemptCount,
    elapsedMs: meta.elapsedMs,
    engine: engine.name,
    engines: [engine.name],
    httpStatus: meta.httpStatus,
    id: engine.providerId,
    label: `手机端 ${engine.name}${engine.role === 'fallback' ? ' 兜底' : ''}`,
    lastFailure: lastFailure ? compactDiagnosticText(lastFailure) : undefined,
    lastFailureAt: lastFailure ? meta.triedAt ?? Date.now() : undefined,
    resultCount,
    role: engine.role,
    scope: 'phone',
    status,
    triedAt: meta.triedAt,
  };
}

function normalizeEngineResults(engine: MobileSearchEngine, results: MobileSearchResult[], maxResults: number) {
  const normalized: MobileSearchResult[] = [];
  const seen = new Set<string>();
  for (const result of results) {
    const url = result.url.trim();
    const title = compactText(result.title, 160);
    if (!title || !isPublicHttpUrl(url) || seen.has(url)) continue;
    seen.add(url);
    normalized.push({
      engine: result.engine || engine.name,
      provider: result.provider || engine.providerId,
      snippet: compactText(result.snippet || '', 420),
      title,
      url,
    });
    if (normalized.length >= maxResults) break;
  }
  return normalized;
}

export async function searchMobileLifeResearch(query: string, options: MobileSearchOptions = {}): Promise<MobileSearchResponse> {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) return { diagnostics: [], results: [] };
  const maxResults = Math.max(1, Math.min(10, Math.round(options.maxResults ?? 6)));
  const diagnostics: MobileSearchDiagnostic[] = [];
  const maxEngines = Math.max(1, Math.round(options.maxEngines ?? Number.POSITIVE_INFINITY));
  for (const engine of resolveMobileSearchEngines(options.engineIds).slice(0, maxEngines)) {
    try {
      const response = await fetchMobileSearchHtml(engine.buildSearchUrl(trimmedQuery), options);
      const meta = {
        attemptCount: response.attemptCount,
        elapsedMs: response.elapsedMs,
        httpStatus: response.httpStatus,
        triedAt: response.triedAt,
      };
      if (!response.ok) {
        diagnostics.push(createMobileSearchDiagnostic(engine, 'failed', 0, response.lastFailure, meta));
        continue;
      }
      const results = normalizeEngineResults(engine, engine.parseResults(response.html ?? '', maxResults), maxResults);
      if (results.length) {
        diagnostics.push(createMobileSearchDiagnostic(engine, 'success', results.length, undefined, meta));
        return { diagnostics, results };
      }
      diagnostics.push(createMobileSearchDiagnostic(engine, 'failed', 0, 'no parseable results', meta));
    } catch (error) {
      diagnostics.push(createMobileSearchDiagnostic(engine, 'failed', 0, compactDiagnosticText(error)));
    }
  }
  return { diagnostics, results: [] };
}

export const mobileSearchClient: MobileSearchClient = {
  search: searchMobileLifeResearch,
};
