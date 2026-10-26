import type { SubjectiveMessage } from '../ai/subjectiveMessages';

export type ScheduleMessageDeliveryResult = {
  inserted: number;
  messages: SubjectiveMessage[];
};

export const emptyScheduleMessageDelivery = (): ScheduleMessageDeliveryResult => ({ inserted: 0, messages: [] });
