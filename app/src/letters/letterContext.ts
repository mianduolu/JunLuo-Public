import {
  loadBaiyunPendingShareExchanges,
  registerBaiyunPendingShareExchange,
  resolveBaiyunPendingShareResponses,
} from '../ai/behavior/actionShareResponseStore';
import type { AiConnection } from '../ai/types';
import { PRIMARY_CHAT_SESSION_ID } from '../chat/primaryChat';
import {
  canCommitBackupRestoreDataEpoch,
  captureBackupRestoreDataEpoch,
  runBackupRestoreDataEpochCommit,
} from '../backup/backupRestoreCoordinator';
import { getLetterMemoryParts, type LetterMemoryPart } from './letterMemorySource';
import { loadLetters, type LetterEntry } from './letterStore';

export { getLetterContextMessageId } from './letterMemorySource';

type LetterContextOptions = {
  continuationAi?: { apiKey: string; connection: AiConnection };
  dataEpoch?: number | null;
};

const contextWrites = new Map<string, Promise<LetterEntry | null>>();

function contextBody(part: LetterMemoryPart) {
  const label = part.label === '未来信' ? '【白云小姐写给未来的我的信】'
    : part.part === 'reply' ? (part.role === 'I' ? '【白云小姐的回信】' : '【给白云小姐的回信】')
      : part.role === 'you' ? '【写给白云小姐的信】' : '【白云小姐寄来的信】';
  return `${label}\n${part.content}`;
}

async function persistLetterContext(letterId: string, options: LetterContextOptions) {
  const dataEpoch = options.dataEpoch === undefined ? captureBackupRestoreDataEpoch() : options.dataEpoch;
  if (dataEpoch === null || !canCommitBackupRestoreDataEpoch(dataEpoch)) return null;
  let letter = (await loadLetters()).find(item => item.id === letterId);
  if (!letter) return null;
  // Memory registration and pending shares remain independent, retryable local writes.
  const { registerLetterMemoryParts } = await import('../memory/letterMemoryIngestion');
  let registrationError: unknown;
  await registerLetterMemoryParts(letter, dataEpoch).catch((error: unknown) => { registrationError = error; });
  for (const part of getLetterMemoryParts(letter)) {
    const assertSource = async () => {
      if (!canCommitBackupRestoreDataEpoch(dataEpoch)) throw new Error('letter-context-restore-changed');
      const latest = (await loadLetters()).find(item => item.id === letterId);
      const current = latest && getLetterMemoryParts(latest).find(item => item.part === part.part);
      if (!current || current.sourceHash !== part.sourceHash) throw new Error('letter-context-source-changed');
      return latest!;
    };
    letter = await assertSource();
    if (part.part === 'original' && part.role === 'I' && !letter.replyContent) {
      await registerBaiyunPendingShareExchange({ sessionId: PRIMARY_CHAT_SESSION_ID,
        origin: 'letter', invitationKind: 'self_driven', sourceMessageIds: [part.messageId],
        responseDriveKeys: part.label === '未来信' ? ['reflection'] : ['reflection', 'social'],
        excerpt: contextBody(part),
      });
    }
    if (part.part === 'reply' && part.role === 'you'
      && letter.kind === 'exchange' && letter.direction === 'ai-to-you') {
      const original = getLetterMemoryParts(letter).find(item => item.part === 'original' && item.role === 'I');
      if (!original) continue;
      const responses = (await loadBaiyunPendingShareExchanges())
        .filter(record => record.state === 'waiting'
          && (record.origin === 'letter' || record.origin === 'chat_action')
          && record.sourceMessageIds.length === 1 && record.sourceMessageIds[0] === original.messageId)
        .map(record => ({ pendingShareId: record.id, state: 'engaged' as const }));
      if (!responses.length) continue;
      await runBackupRestoreDataEpochCommit(dataEpoch, () => resolveBaiyunPendingShareResponses({
        responses, responseMessageId: part.messageId, sessionId: PRIMARY_CHAT_SESSION_ID,
        now: part.createdAt,
        canCommit: async () => {
          if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return false;
          const latest = (await loadLetters()).find(item => item.id === letterId);
          if (!latest || latest.kind !== 'exchange' || latest.direction !== 'ai-to-you') return false;
          const currentParts = getLetterMemoryParts(latest);
          return canCommitBackupRestoreDataEpoch(dataEpoch)
            && currentParts.some(item => item.part === 'original' && item.role === 'I'
              && item.messageId === original.messageId && item.sourceHash === original.sourceHash)
            && currentParts.some(item => item.part === 'reply' && item.role === 'you'
              && item.messageId === part.messageId && item.sourceHash === part.sourceHash);
        },
      }));
    }
  }
  if (registrationError) throw registrationError;
  return letter;
}

export async function persistDeliveredLetterContext(letter: LetterEntry, options: LetterContextOptions = {}) {
  const previous = contextWrites.get(letter.id) ?? Promise.resolve(null);
  const current = previous.catch(() => null).then(() => persistLetterContext(letter.id, options));
  contextWrites.set(letter.id, current);
  try { return await current; }
  finally { if (contextWrites.get(letter.id) === current) contextWrites.delete(letter.id); }
}

export async function persistOpenedFutureLetterContext(letter: LetterEntry, options: LetterContextOptions = {}) {
  if (letter.kind !== 'future-self' || letter.openedAt === undefined) return letter;
  return persistDeliveredLetterContext(letter, options);
}

export async function recoverLetterContexts(dataEpoch: number) {
  for (const letter of await loadLetters()) {
    if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return;
    if (getLetterMemoryParts(letter).length) {
      await persistDeliveredLetterContext(letter, { dataEpoch }).catch(() => undefined);
    }
  }
}
