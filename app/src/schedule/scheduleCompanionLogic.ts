export type ScheduleCompanionEventKind = 'upcoming' | 'timeUp' | 'followUp';

const FIVE_MINUTES_MS = 5 * 60 * 1000;

export function getScheduleCompanionEventSchedule(input: {
  completionFollowUpEnabled: boolean;
  endAt?: number;
  owner?: 'I' | 'you' | 'I 和 you';
  reminderAt: number;
  startReminderEnabled?: boolean;
}) {
  const events: Array<{
    kind: ScheduleCompanionEventKind;
    scheduledAt: number;
  }> = input.startReminderEnabled === false ? [] : [{ kind: 'upcoming', scheduledAt: input.reminderAt }];
  if (input.completionFollowUpEnabled && input.endAt !== undefined) {
    events.push({ kind: 'timeUp', scheduledAt: input.endAt });
    // I-owned and old callers keep their existing schedule. you is observed through normal contact.
    if (!input.owner || input.owner === 'I') events.push({ kind: 'followUp', scheduledAt: input.endAt + FIVE_MINUTES_MS });
  }
  return events;
}

export function getCompanionResponseKinds(kind: ScheduleCompanionEventKind): ScheduleCompanionEventKind[] {
  return kind === 'timeUp' ? ['timeUp', 'followUp'] : [kind];
}
