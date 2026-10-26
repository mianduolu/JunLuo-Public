import { webVoyageReadingStatusText, type WebVoyageReadingStatus } from './webVoyageReading';

const DAY_MS = 24 * 60 * 60 * 1000;
const COMPLETED_RETENTION_DAYS = 2;
const UNRESOLVED_SHARE_RETENTION_DAYS = 2;

export type WebVoyageLifeMaterialInput = {
  at: number;
  detail?: string;
  failureReason?: string;
  id: string;
  query?: string;
  readingStatus?: WebVoyageReadingStatus;
  sharedAt?: number;
  shareStatus?: 'none' | 'pending' | 'delivered' | 'failed';
  sourceType?: 'web' | 'github';
  stage?: 'waiting' | 'query' | 'search' | 'fetch' | 'summarize' | 'completed';
  status: 'skipped' | 'searching' | 'completed' | 'blocked' | 'failed';
  summary?: string;
  title?: string;
  url?: string;
};

export type WebVoyageLifeMaterial = {
  expiresAt: number;
  fingerprintKey: string;
  id: string;
  importance: 'low' | 'medium' | 'high';
  occurredAt: number;
  promptLine: string;
  sourceType: 'web' | 'github';
  summary: string;
};

export type BrowserLifeMaterialInput = {
  openedAt?: number;
  readAt?: number;
  recordId: string;
  source: 'chat' | 'life_agent' | 'proactive' | 'background' | 'manual';
  title?: string;
  url: string;
};

export type BrowserLifeMaterial = {
  expiresAt: number;
  fingerprintKey: string;
  importance: 'low' | 'medium';
  occurredAt: number;
  promptLine: string;
  recordId: string;
  summary: string;
};

function compactText(value: unknown, limit = 220) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : '';
}

function localDaySerial(timestamp: number) {
  const date = new Date(timestamp);
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS);
}

function localDateKey(timestamp: number) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, '0')}-${`${date.getDate()}`.padStart(2, '0')}`;
}

function localDayAge(occurredAt: number, now: number) {
  return Math.max(0, localDaySerial(now) - localDaySerial(occurredAt));
}

function localExpiryAt(occurredAt: number, retentionDays: number) {
  const expiry = new Date(occurredAt);
  expiry.setHours(0, 0, 0, 0);
  expiry.setDate(expiry.getDate() + retentionDays);
  return expiry.getTime();
}

function stageText(stage: WebVoyageLifeMaterialInput['stage']) {
  if (stage === 'query' || stage === 'waiting') return '准备搜索词';
  if (stage === 'fetch') return '读取页面';
  if (stage === 'summarize') return '整理内容';
  return '寻找结果';
}

function formatFailedPrompt(sourceType: 'web' | 'github', query: string, stage: string) {
  if (sourceType === 'github') {
    return `GitHub 逛街：I 这次围绕“${query}”逛了逛，停在了${stage}，没有带回可用见闻。`;
  }
  return `网页远游：I 这次围绕“${query}”出门探索，停在了${stage}，没有带回可用见闻。`;
}

function toWebVoyageMaterial(
  entry: WebVoyageLifeMaterialInput,
  now: number,
): WebVoyageLifeMaterial | null {
  if (!entry.id || !Number.isFinite(entry.at) || entry.at <= 0) return null;
  if (entry.status !== 'completed' && entry.status !== 'failed') return null;
  const sourceType = entry.sourceType === 'github' ? 'github' : 'web';

  if (entry.status === 'failed') {
    if (localDayAge(entry.at, now) > 0) return null;
    const query = compactText(entry.query || entry.title, 80) || '这次探索';
    const stoppedAt = stageText(entry.stage);
    const preview = (entry.title || entry.summary || entry.url) ? [
      webVoyageReadingStatusText(entry.readingStatus, sourceType),
      compactText(entry.title, 60), compactText(entry.summary, 110), entry.url,
    ].filter(Boolean).join('\n') : '';
    return {
      expiresAt: localExpiryAt(entry.at, 1),
      fingerprintKey: [
        entry.id,
        entry.status,
        sourceType,
        entry.stage ?? 'search',
        query,
        compactText(entry.failureReason, 120),
        localDateKey(entry.at),
        ...(entry.readingStatus !== undefined
          ? [entry.at, entry.readingStatus, entry.query, entry.title, entry.summary, entry.url] : []),
      ].join('|'),
      id: entry.id,
      importance: 'low',
      occurredAt: entry.at,
      promptLine: preview || formatFailedPrompt(sourceType, query, stoppedAt),
      sourceType,
      summary: sourceType === 'github' && entry.readingStatus === undefined
        ? `${query}；停在${stoppedAt}` : preview || `${query}；停在${stoppedAt}`,
    };
  }

  const title = compactText(entry.title || entry.query, 60) || '公开材料';
  const content = compactText(entry.summary || entry.detail, 110);
  if (!content) return null;
  const summary = `${title}：${content}`;
  const shareStatus = entry.shareStatus === 'pending' ||
    entry.shareStatus === 'failed' ||
    entry.shareStatus === 'delivered' ||
    entry.shareStatus === 'none'
    ? entry.shareStatus
    : 'none';
  const unresolved = shareStatus === 'pending' || shareStatus === 'failed';
  const shareActivityAt = shareStatus === 'failed' && typeof entry.sharedAt === 'number'
    ? entry.sharedAt
    : entry.at;
  const retentionOrigin = unresolved ? shareActivityAt : entry.at;
  const dayAge = localDayAge(retentionOrigin, now);
  const retentionDays = unresolved ? UNRESOLVED_SHARE_RETENTION_DAYS : COMPLETED_RETENTION_DAYS;
  if (dayAge >= retentionDays) return null;

  return {
    expiresAt: localExpiryAt(retentionOrigin, retentionDays),
    fingerprintKey: [
      entry.id,
      entry.status,
      sourceType,
      shareStatus,
      title,
      content,
      dayAge === 0 ? 'today' : 'recent',
      ...(entry.readingStatus !== undefined
        ? [entry.at, entry.readingStatus, entry.query, entry.title, entry.summary, entry.detail, entry.url] : []),
    ].join('|'),
    id: entry.id,
    importance: unresolved && dayAge === 0 ? 'high' : 'medium',
    occurredAt: shareStatus === 'delivered' && typeof entry.sharedAt === 'number'
      ? entry.sharedAt
      : retentionOrigin,
    promptLine: [webVoyageReadingStatusText(entry.readingStatus, sourceType), title, content, entry.url].filter(Boolean).join('\n'),
    sourceType,
    summary: sourceType === 'github' && entry.readingStatus === undefined
      ? summary : `${webVoyageReadingStatusText(entry.readingStatus, sourceType)}\n${summary}`,
  };
}

export function selectWebVoyageLifeMaterials(
  entries: WebVoyageLifeMaterialInput[],
  now = Date.now(),
) {
  const materials = entries
    .map((entry) => toWebVoyageMaterial(entry, now))
    .filter((item): item is WebVoyageLifeMaterial => !!item)
    .sort((left, right) => right.occurredAt - left.occurredAt);
  const selected = new Map<'web' | 'github', WebVoyageLifeMaterial>();
  materials.forEach((material) => {
    if (!selected.has(material.sourceType)) selected.set(material.sourceType, material);
  });
  return Array.from(selected.values());
}

function browserSourceText(
  source: BrowserLifeMaterialInput['source'],
  actionText: '打开过' | '读过',
) {
  if (source === 'chat') return `I 在和 you 聊天时${actionText}这个网页`;
  if (source === 'life_agent') return `I 在自己的生活探索中${actionText}这个网页`;
  if (source === 'proactive') return `I 准备主动消息时${actionText}这个网页`;
  if (source === 'background') return `I 在后台任务中${actionText}这个网页`;
  return `you 通过工具页手动${actionText}这个网页`;
}

export function selectBrowserLifeMaterial(
  records: BrowserLifeMaterialInput[],
  now = Date.now(),
): BrowserLifeMaterial | null {
  const record = records
    .map((item) => ({
      item,
      occurredAt: item.readAt ?? item.openedAt ?? 0,
    }))
    .filter(({ item, occurredAt }) =>
      !!item.recordId &&
      !!compactText(item.url, 2000) &&
      Number.isFinite(occurredAt) &&
      occurredAt > 0 &&
      localDayAge(occurredAt, now) === 0)
    .sort((left, right) => right.occurredAt - left.occurredAt)[0];
  if (!record) return null;

  const title = compactText(record.item.title || record.item.url, 120);
  const actionText = typeof record.item.readAt === 'number' ? '读过' : '打开过';
  const sourceText = browserSourceText(record.item.source, actionText);
  return {
    expiresAt: localExpiryAt(record.occurredAt, 1),
    fingerprintKey: [
      record.item.recordId,
      compactText(record.item.url, 2000),
      title,
      record.item.source,
      localDateKey(record.occurredAt),
    ].join('|'),
    importance: record.item.source === 'chat' ? 'medium' : 'low',
    occurredAt: record.occurredAt,
    promptLine: `最近网页记录：${title}；${sourceText}。`,
    recordId: record.item.recordId,
    summary: `${title}（${record.item.source}）`,
  };
}
