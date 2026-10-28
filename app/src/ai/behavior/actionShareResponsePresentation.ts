import {
  getBaiyunActiveShareExchanges,
  getBaiyunRecentEndedShareExchanges,
  type BaiyunPendingShareExchange,
} from './actionShareResponse';

type LetterSource = { id: string; chatMessageIds?: readonly string[] };

/** Display projection only; the original share ledger and letter history are untouched. */
export function projectBaiyunShareResponsePresentation(
  records: readonly BaiyunPendingShareExchange[],
  letters: readonly LetterSource[],
  sessionId?: string,
  now = Date.now(),
) {
  const existingLetterSources = new Set(letters.flatMap(letter => [
    `letter-${letter.id}-original`, `letter-${letter.id}-reply`, ...(letter.chatMessageIds ?? []),
  ]));
  const visible = records.filter(record => {
    if (record.origin === 'letter') {
      return record.sourceMessageIds.some(id => existingLetterSources.has(id));
    }
    if (record.origin === 'chat_action' && record.sourceMessageIds.length
      && record.sourceMessageIds.every(id => /^letter-.+-(original|reply)$/u.test(id))) {
      return record.sourceMessageIds.some(id => existingLetterSources.has(id));
    }
    return true;
  });
  return {
    active: getBaiyunActiveShareExchanges(visible, sessionId, now),
    recentEnded: getBaiyunRecentEndedShareExchanges(visible, sessionId, now),
  };
}
