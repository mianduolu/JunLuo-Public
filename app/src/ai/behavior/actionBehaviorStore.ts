import { relationshipAuthorizationStorageBridge as AsyncStorage } from '../../sync/syncRelationshipAuthorizationStorageBridge';

import {
  createBaiyunSemanticReviewBudget,
  DEFAULT_BAIYUN_REMOTE_REVIEW_DAILY_LIMIT,
  normalizeBaiyunSemanticReviewBudget,
  type BaiyunSemanticReviewBudget,
} from './actionBudget';

const ROUTING_SETTINGS_KEY = 'junluo.baiyunBehavior.routing';
const REVIEW_BUDGET_KEY = 'junluo.baiyunBehavior.semanticReviewBudget';
const INTIMACY_SAFETY_SETTINGS_KEY = 'junluo.baiyunBehavior.intimacySafety';

export interface BaiyunBehaviorRoutingSettings {
  primaryConnectionId?: string;
  remoteFallbackConnectionId?: string;
  remoteSemanticReviewEnabled: boolean;
  remoteSemanticReviewDailyLimit: number;
  privateSummaryEnabled: boolean;
}

export const DEFAULT_BAIYUN_BEHAVIOR_ROUTING_SETTINGS: BaiyunBehaviorRoutingSettings = {
  remoteSemanticReviewEnabled: false,
  remoteSemanticReviewDailyLimit: DEFAULT_BAIYUN_REMOTE_REVIEW_DAILY_LIMIT,
  privateSummaryEnabled: false,
};

export interface BaiyunIntimacySafetySettings {
  safeWord: string;
}

export const DEFAULT_BAIYUN_INTIMACY_SAFETY_SETTINGS: BaiyunIntimacySafetySettings = {
  safeWord: '',
};

export function getBaiyunLocalDateKey(now = new Date()) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const date = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${date}`;
}

function normalizeRoutingSettings(value: unknown): BaiyunBehaviorRoutingSettings {
  if (!value || typeof value !== 'object') {
    return { ...DEFAULT_BAIYUN_BEHAVIOR_ROUTING_SETTINGS };
  }
  const candidate = value as Partial<BaiyunBehaviorRoutingSettings>;
  const limit = candidate.remoteSemanticReviewDailyLimit === -1
    ? -1
    : Number.isFinite(candidate.remoteSemanticReviewDailyLimit)
      ? Math.max(0, Math.round(candidate.remoteSemanticReviewDailyLimit as number))
      : DEFAULT_BAIYUN_REMOTE_REVIEW_DAILY_LIMIT;
  return {
    primaryConnectionId: typeof candidate.primaryConnectionId === 'string'
      ? candidate.primaryConnectionId
      : undefined,
    remoteFallbackConnectionId: typeof candidate.remoteFallbackConnectionId === 'string'
      ? candidate.remoteFallbackConnectionId
      : undefined,
    remoteSemanticReviewEnabled: candidate.remoteSemanticReviewEnabled === true,
    remoteSemanticReviewDailyLimit: limit,
    privateSummaryEnabled: candidate.privateSummaryEnabled === true,
  };
}

function normalizeIntimacySafetySettings(value: unknown): BaiyunIntimacySafetySettings {
  if (!value || typeof value !== 'object') {
    return { ...DEFAULT_BAIYUN_INTIMACY_SAFETY_SETTINGS };
  }
  const candidate = value as Partial<BaiyunIntimacySafetySettings>;
  const safeWord = typeof candidate.safeWord === 'string'
    ? Array.from(candidate.safeWord.trim()).slice(0, 24).join('')
    : '';
  return { safeWord };
}

export async function loadBaiyunBehaviorRoutingSettings() {
  const saved = await AsyncStorage.getItem(ROUTING_SETTINGS_KEY);
  if (!saved) return { ...DEFAULT_BAIYUN_BEHAVIOR_ROUTING_SETTINGS };
  try {
    return normalizeRoutingSettings(JSON.parse(saved));
  } catch {
    return { ...DEFAULT_BAIYUN_BEHAVIOR_ROUTING_SETTINGS };
  }
}

export async function saveBaiyunBehaviorRoutingSettings(
  settings: BaiyunBehaviorRoutingSettings,
) {
  const normalized = normalizeRoutingSettings(settings);
  await AsyncStorage.setItem(ROUTING_SETTINGS_KEY, JSON.stringify(normalized));
  return normalized;
}

export async function loadBaiyunIntimacySafetySettings() {
  const saved = await AsyncStorage.getItem(INTIMACY_SAFETY_SETTINGS_KEY);
  if (!saved) return { ...DEFAULT_BAIYUN_INTIMACY_SAFETY_SETTINGS };
  try {
    return normalizeIntimacySafetySettings(JSON.parse(saved));
  } catch {
    return { ...DEFAULT_BAIYUN_INTIMACY_SAFETY_SETTINGS };
  }
}

export async function saveBaiyunIntimacySafetySettings(
  settings: BaiyunIntimacySafetySettings,
) {
  const normalized = normalizeIntimacySafetySettings(settings);
  await AsyncStorage.setItem(INTIMACY_SAFETY_SETTINGS_KEY, JSON.stringify(normalized));
  return normalized;
}

export async function loadBaiyunSemanticReviewBudget(
  settings: BaiyunBehaviorRoutingSettings,
  now = new Date(),
) {
  const localDate = getBaiyunLocalDateKey(now);
  const saved = await AsyncStorage.getItem(REVIEW_BUDGET_KEY);
  if (!saved) {
    return createBaiyunSemanticReviewBudget(
      localDate,
      settings.remoteSemanticReviewDailyLimit,
    );
  }
  try {
    return normalizeBaiyunSemanticReviewBudget(
      JSON.parse(saved) as BaiyunSemanticReviewBudget,
      localDate,
      settings.remoteSemanticReviewDailyLimit,
    );
  } catch {
    return createBaiyunSemanticReviewBudget(
      localDate,
      settings.remoteSemanticReviewDailyLimit,
    );
  }
}

export async function saveBaiyunSemanticReviewBudget(
  budget: BaiyunSemanticReviewBudget,
) {
  await AsyncStorage.setItem(REVIEW_BUDGET_KEY, JSON.stringify(budget));
}

let budgetMutationQueue: Promise<unknown> = Promise.resolve();

export async function mutateBaiyunSemanticReviewBudget<T>(
  settings: BaiyunBehaviorRoutingSettings,
  mutate: (budget: BaiyunSemanticReviewBudget) => Promise<{
    budget: BaiyunSemanticReviewBudget;
    value: T;
  }> | {
    budget: BaiyunSemanticReviewBudget;
    value: T;
  },
  now = new Date(),
): Promise<T> {
  let resolveResult: (value: T) => void;
  let rejectResult: (reason: unknown) => void;
  const result = new Promise<T>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  budgetMutationQueue = budgetMutationQueue.catch(() => undefined).then(async () => {
    try {
      const current = await loadBaiyunSemanticReviewBudget(settings, now);
      const next = await mutate(current);
      await saveBaiyunSemanticReviewBudget(next.budget);
      resolveResult(next.value);
    } catch (error) {
      rejectResult(error);
    }
  });
  return result;
}
