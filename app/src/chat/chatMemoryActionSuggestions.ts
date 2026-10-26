import type { ScheduleDraft, ScheduleOccurrence } from '../schedule/scheduleStore';
import type { HabitDraft } from '../schedule/habitStore';
import type { TodoDraft } from '../schedule/todoStore';

export type ScheduleReviewAction =
  | {
      draft: ScheduleDraft;
      kind: 'create';
      sourceMemoryIds?: string[];
      sourceReason?: string;
      reviewId: string;
    }
  | {
      draft: TodoDraft;
      kind: 'todo';
      sourceMemoryIds?: string[];
      sourceReason?: string;
      reviewId: string;
    }
  | {
      draft: HabitDraft;
      kind: 'habit';
      sourceMemoryIds?: string[];
      sourceReason?: string;
      reviewId: string;
    }
  | {
      kind: 'cancel';
      occurrence: ScheduleOccurrence;
      sourceMemoryIds?: string[];
      sourceReason?: string;
      reviewId: string;
    };

export function isRetiredMemoryActionReview(review: Pick<ScheduleReviewAction, 'reviewId'>) {
  return review.reviewId.startsWith('memory-action-');
}
