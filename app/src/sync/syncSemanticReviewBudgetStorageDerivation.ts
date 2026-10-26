import type { BaiyunSemanticReviewEntry } from '../ai/behavior/actionBudget';
import type { ChatCoreMutationEnvelope } from './syncChatCore';
import {
  assertSemanticReviewEntry,
  buildSemanticReviewBudgetMutation,
  semanticReviewBudgetEntityId,
} from './syncSemanticReviewBudget';
import type { PlainMutationV1 } from './syncProtocol';

export const SEMANTIC_REVIEW_BUDGET_STORAGE_KEY =
  'junluo.baiyunBehavior.semanticReviewBudget' as const;
export const SEMANTIC_REVIEW_BUDGET_GLOBAL_KEYS = Object.freeze([
  SEMANTIC_REVIEW_BUDGET_STORAGE_KEY,
] as const);

export type SemanticReviewBudgetStorageChange =
  | { kind: 'set'; key: string; value: string }
  | { kind: 'remove'; key: string };

export type SemanticReviewBudgetStorageReadPort = {
  getItem(key: string): Promise<string | null>;
};

export type SemanticReviewBudgetEnvelopeFactory = (
  entity: {
    domain: 'usage';
    type: 'semantic-review-budget';
    id: string;
  },
) => Promise<ChatCoreMutationEnvelope>;

export type SemanticReviewRemoteAccountResolver = (
  connectionId: string,
) => string | null;

type GlobalEntry = {
  entityId: string;
  localDate: string;
  remoteAccountId: string;
  entry: BaiyunSemanticReviewEntry;
};

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function globalEntries(input: {
  raw: string | null;
  sourceDeviceId: string;
  resolveRemoteAccountId: SemanticReviewRemoteAccountResolver;
}) {
  if (!input.raw) return [] as GlobalEntry[];
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.raw) as unknown;
  } catch {
    throw new Error('semantic review budget storage 不是有效 JSON。');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('semantic review budget storage 必须是对象。');
  }
  const candidate = parsed as {
    localDate?: unknown;
    entries?: unknown;
  };
  if (
    typeof candidate.localDate !== 'string'
    || !/^\d{4}-\d{2}-\d{2}$/u.test(candidate.localDate)
  ) {
    throw new Error('semantic review budget localDate 无效。');
  }
  if (!Array.isArray(candidate.entries)) return [] as GlobalEntry[];
  const seen = new Set<string>();
  return candidate.entries.flatMap((value) => {
    try {
      assertSemanticReviewEntry(value);
    } catch {
      return [];
    }
    const entry = value as BaiyunSemanticReviewEntry;
    if (!entry.connectionId) return [];
    const remoteAccountId = input.resolveRemoteAccountId(
      entry.connectionId,
    );
    if (!remoteAccountId || remoteAccountId !== entry.connectionId) {
      return [];
    }
    const entityId = semanticReviewBudgetEntityId(
      input.sourceDeviceId,
      entry.id,
    );
    if (seen.has(entityId)) return [];
    seen.add(entityId);
    return [{
      entityId,
      localDate: candidate.localDate as string,
      remoteAccountId,
      entry,
    }];
  });
}

export function isSemanticReviewBudgetGlobalStorageKey(key: string) {
  return key === SEMANTIC_REVIEW_BUDGET_STORAGE_KEY;
}

export async function deriveSemanticReviewBudgetMutationsForStorageChanges(
  input: {
    changes: readonly SemanticReviewBudgetStorageChange[];
    reader: SemanticReviewBudgetStorageReadPort;
    sourceDeviceId: string;
    resolveRemoteAccountId: SemanticReviewRemoteAccountResolver;
    capturedAt: number;
    envelopeFactory: SemanticReviewBudgetEnvelopeFactory;
  },
): Promise<PlainMutationV1[]> {
  const mutations: PlainMutationV1[] = [];
  for (const change of input.changes) {
    if (!isSemanticReviewBudgetGlobalStorageKey(change.key)) continue;
    if (change.kind === 'remove') continue;
    const previous = globalEntries({
      raw: await input.reader.getItem(change.key),
      sourceDeviceId: input.sourceDeviceId,
      resolveRemoteAccountId: input.resolveRemoteAccountId,
    });
    const previousById = new Map(
      previous.map((item) => [item.entityId, item]),
    );
    const next = globalEntries({
      raw: change.value,
      sourceDeviceId: input.sourceDeviceId,
      resolveRemoteAccountId: input.resolveRemoteAccountId,
    });
    for (const item of next) {
      const before = previousById.get(item.entityId);
      if (before && stableJson(before) === stableJson(item)) continue;
      const envelope = await input.envelopeFactory({
        domain: 'usage',
        type: 'semantic-review-budget',
        id: item.entityId,
      });
      mutations.push(buildSemanticReviewBudgetMutation({
        envelope,
        localDate: item.localDate,
        remoteAccountId: item.remoteAccountId,
        entry: item.entry,
      }));
    }
  }
  return mutations;
}
