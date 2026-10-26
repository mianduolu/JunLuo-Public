export type LetterDateTicketCandidate = {
  dateId: string;
  source: 'relationship-date' | 'schedule';
  sourceRecordId: string;
  scheduledAt: number;
  eventTitle: string;
  eventNote?: string;
  annual: boolean;
};

export function sortLetterDateTicketCandidates(
  candidates: readonly LetterDateTicketCandidate[],
) {
  return [...candidates].sort((left, right) => (
    left.scheduledAt - right.scheduledAt
    || (left.source === right.source ? 0 : left.source === 'relationship-date' ? -1 : 1)
    || left.dateId.localeCompare(right.dateId)
  ));
}
