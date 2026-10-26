import type { ChatCoreMutationEnvelope } from './syncChatCore';
import {
  BEHAVIOR_ROUTING_FIELDS,
  buildBehaviorRoutingMutation,
  parseBehaviorRoutingStorageProjection,
  type BehaviorRoutingField,
  type BehaviorRoutingProjection,
} from './syncBehaviorRouting';
import type { PlainMutationV1 } from './syncProtocol';

export const BEHAVIOR_ROUTING_STORAGE_KEY =
  'junluo.baiyunBehavior.routing' as const;
export const BEHAVIOR_ROUTING_GLOBAL_KEYS = Object.freeze([
  BEHAVIOR_ROUTING_STORAGE_KEY,
] as const);

export type BehaviorRoutingStorageChange =
  | { kind: 'set'; key: string; value: string }
  | { kind: 'remove'; key: string };

export type BehaviorRoutingStorageReadPort = {
  getItem(key: string): Promise<string | null>;
};

export type BehaviorRoutingEnvelopeFactory = (
  entity: {
    domain: 'behavior';
    type: 'logical-route';
    id: BehaviorRoutingField;
  },
) => Promise<ChatCoreMutationEnvelope>;

export function isBehaviorRoutingGlobalStorageKey(key: string) {
  return key === BEHAVIOR_ROUTING_STORAGE_KEY;
}

function sameField(
  left: BehaviorRoutingProjection,
  right: BehaviorRoutingProjection,
  field: BehaviorRoutingField,
) {
  return left[field] === right[field];
}

export async function deriveBehaviorRoutingMutationsForStorageChanges(
  input: {
    changes: readonly BehaviorRoutingStorageChange[];
    reader: BehaviorRoutingStorageReadPort;
    capturedAt: number;
    envelopeFactory: BehaviorRoutingEnvelopeFactory;
  },
): Promise<PlainMutationV1[]> {
  const mutations: PlainMutationV1[] = [];
  for (const change of input.changes) {
    if (!isBehaviorRoutingGlobalStorageKey(change.key)) continue;
    const previousRaw = await input.reader.getItem(change.key);
    if (change.kind === 'remove') {
      if (previousRaw === null) continue;
      for (const field of BEHAVIOR_ROUTING_FIELDS) {
        const envelope = await input.envelopeFactory({
          domain: 'behavior',
          type: 'logical-route',
          id: field,
        });
        mutations.push(buildBehaviorRoutingMutation({
          envelope,
          field,
          operation: 'delete',
        }));
      }
      continue;
    }
    const next = parseBehaviorRoutingStorageProjection(change.value);
    const previous = previousRaw === null
      ? null
      : parseBehaviorRoutingStorageProjection(previousRaw);
    for (const field of BEHAVIOR_ROUTING_FIELDS) {
      if (previous && sameField(previous, next, field)) continue;
      const envelope = await input.envelopeFactory({
        domain: 'behavior',
        type: 'logical-route',
        id: field,
      });
      mutations.push(buildBehaviorRoutingMutation({
        envelope,
        field,
        operation: 'upsert',
        value: next[field],
      }));
    }
  }
  return mutations;
}
