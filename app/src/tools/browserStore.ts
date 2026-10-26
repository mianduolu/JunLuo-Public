import { toolsWorkspaceStorageBridge as AsyncStorage } from '../sync/syncToolsWorkspaceStorageBridge';
import { TOOLS_WORKSPACE_VISIT_RETENTION_MS } from '../sync/syncToolsWorkspace';

export const BROWSER_RECORDS_KEY = 'junluo.tools.browser.records.v1';

const MAX_BROWSER_RECORDS = 50;

export type JunLuoBrowserRecordSource = 'chat' | 'life_agent' | 'proactive' | 'background' | 'manual';

export type JunLuoBrowserRecord = {
  recordId: string;
  url: string;
  title?: string;
  cacheId?: string;
  openedAt?: number;
  readAt?: number;
  fetchMode?: 'http' | 'browser';
  source: JunLuoBrowserRecordSource;
};

function compactText(value: unknown, limit = 180) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : '';
}

function normalizeRecord(value: unknown): JunLuoBrowserRecord | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<JunLuoBrowserRecord>;
  const url = compactText(candidate.url, 2000);
  const recordId = compactText(candidate.recordId, 120);
  if (!url || !recordId) return null;
  const source = candidate.source === 'chat' ||
    candidate.source === 'life_agent' ||
    candidate.source === 'proactive' ||
    candidate.source === 'background' ||
    candidate.source === 'manual'
    ? candidate.source
    : 'manual';
  return {
    recordId,
    url,
    title: compactText(candidate.title, 180) || undefined,
    cacheId: compactText(candidate.cacheId, 120) || undefined,
    openedAt: typeof candidate.openedAt === 'number' ? candidate.openedAt : undefined,
    readAt: typeof candidate.readAt === 'number' ? candidate.readAt : undefined,
    fetchMode: candidate.fetchMode === 'browser' ? 'browser' : candidate.fetchMode === 'http' ? 'http' : undefined,
    source,
  };
}

function sortRecords(records: JunLuoBrowserRecord[]) {
  return records
    .slice()
    .sort((left, right) => (right.readAt ?? right.openedAt ?? 0) - (left.readAt ?? left.openedAt ?? 0));
}

function isRetainedRecord(record: JunLuoBrowserRecord, now = Date.now()) {
  const eventAt = record.readAt ?? record.openedAt ?? 0;
  return eventAt >= now - TOOLS_WORKSPACE_VISIT_RETENTION_MS;
}

async function loadAllBrowserRecords() {
  const raw = await AsyncStorage.getItem(BROWSER_RECORDS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const records = sortRecords(parsed
      .map(normalizeRecord)
      .filter((record): record is JunLuoBrowserRecord => (
        !!record && isRetainedRecord(record)
      )));
    const normalizedRaw = JSON.stringify(records);
    if (normalizedRaw !== raw) {
      await AsyncStorage.setItem(BROWSER_RECORDS_KEY, normalizedRaw);
    }
    return records;
  } catch {
    return [];
  }
}

async function saveBrowserRecords(records: JunLuoBrowserRecord[]) {
  const normalized = sortRecords(records)
    .map(normalizeRecord)
    .filter((record): record is JunLuoBrowserRecord => (
      !!record && isRetainedRecord(record)
    ))
    .slice(0, MAX_BROWSER_RECORDS);
  await AsyncStorage.setItem(BROWSER_RECORDS_KEY, JSON.stringify(normalized));
  return normalized;
}

export async function recordBrowserPageVisit(input: {
  cacheId?: string;
  fetchMode?: 'http' | 'browser';
  openedAt?: number;
  readAt?: number;
  source?: JunLuoBrowserRecordSource;
  title?: string;
  url: string;
}) {
  const now = Date.now();
  const url = compactText(input.url, 2000);
  if (!url) throw new Error('browser record url is required');
  const current = await loadAllBrowserRecords();
  const existing = current.find((record) => record.url === url);
  const next: JunLuoBrowserRecord = {
    ...(existing ?? {
      recordId: `browser-${now}-${Math.random().toString(36).slice(2, 8)}`,
      source: input.source ?? 'manual',
      url,
    }),
    cacheId: compactText(input.cacheId, 120) || existing?.cacheId,
    fetchMode: input.fetchMode ?? existing?.fetchMode,
    openedAt: input.openedAt ?? existing?.openedAt ?? now,
    readAt: input.readAt ?? existing?.readAt,
    source: input.source ?? existing?.source ?? 'manual',
    title: compactText(input.title, 180) || existing?.title,
    url,
  };
  await saveBrowserRecords([next, ...current.filter((record) => record.recordId !== next.recordId)]);
  return next;
}

export async function loadRecentBrowserRecords(limit = 20) {
  return (await loadAllBrowserRecords()).slice(0, Math.max(1, Math.min(50, Math.round(limit))));
}

export async function clearBrowserRecordsForTests() {
  await AsyncStorage.removeItem(BROWSER_RECORDS_KEY);
}
