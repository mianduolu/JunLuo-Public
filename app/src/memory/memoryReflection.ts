import { memoryExperienceStorageBridge as AsyncStorage } from '../sync/syncMemoryExperienceStorageBridge';
import { isBaiyunPostMemory } from '../posts/baiyunPostContract';
import { loadMemories } from './memoryStore';

// Existing read markers remain compatible; the old reflection generator is retired.
const BAIYUN_HEART_VIEWED_KEY = 'junluo.memory.baiyunHeartViewedThroughId';
const BAIYUN_HEART_OPEN_TAB_KEY = 'junluo.memory.openBaiyunHeartTab';

async function latestPost() {
  return (await loadMemories()).filter(memory => memory.type !== 'archived' && isBaiyunPostMemory(memory))
    .sort((left, right) => right.createdAt - left.createdAt)[0];
}
export async function loadBaiyunHeartNotice(options: { now?: number } = {}) {
  const latest = await latestPost();
  if (!latest) return { latest: null, visible: false };
  const viewed = await AsyncStorage.getItem(BAIYUN_HEART_VIEWED_KEY).catch(() => null);
  return { latest, visible: (options.now ?? Date.now()) - latest.createdAt <= 24 * 60 * 60 * 1000 && viewed !== latest.id };
}
export async function markLatestBaiyunHeartViewed(memoryId?: string) {
  const targetId = memoryId ?? (await latestPost())?.id;
  if (targetId) await AsyncStorage.setItem(BAIYUN_HEART_VIEWED_KEY, targetId);
}
export async function requestOpenBaiyunHeartTab() {
  await AsyncStorage.setItem(BAIYUN_HEART_OPEN_TAB_KEY, '1');
}
export async function consumeOpenBaiyunHeartTabRequest() {
  const value = await AsyncStorage.getItem(BAIYUN_HEART_OPEN_TAB_KEY).catch(() => null);
  if (!value) return false;
  await AsyncStorage.removeItem(BAIYUN_HEART_OPEN_TAB_KEY);
  return true;
}
