export const BODY_SIGNAL_SUPPORT_DOORBELL_INSTRUCTION =
  '这次的记录让 I 想留意一下，看看 you 现在感觉怎么样。';
export const BODY_SIGNAL_CONCERN_DOORBELL_INSTRUCTION =
  '这次的记录让 I 有些担心，想先看看 you 现在感觉怎么样。';

export type BodySignalCareDoorbellCandidate = {
  id: string;
  observedAt: number;
  severity: 'concern' | 'observe' | 'support';
};

export type BodySignalCareDoorbellPreparation = {
  eventIds: string[];
  periodIds?: string[];
  sources?: Array<{ kind: 'heart' | 'period'; id: string; version: string }>;
  handledSources?: string[];
  instruction: string;
  severity?: 'concern' | 'support';
};

export const EMPTY_BODY_SIGNAL_CARE_DOORBELL: BodySignalCareDoorbellPreparation = {
  eventIds: [],
  instruction: '',
};

export function selectBodySignalCareDoorbell(
  events: readonly BodySignalCareDoorbellCandidate[],
): BodySignalCareDoorbellPreparation {
  const eligible = events.filter((event) => (
    event.severity === 'concern' || event.severity === 'support'
  ));
  const eventIds = [...new Set(eligible.map((event) => event.id).filter(Boolean))];
  if (eventIds.length === 0) return { ...EMPTY_BODY_SIGNAL_CARE_DOORBELL };
  const severity = eligible.some((event) => event.severity === 'concern')
    ? 'concern' as const
    : 'support' as const;
  return {
    eventIds,
    instruction: severity === 'concern'
      ? BODY_SIGNAL_CONCERN_DOORBELL_INSTRUCTION
      : BODY_SIGNAL_SUPPORT_DOORBELL_INSTRUCTION,
    severity,
  };
}
