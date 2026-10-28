import { chatRelationshipStorageBridge as AsyncStorage } from '../sync/syncChatRelationshipStorageBridge';

import {
  loadKeywordCounterSnapshot,
  type KeywordCounterTask,
} from './keywordCounterStore';

export type NotebookEntrySourceType =
  | 'manual'
  | 'keyword_counter'
  | 'assistant_hidden_request'
  | 'assistant_inner_reaction'
  | 'assistant_auto_guarded'
  | 'interaction';

export type NotebookEntry = {
  content: string;
  createdAt: number;
  id: string;
  interactedAt?: number;
  keywords: string[];
  readAt?: number;
  sourceExcerpt?: string;
  sourceId?: string;
  sourceMessageId?: string;
  sourceType: NotebookEntrySourceType;
  title: string;
  updatedAt: number;
};

export type NotebookSettings = {
  cooldownMs: number;
  enabled: boolean;
  lastCreatedAt?: number;
};

export type NotebookSnapshot = {
  entries: NotebookEntry[];
  settings: NotebookSettings;
};

export type NotebookEntryDraft = {
  content: string;
  createdAt?: number;
  keywords?: string[];
  sourceExcerpt?: string;
  sourceId?: string;
  sourceMessageId?: string;
  sourceType?: NotebookEntrySourceType;
  title?: string;
};

export type NotebookEntryRequest = {
  content: string;
  keywords?: string[];
  sourceExcerpt?: string;
  title?: string;
};

export type NotebookInteractionHandoff = {
  content: string;
  createdAt: number;
  entryId: string;
  keywords: string[];
  sourceExcerpt?: string;
  sourceType: NotebookEntrySourceType;
  title: string;
};

const NOTEBOOK_KEY = 'junluo.chat.baiyunNotebook.v1';
const NOTEBOOK_PENDING_INTERACTION_KEY = 'junluo.chat.baiyunNotebook.pendingInteraction.v1';
const NOTEBOOK_ENTRY_MARKER_PATTERN = /\[\[NOTEBOOK_ENTRY:([\s\S]*?)\]\]/g;
export const NOTEBOOK_DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 400;
const MAX_KEYWORDS = 8;
const MAX_TITLE_LENGTH = 40;
const MAX_CONTENT_LENGTH = 480;
const MAX_SOURCE_EXCERPT_LENGTH = 180;
const notebookListeners = new Set<(snapshot: NotebookSnapshot) => void>();

export function subscribeNotebookChanged(listener: (snapshot: NotebookSnapshot) => void) {
  notebookListeners.add(listener);
  return () => { notebookListeners.delete(listener); };
}

const MECHANICAL_NOTEBOOK_PATTERN =
  /(?:NOTEBOOK_ENTRY|COUNTER_REQUEST|隐藏指令|系统(?:检测|记录|提示)?|计数器|检测到关键词|关键词命中|触发(?:了|到)?|落库|写入数据库|用户说了?|小仓鼠说(?:了)?)/i;
const NOTEBOOK_DIRECTIVE_PATTERN = /\[\[(?:NOTEBOOK_ENTRY|COUNTER_REQUEST):[\s\S]*?\]\]/g;

export const defaultNotebookSettings: NotebookSettings = {
  cooldownMs: NOTEBOOK_DEFAULT_COOLDOWN_MS,
  enabled: true,
};

function makeId(prefix: string, now = Date.now()) {
  return `${prefix}-${now}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeText(value: unknown, maxLength: number) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function normalizeKeywords(value: unknown) {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  return [...new Set(raw.map((item) => normalizeText(item, 24)).filter(Boolean))].slice(0, MAX_KEYWORDS);
}

export function cleanNotebookContent(value: unknown) {
  const text = normalizeText(value, MAX_CONTENT_LENGTH)
    .replace(NOTEBOOK_DIRECTIVE_PATTERN, '')
    .replace(/^(?:检测到|记录到|系统记录|系统检测到|用户说了?|小仓鼠说(?:了)?|关键词命中|触发(?:了|到)?)[：:\s]*/i, '')
    .replace(/(?:隐藏指令|计数器|系统提示|写入数据库|落库)[：:\s]*/gi, '')
    .trim();
  if (!text || MECHANICAL_NOTEBOOK_PATTERN.test(text)) return '';
  return text.slice(0, 180).trim();
}

function normalizeSettings(value: unknown): NotebookSettings {
  if (!value || typeof value !== 'object') return defaultNotebookSettings;
  const settings = value as Partial<NotebookSettings>;
  const cooldownMs = typeof settings.cooldownMs === 'number' && Number.isFinite(settings.cooldownMs)
    ? Math.max(0, settings.cooldownMs)
    : NOTEBOOK_DEFAULT_COOLDOWN_MS;
  return {
    cooldownMs,
    enabled: settings.enabled !== false,
    lastCreatedAt: typeof settings.lastCreatedAt === 'number' ? settings.lastCreatedAt : undefined,
  };
}

function normalizeSourceType(value: unknown): NotebookEntrySourceType {
  return value === 'keyword_counter' ||
    value === 'assistant_hidden_request' ||
    value === 'assistant_inner_reaction' ||
    value === 'assistant_auto_guarded' ||
    value === 'interaction' ||
    value === 'manual'
    ? value
    : 'manual';
}

function buildTitle(rawTitle: unknown, keywords: string[]) {
  const title = normalizeText(rawTitle, MAX_TITLE_LENGTH);
  if (title) return title;
  const keywordTitle = keywords.join('、').slice(0, MAX_TITLE_LENGTH);
  return keywordTitle || '白云小本本';
}

function readNotebookRequest(value: unknown): NotebookEntryRequest | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const content = cleanNotebookContent(item.content ?? item.note ?? item.text);
  if (!content) return null;

  const keywords = normalizeKeywords(item.keywords ?? item.keyword);
  return {
    content,
    keywords,
    sourceExcerpt: normalizeText(item.sourceExcerpt ?? item.excerpt, MAX_SOURCE_EXCERPT_LENGTH) || undefined,
    title: normalizeText(item.title, MAX_TITLE_LENGTH) || undefined,
  };
}

function normalizeEntry(value: unknown): NotebookEntry | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<NotebookEntry>;
  const content = normalizeText(item.content, MAX_CONTENT_LENGTH);
  if (!content || typeof item.id !== 'string' || typeof item.createdAt !== 'number') return null;

  const keywords = normalizeKeywords(item.keywords);
  return {
    content,
    createdAt: item.createdAt,
    id: item.id,
    interactedAt: typeof item.interactedAt === 'number' ? item.interactedAt : undefined,
    keywords,
    readAt: typeof item.readAt === 'number' ? item.readAt : undefined,
    sourceExcerpt: normalizeText(item.sourceExcerpt, MAX_SOURCE_EXCERPT_LENGTH) || undefined,
    sourceId: normalizeText(item.sourceId, 120) || undefined,
    sourceMessageId: normalizeText(item.sourceMessageId, 120) || undefined,
    sourceType: normalizeSourceType(item.sourceType),
    title: buildTitle(item.title, keywords),
    updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : item.createdAt,
  };
}

function buildInteractionHandoff(entry: NotebookEntry): NotebookInteractionHandoff {
  return {
    content: normalizeText(entry.content, MAX_CONTENT_LENGTH),
    createdAt: Date.now(),
    entryId: entry.id,
    keywords: normalizeKeywords(entry.keywords),
    sourceExcerpt: normalizeText(entry.sourceExcerpt, MAX_SOURCE_EXCERPT_LENGTH) || undefined,
    sourceType: normalizeSourceType(entry.sourceType),
    title: buildTitle(entry.title, entry.keywords),
  };
}

function normalizeInteractionHandoff(value: unknown): NotebookInteractionHandoff | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<NotebookInteractionHandoff>;
  const content = normalizeText(item.content, MAX_CONTENT_LENGTH);
  const entryId = normalizeText(item.entryId, 120);
  const keywords = normalizeKeywords(item.keywords);
  if (!content || !entryId) return null;
  return {
    content,
    createdAt: typeof item.createdAt === 'number' ? item.createdAt : Date.now(),
    entryId,
    keywords,
    sourceExcerpt: normalizeText(item.sourceExcerpt, MAX_SOURCE_EXCERPT_LENGTH) || undefined,
    sourceType: normalizeSourceType(item.sourceType),
    title: buildTitle(item.title, keywords),
  };
}

function normalizeSnapshot(value: unknown): NotebookSnapshot {
  const candidate = value && typeof value === 'object' ? value as Partial<NotebookSnapshot> : {};
  const entries = Array.isArray(candidate.entries)
    ? candidate.entries
      .map(normalizeEntry)
      .filter((entry): entry is NotebookEntry => !!entry)
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, MAX_ENTRIES)
    : [];

  return {
    entries,
    settings: normalizeSettings(candidate.settings),
  };
}

async function loadSnapshot(): Promise<NotebookSnapshot> {
  const raw = await AsyncStorage.getItem(NOTEBOOK_KEY);
  if (!raw) return { entries: [], settings: defaultNotebookSettings };

  try {
    return normalizeSnapshot(JSON.parse(raw) as unknown);
  } catch {
    return { entries: [], settings: defaultNotebookSettings };
  }
}

async function saveSnapshot(snapshot: NotebookSnapshot) {
  const normalized = normalizeSnapshot(snapshot);
  await AsyncStorage.setItem(NOTEBOOK_KEY, JSON.stringify(normalized));
  for (const listener of notebookListeners) {
    try { listener(normalized); } catch { /* A view must not turn a saved entry into a failed write. */ }
  }
  return normalized;
}

export async function loadNotebookSnapshot() {
  return loadSnapshot();
}

export async function saveNotebookSettings(settings: Partial<NotebookSettings>) {
  const snapshot = await loadSnapshot();
  return saveSnapshot({ ...snapshot, settings: normalizeSettings({ ...snapshot.settings, ...settings }) });
}

export function isNotebookEntryAllowedNow(
  settings: NotebookSettings,
  sourceType: NotebookEntrySourceType,
  now = Date.now(),
) {
  if (!settings.enabled) return false;
  if (sourceType !== 'assistant_hidden_request' && sourceType !== 'assistant_auto_guarded') return true;
  if (!settings.lastCreatedAt) return true;
  return now - settings.lastCreatedAt >= settings.cooldownMs;
}

export async function createNotebookEntry(draft: NotebookEntryDraft) {
  const snapshot = await loadSnapshot();
  const now = Date.now();
  const sourceType = normalizeSourceType(draft.sourceType);
  const createdAt = typeof draft.createdAt === 'number' ? draft.createdAt : now;
  const content = cleanNotebookContent(draft.content);
  if (!content) return null;
  const sourceId = normalizeText(draft.sourceId, 120) || undefined;
  const sourceMessageId = normalizeText(draft.sourceMessageId, 120) || undefined;
  const duplicate = snapshot.entries.find((entry) => (
    entry.sourceType === sourceType
    && entry.content === content
    && (
      (sourceMessageId && entry.sourceMessageId === sourceMessageId)
      || (sourceId && entry.sourceId === sourceId)
    )
  ));
  if (duplicate) return duplicate;
  if (!isNotebookEntryAllowedNow(snapshot.settings, sourceType, now)) return null;

  const keywords = normalizeKeywords(draft.keywords);
  const entry: NotebookEntry = {
    content,
    createdAt,
    id: makeId('baiyun-note', now),
    keywords,
    sourceExcerpt: normalizeText(draft.sourceExcerpt, MAX_SOURCE_EXCERPT_LENGTH) || undefined,
    sourceId,
    sourceMessageId,
    sourceType,
    title: buildTitle(draft.title, keywords),
    updatedAt: now,
  };

  const settings = sourceType === 'assistant_hidden_request' || sourceType === 'assistant_auto_guarded'
    ? { ...snapshot.settings, lastCreatedAt: now }
    : snapshot.settings;
  await saveSnapshot({ ...snapshot, entries: [entry, ...snapshot.entries].slice(0, MAX_ENTRIES), settings });
  return entry;
}

export function extractNotebookEntryRequests(contents: string[]) {
  const requests: NotebookEntryRequest[] = [];
  const cleanedContents = contents
    .map((content) => content.replace(NOTEBOOK_ENTRY_MARKER_PATTERN, (_match, rawJson: string) => {
      try {
        const parsed = JSON.parse(rawJson.trim()) as unknown;
        const entries = Array.isArray(parsed) ? parsed : [parsed];
        entries.forEach((entry) => {
          const request = readNotebookRequest(entry);
          if (request) requests.push(request);
        });
      } catch {
        // Bad hidden directives are removed from visible chat and otherwise ignored.
      }
      return '';
    }).trim())
    .filter(Boolean);
  return { cleanedContents, requests };
}

function keywordCounterStatusText(task: KeywordCounterTask) {
  if (task.status === 'disabled') return '已停用';
  if (task.status === 'completed') return '已完成';
  return '记录中';
}

function buildKeywordCounterMigrationEntry(task: KeywordCounterTask, now: number, index: number): NotebookEntry {
  const keywords = normalizeKeywords(task.keywords);
  const keywordText = keywords.map((keyword) => `“${keyword}”`).join('、') || '这个词';
  const targetText = task.type === 'nth_occurrence' && task.targetCount ? `，目标是第 ${task.targetCount} 次` : '';
  return {
    content: `旧页归档：之前记着${keywordText}${targetText}，现在计到 ${task.count} 次。状态：${keywordCounterStatusText(task)}。`,
    createdAt: task.createdAt,
    id: makeId('baiyun-note', now + index),
    keywords,
    sourceId: task.id,
    sourceType: 'keyword_counter',
    title: buildTitle(`旧计数：${task.title}`, keywords),
    updatedAt: now,
  };
}

export async function migrateKeywordCountersToNotebook() {
  const [counterSnapshot, notebookSnapshot] = await Promise.all([
    loadKeywordCounterSnapshot(),
    loadSnapshot(),
  ]);
  if (!notebookSnapshot.settings.enabled) return notebookSnapshot;

  const importedTaskIds = new Set(
    notebookSnapshot.entries
      .filter((entry) => entry.sourceType === 'keyword_counter' && entry.sourceId)
      .map((entry) => entry.sourceId),
  );
  const tasksToImport = counterSnapshot.tasks.filter((task) =>
    !importedTaskIds.has(task.id) && !task.requestedByMessageId?.startsWith('afterglow:'));
  if (!tasksToImport.length) return notebookSnapshot;

  const now = Date.now();
  const entries = [
    ...tasksToImport.map((task, index) => buildKeywordCounterMigrationEntry(task, now, index)),
    ...notebookSnapshot.entries,
  ];
  return saveSnapshot({ ...notebookSnapshot, entries });
}

export async function deleteNotebookEntry(entryId: string) {
  const snapshot = await loadSnapshot();
  const pending = await loadPendingNotebookInteraction();
  if (pending?.entryId === entryId) {
    await AsyncStorage.removeItem(NOTEBOOK_PENDING_INTERACTION_KEY);
  }
  return saveSnapshot({
    ...snapshot,
    entries: snapshot.entries.filter((entry) => entry.id !== entryId),
  });
}

export async function markNotebookEntryRead(entryId: string) {
  const snapshot = await loadSnapshot();
  const now = Date.now();
  return saveSnapshot({
    ...snapshot,
    entries: snapshot.entries.map((entry) =>
      entry.id === entryId ? { ...entry, readAt: entry.readAt ?? now, updatedAt: now } : entry,
    ),
  });
}

export async function markNotebookEntryInteracted(entryId: string) {
  const snapshot = await loadSnapshot();
  const now = Date.now();
  return saveSnapshot({
    ...snapshot,
    entries: snapshot.entries.map((entry) =>
      entry.id === entryId ? { ...entry, interactedAt: entry.interactedAt ?? now, updatedAt: now } : entry,
    ),
  });
}

export async function savePendingNotebookInteraction(entryId: string) {
  const snapshot = await loadSnapshot();
  const entry = snapshot.entries.find((item) => item.id === entryId);
  if (!entry) return null;
  const handoff = buildInteractionHandoff(entry);
  await AsyncStorage.setItem(NOTEBOOK_PENDING_INTERACTION_KEY, JSON.stringify(handoff));
  return handoff;
}

export async function loadPendingNotebookInteraction() {
  const raw = await AsyncStorage.getItem(NOTEBOOK_PENDING_INTERACTION_KEY);
  if (!raw) return null;
  try {
    return normalizeInteractionHandoff(JSON.parse(raw) as unknown);
  } catch {
    await AsyncStorage.removeItem(NOTEBOOK_PENDING_INTERACTION_KEY);
    return null;
  }
}

export async function consumePendingNotebookInteraction() {
  const handoff = await loadPendingNotebookInteraction();
  await AsyncStorage.removeItem(NOTEBOOK_PENDING_INTERACTION_KEY);
  return handoff;
}

export function buildNotebookInteractionInstruction(handoff: NotebookInteractionHandoff, userText: string) {
  const sourceText = handoff.sourceType === 'keyword_counter'
    ? '这页是 I 以前留下的关键词计数归档，记录着当时已经数到的结果。'
    : '这页是 I 之前留下的一张小纸条。';
  const pageLines = [
    `标题：${handoff.title}`,
    `正文：${handoff.content}`,
    handoff.keywords.length
      ? `关键词：${handoff.keywords.map((keyword) => `“${keyword}”`).join('、')}`
      : '',
    handoff.sourceExcerpt ? `当时相关原话摘要：${handoff.sourceExcerpt}` : '',
  ].filter(Boolean);

  return [
    '【小本本：you 带着一页回来聊天】',
    '刚刚发生的事实：\nyou 在信件页翻开了 I 的一页小本本，现在回来和 I 聊这一页。',
    sourceText,
    `【这一页】\n${pageLines.join('\n')}`,
    `you 这次说：${normalizeText(userText, 180)}`,
  ].join('\n\n');
}
