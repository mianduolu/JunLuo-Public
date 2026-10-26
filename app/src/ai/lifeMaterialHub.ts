import {
  getCachedAmbientContext,
  getCachedAmbientLifeMaterialFingerprint,
  getCachedAmbientSnapshot,
} from './ambientContext';
import { getCachedSystemStatusAmbientContext, getCachedSystemStatusAmbientSnapshot } from './systemStatusAmbientContext';
import {
  formatNearStatusBodySignal,
  formatNearStatusFocus,
  formatNearStatusLifeEntries,
  formatNearStatusPhone,
  formatNearStatusPeriodLogParts,
  formatNearStatusReadingProgress,
  formatNearStatusReadingResult,
  formatNearStatusRecordedAt,
  formatNearStatusWebVoyage,
  selectNearStatusLifeEntries,
} from './nearStatusLifeMaterialFormat';
import { loadActiveFocusSession, loadRecentFocusSessions, loadLatestFocusSummary, loadFocusSummaryById } from '../focus/focusStore';
import { loadWebVoyageLog } from '../life/webVoyage';
import {
  selectBrowserLifeMaterial,
  selectWebVoyageLifeMaterials,
} from '../life/webVoyageLifeMaterialPolicy';
import {
  getPeriodDateKey,
  getPeriodDurationDays,
  loadLatestDailyLogBefore,
  loadPeriodSummary,
} from '../period/periodStore';
import { selectPeriodLifeMaterial } from '../period/periodLifeMaterialPolicy';
import { loadBodySignalSnapshot } from '../bodySignal/bodySignalReader';
import { selectBodySignalLifeMaterials, type BodySignalLifeMaterialInput } from '../bodySignal/bodySignalLifeMaterialPolicy';
import { formatBodySignalReadingContext, unknownBodySignalReadingContext } from '../bodySignal/bodySignalReadingContext';
import { loadBodySignalReadingContext } from '../bodySignal/bodySignalReadingContextReader';
import { loadReadingLifeMaterialSnapshot } from '../reading/readingLifeMaterial';
import { loadReadingAnnotations, loadReadingNotes, loadReadingSessions } from '../reading/readingStore';
import {
  formatCoReadingProgressPrompt,
  formatCoReadingResultPrompt,
} from '../reading/readingLifeMaterialPolicy';
import { loadRecentBrowserRecords } from '../tools/browserStore';
import { loadRecentToolCalls } from '../tools/toolAuditStore';
import { selectToolLifeMaterial, type ToolLifeMaterialInput } from '../tools/toolLifeMaterialPolicy';
import { loadActiveMessageCoordinatorSnapshot } from '../proactive/activeMessageCoordinator';
import { formatSleepSchedule, sleepWakeTarget } from '../life/sleepPlanPolicy';
import { formatSleepExperience, loadSleepMaterialDays, selectSleepExperienceEvents,
  sleepMaterialNightKey, SLEEP_EXPERIENCE_PREFIX, type SleepMaterialWindow } from '../life/sleepExperienceMaterial';

export type LifeMaterialSource =
  | 'wish-pool'
  | 'co-reading'
  | 'web-voyage'
  | 'github-voyage'
  | 'browser'
  | 'tool-audit'
  | 'period'
  | 'body-signal'
  | 'active-message'
  | 'assistant-schedule'
  | 'focus'
  | 'ambient';

export type LifeMaterialImportance = 'low' | 'medium' | 'high';

export type LifeMaterialItem = {
  id: string;
  source: LifeMaterialSource;
  title: string;
  summary: string;
  occurredAt: number;
  importance: LifeMaterialImportance;
  freshness: 'fresh' | 'recent' | 'stale';
  fingerprint: string;
  /** Exact source revision for this request, separate from legacy consumption identity. */
  sourceVersion?: string;
  promptLine: string;
  expiresAt?: number;
  /** Source evidence for home-only ordering; never a model instruction or persisted activity. */
  assistantParticipated?: boolean;
  /** Original saved result/change time; only these facts can open an independent affect paper. */
  affectResultAt?: number;
  /** Meaningful activity change, excluding elapsed seconds and cache timestamps. */
  nearStatusRevision?: string;
  /** A schedule tool result from this same near-status flow is background, not its next opportunity. */
  nearStatusSelfResult?: boolean;
  /** Saved tool identity for host-side selection, never inferred from result wording. */
  toolId?: string;
  /** Exact shared-scene identity for selection only, never model-visible metadata. */
  sameSource?: string;
};

export type LifeMaterialSnapshot = {
  generatedAt: number;
  items: LifeMaterialItem[];
  promptItems: LifeMaterialItem[];
  promptContext: string;
  fingerprint: string;
  debug: {
    sourceCounts: Partial<Record<LifeMaterialSource, number>>;
    dropped: string[];
  };
};

const FRESH_MS = 30 * 60 * 1000;
const RECENT_MS = 24 * 60 * 60 * 1000;
const MAX_PROMPT_ITEMS = 8;
const MAX_DROPPED_DEBUG_ITEMS = 8;

function compactText(value: unknown, limit = 160) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : '';
}

function localDateKey(timestamp = Date.now()) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, '0')}-${`${date.getDate()}`.padStart(2, '0')}`;
}

function hashText(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

export function lifeMaterialSourceRevision(item: LifeMaterialItem) {
  return item.sourceVersion ?? item.fingerprint;
}

export function hasConsumedLifeMaterial(stored: string | undefined, item: LifeMaterialItem) {
  return typeof stored === 'string' && (stored === item.fingerprint || stored === item.sourceVersion);
}

function freshnessFor(occurredAt: number, now: number): LifeMaterialItem['freshness'] {
  const age = Math.max(0, now - occurredAt);
  if (age <= FRESH_MS) return 'fresh';
  if (age <= RECENT_MS) return 'recent';
  return 'stale';
}

function makeItem(input: Omit<LifeMaterialItem, 'fingerprint' | 'freshness' | 'promptLine'> & {
  fingerprintParts?: unknown[];
  fingerprintText?: string;
  fullFingerprint?: boolean;
  nearStatus?: boolean;
  now: number;
  promptLine?: string;
}): LifeMaterialItem {
  const {
    fingerprintParts,
    fingerprintText,
    fullFingerprint,
    nearStatus,
    now,
    promptLine: inputPromptLine,
    ...item
  } = input;
  const fingerprintBody = [
    item.source,
    item.id,
    item.title,
    fingerprintText ?? item.summary,
    ...(fingerprintParts ?? []),
  ].map((part) => nearStatus || item.source === 'body-signal' || fullFingerprint ? String(part ?? '') : compactText(String(part ?? ''), 220)).join('|');
  const promptLine = inputPromptLine ?? `${item.title}：${item.summary}`;
  return {
    ...item,
    fingerprint: `${item.source}:${hashText(fingerprintBody)}`,
    freshness: freshnessFor(item.occurredAt, now),
    promptLine: nearStatus || item.source === 'body-signal' || item.source === 'web-voyage' || item.source === 'github-voyage'
      ? promptLine : compactText(promptLine, 220),
  };
}

function importanceRank(value: LifeMaterialImportance) {
  if (value === 'high') return 3;
  if (value === 'medium') return 2;
  return 1;
}

function sortItems(left: LifeMaterialItem, right: LifeMaterialItem) {
  return importanceRank(right.importance) - importanceRank(left.importance) ||
    right.occurredAt - left.occurredAt ||
    left.source.localeCompare(right.source);
}

function selectPromptItems(items: LifeMaterialItem[]) {
  return items
    .slice()
    .sort(sortItems)
    .slice(0, MAX_PROMPT_ITEMS);
}

function buildSnapshotFingerprint(promptItems: LifeMaterialItem[]) {
  const body = promptItems
    .map((item) => `${item.source}:${item.fingerprint}`)
    .sort()
    .join('\n');
  return `life-material:${hashText(body || 'empty')}`;
}

/** Shared input for I's saved schedule changes; future activity records use their own
 * versioned ID, real save time and approved material here, not you's calendar or a timer tick. */
export function makeAssistantScheduleLifeMaterial(input: {
  id: string; changedAt: number; promptLine: string;
}, now: number): LifeMaterialItem {
  return makeItem({ id: `assistant-schedule:${input.id}`, source: 'assistant-schedule',
    title: 'I 已有的日程', summary: input.promptLine, promptLine: input.promptLine,
    occurredAt: input.changedAt, affectResultAt: input.changedAt, assistantParticipated: true,
    importance: 'medium', now, nearStatus: true });
}

export async function collectAssistantSchedule(now: number, options: SleepMaterialWindow = {}) {
  const days = await loadSleepMaterialDays(now, options);
  // Concrete own-activity schedules are not implemented yet. Their saved changes join
  // this collector through makeAssistantScheduleLifeMaterial, never a second request path.
  return days.flatMap(day => {
    const plan = day?.nightSleepPlan;
    if (plan?.events) return selectSleepExperienceEvents(day, now, options).flatMap(event => {
      const promptLine = formatSleepExperience(day, event);
      if (!promptLine) return [];
      return [makeItem({ id: `${SLEEP_EXPERIENCE_PREFIX}${day.dateKey}:${event.id}`, source: 'assistant-schedule',
        title: 'I 的作息记录', summary: promptLine, promptLine, occurredAt: event.at,
        ...(event.kind === 'schedule' ? { affectResultAt: event.at } : {}),
        ...(event.turnId && !event.sessionId ? { nearStatusSelfResult: true } : {}),
        nearStatusRevision: JSON.stringify(event), assistantParticipated: true,
        fingerprintText: JSON.stringify(event), importance: 'medium', now, nearStatus: true })];
    });
    if (!day || !plan || !plan.revision || plan.scheduleChangedAt === undefined || plan.scheduleChangedAt > now) return [];
    if (plan.scheduleChangedAt > (options.sleepThrough ?? now)) return [];
    const context = { nightKey: day.dateKey, revision: plan.revision, requestAt: now,
      originalSleepAt: plan.originalSleepAt, originalWakeAt: plan.originalWakeAt,
      currentSleepAt: day.sleepTargetAt, currentWakeAt: sleepWakeTarget(plan, plan.actualSleepAt ?? day.sleepTargetAt) };
    const item = makeAssistantScheduleLifeMaterial({ id: `sleep:${day.dateKey}:${plan.revision}`,
      changedAt: plan.scheduleChangedAt,
      promptLine: `${formatNearStatusRecordedAt(plan.scheduleChangedAt)}\n${formatSleepSchedule(context)}` }, now);
    return !options.sleepRefs || options.sleepRefs.some(ref => ref.id === item.id) ? [item] : [];
  });
}

async function collectReading(now: number, nearStatus = false) {
  const snapshot = await loadReadingLifeMaterialSnapshot(now);
  const items: LifeMaterialItem[] = [];
  if (snapshot.progress) {
    const progress = snapshot.progress;
    const sourceSessions = nearStatus ? (await loadReadingSessions())
      .filter((session) => session.bookId === progress.bookId)
      .map((session) => [session.id, session.startedAt, session.endedAt, session.activeSeconds]) : undefined;
    const timeText = progress.dayAge === 0 && progress.todayActiveSeconds > 0
      ? `；今天有效阅读约 ${Math.max(1, Math.round(progress.todayActiveSeconds / 60))} 分钟`
      : '';
    items.push(makeItem({
      id: `reading-progress:${progress.bookId}`,
      importance: progress.importance,
      now,
      nearStatus,
      occurredAt: progress.lastActivityAt,
      source: 'co-reading',
      assistantParticipated: progress.sharedRecently,
      summary: `《${progress.title}》第 ${progress.chapterIndex + 1} / ${progress.totalChapters} 章，P${progress.paragraphIndex}${timeText}`,
      title: '共读进度',
      expiresAt: progress.expiresAt,
      fingerprintText: nearStatus
        ? JSON.stringify([progress.bookId, progress.title, progress.chapterIndex, progress.paragraphIndex, progress.totalChapters, progress.lastActivityAt, sourceSessions])
        : progress.fingerprintKey,
      promptLine: nearStatus ? formatNearStatusReadingProgress(progress) : formatCoReadingProgressPrompt(progress),
    }));
  }
  if (snapshot.result) {
    let result = snapshot.result;
    let affectResultAt: number | undefined;
    if (nearStatus) {
      // 旧选择器只保留短预览；按同一条有效记录重新读取全文，不改其它消费者。
      if (result.kind === 'summary' || result.kind === 'annotation') {
        const original = await loadReadingAnnotations(result.bookId, result.chapterIndex);
        const record = result.kind === 'summary'
          ? original.summaries.find((entry) => `summary:${entry.chapterIndex}:${entry.segmentIndex}` === result.id)
          : original.annotations.find((entry) => entry.id === result.id);
        if (!record) return items;
        affectResultAt = record.createdAt;
        result = { ...result, text: 'summary' in record ? record.summary : record.text, occurredAt: record.updatedAt ?? record.createdAt };
      } else {
        const original = (await loadReadingNotes(result.bookId)).find((entry) => entry.id === result.id);
        if (!original || original.kind !== result.kind) return items;
        result = { ...result, text: original.note, question: original.question, answer: original.answer, occurredAt: original.createdAt };
      }
      if (result.kind === 'question' ? !result.question?.trim() || !result.answer?.trim() : !result.text?.trim()) return items;
    }
    const resultText = result.kind === 'question'
      ? `问 I：${result.question}；回答：${result.answer}`
      : `${result.kind === 'summary' ? '读后感' : result.kind === 'annotation' ? '批注' : '我的笔记'}：${result.text}`;
    items.push(makeItem({
      id: `reading-result:${result.bookId}:${result.id}`,
      importance: 'medium',
      now,
      nearStatus,
      occurredAt: result.occurredAt,
      source: 'co-reading',
      assistantParticipated: result.kind !== 'my-note',
      affectResultAt,
      // A saved complete Q&A is a third-paper experience, not a new wants/affect trigger.
      nearStatusRevision: nearStatus && result.kind === 'question' ? `question:${result.occurredAt}` : undefined,
      summary: `《${result.title}》${resultText}`,
      title: '共读成果',
      expiresAt: result.expiresAt,
      fingerprintText: nearStatus ? JSON.stringify([result.id, result.title, result.occurredAt, result.kind, result.text, result.question, result.answer]) : result.fingerprintKey,
      promptLine: nearStatus ? formatNearStatusReadingResult(result) : formatCoReadingResultPrompt(result),
    }));
  }
  return items;
}

type FirstPaperVoyageWindow = { refs?: readonly { id: string; createdAt: number }[] };

async function collectWebVoyage(now: number, nearStatus = false, firstPaper?: FirstPaperVoyageWindow) {
  const logs = await loadWebVoyageLog();
  // Other consumers still show the latest per category. First-paper unread
  // filtering happens later, before capacity selection; do not hide older rows.
  const candidates = firstPaper?.refs ? logs.filter(entry => firstPaper.refs!.some(ref =>
    ref.id === `${entry.sourceType === 'github' ? 'github-voyage' : 'web-voyage'}:${entry.id}`)) : logs;
  const materials = firstPaper ? candidates.flatMap(entry =>
    selectWebVoyageLifeMaterials([entry], firstPaper.refs ? entry.at : now))
    : selectWebVoyageLifeMaterials(logs, now);
  return materials.map((material) => {
    const source: LifeMaterialSource = material.sourceType === 'github' ? 'github-voyage' : 'web-voyage';
    const original = logs.find((entry) => entry.id === material.id && (entry.sourceType === 'github' ? 'github-voyage' : 'web-voyage') === source);
    const fixed = firstPaper?.refs?.find(ref => ref.id === `${source}:${material.id}`);
    return makeItem({
      id: `${source}:${material.id}`,
      importance: nearStatus && original?.status === 'failed' ? 'medium' : material.importance,
      now,
      nearStatus,
      occurredAt: fixed?.createdAt ?? (firstPaper && original ? original.at : material.occurredAt),
      source,
      assistantParticipated: true,
      affectResultAt: original?.status === 'completed' ? original.at : undefined,
      summary: material.summary,
      title: source === 'github-voyage' ? 'GitHub 逛街' : '网页远游',
      // A frozen batch validates the original record, not its display age.
      expiresAt: firstPaper?.refs ? undefined : material.expiresAt,
      sourceVersion: original ? `web-source:${hashText(JSON.stringify([
        original.id, original.at, original.status, original.stage, original.sourceType, original.title,
        original.query, original.summary, original.detail, original.url, original.readingStatus,
      ]))}` : undefined,
      fullFingerprint: original?.readingStatus !== undefined,
      fingerprintText: nearStatus && original ? JSON.stringify([original.id, original.at, original.status, original.stage, original.title, original.query, original.summary, original.detail, original.shareStatus,
        ...(original.readingStatus === undefined ? [] : [original.readingStatus, original.sourceType, original.url])]) : material.fingerprintKey,
      promptLine: nearStatus && original ? formatNearStatusWebVoyage(original) : material.promptLine,
    });
  });
}

async function collectBrowser(now: number) {
  const records = await loadRecentBrowserRecords(4);
  const material = selectBrowserLifeMaterial(records, now);
  if (!material) return [];
  return [makeItem({
    id: `browser:${material.recordId}`,
    importance: material.importance,
    now,
    occurredAt: material.occurredAt,
    source: 'browser',
    summary: material.summary,
    title: '最近网页记录',
    expiresAt: material.expiresAt,
    fingerprintText: material.fingerprintKey,
    promptLine: material.promptLine,
  })];
}

async function collectToolAudit(now: number, nearStatus = false) {
  const records = await loadRecentToolCalls(50);
  return toolAuditLifeItems(records, now, nearStatus);
}

/** Recheck the saved receipt by ID, not its place in the latest-material tray. */
export async function loadReferencedToolLifeMaterial(callId: string): Promise<LifeMaterialItem | undefined> {
  const record = (await loadRecentToolCalls(200)).find(record => record.callId === callId);
  if (!record) return undefined;
  return toolAuditLifeItems([record], record.finishedAt ?? record.startedAt ?? record.createdAt, true)[0];
}

function toolAuditLifeItems(records: ToolLifeMaterialInput[], now: number, nearStatus: boolean) {
  const material = selectToolLifeMaterial(records, now);
  if (!material) return [];
  const original = nearStatus ? records.find((record) =>
    record.toolId === material.toolId
    && (record.finishedAt ?? record.startedAt ?? record.createdAt) === material.occurredAt
    && (record.status === 'success' || record.status === 'error')
    && selectToolLifeMaterial([record], now)?.fingerprintKey === material.fingerprintKey) : undefined;
  if (nearStatus && !original) return [];
  return [makeItem({
    id: `tool:${original?.callId ?? material.toolId}`,
    importance: material.importance,
    now,
    nearStatus,
    occurredAt: material.occurredAt,
    source: 'tool-audit',
    toolId: material.toolId,
    assistantParticipated: true,
    summary: material.summary,
    title: '工具结果',
    expiresAt: material.expiresAt,
    fingerprintText: original ? JSON.stringify([original.callId, original.status, original.resultSummary]) : material.fingerprintKey,
    promptLine: original ? `${formatNearStatusRecordedAt(material.occurredAt)}｜${material.toolLabel}\n结果：${original.resultSummary}` : material.promptLine,
  })];
}

async function collectPeriod(now: number, nearStatus = false, wantsFactsOnly = false) {
  const todayDateKey = getPeriodDateKey(now);
  const [summary, previousLog] = await Promise.all([
    loadPeriodSummary(),
    loadLatestDailyLogBefore(todayDateKey),
  ]);
  const material = selectPeriodLifeMaterial({
    currentDay: summary.currentPeriod
      ? getPeriodDurationDays(summary.currentPeriod)
      : null,
    daysUntilDue: summary.prediction?.daysUntilDue ?? null,
    isCurrent: Boolean(summary.currentPeriod),
    now,
    previousLog,
    todayDateKey,
    todayLog: summary.todayLog,
  });
  if (!material) return [];
  const prediction = material.id.startsWith('period:prediction:');
  const previous = material.id.startsWith('period:previous:');
  const sourceRecord = prediction ? summary.history : previous ? previousLog : [summary.currentPeriod, summary.todayLog, previousLog];
  let currentPromptLine = material.promptLine;
  if (nearStatus && !prediction && !previous) {
    const currentParts: string[] = [];
    if (summary.currentPeriod) currentParts.push(`经期第 ${Math.round(getPeriodDurationDays(summary.currentPeriod))} 天`);
    if (summary.todayLog?.dateKey === todayDateKey) {
      currentParts.push(...formatNearStatusPeriodLogParts(summary.todayLog, { today: true, includePeriodState: !summary.currentPeriod }));
    } else if (previousLog && material.summary.includes('昨天记录：')) {
      currentParts.push(`昨天记录：${formatNearStatusPeriodLogParts(previousLog).join('；')}`);
    }
    currentPromptLine = wantsFactsOnly ? `you 的身体记录：${currentParts.join('；')}。`
      : `小仓鼠身体记录：${currentParts.join('；')}。I 会留意这些具体感受，温柔照看小仓鼠。`;
  }
  const promptLine = !nearStatus ? material.promptLine : prediction
    ? '根据已有日期推算，you 最近可能接近经期。'
      + (wantsFactsOnly ? '' : '\nI 会留意 you 今天实际说出的感受，温柔照看 you。')
    : previous
      ? `you 昨天的身体记录：${previousLog ? formatNearStatusPeriodLogParts(previousLog).join('；') : ''}。`
        + (wantsFactsOnly ? '' : '\nI 今天会继续留意 you 有没有新的变化。')
      : currentPromptLine;
  return [makeItem({
    id: nearStatus && prediction ? `period:prediction:${summary.prediction?.estimatedStartAt}`
      : nearStatus && summary.currentPeriod ? `period:current:${summary.currentPeriod.id}` : material.id,
    importance: material.importance,
    now,
    nearStatus,
    occurredAt: material.occurredAt,
    source: 'period',
    summary: material.summary,
    title: '小仓鼠身体记录',
    expiresAt: material.expiresAt,
    fingerprintText: nearStatus ? JSON.stringify(sourceRecord) : material.fingerprintKey,
    promptLine,
  })];
}

async function collectBodySignal(now: number, nearStatus = false, wantsFactsOnly = false) {
  const snapshot = await loadBodySignalSnapshot(now);
  return bodySignalLifeItems(await withBodySignalReadingContext(snapshot, now), now, nearStatus, wantsFactsOnly);
}

async function collectWearableSleep(now: number) {
  const { loadBodySignalSleepAiMaterial } = await import('../bodySignal/bodySignalSleepAiMaterial');
  const material = await loadBodySignalSleepAiMaterial(now);
  return material ? [makeItem({
    id: material.id, source: 'body-signal', title: '睡眠记录', summary: material.text,
    occurredAt: material.occurredAt, expiresAt: material.expiresAt, importance: 'medium',
    now, nearStatus: true, fingerprintText: material.version, promptLine: material.text,
  })] : [];
}

async function collectWearableSteps(now: number) {
  const { loadBodySignalStepsAiMaterial } = await import('../bodySignal/bodySignalStepsAiMaterial');
  const material = await loadBodySignalStepsAiMaterial(now);
  return material ? [makeItem({
    id: material.id, source: 'body-signal', title: '步数记录', summary: material.text,
    occurredAt: material.occurredAt, expiresAt: material.expiresAt, importance: 'medium',
    now, nearStatus: true, fingerprintText: material.version, promptLine: material.text,
  })] : [];
}

async function withBodySignalReadingContext(input: BodySignalLifeMaterialInput, now: number): Promise<BodySignalLifeMaterialInput> {
  if (!input.heartRate || !selectBodySignalLifeMaterials(input, now).some(item => item.id.startsWith('body-signal:heart:'))) return input;
  return { ...input, heartRate: { ...input.heartRate, readingContext: await loadBodySignalReadingContext(input.heartRate) } };
}

function bodySignalLifeItems(snapshot: BodySignalLifeMaterialInput, now: number, nearStatus: boolean, wantsFactsOnly = false) {
  return selectBodySignalLifeMaterials(snapshot, now).map((material) => {
    const battery = material.id.includes(':battery:');
    const reading = battery ? snapshot.battery : snapshot.heartRate;
    const context = !battery && reading ? reading.readingContext ?? unknownBodySignalReadingContext(reading) : undefined;
    return makeItem({
      id: material.id,
      importance: material.importance,
      now,
      nearStatus,
      occurredAt: material.occurredAt,
      source: 'body-signal',
      summary: material.summary,
      title: material.id.includes(':battery:') ? '穿戴设备状态' : '身体现场信号',
      expiresAt: material.expiresAt,
      fingerprintText: nearStatus && reading
        ? JSON.stringify([reading.measuredAt, reading.value, reading.confidence,
          ...(context ? [reading.deviceProfileId, reading.sourceProvider, reading.sourceDeviceName, context.revision] : [])])
        : context ? JSON.stringify([material.fingerprintKey, reading?.deviceProfileId, context.revision]) : material.fingerprintKey,
      promptLine: nearStatus && reading ? formatNearStatusBodySignal(reading, battery, wantsFactsOnly)
        : context ? `${material.promptLine}\n${formatBodySignalReadingContext(context)}` : material.promptLine,
    });
  });
}

async function collectActiveMessages(now: number) {
  const snapshot = await loadActiveMessageCoordinatorSnapshot();
  const items: LifeMaterialItem[] = [];
  const last = snapshot.lastDecision;
  if (last && now - last.decidedAt <= RECENT_MS && last.allowed === false) {
    items.push(makeItem({
      id: `active-message:last-decision:${last.source}:${last.topicKey ?? 'none'}`,
      importance: last.source === 'web-voyage-share' ? 'high' : 'medium',
      now,
      occurredAt: last.decidedAt,
      source: 'active-message',
      summary: `${last.source} 主动消息暂时没有发出：${last.reason ?? '未说明原因'}`,
      title: '主动消息状态',
      fingerprintParts: [last.source, last.topicKey, last.reason, Math.floor(last.decidedAt / (10 * 60 * 1000))],
      promptLine: `主动消息状态：${last.source} 暂时没有发出（${last.reason ?? '未说明原因'}）。`,
    }));
  }
  const delivered = snapshot.records.slice().sort((left, right) => right.deliveredAt - left.deliveredAt)[0];
  if (delivered && now - delivered.deliveredAt <= FRESH_MS) {
    items.push(makeItem({
      id: `active-message:delivered:${delivered.source}:${delivered.topicKey ?? 'none'}`,
      importance: 'low',
      now,
      occurredAt: delivered.deliveredAt,
      source: 'active-message',
      summary: `${delivered.source} 刚刚发出过 ${delivered.messageCount} 条主动消息`,
      title: '主动消息状态',
      fingerprintParts: [delivered.source, delivered.topicKey, delivered.messageCount, Math.floor(delivered.deliveredAt / 60000)],
    }));
  }
  return items;
}

const FOCUS_SUMMARY_MATERIAL_PREFIX = 'focus-summary:';
export const isFocusSummaryLifeMaterialId = (id: string) => id.startsWith(FOCUS_SUMMARY_MATERIAL_PREFIX);

function makeFocusSummaryLifeMaterial(saved: NonNullable<Awaited<ReturnType<typeof loadFocusSummaryById>>>, now: number) {
  const { session, record } = saved;
  const promptLine = `共同专注｜已结束\n开始时间：${formatNearStatusRecordedAt(session.startedAt)}\n结束时间：${formatNearStatusRecordedAt(session.endedAt)}\nyou 的事项：${session.userActivity}\nI 的事项记录：${session.baiyunActivity}\n小结：${record.summary}`;
  return makeItem({ id: `${FOCUS_SUMMARY_MATERIAL_PREFIX}${session.id}`, source: 'focus', title: '共同专注',
    summary: record.summary, promptLine, occurredAt: session.endedAt, expiresAt: session.endedAt + RECENT_MS,
    sameSource: `focus:${session.id}`, importance: 'high', assistantParticipated: true, now, nearStatus: true,
    fingerprintText: JSON.stringify([session.id, session.startedAt, session.endedAt, session.userActivity, session.baiyunActivity, record.summary]) });
}

/** Re-read the scene already selected for contact, never substitute the latest scene. */
export async function loadReferencedFocusSummaryLifeMaterial(id: string, now = Date.now()): Promise<LifeMaterialItem | undefined> {
  if (!isFocusSummaryLifeMaterialId(id)) return undefined;
  const saved = await loadFocusSummaryById(id.slice(FOCUS_SUMMARY_MATERIAL_PREFIX.length), now);
  return saved ? makeFocusSummaryLifeMaterial(saved, now) : undefined;
}

async function collectFocus(now: number, nearStatus = false, includeCompleted = false, includeSummaries = false) {
  const focus = await loadActiveFocusSession(nearStatus);
  const items = focus ? [makeItem({
    id: `focus:${focus.startedAt}`,
    importance: 'high',
    now,
    nearStatus,
    occurredAt: focus.pausedAt ?? focus.startedAt,
    source: 'focus',
    assistantParticipated: Boolean(focus.baiyunActivity.trim()),
    nearStatusRevision: focus.mode === 'cowork' && focus.baiyunActivity.trim()
      ? hashText(JSON.stringify([focus.startedAt, focus.paused, focus.userActivity, focus.baiyunActivity])) : undefined,
    summary: `小仓鼠正在做：${focus.userActivity}；白云正在做：${focus.baiyunActivity}${focus.paused ? '；专注暂停中' : ''}`,
    title: '共同专注',
    fingerprintParts: [focus.startedAt, focus.userActivity, focus.baiyunActivity, focus.paused],
    promptLine: nearStatus ? formatNearStatusFocus(focus) : `共同专注：小仓鼠正在做 ${focus.userActivity}，I 正在做 ${focus.baiyunActivity}${focus.paused ? '，当前暂停中' : ''}。`,
  })] : [];
  if (includeCompleted) {
    for (const finished of (await loadRecentFocusSessions(12)).sort((a, b) => b.endedAt - a.endedAt)) {
      if (finished.mode !== 'cowork' || !finished.baiyunActivity.trim()
        || finished.endedAt <= finished.startedAt || finished.endedAt > now
        || now - finished.endedAt > RECENT_MS || items.some(item => item.id === `focus:${finished.startedAt}`)) continue;
      const promptLine = formatNearStatusFocus({ ...finished, paused: false });
      items.push(makeItem({ id: `focus:${finished.startedAt}`, source: 'focus', title: '共同专注',
        summary: promptLine, promptLine, occurredAt: finished.endedAt, expiresAt: finished.endedAt + RECENT_MS,
        assistantParticipated: true, nearStatusRevision: `ended:${finished.endedAt}`,
        importance: 'high', now, nearStatus: true }));
    }
  }
  if (includeSummaries) {
    const saved = await loadLatestFocusSummary(now);
    const sameActive = saved && focus && focus.startedAt === saved.session.startedAt && focus.mode === saved.session.mode
      && focus.userActivity.trim() === saved.session.userActivity;
    if (saved && !sameActive) items.push(makeFocusSummaryLifeMaterial(saved, now));
  }
  return items;
}

function collectAmbient(now: number) {
  const context = [getCachedAmbientContext({ categories: ['time', 'weather', 'schedule', 'todos'] }), getCachedSystemStatusAmbientContext()]
    .filter(Boolean)
    .join('\n');
  const clean = compactText(context.replace(/【[^】]+】/g, ''), 180);
  if (!clean) return [];
  return [makeItem({
    id: `ambient:${localDateKey(now)}`,
    importance: 'low',
    now,
    occurredAt: now,
    source: 'ambient',
    summary: clean,
    title: '当前环境',
    fingerprintText: getCachedAmbientLifeMaterialFingerprint(now),
  })];
}

async function collectSafely(
  source: LifeMaterialSource,
  dropped: string[],
  run: () => Promise<LifeMaterialItem[]> | LifeMaterialItem[],
) {
  try {
    return await run();
  } catch (error) {
    dropped.push(`${source}: 收集失败`);
    return [];
  }
}

export function formatLifeMaterialPrompt(snapshot: LifeMaterialSnapshot) {
  if (!snapshot.promptItems.length) return '';
  const lines = snapshot.promptItems
    .map((item) => `- [${item.source}/${item.freshness}/${item.importance}] ${item.promptLine}`);
  return [
    '【生活材料托盘】',
    '下面是各模块已经记录下来的近况。仅供自然参考；旧材料不能说成正在发生。',
    ...lines,
  ].join('\n');
}

export function shouldRegenerateForLifeMaterials(previousKey: string | undefined, next: LifeMaterialSnapshot) {
  if (!previousKey) return next.items.length > 0;
  return !previousKey.includes(next.fingerprint);
}

export async function buildLifeMaterialSnapshot(now = Date.now()): Promise<LifeMaterialSnapshot> {
  const dropped: string[] = [];
  const groups = await Promise.all([
    collectSafely('co-reading', dropped, () => collectReading(now)),
    collectSafely('web-voyage', dropped, () => collectWebVoyage(now)),
    collectSafely('browser', dropped, () => collectBrowser(now)),
    collectSafely('tool-audit', dropped, () => collectToolAudit(now)),
    collectSafely('period', dropped, () => collectPeriod(now)),
    collectSafely('body-signal', dropped, () => collectBodySignal(now)),
    collectSafely('active-message', dropped, () => collectActiveMessages(now)),
    collectSafely('focus', dropped, () => collectFocus(now)),
    collectSafely('ambient', dropped, () => collectAmbient(now)),
  ]);
  const items = groups
    .flat()
    .filter((item) => !item.expiresAt || item.expiresAt > now)
    .sort(sortItems)
    .slice(0, 24);
  const sourceCounts = items.reduce<Partial<Record<LifeMaterialSource, number>>>((counts, item) => ({
    ...counts,
    [item.source]: (counts[item.source] ?? 0) + 1,
  }), {});
  const promptItems = selectPromptItems(items);
  const snapshot: LifeMaterialSnapshot = {
    debug: { dropped: dropped.slice(0, MAX_DROPPED_DEBUG_ITEMS), sourceCounts },
    fingerprint: buildSnapshotFingerprint(promptItems),
    generatedAt: now,
    items,
    promptItems,
    promptContext: '',
  };
  return {
    ...snapshot,
    promptContext: formatLifeMaterialPrompt(snapshot),
  };
}

function collectNearStatusPhone(now: number) {
  const snapshot = getCachedSystemStatusAmbientSnapshot(now);
  if (!snapshot) return [];
  return [makeItem({
    id: 'ambient:phone',
    importance: 'low',
    now,
    nearStatus: true,
    occurredAt: snapshot.checkedAt,
    source: 'ambient',
    summary: '手机状态记录',
    title: '手机状态',
    // fetchedAt 和 stale 是缓存时效，不是新的设备记录。
    fingerprintText: JSON.stringify([snapshot.battery.percentage, snapshot.battery.level, snapshot.battery.state, snapshot.battery.isLowPowerModeEnabled, snapshot.appState]),
    promptLine: formatNearStatusPhone(snapshot),
  })];
}

function collectNearStatusAmbient(now: number, includeYouPlans = true) {
  const snapshot = getCachedAmbientSnapshot();
  if (!snapshot) return [];
  const items: LifeMaterialItem[] = [];
  const weather = snapshot.weather;
  if (weather && (weather.label || weather.placeLabel || typeof weather.temperature === 'number')) {
    const recordedAt = weather.observedAt;
    const temperature = typeof weather.temperature === 'number' ? ` ${weather.temperature}°C` : '';
    const lines = [
      ...(typeof recordedAt === 'number' ? [`天气记录：${formatNearStatusRecordedAt(recordedAt)}`] : []),
      ...(weather.placeLabel ? [`地点：${weather.placeLabel}`] : []),
      ...(weather.label || temperature ? [`天气：${weather.label}${temperature}${weather.error ? '（可能不准确）' : ''}。`] : []),
    ];
    items.push(makeItem({
      id: 'ambient:weather',
      importance: 'low', now, nearStatus: true, occurredAt: recordedAt ?? 0,
      source: 'ambient', title: '天气', summary: weather.label,
      fingerprintText: JSON.stringify([weather.placeLabel, weather.label, weather.temperature, weather.error]),
      promptLine: lines.join('\n'),
    }));
  }
  if (!includeYouPlans) return items;
  // 日期限定的缓存过夜后不把昨天事项写成今天；取材本身不触发刷新。
  const todayCache = localDateKey(snapshot.fetchedAt) === localDateKey(now);
  const schedule = todayCache ? snapshot.todaySchedule
    .filter((item) => item.status !== 'cancelled' && item.scheduledStartAt >= now - 15 * 60000)
    .slice(0, 5) : [];
  if (schedule.length) {
    const lines = schedule.map((item) => `${formatNearStatusRecordedAt(item.scheduledStartAt).slice(-5)} ${item.title}${item.notes ? `：${item.notes}` : ''}`);
    items.push(makeItem({
      id: `ambient:schedule:${schedule.map((item) => item.id).join('|')}`,
      importance: 'low', now, nearStatus: true, occurredAt: Math.max(...schedule.map((item) => item.scheduledStartAt)),
      source: 'ambient', title: 'you 的日程', summary: lines.join('\n'),
      fingerprintText: JSON.stringify(schedule.map((item) => [item.id, item.scheduledStartAt, item.title, item.notes, item.status])),
      promptLine: `you 今天的日程：\n${lines.join('\n')}`,
    }));
  }
  const candidates = [
    ...(todayCache ? snapshot.todayTodos.slice(0, 5) : []),
    ...snapshot.openTodos.filter((item) => item.status === 'inbox').slice(0, 5),
  ];
  const todos = candidates.filter((item, index) => item.type === 'normal'
    && (item.status === 'today' || item.status === 'inbox' || item.status === 'scheduled')
    && candidates.findIndex((candidate) => candidate.id === item.id) === index);
  if (todos.length) {
    const lines = todos.map((item) => item.title);
    items.push(makeItem({
      id: `ambient:todos:${todos.map((item) => item.id).join('|')}`,
      importance: 'low', now, nearStatus: true, occurredAt: Math.max(...todos.map((item) => item.updatedAt)),
      source: 'ambient', title: 'you 的待办', summary: lines.join('\n'),
      fingerprintText: JSON.stringify(todos.map((item) => [item.id, item.title, item.status, item.updatedAt])),
      promptLine: `you 的待办：\n${lines.join('\n')}`,
    }));
  }
  return items;
}

export async function buildNearStatusLifeMaterialSnapshot(
  now = Date.now(),
  options: { excludeIds?: readonly string[]; homeOnly?: boolean; nearStatusFocusSummaries?: boolean; includeAssistantSchedule?: boolean; excludeSharedExperience?: boolean; includeWearableSleep?: boolean; includeWearableSteps?: boolean; wantsFactsOnly?: boolean; firstPaperVoyages?: FirstPaperVoyageWindow } & SleepMaterialWindow = {},
): Promise<LifeMaterialSnapshot> {
  const dropped: string[] = [];
  const groups = await Promise.all([
    ...(options.excludeSharedExperience ? [] : [collectSafely('co-reading', dropped, () => collectReading(now, true))]),
    collectSafely('web-voyage', dropped, () => collectWebVoyage(now, true, options.firstPaperVoyages)),
    collectSafely('tool-audit', dropped, () => collectToolAudit(now, true)),
    ...(options.includeAssistantSchedule ? [collectSafely('assistant-schedule', dropped, () => collectAssistantSchedule(now, options))] : []),
    ...(options.homeOnly ? [] : [
      collectSafely('period', dropped, () => collectPeriod(now, true, options.wantsFactsOnly)),
      collectSafely('body-signal', dropped, () => collectBodySignal(now, true, options.wantsFactsOnly)),
      ...(options.includeWearableSleep ? [collectSafely('body-signal', dropped, () => collectWearableSleep(now))] : []),
      ...(options.includeWearableSteps ? [collectSafely('body-signal', dropped, () => collectWearableSteps(now))] : []),
    ]),
    ...(options.excludeSharedExperience ? [] : [collectSafely('focus', dropped, () => collectFocus(now, true, options.homeOnly, options.nearStatusFocusSummaries))]),
    collectSafely('ambient', dropped, () => collectNearStatusPhone(now)),
    collectSafely('ambient', dropped, () => collectNearStatusAmbient(now, !options.homeOnly)),
  ]);
  const items = groups.flat()
    .filter((item) => !item.expiresAt || item.expiresAt > now)
    .sort((left, right) => (options.homeOnly
      ? Number(Boolean(right.assistantParticipated)) - Number(Boolean(left.assistantParticipated)) : 0)
      || sortItems(left, right));
  const sourceCounts = items.reduce<Partial<Record<LifeMaterialSource, number>>>((counts, item) => ({
    ...counts,
    [item.source]: (counts[item.source] ?? 0) + 1,
  }), {});
  const promptItems = selectNearStatusLifeEntries(items, options.excludeIds);
  return {
    debug: { dropped: dropped.slice(0, MAX_DROPPED_DEBUG_ITEMS), sourceCounts },
    fingerprint: buildSnapshotFingerprint(promptItems),
    generatedAt: now,
    items,
    promptItems,
    promptContext: formatNearStatusLifeEntries(promptItems),
  };
}

// Validate what was read, not whether a dated observation is still the latest.
// Editable business records retain the existing exact-version check.
export async function nearStatusLifeSourcesMatch(
  refs: readonly { id: string; createdAt: number; revision: string }[],
  items: readonly LifeMaterialItem[],
  dropped: readonly string[] = [],
): Promise<boolean> {
  for (const ref of refs) {
    const current = items.find(item => item.id === ref.id);
    // A partial snapshot cannot prove deletion. Keep the original paid batch for a later read.
    if (!current && dropped.some(reason => reason.endsWith(': 收集失败'))) throw new Error('life-material-source-unavailable');
    if (ref.id.startsWith('assistant-schedule:sleep') && sleepMaterialNightKey(ref.id)) {
      const original = await collectAssistantSchedule(Date.now(), { sleepRefs: [ref] });
      if (!original.some(item => item.id === ref.id && item.fingerprint === ref.revision)) return false;
    } else if (ref.id === 'ambient:phone' || ref.id === 'ambient:weather') {
      if (!current || !Number.isFinite(ref.createdAt) || !Number.isFinite(current.occurredAt)
        || current.occurredAt < ref.createdAt) return false;
      if (ref.createdAt > 0 && current.occurredAt > ref.createdAt) continue;
      if (current.fingerprint !== ref.revision) return false;
    } else if (/^body-signal:(heart|battery):/.test(ref.id)) {
      const battery = ref.id.startsWith('body-signal:battery:');
      if (battery && current?.occurredAt === ref.createdAt && current.fingerprint === ref.revision) continue;
      const { loadBodySignalReadingsAt } = await import('../bodySignal/bodySignalStore');
      const readings = await loadBodySignalReadingsAt(battery ? 'battery' : 'heart_rate', ref.createdAt);
      // The original reading may have aged out of the latest-material window.
      // Rebuild only its version, at its original time; never replace model input.
      let matches = false;
      for (const reading of readings) {
        const original = await withBodySignalReadingContext(battery ? { battery: reading } : { heartRate: reading }, ref.createdAt);
        if (bodySignalLifeItems(original, ref.createdAt, true).some(item => item.id === ref.id && item.fingerprint === ref.revision)) {
          matches = true;
          break;
        }
      }
      if (!matches) return false;
    } else if (ref.id.startsWith('web-voyage:') || ref.id.startsWith('github-voyage:')) {
      if (!current?.sourceVersion || current.sourceVersion !== ref.revision) return false;
    } else if (!current || current.fingerprint !== ref.revision) return false;
  }
  return true;
}
