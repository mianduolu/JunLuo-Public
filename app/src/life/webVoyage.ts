import {
  proactiveLedgerStorageBridge as AsyncStorage,
} from '../sync/syncProactiveLedgerStorageBridge';

import { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import { isAiCostDeferred } from '../ai/aiCallBudget';
import { captureWebVoyageSources, type WebVoyageSourceRefs } from './webVoyageSources';
import { WEB_VOYAGE_TOPIC_INSTRUCTION, WEB_VOYAGE_PAGE_INSTRUCTION, requestWebVoyageDecision,
  parseGeneratedSearchQuery, parseWebVoyagePageChoice, selectWebVoyageCandidates,
  GITHUB_VOYAGE_PAGE_INSTRUCTION, isValidExplorationQuery, checkWebVoyageCost, WebVoyageDecisionResponseError, type GeneratedWebVoyageQuery } from './webVoyageDecision';
import { searchGithubVoyage, readGithubVoyage, validRepository, type GithubVoyageCandidate } from './githubVoyage';
import { PUBLIC_EXPLORATION_STATE_KEY, LEGACY_GITHUB_VOYAGE_STATE_KEY,
  normalizePublicExplorationQuota, explorationDateKey, type PublicExplorationQuota } from './publicExplorationQuota';
import { isWebVoyageShareableReading, type WebVoyageReadingStatus } from './webVoyageReading';
export { parseGeneratedSearchQuery } from './webVoyageDecision';

import {
  EXPLORATION_DRIVE_LABELS,
  type ExplorationDriveKey,
  type ExplorationExecutionIntent,
} from './explorationExecutionIntent';
import {
  fetchWebVoyageProviderPage,
  getWebSearchProviderStatus,
  searchWebVoyageProvider,
  type WebSearchProviderId,
  type WebSearchProviderPage,
  type WebSearchProviderSearchResult,
} from './webSearchProvider';

export const WEB_VOYAGE_STATE_KEY = PUBLIC_EXPLORATION_STATE_KEY;
export const WEB_VOYAGE_LOG_KEY = 'junluo.life.webVoyage.log.v1';
export const WEB_VOYAGE_SHARE_QUEUE_KEY = 'junluo.life.webVoyage.shareQueue.v1';

const HOUR_MS = 60 * 60 * 1000;
const MIN_ATTEMPT_INTERVAL_MS = 2 * HOUR_MS;
const MAX_ATTEMPTS_PER_DAY = 3;
const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_LOG_ITEMS = 10;
const MAX_SHARE_QUEUE_ITEMS = 8;

export type WebVoyageStatus = 'skipped' | 'searching' | 'completed' | 'blocked' | 'failed';
export type WebVoyageStage = 'waiting' | 'query' | 'search' | 'fetch' | 'summarize' | 'completed';
export type WebVoyageShareStatus = 'none' | 'pending' | 'delivered' | 'failed';

export type WebVoyageLogEntry = {
  at: number;
  driveKey?: ExplorationDriveKey;
  driveLabel?: string;
  driveReason?: string;
  detail: string;
  evidenceConfidence?: string;
  evidenceStatus?: 'completed' | 'skipped' | 'failed' | string;
  evidenceSummary?: string;
  evidenceVerdict?: string;
  evidenceWarnings?: string[];
  failureReason?: string;
  id: string;
  /** Local ingestion eligibility; never included in model or sync transport materials. */
  memoryIngestionVersion?: 1;
  fetchMode?: 'http' | 'browser';
  providerId?: WebSearchProviderId;
  providerLabel?: string;
  query?: string;
  reason: string;
  readingStatus?: WebVoyageReadingStatus;
  shareError?: string;
  shareAttemptedAt?: number;
  shareCancelledAt?: number;
  shareChatHandoffAt?: number;
  sharedAt?: number;
  shareStatus?: WebVoyageShareStatus;
  sourceType?: 'web' | 'github';
  stage?: WebVoyageStage;
  status: WebVoyageStatus;
  summary?: string;
  title?: string;
  url?: string;
};

export type PendingWebVoyageShare = {
  at: number;
  driveLabel?: string;
  driveReason?: string;
  evidenceSummary?: string;
  evidenceVerdict?: string;
  id: string;
  logId: string;
  query: string;
  sourceType?: 'web' | 'github';
  summary: string;
  title: string;
  url?: string;
};

export type WebVoyageState = PublicExplorationQuota & { pending?: WebVoyagePending };

type WebVoyagePending = {
  at: number;
  intent: ExplorationExecutionIntent;
  sources: WebVoyageSourceRefs;
  query: string;
  /** Missing only in the preceding web-only local continuation format. */
  target?: 'web' | 'github';
  searchStarted?: boolean;
  candidates?: Array<WebSearchProviderSearchResult | GithubVoyageCandidate>;
  selectionStarted?: boolean;
  selectedIndex?: number;
  readStarted?: boolean;
  result?: WebVoyageLogEntry;
};

function readPending(value: unknown): WebVoyagePending | undefined {
  if (value === undefined) return undefined;
  const p = value as WebVoyagePending;
  const refs = (value: unknown, max: number) => Array.isArray(value) && value.length <= max
    && value.every(ref => ref && typeof ref.id === 'string' && !!ref.id && typeof ref.version === 'string');
  if (!p || typeof p !== 'object' || !Number.isFinite(p.at) || !p.intent
    || !(p.intent.driveKey in EXPLORATION_DRIVE_LABELS) || typeof p.intent.reason !== 'string'
    || !Number.isFinite(p.intent.score) || !p.sources
    || !(p.sources.owner === null || typeof p.sources.owner === 'string')
    || !refs(p.sources.chats, 6) || !refs(p.sources.voyages, 2)
    || !isValidExplorationQuery(p.query) || !p.query.trim()
    || (p.target !== undefined && p.target !== 'web' && p.target !== 'github')
    || (p.searchStarted !== undefined && typeof p.searchStarted !== 'boolean')
    || (p.selectionStarted !== undefined && typeof p.selectionStarted !== 'boolean')
    || (p.readStarted !== undefined && typeof p.readStarted !== 'boolean')
    || (p.selectedIndex !== undefined && (!Number.isInteger(p.selectedIndex) || p.selectedIndex < 0
      || !p.candidates || p.selectedIndex >= p.candidates.length))
    || (p.candidates !== undefined && (!Array.isArray(p.candidates) || !p.candidates.length
      || !p.candidates.every(item => item && typeof item.title === 'string' && typeof item.url === 'string'
        && typeof item.snippet === 'string')
      || selectWebVoyageCandidates(p.candidates).length !== p.candidates.length
      || (p.target === 'github' && !p.candidates.every(item => {
        const repo = item as GithubVoyageCandidate;
        return typeof repo.owner === 'string' && typeof repo.repo === 'string'
          && (repo.defaultBranch === undefined || typeof repo.defaultBranch === 'string')
          && validRepository(repo.owner, repo.repo, repo.url);
      }))))) {
    throw new Error('web-voyage-pending-invalid');
  }
  if (p.result !== undefined) {
    const result = normalizeLogEntry(p.result);
    if (!result || result.id !== `web-voyage-${p.at}-${p.sources.owner ?? 'local'}`
      || result.at !== p.at || result.query !== p.query || result.sourceType !== (p.target ?? 'web')
      || !['completed', 'failed', 'skipped'].includes(result.status)) throw new Error('web-voyage-pending-invalid');
  }
  return p;
}

function compactText(value: unknown, limit = 220) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, limit);
}

function isPublicHttpUrl(url: string) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    if (!host || host === 'localhost' || host.endsWith('.local')) return false;
    if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.)/.test(host)) return false;
    return !/^172\.(1[6-9]|2\d|3[0-1])\./.test(host);
  } catch {
    return false;
  }
}

type ChatCompletionQueryResponse = {
  choices?: Array<{
    finish_reason?: unknown;
    message?: {
      answer?: unknown;
      content?: unknown;
      refusal?: unknown;
      role?: unknown;
      reasoning?: unknown;
      reasoning_content?: unknown;
      tool_calls?: unknown;
    };
    output_text?: unknown;
    text?: unknown;
  }>;
  output_text?: unknown;
  text?: unknown;
};

function readTextPart(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map(readTextPart).join('');
  }
  if (value && typeof value === 'object') {
    const part = value as { content?: unknown; output_text?: unknown; text?: unknown };
    return readTextPart(part.text ?? part.content ?? part.output_text);
  }
  return '';
}

export function readWebVoyageAssistantContent(payload: ChatCompletionQueryResponse) {
  const choice = payload.choices?.[0];
  const message = choice?.message;
  const candidates = [
    message?.content,
    choice?.text,
    choice?.output_text,
    payload.output_text,
    payload.text,
    message?.answer,
  ];
  for (const candidate of candidates) {
    const text = readTextPart(candidate).trim();
    if (text) return text;
  }
  return '';
}

export function describeWebVoyageQueryResponse(payload: ChatCompletionQueryResponse) {
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const choice = choices[0];
  const message = choice?.message;
  const content = message?.content;
  const contentKind = Array.isArray(content) ? `array(${content.length})` : typeof content;
  const parts = [
    `choices=${choices.length}`,
    `finish=${typeof choice?.finish_reason === 'string' ? choice.finish_reason : 'none'}`,
    `content=${contentKind}`,
    `choiceText=${readTextPart(choice?.text).trim() ? 'yes' : 'no'}`,
    `outputText=${readTextPart(choice?.output_text ?? payload.output_text ?? payload.text).trim() ? 'yes' : 'no'}`,
    `answer=${readTextPart(message?.answer).trim() ? 'yes' : 'no'}`,
    `reasoning=${readTextPart(message?.reasoning_content ?? message?.reasoning).trim() ? 'yes' : 'no'}`,
    `toolCalls=${Array.isArray(message?.tool_calls) ? message.tool_calls.length : 0}`,
    `refusal=${readTextPart(message?.refusal).trim() ? 'yes' : 'no'}`,
  ];
  return parts.join(', ');
}

function normalizeLogEntry(value: unknown): WebVoyageLogEntry | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<WebVoyageLogEntry>;
  const at = typeof candidate.at === 'number' ? candidate.at : 0;
  const status = candidate.status === 'completed' ||
    candidate.status === 'failed' ||
    candidate.status === 'blocked' ||
    candidate.status === 'searching' ||
    candidate.status === 'skipped'
    ? candidate.status
    : undefined;
  if (!at || !status) return null;
  const driveKey = typeof candidate.driveKey === 'string' && candidate.driveKey in EXPLORATION_DRIVE_LABELS
    ? candidate.driveKey as ExplorationDriveKey
    : undefined;
  const stage = candidate.stage === 'query' ||
    candidate.stage === 'search' ||
    candidate.stage === 'fetch' ||
    candidate.stage === 'summarize' ||
    candidate.stage === 'completed'
    ? candidate.stage
    : undefined;
  const shareStatus = candidate.shareStatus === 'pending' ||
    candidate.shareStatus === 'delivered' ||
    candidate.shareStatus === 'failed' ||
    candidate.shareStatus === 'none'
    ? candidate.shareStatus
    : undefined;
  return {
    at,
    driveKey,
    driveLabel: compactText(candidate.driveLabel || (driveKey ? EXPLORATION_DRIVE_LABELS[driveKey] : ''), 24) || undefined,
    driveReason: compactText(candidate.driveReason, 180) || undefined,
    detail: compactText(candidate.detail, 360),
    evidenceConfidence: compactText(candidate.evidenceConfidence, 40) || undefined,
    evidenceStatus: compactText(candidate.evidenceStatus, 40) || undefined,
    evidenceSummary: compactText(candidate.evidenceSummary, 320) || undefined,
    evidenceVerdict: compactText(candidate.evidenceVerdict, 60) || undefined,
    evidenceWarnings: Array.isArray(candidate.evidenceWarnings)
      ? candidate.evidenceWarnings.map((item) => compactText(item, 120)).filter(Boolean).slice(0, 4)
      : undefined,
    failureReason: compactText(candidate.failureReason, 180) || undefined,
    fetchMode: candidate.fetchMode === 'browser' ? 'browser' : candidate.fetchMode === 'http' ? 'http' : undefined,
    id: typeof candidate.id === 'string' ? candidate.id : `web-voyage-${at}-${Math.random().toString(36).slice(2)}`,
    ...(candidate.memoryIngestionVersion === 1 ? { memoryIngestionVersion: 1 as const } : {}),
    providerId: candidate.providerId === 'builtin_life_research' ||
      candidate.providerId === 'github_voyage' ||
      candidate.providerId === 'simple_web_search_mcp' ||
      candidate.providerId === 'zero_api_key_web_search'
      ? candidate.providerId
      : undefined,
    providerLabel: compactText(candidate.providerLabel, 60) || undefined,
    query: isValidExplorationQuery(candidate.query) ? candidate.query : undefined,
    readingStatus: candidate.readingStatus === 'body_excerpt' || candidate.readingStatus === 'search_preview'
      || candidate.readingStatus === 'metadata_only' ? candidate.readingStatus : undefined,
    reason: compactText(candidate.reason, 180),
    shareError: compactText(candidate.shareError, 180) || undefined,
    shareAttemptedAt: typeof candidate.shareAttemptedAt === 'number' ? candidate.shareAttemptedAt
      : shareStatus === 'failed' && (candidate.shareError === 'message-generation-empty' || candidate.shareError === 'delivery-lease-incomplete')
        ? candidate.sharedAt ?? at : undefined,
    shareCancelledAt: typeof candidate.shareCancelledAt === 'number' ? candidate.shareCancelledAt : undefined,
    shareChatHandoffAt: typeof candidate.shareChatHandoffAt === 'number' && Number.isFinite(candidate.shareChatHandoffAt)
      ? candidate.shareChatHandoffAt : undefined,
    sharedAt: typeof candidate.sharedAt === 'number' ? candidate.sharedAt : undefined,
    shareStatus,
    sourceType: candidate.sourceType === 'github' ? 'github' : 'web',
    stage,
    status,
    summary: compactText(candidate.summary, 260) || undefined,
    title: compactText(candidate.title, 80) || undefined,
    url: typeof candidate.url === 'string' && isPublicHttpUrl(candidate.url) ? candidate.url : undefined,
  };
}

function normalizePendingWebVoyageShare(value: unknown): PendingWebVoyageShare | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<PendingWebVoyageShare>;
  const query = isValidExplorationQuery(candidate.query) ? candidate.query : '';
  const summary = compactText(candidate.summary, 360);
  const title = compactText(candidate.title, 100);
  const logId = compactText(candidate.logId, 100);
  if (!query || !summary || !title || !logId) return null;
  return {
    at: typeof candidate.at === 'number' ? candidate.at : Date.now(),
    driveLabel: compactText(candidate.driveLabel, 24) || undefined,
    driveReason: compactText(candidate.driveReason, 180) || undefined,
    evidenceSummary: compactText(candidate.evidenceSummary, 320) || undefined,
    evidenceVerdict: compactText(candidate.evidenceVerdict, 60) || undefined,
    id: typeof candidate.id === 'string' ? candidate.id : `web-voyage-share-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    logId,
    query,
    sourceType: candidate.sourceType === 'github' ? 'github' : 'web',
    summary,
    title,
    url: typeof candidate.url === 'string' && isPublicHttpUrl(candidate.url) ? candidate.url : undefined,
  };
}

async function loadWebVoyageState(now = Date.now()) {
  const [web, github] = await Promise.all([AsyncStorage.getItem(WEB_VOYAGE_STATE_KEY),
    AsyncStorage.getItem(LEGACY_GITHUB_VOYAGE_STATE_KEY)]);
  return { ...normalizePublicExplorationQuota(web, github, now),
    pending: readPending(web ? JSON.parse(web).pending : undefined) };
}

async function saveWebVoyageState(state: WebVoyageState, now = Date.now()) {
  const normalized = { ...normalizePublicExplorationQuota(JSON.stringify(state), undefined, now),
    pending: readPending(state.pending) };
  await AsyncStorage.setItem(WEB_VOYAGE_STATE_KEY, JSON.stringify(normalized));
  return normalized;
}

function hasMemoryExplorationBody(entry: WebVoyageLogEntry) {
  return entry.status === 'completed' && entry.readingStatus === 'body_excerpt'
    && typeof entry.summary === 'string' && !!entry.summary.trim();
}

export async function loadWebVoyageLog(options: { unpruned?: boolean } = {}) {
  const raw = await AsyncStorage.getItem(WEB_VOYAGE_LOG_KEY);
  if (!raw) return [];
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error('loadWebVoyageLog-invalid');
  const entries = parsed
    .map(normalizeLogEntry)
    .filter((entry): entry is WebVoyageLogEntry => !!entry)
    .sort((left, right) => right.at - left.at);
  // Transactional source verification must not re-enter the memory database.
  if (options.unpruned) return entries;
  const { loadLifeSelfRetainedIds, retainLifeSelfRecent } = await import('../memory/lifeSelfMemoryRetention');
  let retained: Set<string>;
  try { retained = (await loadLifeSelfRetainedIds(undefined, entries.filter(hasMemoryExplorationBody))).exploration; }
  catch { console.warn('life-self-exploration-retention-read-failed'); return entries; }
  return retainLifeSelfRecent(entries, retained, MAX_LOG_ITEMS);
}

async function saveWebVoyageLog(entries: WebVoyageLogEntry[]) {
  const { loadLifeSelfRetainedIds, retainLifeSelfRecent } = await import('../memory/lifeSelfMemoryRetention');
  let retained: Set<string>;
  try { retained = (await loadLifeSelfRetainedIds(undefined, entries.filter(hasMemoryExplorationBody))).exploration; }
  catch {
    console.warn('life-self-exploration-retention-read-failed');
    await AsyncStorage.setItem(WEB_VOYAGE_LOG_KEY, JSON.stringify(entries.sort((left, right) => right.at - left.at)));
    return;
  }
  await AsyncStorage.setItem(
    WEB_VOYAGE_LOG_KEY,
    JSON.stringify(retainLifeSelfRecent(entries.sort((left, right) => right.at - left.at), retained, MAX_LOG_ITEMS)),
  );
}

let logWrites: Promise<unknown> = Promise.resolve();
function writeWebVoyageLog<T>(work: () => Promise<T>): Promise<T> {
  const next = logWrites.then(work, work);
  logWrites = next.then(() => undefined, () => undefined);
  return next;
}

async function updateWebVoyageLogEntryUnlocked(logId: string, patch: Partial<WebVoyageLogEntry>) {
  const current = await loadWebVoyageLog();
  let changed = false;
  const next = current.map((entry) => {
    if (entry.id !== logId) return entry;
    changed = true;
    return normalizeLogEntry({ ...entry, ...patch }) ?? entry;
  });
  if (changed) await saveWebVoyageLog(next);
}

function updateWebVoyageLogEntry(logId: string, patch: Partial<WebVoyageLogEntry>) {
  return writeWebVoyageLog(() => updateWebVoyageLogEntryUnlocked(logId, patch));
}

/** A failed old delivery had already generated its message before acquiring delivery ownership. */
export function hasWebVoyageShareAttempt(entry: WebVoyageLogEntry) {
  return entry.shareAttemptedAt !== undefined || entry.shareStatus === 'failed'
    && (entry.shareError === 'message-generation-empty' || entry.shareError === 'delivery-lease-incomplete');
}

export function claimWebVoyageShareRequest(logId: string, now: number) {
  return writeWebVoyageLog(async () => {
    const entry = (await loadWebVoyageLog()).find(item => item.id === logId);
    if (!entry || entry.shareCancelledAt !== undefined || entry.shareStatus === 'delivered' || hasWebVoyageShareAttempt(entry)) return false;
    await updateWebVoyageLogEntryUnlocked(logId, { shareAttemptedAt: now });
    const saved = (await loadWebVoyageLog()).find(item => item.id === logId);
    return saved?.shareAttemptedAt === now && saved.shareCancelledAt === undefined;
  });
}

export async function markWebVoyageShareFailure(share: PendingWebVoyageShare, reason: string, now = Date.now()) {
  await writeWebVoyageLog(async () => {
    const entry = (await loadWebVoyageLog()).find(item => item.id === share.logId);
    if (!entry || entry.shareStatus === 'delivered' || entry.shareCancelledAt !== undefined) return;
    await updateWebVoyageLogEntryUnlocked(share.logId, {
      shareStatus: 'failed', shareError: reason, sharedAt: now,
      // Only actual failed requests opt in. Merely reading old history cannot revive deleted tasks.
      shareChatHandoffAt: hasWebVoyageShareAttempt(entry) ? entry.shareChatHandoffAt ?? now : undefined,
    });
  });
}

export function markWebVoyageChatShareDelivered(
  snapshot: WebVoyageLogEntry, deliveredAt: number, canCommit: () => boolean = () => true,
) {
  return writeWebVoyageLog(async () => {
    const entry = (await loadWebVoyageLog()).find(item => item.id === snapshot.id);
    if (!canCommit() || !entry || entry.shareCancelledAt !== undefined
      || !Number.isFinite(entry.shareChatHandoffAt)
      || !(['at', 'summary', 'title', 'url', 'query', 'readingStatus', 'sourceType', 'shareChatHandoffAt'] as const)
        .every(key => entry[key] === snapshot[key])) return false;
    if (entry.shareStatus === 'delivered') return entry.sharedAt === deliveredAt;
    if (entry.shareStatus !== 'failed') return false;
    await updateWebVoyageLogEntryUnlocked(entry.id, { shareStatus: 'delivered', sharedAt: deliveredAt, shareError: undefined });
    return true;
  });
}

export async function recordWebVoyageLog(
  entry: Omit<WebVoyageLogEntry, 'at' | 'id'> & { at?: number; id?: string },
  canCommit: () => Promise<boolean> = async () => true,
) {
  const at = entry.at ?? Date.now();
  const nextEntry = normalizeLogEntry({
    ...entry,
    at,
    id: entry.id ?? `web-voyage-${at}-${Math.random().toString(36).slice(2)}`,
    memoryIngestionVersion: hasMemoryExplorationBody(entry as WebVoyageLogEntry) ? 1 : undefined,
  });
  if (!nextEntry) return null;
  return writeWebVoyageLog(async () => {
    const current = await loadWebVoyageLog();
    // Existing identity must not lose its consumed request on duplicate capture.
    const existing = current.find(item => item.id === nextEntry.id);
    if (existing) return existing;
    if (!await canCommit()) return null;
    const ingestion = nextEntry.memoryIngestionVersion === 1 ? await import('../memory/lifeSelfMemoryIngestion') : undefined;
    try { await ingestion?.ensureLifeSelfMemoryCutover(at); }
    catch { console.warn('life-self-exploration-cutover-deferred'); }
    if (!await canCommit()) return null;
    await saveWebVoyageLog([nextEntry, ...current]);
    try {
      await ingestion?.registerLifeSelfExploration(nextEntry);
    } catch {
      // Source capture succeeded. The existing ingestion scan repairs its local registration.
      console.warn('life-self-exploration-registration-failed');
    }
    return nextEntry;
  });
}

export async function loadWebVoyageShareQueue() {
  const raw = await AsyncStorage.getItem(WEB_VOYAGE_SHARE_QUEUE_KEY);
  if (!raw) return [];
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error('loadWebVoyageShareQueue-invalid');
  return parsed
    .map(normalizePendingWebVoyageShare)
    .filter((item): item is PendingWebVoyageShare => !!item)
    .sort((left, right) => left.at - right.at)
    .slice(0, MAX_SHARE_QUEUE_ITEMS);
}

async function saveWebVoyageShareQueue(items: PendingWebVoyageShare[]) {
  await AsyncStorage.setItem(
    WEB_VOYAGE_SHARE_QUEUE_KEY,
    JSON.stringify(items.sort((left, right) => left.at - right.at).slice(-MAX_SHARE_QUEUE_ITEMS)),
  );
}

export function enqueueWebVoyageShare(entry: WebVoyageLogEntry, canCommit: () => Promise<boolean> = async () => true) {
  return writeWebVoyageLog(async () => {
    if (!entry.query || !entry.summary || !entry.title || !isWebVoyageShareableReading(entry)) return;
    if (entry.shareCancelledAt !== undefined || entry.shareStatus === 'delivered' || hasWebVoyageShareAttempt(entry)) return;
    const current = await loadWebVoyageShareQueue();
    if (current.some((item) => item.logId === entry.id)) return;
    const next: PendingWebVoyageShare = {
      at: entry.at,
      driveLabel: entry.driveLabel,
      driveReason: entry.driveReason,
      evidenceSummary: entry.evidenceSummary,
      evidenceVerdict: entry.evidenceVerdict,
      id: `web-voyage-share-${entry.at}-${Math.random().toString(36).slice(2)}`,
      logId: entry.id,
      query: entry.query,
      sourceType: entry.sourceType === 'github' ? 'github' : 'web',
      summary: entry.summary,
      title: entry.title,
      url: entry.url,
    };
    if (!await canCommit()) return;
    await saveWebVoyageShareQueue([...current, next]);
  });
}

/** The caller supplies already-saved I messages, never a generation attempt. */
export function commitWebVoyageUnifiedShare(
  snapshot: WebVoyageLogEntry,
  deliveredAt: number,
  registerDelivery: () => Promise<unknown>,
  canCommit: () => boolean = () => true,
) {
  return writeWebVoyageLog(async () => {
    const entry = (await loadWebVoyageLog()).find(item => item.id === snapshot.id);
    if (!canCommit() || !entry || !isWebVoyageShareableReading(entry) || entry.status !== 'completed' || entry.shareCancelledAt !== undefined
      || !(['at', 'summary', 'title', 'url', 'query', 'readingStatus', 'sourceType'] as const).every(key => entry[key] === snapshot[key])) return false;
    const queue = await loadWebVoyageShareQueue();
    if (entry.shareStatus === 'delivered') {
      if (entry.sharedAt !== deliveredAt) return false;
    } else if (!queue.some(item => item.logId === entry.id) || hasWebVoyageShareAttempt(entry)) return false;
    await registerDelivery();
    if (!canCommit()) return false;
    if (entry.shareStatus !== 'delivered') {
      await updateWebVoyageLogEntryUnlocked(entry.id, {
        shareError: undefined, sharedAt: deliveredAt, shareStatus: 'delivered',
      });
    }
    // Re-read so a concurrently received unrelated queue item cannot be lost.
    const latestQueue = await loadWebVoyageShareQueue();
    if (latestQueue.some(item => item.logId === entry.id)) {
      await saveWebVoyageShareQueue(latestQueue.filter(item => item.logId !== entry.id));
    }
    return true;
  });
}

type WebVoyageSkipReason = 'drive-not-matching' | 'daily-cap' | 'failure-stop' | 'cooldown';

function canTryWebVoyage(intent: ExplorationExecutionIntent, state: WebVoyageState, now: number): { ok: true } | { nextAt?: number; reason: WebVoyageSkipReason; ok: false } {
  if (intent.driveKey !== 'curiosity' && intent.driveKey !== 'social') return { ok: false, reason: 'drive-not-matching' };
  if (state.attemptCountToday >= MAX_ATTEMPTS_PER_DAY) return { ok: false, reason: 'daily-cap' };
  if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return { ok: false, reason: 'failure-stop' };
  if (typeof state.lastAttemptAt === 'number' && now - state.lastAttemptAt < MIN_ATTEMPT_INTERVAL_MS) {
    return { nextAt: state.lastAttemptAt + MIN_ATTEMPT_INTERVAL_MS, ok: false, reason: 'cooldown' };
  }
  return { ok: true };
}

export function shouldRecordWebVoyageSkipLog(reason: WebVoyageSkipReason) {
  return reason !== 'drive-not-matching' &&
    reason !== 'daily-cap' &&
    reason !== 'cooldown' &&
    reason !== 'failure-stop';
}

export function describeSearchDiagnostics(
  diagnostics: Array<{
    attemptCount?: number;
    engine?: string;
    httpStatus?: number;
    label?: string;
    lastFailure?: string;
    resultCount?: number;
    scope?: string;
    skippedReason?: string;
    status?: string;
  }>,
) {
  const parts = diagnostics
    .map((diagnostic) => {
      const label = compactText(diagnostic.label, 36);
      const facts = [
        compactText(diagnostic.scope, 20),
        compactText(diagnostic.engine, 24),
        typeof diagnostic.httpStatus === 'number' ? `HTTP ${diagnostic.httpStatus}` : '',
        typeof diagnostic.attemptCount === 'number' ? `尝试 ${diagnostic.attemptCount}` : '',
        typeof diagnostic.resultCount === 'number' ? `结果 ${diagnostic.resultCount}` : '',
      ].filter(Boolean);
      const reason = compactText(diagnostic.lastFailure || diagnostic.skippedReason || diagnostic.status, 90);
      const detail = [facts.join(' '), reason].filter(Boolean).join('；');
      return label && detail ? `${label}: ${detail}` : '';
    })
    .filter(Boolean);
  return compactText(parts.join(' / '), 260);
}

function compactErrorMessage(error: unknown, limit = 120) {
  return compactText(error instanceof Error ? error.message : String(error || 'unknown_error'), limit) || 'unknown_error';
}

export function classifyWebVoyageRuntimeError(phase: 'search' | 'fetch', error: unknown) {
  const message = compactErrorMessage(error);
  if (phase === 'search') {
    return {
      detail: `公开网页搜索链路异常：${message}。已停止，没有打开社交平台。`,
      failureReason: 'search_failed',
      stage: 'search' as const,
    };
  }
  return {
    detail: `搜到了公开网页链接，但页面读取失败：${message}。已停止，没有改走社交平台。`,
    failureReason: 'fetch_failed',
    stage: 'fetch' as const,
  };
}

export function describeWebVoyagePageFailure(page: WebSearchProviderPage | null, fetchFailureDetail = '') {
  if (page) {
    return {
      detail: '找到了公开网页，但没有读到清晰摘要；已停止，没有改走社交平台。',
      failureReason: 'empty_summary',
      stage: 'summarize' as const,
    };
  }
  const detail = fetchFailureDetail
    ? `搜到了公开网页链接，但页面读取失败：${compactText(fetchFailureDetail, 120)}。已停止，没有改走社交平台。`
    : '搜到了公开网页链接，但页面读取失败；已停止，没有改走社交平台。';
  return {
    detail,
    failureReason: 'fetch_failed',
    stage: 'fetch' as const,
  };
}


let voyageInFlight = false;

export async function runWebVoyageTick({
  backupRestoreLeaseHeld, intent, now = Date.now(),
}: { backupRestoreLeaseHeld?: boolean; intent: ExplorationExecutionIntent; now?: number }) {
  if (voyageInFlight) return null;
  voyageInFlight = true;
  const epoch = captureBackupRestoreDataEpoch();
  try {
    if (!canCommitBackupRestoreDataEpoch(epoch)) return null;
    const currentTime = () => Math.max(now, Date.now());
    const initialState = await loadWebVoyageState(currentTime());
    let beforeReservation = initialState;
    let pending = initialState.pending;
    if (!pending && !canTryWebVoyage(intent, initialState, currentTime()).ok) return null;
    if (!pending?.result && !(pending?.searchStarted && !pending.candidates)
      && !pending?.selectionStarted && pending?.selectedIndex === undefined) {
      try { await checkWebVoyageCost(); }
      catch (error) { if (isAiCostDeferred(error)) return null; throw error; }
    }
    const originalIntent = pending?.intent ?? intent;
    let occurredAt = pending?.at ?? now;
    const sources = await captureWebVoyageSources(originalIntent, now, pending?.sources);
    const isCurrent = async () => canCommitBackupRestoreDataEpoch(epoch)
      && await sources.isCurrent() && canCommitBackupRestoreDataEpoch(epoch);
    if (!await sources.canRun() || !canCommitBackupRestoreDataEpoch(epoch)) return null;
    if (!await sources.sourcesCurrent()) {
      if (pending) await runBackupRestoreDataEpochCommit(epoch, () => writeWebVoyageLog(async () => {
        const latest = await loadWebVoyageState(currentTime());
        if (latest.pending?.at === occurredAt) await saveWebVoyageState({ ...latest, pending: undefined }, currentTime());
      }));
      return null;
    }
    const reservation = await runBackupRestoreDataEpochCommit(epoch, () => writeWebVoyageLog(async () => {
      if (!await isCurrent()) return null;
      const loaded = await loadWebVoyageState(currentTime());
      if (!await isCurrent()) return null;
      const reservationNow = currentTime();
      const state = { ...loaded, ...normalizePublicExplorationQuota(JSON.stringify(loaded), undefined, reservationNow) };
      if (pending) return state.pending?.at === occurredAt ? state : null;
      if (!canTryWebVoyage(intent, state, reservationNow).ok) return null;
      beforeReservation = state;
      const next = { ...state, attemptCountToday: state.attemptCountToday + 1, lastAttemptAt: reservationNow };
      await saveWebVoyageState(next, reservationNow);
      return next;
    }));
    if (!reservation.committed || !reservation.value) return null;
    const reserved = reservation.value;
    occurredAt = pending?.at ?? reserved.lastAttemptAt!;
    let target = pending?.target ?? 'web';
    const provider = getWebSearchProviderStatus();
    const logId = `web-voyage-${occurredAt}-${sources.refs.owner ?? 'local'}`;
    const common = { at: occurredAt, driveKey: originalIntent.driveKey, driveLabel: EXPLORATION_DRIVE_LABELS[originalIntent.driveKey],
      driveReason: originalIntent.reason, reason: `${EXPLORATION_DRIVE_LABELS[originalIntent.driveKey]}：${originalIntent.reason}`,
      providerId: provider.id, providerLabel: provider.label, sourceType: 'web' as const };
    let settling = false;
    let savingProgress = false;
    const checkpoint = async (next: WebVoyagePending, unstarted = false) => {
      savingProgress = true;
      const commit = await runBackupRestoreDataEpochCommit(epoch, () => writeWebVoyageLog(async () => {
        if (!unstarted && !await isCurrent()) return false;
        const latest = await loadWebVoyageState(currentTime());
        if (latest.lastAttemptAt !== reserved.lastAttemptAt) return false;
        if (unstarted && JSON.stringify(latest.pending) !== JSON.stringify(pending)) return false;
        await saveWebVoyageState({ ...latest, pending: next }, currentTime());
        return true;
      }));
      if (!commit.committed || !commit.value) throw new Error('web_voyage_source_invalid');
      pending = next;
      savingProgress = false;
    };
    const finish = async (entry: Omit<WebVoyageLogEntry, 'at' | 'id' | 'reason'>) => {
      settling = true;
      if (!await isCurrent()) return null;
      const commit = await runBackupRestoreDataEpochCommit(epoch, async () => {
        if (!await isCurrent()) return null;
        const latest = await loadWebVoyageState(currentTime());
        // A changed reservation is not this run's state to settle.
        if (!await isCurrent() || latest.lastAttemptAt !== reserved.lastAttemptAt) return null;
        const result = pending?.result ?? normalizeLogEntry({ ...common,
          ...(target === 'github' ? { sourceType: 'github' as const,
            providerId: 'github_voyage' as const, providerLabel: 'GitHub 逛街' } : {}),
          ...entry, id: logId });
        if (!result) return null;
        // Keep an obtained result in this same local continuation before the
        // log/share writes. A failed log write must not repeat the HTTP read.
        if (pending && !pending.result) await checkpoint({ ...pending, result });
        const saved = await recordWebVoyageLog(result, isCurrent);
        if (!saved) return null;
        if (saved.status === 'completed' && await isCurrent()) await enqueueWebVoyageShare(saved, isCurrent);
        if (!await isCurrent()) return null;
        const commitNow = currentTime();
        const current = await loadWebVoyageState(commitNow);
        if (!await isCurrent() || current.lastAttemptAt !== reserved.lastAttemptAt) return null;
        await saveWebVoyageState({ ...current, pending: undefined,
          ...(current.dateKey === explorationDateKey(occurredAt) ? { consecutiveFailures: saved.status === 'failed'
            ? current.consecutiveFailures + 1 : 0 } : {}),
          ...(saved.status === 'completed' ? { lastCompletedAt: commitNow } : {}) }, commitNow);
        return saved;
      });
      return commit.committed ? commit.value : null;
    };
    let query = pending?.query ?? '';
    let stage: WebVoyageStage = 'query';
    try {
      if (pending) {
        const recorded = (await loadWebVoyageLog()).find(entry => entry.id === logId);
        if (recorded) return await finish(recorded);
        if (pending.result) return await finish(pending.result);
      }
      if (!pending) {
        const answer = await requestWebVoyageDecision(WEB_VOYAGE_TOPIC_INSTRUCTION, sources.material, isCurrent);
        if (!await isCurrent()) return null;
        const parsed: GeneratedWebVoyageQuery = parseGeneratedSearchQuery(answer);
        if (parsed.ok === false) return await finish({ status: 'failed', stage, detail: parsed.detail, failureReason: parsed.reason });
        query = parsed.query;
        target = parsed.target ?? 'web';
        if (!query.trim()) return await finish({ status: 'skipped', stage, detail: '本次选择暂不探索。' });
        await checkpoint({ at: occurredAt, intent: originalIntent, sources: sources.refs, query, target });
      }
      stage = 'search';
      if (!await isCurrent()) return null;
      if (pending?.selectionStarted && pending.selectedIndex === undefined) {
        // The previous process entered transport but did not persist a decision.
        // Unknown paid results must never turn into another paid selection.
        return await finish({ status: 'failed', stage, query, detail: '上次选页结果无法确认。', failureReason: 'page_choice_unknown' });
      }
      let candidates = pending?.candidates;
      if (!candidates) {
        // Like an interrupted page read, an unknown search must not be bought again.
        if (pending?.searchStarted) throw new Error('web_voyage_search_outcome_unknown');
        await checkpoint({ ...pending!, searchStarted: true });
        if (!await isCurrent()) return null;
        candidates = target === 'github'
          ? await searchGithubVoyage(query, { backupRestoreLeaseHeld, isCurrent })
          : selectWebVoyageCandidates((await searchWebVoyageProvider(query, { backupRestoreLeaseHeld })).results);
        if (!await isCurrent()) return null;
        if (candidates.length) await checkpoint({ ...pending!, candidates });
      }
      if (!candidates.length) return await finish({ status: 'failed', stage, query,
        detail: '本次搜索没有可读取候选。', failureReason: 'no_search_result' });
      if (pending?.selectedIndex === undefined) {
        const selection = await requestWebVoyageDecision(target === 'github' ? GITHUB_VOYAGE_PAGE_INSTRUCTION : WEB_VOYAGE_PAGE_INSTRUCTION,
          JSON.stringify({ 搜索词: query, 候选: candidates.map((item, index) => target === 'github'
            ? { 编号: index + 1, 项目名称: item.title, 链接: item.url, 简介: item.snippet }
            : { 编号: index + 1, 标题: item.title, 链接: item.url, 摘要: item.snippet }) }), isCurrent,
          () => checkpoint({ ...pending!, selectionStarted: true }),
          () => checkpoint({ ...pending!, selectionStarted: false }, true));
        if (!await isCurrent()) return null;
        const item = parseWebVoyagePageChoice(selection, candidates.length);
        if (item === null) return await finish({ status: 'skipped', stage, query, detail: '本次没有选择网页。' });
        if (item === undefined) return await finish({ status: 'failed', stage, query,
          detail: '选页答卷格式或编号无效。', failureReason: 'page_choice_invalid' });
        await checkpoint({ ...pending!, selectedIndex: item - 1 });
      }
      const selected = candidates[pending!.selectedIndex!];
      stage = 'fetch';
      if (!await isCurrent()) return null;
      if (pending?.readStarted) throw new Error('web_voyage_read_outcome_unknown');
      await checkpoint({ ...pending!, readStarted: true });
      if (!await isCurrent()) return null;
      // A read failure still retains the exact search preview, never tries another page.
      const fetched = target === 'github' ? null
        : await fetchWebVoyageProviderPage(selected.url, { backupRestoreLeaseHeld }).catch(() => null);
      const githubBody = target === 'github'
        ? await readGithubVoyage(selected as GithubVoyageCandidate, { backupRestoreLeaseHeld, isCurrent }).catch(() => null) : null;
      if (!await isCurrent()) return null;
      const body = compactText(target === 'github' ? githubBody : fetched?.page?.excerpt, 260);
      const preview = compactText(selected.snippet, 260);
      const readingStatus: WebVoyageReadingStatus = body ? 'body_excerpt' : preview ? 'search_preview' : 'metadata_only';
      return await finish({ status: body ? 'completed' : 'failed', stage: body ? 'completed' : 'fetch', query,
        readingStatus, summary: body || preview || undefined,
        title: compactText(fetched?.page?.title || selected.title, 80), url: selected.url,
        fetchMode: target === 'github' ? 'http' : fetched?.page?.fetchMode,
        shareStatus: body ? 'pending' : 'none',
        failureReason: body ? undefined : 'body_unavailable',
        detail: body ? '已取得正文摘录，等待原有交流机会。' : '没有取得网页正文，保留现有预览。' });
    } catch (error) {
      if (settling || savingProgress) throw error;
      if (isAiCostDeferred(error)) {
        if (!pending) await runBackupRestoreDataEpochCommit(epoch, () => writeWebVoyageLog(async () => {
          const latest = await loadWebVoyageState(currentTime());
          if (latest.lastAttemptAt === reserved.lastAttemptAt) {
            // No first request went out: only undo this run's own reservation.
            await saveWebVoyageState(beforeReservation, currentTime());
          }
        }));
        return null;
      }
      if (!await isCurrent()) return null;
      return await finish({ status: 'failed', stage, query: query || undefined,
        detail: compactErrorMessage(error), failureReason: error instanceof WebVoyageDecisionResponseError
          ? error.reason : stage === 'query' ? 'query_failed' : stage + '_failed' });
    }
  } finally { voyageInFlight = false; }
}

