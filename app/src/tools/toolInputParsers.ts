import type { ExpenseDraft } from '../expense/expenseStore';
import type { MemoryDraft } from '../memory/memoryStore';
import type { ScheduleDraft } from '../schedule/scheduleStore';
import { parseTodoDraftsFromText } from '../schedule/schedulePlanner';
import type { TodoDraft } from '../schedule/todoStore';

export function todoDraftToToolInput(draft: TodoDraft): Record<string, unknown> {
  return {
    title: draft.title,
    notes: draft.notes,
    plannedForDate: draft.plannedForDate,
    priority: draft.priority,
    quadrant: draft.quadrant,
    category: draft.category,
    estimatedMinutes: draft.estimatedMinutes,
    reminderMode: draft.reminderMode,
  };
}

export function scheduleDraftToToolInput(draft: ScheduleDraft): Record<string, unknown> {
  return {
    title: draft.title,
    startAt: draft.startAt,
    endAt: draft.endAt,
    notes: draft.notes,
    reminderMinutesBefore: draft.reminderMinutesBefore,
    recurrence: draft.recurrence,
    reminderText: draft.reminderText,
    reminderIntensity: draft.reminderIntensity,
    companionEnabled: draft.companionEnabled,
  };
}

export function expenseDraftToToolInput(draft: ExpenseDraft): Record<string, unknown> {
  return {
    amount: draft.amount,
    type: draft.type,
    category: draft.category,
    note: draft.note,
    occurredAt: draft.occurredAt,
  };
}

export function memoryDraftToToolInput(draft: MemoryDraft): Record<string, unknown> {
  return {
    content: draft.content,
    title: draft.title,
    domain: draft.domain,
    tags: draft.tags,
    recallCues: draft.recallCues,
    importance: draft.importance,
    valence: draft.valence,
    arousal: draft.arousal,
    pinned: draft.pinned,
    rememberedReason: draft.rememberedReason,
    source: draft.source,
    sourceType: draft.sourceType,
    sourceStartAt: draft.sourceStartAt,
    sourceEndAt: draft.sourceEndAt,
  };
}

export function parseTodoToolInputsFromText(text: string) {
  return parseTodoDraftsFromText(text).map(todoDraftToToolInput);
}

export function parseExpenseToolInputFromText(_text: string) {
  // Kept for old callers; free-form chat can no longer manufacture a ledger write.
  return null;
}
