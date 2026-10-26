import { assistantLifeStateStorageBridge as AsyncStorage } from '../sync/syncAssistantLifeStateStorageBridge';

import { loadActiveFocusSession, type ActiveFocusSession } from '../focus/focusStore';
import {
  buildChatMemoryBundle,
  type MemoryBundle,
  type MemoryBundleDebug,
  type MemoryBundleStage,
} from '../memory/memoryOrchestrator';
import type { MemoryRecallRoute } from '../memory/memoryRecallRouter';
import type { MemoryRecallWorkReporter } from '../memory/memoryChatPreparation';
import type { MemoryRecallItem } from '../memory/memoryStore';
import { createMemoryMaterialPreparation, type MemoryMaterialPreparation, type MemoryUsageReference } from '../memory/memoryCurrentMaterials';
import { isMemoryDatabaseBusy } from '../memory/memoryDatabaseWrites';
import type { PostRecallReference } from '../posts/baiyunPostKnown';
import { buildNearbyWorldContext } from '../nearby/nearbyWorldContext';
import { loadPeriodStatusForContext, type PeriodContextStatus } from '../period/periodStore';
import {
  buildAmbientContext,
  getCachedAmbientContext,
  type AmbientContextCategory,
} from './ambientContext';
import { buildBodySignalAmbientContext } from './bodySignalAmbientContext';
import { observeRuntimeWorkload } from '../runtime/runtimeWorkloadDiagnostics';

export type GlobalCognitionSource = 'chat' | 'focus' | 'proactive' | 'letter' | 'schedule' | 'life';

export type GlobalInteractionState = {
  lastInteractionAt: number;
  source: GlobalCognitionSource;
};

export type GlobalCognitionContext = {
  memoryUsageReferences?: MemoryUsageReference[];
  refreshMemoryMaterials?: MemoryBundle['refreshMemoryMaterials'];
  visibleMemoryIds?: Set<string>;
  activeFocus: ActiveFocusSession | null;
  lastInteractionAt: number | null;
  memoryContext: string;
  postContext?: string;
  postReference?: PostRecallReference;
  memoryDebug?: MemoryBundleDebug;
  memoryItems: MemoryRecallItem[];
  memoryMentionItems?: import('../memory/memoryReadReference').MemoryReadReference[];
  runtimeContext: string;
};

export type GlobalCognitionOptions = {
  memoryWorkReporter?: MemoryRecallWorkReporter;
  allowRerank?: boolean;
  materialPreparation?: MemoryMaterialPreparation;
  readOnly?: boolean;
  allowNetwork?: boolean;
  ambientCacheOnly?: boolean;
  ambientCategories?: AmbientContextCategory[];
  ambientIncludeUnavailable?: AmbientContextCategory[];
  backupRestoreLeaseHeld?: boolean;
  diagnosticParentToken?: number;
  includeMemory?: boolean;
  includeNearbyWorld?: boolean;
  memoryRoute?: MemoryRecallRoute | null;
  numberMemories?: boolean;
  refreshAmbient?: boolean;
  signal?: AbortSignal;
  touchMemory?: boolean;
  useSemanticMemory?: boolean;
  onStage?: (stage: GlobalCognitionStage) => void;
  throwOnMemoryError?: boolean;
};

/** The chat caller can await memory without waiting for unrelated environment data. */
export async function buildGlobalMemoryBundle(query: string, source: GlobalCognitionSource, options: GlobalCognitionOptions = {}) {
  throwIfGlobalCognitionAborted(options.signal);
  const materialPreparation = options.materialPreparation ?? createMemoryMaterialPreparation({
    signal: options.signal, includeSources: options.memoryRoute?.mode === 'detail_recall',
  });
  let focus: ActiveFocusSession | null = null;
  let focusFailure: 'focus_database_busy' | 'focus_read_failed' | undefined;
  try { focus = await loadActiveFocusSession(options.readOnly); }
  catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    focusFailure = isMemoryDatabaseBusy(error) ? 'focus_database_busy' : 'focus_read_failed';
  }
  throwIfGlobalCognitionAborted(options.signal);
  materialPreparation.assertCurrent(options.signal);
  const routeHints = options.memoryRoute
    ? [options.memoryRoute.topic, ...options.memoryRoute.keywords].filter(Boolean).join(' ') : '';
  const bundle = await buildChatMemoryBundle({
    userText: query.trim(),
    sourceHints: [SOURCE_MEMORY_HINTS[source], routeHints].filter(Boolean).join(' '),
    activeContext: focus?.userActivity ?? '',
    recallMode: options.memoryRoute?.mode,
  }, {
    materialPreparation, memoryRoute: options.memoryRoute, memoryWorkReporter: options.memoryWorkReporter,
    source, readOnly: options.readOnly, signal: options.signal, touch: false,
    numberMemories: options.numberMemories, useSemanticMemory: options.useSemanticMemory, allowRerank: options.allowRerank,
    throwOnError: options.throwOnMemoryError,
    onStage: stage => options.onStage?.(`memory:${stage}`),
  });
  if (focusFailure) bundle.debug.auxiliaryFailures = [focusFailure, ...(bundle.debug.auxiliaryFailures ?? [])];
  return bundle;
}

const MEMORY_TIME_CONTEXT = `【记忆里的时间】

每条记忆都属于它标注的日期，只说明那时发生过什么。此刻的情况以当前状态和近期对话为准。`;

export function attachGlobalMemoryBundle(cognition: GlobalCognitionContext, bundle: MemoryBundle) {
  const environment = cognition.runtimeContext.replace(MEMORY_TIME_CONTEXT, '').trim();
  const apply = () => {
    cognition.memoryContext = bundle.context;
    cognition.memoryItems = bundle.recallItems;
    cognition.memoryMentionItems = bundle.memoryMentionItems;
    cognition.memoryUsageReferences = bundle.memoryUsageReferences;
    cognition.postContext = bundle.postContext;
    cognition.postReference = bundle.postReference;
    cognition.visibleMemoryIds = bundle.visibleMemoryIds;
    cognition.memoryDebug = { ...cognition.memoryDebug, ...bundle.debug,
      counts: { ...cognition.memoryDebug?.counts, ...bundle.debug.counts } };
    cognition.runtimeContext = [environment, bundle.context.trim() ? MEMORY_TIME_CONTEXT : ''].filter(Boolean).join('\n\n');
  };
  apply();
  cognition.refreshMemoryMaterials = bundle.refreshMemoryMaterials ? async additionalMemories => {
    await bundle.refreshMemoryMaterials!(additionalMemories);
    apply();
  } : undefined;
  return cognition;
}

function throwIfGlobalCognitionAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  throw Object.assign(new Error('global-cognition-cancelled'), { name: 'AbortError' });
}

export type GlobalCognitionStage =
  | 'active_focus_ready'
  | 'ambient_ready'
  | 'body_signal_ready'
  | 'focus_context_ready'
  | 'interaction_ready'
  | 'memory_ready'
  | 'nearby_world_ready'
  | 'period_ready'
  | `memory:${MemoryBundleStage}`;

const INTERACTION_STATE_KEY = 'junluo.globalCognition.lastInteraction';
let interactionWriteQueue = Promise.resolve<GlobalInteractionState | null>(null);

const SOURCE_MEMORY_HINTS: Record<GlobalCognitionSource, string> = {
  chat: '最近近况 重要经历 偏好 约定 边界 相处',
  focus: '专注 学习 工作 任务习惯 鼓励方式 约定 身体情绪',
  proactive: '最近近况 重要事件 当前任务 日程 约定 身体情绪',
  letter: '长期关系 重要经历 约定 边界 近期生活',
  schedule: '日程 任务 执行习惯 提醒偏好 身体情绪',
  life: '最近近况 重要事件 身体 情绪 项目 约定',
};

function normalizeInteractionState(value: unknown): GlobalInteractionState | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<GlobalInteractionState>;
  if (
    typeof candidate.lastInteractionAt !== 'number'
    || !Number.isFinite(candidate.lastInteractionAt)
    || !candidate.source
    || !(candidate.source in SOURCE_MEMORY_HINTS)
  ) return null;
  return {
    lastInteractionAt: candidate.lastInteractionAt,
    source: candidate.source,
  };
}

export async function loadGlobalInteraction() {
  const raw = await AsyncStorage.getItem(INTERACTION_STATE_KEY);
  if (!raw) return null;
  try {
    return normalizeInteractionState(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

export async function recordGlobalInteraction(source: GlobalCognitionSource, occurredAt = Date.now()) {
  interactionWriteQueue = interactionWriteQueue
    .catch(() => null)
    .then(async () => {
      const current = await loadGlobalInteraction();
      if (current && current.lastInteractionAt > occurredAt) return current;
      const next = { lastInteractionAt: occurredAt, source };
      await AsyncStorage.setItem(INTERACTION_STATE_KEY, JSON.stringify(next));
      return next;
    });
  return interactionWriteQueue;
}

function formatActiveFocus(activeFocus: ActiveFocusSession) {
  const recentConversation = activeFocus.logs
    .filter((log) => log.role !== 'system')
    .slice(-6)
    .map((log) => `${log.role}: ${log.content}`)
    .join('\n');
  return `【I 和 you 正在共同专注】

you 正在做：${activeFocus.userActivity}
I 正在做：${activeFocus.baiyunActivity}
专注方式：${activeFocus.mode === 'cowork' ? '各忙各的赛博搭子' : '陪伴专注'}
状态：${activeFocus.paused ? '暂时暂停' : '正在进行'}
${recentConversation ? `\n最近的互动：\n${recentConversation}` : ''}`;
}

async function buildRecentFocusContext(activeFocus: ActiveFocusSession | null) {
  if (activeFocus) return formatActiveFocus(activeFocus);
  return '';
}

function formatPeriodContext(status: PeriodContextStatus | null) {
  if (!status) return '';
  const flowLabels: Record<NonNullable<PeriodContextStatus['flow']>, string> = {
    heavy: '多',
    light: '少',
    medium: '中',
    none: '无',
    spotting: '点滴',
  };
  const lines: string[] = [];
  if (status.isCurrent && status.currentDay) {
    lines.push(`今天是 you 经期的第 ${status.currentDay} 天。`);
  } else if (status.isDueSoon && status.daysUntilDue !== null) {
    if (status.daysUntilDue >= 0) lines.push('按已有记录，you 最近可能接近经期。');
    else lines.push('按已有记录，you 最近仍可能处在经期前后的变化中。');
  }
  if (status.bodyState === 'uncertain') {
    lines.push('you 今天记录了身体不舒服，但还没有确认经期开始。');
  }
  if (status.note.trim()) lines.push(`you 今天写下：${status.note.trim()}`);
  const bodyParts = [
    status.painLevel !== null ? `疼痛 ${status.painLevel}/5` : '',
    status.flow ? `流量 ${flowLabels[status.flow]}` : '',
    status.symptoms.length ? `症状：${status.symptoms.join('、')}` : '',
  ].filter(Boolean);
  if (bodyParts.length) lines.push(`今天的记录：${bodyParts.join('；')}。`);
  if (!lines.length) return '';
  return `【you 最近保存的经期状态】\n\n${lines.join('\n')}`;
}

export async function buildGlobalCognitionContext(
  query: string,
  source: GlobalCognitionSource,
  options: GlobalCognitionOptions = {},
): Promise<GlobalCognitionContext> {
  throwIfGlobalCognitionAborted(options.signal);
  const activeFocus = await loadActiveFocusSession(options.readOnly).catch(() => null);
  throwIfGlobalCognitionAborted(options.signal);
  options.onStage?.('active_focus_ready');
  const routeHints = options.memoryRoute
    ? [options.memoryRoute.topic, ...options.memoryRoute.keywords].filter(Boolean).join(' ')
    : '';
  const memoryQuery = {
    userText: query.trim(),
    sourceHints: [SOURCE_MEMORY_HINTS[source], routeHints].filter(Boolean).join(' '),
    activeContext: activeFocus?.userActivity ?? '',
    recallMode: options.memoryRoute?.mode,
  };
  const emptyMemoryBundle = {
    memoryMentionItems: [], careItems: [], currentStateItems: [],
    anchorItems: [],
    context: '',
    postContext: undefined,
    postReference: undefined,
    debug: { counts: {}, dropped: [] },
    recallItems: [],
    reflectionItems: [],
  };
  const memoryPromise = options.includeMemory === false
    ? Promise.resolve(emptyMemoryBundle).then((value) => {
        options.onStage?.('memory_ready');
        return value;
      })
    : observeRuntimeWorkload(
        'cognition.memory',
        (span) => buildChatMemoryBundle(memoryQuery, {
          materialPreparation: options.materialPreparation,
          diagnosticParentToken: span?.token,
          memoryRoute: options.memoryRoute,
          numberMemories: options.numberMemories,
          source,
          readOnly: options.readOnly,
          touch: options.readOnly ? false : options.touchMemory ?? source !== 'life',
          onStage: (stage) => options.onStage?.(`memory:${stage}`),
          signal: options.signal,
          allowRerank: options.allowRerank,
          useSemanticMemory: !options.readOnly && options.useSemanticMemory !== false,
        })
          .catch(() => emptyMemoryBundle)
          .then((value) => {
            options.onStage?.('memory_ready');
            return value;
          }),
        (value) => ({
          memoryCount: value.anchorItems.length + value.recallItems.length + value.reflectionItems.length,
        }),
        { parentToken: options.diagnosticParentToken },
      );
  const ambientPromise = observeRuntimeWorkload(
    'cognition.ambient',
    (span) => (options.readOnly || options.ambientCacheOnly
      ? Promise.resolve(getCachedAmbientContext({
        categories: options.ambientCategories,
        includeUnavailable: options.ambientIncludeUnavailable,
      }))
      : buildAmbientContext({
        allowNetwork: options.allowNetwork !== false,
        backupRestoreLeaseHeld: options.backupRestoreLeaseHeld,
        categories: options.ambientCategories,
        diagnosticParentToken: span?.token,
        forceRefresh: options.refreshAmbient,
        includeUnavailable: options.ambientIncludeUnavailable,
      }).catch(() => getCachedAmbientContext({
        categories: options.ambientCategories,
        includeUnavailable: options.ambientIncludeUnavailable,
      })))
      .then((value) => {
        options.onStage?.('ambient_ready');
        return value;
      }),
    undefined,
    { parentToken: options.diagnosticParentToken },
  );
  const emptyNearbyWorld = {
    context: '',
    debug: {
      available: false,
      enabled: false,
      hasAmapKey: false,
      permissionStatus: 'unknown',
      poiCount: 0,
      precisionMode: 'off',
      stale: false,
    },
    status: {
      available: false,
      enabled: false,
      hasAmapKey: false,
      nearbyReferences: [],
      poiCount: 0,
      precisionMode: 'off',
      presence: 'unknown' as const,
      stale: false,
    },
  };
  const nearbyWorldPromise = options.includeNearbyWorld === false
    ? Promise.resolve(emptyNearbyWorld).then((value) => {
        options.onStage?.('nearby_world_ready');
        return value;
      })
    : observeRuntimeWorkload(
        'cognition.nearby_world',
        () => buildNearbyWorldContext({
          allowRefresh: !options.readOnly && source === 'chat' && options.allowNetwork !== false,
          allowStale: source !== 'chat',
          intent: source === 'chat' ? 'auto' : 'proactive',
          readOnly: options.readOnly,
        })
      .catch(() => ({
        context: '',
        debug: {
          available: false,
          enabled: false,
          hasAmapKey: false,
          permissionStatus: 'unknown',
          poiCount: 0,
          precisionMode: 'off',
          stale: false,
        },
        status: {
          available: false,
          enabled: false,
          hasAmapKey: false,
          nearbyReferences: [],
          poiCount: 0,
          precisionMode: 'off',
          presence: 'unknown' as const,
          stale: false,
        },
      }))
          .then((value) => {
            options.onStage?.('nearby_world_ready');
            return value;
          }),
        (value) => ({ itemCount: value.status.poiCount }),
        { parentToken: options.diagnosticParentToken },
      );
  const lightweightPromise = observeRuntimeWorkload(
    'cognition.lightweight',
    () => Promise.all([
      loadGlobalInteraction()
        .catch(() => null)
        .then((value) => {
          options.onStage?.('interaction_ready');
          return value;
        }),
      buildRecentFocusContext(activeFocus).then((value) => {
        options.onStage?.('focus_context_ready');
        return value;
      }),
      (source === 'chat' ? loadPeriodStatusForContext().then(formatPeriodContext).catch(() => '') : Promise.resolve(''))
        .then((value) => {
          options.onStage?.('period_ready');
          return value;
        }),
      source === 'chat' || source === 'proactive'
        ? buildBodySignalAmbientContext(Date.now(), { includeWearableSleep: source === 'chat', includeWearableSteps: source === 'chat' }).then((value) => {
            options.onStage?.('body_signal_ready');
            return value;
          })
        : Promise.resolve('').then((value) => {
            options.onStage?.('body_signal_ready');
            return value;
          }),
    ]),
    undefined,
    { parentToken: options.diagnosticParentToken },
  );
  const [memoryBundle, ambientContext, nearbyWorld, lightweight] = await Promise.all([
    memoryPromise,
    ambientPromise,
    nearbyWorldPromise,
    lightweightPromise,
  ]);
  throwIfGlobalCognitionAborted(options.signal);
  const [interaction, focusContext, periodContext, bodySignalContext] = lightweight;
  const memoryDebug = withNearbyWorldDebug(memoryBundle.debug, nearbyWorld.debug);
  const effectiveAmbientContext = nearbyWorld.status.available
    ? stripAmbientLocationLine(ambientContext)
    : ambientContext;
  const cognition: GlobalCognitionContext = {
    activeFocus,
    lastInteractionAt: interaction?.lastInteractionAt ?? null,
    memoryContext: memoryBundle.context,
    postContext: memoryBundle.postContext,
    postReference: memoryBundle.postReference,
    memoryDebug,
    memoryItems: memoryBundle.recallItems,
    memoryMentionItems: 'memoryMentionItems' in memoryBundle ? memoryBundle.memoryMentionItems : [],
    runtimeContext: [
      nearbyWorld.context,
      effectiveAmbientContext,
      focusContext,
      periodContext,
      bodySignalContext,
    ].filter(Boolean).join('\n\n'),
  };
  return attachGlobalMemoryBundle(cognition, memoryBundle);
}

function withNearbyWorldDebug(
  debug: MemoryBundleDebug,
  nearby: {
    enabled: boolean;
    available: boolean;
    backgroundProfile?: string;
    gpsQuality?: string;
    stale: boolean;
    poiCount: number;
    hasAmapKey: boolean;
    precisionMode: string;
  },
): MemoryBundleDebug {
  if (!nearby.enabled) return debug;
  return {
    ...debug,
    counts: {
      ...debug.counts,
      nearbyWorld: nearby.available ? 1 : 0,
      nearbyWorldPois: nearby.poiCount,
      ...(nearby.precisionMode === 'walking' ? { nearbyWorldWalking: 1 } : {}),
      ...(nearby.precisionMode === 'transit' ? { nearbyWorldTransit: 1 } : {}),
      ...(nearby.gpsQuality === 'excellent' ? { nearbyWorldGpsExcellent: 1 } : {}),
      ...(nearby.gpsQuality === 'good' ? { nearbyWorldGpsGood: 1 } : {}),
      ...(nearby.gpsQuality === 'fair' ? { nearbyWorldGpsFair: 1 } : {}),
      ...(nearby.gpsQuality === 'poor' ? { nearbyWorldGpsPoor: 1 } : {}),
      ...(nearby.backgroundProfile === 'precision' ? { nearbyWorldBackgroundPrecision: 1 } : {}),
      ...(nearby.stale ? { nearbyWorldStale: 1 } : {}),
      ...(!nearby.hasAmapKey ? { nearbyWorldNoKey: 1 } : {}),
    },
  };
}

function stripAmbientLocationLine(context: string) {
  if (!context.includes('位置：')) return context;
  return context
    .split('\n')
    .filter((line) => !line.trim().startsWith('位置：'))
    .join('\n')
    .replace(/^【当前环境】\s*$/m, '')
    .trim();
}

export function shouldSuppressOrdinaryProactive(context: Pick<GlobalCognitionContext, 'activeFocus'>) {
  return context.activeFocus !== null;
}
