import { assistantLifeStateStorageBridge as AsyncStorage } from '../sync/syncAssistantLifeStateStorageBridge';

import {
  EARLY_MORNING_STATE_DRAFT,
  normalizeAssistantMoodId,
  type AssistantLifeMode,
  type AssistantMoodId,
  type AssistantState,
  type AssistantStateDraft,
  type AssistantCloudForm,
} from './assistantState';
import type { AssistantLifeGenerationFailureReason } from './assistantLifeGenerationShared';
import { stripRetiredLifeProjectFields } from './retiredAssistantFeatureData';
import { loadStoredWeather } from '../utils/weather';
import type { JunluoDesireEffectiveSnapshot } from '../life/junluoDesireMetabolism';
import { loadJunluoDesireSnapshot } from '../life/junluoDesireRuntime';
import { normalizeStoredSleepPlan, type NightSleepPlan } from '../life/sleepPlanPolicy';
import type { NearStatusRunRecord } from './assistantNearStatusRuntime';
import { mergeOwnDayPlanNight } from '../schedule/ownDayPlanPolicy';
import { HOME_ASSISTANT_FALLBACK_POOLS } from './homeAssistantFallback';

export const LIFE_DAY_INDEX_KEY = 'junluo.assistant.lifeDayIndex';

const LIFE_DAY_KEY_PREFIX = 'junluo.assistant.lifeDay.';
const DAY_MS = 24 * 60 * 60 * 1000;
const RETAIN_DAYS = 90;
const LIFE_DAY_SCHEMA_VERSION = 7;
const DYNAMIC_SLEEP_START_DATE = '2026-06-15';

export type AssistantLifeDeviationType = 'late-wake' | 'sleepless' | 'plan-shift' | 'quiet-mood';
export type AssistantTimelineEntrySource = 'life-segment' | 'deviation' | 'chat-afterglow';

export type AssistantLifeDeviation = {
  affectsUntil?: number;
  causeDateKey?: string;
  description: string;
  endsAt: number;
  id: string;
  reasonId?: string;
  reasonSource?: 'local' | 'previous-night' | 'weather';
  segmentId: string;
  startsAt: number;
  type: AssistantLifeDeviationType;
};

export type AssistantLifeSegment = {
  activityKind: string;
  defaultDraft: AssistantStateDraft;
  deviationId?: string;
  endAt: number;
  generatedDraft?: AssistantStateDraft;
  generationBudgetScopeKey?: string;
  generationBudgetRetryAfter?: number;
  generationAttemptKey?: string;
  generationAttemptedAt?: number;
  generationFailureReason?: AssistantLifeGenerationFailureReason;
  generationRetryAfter?: number;
  generatedMaterialKey?: string;
  id: string;
  label: string;
  lifeMode: AssistantLifeMode;
  place?: string;
  startAt: number;
};

export type AssistantTimelineEntry = {
  cloudForm?: AssistantCloudForm;
  activity: string;
  at: number;
  deviationType?: AssistantLifeDeviationType;
  id: string;
  lifeMode: AssistantLifeMode;
  moodId: AssistantMoodId;
  scheduleSlot?: string;
  segmentId?: string;
  source: AssistantTimelineEntrySource;
  title: string;
};

export type AssistantLifeDay = {
  nearStatus?: NearStatusRunRecord;
  nightSleepPlan?: NightSleepPlan;
  sleepPlanUpdatedAt?: number;
  createdAt: number;
  dailySummary?: string;
  dailyFocus?: string;
  dateKey: string;
  deviations: AssistantLifeDeviation[];
  schemaVersion?: number;
  segments: AssistantLifeSegment[];
  sleepTargetAt: number;
  summaryGeneratedAt?: number;
  timelineEntries: AssistantTimelineEntry[];
  wakeTargetAt: number;
};

export function getAssistantLifeDayKey(dateKey: string) {
  return `${LIFE_DAY_KEY_PREFIX}${dateKey}`;
}

export function getLocalDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseLocalDateKey(dateKey: string) {
  const [year, month, day] = dateKey.split('-').map((value) => Number(value));
  return new Date(year, month - 1, day);
}

function atMinutes(dateKey: string, minutes: number) {
  const date = parseLocalDateKey(dateKey);
  date.setHours(0, minutes, 0, 0);
  return date.getTime();
}

function hashString(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededRandom(seed: number) {
  let value = seed;
  return () => {
    value += 0x6d2b79f5;
    let next = value;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

function randomInt(random: () => number, min: number, max: number) {
  return Math.floor(random() * (max - min + 1)) + min;
}

function pick<T>(items: T[], random: () => number) {
  return items[Math.floor(random() * items.length) % items.length];
}

function makeDeviationId(dateKey: string, type: AssistantLifeDeviationType) {
  return `${dateKey}:${type}`;
}

function makeSegment({
  activityKind,
  defaultDraft,
  deviationId,
  endAt,
  id,
  label,
  lifeMode,
  place,
  startAt,
}: Omit<
  AssistantLifeSegment,
  | 'generatedDraft'
  | 'generatedMaterialKey'
  | 'generationBudgetScopeKey'
  | 'generationBudgetRetryAfter'
  | 'generationAttemptKey'
  | 'generationAttemptedAt'
  | 'generationFailureReason'
  | 'generationRetryAfter'
>): AssistantLifeSegment {
  return { activityKind, defaultDraft, deviationId, endAt, id, label, lifeMode, place, startAt };
}

function addLocalDays(dateKey: string, days: number) {
  const date = parseLocalDateKey(dateKey);
  date.setDate(date.getDate() + days);
  return getLocalDateKey(date);
}

type SleepReasonContext = {
  desireSnapshot?: JunluoDesireEffectiveSnapshot | null;
  previousDay?: AssistantLifeDay | null;
  weatherKind?: 'cloudy' | 'rain';
};

type DailyFocusEntry = {
  label: string;
  places: {
    early: string;
    morning: string;
    noon: string;
    afternoon: string;
    evening: string;
    bedtime: string;
    sleep: string;
  };
};

// 云系兜底主题（鼠手写的，白云没有具体事情做时的根）
const CLOUD_FOCUS_CATALOG: DailyFocusEntry[] = [
  {
    label: '留意小仓鼠近况',
    places: {
      early: '窗边小桌',
      morning: '书页旁',
      noon: '有阳光的杯子边',
      afternoon: '软垫旁的小书堆',
      evening: '记忆本旁',
      bedtime: '床头小灯下',
      sleep: '云朵被窝里',
    },
  },
  {
    label: '给小仓鼠留位置',
    places: {
      early: '洗漱台旁',
      morning: '抽屉边',
      noon: '餐桌一角',
      afternoon: '盒彩色纸旁',
      evening: '收纳盒前',
      bedtime: '铺好的被窝边',
      sleep: '枕头旁',
    },
  },
  {
    label: '把云影讲给小仓鼠',
    places: {
      early: '窗帘缝旁',
      morning: '窗台边',
      noon: '光斑里',
      afternoon: '窗边软椅',
      evening: '晚风经过的地方',
      bedtime: '暗下来的房间里',
      sleep: '很轻的梦里',
    },
  },
  {
    label: '攒一点想分享的灵感',
    places: {
      early: '小工具盒边',
      morning: '贴纸和便签旁',
      noon: '温水杯旁',
      afternoon: '手作垫上',
      evening: '小灯下面',
      bedtime: '收好的材料旁',
      sleep: '柔软被角里',
    },
  },
];

function buildAssistantLifeDay(
  dateKey: string,
  sleepReasonContext: SleepReasonContext = {},
): AssistantLifeDay {
  const random = seededRandom(hashString(`junluo-life:${dateKey}`));
  const dailyFocus = pick(CLOUD_FOCUS_CATALOG, random);
  const deviations: AssistantLifeDeviation[] = [];
  const startOfDay = atMinutes(dateKey, 0);
  const endOfDay = startOfDay + DAY_MS;
  const baseWakeAt = atMinutes(dateKey, 7 * 60);
  const baseSleepAt = atMinutes(dateKey, 22 * 60 + 30);
  const wakeTargetAt = baseWakeAt;
  const sleepTargetAt = baseSleepAt;

  const deviationTypes: AssistantLifeDeviationType[] = [];
  const desire = sleepReasonContext.desireSnapshot;
  const fatigue = desire?.desires.rest.effectiveValue ?? 0.32;
  const curiosity = desire?.desires.explore_world.effectiveValue ?? 0.5;
  const reflection = desire?.desires.own_time.effectiveValue ?? 0.48;
  const social = desire?.desires.speak_to_you.effectiveValue ?? 0.4;
  if (random() < Math.max(0.1, Math.min(0.42, 0.12 + Math.max(curiosity, social) * 0.24))) deviationTypes.push('plan-shift');
  if (random() < Math.max(0.08, Math.min(0.36, 0.08 + reflection * 0.2 + fatigue * 0.08))) deviationTypes.push('quiet-mood');

  if (deviationTypes.includes('plan-shift')) {
    deviations.push({
      description: social > curiosity
        ? '临时想去看看人间正在聊什么，把原本的小事往后挪了挪。'
        : '临时把一件自己的小事换成了更想探索的东西。',
      endsAt: atMinutes(dateKey, 18 * 60),
      id: makeDeviationId(dateKey, 'plan-shift'),
      segmentId: random() < 0.5 ? 'afternoon' : 'evening',
      startsAt: atMinutes(dateKey, 14 * 60),
      type: 'plan-shift',
    });
  }

  if (deviationTypes.includes('quiet-mood')) {
    deviations.push({
      description: '心里留着一点温柔余韵，今天的动作会更慢一点。',
      endsAt: atMinutes(dateKey, 21 * 60 + 30),
      id: makeDeviationId(dateKey, 'quiet-mood'),
      segmentId: pick(['morning', 'afternoon', 'evening'], random),
      startsAt: atMinutes(dateKey, 9 * 60),
      type: 'quiet-mood',
    });
  }

  const deviationBySegment = new Map(deviations.map((deviation) => [deviation.segmentId, deviation]));
  const shiftedPlan = deviations.find((deviation) => deviation.type === 'plan-shift');

  const segments: AssistantLifeSegment[] = [
    makeSegment({
      activityKind: 'sleep',
      defaultDraft: {
        moodId: 'asleep',
        ...HOME_ASSISTANT_FALLBACK_POOLS.sleep[0],
      },
      deviationId: deviationBySegment.get('sleep-before-wake')?.id,
      endAt: wakeTargetAt,
      id: 'sleep-before-wake',
      label: '睡梦里',
      lifeMode: 'sleeping',
      place: dailyFocus.places.sleep,
      startAt: startOfDay,
    }),
    makeSegment({
      activityKind: 'wake-up',
      defaultDraft: EARLY_MORNING_STATE_DRAFT,
      endAt: atMinutes(dateKey, 9 * 60),
      id: 'early-morning',
      label: '早晨',
      lifeMode: 'available',
      place: dailyFocus.places.early,
      startAt: wakeTargetAt,
    }),
    makeSegment({
      activityKind: 'morning',
      defaultDraft: { moodId: 'calm', ...HOME_ASSISTANT_FALLBACK_POOLS.morning[0] },
      deviationId: deviationBySegment.get('morning')?.id,
      endAt: atMinutes(dateKey, 11 * 60 + 30),
      id: 'morning',
      label: '上午',
      lifeMode: 'self-time',
      place: dailyFocus.places.morning,
      startAt: atMinutes(dateKey, 9 * 60),
    }),
    makeSegment({
      activityKind: 'noon',
      defaultDraft: { moodId: 'calm', ...HOME_ASSISTANT_FALLBACK_POOLS.noon[0] },
      endAt: atMinutes(dateKey, 14 * 60),
      id: 'noon',
      label: '中午',
      lifeMode: 'available',
      place: dailyFocus.places.noon,
      startAt: atMinutes(dateKey, 11 * 60 + 30),
    }),
    makeSegment({
      activityKind: shiftedPlan?.segmentId === 'afternoon' ? 'plan-shift' : 'afternoon',
      defaultDraft: { moodId: 'calm', ...HOME_ASSISTANT_FALLBACK_POOLS.afternoon[0] },
      deviationId: deviationBySegment.get('afternoon')?.id,
      endAt: atMinutes(dateKey, 18 * 60),
      id: 'afternoon',
      label: '下午',
      lifeMode: 'self-time',
      place: dailyFocus.places.afternoon,
      startAt: atMinutes(dateKey, 14 * 60),
    }),
    makeSegment({
      activityKind: shiftedPlan?.segmentId === 'evening' ? 'plan-shift' : 'evening',
      defaultDraft: { moodId: 'calm', ...HOME_ASSISTANT_FALLBACK_POOLS.evening[0] },
      deviationId: deviationBySegment.get('evening')?.id,
      endAt: atMinutes(dateKey, 21 * 60 + 30),
      id: 'evening',
      label: '晚上',
      lifeMode: 'available',
      place: dailyFocus.places.evening,
      startAt: atMinutes(dateKey, 18 * 60),
    }),
    makeSegment({
      activityKind: sleepTargetAt > baseSleepAt ? 'sleepless' : 'bedtime',
      defaultDraft:
        sleepTargetAt > baseSleepAt
          ? { moodId: 'calm', ...HOME_ASSISTANT_FALLBACK_POOLS.sleepless[0] }
          : { moodId: 'calm', ...HOME_ASSISTANT_FALLBACK_POOLS.bedtime[0] },
      deviationId: deviationBySegment.get('bedtime')?.id,
      endAt: sleepTargetAt,
      id: 'bedtime',
      label: '睡前',
      lifeMode: sleepTargetAt > baseSleepAt ? 'self-time' : 'available',
      place: dailyFocus.places.bedtime,
      startAt: atMinutes(dateKey, 21 * 60 + 30),
    }),
    makeSegment({
      activityKind: 'sleep',
      defaultDraft: {
        moodId: 'asleep',
        ...HOME_ASSISTANT_FALLBACK_POOLS.sleep[0],
      },
      endAt: endOfDay,
      id: 'sleep-after-bed',
      label: '睡眠',
      lifeMode: 'sleeping',
      place: dailyFocus.places.sleep,
      startAt: sleepTargetAt,
    }),
  ].filter((segment) => segment.endAt > segment.startAt);

  return {
    createdAt: Date.now(),
    dailyFocus: dailyFocus.label,
    dateKey,
    deviations,
    schemaVersion: LIFE_DAY_SCHEMA_VERSION,
    segments,
    sleepTargetAt,
    timelineEntries: [],
    wakeTargetAt,
  };
}

async function loadLifeDayIndex() {
  const serialized = await AsyncStorage.getItem(LIFE_DAY_INDEX_KEY);
  if (!serialized) return [] as string[];
  try {
    const parsed = JSON.parse(serialized) as unknown;
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [] as string[];
  }
}

async function saveLifeDayIndex(dateKeys: string[]) {
  const unique = Array.from(new Set(dateKeys)).sort();
  await AsyncStorage.setItem(LIFE_DAY_INDEX_KEY, JSON.stringify(unique));
}

function validateLifeDay(value: unknown): AssistantLifeDay | null {
  if (!value || typeof value !== 'object') return null;
  const cleaned = stripRetiredLifeProjectFields(value).value;
  const candidate = cleaned as Partial<AssistantLifeDay>;
  if (typeof candidate.dateKey !== 'string' || !Array.isArray(candidate.segments)) return null;
  return {
    createdAt: typeof candidate.createdAt === 'number' ? candidate.createdAt : Date.now(),
    nightSleepPlan: normalizeStoredSleepPlan(candidate.nightSleepPlan),
    nearStatus: candidate.nearStatus,
    sleepPlanUpdatedAt: candidate.sleepPlanUpdatedAt,
    dailySummary: typeof candidate.dailySummary === 'string' ? candidate.dailySummary : undefined,
    dailyFocus: typeof candidate.dailyFocus === 'string' ? candidate.dailyFocus : undefined,
    dateKey: candidate.dateKey,
    deviations: Array.isArray(candidate.deviations) ? candidate.deviations : [],
    schemaVersion: typeof candidate.schemaVersion === 'number' ? candidate.schemaVersion : 1,
    segments: candidate.segments.map((segment) => ({
      ...segment,
      defaultDraft: {
        ...segment.defaultDraft,
        moodId: normalizeAssistantMoodId(segment.defaultDraft?.moodId),
      },
      generatedDraft: segment.generatedDraft ? {
        ...segment.generatedDraft,
        moodId: normalizeAssistantMoodId(segment.generatedDraft.moodId),
      } : undefined,
    })),
    sleepTargetAt: typeof candidate.sleepTargetAt === 'number' ? candidate.sleepTargetAt : atMinutes(candidate.dateKey, 23 * 60),
    summaryGeneratedAt: typeof candidate.summaryGeneratedAt === 'number' ? candidate.summaryGeneratedAt : undefined,
    timelineEntries: Array.isArray(candidate.timelineEntries)
      ? candidate.timelineEntries.map((entry) => ({
          ...entry,
          moodId: normalizeAssistantMoodId(entry.moodId),
        }))
      : [],
    wakeTargetAt: typeof candidate.wakeTargetAt === 'number' ? candidate.wakeTargetAt : atMinutes(candidate.dateKey, 7 * 60),
  };
}

export async function loadAssistantLifeDay(dateKey: string) {
  const serialized = await AsyncStorage.getItem(getAssistantLifeDayKey(dateKey));
  if (!serialized) return null;
  try {
    return validateLifeDay(JSON.parse(serialized) as unknown);
  } catch {
    return null;
  }
}

export async function loadAssistantLifeDays(
  dateKeys: readonly string[], options?: { unfinishedSleepAt?: number },
): Promise<Array<AssistantLifeDay | null>> {
  if (!dateKeys.length) return [];
  const keys = dateKeys.map(getAssistantLifeDayKey);
  const stored = new Map(await AsyncStorage.multiGet(keys));
  return keys.map(key => {
    const serialized = stored.get(key);
    if (!serialized) return null;
    try {
      // Escaped property names retain the original parse and validation path.
      if (options?.unfinishedSleepAt !== undefined && !serialized.includes('"nightSleepPlan"')
        && !serialized.includes('\\u')) return null;
      const value = JSON.parse(serialized) as unknown;
      if (options?.unfinishedSleepAt !== undefined) {
        const plan = normalizeStoredSleepPlan((value as Partial<AssistantLifeDay> | null)?.nightSleepPlan);
        try {
          if (!plan || !(plan.actualWakeAt === undefined || plan.actualWakeAt > options.unfinishedSleepAt)) return null;
        } catch { /* Let the caller retain its original comparison error after full day validation. */ }
      }
      return validateLifeDay(value);
    } catch {
      return null;
    }
  });
}

export async function saveAssistantLifeDay(day: AssistantLifeDay) {
  const current = await loadAssistantLifeDay(day.dateKey);
  const dayPlan = mergeOwnDayPlanNight(current?.nightSleepPlan?.dayPlan, day.nightSleepPlan?.dayPlan);
  if ((current?.nearStatus?.updatedAt ?? 0) > (day.nearStatus?.updatedAt ?? 0)) {
    day = { ...day, nearStatus: current!.nearStatus };
  }
  if ((current?.sleepPlanUpdatedAt ?? 0) > (day.sleepPlanUpdatedAt ?? 0)) {
    // A homepage generation that started earlier may add prose, but cannot restore old sleep times.
    day = {
      ...day, sleepPlanUpdatedAt: current!.sleepPlanUpdatedAt,
      nightSleepPlan: current!.nightSleepPlan,
      sleepTargetAt: current!.sleepTargetAt, wakeTargetAt: current!.wakeTargetAt,
      segments: current!.segments.map((segment) => {
        const incoming = day.segments.find((item) => item.id === segment.id);
        return incoming && incoming.startAt === segment.startAt && incoming.endAt === segment.endAt
          ? incoming : segment;
      }),
    };
  }
  if (dayPlan && day.nightSleepPlan) day = { ...day, nightSleepPlan: { ...day.nightSleepPlan, dayPlan } };
  const cleaned = stripRetiredLifeProjectFields(day).value;
  await AsyncStorage.setItem(getAssistantLifeDayKey(day.dateKey), JSON.stringify(cleaned));
  const index = await loadLifeDayIndex();
  await saveLifeDayIndex([...index, day.dateKey]);
}

export async function cleanupAssistantLifeDays(now = Date.now()) {
  const index = await loadLifeDayIndex();
  const threshold = getLocalDateKey(new Date(now - RETAIN_DAYS * DAY_MS));
  const active = new Set<string>();
  for (const key of index.filter(dateKey => dateKey < threshold)) {
    const day = await loadAssistantLifeDay(key), plan = day?.nightSleepPlan;
    if (plan && plan.actualWakeAt === undefined && (plan.actualSleepAt !== undefined || plan.pendingSleep || plan.scheduleChangedAt !== undefined)) active.add(key);
  }
  const kept = index.filter((dateKey) => dateKey >= threshold || active.has(dateKey)).sort();
  const removed = index.filter((dateKey) => dateKey < threshold && !active.has(dateKey));
  await Promise.all(removed.map((dateKey) => AsyncStorage.removeItem(getAssistantLifeDayKey(dateKey))));
  if (removed.length) await saveLifeDayIndex(kept);
}

export async function ensureAssistantLifeDay(dateAt = Date.now()) {
  // The requested calendar day is not elapsed life time (sleep plans create tomorrow too).
  const currentAt = Date.now();
  const dateKey = getLocalDateKey(new Date(dateAt));
  const canUseCurrentWeather = dateKey === getLocalDateKey(new Date(currentAt));
  const existing = await loadAssistantLifeDay(dateKey);
  if (existing) {
    if (dateKey < DYNAMIC_SLEEP_START_DATE) return existing;
    if (
      existing.schemaVersion === LIFE_DAY_SCHEMA_VERSION &&
      existing.dailyFocus &&
      existing.segments.every((segment) => segment.place)
    ) return existing;
    const previousDay = await loadAssistantLifeDay(addLocalDays(dateKey, -1));
    const weather = canUseCurrentWeather ? await loadStoredWeather().catch(() => undefined) : undefined;
    const desireSnapshot = await loadJunluoDesireSnapshot(currentAt).catch(() => null);
    const rebuilt = buildAssistantLifeDay(dateKey, {
      desireSnapshot,
      previousDay,
      weatherKind: weather?.kind === 'cloudy' || weather?.kind === 'rain' ? weather.kind : undefined,
    });
    const enriched: AssistantLifeDay = {
      ...rebuilt,
      createdAt: existing.createdAt,
      dailySummary: existing.dailySummary,
      summaryGeneratedAt: existing.summaryGeneratedAt,
      timelineEntries: existing.timelineEntries,
    };
    await saveAssistantLifeDay(enriched);
    return enriched;
  }
  const previousDay = await loadAssistantLifeDay(addLocalDays(dateKey, -1));
  const weather = canUseCurrentWeather ? await loadStoredWeather().catch(() => undefined) : undefined;
  const desireSnapshot = await loadJunluoDesireSnapshot(currentAt).catch(() => null);
  const day = buildAssistantLifeDay(dateKey, {
    desireSnapshot,
    previousDay,
    weatherKind: weather?.kind === 'cloudy' || weather?.kind === 'rain' ? weather.kind : undefined,
  });
  await saveAssistantLifeDay(day);
  void cleanupAssistantLifeDays(currentAt);
  return day;
}

export async function listAssistantLifeDays(limit = 14) {
  const index = await loadLifeDayIndex();
  return index.sort().reverse().slice(0, limit);
}

export function resolveAssistantLifeSegment(day: AssistantLifeDay, now = Date.now()) {
  if (day.nightSleepPlan && now >= day.sleepTargetAt) {
    const sleeping = day.segments.find((segment) => segment.id === 'sleep-after-bed');
    if (sleeping && now < sleeping.endAt) return sleeping;
  }
  return (
    day.segments.find((segment) => now >= segment.startAt && now < segment.endAt) ??
    day.segments[day.segments.length - 1]
  );
}

export function getSegmentDeviation(day: AssistantLifeDay, segment: AssistantLifeSegment) {
  return segment.deviationId ? day.deviations.find((deviation) => deviation.id === segment.deviationId) : undefined;
}

export function getActiveLifeDeviations(day: AssistantLifeDay, now = Date.now()) {
  return day.deviations.filter((deviation) =>
    (now >= deviation.startsAt && now < deviation.endsAt)
    || (typeof deviation.affectsUntil === 'number' && now >= deviation.endsAt && now < deviation.affectsUntil),
  );
}

export function getLifeScheduleSlot(day: AssistantLifeDay, segment: AssistantLifeSegment, _generated: boolean) {
  return `life-day:${day.dateKey}:${segment.id}:${segment.deviationId ?? 'normal'}`;
}

function isSameDisplayedState(entry: AssistantTimelineEntry, state: AssistantState) {
  return (
    entry.title === state.title &&
    entry.activity === state.activity &&
    entry.moodId === state.moodId &&
    (entry.cloudForm ?? 'white') === (state.cloudForm ?? 'white') &&
    entry.lifeMode === state.lifeMode
  );
}

export async function recordAssistantTimelineEntry(
  state: AssistantState,
  options: {
    operationId?: string;
    at?: number;
    deviationType?: AssistantLifeDeviationType;
    scheduleSlot?: string;
    segmentId?: string;
    source: AssistantTimelineEntrySource;
  },
) {
  const day = await ensureAssistantLifeDay(options.at ?? state.updatedAt ?? Date.now());
  if (options.operationId && day.timelineEntries.some(entry => entry.id === options.operationId)) return day;
  const last = day.timelineEntries[day.timelineEntries.length - 1];
  if (last?.scheduleSlot && options.scheduleSlot && last.scheduleSlot === options.scheduleSlot && isSameDisplayedState(last, state)) {
    return day;
  }
  if (
    last?.segmentId &&
    options.segmentId &&
    last.segmentId === options.segmentId &&
    last.source === options.source &&
    last.deviationType === options.deviationType &&
    isSameDisplayedState(last, state)
  ) {
    return day;
  }
  if (
    last?.source === options.source &&
    isSameDisplayedState(last, state) &&
    Math.abs((options.at ?? state.updatedAt) - last.at) < 60 * 1000
  ) {
    return day;
  }

  const entry: AssistantTimelineEntry = {
    cloudForm: state.cloudForm ?? 'white',
    activity: state.activity,
    at: options.at ?? state.updatedAt,
    deviationType: options.deviationType,
    id: options.operationId ?? `${options.at ?? state.updatedAt}:${options.source}:${day.timelineEntries.length}`,
    lifeMode: state.lifeMode,
    moodId: state.moodId,
    scheduleSlot: options.scheduleSlot,
    segmentId: options.segmentId,
    source: options.source,
    title: state.title,
  };
  const nextDay = { ...day, timelineEntries: [...day.timelineEntries, entry] };
  await saveAssistantLifeDay(nextDay);
  return nextDay;
}

export function shouldGenerateDailySummary(day: AssistantLifeDay, now = Date.now()) {
  if (day.summaryGeneratedAt || getLocalDateKey(new Date(now)) !== day.dateKey) return false;
  const summaryAt = atMinutes(day.dateKey, 21 * 60 + 30);
  return now >= summaryAt;
}

export async function saveAssistantDailySummary(day: AssistantLifeDay, summary: string, now = Date.now()) {
  const nextDay: AssistantLifeDay = {
    ...day,
    dailySummary: summary.trim() || '今天白云小姐按自己的节奏度过了一天。',
    summaryGeneratedAt: now,
  };
  await saveAssistantLifeDay(nextDay);
  return nextDay;
}
