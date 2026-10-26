export type GithubIntentRoute = {
  candidateTools: string[];
  reason:
    | 'github_config_status'
    | 'github_search_repositories'
    | 'github_get_repository'
    | 'github_list_issues'
    | 'github_list_issue_comments'
    | 'github_list_pull_requests'
    | 'github_get_pull_request'
    | 'github_get_file'
    | 'github_create_issue'
    | 'github_comment_issue'
    | 'github_create_pull_request'
    | 'github_dangerous_unsupported';
  unsupported?: boolean;
};

const GITHUB_TEXT_PATTERN = /GitHub|github|repo|repository|仓库|issue|PR|Pull Request|pull request/i;
const GITHUB_URL_PATTERN = /https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/(?:(issues)\/(\d+)|(pull)\/(\d+)|(blob|tree)\/([^/\s]+)\/([^\s#?]+)))?/i;
const CONFIG_PATTERN = /(?:GitHub|github).{0,16}(?:token|Token|配置|凭据|密钥).{0,12}(?:状态|配好|有没有|是否|看一下|检查)/i;
const SEARCH_REPO_PATTERN = /(?:搜|搜索|查找|找).{0,12}(?:GitHub|github).{0,12}(?:仓库|repo|repository)|(?:GitHub|github).{0,12}(?:仓库|repo|repository).{0,12}(?:搜索|搜|查找|找)/i;
const GET_REPO_PATTERN = /(?:这个|该)?(?:GitHub|github).{0,12}(?:仓库|repo|repository).{0,18}(?:做什么|详情|信息|介绍|看看|读取|查一下)|https?:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/i;
const ISSUE_PATTERN = /(?:issue|议题|问题单)/i;
const ISSUE_COMMENT_PATTERN = /(?:issue|议题|问题单).{0,20}(?:评论|comments?|回复)|(?:评论|comments?).{0,20}(?:issue|议题|问题单)/i;
const PR_PATTERN = /(?:PR|Pull Request|pull request|合并请求)/i;
const FILE_PATTERN = /(?:文件|代码|源码|blob|README|readme|package\.json|\.ts|\.tsx|\.js|\.md)/i;
const CREATE_ISSUE_PATTERN = /(?:创建|新建|开|提).{0,12}(?:GitHub|github)?.{0,12}(?:issue|议题|问题单)/i;
const COMMENT_ISSUE_PATTERN = /(?:评论|回复).{0,12}(?:GitHub|github)?.{0,12}(?:issue|议题|问题单)/i;
const CREATE_PR_PATTERN = /(?:创建|新建|开|提).{0,12}(?:PR|Pull Request|pull request|合并请求)/i;
const DANGEROUS_PATTERN = /(?:删除|覆盖|改写|更新).{0,18}(?:GitHub|github|仓库|远端).{0,18}(?:文件|代码)|(?:合并|merge).{0,12}(?:PR|Pull Request)|terminal|终端|shell|命令行/i;

function githubUrlMatch(text: string) {
  const match = GITHUB_URL_PATTERN.exec(text);
  if (!match) return null;
  return {
    owner: match[1],
    repo: match[2],
    issueNumber: match[3] === 'issues' ? Number(match[4]) : undefined,
    pullNumber: match[5] === 'pull' ? Number(match[6]) : undefined,
    ref: match[7] === 'blob' || match[7] === 'tree' ? match[8] : undefined,
    path: match[7] === 'blob' ? decodeURIComponent(match[9] ?? '') : undefined,
  };
}

export function routeGithubIntent(text: string): GithubIntentRoute | null {
  const trimmed = text.trim();
  if (!trimmed || !GITHUB_TEXT_PATTERN.test(trimmed)) return null;
  if (DANGEROUS_PATTERN.test(trimmed)) {
    return { candidateTools: [], reason: 'github_dangerous_unsupported', unsupported: true };
  }
  if (CONFIG_PATTERN.test(trimmed)) return { candidateTools: ['github.get_config_status'], reason: 'github_config_status' };
  if (CREATE_PR_PATTERN.test(trimmed)) return { candidateTools: ['github.create_pull_request'], reason: 'github_create_pull_request' };
  if (COMMENT_ISSUE_PATTERN.test(trimmed)) return { candidateTools: ['github.comment_issue'], reason: 'github_comment_issue' };
  if (CREATE_ISSUE_PATTERN.test(trimmed)) return { candidateTools: ['github.create_issue'], reason: 'github_create_issue' };

  const url = githubUrlMatch(trimmed);
  if (url?.path) return { candidateTools: ['github.get_file'], reason: 'github_get_file' };
  if (url?.issueNumber && ISSUE_COMMENT_PATTERN.test(trimmed)) return { candidateTools: ['github.list_issue_comments'], reason: 'github_list_issue_comments' };
  if (url?.issueNumber) return { candidateTools: ['github.list_issues'], reason: 'github_list_issues' };
  if (url?.pullNumber) return { candidateTools: ['github.get_pull_request'], reason: 'github_get_pull_request' };
  if (url) return { candidateTools: ['github.get_repository'], reason: 'github_get_repository' };

  if (FILE_PATTERN.test(trimmed)) return { candidateTools: ['github.get_file'], reason: 'github_get_file' };
  if (ISSUE_COMMENT_PATTERN.test(trimmed)) return { candidateTools: ['github.list_issue_comments'], reason: 'github_list_issue_comments' };
  if (ISSUE_PATTERN.test(trimmed)) return { candidateTools: ['github.list_issues'], reason: 'github_list_issues' };
  if (PR_PATTERN.test(trimmed)) return { candidateTools: ['github.list_pull_requests'], reason: 'github_list_pull_requests' };
  if (SEARCH_REPO_PATTERN.test(trimmed)) return { candidateTools: ['github.search_repositories'], reason: 'github_search_repositories' };
  if (GET_REPO_PATTERN.test(trimmed)) return { candidateTools: ['github.get_repository'], reason: 'github_get_repository' };
  return null;
}

function parseOwnerRepoFromText(text: string) {
  const url = githubUrlMatch(text);
  if (url) return { owner: url.owner, repo: url.repo, path: url.path, ref: url.ref, issueNumber: url.issueNumber, pullNumber: url.pullNumber };
  const slash = /(?:repo|仓库|GitHub|github)?\s*([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/.exec(text);
  if (slash) return { owner: slash[1], repo: slash[2] };
  return null;
}

function parseNumberAfter(text: string, words: string[]) {
  const pattern = new RegExp(`(?:${words.join('|')})\\s*#?\\s*(\\d+)`, 'i');
  const match = pattern.exec(text);
  return match ? Number(match[1]) : undefined;
}

function removeGithubScaffolding(text: string) {
  return text
    .replace(GITHUB_URL_PATTERN, '')
    .replace(/(?:创建|新建|开|提|评论|回复|GitHub|github|issue|议题|问题单|PR|Pull Request|pull request|仓库|repo|repository|标题|内容|正文|body|title|评论内容|回复内容)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseGithubSearchRepositoriesInputFromText(text: string): Record<string, unknown> | null {
  const cleaned = text
    .replace(/(?:帮我|老师|白云|GitHub|github|仓库|repo|repository|搜|搜索|查找|找|一下|几个|看看)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const query = cleaned || text.trim();
  return query ? { query, perPage: 10 } : null;
}

export function parseGithubOwnerRepoInputFromText(text: string): Record<string, unknown> | null {
  const parsed = parseOwnerRepoFromText(text);
  return parsed ? { owner: parsed.owner, repo: parsed.repo } : null;
}

export function parseGithubIssueListInputFromText(text: string): Record<string, unknown> | null {
  const parsed = parseOwnerRepoFromText(text);
  if (!parsed) return null;
  return { owner: parsed.owner, repo: parsed.repo, state: /关闭|closed/i.test(text) ? 'closed' : /全部|all/i.test(text) ? 'all' : 'open' };
}

export function parseGithubIssueCommentsInputFromText(text: string): Record<string, unknown> | null {
  const parsed = parseOwnerRepoFromText(text);
  const issueNumber = parsed?.issueNumber ?? parseNumberAfter(text, ['issue', '议题', '问题单']);
  if (!parsed || !issueNumber) return null;
  return { owner: parsed.owner, repo: parsed.repo, issueNumber };
}

export function parseGithubPullRequestListInputFromText(text: string): Record<string, unknown> | null {
  const parsed = parseOwnerRepoFromText(text);
  if (!parsed) return null;
  return { owner: parsed.owner, repo: parsed.repo, state: /关闭|closed/i.test(text) ? 'closed' : /全部|all/i.test(text) ? 'all' : 'open' };
}

export function parseGithubPullRequestInputFromText(text: string): Record<string, unknown> | null {
  const parsed = parseOwnerRepoFromText(text);
  const pullNumber = parsed?.pullNumber ?? parseNumberAfter(text, ['PR', 'Pull Request', 'pull request', '合并请求']);
  if (!parsed || !pullNumber) return null;
  return { owner: parsed.owner, repo: parsed.repo, pullNumber };
}

export function parseGithubFileInputFromText(text: string): Record<string, unknown> | null {
  const parsed = parseOwnerRepoFromText(text);
  if (!parsed) return null;
  const path = parsed.path ?? /(?:文件|代码|源码|path)\s*[:：]?\s*([^\s，。]+)/i.exec(text)?.[1];
  if (!path) return null;
  return { owner: parsed.owner, repo: parsed.repo, path, ref: parsed.ref };
}

export function parseGithubCreateIssueInputFromText(text: string): Record<string, unknown> | null {
  const parsed = parseOwnerRepoFromText(text);
  if (!parsed) return null;
  const title = /(?:标题|title)\s*[:：]\s*([^\n。]+)/i.exec(text)?.[1]?.trim() || removeGithubScaffolding(text);
  if (!title) return null;
  const body = /(?:正文|内容|body)\s*[:：]\s*([\s\S]+)/i.exec(text)?.[1]?.trim();
  return { owner: parsed.owner, repo: parsed.repo, title, ...(body ? { body } : {}) };
}

export function parseGithubCommentIssueInputFromText(text: string): Record<string, unknown> | null {
  const parsed = parseOwnerRepoFromText(text);
  const issueNumber = parsed?.issueNumber ?? parseNumberAfter(text, ['issue', '议题', '问题单']);
  if (!parsed || !issueNumber) return null;
  const body = /(?:评论|回复|内容|body)\s*[:：]\s*([\s\S]+)/i.exec(text)?.[1]?.trim() || removeGithubScaffolding(text);
  return body ? { owner: parsed.owner, repo: parsed.repo, issueNumber, body } : null;
}

export function parseGithubCreatePullRequestInputFromText(text: string): Record<string, unknown> | null {
  const parsed = parseOwnerRepoFromText(text);
  if (!parsed) return null;
  const title = /(?:标题|title)\s*[:：]\s*([^\n。]+)/i.exec(text)?.[1]?.trim() || removeGithubScaffolding(text);
  const head = /(?:head|源分支|from)\s*[:：]?\s*([A-Za-z0-9_.\/-]+)/i.exec(text)?.[1]?.trim();
  const base = /(?:base|目标分支|to)\s*[:：]?\s*([A-Za-z0-9_.\/-]+)/i.exec(text)?.[1]?.trim();
  if (!title || !head || !base) return null;
  const body = /(?:正文|内容|body)\s*[:：]\s*([\s\S]+)/i.exec(text)?.[1]?.trim();
  return { owner: parsed.owner, repo: parsed.repo, title, head, base, ...(body ? { body } : {}) };
}
