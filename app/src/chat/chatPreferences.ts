import { chatRelationshipStorageBridge as AsyncStorage } from '../sync/syncChatRelationshipStorageBridge';

export type ChatPreferences = {
  musicAutoplay: boolean;
  musicEnabled: boolean;
  musicMultipleCardsEnabled: boolean;
  waitingModeEnabled: boolean;
};

const CHAT_PREFERENCES_KEY = 'junluo.chat.preferences';

const DEFAULT_CHAT_PREFERENCES: ChatPreferences = {
  musicAutoplay: false,
  musicEnabled: false,
  musicMultipleCardsEnabled: false,
  waitingModeEnabled: true,
};

export async function loadChatPreferences(): Promise<ChatPreferences> {
  const raw = await AsyncStorage.getItem(CHAT_PREFERENCES_KEY);
  if (!raw) return DEFAULT_CHAT_PREFERENCES;

  try {
    const parsed = JSON.parse(raw) as Partial<ChatPreferences>;
    return {
      musicAutoplay:
        typeof parsed.musicAutoplay === 'boolean'
          ? parsed.musicAutoplay
          : DEFAULT_CHAT_PREFERENCES.musicAutoplay,
      musicEnabled:
        typeof parsed.musicEnabled === 'boolean'
          ? parsed.musicEnabled
          : DEFAULT_CHAT_PREFERENCES.musicEnabled,
      musicMultipleCardsEnabled:
        typeof parsed.musicMultipleCardsEnabled === 'boolean'
          ? parsed.musicMultipleCardsEnabled
          : DEFAULT_CHAT_PREFERENCES.musicMultipleCardsEnabled,
      waitingModeEnabled:
        typeof parsed.waitingModeEnabled === 'boolean'
          ? parsed.waitingModeEnabled
          : DEFAULT_CHAT_PREFERENCES.waitingModeEnabled,
    };
  } catch {
    return DEFAULT_CHAT_PREFERENCES;
  }
}

export async function saveChatPreferences(preferences: ChatPreferences) {
  await AsyncStorage.setItem(CHAT_PREFERENCES_KEY, JSON.stringify(preferences));
}
