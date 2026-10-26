import type { BaiyunContinuityEvidenceKind } from '../ai/behavior/continuityEvent';

export const JUNLUO_MEMORY_DATA_LAYERS = [
  'historical_memory',
  'current_state',
  'continuity_event',
  'source_evidence',
] as const;

export type JunLuoMemoryDataLayer = typeof JUNLUO_MEMORY_DATA_LAYERS[number];

export type JunLuoMemoryDataReference =
  | { layer: 'historical_memory'; targetKind: 'memory'; targetId: string }
  | { layer: 'current_state'; targetKind: 'memory_current_state'; targetId: string }
  | { layer: 'continuity_event'; targetKind: 'continuity_event'; targetId: string }
  | {
    layer: 'source_evidence';
    targetKind: BaiyunContinuityEvidenceKind;
    targetId: string;
  };

export type MemoryContinuityContextLink =
  | { relation: 'memory'; targetKind: 'memory'; targetId: string }
  | {
    relation: 'current_state';
    targetKind: 'memory_current_state';
    targetId: string;
  };

export const JUNLUO_MEMORY_LAYER_POLICIES = {
  historical_memory: {
    storage: 'memories',
    responsibility: 'what_happened',
    lifecycleOwner: 'memory_record',
    mayCompleteContinuityEvent: false,
    maySatisfyCompletionRule: false,
    allowsCrossLayerMutation: false,
  },
  current_state: {
    storage: 'memory_current_states',
    responsibility: 'what_is_valid_now',
    lifecycleOwner: 'current_state',
    mayCompleteContinuityEvent: false,
    maySatisfyCompletionRule: false,
    allowsCrossLayerMutation: false,
  },
  continuity_event: {
    storage: 'continuity_events',
    responsibility: 'what_remains_unfinished',
    lifecycleOwner: 'continuity_event',
    mayCompleteContinuityEvent: true,
    maySatisfyCompletionRule: false,
    allowsCrossLayerMutation: false,
  },
  source_evidence: {
    storage: 'continuity_event_transitions_and_links',
    responsibility: 'what_supports_the_judgement',
    lifecycleOwner: 'none',
    mayCompleteContinuityEvent: false,
    maySatisfyCompletionRule: true,
    allowsCrossLayerMutation: false,
  },
} as const satisfies Readonly<Record<JunLuoMemoryDataLayer, {
  storage: string;
  responsibility: string;
  lifecycleOwner: string;
  mayCompleteContinuityEvent: boolean;
  maySatisfyCompletionRule: boolean;
  allowsCrossLayerMutation: false;
}>>;

function uniqueIds(ids: readonly string[] | undefined) {
  return [...new Set((ids ?? []).map((id) => id.trim()).filter(Boolean))];
}

export function buildContinuityMemoryLinks(input: {
  memoryIds?: readonly string[];
  currentStateIds?: readonly string[];
}): MemoryContinuityContextLink[] {
  return [
    ...uniqueIds(input.memoryIds).map((targetId) => ({
      relation: 'memory' as const,
      targetKind: 'memory' as const,
      targetId,
    })),
    ...uniqueIds(input.currentStateIds).map((targetId) => ({
      relation: 'current_state' as const,
      targetKind: 'memory_current_state' as const,
      targetId,
    })),
  ];
}
