import { Buffer } from 'buffer';

import { writeTextFileToCache } from '../fileToolStore';
import { getGithubToken, loadGithubConfigStatus, loadGithubSettings, normalizeGithubApiBaseUrl } from '../githubCredentialStore';
import { createToolError } from '../toolErrors';
import { resolveToolPermissionForCall } from '../toolPermissions';
import { getToolDefinition, listToolPackages } from '../toolRegistry';
import { createToolErrorResult, createToolSuccessResult } from '../toolResult';
import type { JunLuoToolCall, JunLuoToolDefinition, JunLuoToolExecutorContext, JunLuoToolPackage, JunLuoToolResult } from '../toolTypes';
import { isOneOf, readBooleanInput, readNumberInput, readOptionalStringInput, readStringArrayInput, readStringInput, validationFailed } from './builtinToolValidation';

const MAX_PER_PAGE = 50;
const DEFAULT_PER_PAGE = 20;
const MAX_INLINE_FILE_CHARS = 12_000;
const FILE_PREVIEW_CHARS = 4_000;
const MAX_BODY_CHARS = 20_000;
const MAX_FILE_CONTENT_CHARS = 200_000;
const GITHUB_TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'json', 'csv',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'py', 'kt', 'java', 'go', 'rs', 'rb', 'php',
  'c', 'cc', 'cpp', 'h', 'hpp', 'cs', 'swift',
  'html', 'css', 'scss', 'sass', 'less', 'xml', 'yaml', 'yml',
  'toml', 'ini', 'env', 'sh', 'bash', 'ps1', 'bat', 'gradle',
  'sql', 'graphql', 'gql',
]);

type GithubResponse<T = unknown> = {
  data?: T;
  error?: JunLuoToolResult<T>;
  status?: number;
};

type GithubRepositorySummary = {
  defaultBranch?: string;
  description?: string;
  fullName: string;
  htmlUrl?: string;
  language?: string;
  name: string;
  owner: string;
  private?: boolean;
  pushedAt?: string;
  stars?: number;
  updatedAt?: string;
};

type GithubFileData = {
  bodyCacheId?: string;
  contentPreview?: string;
  downloadUrl?: string;
  encoding?: string;
  htmlUrl?: string;
  isText: boolean;
  name: string;
  path: string;
  sha?: string;
  size?: number;
  truncated: boolean;
};

function clampPerPage(value: number | undefined) {
  if (typeof value !== 'number') return DEFAULT_PER_PAGE;
  return Math.max(1, Math.min(MAX_PER_PAGE, Math.round(value)));
}

function clampPage(value: number | undefined) {
  if (typeof value !== 'number') return 1;
  return Math.max(1, Math.min(100, Math.round(value)));
}

function ownerRepo(call: JunLuoToolCall) {
  const owner = readStringInput(call.input, 'owner');
  const repo = readStringInput(call.input, 'repo');
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(owner)) {
    return { error: validationFailed(call, 'owner 不能为空，且只能包含 GitHub 用户/组织名常见字符', '没有执行 GitHub 请求'), owner: '', repo: '' };
  }
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(repo)) {
    return { error: validationFailed(call, 'repo 不能为空，且只能包含仓库名常见字符', '没有执行 GitHub 请求'), owner: '', repo: '' };
  }
  return { error: null, owner, repo };
}

function readPositiveInteger(call: JunLuoToolCall, key: string) {
  const value = readNumberInput(call.input, key);
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
}

function normalizePath(value: string) {
  const path = value.trim().replace(/^\/+/, '');
  if (!path || path.includes('\0') || path.includes('..')) return '';
  return path;
}

function githubFileExtension(name: string) {
  const match = /\.([^.\/\\]+)$/.exec(name.trim());
  return match?.[1]?.toLowerCase() ?? '';
}

function isGithubTextFileName(name: string) {
  const extension = githubFileExtension(name);
  return Boolean(extension && GITHUB_TEXT_EXTENSIONS.has(extension));
}

function githubCacheFileName(name: string) {
  const extension = githubFileExtension(name);
  if (['txt', 'md', 'markdown', 'json', 'csv'].includes(extension)) return name;
  const safeName = name.replace(/[^A-Za-z0-9_.-]+/g, '_') || 'github-file';
  return safeName + '.txt';
}
function normalizeBranch(value?: string) {
  if (!value) return undefined;
  const branch = value.trim();
  if (!branch || branch.includes('\0') || branch.includes('..')) return undefined;
  return branch.slice(0, 160);
}

function trimBody(value?: string) {
  const body = (value ?? '').trim();
  if (body.length > MAX_BODY_CHARS) return body.slice(0, MAX_BODY_CHARS);
  return body;
}

function requestPath(path: string, params?: Record<string, string | number | boolean | undefined>) {
  const query = new URLSearchParams();
  Object.entries(params ?? {}).forEach(([key, value]) => {
    if (value !== undefined && value !== '') query.set(key, String(value));
  });
  const qs = query.toString();
  return qs ? `${path}?${qs}` : path;
}

function previewHeaders(response: Response) {
  const requestId = response.headers?.get?.('x-github-request-id') ?? undefined;
  const remaining = response.headers?.get?.('x-ratelimit-remaining') ?? undefined;
  const reset = response.headers?.get?.('x-ratelimit-reset') ?? undefined;
  return { requestId, remaining, reset };
}

async function parseGithubJson(response: Response) {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 500) };
  }
}

function githubErrorResult<T>(call: JunLuoToolCall, message: string, summary: string, details?: unknown) {
  return createToolErrorResult<T>(call, createToolError('EXECUTION_FAILED', message, details), summary);
}

async function githubRequest<T>(
  call: JunLuoToolCall,
  path: string,
  init: RequestInit = {},
  options: { requireToken?: boolean; publicVoyage?: boolean; isCurrent?: () => Promise<boolean> } = {},
): Promise<GithubResponse<T>> {
  if (options.publicVoyage) {
    const definition = getToolDefinition(call.toolId);
    const enabled = listToolPackages().some(item => item.id === 'github' && item.defaultEnabled);
    if (!enabled || !definition || (await resolveToolPermissionForCall(definition, call)).permission === 'deny') {
      return { error: createToolErrorResult<T>(call,
        createToolError('PERMISSION_DENIED', 'GitHub voyage tool is disabled or denied'), 'GitHub request not executed') };
    }
  }
  const settings = await loadGithubSettings();
  const apiBaseUrl = options.publicVoyage ? 'https://api.github.com' : normalizeGithubApiBaseUrl(settings.apiBaseUrl);
  const token = options.publicVoyage ? undefined : await getGithubToken();
  if (options.requireToken && !token) {
    return {
      error: createToolErrorResult<T>(
        call,
        createToolError('PERMISSION_DENIED', 'GitHub 写入工具需要先在设置页保存 Token'),
        '没有执行 GitHub 写入：缺少 Token',
      ),
    };
  }

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(init.headers as Record<string, string> | undefined),
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const controller = options.publicVoyage ? new AbortController() : undefined;
  const timeout = controller ? setTimeout(() => controller.abort(), 60_000) : undefined;
  try {
    if (options.publicVoyage && options.isCurrent && !await options.isCurrent()) {
      return { error: createToolErrorResult<T>(call,
        createToolError('TOOL_NOT_STARTED', 'GitHub voyage source, settings or restore epoch changed'), 'GitHub request not executed') };
    }
    const response = await fetch(`${apiBaseUrl}${path}`, {
      ...init,
      headers,
      ...(controller ? { signal: controller.signal } : {}),
    });
    const data = await parseGithubJson(response);
    if (!response.ok) {
      return {
        error: githubErrorResult<T>(
          call,
          `GitHub API 返回失败状态：${response.status}`,
          `GitHub 请求失败：${response.status}`,
          {
            githubMessage: typeof data?.message === 'string' ? data.message : undefined,
            status: response.status,
            ...previewHeaders(response),
          },
        ),
        status: response.status,
      };
    }
    return { data: data as T, status: response.status };
  } catch (error) {
    return {
      error: githubErrorResult<T>(
        call,
        error instanceof Error ? error.message : 'GitHub 网络请求失败',
        'GitHub 请求失败：网络不可用',
      ),
    };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function repoSummary(item: Record<string, unknown>): GithubRepositorySummary {
  const owner = item.owner && typeof item.owner === 'object' ? item.owner as Record<string, unknown> : {};
  return {
    defaultBranch: typeof item.default_branch === 'string' ? item.default_branch : undefined,
    description: typeof item.description === 'string' ? item.description : undefined,
    fullName: typeof item.full_name === 'string' ? item.full_name : '',
    htmlUrl: typeof item.html_url === 'string' ? item.html_url : undefined,
    language: typeof item.language === 'string' ? item.language : undefined,
    name: typeof item.name === 'string' ? item.name : '',
    owner: typeof owner.login === 'string' ? owner.login : '',
    private: typeof item.private === 'boolean' ? item.private : undefined,
    pushedAt: typeof item.pushed_at === 'string' ? item.pushed_at : undefined,
    stars: typeof item.stargazers_count === 'number' ? item.stargazers_count : undefined,
    updatedAt: typeof item.updated_at === 'string' ? item.updated_at : undefined,
  };
}

function issueSummary(item: Record<string, unknown>) {
  return {
    bodyPreview: typeof item.body === 'string' ? item.body.slice(0, 800) : undefined,
    comments: typeof item.comments === 'number' ? item.comments : undefined,
    createdAt: typeof item.created_at === 'string' ? item.created_at : undefined,
    htmlUrl: typeof item.html_url === 'string' ? item.html_url : undefined,
    labels: Array.isArray(item.labels)
      ? item.labels.map((label) => typeof label?.name === 'string' ? label.name : '').filter(Boolean).slice(0, 12)
      : [],
    number: typeof item.number === 'number' ? item.number : undefined,
    state: typeof item.state === 'string' ? item.state : undefined,
    title: typeof item.title === 'string' ? item.title : '',
    updatedAt: typeof item.updated_at === 'string' ? item.updated_at : undefined,
  };
}

function prSummary(item: Record<string, unknown>) {
  return {
    bodyPreview: typeof item.body === 'string' ? item.body.slice(0, 800) : undefined,
    createdAt: typeof item.created_at === 'string' ? item.created_at : undefined,
    draft: typeof item.draft === 'boolean' ? item.draft : undefined,
    head: item.head && typeof item.head === 'object' ? (item.head as Record<string, unknown>).ref : undefined,
    htmlUrl: typeof item.html_url === 'string' ? item.html_url : undefined,
    number: typeof item.number === 'number' ? item.number : undefined,
    state: typeof item.state === 'string' ? item.state : undefined,
    title: typeof item.title === 'string' ? item.title : '',
    updatedAt: typeof item.updated_at === 'string' ? item.updated_at : undefined,
  };
}

async function executeConfigStatus(call: JunLuoToolCall) {
  const status = await loadGithubConfigStatus();
  return createToolSuccessResult(call, status.hasToken ? `GitHub Token 已配置：末尾 ${status.tokenSuffix}` : 'GitHub Token 尚未配置', status);
}

async function executeSearchRepositories(call: JunLuoToolCall, context?: JunLuoToolExecutorContext) {
  const publicVoyage = call.requestedBy === 'life_agent' && call.sourceMessageId === 'life-github-voyage:search';
  const query = publicVoyage && typeof call.input.query === 'string' ? call.input.query : readStringInput(call.input, 'query');
  if (!query.trim()) return validationFailed(call, 'query 不能为空', '没有搜索 GitHub 仓库');
  const sort = readOptionalStringInput(call.input, 'sort');
  const order = isOneOf(call.input.order, ['asc', 'desc'] as const) ? call.input.order : 'desc';
  const request = requestPath('/search/repositories', {
    q: publicVoyage ? `${query} is:public` : query,
    sort: sort || undefined,
    order,
    page: clampPage(readNumberInput(call.input, 'page')),
    per_page: clampPerPage(readNumberInput(call.input, 'perPage')),
  });
  const response = await githubRequest<{ items?: Record<string, unknown>[]; total_count?: number }>(call, request, {}, {
    publicVoyage, isCurrent: context?.githubVoyageIsCurrent,
  });
  if (response.error) return response.error;
  const repositories = (response.data?.items ?? []).map(repoSummary);
  if (!repositories.length) return githubErrorResult(call, 'GitHub 仓库搜索没有结果', `没有搜索到 GitHub 仓库：${query}`);
  return createToolSuccessResult(call, `搜索到 ${repositories.length} 个 GitHub 仓库：${query}`, {
    query,
    repositories,
    totalCount: response.data?.total_count,
  });
}

async function executeGetReadme(call: JunLuoToolCall, context?: JunLuoToolExecutorContext) {
  const parsed = ownerRepo(call);
  if (parsed.error) return parsed.error;
  const response = await githubRequest<Record<string, unknown>>(call,
    requestPath(`/repos/${parsed.owner}/${parsed.repo}/readme`, { ref: readOptionalStringInput(call.input, 'ref') }),
    {}, { publicVoyage: true, isCurrent: context?.githubVoyageIsCurrent });
  if (response.error) return response.error;
  const data = response.data ?? {};
  const name = typeof data.name === 'string' ? data.name : '';
  const encoded = typeof data.content === 'string' ? data.content.replace(/\s/g, '') : '';
  if (data.type !== 'file' || data.encoding !== 'base64'
    || (!/^readme$/i.test(name) && !isGithubTextFileName(name) && !/\.(rst|adoc|rdoc|org)$/i.test(name))
    || !encoded || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    return validationFailed(call, 'README is not available as base64 text', 'README unavailable');
  }
  const bytes = Buffer.from(encoded, 'base64');
  const decoded = bytes.toString('utf8');
  if (!Buffer.from(decoded, 'utf8').equals(bytes) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(decoded)
    || decoded.length > MAX_FILE_CONTENT_CHARS || !decoded.trim()) {
    return validationFailed(call, 'README text is invalid or exceeds 200k characters', 'README unavailable');
  }
  return createToolSuccessResult(call, 'README read', { body: decoded.slice(0, MAX_INLINE_FILE_CHARS) });
}

async function executeGetRepository(call: JunLuoToolCall) {
  const parsed = ownerRepo(call);
  if (parsed.error) return parsed.error;
  const response = await githubRequest<Record<string, unknown>>(call, `/repos/${parsed.owner}/${parsed.repo}`);
  if (response.error) return response.error;
  return createToolSuccessResult(call, `已读取 GitHub 仓库：${parsed.owner}/${parsed.repo}`, {
    repository: repoSummary(response.data ?? {}),
  });
}

async function executeListIssues(call: JunLuoToolCall) {
  const parsed = ownerRepo(call);
  if (parsed.error) return parsed.error;
  const state = isOneOf(call.input.state, ['open', 'closed', 'all'] as const) ? call.input.state : 'open';
  const response = await githubRequest<Record<string, unknown>[]>(call, requestPath(`/repos/${parsed.owner}/${parsed.repo}/issues`, {
    state,
    labels: readOptionalStringInput(call.input, 'labels'),
    creator: readOptionalStringInput(call.input, 'creator'),
    page: clampPage(readNumberInput(call.input, 'page')),
    per_page: clampPerPage(readNumberInput(call.input, 'perPage')),
  }));
  if (response.error) return response.error;
  const includePullRequests = readBooleanInput(call.input, 'includePullRequests') === true;
  const issues = (response.data ?? [])
    .filter((item) => includePullRequests || !item.pull_request)
    .map(issueSummary);
  return createToolSuccessResult(call, `读取到 ${issues.length} 条 GitHub issue`, { issues, owner: parsed.owner, repo: parsed.repo, state });
}

async function executeListIssueComments(call: JunLuoToolCall) {
  const parsed = ownerRepo(call);
  if (parsed.error) return parsed.error;
  const issueNumber = readPositiveInteger(call, 'issueNumber');
  if (!issueNumber) return validationFailed(call, 'issueNumber 必须是正整数', '没有读取 GitHub issue 评论');
  const response = await githubRequest<Record<string, unknown>[]>(call, requestPath(`/repos/${parsed.owner}/${parsed.repo}/issues/${issueNumber}/comments`, {
    page: clampPage(readNumberInput(call.input, 'page')),
    per_page: clampPerPage(readNumberInput(call.input, 'perPage')),
  }));
  if (response.error) return response.error;
  const comments = (response.data ?? []).map((item) => ({
    author: item.user && typeof item.user === 'object' ? (item.user as Record<string, unknown>).login : undefined,
    bodyPreview: typeof item.body === 'string' ? item.body.slice(0, 1200) : '',
    createdAt: typeof item.created_at === 'string' ? item.created_at : undefined,
    htmlUrl: typeof item.html_url === 'string' ? item.html_url : undefined,
    id: typeof item.id === 'number' ? item.id : undefined,
  }));
  return createToolSuccessResult(call, `读取到 ${comments.length} 条 GitHub issue 评论`, { comments, issueNumber, owner: parsed.owner, repo: parsed.repo });
}

async function executeListPullRequests(call: JunLuoToolCall) {
  const parsed = ownerRepo(call);
  if (parsed.error) return parsed.error;
  const state = isOneOf(call.input.state, ['open', 'closed', 'all'] as const) ? call.input.state : 'open';
  const response = await githubRequest<Record<string, unknown>[]>(call, requestPath(`/repos/${parsed.owner}/${parsed.repo}/pulls`, {
    state,
    head: readOptionalStringInput(call.input, 'head'),
    base: readOptionalStringInput(call.input, 'base'),
    page: clampPage(readNumberInput(call.input, 'page')),
    per_page: clampPerPage(readNumberInput(call.input, 'perPage')),
  }));
  if (response.error) return response.error;
  const pullRequests = (response.data ?? []).map(prSummary);
  return createToolSuccessResult(call, `读取到 ${pullRequests.length} 个 GitHub PR`, { owner: parsed.owner, pullRequests, repo: parsed.repo, state });
}

async function executeGetPullRequest(call: JunLuoToolCall) {
  const parsed = ownerRepo(call);
  if (parsed.error) return parsed.error;
  const pullNumber = readPositiveInteger(call, 'pullNumber');
  if (!pullNumber) return validationFailed(call, 'pullNumber 必须是正整数', '没有读取 GitHub PR');
  const response = await githubRequest<Record<string, unknown>>(call, `/repos/${parsed.owner}/${parsed.repo}/pulls/${pullNumber}`);
  if (response.error) return response.error;
  return createToolSuccessResult(call, `已读取 GitHub PR #${pullNumber}`, { owner: parsed.owner, pullRequest: prSummary(response.data ?? {}), repo: parsed.repo });
}

async function executeGetFile(call: JunLuoToolCall) {
  const parsed = ownerRepo(call);
  if (parsed.error) return parsed.error;
  const path = normalizePath(readStringInput(call.input, 'path'));
  if (!path) return validationFailed(call, 'path 不能为空，且不能包含 ..', '没有读取 GitHub 文件');
  const response = await githubRequest<Record<string, unknown>>(call, requestPath(`/repos/${parsed.owner}/${parsed.repo}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}`, {
    ref: readOptionalStringInput(call.input, 'ref'),
  }));
  if (response.error) return response.error;
  const data = response.data ?? {};
  if (data.type && data.type !== 'file') return validationFailed(call, '当前路径不是文件', '没有读取 GitHub 文件内容');
  const name = typeof data.name === 'string' ? data.name : path.split('/').pop() ?? 'github-file.txt';
  const encoded = typeof data.content === 'string' ? data.content.replace(/\s/g, '') : '';
  const decoded = encoded ? Buffer.from(encoded, 'base64').toString('utf8') : '';
  const isText = Boolean(decoded) && isGithubTextFileName(name);
  let bodyCacheId: string | undefined;
  const truncated = isText && decoded.length > MAX_INLINE_FILE_CHARS;
  if (isText && decoded.length > MAX_FILE_CONTENT_CHARS) {
    return validationFailed(call, 'GitHub 文件太大，第一版不读取超过 200k 字符的文本', '没有读取 GitHub 文件内容：文件太大');
  }
  if (truncated) {
    const record = await writeTextFileToCache({
      mimeType: 'text/plain',
      name: githubCacheFileName(name),
      text: decoded,
    });
    bodyCacheId = record.cacheId;
  }
  const file: GithubFileData = {
    bodyCacheId,
    contentPreview: isText ? decoded.slice(0, truncated ? FILE_PREVIEW_CHARS : MAX_INLINE_FILE_CHARS) : undefined,
    downloadUrl: typeof data.download_url === 'string' ? data.download_url : undefined,
    encoding: typeof data.encoding === 'string' ? data.encoding : undefined,
    htmlUrl: typeof data.html_url === 'string' ? data.html_url : undefined,
    isText,
    name,
    path: typeof data.path === 'string' ? data.path : path,
    sha: typeof data.sha === 'string' ? data.sha : undefined,
    size: typeof data.size === 'number' ? data.size : undefined,
    truncated,
  };
  return createToolSuccessResult(call, isText ? `已读取 GitHub 文件：${path}` : `已读取 GitHub 文件信息：${path}（不是可预览文本）`, {
    file,
    owner: parsed.owner,
    repo: parsed.repo,
  });
}

async function executeCreateIssue(call: JunLuoToolCall) {
  const parsed = ownerRepo(call);
  if (parsed.error) return parsed.error;
  const title = readStringInput(call.input, 'title');
  if (!title) return validationFailed(call, 'title 不能为空', '没有创建 GitHub issue');
  const body = trimBody(readOptionalStringInput(call.input, 'body'));
  const payload = {
    title,
    ...(body ? { body } : {}),
    labels: readStringArrayInput(call.input, 'labels'),
    assignees: readStringArrayInput(call.input, 'assignees'),
  };
  const response = await githubRequest<Record<string, unknown>>(call, `/repos/${parsed.owner}/${parsed.repo}/issues`, {
    body: JSON.stringify(payload),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  }, { requireToken: true });
  if (response.error) return response.error;
  const issue = issueSummary(response.data ?? {});
  return createToolSuccessResult(call, `已创建 GitHub issue #${issue.number ?? '?'}：${title}`, { issue, owner: parsed.owner, repo: parsed.repo });
}

async function executeCommentIssue(call: JunLuoToolCall) {
  const parsed = ownerRepo(call);
  if (parsed.error) return parsed.error;
  const issueNumber = readPositiveInteger(call, 'issueNumber');
  const body = trimBody(readStringInput(call.input, 'body'));
  if (!issueNumber) return validationFailed(call, 'issueNumber 必须是正整数', '没有评论 GitHub issue');
  if (!body) return validationFailed(call, 'body 不能为空', '没有评论 GitHub issue');
  const response = await githubRequest<Record<string, unknown>>(call, `/repos/${parsed.owner}/${parsed.repo}/issues/${issueNumber}/comments`, {
    body: JSON.stringify({ body }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  }, { requireToken: true });
  if (response.error) return response.error;
  return createToolSuccessResult(call, `已评论 GitHub issue #${issueNumber}`, {
    comment: {
      bodyPreview: typeof response.data?.body === 'string' ? response.data.body.slice(0, 800) : body.slice(0, 800),
      htmlUrl: typeof response.data?.html_url === 'string' ? response.data.html_url : undefined,
      id: typeof response.data?.id === 'number' ? response.data.id : undefined,
    },
    issueNumber,
    owner: parsed.owner,
    repo: parsed.repo,
  });
}

async function executeCreatePullRequest(call: JunLuoToolCall) {
  const parsed = ownerRepo(call);
  if (parsed.error) return parsed.error;
  const title = readStringInput(call.input, 'title');
  const head = readStringInput(call.input, 'head');
  const base = readStringInput(call.input, 'base');
  if (!title || !head || !base) return validationFailed(call, 'title、head、base 都不能为空', '没有创建 GitHub PR');
  const response = await githubRequest<Record<string, unknown>>(call, `/repos/${parsed.owner}/${parsed.repo}/pulls`, {
    body: JSON.stringify({
      title,
      head,
      base,
      body: trimBody(readOptionalStringInput(call.input, 'body')),
      draft: readBooleanInput(call.input, 'draft') === true,
    }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  }, { requireToken: true });
  if (response.error) return response.error;
  const pullRequest = prSummary(response.data ?? {});
  return createToolSuccessResult(call, `已创建 GitHub PR #${pullRequest.number ?? '?'}：${title}`, { owner: parsed.owner, pullRequest, repo: parsed.repo });
}

async function executeUpdateFile(call: JunLuoToolCall) {
  const parsed = ownerRepo(call);
  if (parsed.error) return parsed.error;
  const path = normalizePath(readStringInput(call.input, 'path'));
  const message = readStringInput(call.input, 'message');
  const content = readStringInput(call.input, 'content');
  const sha = readStringInput(call.input, 'sha');
  if (!path || !message || !content) return validationFailed(call, 'path、message、content 都不能为空', '没有更新 GitHub 文件');
  if (content.length > MAX_FILE_CONTENT_CHARS) return validationFailed(call, 'content 太大', '没有更新 GitHub 文件');
  const response = await githubRequest<Record<string, unknown>>(call, `/repos/${parsed.owner}/${parsed.repo}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}`, {
    body: JSON.stringify({
      branch: normalizeBranch(readOptionalStringInput(call.input, 'branch')),
      content: Buffer.from(content, 'utf8').toString('base64'),
      message,
      ...(sha ? { sha } : {}),
    }),
    headers: { 'Content-Type': 'application/json' },
    method: 'PUT',
  }, { requireToken: true });
  if (response.error) return response.error;
  return createToolSuccessResult(call, `已更新 GitHub 文件：${path}`, { owner: parsed.owner, path, repo: parsed.repo, result: response.data });
}

async function executeDeleteFile(call: JunLuoToolCall) {
  const parsed = ownerRepo(call);
  if (parsed.error) return parsed.error;
  const path = normalizePath(readStringInput(call.input, 'path'));
  const message = readStringInput(call.input, 'message');
  const sha = readStringInput(call.input, 'sha');
  if (!path || !message || !sha) return validationFailed(call, 'path、message、sha 都不能为空', '没有删除 GitHub 文件');
  const response = await githubRequest<Record<string, unknown>>(call, `/repos/${parsed.owner}/${parsed.repo}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}`, {
    body: JSON.stringify({
      branch: normalizeBranch(readOptionalStringInput(call.input, 'branch')),
      message,
      sha,
    }),
    headers: { 'Content-Type': 'application/json' },
    method: 'DELETE',
  }, { requireToken: true });
  if (response.error) return response.error;
  return createToolSuccessResult(call, `已删除 GitHub 文件：${path}`, { owner: parsed.owner, path, repo: parsed.repo, result: response.data });
}

const emptySchema = { type: 'object' as const };
const ownerRepoProps = {
  owner: { type: 'string' as const, description: 'GitHub owner / organization' },
  repo: { type: 'string' as const, description: 'GitHub repository name' },
};

function tool(definition: Omit<JunLuoToolDefinition, 'packageId'>): JunLuoToolDefinition {
  return { ...definition, packageId: 'github' };
}

export const githubToolPackage: JunLuoToolPackage = {
  id: 'github',
  name: 'GitHub 与开发协作',
  description: '查询 GitHub 仓库、issue、PR 和文件，并在授权后创建 issue、评论或 PR。',
  category: 'development',
  defaultEnabled: true,
  riskLevel: 'external_network',
  source: 'builtin',
  tools: [
    tool({
      id: 'github.get_config_status',
      chatExposure: 'explicit_only',
      proactiveEligible: false,
      name: '查看 GitHub 配置状态',
      description: '查看 GitHub Token 是否已配置和 API base URL；只返回脱敏状态。',
      inputSchema: emptySchema,
      permission: 'allow',
      riskLevel: 'read',
      readOnly: true,
      executor: executeConfigStatus,
    }),
    tool({
      id: 'github.search_repositories',
      agentEpochMode: 'read_only_outside_lease',
      backupRestoreSafeOutsideLease: true,
      chatExposure: 'explicit_only',
      proactiveEligible: false,
      name: '搜索 GitHub 仓库',
      description: '按关键词搜索公开 GitHub 仓库。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          sort: { type: 'string', enum: ['stars', 'forks', 'help-wanted-issues', 'updated'] },
          order: { type: 'string', enum: ['asc', 'desc'] },
          page: { type: 'number' },
          perPage: { type: 'number' },
        },
        required: ['query'],
      },
      permission: 'ask',
      riskLevel: 'external_network',
      readOnly: true,
      executor: executeSearchRepositories,
    }),
    tool({
      id: 'github.get_readme',
      chatExposure: 'internal_only',
      proactiveEligible: false,
      agentEpochMode: 'read_only_outside_lease',
      backupRestoreSafeOutsideLease: true,
      name: 'Internal public README reader',
      description: 'Internal voyage provider transport; not exposed to model tools.',
      inputSchema: { type: 'object', properties: { ...ownerRepoProps, ref: { type: 'string' } }, required: ['owner', 'repo'] },
      permission: 'ask',
      riskLevel: 'external_network',
      readOnly: true,
      executor: executeGetReadme,
    }),
    tool({
      id: 'github.get_repository',
      chatExposure: 'explicit_only',
      proactiveEligible: false,
      name: '读取 GitHub 仓库',
      description: '读取一个 GitHub 仓库的基础信息。',
      inputSchema: { type: 'object', properties: ownerRepoProps, required: ['owner', 'repo'] },
      permission: 'ask',
      riskLevel: 'external_network',
      readOnly: true,
      executor: executeGetRepository,
    }),
    tool({
      id: 'github.list_issues',
      chatExposure: 'explicit_only',
      proactiveEligible: false,
      name: '列出 GitHub issues',
      description: '读取仓库 issue 列表；默认不包含 PR。',
      inputSchema: {
        type: 'object',
        properties: {
          ...ownerRepoProps,
          state: { type: 'string', enum: ['open', 'closed', 'all'] },
          labels: { type: 'string' },
          creator: { type: 'string' },
          includePullRequests: { type: 'boolean' },
          page: { type: 'number' },
          perPage: { type: 'number' },
        },
        required: ['owner', 'repo'],
      },
      permission: 'ask',
      riskLevel: 'external_network',
      readOnly: true,
      executor: executeListIssues,
    }),
    tool({
      id: 'github.list_issue_comments',
      chatExposure: 'explicit_only',
      proactiveEligible: false,
      name: '列出 GitHub issue 评论',
      description: '读取某个 issue 的评论。',
      inputSchema: {
        type: 'object',
        properties: { ...ownerRepoProps, issueNumber: { type: 'number' }, page: { type: 'number' }, perPage: { type: 'number' } },
        required: ['owner', 'repo', 'issueNumber'],
      },
      permission: 'ask',
      riskLevel: 'external_network',
      readOnly: true,
      executor: executeListIssueComments,
    }),
    tool({
      id: 'github.list_pull_requests',
      chatExposure: 'explicit_only',
      proactiveEligible: false,
      name: '列出 GitHub PR',
      description: '读取仓库 Pull Request 列表。',
      inputSchema: {
        type: 'object',
        properties: { ...ownerRepoProps, state: { type: 'string', enum: ['open', 'closed', 'all'] }, head: { type: 'string' }, base: { type: 'string' }, page: { type: 'number' }, perPage: { type: 'number' } },
        required: ['owner', 'repo'],
      },
      permission: 'ask',
      riskLevel: 'external_network',
      readOnly: true,
      executor: executeListPullRequests,
    }),
    tool({
      id: 'github.get_pull_request',
      chatExposure: 'explicit_only',
      proactiveEligible: false,
      name: '读取 GitHub PR',
      description: '读取一个 Pull Request 的详情。',
      inputSchema: { type: 'object', properties: { ...ownerRepoProps, pullNumber: { type: 'number' } }, required: ['owner', 'repo', 'pullNumber'] },
      permission: 'ask',
      riskLevel: 'external_network',
      readOnly: true,
      executor: executeGetPullRequest,
    }),
    tool({
      id: 'github.get_file',
      chatExposure: 'explicit_only',
      proactiveEligible: false,
      name: '读取 GitHub 文件',
      description: '读取仓库文件；文本大文件会写入 files 缓存。',
      inputSchema: { type: 'object', properties: { ...ownerRepoProps, path: { type: 'string' }, ref: { type: 'string' } }, required: ['owner', 'repo', 'path'] },
      permission: 'ask',
      riskLevel: 'external_network',
      readOnly: true,
      executor: executeGetFile,
    }),
    tool({
      id: 'github.create_issue',
      chatExposure: 'explicit_only',
      proactiveEligible: false,
      name: '创建 GitHub issue',
      description: '在指定仓库创建 issue；需要 GitHub Token。',
      inputSchema: { type: 'object', properties: { ...ownerRepoProps, title: { type: 'string' }, body: { type: 'string' }, labels: { type: 'array', items: { type: 'string' } }, assignees: { type: 'array', items: { type: 'string' } } }, required: ['owner', 'repo', 'title'] },
      permission: 'ask',
      riskLevel: 'social_action',
      readOnly: false,
      executor: executeCreateIssue,
    }),
    tool({
      id: 'github.comment_issue',
      chatExposure: 'explicit_only',
      proactiveEligible: false,
      name: '评论 GitHub issue',
      description: '在指定 issue 下评论；需要 GitHub Token。',
      inputSchema: { type: 'object', properties: { ...ownerRepoProps, issueNumber: { type: 'number' }, body: { type: 'string' } }, required: ['owner', 'repo', 'issueNumber', 'body'] },
      permission: 'ask',
      riskLevel: 'social_action',
      readOnly: false,
      executor: executeCommentIssue,
    }),
    tool({
      id: 'github.create_pull_request',
      chatExposure: 'explicit_only',
      proactiveEligible: false,
      name: '创建 GitHub PR',
      description: '创建 Pull Request；需要 GitHub Token。',
      inputSchema: { type: 'object', properties: { ...ownerRepoProps, title: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' }, body: { type: 'string' }, draft: { type: 'boolean' } }, required: ['owner', 'repo', 'title', 'head', 'base'] },
      permission: 'ask',
      riskLevel: 'social_action',
      readOnly: false,
      executor: executeCreatePullRequest,
    }),
    tool({
      id: 'github.update_file',
      chatExposure: 'explicit_only',
      proactiveEligible: false,
      name: '更新 GitHub 文件',
      description: '覆盖或创建远端仓库文件；危险工具，默认拒绝。',
      inputSchema: { type: 'object', properties: { ...ownerRepoProps, path: { type: 'string' }, message: { type: 'string' }, content: { type: 'string' }, branch: { type: 'string' }, sha: { type: 'string' } }, required: ['owner', 'repo', 'path', 'message', 'content'] },
      permission: 'deny',
      riskLevel: 'dangerous',
      readOnly: false,
      executor: executeUpdateFile,
    }),
    tool({
      id: 'github.delete_file',
      chatExposure: 'explicit_only',
      proactiveEligible: false,
      name: '删除 GitHub 文件',
      description: '删除远端仓库文件；危险工具，默认拒绝。',
      inputSchema: { type: 'object', properties: { ...ownerRepoProps, path: { type: 'string' }, message: { type: 'string' }, branch: { type: 'string' }, sha: { type: 'string' } }, required: ['owner', 'repo', 'path', 'message', 'sha'] },
      permission: 'deny',
      riskLevel: 'dangerous',
      readOnly: false,
      executor: executeDeleteFile,
    }),
  ],
};
