import { loadChatSessionMessage } from '../chat/chatStorage';
import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import { readingMessageRevision } from '../chat/chatReadingReferences';
import { canCommitBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import { parseDayPlanSubmission } from './dayPlanDraft';
import { loadScheduleItemById, loadScheduleOccurrence } from './scheduleStore';
import { loadTodoItemById, loadTodoSteps } from './todoStore';
import { completeScheduleOccurrenceOnce } from './scheduleCompletionOnce';
import { completeTodoItemOnce } from './todoCompletionOnce';
import { settleChatHabitOccurrence, settleChatHabitTodo } from './habitScheduleStore';
import { getScheduleDatabase } from './scheduleDatabase';
import { cancelNotifications } from './scheduleNotifications';
import { prepareChatReminderBatch, sameReminderCandidates, type ChatReminderBatch } from './chatScheduleReminders';
import { createToolSuccessResult, createToolErrorResult } from '../tools/toolResult';
import { createToolError } from '../tools/toolErrors';
import type { JunLuoToolCall, JunLuoToolResult } from '../tools/toolTypes';

export const CHAT_SCHEDULE_COMPLETION_TOOLS = new Set(['schedule.complete_occurrence', 'todo.complete']);
export async function createChatScheduleTurn(input: {
  sourceMessage?: Pick<SubjectiveMessage, 'id' | 'role' | 'content' | 'createdAt' | 'replyTo'>;
  sourceSessionId: string; sourceMessageId: string; dataEpoch: number; signal?: AbortSignal;
  isCurrent?: () => boolean | Promise<boolean>;
}) {
  const occurrences = new Map<string, { title: string; itemId: string; updatedAt: number }>();
  const todos = new Map<string, { title: string; updatedAt: number }>();
  const habits = new Map<string, number>();
  const batches = new Map<string, ChatReminderBatch>();
  let deliveredBatch: ChatReminderBatch | undefined;
  let nextReminderItem = 1;
  const habitTodoSettlements = new Map<string, Awaited<ReturnType<typeof settleChatHabitTodo>>>();
  const current = async () => {
    if (!input.sourceMessage || input.sourceMessage.role !== 'you' || input.signal?.aborted
      || !canCommitBackupRestoreDataEpoch(input.dataEpoch) || input.isCurrent && !await input.isCurrent()) return false;
    const actual = await loadChatSessionMessage(input.sourceSessionId, input.sourceMessageId);
    const same = !!actual && actual.role === 'you' && readingMessageRevision(actual) === readingMessageRevision(input.sourceMessage)
      && JSON.stringify(actual.replyTo) === JSON.stringify(input.sourceMessage.replyTo);
    return same && !input.signal?.aborted && canCommitBackupRestoreDataEpoch(input.dataEpoch) && (!input.isCurrent || await input.isCurrent());
  };
  const observe = (messages: readonly { kind: string; content?: string; callId?: string; toolId?: string }[]) => {
    deliveredBatch = undefined;
    const delivered = new Map<string, ChatReminderBatch>();
    for (const message of messages) {
      if (message.kind !== 'tool_result' || !message.content) continue;
      try {
        const receipt = JSON.parse(message.content);
        if (receipt.dataOmitted) continue;
        if (message.toolId === 'schedule.query_agenda' && receipt.ok) {
          for (const row of receipt.data?.scheduleItems ?? []) if (row.owner !== 'I' && typeof row.updatedAt === 'number') {
            occurrences.set(row.occurrenceId, { title: row.title, itemId: row.itemId, updatedAt: row.updatedAt });
            if (row.habitId && typeof row.habitUpdatedAt === 'number') habits.set(row.habitId, row.habitUpdatedAt);
          }
          for (const row of [...(receipt.data?.scheduledTodos ?? []), ...(receipt.data?.inboxTodos ?? [])])
            if (typeof row.updatedAt === 'number') {
              todos.set(row.id, { title: row.title, updatedAt: row.updatedAt });
              if (row.habitId && typeof row.habitUpdatedAt === 'number') habits.set(row.habitId, row.habitUpdatedAt);
            }
        }
        const batch = batches.get(message.callId ?? '');
        if (receipt.ok && batch && sameReminderCandidates(receipt.data?.reminderCandidates, batch)) delivered.set(message.callId!, batch);
      } catch { /* An omitted or unreadable result grants no target or reminder identity. */ }
    }
    if (delivered.size) deliveredBatch = { mode: 'habit', candidates: [...delivered.values()].flatMap(batch => batch.candidates),
      events: [...delivered.values()].flatMap(batch => batch.events) };
  };
  const completeOccurrence = async (id: string, completedAt: number) => {
    const occurrence = await loadScheduleOccurrence(id);
    if (!occurrence || occurrence.owner === 'I' || occurrence.status === 'cancelled') throw new Error('schedule-target-unavailable');
    if (!await current()) throw new Error('schedule-turn-stale');
    if (occurrence.source === 'habit' && occurrence.habitId) return settleChatHabitOccurrence(id, completedAt, current);
    const result = await completeScheduleOccurrenceOnce(id, completedAt, current);
    if (result.notificationIds.length) await cancelNotifications(result.notificationIds);
    return undefined;
  };
  const completeTodo = async (id: string, completedAt: number, parentOccurrenceId?: string) => {
    const todo = await loadTodoItemById(id, { promoteDue: false });
    if (!todo || todo.type !== 'normal' || ['cancelled', 'expired'].includes(todo.status)) throw new Error('todo-target-unavailable');
    const rows = await (await getScheduleDatabase()).getAllAsync<{ id: string }>(
      "SELECT o.id FROM schedule_occurrences o JOIN schedule_items i ON i.id=o.item_id WHERE i.todo_id=? AND i.owner != 'I' AND o.status='pending' LIMIT 2", id);
    if (rows.length > 1) throw new Error('todo-occurrence-ambiguous');
    const steps = todo.parentTodoId ? [] : await loadTodoSteps(id, parentOccurrenceId ?? todo.parentOccurrenceId ?? rows[0]?.id);
    for (const step of steps) {
      if (!await current()) throw new Error('schedule-turn-stale');
      if (['cancelled', 'expired'].includes(step.status)) continue;
      await completeTodo(step.id, completedAt);
    }
    for (const row of rows) await completeOccurrence(row.id, completedAt);
    if (!await current()) throw new Error('schedule-turn-stale');
    const completed = await completeTodoItemOnce(id, { completedAt, skipGoalCredit: steps.length > 0 }, current);
    if (!todo.parentTodoId && todo.habitId && todo.parentOccurrenceId) {
      habitTodoSettlements.set(id, await settleChatHabitTodo(id, current));
    }
    return completed;
  };
  const habitReminderCandidates = async (callId: string, habit: { completedCount: number; completedAt?: number; nextOccurrence?: { id: string } | null }) => {
    if (!habit.nextOccurrence) return undefined;
    const batch = await prepareChatReminderBatch([habit.nextOccurrence.id], 'habit',
      { completedCount: habit.completedCount, completedAt: habit.completedAt });
    for (const candidate of batch.candidates) candidate.item = nextReminderItem++;
    batches.set(callId, batch);
    return batch.candidates;
  };
  const execute = async (call: JunLuoToolCall): Promise<JunLuoToolResult> => {
    try {
      if (!await current()) throw new Error('schedule-turn-stale');
      if (call.toolId === 'schedule.submit_day_plan') {
        const draft = parseDayPlanSubmission(call.input);
        for (const entry of draft.entries.flatMap(row => [row, ...(row.steps ?? [])])) {
          if (entry.occurrenceId) {
            const expected = occurrences.get(entry.occurrenceId);
            const actual = await loadScheduleOccurrence(entry.occurrenceId);
            const item = actual && await loadScheduleItemById(actual.itemId);
            if (!expected) throw new Error('schedule-target-not-queried');
            if (!actual || !item || expected.itemId !== item.id || expected.updatedAt !== item.updatedAt
              || actual.status !== 'pending' || item.owner === 'I') throw new Error('schedule-target-changed');
            entry.sourceUpdatedAt = expected.updatedAt;
          }
          if (entry.todoId) {
            const expected = todos.get(entry.todoId);
            const actual = await loadTodoItemById(entry.todoId, { promoteDue: false });
            if (!expected || !actual || actual.updatedAt !== expected.updatedAt) throw new Error('todo-target-changed');
            entry.sourceTodoUpdatedAt = expected.updatedAt;
          }
          if (entry.habitId) {
            if (!habits.has(entry.habitId)) throw new Error('habit-target-unavailable');
            entry.sourceHabitUpdatedAt = habits.get(entry.habitId);
          }
        }
        return createToolSuccessResult(call, '', draft);
      }
      const title = typeof call.input.title === 'string' ? call.input.title.trim() : '';
      const completedAt = call.input.completedAt ?? input.sourceMessage!.createdAt;
      if (!Number.isSafeInteger(completedAt) || Number(completedAt) < 0 || Number(completedAt) > input.sourceMessage!.createdAt) throw new Error('completion-time-invalid');
      const outcome = await runBackupRestoreDataEpochCommit(input.dataEpoch, async () => {
        if (!await current()) throw new Error('schedule-turn-stale');
        if (call.toolId === 'todo.complete') {
          const id = String(call.input.todoId ?? '');
          const expected = todos.get(id), actual = await loadTodoItemById(id, { promoteDue: false });
          if (!expected || expected.title !== title || !actual || actual.title !== title
            || actual.status !== 'completed' && actual.updatedAt !== expected.updatedAt) throw new Error('todo-target-changed');
          const todo = await completeTodo(id, Number(completedAt));
          const habit = habitTodoSettlements.get(id);
          return { id, title, status: todo?.status, completedAt: todo?.completedAt,
            ...(habit ? { reminderCandidates: await habitReminderCandidates(call.callId,
              { completedCount: habit.completedCount, completedAt: todo?.completedAt, nextOccurrence: habit.nextOccurrence }) } : {}) };
        }
        const id = String(call.input.occurrenceId ?? '');
        const expected = occurrences.get(id), actual = await loadScheduleOccurrence(id);
        const item = actual && await loadScheduleItemById(actual.itemId);
        if (!expected || expected.title !== title || !actual || !item || actual.title !== title || actual.owner === 'I'
          || actual.status !== 'completed' && item.updatedAt !== expected.updatedAt) throw new Error('schedule-target-changed');
        // A completed parent can still repair a child left pending by a partial earlier save.
        if (actual.todoId) {
          const linked = await loadTodoItemById(actual.todoId, { promoteDue: false });
          if (linked && !linked.parentTodoId) for (const step of await loadTodoSteps(linked.id, actual.id))
            if (!['cancelled', 'expired'].includes(step.status)) await completeTodo(step.id, Number(completedAt));
        }
        const habit = await completeOccurrence(id, Number(completedAt));
        const reminderCandidates = habit && await habitReminderCandidates(call.callId,
          { completedCount: habit.completedCount, completedAt: habit.occurrence.completedAt, nextOccurrence: habit.nextOccurrence });
        const completed = await loadScheduleOccurrence(id);
        if (completed?.todoId && await current()) {
          const linked = await loadTodoItemById(completed.todoId, { promoteDue: false });
          if (linked && !['cancelled', 'expired'].includes(linked.status)) await completeTodoItemOnce(linked.id,
            { completedAt: completed.completedAt ?? Number(completedAt), skipTimeBasedGoalCredit: true,
              skipGoalCredit: !linked.parentTodoId && (await loadTodoSteps(linked.id, completed.id)).length > 0 }, current);
        }
        return { changed: actual.status !== 'completed', occurrenceId: id, title, status: completed?.status,
          completedAt: completed?.completedAt, reminderCandidates };
      });
      if (!outcome.committed) throw new Error('schedule-turn-stale');
      return createToolSuccessResult(call, '', outcome.value);
    } catch (error) {
      const details = error as { occurrenceCompleted?: boolean; todoCompleted?: boolean; habitLogSaved?: boolean; occurrenceId?: string; todoId?: string;
        argumentIssue?: { field?: unknown; reason?: unknown }; argumentIssues?: unknown };
      const argumentIssue = call.toolId === 'schedule.submit_day_plan' && error instanceof Error && error.message === 'INVALID_ARGUMENTS'
        && details.argumentIssue?.field === 'repeat.frequency' && details.argumentIssue.reason === 'frequency_value'
        ? { field: 'repeat.frequency', reason: 'frequency_value' } : undefined;
      const rawIssues = details.argumentIssues;
      const argumentIssues = call.toolId === 'schedule.submit_day_plan' && error instanceof Error && error.message === 'INVALID_ARGUMENTS'
        && Array.isArray(call.input.entries) && Array.isArray(rawIssues) && rawIssues.length > 0
        && rawIssues.every(issue => issue && typeof issue === 'object' && !Array.isArray(issue)
          && Number.isSafeInteger(issue.entry) && issue.entry >= 1 && issue.entry <= (call.input.entries as unknown[]).length
          && (issue.field === 'startAt' && issue.reason === 'conflicts_with_startLocal'
            || issue.field === 'endAt' && issue.reason === 'conflicts_with_endLocal'
            || issue.field === 'repeat.frequency' && issue.reason === 'frequency_value'
            || issue.field === 'steps' && issue.reason === 'empty_array'))
        ? rawIssues.map(issue => ({ entry: issue.entry, field: issue.field, reason: issue.reason })) : undefined;
      return { ...createToolErrorResult(call, createToolError('EXECUTION_FAILED', error instanceof Error ? error.message : 'schedule-completion-failed'), ''),
        ...(error instanceof Error && error.message === 'schedule-target-not-queried' ? { data: { argumentIssue: { field: 'occurrenceId', reason: 'not_in_current_query' } } } : {}),
        ...(argumentIssue ? { data: { argumentIssue } } : {}),
        ...(!argumentIssue && argumentIssues ? { data: { argumentIssues } } : {}),
        ...(details.occurrenceCompleted ? { data: { occurrenceCompleted: true, occurrenceId: details.occurrenceId, habitLogSaved: details.habitLogSaved === true } } : {}),
        ...(details.todoCompleted ? { data: { todoCompleted: true, todoId: details.todoId, habitLogSaved: details.habitLogSaved === true } } : {}) };
    }
  };
  return { current, observe, execute, batches, get deliveredBatch() { return deliveredBatch; } };
}

