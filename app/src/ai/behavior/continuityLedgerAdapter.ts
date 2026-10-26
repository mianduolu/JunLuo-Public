import {
  isBaiyunRetiredActionIntentId,
  type BaiyunActionSelectionContext,
} from './actionIntent';
import {
  canBaiyunSemanticSignalCreateCandidate,
  getIntentForBaiyunSemanticSignal,
  type BaiyunSemanticEvidenceResult,
} from './actionSemantic';
import type { BaiyunOpenSituationEvent } from './actionSituation';
import {
  deriveBaiyunContinuityTimingState,
  type BaiyunContinuityEvent,
} from './continuityEvent';
import {
  advanceDueBaiyunContinuityEvents,
  listBaiyunContinuityLinks,
  listOpenBaiyunContinuityEvents,
} from './continuityLedger';

export interface BaiyunOpenEventPlanningEligibility {
  eventId: string;
  actionable: boolean;
  reason:
    | 'direct_reply'
    | 'current_matching_signal'
    | 'resolution_progressed'
    | 'followup_due'
    | 'structured_source_active'
    | 'awaiting_response_quiet'
    | 'stale_source'
    | 'awaiting_confirmation';
}

type BaiyunContinuityTurnContext = {
  currentMessageId?: string;
  semanticEvidence?: BaiyunSemanticEvidenceResult;
  directReplyEventIds?: ReadonlySet<string>;
  progressedEventIds?: ReadonlySet<string>;
  activeStructuredSourceIds?: ReadonlySet<string>;
};

function intentForContinuityEvent(event: BaiyunContinuityEvent) {
  if (event.kind === 'relationship_rupture') {
    if (event.stage === 'rupture_detected') return 'retain' as const;
    if (event.stage === 'paused_for_return') return null;
    return 'repair' as const;
  }
  if (event.kind === 'return_commitment') {
    return event.stage === 'due' || event.stage === 'waiting_return_delivery'
      ? 'rest_return' as const
      : null;
  }
  if (event.kind === 'care_process' && event.stage === 'follow_up_due') {
    return 'care_check' as const;
  }
  if (event.kind === 'cross_day_life' && event.stage === 'follow_up_due') {
    return 'care_check' as const;
  }
  return event.primaryIntent;
}

function scoreForContinuityEvent(event: BaiyunContinuityEvent, now: number) {
  const timing = deriveBaiyunContinuityTimingState(event, now);
  if (event.kind === 'care_process' && timing === 'due') return 0.99;
  if (event.kind === 'relationship_rupture') return 0.98;
  if (event.kind === 'return_commitment' && timing === 'due') return 0.97;
  if (timing === 'due') return 0.95;
  if (event.kind === 'closeness_request') return 0.94;
  return 0.91;
}

function priorityForContinuityEvent(event: BaiyunContinuityEvent, now: number) {
  const timing = deriveBaiyunContinuityTimingState(event, now);
  if (
    event.kind === 'care_process'
    && timing === 'due'
    && (event.primaryIntent === 'interrupt' || event.primaryIntent === 'protect')
  ) {
    return 'authorized_urgent_care_or_protection' as const;
  }
  return 'open_continuity_obligation' as const;
}

export function adaptBaiyunContinuityEventsToSituation(
  events: readonly BaiyunContinuityEvent[],
  now = Date.now(),
  eligibleEventIds?: ReadonlySet<string>,
): BaiyunOpenSituationEvent[] {
  return events.flatMap((event) => {
    if (isBaiyunRetiredActionIntentId(event.primaryIntent)) return [];
    if (eligibleEventIds && !eligibleEventIds.has(event.id)) return [];
    if (event.kind === 'shared_task' && event.stage === 'awaiting_shared_confirmation') {
      return [];
    }
    const intentId = intentForContinuityEvent(event);
    if (!intentId) return [];
    return [{
      id: event.id,
      intentId,
      openedAt: event.occurredAt,
      evidenceCode: `continuity_${event.kind}_${event.stage}`,
      score: scoreForContinuityEvent(event, now),
      priority: priorityForContinuityEvent(event, now),
      continuityKind: event.kind,
      continuityStage: event.stage,
      nextActionAt: event.nextActionAt,
      focusExcerpt: event.focusExcerpt,
    }];
  });
}

function normalizeFocus(text: string | undefined) {
  return (text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function eventMatchesCurrentSignal(
  event: BaiyunContinuityEvent,
  turn: BaiyunContinuityTurnContext,
) {
  const currentMessageId = turn.currentMessageId;
  if (!currentMessageId || !turn.semanticEvidence) return false;
  const focus = normalizeFocus(event.focusExcerpt);
  if (focus.length < 2) return false;
  return turn.semanticEvidence.signals.some((signal) => {
    if (!canBaiyunSemanticSignalCreateCandidate(signal, currentMessageId)) return false;
    if (getIntentForBaiyunSemanticSignal(signal) !== intentForContinuityEvent(event)) return false;
    const evidence = normalizeFocus(signal.evidence);
    return evidence.length >= 2 && (focus.includes(evidence) || evidence.includes(focus));
  });
}

export function getBaiyunOpenEventPlanningEligibility(
  event: BaiyunContinuityEvent,
  turn: BaiyunContinuityTurnContext = {},
): BaiyunOpenEventPlanningEligibility {
  if (event.kind === 'shared_task' && event.stage === 'awaiting_shared_confirmation') {
    return { eventId: event.id, actionable: false, reason: 'awaiting_confirmation' };
  }
  if (turn.directReplyEventIds?.has(event.id)) {
    return { eventId: event.id, actionable: true, reason: 'direct_reply' };
  }
  if (turn.progressedEventIds?.has(event.id)) {
    return { eventId: event.id, actionable: true, reason: 'resolution_progressed' };
  }
  if (event.stage === 'follow_up_due' || event.stage === 'due') {
    return { eventId: event.id, actionable: true, reason: 'followup_due' };
  }
  if (turn.activeStructuredSourceIds?.has(event.source.sourceId)) {
    return { eventId: event.id, actionable: true, reason: 'structured_source_active' };
  }
  if (eventMatchesCurrentSignal(event, turn)) {
    return { eventId: event.id, actionable: true, reason: 'current_matching_signal' };
  }
  if (
    (event.kind === 'care_process' || event.kind === 'cross_day_life')
    && (event.stage === 'awaiting_response' || event.stage === 'intervention_paused')
  ) {
    return { eventId: event.id, actionable: false, reason: 'awaiting_response_quiet' };
  }
  if (
    (event.kind === 'care_process' || event.kind === 'cross_day_life')
    && event.source.kind !== 'global_relationship'
    && event.source.kind !== 'theater'
    && event.stage !== 'signal_seen'
    && event.stage !== 'preparing_check'
    && event.stage !== 'reminded_or_interrupted'
    && event.stage !== 'recorded'
  ) {
    return { eventId: event.id, actionable: false, reason: 'stale_source' };
  }
  return { eventId: event.id, actionable: true, reason: 'current_matching_signal' };
}

export function buildBaiyunContinuitySelectionContext(
  events: readonly BaiyunContinuityEvent[],
  now = Date.now(),
): BaiyunActionSelectionContext {
  const active = events.filter(
    (event) => (
      !isBaiyunRetiredActionIntentId(event.primaryIntent)
      && (event.status === 'open' || event.status === 'waiting')
    ),
  );
  const relationshipEvents = active.filter((event) => event.kind === 'relationship_rupture');
  const careEvents = active.filter((event) => event.kind === 'care_process');
  const dueCare = careEvents.some(
    (event) => deriveBaiyunContinuityTimingState(event, now) === 'due',
  );
  return {
    relationshipRuptureActive: relationshipEvents.some(
      (event) => event.stage === 'rupture_detected',
    ),
    unfinishedRetainOrRepair: relationshipEvents.length > 0,
    explicitAffectionRequestActive: active.some(
      (event) => event.kind === 'closeness_request'
        && (event.primaryIntent === 'affection' || event.primaryIntent === 'desire'),
    ),
    urgentCareOrProtectionActive: dueCare,
    higherPriorityCareOrProtectionActive: dueCare,
    userHighCareNeed: careEvents.some(
      (event) => event.primaryIntent === 'soothe'
        || event.primaryIntent === 'interrupt'
        || event.primaryIntent === 'protect',
    ),
    authorizedInterruptionExecuting: careEvents.some(
      (event) => event.primaryIntent === 'interrupt'
        && event.stage === 'reminded_or_interrupted'
        && event.permissionRequirements.includes('care_preauthorization'),
    ),
  };
}

export function buildBaiyunContinuityPlanningContext(input: {
  events: readonly BaiyunContinuityEvent[];
  now?: number;
  currentMessageId?: string;
  semanticEvidence?: BaiyunSemanticEvidenceResult;
  directReplyEventIds?: ReadonlySet<string>;
  progressedEventIds?: ReadonlySet<string>;
  activeStructuredSourceIds?: ReadonlySet<string>;
}) {
  const now = input.now ?? Date.now();
  const events = input.events.filter((event) => (
    !isBaiyunRetiredActionIntentId(event.primaryIntent)
  ));
  const eligibility = events.map((event) => getBaiyunOpenEventPlanningEligibility(event, input));
  const eligibleEventIds = new Set(
    eligibility.filter((entry) => entry.actionable).map((entry) => entry.eventId),
  );
  const eligibleEvents = events.filter((event) => eligibleEventIds.has(event.id));
  return {
    events,
    allOpenEvents: adaptBaiyunContinuityEventsToSituation(events, now),
    openEvents: adaptBaiyunContinuityEventsToSituation(events, now, eligibleEventIds),
    eligibility,
    selectionContext: buildBaiyunContinuitySelectionContext(eligibleEvents, now),
  };
}

export async function resolveBaiyunDirectReplyContinuityEventIds(
  events: readonly BaiyunContinuityEvent[],
  directReplyTargetId?: string,
) {
  if (!directReplyTargetId) return new Set<string>();
  const matched = await Promise.all(events.map(async (event) => {
    if (event.source.sourceId === directReplyTargetId) return event.id;
    const links = await listBaiyunContinuityLinks(event.id);
    return links.some(
      (link) => link.relation === 'message' && link.targetId === directReplyTargetId,
    ) ? event.id : undefined;
  }));
  return new Set(matched.filter((eventId): eventId is string => Boolean(eventId)));
}

export async function loadBaiyunContinuityPlanningContext(now = Date.now()) {
  const events = await advanceDueBaiyunContinuityEvents(now);
  return buildBaiyunContinuityPlanningContext({
    events,
    now,
  });
}

export async function loadBaiyunContinuityEventsWithoutAdvancing() {
  return listOpenBaiyunContinuityEvents();
}
