import {
  AI_CALL_BUDGET_KEY,
  isRemoteAiCallBudgetRecord,
  parseAiCallBudgetState,
} from '../ai/aiCallBudgetStorage';
import type { ChatCoreMutationEnvelope } from './syncChatCore';
import {
  assertRemoteBudgetEventRecord,
  buildRemoteBudgetEventMutation,
  mergeRemoteBudgetEventMetadata,
  type RemoteBudgetEventRecord,
} from './syncRemoteBudget';
import type { PlainMutationV1 } from './syncProtocol';

export const REMOTE_BUDGET_GLOBAL_KEYS = Object.freeze([
  AI_CALL_BUDGET_KEY,
] as const);

export type RemoteBudgetStorageChange =
  | { kind: 'set'; key: string; value: string }
  | { kind: 'remove'; key: string };

export type RemoteBudgetStorageReadPort = {
  getItem(key: string): Promise<string | null>;
};

export type RemoteBudgetEnvelopeFactory = (
  entity: {
    domain: 'usage';
    type: 'remote-account-budget';
    id: string;
  },
) => Promise<ChatCoreMutationEnvelope>;

function eventOf(
  record: ReturnType<typeof parseAiCallBudgetState>['records'][number],
): RemoteBudgetEventRecord {
  if (!isRemoteAiCallBudgetRecord(record)) {
    throw new Error('device-local AI budget record 不能进入远程账本。');
  }
  const value = {
    id: record.id,
    endedAt: record.endedAt,
    kind: record.kind,
    priority: record.priority,
    remoteAccountId: record.remoteAccountId,
    startedAt: record.startedAt,
    ...(record.purpose ? { purpose: record.purpose } : {}),
    ...(record.costRestricted ? { costRestricted: true as const } : {}),
  };
  assertRemoteBudgetEventRecord(record.id, value);
  return value;
}

export function isRemoteBudgetGlobalStorageKey(key: string) {
  return key === AI_CALL_BUDGET_KEY;
}

export async function deriveRemoteBudgetMutationsForStorageChanges(input: {
  changes: readonly RemoteBudgetStorageChange[];
  reader: RemoteBudgetStorageReadPort;
  capturedAt: number;
  envelopeFactory: RemoteBudgetEnvelopeFactory;
}): Promise<PlainMutationV1[]> {
  const mutations: PlainMutationV1[] = [];
  for (const change of input.changes) {
    if (!isRemoteBudgetGlobalStorageKey(change.key)) continue;
    if (change.kind === 'remove') continue;
    const previous = parseAiCallBudgetState(
      await input.reader.getItem(change.key),
      input.capturedAt,
    );
    const next = parseAiCallBudgetState(change.value, input.capturedAt);
    const previousEvents = new Map(
      previous.records
        .filter(isRemoteAiCallBudgetRecord)
        .map((record) => [record.id, eventOf(record)]),
    );
    for (const record of next.records.filter(isRemoteAiCallBudgetRecord)) {
      let event = eventOf(record);
      const existing = previousEvents.get(event.id);
      if (existing) {
        const merged = mergeRemoteBudgetEventMetadata(existing, event);
        if (!merged) {
          throw new Error(
            `remote budget append-only event ${event.id} 被原地改写。`,
          );
        }
        if (merged.purpose === existing.purpose && merged.costRestricted === existing.costRestricted
          && merged.endedAt === existing.endedAt) continue;
        event = merged;
      }
      const envelope = await input.envelopeFactory({
        domain: 'usage',
        type: 'remote-account-budget',
        id: event.id,
      });
      mutations.push(buildRemoteBudgetEventMutation({ envelope, value: event }));
    }
  }
  return mutations;
}
