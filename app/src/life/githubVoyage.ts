import { executeAgentToolCall } from '../tools/toolAgentExecution';

// Legacy backup/quota migration key; providers do not read or write this state.
export const GITHUB_VOYAGE_STATE_KEY = 'junluo.life.githubVoyage.state.v1';

export type GithubVoyageCandidate = {
  owner: string;
  repo: string;
  defaultBranch?: string;
  title: string;
  url: string;
  snippet: string;
};

type GithubVoyageOptions = {
  backupRestoreLeaseHeld?: boolean;
  isCurrent?: () => Promise<boolean>;
};

export function validRepository(owner: string, repo: string, url: string) {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner)
    || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo) || repo === '.' || repo === '..') return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.host === 'github.com'
      && !parsed.username && !parsed.password && !parsed.search && !parsed.hash
      && parsed.pathname.toLowerCase() === `/${owner}/${repo}`.toLowerCase();
  } catch { return false; }
}

export async function searchGithubVoyage(
  query: string,
  options: GithubVoyageOptions = {},
): Promise<GithubVoyageCandidate[]> {
  const result = await executeAgentToolCall({
    input: { query, perPage: 6, page: 1 },
    requestedBy: 'life_agent',
    sourceMessageId: 'life-github-voyage:search',
    toolId: 'github.search_repositories',
  }, { backupRestoreLeaseHeld: options.backupRestoreLeaseHeld, githubVoyageIsCurrent: options.isCurrent });
  if (!result.ok) throw new Error(result.summary);
  const repositories = (result.data as { repositories?: unknown } | undefined)?.repositories;
  if (!Array.isArray(repositories)) return [];
  const seen = new Set<string>();
  const candidates: GithubVoyageCandidate[] = [];
  for (const item of repositories) {
    if (!item || typeof item !== 'object' || item.private !== false) continue;
    const { owner, name: repo, fullName, htmlUrl: url } = item;
    if (typeof owner !== 'string' || typeof repo !== 'string' || typeof url !== 'string'
      || fullName !== `${owner}/${repo}` || !validRepository(owner, repo, url)) continue;
    const key = `${owner}/${repo}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ owner, repo, url, title: fullName,
      defaultBranch: typeof item.defaultBranch === 'string' ? item.defaultBranch : undefined,
      snippet: typeof item.description === 'string' ? item.description : '',
    });
    if (candidates.length === 6) break;
  }
  return candidates;
}

export async function readGithubVoyage(
  candidate: GithubVoyageCandidate,
  options: GithubVoyageOptions = {},
): Promise<string | null> {
  if (!validRepository(candidate.owner, candidate.repo, candidate.url)) return null;
  const result = await executeAgentToolCall({
    input: { owner: candidate.owner, repo: candidate.repo, ref: candidate.defaultBranch },
    requestedBy: 'life_agent',
    sourceMessageId: 'life-github-voyage:readme',
    toolId: 'github.get_readme',
  }, { backupRestoreLeaseHeld: options.backupRestoreLeaseHeld, githubVoyageIsCurrent: options.isCurrent });
  if (!result.ok) return null;
  const body = (result.data as { body?: unknown } | undefined)?.body;
  return typeof body === 'string' && body.trim() ? body : null;
}

