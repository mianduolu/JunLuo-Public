import { chatRelationshipStorageBridge as AsyncStorage } from '../sync/syncChatRelationshipStorageBridge';

import type { SubjectiveMessage } from '../ai/subjectiveMessages';

const FAVORITE_MESSAGES_KEY = 'junluo.chat.favoriteMessages';

export type FavoriteMessage = {
  id: string;
  messageId: string;
  content: string;
  messageCreatedAt: number;
  savedAt: number;
};

function isFavoriteMessage(value: unknown): value is FavoriteMessage {
  if (!value || typeof value !== 'object') return false;

  const message = value as Partial<FavoriteMessage>;
  return (
    typeof message.id === 'string' &&
    typeof message.messageId === 'string' &&
    typeof message.content === 'string' &&
    typeof message.messageCreatedAt === 'number' &&
    typeof message.savedAt === 'number'
  );
}

export async function loadFavoriteMessages() {
  const stored = await AsyncStorage.getItem(FAVORITE_MESSAGES_KEY);
  if (!stored) return [];

  try {
    const parsed = JSON.parse(stored) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter(isFavoriteMessage).sort((left, right) => right.savedAt - left.savedAt)
      : [];
  } catch {
    return [];
  }
}

export async function saveFavoriteMessage(message: SubjectiveMessage) {
  const favorites = await loadFavoriteMessages();
  const existing = favorites.find((favorite) => favorite.messageId === message.id);
  if (existing) return { favorites, added: false };

  const favorite: FavoriteMessage = {
    id: `favorite-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    messageId: message.id,
    content: message.content,
    messageCreatedAt: message.createdAt,
    savedAt: Date.now(),
  };
  const next = [favorite, ...favorites];
  await AsyncStorage.setItem(FAVORITE_MESSAGES_KEY, JSON.stringify(next));
  return { favorites: next, added: true };
}

export async function saveFavoriteMessages(messages: SubjectiveMessage[]) {
  const favorites = await loadFavoriteMessages();
  const existingIds = new Set(favorites.map((favorite) => favorite.messageId));
  const now = Date.now();
  const additions = messages
    .filter((message) => !existingIds.has(message.id))
    .map<FavoriteMessage>((message, index) => ({
      id: `favorite-${now}-${index}-${Math.random().toString(36).slice(2, 8)}`,
      messageId: message.id,
      content: message.content,
      messageCreatedAt: message.createdAt,
      savedAt: now + index,
    }));

  if (!additions.length) return { favorites, added: 0 };

  const next = [...additions.reverse(), ...favorites];
  await AsyncStorage.setItem(FAVORITE_MESSAGES_KEY, JSON.stringify(next));
  return { favorites: next, added: additions.length };
}

export async function removeFavoriteMessage(id: string) {
  const favorites = await loadFavoriteMessages();
  const next = favorites.filter((favorite) => favorite.id !== id);
  await AsyncStorage.setItem(FAVORITE_MESSAGES_KEY, JSON.stringify(next));
  return next;
}
