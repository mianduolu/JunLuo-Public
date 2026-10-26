import { Platform } from 'react-native';
import { isAutomaticRemoteAiAllowed, loadAutomaticRemoteAiPolicy } from '../runtime/automaticRemoteAiPolicy';
import {
  EARLY_MORNING_STATE_DRAFT,
  loadAssistantState,
  saveAssistantState,
  type AssistantLifeMode,
  type AssistantState,
  type AssistantStateDraft,
} from './assistantState';
import {
  ensureAssistantLifeDay,
  getActiveLifeDeviations,
  getLocalDateKey,
  getLifeScheduleSlot,
  getSegmentDeviation,
  loadAssistantLifeDay,
  resolveAssistantLifeSegment,
  type AssistantLifeDay,
  type AssistantLifeSegment,
} from './assistantLifeTimeline';
import { runAssistantNearStatusUpdate } from './assistantNearStatusRuntime';
import { runAssistantAffectUpdate } from './assistantAffectRuntime';
import { runAssistantInnerStateUpdate } from './assistantInnerStateRuntime';
import { initializeInnerUpdateBookmark, initializeAffectBookmark, initializeSharedExperienceBookmark } from '../chat/chatAfterglowState';
import { defaultAiProfile, type AiConnection, type AiProfile } from './types';
import { applySleepWakeOverride, runRhythmTick } from '../life/lifeRhythm';
import { isNightWakeDecisionPending, nightSleepPhaseAt, sleepWakeTarget } from '../life/sleepPlanPolicy';
import { readRelevantSleepNight, recordSleepPokeAwake } from '../life/sleepPlanStore';
import {
  captureBackupRestoreDataEpoch,
  canCommitBackupRestoreDataEpoch,
  runBackupRestoreDataEpochCommit,
} from '../backup/backupRestoreCoordinator';
import { observeRuntimeWorkload } from '../runtime/runtimeWorkloadDiagnostics';

type ScheduledState = AssistantStateDraft & {
  lifeMode: AssistantLifeMode;
  scheduleSlot: string;
  sourceType: 'self-schedule' | 'sleep';
};

type RefreshOptions = {
  skipNearStatus?: boolean;
  sleepOpportunityChecked?: boolean;
  afterSleepPlanChange?: boolean;
  apiKey?: string;
  backupRestoreLeaseHeld?: boolean;
  connection?: AiConnection;
  dataEpoch?: number | null;
  diagnosticParentToken?: number;
  now?: number;
  profile?: AiProfile;
};

let pendingRefresh: Promise<AssistantState> | undefined;
let pendingRefreshLeaseHeld = false;
let pendingSleepOpportunityCheck: Promise<boolean> | undefined;
const MANUAL_WAKE_IDLE_MS = 15 * 60 * 1000;

function buildLocalScheduledState(day: AssistantLifeDay, now: number,
  segment = resolveAssistantLifeSegment(day, now)): ScheduledState {
  return {
    ...segment.defaultDraft,
    lifeMode: segment.lifeMode,
    scheduleSlot: getLifeScheduleSlot(day, segment, false),
    sourceType: segment.lifeMode === 'sleeping' ? 'sleep' : 'self-schedule',
  };
}

function describeSegment(day: AssistantLifeDay, now: number, segment = resolveAssistantLifeSegment(day, now)) {
  const deviation = getSegmentDeviation(day, segment);
  const activeDeviations = getActiveLifeDeviations(day, now);
  const timeRange = `${new Date(segment.startAt).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })}-${new Date(segment.endAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}`;
  return {
    deviation,
    segment,
    text: [
      `${segment.label} ${timeRange}`,
      `生活模式：${segment.lifeMode}`,
      `基础活动：${segment.activityKind}`,
      `今天主题：${day.dailyFocus ?? '平常生活'}`,
      `当前位置：${segment.place ?? '自己的小角落'}`,
      activeDeviations.length
        ? `今天的小偏移：${activeDeviations.map((item) => `${item.type}，${item.description}`).join('；')}`
        : '今天这一段按平常节奏进行。',
    ].join('；'),
  };
}

async function performRefresh({
  skipNearStatus,
  apiKey,
  backupRestoreLeaseHeld,
  connection,
  dataEpoch,
  diagnosticParentToken,
  now = Date.now(),
  profile = defaultAiProfile,
}: RefreshOptions) {
  const resolvedDataEpoch = dataEpoch === undefined
    ? captureBackupRestoreDataEpoch()
    : dataEpoch;
  if (Platform.OS === 'android') {
    await initializeInnerUpdateBookmark(now, resolvedDataEpoch);
    await initializeAffectBookmark(now, resolvedDataEpoch);
    await initializeSharedExperienceBookmark(now, resolvedDataEpoch);
  }
  let currentState = await loadAssistantState();
  if (currentState.manualWakeUntil && currentState.manualWakeUntil <= now) {
    await runBackupRestoreDataEpochCommit(resolvedDataEpoch, () => runRhythmTick({ now, manualWakeUntil: currentState.manualWakeUntil,
      manualOverrideStartedAt: currentState.manualWakeUntil! - MANUAL_WAKE_IDLE_MS }));
  }
  let day = await ensureAssistantLifeDay(now);
  const previousDay = await loadAssistantLifeDay(getLocalDateKey(new Date(now - 24 * 60 * 60 * 1000)));
  if (previousDay?.sleepTargetAt && (previousDay.sleepTargetAt > now || isNightWakeDecisionPending(previousDay, now))) day = previousDay;
  const canGenerate = Platform.OS === 'android' && !!connection && !!apiKey?.trim()
    && isAutomaticRemoteAiAllowed(await loadAutomaticRemoteAiPolicy());
  const sleepNight = await readRelevantSleepNight(now);
  const actualPhase = sleepNight && nightSleepPhaseAt(sleepNight, now);
  const plan = sleepNight?.nightSleepPlan;
  const lyingAwake = actualPhase === 'awake' && plan?.morningAwakeAt !== undefined && plan.morningAwakeAt <= now && plan.actualWakeAt === undefined;
  const scheduledSegment = resolveAssistantLifeSegment(day, now);
  const segment: AssistantLifeSegment = lyingAwake ? {
    ...(day.segments.find(item => item.id === 'early-morning') ?? scheduledSegment),
    id: 'early-morning', label: '早晨', lifeMode: 'available', activityKind: 'wake-up',
    defaultDraft: EARLY_MORNING_STATE_DRAFT, deviationId: undefined,
    startAt: plan.morningAwakeAt!, endAt: sleepWakeTarget(plan, plan.actualSleepAt ?? sleepNight!.sleepTargetAt),
  } : scheduledSegment;
  const segmentInfo = describeSegment(day, now, segment);
  const localState = buildLocalScheduledState(day, now, segment);
  if (lyingAwake) localState.scheduleSlot += ':morning-awake';
  const alreadyReturned = sleepNight?.nightSleepPlan?.events?.some(event => event.kind === 'sleep_return'
    && event.at >= (currentState.manualWakeUntil ?? 0) - MANUAL_WAKE_IDLE_MS && event.at <= now);
  const manualWakeActive = typeof currentState.manualWakeUntil === 'number' && currentState.manualWakeUntil > now && !alreadyReturned;
  const manualSleepActive = typeof currentState.manualSleepUntil === 'number' && currentState.manualSleepUntil > now;
  const targetLifeMode: AssistantLifeMode = manualWakeActive ? 'available' : manualSleepActive ? 'sleeping'
    : actualPhase === 'awake' ? localState.lifeMode === 'sleeping' ? 'available' : localState.lifeMode
      : actualPhase === 'sleeping' ? 'sleeping' : localState.lifeMode;
  // Updating the real mode must not replace a previously saved near-status with a local draft.
  if (currentState.lifeMode !== targetLifeMode || currentState.scheduleSlot !== localState.scheduleSlot) {
    const sleepChanged = (currentState.lifeMode === 'sleeping') !== (targetLifeMode === 'sleeping');
    const gotUp = currentState.scheduleSlot?.endsWith(':morning-awake') && !lyingAwake;
    const saved = await runBackupRestoreDataEpochCommit(resolvedDataEpoch, () => saveAssistantState(currentState, {
      ...currentState, lifeMode: targetLifeMode, lifeContext: segmentInfo.text, scheduleSlot: localState.scheduleSlot,
      invalidateTextTimestamp: sleepChanged || gotUp,
      sleepNearStatus: sleepChanged && targetLifeMode === 'sleeping' ? undefined : currentState.sleepNearStatus,
    }));
    if (saved.committed) currentState = saved.value;
  }
  await (await import('../life/junluoDesireRuntime')).refreshJunluoDesireClock(now);
  await (await import('../life/junluoDesireRuntime')).initializeJunluoYouMessageClock();
  if (!canGenerate || !canCommitBackupRestoreDataEpoch(resolvedDataEpoch)) return currentState;

  if (!skipNearStatus) {
    if (currentState.lifeMode === 'sleeping') {
      await runAssistantNearStatusUpdate({ apiKey: apiKey!.trim(), connection: connection!, profile,
        now, dataEpoch: resolvedDataEpoch, currentState, transitionOnly: true }).catch(() => undefined);
      await (await import('../life/sleepNearStatusRuntime')).runSleepNearStatusUpdate({ now }).catch(() => undefined);
    } else {
      await runAssistantNearStatusUpdate({ apiKey: apiKey!.trim(), connection: connection!, profile,
        now, dataEpoch: resolvedDataEpoch, currentState }).catch(() => undefined);
    }
  }
  await runAssistantAffectUpdate({ apiKey: apiKey!.trim(), connection: connection!, profile,
    now: Date.now(), dataEpoch: resolvedDataEpoch, currentState: await loadAssistantState() }).catch(() => undefined);
  await runAssistantInnerStateUpdate({ apiKey: apiKey!.trim(), connection: connection!, currentState: await loadAssistantState(),
    dataEpoch: resolvedDataEpoch, profile, now: Date.now(),
  }).catch(() => undefined);
  return loadAssistantState();
}

export function refreshAssistantLifeState(options: RefreshOptions = {}): Promise<AssistantState> {
  // A locally due sleep/get-up must not wait for an in-flight remote refresh.
  if (options.afterSleepPlanChange) return performRefresh({
    ...options, skipNearStatus: true, apiKey: undefined, connection: undefined,
  });
  // C is checked before creating pendingRefresh: its own local reconciliation may refresh the display.
  if (!options.sleepOpportunityChecked && !pendingRefresh) {
    pendingSleepOpportunityCheck ??= import('../life/sleepPlanRuntime').then(({ runSleepPlanTick }) =>
      runSleepPlanTick({ now: options.now ?? Date.now(), allowRequest: !!options.apiKey?.trim() && !!options.connection }))
      .finally(() => { pendingSleepOpportunityCheck = undefined; });
    return pendingSleepOpportunityCheck.then(handled => refreshAssistantLifeState({
      ...options, sleepOpportunityChecked: true, skipNearStatus: options.skipNearStatus || handled,
    }));
  }
  const backupRestoreLeaseHeld = options.backupRestoreLeaseHeld === true;
  if (!pendingRefresh || pendingRefreshLeaseHeld !== backupRestoreLeaseHeld) {
    const refresh = observeRuntimeWorkload(
      'life.refresh_actual',
      (span) => performRefresh({ ...options, diagnosticParentToken: span?.token }),
      undefined,
      { parentToken: options.diagnosticParentToken },
    ).finally(() => {
      if (pendingRefresh === refresh) {
        pendingRefresh = undefined;
        pendingRefreshLeaseHeld = false;
      }
    });
    pendingRefresh = refresh;
    pendingRefreshLeaseHeld = backupRestoreLeaseHeld;
  }
  return pendingRefresh;
}

export async function wakeAssistantByPoke(now = Date.now(), onWoke?: (wokeAt: number) => void) {
  const current = await loadAssistantState();
  if (current.lifeMode !== 'sleeping') return current;
  await runRhythmTick({ now, manualSleepUntil: current.manualSleepUntil, manualWakeUntil: current.manualWakeUntil });
  const saved = await saveAssistantState(
    {
      activity: '被小仓鼠轻轻戳醒，正揉着眼睛看过来。',
      moodId: current.moodId,
      title: '被鼠戳醒啦',
    },
    {
      lifeMode: 'available',
      lifeContext: current.lifeContext,
      manualWakeUntil: now + MANUAL_WAKE_IDLE_MS,
      scheduleSlot: current.scheduleSlot,
      sourceType: current.sourceType,
      wakeSource: 'poke',
    },
  );
  await recordSleepPokeAwake(now, now + MANUAL_WAKE_IDLE_MS).catch(() => {
    console.warn('[sleep-plan] poke fact save failed after actual wake');
  });
  onWoke?.(now);
  await applySleepWakeOverride('wake', now).catch(() => undefined);
  // The poke's immediate chat reply takes priority; its release or the existing life check refreshes near-status.
  return saved;
}


export function describeAssistantAvailability(lifeMode: AssistantLifeMode) {
  switch (lifeMode) {
    case 'sleeping':
      return '睡觉中，也可以给我留言';
    case 'self-time':
      return '在自己的时间里，也听得见鼠';
    default:
      return '与你连接着';
  }
}
