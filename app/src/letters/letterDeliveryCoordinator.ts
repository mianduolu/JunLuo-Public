import type { LetterEntry } from './letterStore';

type DataEpochCommitResult<T> =
  | { committed: false }
  | { committed: true; value: T };

type DueLetterDeliveryDependencies = {
  canCommitDataEpoch: (dataEpoch: number | null) => boolean;
  loadLetters: () => Promise<LetterEntry[]>;
  now?: () => number;
  runDataEpochCommit: <T>(
    dataEpoch: number | null,
    work: () => Promise<T>,
  ) => Promise<DataEpochCommitResult<T>>;
  updateLetter: (letterId: string, patch: Partial<LetterEntry>,
    canUpdate?: (current: LetterEntry) => boolean) => Promise<LetterEntry | null>;
};

export type DueLetterDeliveryOperation = {
  dataEpoch: number | null;
  dueAt: number;
  failureReason: (error: unknown) => string;
  generateReply: (letter: LetterEntry) => Promise<string>;
  onSaved?: (letter: LetterEntry) => Promise<void>;
  notify: (letter: LetterEntry, dataEpoch: number | null) => Promise<unknown>;
  persistContext: (letter: LetterEntry, dataEpoch: number | null) => Promise<unknown>;
  recordDelivery: (letter: LetterEntry) => Promise<unknown>;
};

function findDueLetter(letters: LetterEntry[], letterId: string, dueAt: number) {
  return letters.find((letter) => (
    letter.id === letterId
    && letter.kind === 'exchange'
    && letter.direction === 'you-to-ai'
    && (letter.status === 'waiting_ai' || letter.status === 'failed')
    && (letter.dueAt ?? Infinity) <= dueAt
  )) ?? null;
}

function replySourceKey(letter: LetterEntry) {
  return JSON.stringify([letter.id, letter.kind, letter.direction, letter.createdAt,
    letter.title, letter.content, letter.dueAt]);
}

type RetainedReply = {
  dataEpoch: number | null;
  sourceKey: string;
  previousReply?: string;
  replyContent: string;
  deliveredAt: number;
  onSaved?: DueLetterDeliveryOperation['onSaved'];
};

function isRetainedReplySaved(letter: LetterEntry, reply: RetainedReply) {
  return replySourceKey(letter) === reply.sourceKey && letter.status === 'completed'
    && (letter.replyContent ?? '') === reply.replyContent.trim() && letter.deliveredAt === reply.deliveredAt;
}

export function createDueLetterDeliveryCoordinator(dependencies: DueLetterDeliveryDependencies) {
  const flights = new Map<string, Promise<0 | 1>>();
  // The original usage callback travels only with its paid, unconfirmed reply.
  const retained = new Map<string, RetainedReply>();
  const now = dependencies.now ?? Date.now;

  const pendingLetterIds = (letters: LetterEntry[], dataEpoch: number | null,
    onInvalidated?: (letterId: string) => void) => {
    for (const [id, reply] of retained) {
      const current = letters.find(letter => letter.id === id);
      if (reply.dataEpoch !== dataEpoch || !dependencies.canCommitDataEpoch(reply.dataEpoch)
        || !current || replySourceKey(current) !== reply.sourceKey
        || !isRetainedReplySaved(current, reply) && (current.replyContent !== reply.previousReply
          || !findDueLetter([current], id, Infinity))) {
        retained.delete(id);
        onInvalidated?.(id);
      }
    }
    return [...retained.keys()];
  };

  const deliverOnce = async (
    letterId: string,
    operation: DueLetterDeliveryOperation,
  ): Promise<0 | 1> => {
    const prepared = await dependencies.runDataEpochCommit(operation.dataEpoch, async () => {
      const letters = await dependencies.loadLetters();
      const hadReply = retained.has(letterId);
      pendingLetterIds(letters, operation.dataEpoch);
      if (hadReply && !retained.has(letterId)) return null;
      return retained.has(letterId) ? letters.find(letter => letter.id === letterId) ?? null
        : findDueLetter(letters, letterId, operation.dueAt);
    });
    if (!prepared.committed || !prepared.value) {
      if (!dependencies.canCommitDataEpoch(operation.dataEpoch)) retained.delete(letterId);
      return 0;
    }

    let reply = retained.get(letterId);
    if (!reply) {
      const sourceKey = replySourceKey(prepared.value);
      try {
        const replyContent = await operation.generateReply(prepared.value);
        if (!dependencies.canCommitDataEpoch(operation.dataEpoch)) return 0;
        reply = { dataEpoch: operation.dataEpoch, sourceKey, previousReply: prepared.value.replyContent,
          replyContent, deliveredAt: now(), onSaved: operation.onSaved };
        retained.set(letterId, reply);
      } catch (error) {
        const failureReason = operation.failureReason(error);
        await dependencies.runDataEpochCommit(operation.dataEpoch, async () => {
          const current = findDueLetter(await dependencies.loadLetters(), letterId, operation.dueAt);
          if (!current) return null;
          return dependencies.updateLetter(letterId, { failureReason, status: 'failed' }, letter => (
            dependencies.canCommitDataEpoch(operation.dataEpoch) && replySourceKey(letter) === sourceKey
            && !!findDueLetter([letter], letterId, operation.dueAt)
          ));
        }).catch(() => undefined);
        return 0;
      }
    }

    const draft = reply;
    let delivered: LetterEntry | null = null;
    try {
      const completed = await dependencies.runDataEpochCommit(operation.dataEpoch, async () => {
        const current = (await dependencies.loadLetters()).find(letter => letter.id === letterId);
        if (!current) return null;
        if (isRetainedReplySaved(current, draft)) return current;
        return dependencies.updateLetter(letterId, {
          deliveredAt: draft.deliveredAt,
          failureReason: undefined,
          replyContent: draft.replyContent,
          status: 'completed',
        }, letter => dependencies.canCommitDataEpoch(operation.dataEpoch)
          && replySourceKey(letter) === draft.sourceKey && letter.replyContent === draft.previousReply
          && !!findDueLetter([letter], letterId, operation.dueAt));
      });
      delivered = completed.committed ? completed.value : null;
    } catch (error) {
      // A rejected capture can follow a successful business write. Read it back
      // before retaining the same paid body for a later local-only continuation.
      if (!dependencies.canCommitDataEpoch(operation.dataEpoch)) { retained.delete(letterId); return 0; }
      const letters = await dependencies.loadLetters();
      pendingLetterIds(letters, operation.dataEpoch);
      const current = letters.find(letter => letter.id === letterId);
      if (current && isRetainedReplySaved(current, draft)) delivered = current;
      else if (!retained.has(letterId)) return 0;
      else throw error;
    }
    retained.delete(letterId);
    if (!delivered || !dependencies.canCommitDataEpoch(operation.dataEpoch)) return 0;

    await draft.onSaved?.(delivered).catch(() => undefined);

    await dependencies.runDataEpochCommit(
      operation.dataEpoch,
      () => operation.persistContext(delivered, operation.dataEpoch),
    ).catch(() => undefined);
    await dependencies.runDataEpochCommit(
      operation.dataEpoch,
      () => operation.recordDelivery(delivered),
    ).catch(() => undefined);
    if (dependencies.canCommitDataEpoch(operation.dataEpoch)) {
      await operation.notify(delivered, operation.dataEpoch).catch(() => undefined);
    }
    return 1;
  };

  const deliver = (letterId: string, operation: DueLetterDeliveryOperation) => {
    const existing = flights.get(letterId);
    if (existing) return existing;
    const flight = deliverOnce(letterId, operation);
    flights.set(letterId, flight);
    const clear = () => {
      if (flights.get(letterId) === flight) flights.delete(letterId);
    };
    void flight.then(clear, clear);
    return flight;
  };

  return { deliver, pendingLetterIds };
}
