import type { SubjectiveMessage } from '../ai/subjectiveMessages';

/**
 * Select an initial lock-screen display window, never the model's history.
 * Each you message begins a round; its following I bubbles stay together.
 * A leading I-only block is one display group. Stored messages have no common
 * reply-round ID, so this does not infer separate proactive rounds from time.
 */
export function selectRecentPhoneLockChatMessages(
  messages: readonly SubjectiveMessage[],
  roundLimit = 5,
): SubjectiveMessage[] {
  const limit = Math.floor(roundLimit);
  if (!messages.length || !(limit > 0)) return [];

  const starts = [0];
  for (let index = 1; index < messages.length; index += 1) {
    if (messages[index]!.role === 'you') starts.push(index);
  }
  const firstRound = Math.max(0, starts.length - limit);
  return messages.slice(starts[firstRound]);
}

/**
 * Merge the opening display window with the authoritative active chat slice.
 * Opening live IDs disappear with current history; read-only older pages stay.
 * Never widen the window when its first message is removed. Equal-time appends
 * need a surviving opening ID to establish their position in current order.
 */
export function mergePhoneLockChatDisplayMessages(
  opening: readonly SubjectiveMessage[],
  openingLiveIds: ReadonlySet<string>,
  current: readonly SubjectiveMessage[],
): SubjectiveMessage[] {
  if (!opening.length) return current.slice();

  const currentById = new Map(current.map(message => [message.id, message]));
  const openingIds = new Set(opening.map(message => message.id));
  const retained = opening.flatMap(message => {
    const fresh = currentById.get(message.id);
    return fresh ? [fresh] : openingLiveIds.has(message.id) ? [] : [message];
  });
  const openedThroughAt = opening[opening.length - 1]!.createdAt;
  let lastOpeningIndex = -1;
  current.forEach((message, index) => {
    if (openingIds.has(message.id)) lastOpeningIndex = index;
  });
  const appended = current.filter((message, index) => (
    !openingIds.has(message.id)
    && !openingLiveIds.has(message.id)
    && (message.createdAt > openedThroughAt
      || (message.createdAt === openedThroughAt && lastOpeningIndex >= 0 && index > lastOpeningIndex))
  ));
  return [...retained, ...appended];
}
