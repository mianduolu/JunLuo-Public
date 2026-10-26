import { assistantLifeStateStorageBridge as AsyncStorage } from '../sync/syncAssistantLifeStateStorageBridge';
import { DeviceEventEmitter } from 'react-native';

import { baiyunStatusPortraits, blackCloudStatusPortraits } from '../assets/homeImages';
import { isSleepNearStatusDisplayCurrent, type SleepNearStatusDisplay } from '../life/sleepNearStatusPolicy';
import {
  clearAssistantStatePersistenceDiagnostic,
  recordAssistantStateSyncPending,
} from './assistantStatePersistenceDiagnostics';
import {
  HOME_ASSISTANT_FALLBACK_POOLS,
  selectHomeAssistantFallback,
  type HomeAssistantFallbackInput,
} from './homeAssistantFallback';

const ASSISTANT_STATE_KEY = 'junluo.assistant.currentState';
export const ASSISTANT_STATE_CHANGED_EVENT = 'junluo.assistant.stateChanged';
export const NEAR_STATUS_INTERVAL_MS = 30 * 60_000;
const NEAR_STATUS_UPDATING_EVENT = 'junluo.assistant.nearStatusUpdating';
let nearStatusUpdating = false;

/** Presentation only; never persist this technical label as Baiyun's own near-status. */
export function setNearStatusUpdating(updating: boolean) {
  if (nearStatusUpdating === updating) return;
  nearStatusUpdating = updating;
  DeviceEventEmitter.emit(NEAR_STATUS_UPDATING_EVENT);
}

export function subscribeNearStatusUpdating(listener: () => void) {
  const subscription = DeviceEventEmitter.addListener(NEAR_STATUS_UPDATING_EVENT, listener);
  return () => subscription.remove();
}

type MoodCatalogEntry = {
  defaultTitle: string;
  enabledForGeneration: boolean;
  portrait: number;
};

export const ASSISTANT_MOOD_CATALOG = {
  affectionate: { defaultTitle: '软乎乎地喜欢着', enabledForGeneration: true, portrait: baiyunStatusPortraits.affectionate },
  afraid: { defaultTitle: '有点害怕', enabledForGeneration: true, portrait: baiyunStatusPortraits.afraid },
  angry: {
    defaultTitle: '有点生气',
    enabledForGeneration: true,
    portrait: baiyunStatusPortraits.angry,
  },
  anxious: { defaultTitle: '有些不安', enabledForGeneration: true, portrait: baiyunStatusPortraits.anxious },
  asleep: { defaultTitle: '安静睡着了', enabledForGeneration: true, portrait: baiyunStatusPortraits.asleep },
  calm: { defaultTitle: '平平常常地待着', enabledForGeneration: true, portrait: baiyunStatusPortraits.calm },
  confused: {
    defaultTitle: '有点困惑',
    enabledForGeneration: true,
    portrait: baiyunStatusPortraits.confused,
  },
  disappointed: { defaultTitle: '有些失落', enabledForGeneration: true, portrait: baiyunStatusPortraits.disappointed },
  expectant: { defaultTitle: '有一点期待', enabledForGeneration: true, portrait: baiyunStatusPortraits.expectant },
  frustrated: { defaultTitle: '有点烦躁', enabledForGeneration: true, portrait: baiyunStatusPortraits.frustrated },
  guilty: { defaultTitle: '有些愧疚', enabledForGeneration: true, portrait: baiyunStatusPortraits.guilty },
  happy: {
    defaultTitle: '心情很好',
    enabledForGeneration: true,
    portrait: baiyunStatusPortraits.happy,
  },
  hurt: { defaultTitle: '有点委屈', enabledForGeneration: true, portrait: baiyunStatusPortraits.hurt },
  jealous: { defaultTitle: '悄悄吃醋', enabledForGeneration: true, portrait: baiyunStatusPortraits.jealous },
  lonely: { defaultTitle: '有些孤单', enabledForGeneration: true, portrait: baiyunStatusPortraits.lonely },
  longing: { defaultTitle: '正在想念', enabledForGeneration: true, portrait: baiyunStatusPortraits.longing },
  pained: { defaultTitle: '心里有点疼', enabledForGeneration: true, portrait: baiyunStatusPortraits.pained },
  proud: { defaultTitle: '有一点欣慰', enabledForGeneration: true, portrait: baiyunStatusPortraits.proud },
  relieved: { defaultTitle: '安心了一点', enabledForGeneration: true, portrait: baiyunStatusPortraits.relieved },
  sad: {
    defaultTitle: '有些低落',
    enabledForGeneration: true,
    portrait: baiyunStatusPortraits.sad,
  },
  shy: { defaultTitle: '有点害羞', enabledForGeneration: true, portrait: baiyunStatusPortraits.shy },
  sleepy: { defaultTitle: '有点困了', enabledForGeneration: true, portrait: baiyunStatusPortraits.sleepy },
  surprised: {
    defaultTitle: '有点惊讶',
    enabledForGeneration: true,
    portrait: baiyunStatusPortraits.surprised,
  },
  tired: { defaultTitle: '有些疲惫', enabledForGeneration: true, portrait: baiyunStatusPortraits.tired },
} satisfies Record<string, MoodCatalogEntry>;

export type AssistantMoodId = keyof typeof ASSISTANT_MOOD_CATALOG;
export type AssistantCloudForm = 'white' | 'black';
export function getAssistantPortrait(mood: AssistantMoodId, cloudForm?: AssistantCloudForm) {
  return cloudForm === 'black' ? blackCloudStatusPortraits[mood] : ASSISTANT_MOOD_CATALOG[mood].portrait;
}
export type AssistantStateSource = 'default' | 'idle-conversation' | 'self-schedule' | 'sleep';
export type AssistantLifeMode = 'available' | 'self-time' | 'sleeping';

export type AssistantState = {
  cloudForm?: AssistantCloudForm;
  activity: string;
  lifeContext?: string;
  lifeMode: AssistantLifeMode;
  manualSleepUntil?: number;
  manualWakeUntil?: number;
  moodId: AssistantMoodId;
  scheduleSlot?: string;
  sourceMessageId?: string;
  sourceType: AssistantStateSource;
  title: string;
  updatedAt: number;
  textUpdatedAt?: number;
  wakeSource?: 'message' | 'poke';
  sleepNearStatus?: SleepNearStatusDisplay;
};

export type AssistantStateDraft = Pick<AssistantState, 'activity' | 'moodId' | 'title'>;
export const EARLY_MORNING_STATE_DRAFT: AssistantStateDraft = {
  moodId: 'calm', ...HOME_ASSISTANT_FALLBACK_POOLS.wake[0],
};
export type AssistantStateChangedPayload = { state: AssistantState };

export const DEFAULT_ASSISTANT_STATE: AssistantState = {
  cloudForm: 'white',
  moodId: 'calm',
  ...HOME_ASSISTANT_FALLBACK_POOLS.initial[0],
  lifeMode: 'available',
  sourceType: 'default',
  updatedAt: 0,
};

/** Display only: keep the saved near-status intact and replace expired text with an approved local draft. */
export function getHomeAssistantDisplayState(
  state: AssistantState,
  now = Date.now(),
  weather?: HomeAssistantFallbackInput['weather'],
): AssistantState {
  if (state.lifeMode !== 'sleeping') {
    if (nearStatusUpdating) return { ...state, title: '近况更新中', activity: '' };
    const writtenAt = state.textUpdatedAt ?? 0;
    if (!state.sleepNearStatus && Number.isFinite(writtenAt) && writtenAt > 0
      && writtenAt <= now && now - writtenAt < NEAR_STATUS_INTERVAL_MS) return state;
    const fallback = selectHomeAssistantFallback({
      lifeMode: state.lifeMode,
      now,
      scheduleSlot: state.scheduleSlot,
      sourceType: state.sourceType,
      updatedAt: state.updatedAt,
      weather,
    });
    return { ...state, title: fallback.title, activity: fallback.activity };
  }
  if (state.sleepNearStatus && isSleepNearStatusDisplayCurrent(state.sleepNearStatus, now)) return { ...state, moodId: 'asleep' };
  const fallback = selectHomeAssistantFallback({
    lifeMode: state.lifeMode,
    now,
    scheduleSlot: state.scheduleSlot,
    sourceType: state.sourceType,
    updatedAt: state.updatedAt,
    weather,
  });
  return {
    ...state,
    moodId: 'asleep',
    title: fallback.title,
    activity: fallback.activity,
  };
}

export function isAssistantMoodId(value: unknown): value is AssistantMoodId {
  return typeof value === 'string' && value in ASSISTANT_MOOD_CATALOG;
}

export function normalizeAssistantMoodId(value: unknown): AssistantMoodId {
  if (value === 'neutral' || value === 'speechless') return 'calm';
  if (value === 'like') return 'affectionate';
  return isAssistantMoodId(value) ? value : 'calm';
}

export function getGeneratedMoodIds() {
  return (Object.keys(ASSISTANT_MOOD_CATALOG) as AssistantMoodId[]).filter(
    (moodId) => ASSISTANT_MOOD_CATALOG[moodId].enabledForGeneration,
  );
}

function cleanLine(value: unknown, maximumLength: number, completeSentence = false) {
  if (typeof value !== 'string') return '';
  const clean = value.replace(/\s+/g, ' ').trim().replace(/(?:\.{3,}|…+)$/, '。');
  if (clean.length <= maximumLength) return clean;
  const shortened = clean.slice(0, maximumLength);
  if (!completeSentence) return shortened;
  const boundary = Math.max(
    shortened.lastIndexOf('。'),
    shortened.lastIndexOf('！'),
    shortened.lastIndexOf('？'),
    shortened.lastIndexOf('，'),
    shortened.lastIndexOf('；'),
  );
  const body = boundary >= Math.floor(maximumLength * 0.55)
    ? shortened.slice(0, boundary)
    : shortened;
  return `${body.replace(/[，,；;：:、\s]+$/, '')}。`;
}

export function validateAssistantStateDraft(value: unknown, requireEnabledForGeneration = true): AssistantStateDraft | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as { activity?: unknown; moodId?: unknown; title?: unknown };
  const moodId = normalizeAssistantMoodId(candidate.moodId);
  if (requireEnabledForGeneration && !ASSISTANT_MOOD_CATALOG[moodId].enabledForGeneration) return null;

  const title = cleanLine(candidate.title, 20);
  // Saved near-status prose is a complete text unit, not a 52-character preview.
  const activity = typeof candidate.activity === 'string' ? candidate.activity.replace(/\s+/g, ' ').trim() : '';
  if (!title || !activity) return null;
  return { moodId, title, activity };
}

function validateStoredAssistantState(value: unknown): AssistantState {
  const draft = validateAssistantStateDraft(value, false);
  if (!draft || !value || typeof value !== 'object') return DEFAULT_ASSISTANT_STATE;
  const stored = value as {
    cloudForm?: unknown;
    lifeMode?: unknown;
    lifeContext?: unknown;
    manualSleepUntil?: unknown;
    manualWakeUntil?: unknown;
    scheduleSlot?: unknown;
    sourceMessageId?: unknown;
    sourceType?: unknown;
    updatedAt?: unknown;
    textUpdatedAt?: unknown;
    wakeSource?: unknown;
    sleepNearStatus?: unknown;
  };
  if (typeof stored.updatedAt !== 'number') return DEFAULT_ASSISTANT_STATE;
  const sourceMessageId = typeof stored.sourceMessageId === 'string' ? stored.sourceMessageId : undefined;
  const scheduleSlot = typeof stored.scheduleSlot === 'string' ? stored.scheduleSlot : undefined;
  const lifeContext = typeof stored.lifeContext === 'string' ? stored.lifeContext : undefined;
  const manualSleepUntil = typeof stored.manualSleepUntil === 'number' ? stored.manualSleepUntil : undefined;
  const manualWakeUntil = typeof stored.manualWakeUntil === 'number' ? stored.manualWakeUntil : undefined;
  const wakeSource = stored.wakeSource === 'poke' || stored.wakeSource === 'message' ? stored.wakeSource : undefined;
  const lifeMode: AssistantLifeMode =
    stored.lifeMode === 'sleeping' || stored.lifeMode === 'self-time' || stored.lifeMode === 'available'
      ? stored.lifeMode
      : 'available';
  const sourceType: AssistantStateSource =
    stored.sourceType === 'self-schedule' || stored.sourceType === 'sleep' || stored.sourceType === 'idle-conversation'
      ? stored.sourceType
      : sourceMessageId
        ? 'idle-conversation'
        : 'default';
  const sleepNearStatus = stored.sleepNearStatus as Partial<SleepNearStatusDisplay> | undefined;
  const validSleepNearStatus = sleepNearStatus && typeof sleepNearStatus.nightKey === 'string'
    && typeof sleepNearStatus.slotId === 'string'
    && ['sleeping', 'deep', 'pre-wake'].includes(sleepNearStatus.phase ?? '')
    && [sleepNearStatus.sleepAt, sleepNearStatus.wakeAt, sleepNearStatus.deepAt, sleepNearStatus.preWakeAt, sleepNearStatus.recordedAt].every(value => typeof value === 'number' && Number.isFinite(value));
  return {
    ...draft,
    cloudForm: stored.cloudForm === 'black' ? 'black' : 'white',
    lifeContext,
    lifeMode,
    manualSleepUntil,
    manualWakeUntil,
    scheduleSlot,
    sourceMessageId,
    sourceType,
    updatedAt: stored.updatedAt,
    textUpdatedAt: typeof stored.textUpdatedAt === 'number' && Number.isFinite(stored.textUpdatedAt)
      && stored.textUpdatedAt >= 0 ? stored.textUpdatedAt : 0,
    wakeSource,
    sleepNearStatus: validSleepNearStatus ? sleepNearStatus as SleepNearStatusDisplay : undefined,
  };
}

export async function loadAssistantState() {
  const serialized = await AsyncStorage.getItem(ASSISTANT_STATE_KEY);
  if (!serialized) return DEFAULT_ASSISTANT_STATE;
  try {
    return validateStoredAssistantState(JSON.parse(serialized) as unknown);
  } catch {
    return DEFAULT_ASSISTANT_STATE;
  }
}

export async function saveAssistantState(
  draft: AssistantStateDraft,
  source: {
    cloudFormDecision?: AssistantCloudForm;
    lifeMode?: AssistantLifeMode;
    lifeContext?: string;
    manualSleepUntil?: number;
    manualWakeUntil?: number;
    scheduleSlot?: string;
    sourceMessageId?: string;
    sourceType: AssistantStateSource;
    wakeSource?: 'message' | 'poke';
    sleepNearStatus?: SleepNearStatusDisplay;
    refreshTextTimestamp?: boolean;
    invalidateTextTimestamp?: boolean;
  },
) {
  const previous = await loadAssistantState();
  const now = Date.now();
  const sameText = draft.title === previous.title && draft.activity === previous.activity;
  const preserveManualWake =
    source.manualWakeUntil === undefined &&
    source.lifeMode !== 'sleeping' &&
    typeof previous.manualWakeUntil === 'number' &&
    previous.manualWakeUntil > Date.now();
  const preserveManualSleep =
    source.manualSleepUntil === undefined &&
    source.lifeMode === 'sleeping' &&
    typeof previous.manualSleepUntil === 'number' &&
    previous.manualSleepUntil > Date.now();
  const state: AssistantState = {
    ...draft,
    // Only a final near-status decision can change form. Old sleep/refresh drafts retain the latest value.
    cloudForm: source.cloudFormDecision ?? previous.cloudForm ?? 'white',
    lifeContext: source.lifeContext,
    lifeMode: source.lifeMode ?? 'available',
    manualSleepUntil: source.manualSleepUntil ?? (preserveManualSleep ? previous.manualSleepUntil : undefined),
    manualWakeUntil: source.manualWakeUntil ?? (preserveManualWake ? previous.manualWakeUntil : undefined),
    scheduleSlot: source.scheduleSlot,
    sourceMessageId: source.sourceMessageId,
    sourceType: source.sourceType,
    updatedAt: now,
    textUpdatedAt: source.invalidateTextTimestamp ? 0 : source.refreshTextTimestamp || !sameText ? now : previous.textUpdatedAt ?? 0,
    wakeSource: source.wakeSource ?? (preserveManualWake ? previous.wakeSource : undefined),
    sleepNearStatus: source.sleepNearStatus,
  };
  const serialized = JSON.stringify(state);
  let syncPending = false;
  try {
    await AsyncStorage.setItem(ASSISTANT_STATE_KEY, serialized);
  } catch (error) {
    const persisted = await AsyncStorage.getItem(ASSISTANT_STATE_KEY).catch(() => null);
    if (persisted !== serialized) throw error;
    syncPending = true;
  }
  if (syncPending) {
    console.warn('[assistant-state] local save succeeded; sync capture pending');
    await recordAssistantStateSyncPending(state.updatedAt).catch(() => undefined);
  } else {
    await clearAssistantStatePersistenceDiagnostic().catch(() => undefined);
  }
  DeviceEventEmitter.emit(ASSISTANT_STATE_CHANGED_EVENT, { state } satisfies AssistantStateChangedPayload);
  if (previous.lifeMode !== state.lifeMode) {
    await (await import('../life/junluoDesireRuntime')).noteJunluoActivityChange(state.updatedAt);
  }
  return state;
}

export function subscribeAssistantStateChanged(listener: (state: AssistantState) => void) {
  const subscription = DeviceEventEmitter.addListener(
    ASSISTANT_STATE_CHANGED_EVENT,
    (payload?: AssistantStateChangedPayload) => {
      if (payload?.state) listener(payload.state);
    },
  );
  return () => subscription.remove();
}
