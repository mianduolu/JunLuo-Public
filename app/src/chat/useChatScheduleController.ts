import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { applyChatScheduleTimeChange } from '../schedule/chatSchedulePlanPolicy';

import { createSubjectiveMessage, type SubjectiveMessage } from '../ai/subjectiveMessages';
import type { AiConnection } from '../ai/types';
import { canCommitBackupRestoreDataEpoch, captureBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import {
  clockToHHMM,
  DAY_MS,
  dateAtClockFromKey,
  extractClockFromText,
  extractHabitReminderTimes,
  extractHabitTargetCount,
  formatChatDateTime,
  formatHabitFrequency,
  formatTodoDate,
  habitTextScore,
  inferScheduleConstraintsFromText,
  resolveBulkScheduleDeleteScope,
  scheduleTextScore,
  selectClearCandidate,
  todoTextScore,
} from './chatScheduleText';
import { looksLikeCompletionNarrative, selectNarrativeCompletionCandidate } from '../schedule/completionNarrativeLogic';
import { loadDailyChallengesForDate } from '../schedule/dailyChallengeStore';
import { scheduleDay, type ClassifiedTask, type PendingSchedulePlan, type ScheduleAdjustmentOperation, type ScheduleConstraint } from '../schedule/dayScheduler';
import { loadDayTemplate } from '../schedule/dayTemplate';
import { readEffectiveUserRoutineRange } from '../schedule/userRoutineStore';
import { ensureDayTemplateInstances, loadDayTemplateInstances, toggleDayTemplateInstance } from '../schedule/dayTemplateInstanceStore';
import { removeScheduleCompanionEvents, syncScheduleCompanionEvents } from '../schedule/scheduleCompanionStore';
import { type ScheduleDataChangedPayload } from '../schedule/scheduleEvents';
import { cancelNotifications, requestNotificationPermission, syncScheduleNotifications } from '../schedule/scheduleNotifications';
import { gatherScheduleMemoryContext, type ScheduleMemoryContext } from '../schedule/scheduleMemoryContext';
import {
  classifyTasks,
  determineGoalType,
  extractGoalFromText,
  generateSchedulePlan,
  isAutoFillScheduleRequest,
  isSmartScheduleRequest,
  looksLikeCasualNonScheduleText,
  looksLikeSpecificScheduleRequest,
  parseScheduleAdjustment,
  parseTasksFromText,
  resolveScheduleDate,
  reviewScheduledPlan,
  type PendingGoalProposal,
  type ScheduleIntentKind,
} from '../schedule/schedulePlanner';
import {
  cancelScheduleOccurrence,
  createScheduleItem,
  dateKey,
  deleteScheduleItem,
  hasScheduleConflict,
  loadPendingScheduleOccurrencesBetween,
  loadScheduleItemsBetween,
  loadScheduleItemsForDate,
  loadScheduleOccurrence,
  postponeScheduleOccurrence,
  updateScheduleItem,
  type ScheduleDraft,
  type ScheduleOccurrence,
} from '../schedule/scheduleStore';
import { completeScheduleOccurrenceOnce } from '../schedule/scheduleCompletionOnce';
import { parsePostponeIntent, type PostponeTarget } from '../schedule/postponeLogic';
import { getCategoryConfig, getQuadrantConfig } from '../schedule/taskMeta';
import { createHabit, loadHabits, loadHabitsForDate, toggleHabitLog, updateHabit, type HabitDraft } from '../schedule/habitStore';
import { syncHabitScheduleInstances } from '../schedule/habitScheduleStore';
import { createGoal, loadGoals, updateGoal } from '../schedule/goalStore';
import { confirmGoalTimeCredit, generateGoalTodosForDate, skipGoalTimeCredit } from '../schedule/goalProgressStore';
import { cancelTodoItem, createTodoItem, loadOpenTodoItems, loadPostponableTodoItems, postponeTodoItem, updateTodoItem, type TodoDraft } from '../schedule/todoStore';
import { completeTodoItemOnce } from '../schedule/todoCompletionOnce';
import type { ReadonlyLatestRef } from './useChatSessionsController';
import type { DayPlanChange } from '../schedule/dayPlan';
import { saveDayPlanEntries } from '../schedule/dayPlanStore';
import type { JunLuoToolResult } from '../tools/toolTypes';

import {
  isRetiredMemoryActionReview,
  type ScheduleReviewAction,
} from './chatMemoryActionSuggestions';
export type { ScheduleReviewAction } from './chatMemoryActionSuggestions';

type ScheduleChangeCard = NonNullable<SubjectiveMessage['scheduleChangeCard']>;
type ScheduleAfterwordKind = 'plan-confirmed' | 'change-confirmed';
type GoalTimeCreditEditing = { messageId: string; requestId: string };

export type UseChatScheduleControllerOptions = {
  persistDayPlan?: (plan: PendingSchedulePlan, status: 'pending' | 'confirmed' | 'cancelled' | 'conflict', sessionId: string) => Promise<boolean>;
  requestDayPlanReply?: (sessionId: string, results: JunLuoToolResult[]) => Promise<boolean>;
  requestDayPlanAdjustment?: (plan: PendingSchedulePlan, canCommit: () => boolean) => Promise<boolean>;
  activeSessionId: string | null;
  chatConnection: AiConnection | null | undefined;
  chatKey: string;
  commitMessages: (messages: SubjectiveMessage[]) => void;
  configured: boolean;
  emitScheduleDataChanged: (payload?: ScheduleDataChangedPayload) => void;
  getUtilityJsonModel: () => { apiKey: string; connection: AiConnection };
  messages: SubjectiveMessage[];
  messagesRef: ReadonlyLatestRef<SubjectiveMessage[]>;
  onAfterwordCancelled: (id: string) => void;
  onAfterwordConfirmed: (
    id: string,
    kind: ScheduleAfterwordKind,
    target: PendingSchedulePlan | ScheduleChangeCard,
  ) => void;
  onChangeCardStatus: (cardId: string, status: ScheduleChangeCard['status']) => void;
  onError: (message: string | null) => void;
  onNotice: (message: string, durationMs: number) => void;
  onPlanCardChange: (
    plan: PendingSchedulePlan,
    status?: NonNullable<SubjectiveMessage['schedulePlanCard']>['status'],
  ) => void;
  onPlanConflict: () => void;
};

function useLatestCallback<Args extends unknown[], Result>(callback: (...args: Args) => Result) {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  return useCallback((...args: Args) => callbackRef.current(...args), []);
}

export function useChatScheduleController(options: UseChatScheduleControllerOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const [scheduleReviews, setScheduleReviews] = useState<ScheduleReviewAction[]>([]);
  const [pendingSchedulePlan, setPendingSchedulePlan] = useState<PendingSchedulePlan | null>(null);
  const [pendingGoalProposal, setPendingGoalProposal] = useState<PendingGoalProposal | null>(null);
  const [goalAdjustmentMode, setGoalAdjustmentMode] = useState(false);
  const [editingGoalTimeCredit, setEditingGoalTimeCredit] = useState<GoalTimeCreditEditing | null>(null);
  const [scheduleAdjustmentMode, setScheduleAdjustmentMode] = useState(false);
  const [pendingScheduleDateText, setPendingScheduleDateText] = useState<string | null>(null);
  const [pendingPostponeText, setPendingPostponeText] = useState<string | null>(null);
  const [ambiguousScheduleText, setAmbiguousScheduleText] = useState<string | null>(null);
  const [schedulePlanSaving, setSchedulePlanSaving] = useState(false);

  const scheduleReviewsRef = useRef(scheduleReviews);
  const pendingSchedulePlanRef = useRef(pendingSchedulePlan);
  const pendingGoalProposalRef = useRef(pendingGoalProposal);
  const goalAdjustmentModeRef = useRef(goalAdjustmentMode);
  const editingGoalTimeCreditRef = useRef(editingGoalTimeCredit);
  const scheduleAdjustmentModeRef = useRef(scheduleAdjustmentMode);
  const pendingScheduleDateTextRef = useRef(pendingScheduleDateText);
  const pendingPostponeTextRef = useRef(pendingPostponeText);
  const ambiguousScheduleTextRef = useRef(ambiguousScheduleText);
  const schedulePlanSavingRef = useRef(schedulePlanSaving);
  const adjustmentRevisionRef = useRef(0);
  const adjustmentMountedRef = useRef(true);
  const pendingAdjustmentPlanRef = useRef<PendingSchedulePlan | null>(null);
  scheduleReviewsRef.current = scheduleReviews;
  pendingSchedulePlanRef.current = pendingSchedulePlan;
  pendingGoalProposalRef.current = pendingGoalProposal;
  goalAdjustmentModeRef.current = goalAdjustmentMode;
  editingGoalTimeCreditRef.current = editingGoalTimeCredit;
  scheduleAdjustmentModeRef.current = scheduleAdjustmentMode;
  pendingScheduleDateTextRef.current = pendingScheduleDateText;
  pendingPostponeTextRef.current = pendingPostponeText;
  ambiguousScheduleTextRef.current = ambiguousScheduleText;
  schedulePlanSavingRef.current = schedulePlanSaving;

  const visibleScheduleReviews = useMemo(
    () => scheduleReviews.filter((review) => !isRetiredMemoryActionReview(review)),
    [scheduleReviews],
  );

  const dismissScheduleReview = useCallback((reviewId: string) => {
    setScheduleReviews((current) => {
      return current.filter((review) => review.reviewId !== reviewId);
    });
  }, []);

  const clearScheduleReviews = useCallback(() => {
    setScheduleReviews([]);
  }, []);

  const invalidatePendingAdjustment = useCallback(() => {
    adjustmentRevisionRef.current += 1;
    pendingAdjustmentPlanRef.current = null;
    goalAdjustmentModeRef.current = false;
    scheduleAdjustmentModeRef.current = false;
    setGoalAdjustmentMode(false);
    setScheduleAdjustmentMode(false);
  }, []);

  const beginGoalAdjustment = useCallback(() => {
    invalidatePendingAdjustment();
    goalAdjustmentModeRef.current = true;
    setGoalAdjustmentMode(true);
  }, [invalidatePendingAdjustment]);

  const beginScheduleAdjustment = useCallback((plan?: PendingSchedulePlan) => {
    invalidatePendingAdjustment();
    pendingAdjustmentPlanRef.current = plan ?? pendingSchedulePlanRef.current;
    if (plan) {
      pendingSchedulePlanRef.current = plan;
      setPendingSchedulePlan(plan);
    }
    scheduleAdjustmentModeRef.current = true;
    setScheduleAdjustmentMode(true);
  }, [invalidatePendingAdjustment]);

  const beginGoalTimeCreditEdit = useCallback((message: SubjectiveMessage) => {
    const card = message.goalTimeCreditCard;
    if (!card) return false;
    setEditingGoalTimeCredit({ messageId: message.id, requestId: card.requestId });
    return true;
  }, []);

  const clearGoalTimeCreditEdit = useCallback(() => {
    setEditingGoalTimeCredit(null);
  }, []);

  const openAmbiguousScheduleReview = useCallback((text: string) => {
    setAmbiguousScheduleText(text);
  }, []);

  const takeRejectedAmbiguousScheduleText = useCallback(() => {
    const text = ambiguousScheduleTextRef.current;
    setAmbiguousScheduleText(null);
    return text;
  }, []);

  const clearPendingPostponeText = useCallback(() => {
    setPendingPostponeText(null);
  }, []);

  const clearPendingScheduleDateText = useCallback(() => {
    setPendingScheduleDateText(null);
  }, []);

  const pushScheduleReviewNotice = (text: string) => {
    options.commitMessages([...options.messagesRef.current, createSubjectiveMessage('I', text)]);
  };

  const buildCancelScheduleReviews = async (text: string) => {
    const now = Date.now();
    const occurrenceDays = await Promise.all(
      Array.from({ length: 31 }, (_, index) => loadScheduleItemsForDate(new Date(now + index * DAY_MS))),
    );
    const candidates = occurrenceDays
      .flat()
      .filter((occurrence) => occurrence.scheduledStartAt >= now - 6 * 60 * 60 * 1000);
    const ranked = candidates
      .map((occurrence) => ({ occurrence, score: scheduleTextScore(occurrence, text) }))
      .filter((entry) => entry.score > 0 || candidates.length <= 3)
      .sort((left, right) => right.score - left.score)
      .slice(0, 3);

    return ranked.map(({ occurrence }, index): ScheduleReviewAction => ({
      kind: 'cancel',
      occurrence,
      reviewId: `schedule-cancel-${Date.now()}-${index}`,
    }));
  };

  const buildPendingSchedulePlan = async ({
    originalText,
    targetDateKey,
    tasks,
    constraints = [],
    planId = `smart-plan-${Date.now()}`,
  }: {
    originalText: string;
    targetDateKey: string;
    tasks?: ClassifiedTask[];
    constraints?: ScheduleConstraint[];
    planId?: string;
  }) => {
    if (!options.configured || !options.chatConnection) throw new Error('请先在“白云与连接”中配置模型，白云才能帮鼠拆任务。');
    const utilityJsonModel = options.getUtilityJsonModel();
    const extracted = tasks ? [] : await parseTasksFromText({ apiKey: utilityJsonModel.apiKey, connection: utilityJsonModel.connection, text: originalText });
    const classified = tasks ?? await classifyTasks({ apiKey: utilityJsonModel.apiKey, connection: utilityJsonModel.connection, tasks: extracted });
    if (!classified.length) throw new Error('这句话里暂时没有抓到可以排进一天的任务。');
    const targetDate = new Date(`${targetDateKey}T12:00:00`);
    const [template, occurrences, dailyChallenges] = await Promise.all([
      loadDayTemplate(),
      loadScheduleItemsForDate(targetDate),
      loadDailyChallengesForDate(targetDateKey),
    ]);
    const dayStartAt = new Date(`${targetDateKey}T00:00:00`).getTime();
    const routineEnd = new Date(dayStartAt); routineEnd.setDate(routineEnd.getDate() + 2);
    const routine = await readEffectiveUserRoutineRange(dayStartAt, routineEnd.getTime()).catch(() => []);
    const nowBlock = targetDateKey === dateKey(Date.now())
      ? [{ startAt: dayStartAt, endAt: Date.now(), title: '已经过去的时间' }]
      : [];
    const inhibitTasks = classified.filter((task) => task.type === 'inhibit');
    const schedulableTasks = classified.filter((task) => task.type !== 'inhibit');
    const derivedConstraints = inferScheduleConstraintsFromText(schedulableTasks, originalText);
    const effectiveConstraints = [...derivedConstraints, ...constraints];
    const scheduled = scheduleDay({
      dateKey: targetDateKey,
      tasks: schedulableTasks,
      constraints: effectiveConstraints,
      template,
      routine,
      floatingCommitments: dailyChallenges.map(({ challenge, todo, streak, completed }) => ({
        id: todo.id,
        title: challenge.title,
        category: challenge.category,
        quadrant: challenge.quadrant,
        estimatedMinutes: challenge.estimatedMinutes,
        source: 'daily-challenge' as const,
        sourceId: challenge.id,
        streak,
        completed,
      })),
      occupied: [...nowBlock, ...occurrences
        .filter((item) => item.status === 'pending')
        .map((item) => ({
          startAt: item.scheduledStartAt,
          endAt: item.endAt ?? item.scheduledStartAt + 60 * 60 * 1000,
          title: item.title,
        }))],
    });
    let memoryContext: ScheduleMemoryContext = { text: '', references: [], missingCommitments: [] };
    try {
      memoryContext = await gatherScheduleMemoryContext({
        originalText,
        dateKey: targetDateKey,
        taskTitles: classified.map((task) => task.title),
      });
    } catch {
      // Memory recall is optional and must never block deterministic scheduling.
    }
    let reviewSuggestions: string[] = [];
    try {
      reviewSuggestions = await reviewScheduledPlan({
        apiKey: options.chatKey.trim(),
        connection: options.chatConnection,
        plan: scheduled,
        memoryContext: memoryContext.text,
        missingCommitments: memoryContext.missingCommitments,
      });
    } catch {
      // AI review is optional; deterministic scheduling remains usable.
    }
    memoryContext.missingCommitments.forEach((title) => {
      const suggestion = `记忆里有一条约定“${title}”，这次还没有排进去。`;
      if (!reviewSuggestions.includes(suggestion)) reviewSuggestions.push(suggestion);
    });
    return {
      id: planId,
      originalText,
      dateKey: targetDateKey,
      tasks: classified,
      constraints: effectiveConstraints,
      scheduled,
      reviewSuggestions: reviewSuggestions.slice(0, 5),
      memoryReferences: memoryContext.references,
      inhibitTasks,
    } satisfies PendingSchedulePlan;
  };

  const startSmartSchedule = async (text: string, explicitDate?: string) => {
    const targetDateKey = explicitDate ?? resolveScheduleDate(text);
    if (!targetDateKey) {
      setPendingScheduleDateText(text);
      pushScheduleReviewNotice('鼠想把这些事排在哪一天呀？可以告诉我“今天”“明天”“周五”或具体日期。');
      return;
    }
    setPendingScheduleDateText(null);
    let autofillTasks: ClassifiedTask[] | undefined;
    if (isAutoFillScheduleRequest(text)) {
      const openTodos = await loadOpenTodoItems(160);
      const candidates = openTodos.filter((todo) => {
        if (todo.source === 'daily-challenge') return false;
        const planned = todo.plannedForDate ?? todo.dueDate;
        return !!planned && planned <= targetDateKey;
      });
      if (!candidates.length) {
        pushScheduleReviewNotice(`${targetDateKey} 还没有待办或过期任务，我先不让 AI 凭空编一份安排。`);
        return;
      }
      const ready = candidates.filter((todo) => todo.estimatedMinutes).map((todo): ClassifiedTask => ({
        id: `todo:${todo.id}`,
        title: todo.title,
        category: todo.category,
        quadrant: todo.quadrant,
        estimatedMinutes: todo.estimatedMinutes,
        userEstimatedMinutes: todo.estimatedMinutes,
        type: todo.type,
      }));
      const missing = candidates.filter((todo) => !todo.estimatedMinutes).map((todo) => ({
        id: `todo:${todo.id}`,
        title: todo.title,
        type: todo.type,
      }));
      const utilityJsonModel = options.getUtilityJsonModel();
      const estimated = missing.length
        ? await classifyTasks({ apiKey: utilityJsonModel.apiKey, connection: utilityJsonModel.connection, tasks: missing })
        : [];
      autofillTasks = [...ready, ...estimated];
    }
    const plan = await buildPendingSchedulePlan({ originalText: text, targetDateKey, tasks: autofillTasks });
    setPendingSchedulePlan(plan);
    setScheduleAdjustmentMode(false);
    options.onPlanCardChange(plan);
  };

  const applyScheduleAdjustments = async (
    text: string,
    plan = pendingSchedulePlanRef.current,
    canCommit = () => true,
  ) => {
    if (!plan || !options.configured || !options.chatConnection || !canCommit()) return;
    const operations = await parseScheduleAdjustment({
      apiKey: options.chatKey.trim(),
      connection: options.chatConnection,
      text,
      tasks: plan.tasks,
    });
    if (!canCommit()) return;
    if (!operations.length) {
      pushScheduleReviewNotice('我还没看懂要改哪一项。鼠可以说“把开发移到下午三点”“复习改成 60 分钟”“删掉散步”或“再加一项买药”。');
      return;
    }
    let tasks = [...plan.tasks];
    let constraints = [...plan.constraints];
    const additions: Extract<ScheduleAdjustmentOperation, { kind: 'add' }>[] = [];
    operations.forEach((operation) => {
      if (operation.kind === 'remove') {
        tasks = tasks.filter((task) => task.id !== operation.taskId);
        constraints = constraints.filter((constraint) => constraint.taskId !== operation.taskId);
      } else if (operation.kind === 'duration') {
        tasks = tasks.map((task) => task.id === operation.taskId ? { ...task, estimatedMinutes: operation.estimatedMinutes } : task);
      } else if (operation.kind === 'segments') {
        tasks = tasks.map((task) => task.id === operation.taskId ? { ...task, requestedSegments: operation.requestedSegments } : task);
      } else if (operation.kind === 'move') {
        constraints = [
          ...constraints.filter((constraint) => constraint.taskId !== operation.taskId),
          { taskId: operation.taskId, fixedStartTime: operation.fixedStartTime, preferredPeriod: operation.preferredPeriod },
        ];
      } else {
        additions.push(operation);
      }
    });
    if (additions.length) {
      const extracted = additions.map((item, index) => ({
        id: `task-added-${Date.now()}-${index}`,
        title: item.title,
        userEstimatedMinutes: item.estimatedMinutes,
      }));
      const utilityJsonModel = options.getUtilityJsonModel();
      tasks = [...tasks, ...await classifyTasks({ apiKey: utilityJsonModel.apiKey, connection: utilityJsonModel.connection, tasks: extracted })];
      if (!canCommit()) return;
    }
    if (!tasks.length) {
      pendingSchedulePlanRef.current = null;
      setPendingSchedulePlan(null);
      setScheduleAdjustmentMode(false);
      pushScheduleReviewNotice('这一组任务已经都移掉啦，方案没有写进日程。');
      return;
    }
    const next = await buildPendingSchedulePlan({
      originalText: plan.originalText,
      targetDateKey: plan.dateKey,
      tasks,
      constraints,
      planId: plan.id,
    });
    if (!canCommit()) return;
    pendingSchedulePlanRef.current = next;
    setPendingSchedulePlan(next);
    setScheduleAdjustmentMode(false);
    options.onPlanCardChange(next);
  };

  const updateScheduleChangeCard = (cardId: string, status: ScheduleChangeCard['status']) => {
    options.commitMessages(options.messagesRef.current.map((message) => message.scheduleChangeCard?.id === cardId
      ? { ...message, scheduleChangeCard: { ...message.scheduleChangeCard, status } }
      : message));
  };

  const buildScheduleChangeCard = async (text: string): Promise<ScheduleChangeCard | null> => {
    const now = Date.now();
    const isDelete = /删|删除|取消|清除|清空|撤掉|去掉|移除|不做|不用/.test(text);
    const clock = extractClockFromText(text);
    const targetDateKey = resolveScheduleDate(text);
    const wantsMove = !!clock || /改到|换到|挪到|移到|提前到|推迟到/.test(text);
    if (!isDelete && !wantsMove) return null;

    const bulkDeleteScope = isDelete ? resolveBulkScheduleDeleteScope(text, now) : null;
    const occurrenceStartAt = bulkDeleteScope?.startAt ?? now - DAY_MS;
    const occurrenceEndAt = bulkDeleteScope?.endAt ?? now + 90 * DAY_MS;
    const [todos, occurrences] = await Promise.all([
      loadPostponableTodoItems(160),
      loadPendingScheduleOccurrencesBetween(occurrenceStartAt, occurrenceEndAt),
    ]);
    const id = `schedule-change-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    if (bulkDeleteScope) {
      const bulkOccurrences = occurrences
        .filter((item) => item.scheduledStartAt >= bulkDeleteScope.startAt && item.scheduledStartAt < bulkDeleteScope.endAt)
        .sort((left, right) => left.scheduledStartAt - right.scheduledStartAt)
        .map((item) => ({
          occurrenceId: item.id,
          itemId: item.itemId,
          title: item.title,
          scheduledStartAt: item.scheduledStartAt,
        }));
      if (!bulkOccurrences.length) return null;
      return {
        id,
        status: 'pending',
        kind: 'delete-schedule',
        title: `批量删除 ${bulkDeleteScope.label}`,
        before: `${bulkDeleteScope.label} · ${bulkOccurrences.length} 条`,
        bulkOccurrences,
      };
    }
    const todoCandidates = todos.map((item) => ({
      kind: 'todo' as const,
      item,
      score: todoTextScore(item, text),
    }));
    const scheduleCandidates = occurrences.map((item) => ({
      kind: 'schedule' as const,
      item,
      score: scheduleTextScore(item, text) + (clock && item.endAt ? 1 : 0),
    }));
    const selected = selectClearCandidate([...todoCandidates, ...scheduleCandidates]);
    if (!selected) return null;

    if (isDelete) {
      if (selected.kind === 'schedule') {
        return {
          id,
          status: 'pending',
          kind: 'delete-schedule',
          title: selected.item.title,
          before: formatChatDateTime(selected.item.scheduledStartAt),
          occurrenceId: selected.item.id,
          itemId: selected.item.itemId,
        };
      }
      return {
        id,
        status: 'pending',
        kind: 'delete-todo',
        title: selected.item.title,
        before: formatTodoDate(selected.item.plannedForDate),
        todoId: selected.item.id,
      };
    }

    if (selected.kind === 'schedule' && clock) {
      const targetDay = targetDateKey ?? dateKey(selected.item.scheduledStartAt);
      const [targetHour, targetMinute] = clockToHHMM(clock, text).split(':').map(Number);
      const targetStartAt = dateAtClockFromKey(targetDay, { hour: targetHour, minute: targetMinute });
      const duration = Math.max(0, (selected.item.endAt ?? selected.item.scheduledStartAt) - selected.item.scheduledStartAt);
      return {
        id,
        status: 'pending',
        kind: 'move-schedule',
        title: selected.item.title,
        before: formatChatDateTime(selected.item.scheduledStartAt),
        after: formatChatDateTime(targetStartAt),
        occurrenceId: selected.item.id,
        itemId: selected.item.itemId,
        targetStartAt,
        targetEndAt: selected.item.endAt ? targetStartAt + duration : undefined,
      };
    }

    if (selected.kind === 'todo' && targetDateKey) {
      return {
        id,
        status: 'pending',
        kind: 'move-todo',
        title: selected.item.title,
        before: formatTodoDate(selected.item.plannedForDate),
        after: targetDateKey,
        todoId: selected.item.id,
        targetDate: targetDateKey,
      };
    }

    return null;
  };

  const confirmScheduleChangeCard = async (message: SubjectiveMessage) => {
    const card = message.scheduleChangeCard;
    if (!card || card.status !== 'pending') return;
    try {
      if (card.kind === 'delete-schedule' && card.bulkOccurrences?.length) {
        const notificationGroups = await Promise.all(
          card.bulkOccurrences.map((item) => cancelScheduleOccurrence(item.occurrenceId)),
        );
        await cancelNotifications(notificationGroups.flat());
        await cancelNotifications(await removeScheduleCompanionEvents(card.bulkOccurrences.map((item) => item.occurrenceId)));
        await syncScheduleNotifications();
        await syncScheduleCompanionEvents();
      } else if (card.kind === 'delete-schedule' && (card.occurrenceId || card.itemId)) {
        const notificationIds = card.occurrenceId
          ? await cancelScheduleOccurrence(card.occurrenceId)
          : card.itemId
            ? await deleteScheduleItem(card.itemId)
            : [];
        await cancelNotifications(notificationIds);
        await cancelNotifications(card.occurrenceId ? await removeScheduleCompanionEvents([card.occurrenceId]) : []);
        await syncScheduleNotifications();
        await syncScheduleCompanionEvents();
      } else if (card.kind === 'delete-todo' && card.todoId) {
        await cancelTodoItem(card.todoId);
      } else if (card.kind === 'move-todo' && card.todoId) {
        await updateTodoItem(card.todoId, { plannedForDate: card.targetDate });
      } else if (card.kind === 'move-schedule' && card.occurrenceId && card.itemId && card.targetStartAt) {
        const occurrence = await loadScheduleOccurrence(card.occurrenceId);
        if (!occurrence) throw new Error('找不到这条日程了');
        const draft: ScheduleDraft = {
          title: occurrence.title,
          notes: occurrence.notes,
          startAt: card.targetStartAt,
          endAt: card.targetEndAt,
          reminderMinutesBefore: occurrence.reminderMinutesBefore,
          recurrence: occurrence.recurrence,
          reminderText: occurrence.reminderText,
          reminderIntensity: occurrence.reminderIntensity,
          source: occurrence.source,
          habitId: occurrence.habitId,
          habitAnchorKey: occurrence.habitAnchorKey,
          todoId: occurrence.todoId,
          goalId: occurrence.goalId,
          planId: occurrence.planId,
          companionEnabled: occurrence.companionEnabled,
        };
        if (await hasScheduleConflict(draft, card.itemId)) {
          throw new Error('目标时间已经有别的安排');
        }
        const result = await updateScheduleItem(card.itemId, draft);
        await cancelNotifications(result.notificationIds);
        await cancelNotifications(await removeScheduleCompanionEvents([card.occurrenceId]));
        await syncScheduleNotifications();
        await syncScheduleCompanionEvents();
      }
      options.emitScheduleDataChanged({
        dateKey: card.kind === 'move-todo'
          ? card.targetDate
          : card.kind === 'move-schedule' && card.targetStartAt
            ? dateKey(card.targetStartAt)
            : undefined,
        reason: card.kind.includes('todo') ? 'todo' : 'schedule',
      });
      updateScheduleChangeCard(card.id, 'confirmed');
      void options.onAfterwordConfirmed(`change:${card.id}`, 'change-confirmed', card);
      options.onNotice(`已同步：${card.title}`, 2400);
    } catch (caught) {
      updateScheduleChangeCard(card.id, 'failed');
      options.onError(caught instanceof Error ? `${caught.message}，原安排没有动。` : '这次变更没有安全完成，原安排没有动。');
    }
  };

  const cancelScheduleChangeCard = (message: SubjectiveMessage) => {
    const card = message.scheduleChangeCard;
    if (!card || card.status !== 'pending') return;
    options.onAfterwordCancelled(`change:${card.id}`);
    updateScheduleChangeCard(card.id, 'cancelled');
  };

  const handleHabitRuleChange = async (text: string, outgoingMessages: SubjectiveMessage[]) => {
    const targetCount = extractHabitTargetCount(text);
    const reminderTimes = extractHabitReminderTimes(text);
    if (targetCount === undefined && !reminderTimes.length) {
      options.commitMessages([...outgoingMessages, createSubjectiveMessage('I', '我知道小仓鼠想修改习惯，但还不知道具体要怎么改。可以像“改成每天两次，12:00 和 21:00”这样告诉我。')]);
      return true;
    }

    const habits = await loadHabits(false, 'habit');
    const candidates = habits
      .map((habit) => ({ habit, score: habitTextScore(habit, text) }))
      .sort((left, right) => right.score - left.score);
    const selected = selectClearCandidate(candidates);
    if (!selected) {
      const top = candidates.filter((candidate) => candidate.score > 0).slice(0, 3);
      const names = top.length ? `我找到这些可能相关的习惯：${top.map((candidate) => `“${candidate.habit.title}”`).join('、')}。` : '';
      options.commitMessages([...outgoingMessages, createSubjectiveMessage('I', `${names}小仓鼠把要修改的习惯名字带上，我确认清楚再改。`)]);
      return true;
    }

    const patch: Partial<HabitDraft> = {};
    if (targetCount !== undefined) patch.targetCount = targetCount;
    if (reminderTimes.length) {
      patch.reminderTimes = reminderTimes;
      patch.reminderTime = reminderTimes[0];
    }
    if (/每天|每日|每一天|一天/.test(text)) {
      patch.frequency = 'daily';
      patch.weekDays = [];
    }

    await updateHabit(selected.habit.id, patch);
    await syncHabitScheduleInstances(selected.habit.id);
    options.emitScheduleDataChanged({ dateKey: dateKey(Date.now()), reason: 'habit' });

    const parts = [
      targetCount !== undefined ? `每天 ${targetCount} 次` : undefined,
      reminderTimes.length ? `时间是 ${reminderTimes.join('、')}` : undefined,
    ].filter(Boolean);
    options.commitMessages([...outgoingMessages, createSubjectiveMessage('I', `好，我把“${selected.habit.title}”改好啦：${parts.join('，')}。如果这个习惯会自动排进日程，相关安排也会一起更新。`)]);
    return true;
  };

  const handleHabitListQuery = async (outgoingMessages: SubjectiveMessage[]) => {
    const today = dateKey(Date.now());
    const [habits, todayHabits] = await Promise.all([
      loadHabits(false, 'habit'),
      loadHabitsForDate(today),
    ]);
    if (!habits.length) {
      options.commitMessages([...outgoingMessages, createSubjectiveMessage('I', '小仓鼠现在还没有正在进行的习惯。')]);
      return true;
    }

    const todayById = new Map(todayHabits.map((habit) => [habit.id, habit]));
    const lines = habits.map((habit) => {
      const todayHabit = todayById.get(habit.id);
      const progress = todayHabit
        ? `今天 ${todayHabit.log?.completedCount ?? 0}/${habit.targetCount}`
        : '今天不需要打卡';
      const times = habit.reminderTimes.length ? ` · ${habit.reminderTimes.join('、')}` : '';
      const calendar = habit.scheduleInstances.enabled ? ' · 已进日历' : ' · 不自动排进日程';
      return `- ${getCategoryConfig(habit.category).icon} ${habit.title}（${formatHabitFrequency(habit.frequency, habit.weekDays)} · ${progress}${times}${calendar}）`;
    });

    options.commitMessages([
      ...outgoingMessages,
      createSubjectiveMessage('I', `小仓鼠当前的习惯都在这里啦：\n${lines.join('\n')}`),
    ]);
    return true;
  };

  const handleGoalHabitQuickAction = async (text: string, outgoingMessages: SubjectiveMessage[]) => {
    if (/(?:目标).{0,18}(?:实现|完成|达成)|(?:实现|完成|达成).{0,18}(?:目标)/.test(text)) {
      const goals = await loadGoals();
      const candidates = goals.map((goal) => {
        const normalized = text.replace(/\s+/g, '').toLowerCase();
        const title = goal.title.replace(/\s+/g, '').toLowerCase();
        return { goal, score: normalized.includes(title) ? 10 : [...title].filter((char) => normalized.includes(char)).length };
      });
      const selected = selectClearCandidate(candidates);
      if (!selected) {
        options.commitMessages([...outgoingMessages, createSubjectiveMessage('I', '小仓鼠想标记哪个目标完成呀？把目标名字告诉我，我确认清楚再改。')]);
        return true;
      }
      await updateGoal(selected.goal.id, { status: 'completed', progress: 100 });
      options.emitScheduleDataChanged({ reason: 'goal' });
      options.commitMessages([...outgoingMessages, createSubjectiveMessage('I', `好，我把“${selected.goal.title}”标记为完成啦！小仓鼠真的做到啦><`)]);
      return true;
    }

    if (/(?:习惯|打卡).{0,18}(?:完成|做了|打卡|好了)|(?:完成|做完|打卡).{0,18}(?:习惯)/.test(text)) {
      const today = dateKey(Date.now());
      const habits = await loadHabitsForDate(today);
      const candidates = habits.map((habit) => {
        const normalized = text.replace(/\s+/g, '').toLowerCase();
        const title = habit.title.replace(/\s+/g, '').toLowerCase();
        return { habit, score: normalized.includes(title) ? 10 : [...title].filter((char) => normalized.includes(char)).length };
      });
      const selected = selectClearCandidate(candidates);
      if (!selected) {
        options.commitMessages([...outgoingMessages, createSubjectiveMessage('I', '小仓鼠想给哪个习惯打卡呀？把习惯名字告诉我，我确认清楚再记。')]);
        return true;
      }
      await toggleHabitLog(selected.habit.id, today, true);
      options.emitScheduleDataChanged({ dateKey: today, reason: 'habit' });
      options.commitMessages([...outgoingMessages, createSubjectiveMessage('I', `好，今天的“${selected.habit.title}”已经打卡啦！`)]);
      return true;
    }

    return false;
  };

  const buildGoalProposal = async (text: string, originalText = text, canCommit = () => true) => {
    const utilityJsonModel = options.getUtilityJsonModel();
    const extracted = await extractGoalFromText({ apiKey: utilityJsonModel.apiKey, connection: utilityJsonModel.connection, text });
    if (!canCommit()) return;
    const proposal: PendingGoalProposal = {
      id: `goal-proposal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      originalText,
      extracted,
      goalType: determineGoalType(extracted),
    };
    pendingGoalProposalRef.current = proposal;
    setPendingGoalProposal(proposal);
    setGoalAdjustmentMode(false);
    return proposal;
  };

  const confirmPendingGoal = async () => {
    invalidatePendingAdjustment();
    if (!pendingGoalProposal) return;
    const { extracted, goalType } = pendingGoalProposal;
    const goal = await createGoal({
      title: extracted.title,
      description: extracted.description,
      lifeArea: 'growth',
      priority: 'normal',
      targetDate: extracted.deadline,
      goalType,
      targetCount: goalType === 'countdown' ? extracted.number : undefined,
      targetUnit: goalType === 'countdown' ? extracted.unit : undefined,
      estimatedTotalMinutes: goalType === 'time_based' && extracted.estimatedHours
        ? Math.round(extracted.estimatedHours * 60)
        : undefined,
      frequency: extracted.frequency,
      weekDays: extracted.weekDays,
      actionTitle: extracted.suggestedAction || extracted.title,
      actionAmount: 1,
    });
    await generateGoalTodosForDate(dateKey(new Date()));
    options.emitScheduleDataChanged({ dateKey: dateKey(new Date()), reason: 'goal' });
    setPendingGoalProposal(null);
    options.commitMessages([...options.messagesRef.current, createSubjectiveMessage('I', `目标“${goal.title}”已经建好啦！`)]);
  };

  const cancelPendingGoal = () => {
    invalidatePendingAdjustment();
    pendingGoalProposalRef.current = null;
    setPendingGoalProposal(null);
    setGoalAdjustmentMode(false);
    options.commitMessages([...options.messagesRef.current, createSubjectiveMessage('I', '好，这次先不建啦，刚才的目标方案已经取消了。')]);
  };

  const handleUnifiedCompletionAck = async (text: string, outgoingMessages: SubjectiveMessage[]) => {
    const today = dateKey(Date.now());
    await ensureDayTemplateInstances(today);
    const [todos, occurrences, templateInstances] = await Promise.all([
      loadPostponableTodoItems(120),
      loadPendingScheduleOccurrencesBetween(Date.now() - DAY_MS, Date.now() + 90 * DAY_MS),
      loadDayTemplateInstances(today),
    ]);
    const candidates = [
      ...todos.map((item) => ({ kind: 'todo' as const, id: item.id, title: item.title, score: todoTextScore(item, text) })),
      ...occurrences.map((item) => ({ kind: 'schedule' as const, id: item.id, title: item.title, score: scheduleTextScore(item, text) })),
      ...templateInstances.filter((item) => item.status === 'pending').map((item) => ({
        kind: 'template' as const,
        id: item.id,
        title: item.title,
        score: text.includes(item.title) ? 10 : 0,
      })),
    ].sort((left, right) => right.score - left.score);
    const candidate = candidates.length === 1 ? candidates[0] : candidates[0]?.score > 0 && candidates[0].score > (candidates[1]?.score ?? -1) ? candidates[0] : null;
    if (!candidate) {
      const likely = candidates.filter((item) => item.score > 0).slice(0, 4);
      if (!likely.length) return false;
      options.commitMessages([
        ...outgoingMessages,
        createSubjectiveMessage('I', `小仓鼠完成的是哪一项呀？我找到了这些可能的事项：${likely.map((item) => `“${item.title}”`).join('、')}。把名字告诉我，我确认清楚再记为完成。`),
      ]);
      return true;
    }
    if (candidate.kind === 'todo') await completeTodoItemOnce(candidate.id);
    else if (candidate.kind === 'schedule') await completeScheduleOccurrenceOnce(candidate.id);
    else await toggleDayTemplateInstance(candidate.id);
    options.emitScheduleDataChanged({ dateKey: today, reason: candidate.kind === 'todo' ? 'todo' : 'schedule' });
    options.onNotice(`已完成：${candidate.title}`, 2600);
    options.commitMessages([
      ...outgoingMessages,
      createSubjectiveMessage('I', `好，“${candidate.title}”已经完成啦！小仓鼠辛苦啦><`),
    ]);
    return true;
  };

  const handleNarrativeCompletionSideEffect = async (text: string, outgoingMessages: SubjectiveMessage[]) => {
    const today = dateKey(Date.now());
    await ensureDayTemplateInstances(today);
    const [todos, occurrences, templateInstances] = await Promise.all([
      loadPostponableTodoItems(120),
      loadPendingScheduleOccurrencesBetween(Date.now() - DAY_MS, Date.now() + 90 * DAY_MS),
      loadDayTemplateInstances(today),
    ]);
    const candidates = [
      ...todos.map((item) => ({ kind: 'todo' as const, id: item.id, title: item.title, score: todoTextScore(item, text) })),
      ...occurrences.map((item) => ({ kind: 'schedule' as const, id: item.id, title: item.title, score: scheduleTextScore(item, text) })),
      ...templateInstances.filter((item) => item.status === 'pending').map((item) => ({
        kind: 'template' as const,
        id: item.id,
        title: item.title,
        score: text.includes(item.title) ? 10 : 0,
      })),
    ].sort((left, right) => right.score - left.score);
    const candidate = selectNarrativeCompletionCandidate(candidates);
    if (candidate) {
      if (candidate.kind === 'todo') await completeTodoItemOnce(candidate.id);
      else if (candidate.kind === 'schedule') await completeScheduleOccurrenceOnce(candidate.id);
      else await toggleDayTemplateInstance(candidate.id);
      options.emitScheduleDataChanged({ dateKey: today, reason: candidate.kind === 'todo' ? 'todo' : 'schedule' });
      options.onNotice(`已完成：${candidate.title}`, 2600);
      return;
    }
  };

  const handlePostponeRequest = async (
    text: string,
    outgoingMessages: SubjectiveMessage[],
    targetOverride?: PostponeTarget,
  ) => {
    const parsed = parsePostponeIntent(text);
    let target = targetOverride ?? parsed?.target;
    if (!target && /等.+再/.test(text)) {
      const goals = (await loadGoals()).filter((goal) => goal.status === 'active' && goal.targetDate);
      const mentioned = goals.filter((goal) => text.includes(goal.title));
      const match = mentioned.length === 1 ? mentioned[0] : goals.length === 1 ? goals[0] : undefined;
      if (match) target = { kind: 'after_deadline', goalId: match.id };
    }
    if (!target) {
      setPendingPostponeText(text);
      options.commitMessages([...outgoingMessages, createSubjectiveMessage('I', '小仓鼠想把它推到哪一天呀？可以说“明天”“下周”“周五”，也可以直接告诉我具体日期。')]);
      return true;
    }
    const [todos, occurrences] = await Promise.all([
      loadPostponableTodoItems(120),
      loadPendingScheduleOccurrencesBetween(Date.now() - DAY_MS, Date.now() + 90 * DAY_MS),
    ]);
    const candidates = [
      ...todos.map((item) => ({ kind: 'todo' as const, id: item.id, title: item.title, score: todoTextScore(item, text) })),
      ...occurrences.filter((item) => !item.todoId || !todos.some((todo) => todo.id === item.todoId)).map((item) => ({ kind: 'schedule' as const, id: item.id, title: item.title, score: scheduleTextScore(item, text) })),
    ].sort((left, right) => right.score - left.score);
    const candidate = candidates.length === 1 ? candidates[0] : candidates[0]?.score > 0 && candidates[0].score > (candidates[1]?.score ?? -1) ? candidates[0] : null;
    if (!candidate) {
      const likely = candidates.filter((item) => item.score > 0).slice(0, 4);
      options.commitMessages([...outgoingMessages, createSubjectiveMessage('I', likely.length
        ? `小仓鼠想推迟的是哪一项呀？我找到了这些可能的事项：${likely.map((item) => `“${item.title}”`).join('、')}。把名字告诉我，我确认清楚再改日期。`
        : '我还没找到小仓鼠想推迟的事项。把它的名字也告诉我，我再改日期。')]);
      return true;
    }
    if (candidate.kind === 'todo') {
      const linkedOccurrence = occurrences.find((item) => item.todoId === candidate.id);
      const linkedMove = linkedOccurrence ? await postponeScheduleOccurrence(linkedOccurrence.id, target) : null;
      const moved = linkedMove ? linkedMove.ok : !!(await postponeTodoItem(candidate.id, target));
      if (!moved) {
        options.commitMessages([...outgoingMessages, createSubjectiveMessage('I', `这次没有改成功，“${candidate.title}”还在原来的日期。`)]);
        return true;
      }
      if (linkedMove?.ok && linkedOccurrence) {
        await cancelNotifications(linkedMove.notificationIds);
        await cancelNotifications(await removeScheduleCompanionEvents([linkedOccurrence.id]));
        await Promise.all([syncScheduleNotifications(), syncScheduleCompanionEvents()]);
      }
    } else {
      const moved = await postponeScheduleOccurrence(candidate.id, target);
      if (!moved.ok) {
        options.commitMessages([...outgoingMessages, createSubjectiveMessage('I', moved.reason === 'conflict' ? `新的日期和现有安排撞在一起啦，所以“${candidate.title}”还在原来的日期。` : `这次没有完整改好，所以“${candidate.title}”还在原来的日期。`)]);
        return true;
      }
      await cancelNotifications(moved.notificationIds);
      await syncScheduleNotifications();
      await cancelNotifications(await removeScheduleCompanionEvents([candidate.id]));
      await syncScheduleCompanionEvents();
    }
    setPendingPostponeText(null);
    options.emitScheduleDataChanged({ reason: candidate.kind === 'todo' ? 'todo' : 'schedule' });
    options.commitMessages([...outgoingMessages, createSubjectiveMessage('I', `好，“${candidate.title}”已经推迟好啦。`)]);
    return true;
  };

  const cancelScheduleReview = async (review: ScheduleReviewAction) => {
    if (isRetiredMemoryActionReview(review) || review.kind !== 'cancel') return;
    const notificationIds = await cancelScheduleOccurrence(review.occurrence.id);
    await cancelNotifications(notificationIds);
    options.emitScheduleDataChanged({ dateKey: dateKey(review.occurrence.scheduledStartAt), reason: 'schedule' });
    dismissScheduleReview(review.reviewId);
    options.onNotice(`已经取消这次啦：${review.occurrence.title}`, 2600);
  };

  const saveHabitReview = async (review: ScheduleReviewAction) => {
    if (isRetiredMemoryActionReview(review) || review.kind !== 'habit') return;
    const habit = await createHabit(review.draft);
    await syncHabitScheduleInstances(habit.id);
    options.emitScheduleDataChanged({ dateKey: dateKey(new Date()), reason: 'habit' });
    dismissScheduleReview(review.reviewId);
    options.onNotice(`已经收进习惯啦：${review.draft.title}`, 2600);
  };

  const acceptAmbiguousSchedule = () => {
    const text = ambiguousScheduleTextRef.current;
    setAmbiguousScheduleText(null);
    if (!text) return;
    void startSmartSchedule(text).catch((caught) => {
      options.onError(caught instanceof Error ? caught.message : '这组安排暂时没有排出来。');
    });
  };

  const discardPendingSchedulePlan = (planOverride?: PendingSchedulePlan) => {
    invalidatePendingAdjustment();
    const plan = planOverride ?? pendingSchedulePlan;
    if (plan) {
      options.onAfterwordCancelled(`plan:${plan.id}`);
      options.onPlanCardChange(plan, 'cancelled');
    }
    pendingSchedulePlanRef.current = null;
    setPendingSchedulePlan(null);
    setScheduleAdjustmentMode(false);
    options.onNotice('好，今天先不排这组。', 2200);
  };

  const confirmPendingSchedulePlan = async (planOverride?: PendingSchedulePlan) => {
    invalidatePendingAdjustment();
    const plan = planOverride ?? pendingSchedulePlan;
    if (!plan || schedulePlanSaving) return;
    if (plan.dayPlan) {
      const sessionId = options.activeSessionId;
      if (!sessionId || schedulePlanSavingRef.current || !options.persistDayPlan) return;
      const card = options.messagesRef.current.find((message) => message.schedulePlanCard?.plan.id === plan.id)?.schedulePlanCard;
      if (!card || card.plan !== plan || !['pending', 'conflict'].includes(card.status)) return;
      schedulePlanSavingRef.current = true;
      setSchedulePlanSaving(true);
      const dataEpoch = captureBackupRestoreDataEpoch();
      try {
        if (!await options.persistDayPlan(plan, 'pending', sessionId)) throw new Error('方案没有保存到本机');
        const write = await runBackupRestoreDataEpochCommit(dataEpoch, () => saveDayPlanEntries(plan.dayPlan!.entries));
        if (!write.committed) return;
        const entries = write.value;
        const savedPlan = { ...plan, dayPlan: { entries } };
        const status = entries.every((entry) => entry.saved) ? 'confirmed' as const : 'conflict' as const;
        let notificationError: string | undefined;
        try {
          if (!await options.persistDayPlan(savedPlan, status, sessionId)) throw new Error('执行结果没有保存到本机');
        } finally {
          // The schedules are already saved even if their chat card cannot be updated.
          if (canCommitBackupRestoreDataEpoch(dataEpoch)) {
            options.emitScheduleDataChanged();
            try { if (!await syncScheduleNotifications()) notificationError = 'NOTIFICATION_UNAVAILABLE'; }
            catch (error) { notificationError = error instanceof Error ? error.message : String(error); }
          }
        }
        if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return;
        const now = Date.now();
        const changed = entries.filter((entry) => !plan.dayPlan!.entries.find((prior) => prior.id === entry.id)?.saved);
        const summary = [
          `已保存：${changed.filter((entry) => (entry.saved || entry.scheduleSaved) && entry.action !== 'cancel').map((entry) => entry.title).join('、')}`,
          `已取消：${changed.filter((entry) => entry.saved && entry.action === 'cancel').map((entry) => entry.title).join('、')}`,
          `未成功：${changed.filter((entry) => !entry.saved).map((entry) => entry.title).join('、')}`,
          `失败原因：${[...changed.filter((entry) => entry.error).map((entry) => `${entry.title}：${entry.error}`), notificationError].filter(Boolean).join('；')}`,
        ].join('\n');
        await options.requestDayPlanReply?.(sessionId, [{
          callId: `${plan.id}:${now}`, toolId: 'schedule.submit_day_plan', ok: entries.every((entry) => entry.saved),
          status: entries.every((entry) => entry.saved) ? 'success' : 'error', summary,
          data: { subject: 'you', planId: plan.id, entries: changed.map((entry) => ({ id: entry.id, title: entry.title,
            action: entry.action, saved: entry.saved === true, scheduleSaved: entry.scheduleSaved === true,
            habitSaved: entry.habitSaved === true,
            startAt: entry.startAt, endAt: entry.endAt, savedOccurrenceId: entry.savedOccurrenceId, error: entry.error })), notificationError },
          startedAt: now, finishedAt: now,
        }]);
      } catch (error) {
        options.onError(error instanceof Error ? error.message : String(error));
      } finally {
        schedulePlanSavingRef.current = false;
        setSchedulePlanSaving(false);
      }
      return;
    }
    const scheduleDrafts: ScheduleDraft[] = plan.scheduled.slots.map((slot) => ({
      title: slot.displayTitle,
      notes: [
        `分类：${getCategoryConfig(slot.category).label}`,
        `象限：${getQuadrantConfig(slot.quadrant).title}`,
        `预估：${slot.estimatedMinutes}分钟`,
        `排程方案：${plan.id}`,
      ].join('\n'),
      startAt: slot.startAt,
      endAt: slot.endAt,
      reminderMinutesBefore: 5,
      recurrence: 'none',
      reminderIntensity: 'gentle',
      reminderText: `小仓鼠，${slot.title}的时间到啦，我们慢慢开始吧。`,
      source: 'ai',
      todoId: slot.taskId.startsWith('todo:') ? slot.taskId.slice(5) : undefined,
      planId: plan.id,
      companionEnabled: false,
    }));
    setSchedulePlanSaving(true);
    const createdScheduleIds: string[] = [];
    const createdTodoIds: string[] = [];
    try {
      for (const draft of scheduleDrafts) {
        if (await hasScheduleConflict(draft)) {
          options.onPlanCardChange(plan, 'conflict');
          options.onPlanConflict();
          return;
        }
      }
      for (const draft of scheduleDrafts) {
        const created = await createScheduleItem(draft);
        createdScheduleIds.push(created.id);
      }
      for (const item of plan.scheduled.unscheduled) {
        if (item.task.id.startsWith('todo:')) continue;
        const created = await createTodoItem({
          title: item.task.title,
          notes: [
            `分类：${getCategoryConfig(item.task.category).label}`,
            `象限：${getQuadrantConfig(item.task.quadrant).title}`,
            item.task.estimatedMinutes ? `预估：${item.task.estimatedMinutes}分钟` : '预估：未确定',
            `排程方案：${plan.id}`,
            item.reason === 'missing-estimate' ? '暂未可靠估时' : '当天暂时放不下',
          ].join('\n'),
          plannedForDate: plan.dateKey,
          source: 'ai',
          priority: item.task.quadrant === 'q1' ? 'high' : 'normal',
          quadrant: item.task.quadrant,
          category: item.task.category,
          estimatedMinutes: item.task.estimatedMinutes,
          reminderMode: 'followup',
        }, 'scheduled');
        createdTodoIds.push(created.id);
      }
      for (const task of plan.inhibitTasks ?? []) {
        if (task.id.startsWith('todo:')) continue;
        const created = await createTodoItem({
          title: task.title,
          plannedForDate: plan.dateKey,
          source: 'ai',
          priority: 'normal',
          quadrant: task.quadrant,
          category: task.category,
          type: 'inhibit',
          reminderMode: 'none',
          notes: `持续提醒\n排程方案：${plan.id}`,
        }, 'scheduled');
        createdTodoIds.push(created.id);
      }
      await requestNotificationPermission();
      await syncScheduleNotifications();
      await syncScheduleCompanionEvents();
      options.emitScheduleDataChanged({ dateKey: plan.dateKey, reason: scheduleDrafts.length ? 'schedule' : 'todo' });
      options.onPlanCardChange(plan, 'confirmed');
      void options.onAfterwordConfirmed(`plan:${plan.id}`, 'plan-confirmed', plan);
      setPendingSchedulePlan(null);
      setScheduleAdjustmentMode(false);
      options.onNotice(`整组安排已经收好：${scheduleDrafts.length} 个时间块，${createdTodoIds.length} 个找时间做`, 3200);
    } catch (caught) {
      await Promise.allSettled(createdScheduleIds.map((id) => deleteScheduleItem(id)));
      await Promise.allSettled(createdTodoIds.map((id) => cancelTodoItem(id)));
      await syncScheduleNotifications().catch(() => undefined);
      options.onError(caught instanceof Error ? `${caught.message}；已撤回本次已写入内容，方案还留着。` : '保存中断；已撤回本次已写入内容，方案还留着。');
    } finally {
      setSchedulePlanSaving(false);
    }
  };

  const updateGoalTimeCreditCard = (
    messageId: string,
    status: NonNullable<SubjectiveMessage['goalTimeCreditCard']>['status'],
    minutes?: number,
  ) => {
    options.commitMessages(options.messagesRef.current.map((message) => message.id === messageId && message.goalTimeCreditCard
      ? {
        ...message,
        goalTimeCreditCard: {
          ...message.goalTimeCreditCard,
          status,
          suggestedMinutes: minutes ?? message.goalTimeCreditCard.suggestedMinutes,
        },
      }
      : message));
  };

  const confirmGoalTimeCreditCard = async (message: SubjectiveMessage, minutes?: number) => {
    const card = message.goalTimeCreditCard;
    if (!card || card.status !== 'pending') return;
    const confirmed = await confirmGoalTimeCredit(card.requestId, minutes ?? card.suggestedMinutes);
    if (!confirmed || confirmed.status !== 'confirmed') {
      options.onError('这次分钟还没有安全记入目标。');
      return;
    }
    updateGoalTimeCreditCard(message.id, 'confirmed', confirmed.suggestedMinutes);
  };

  const skipGoalTimeCreditCard = async (message: SubjectiveMessage) => {
    const card = message.goalTimeCreditCard;
    if (!card || card.status !== 'pending') return;
    await skipGoalTimeCredit(card.requestId);
    updateGoalTimeCreditCard(message.id, 'skipped');
  };

  const processScheduleIntent = async (text: string, intent: ScheduleIntentKind = 'create') => {
    try {
      if (intent === 'cancel') {
        const cancelReviews = await buildCancelScheduleReviews(text);
        if (!cancelReviews.length) {
          pushScheduleReviewNotice('我还没找到小仓鼠想取消的安排。把标题、日期或时间再告诉我一点，我再找找。');
          return;
        }
        setScheduleReviews((current) => [...current, ...cancelReviews]);
        pushScheduleReviewNotice(
          cancelReviews.length === 1
            ? '我找到一条可能是小仓鼠想取消的安排啦。确认一下，我再删掉它。'
            : '我找到几条可能的安排啦。小仓鼠点一下想取消哪一条。',
        );
        return;
      }

      if (intent === 'update') {
        pushScheduleReviewNotice('这次的修改我还不能直接完成。小仓鼠可以先点开对应日程编辑。');
        return;
      }

      if (intent === 'create' && (isSmartScheduleRequest(text) || isAutoFillScheduleRequest(text)) && !looksLikeSpecificScheduleRequest(text)) {
        await startSmartSchedule(text);
        return;
      }

      if (!options.configured || !options.chatConnection) {
        pushScheduleReviewNotice('这次我还没法把它准确放进日程。小仓鼠可以先在日程页新建，或者说“明天想做 A、B、C”，让我先收进待办。');
        return;
      }

      const existingItems = await loadScheduleItemsBetween(Date.now(), Date.now() + 90 * DAY_MS);
      const plan = await generateSchedulePlan({
        apiKey: options.chatKey.trim(),
        connection: options.chatConnection,
        existingItems,
        request: text,
      });
      const todos = plan.todos;
      if (!plan.schedules.length && !todos.length) {
        pushScheduleReviewNotice('我还没看清这件事要放在什么时候。小仓鼠再告诉我大概哪天、几点，或者只说“今天”“明天”“这周”也可以。');
        return;
      }

      setScheduleReviews((current) => [
        ...current,
        ...plan.schedules.map((draft, index): ScheduleReviewAction => ({
          draft,
          kind: 'create',
          reviewId: `schedule-create-${Date.now()}-${index}`,
        })),
        ...todos.map((draft, index): ScheduleReviewAction => ({
          draft,
          kind: 'todo',
          reviewId: `todo-create-${Date.now()}-${index}`,
        })),
      ]);
      const total = plan.schedules.length + todos.length;
      pushScheduleReviewNotice(
        total === 1
          ? '我整理出一条待确认的安排啦。小仓鼠看一下，确认后我再放进日程或待办。'
          : `我整理出 ${total} 条待确认的安排啦。确认后，有具体时间的会进日程，没有具体时间的会进待办。`,
      );
    } catch (caught) {
      options.onError(caught instanceof Error ? caught.message : '日程编排暂时失败，请稍后再试。');
    }
  };

  const adjustPendingGoal = async (
    text: string,
    proposal = pendingGoalProposalRef.current,
    canCommit = () => true,
  ) => {
    if (!proposal || !options.configured || !options.chatConnection || !canCommit()) return;
    await buildGoalProposal(
      `原目标：${JSON.stringify(proposal.extracted)}\n修改要求：${text}`,
      proposal.originalText,
      canCommit,
    );
  };

  const consumePendingAdjustment = (): ((text: string) => Promise<void>) | null => {
    if (!goalAdjustmentModeRef.current && !scheduleAdjustmentModeRef.current) return null;
    const proposal = goalAdjustmentModeRef.current ? pendingGoalProposalRef.current : null;
    const plan = !proposal && scheduleAdjustmentModeRef.current ? pendingAdjustmentPlanRef.current : null;
    invalidatePendingAdjustment();
    if (!proposal && !plan) return null;
    const revision = adjustmentRevisionRef.current;
    const sessionId = options.activeSessionId;
    const dataEpoch = captureBackupRestoreDataEpoch();
    let consumed = false;
    const canCommit = () => adjustmentMountedRef.current
      && adjustmentRevisionRef.current === revision
      && optionsRef.current.activeSessionId === sessionId
      && canCommitBackupRestoreDataEpoch(dataEpoch)
      && (proposal
        ? pendingGoalProposalRef.current?.id === proposal.id
        : pendingSchedulePlanRef.current?.id === plan?.id || optionsRef.current.messages.some((message) => (
          message.schedulePlanCard?.plan.id === plan?.id
          && (message.schedulePlanCard?.status === 'pending' || message.schedulePlanCard?.status === 'conflict')
        )));
    return async (text) => {
      if (consumed) return;
      consumed = true;
      if (!text.trim() || !canCommit()) return;
      try {
        if (proposal) await adjustPendingGoal(text, proposal, canCommit);
        else if (plan?.dayPlan) await options.requestDayPlanAdjustment?.(plan, canCommit);
        else await applyScheduleAdjustments(text, plan, canCommit);
      } catch (caught) {
        if (canCommit()) options.onError(caught instanceof Error ? caught.message : '日程编排暂时失败，请稍后再试。');
      }
    };
  };

  const handlePendingPostponeFollowUp = async (
    text: string,
    outgoingMessages: SubjectiveMessage[],
  ) => {
    const original = pendingPostponeTextRef.current;
    if (!original) return false;
    const followUp = parsePostponeIntent(`推到${text}`);
    if (!followUp?.target) {
      options.commitMessages([...outgoingMessages, createSubjectiveMessage('I', '我还没认出小仓鼠说的是哪一天。可以直接说“明天”“下周一”或“2026-06-25”。')]);
      return true;
    }
    setPendingPostponeText(null);
    await handlePostponeRequest(original, outgoingMessages, followUp.target);
    return true;
  };

  const handlePendingScheduleDateFollowUp = async (text: string) => {
    const originalText = pendingScheduleDateTextRef.current;
    if (!originalText) return false;
    const targetDateKey = resolveScheduleDate(text);
    if (!targetDateKey) {
      if (looksLikeCasualNonScheduleText(text)) {
        setPendingScheduleDateText(null);
        return false;
      }
      pushScheduleReviewNotice('我还没认出小仓鼠说的是哪一天。可以直接说“明天”“下周一”或“2026-06-25”。');
      return true;
    }
    setPendingScheduleDateText(null);
    await startSmartSchedule(originalText, targetDateKey);
    return true;
  };

  const requestAmbiguousScheduleConfirmation = (
    text: string,
    outgoingMessages: SubjectiveMessage[],
  ) => {
    setAmbiguousScheduleText(text);
    options.commitMessages([
      ...outgoingMessages,
      createSubjectiveMessage('I', '小仓鼠是想把这件事记成待办或安排吗？我先不记录，等小仓鼠确认。'),
    ]);
  };

  const adjustPendingGoalAction = useLatestCallback(adjustPendingGoal);
  const applyScheduleAdjustmentsAction = useLatestCallback(applyScheduleAdjustments);
  const acceptAmbiguousScheduleAction = useLatestCallback(acceptAmbiguousSchedule);
  const editDayPlanEntry = (plan: PendingSchedulePlan, entryId: string, change: DayPlanChange) => {
    if (!plan.dayPlan || schedulePlanSavingRef.current) return;
    invalidatePendingAdjustment();
    try {
      const entries = plan.dayPlan.entries.map((entry) => entry.id !== entryId || entry.saved || entry.scheduleSaved ? entry
        : { ...applyChatScheduleTimeChange(entry, change), error: undefined });
      options.onPlanCardChange({ ...plan, dayPlan: { entries } }, 'pending');
    } catch (error) { options.onError(error instanceof Error ? error.message : 'invalid-day-plan-time'); }
  };
  const removeDayPlanEntry = (plan: PendingSchedulePlan, entryId: string) => {
    if (!plan.dayPlan || schedulePlanSavingRef.current) return;
    invalidatePendingAdjustment();
    const target = plan.dayPlan.entries.find(entry => entry.id === entryId && !entry.saved && !entry.scheduleSaved);
    const entries = plan.dayPlan.entries.flatMap((entry) => entry.saved || entry.scheduleSaved || !target
      || entry.id !== entryId && entry.parentTodoId !== target.targetTodoId ? [entry]
      : entry.occurrenceId ? [{ ...entry, action: 'cancel' as const, error: undefined }] : []);
    options.onPlanCardChange({ ...plan, dayPlan: { entries } }, 'pending');
  };
  const setDayPlanEndQuestions = (plan: PendingSchedulePlan, enabled: boolean) => {
    if (!plan.dayPlan || schedulePlanSavingRef.current) return;
    invalidatePendingAdjustment();
    const entries = plan.dayPlan.entries.map(entry => entry.saved || entry.scheduleSaved || entry.endAt === undefined ? entry
      : { ...entry, companionEnabled: enabled, error: undefined });
    options.onPlanCardChange({ ...plan, dayPlan: { entries } }, 'pending');
  };
  const buildGoalProposalAction = useLatestCallback(buildGoalProposal);
  const buildScheduleChangeCardAction = useLatestCallback(buildScheduleChangeCard);
  const cancelPendingGoalAction = useLatestCallback(cancelPendingGoal);
  const cancelScheduleChangeCardAction = useLatestCallback(cancelScheduleChangeCard);
  const cancelScheduleReviewAction = useLatestCallback(cancelScheduleReview);
  const confirmGoalTimeCreditCardAction = useLatestCallback(confirmGoalTimeCreditCard);
  const confirmPendingGoalAction = useLatestCallback(confirmPendingGoal);
  const confirmPendingSchedulePlanAction = useLatestCallback(confirmPendingSchedulePlan);
  const consumePendingAdjustmentAction = useLatestCallback(consumePendingAdjustment);
  const confirmScheduleChangeCardAction = useLatestCallback(confirmScheduleChangeCard);
  const discardPendingSchedulePlanAction = useLatestCallback(discardPendingSchedulePlan);
  const handleGoalHabitQuickActionAction = useLatestCallback(handleGoalHabitQuickAction);
  const handleHabitListQueryAction = useLatestCallback(handleHabitListQuery);
  const handleHabitRuleChangeAction = useLatestCallback(handleHabitRuleChange);
  const handleNarrativeCompletionSideEffectAction = useLatestCallback(handleNarrativeCompletionSideEffect);
  const handlePendingPostponeFollowUpAction = useLatestCallback(handlePendingPostponeFollowUp);
  const handlePendingScheduleDateFollowUpAction = useLatestCallback(handlePendingScheduleDateFollowUp);
  const handlePostponeRequestAction = useLatestCallback(handlePostponeRequest);
  const handleUnifiedCompletionAckAction = useLatestCallback(handleUnifiedCompletionAck);
  const processScheduleIntentAction = useLatestCallback(processScheduleIntent);
  const requestAmbiguousScheduleConfirmationAction = useLatestCallback(requestAmbiguousScheduleConfirmation);
  const saveHabitReviewAction = useLatestCallback(saveHabitReview);
  const skipGoalTimeCreditCardAction = useLatestCallback(skipGoalTimeCreditCard);
  const startSmartScheduleAction = useLatestCallback(startSmartSchedule);
  const updateGoalTimeCreditCardAction = useLatestCallback(updateGoalTimeCreditCard);

  useEffect(() => {
    if (!scheduleReviews.some(isRetiredMemoryActionReview)) return;
    setScheduleReviews((current) => current.filter((review) => !isRetiredMemoryActionReview(review)));
  }, [scheduleReviews]);

  useEffect(() => {
    adjustmentMountedRef.current = true;
    invalidatePendingAdjustment();
    pendingGoalProposalRef.current = null;
    pendingScheduleDateTextRef.current = null;
    pendingPostponeTextRef.current = null;
    ambiguousScheduleTextRef.current = null;
    setPendingGoalProposal(null);
    setPendingScheduleDateText(null);
    setPendingPostponeText(null);
    setAmbiguousScheduleText(null);
    setEditingGoalTimeCredit(null);
    return () => {
      adjustmentMountedRef.current = false;
      adjustmentRevisionRef.current += 1;
      pendingAdjustmentPlanRef.current = null;
      goalAdjustmentModeRef.current = false;
      scheduleAdjustmentModeRef.current = false;
    };
  }, [options.activeSessionId, invalidatePendingAdjustment]);

  useEffect(() => {
    const recoverable = [...options.messages]
      .reverse()
      .find(
        (message) => message.schedulePlanCard?.status === 'pending'
          || message.schedulePlanCard?.status === 'conflict',
      );
    const plan = recoverable?.schedulePlanCard?.plan ?? null;
    pendingSchedulePlanRef.current = plan;
    setPendingSchedulePlan(plan);
  }, [options.activeSessionId, options.messages]);

  return {
    editDayPlanEntry,
    setDayPlanEndQuestions,
    removeDayPlanEntry,
    acceptAmbiguousSchedule: acceptAmbiguousScheduleAction,
    adjustPendingGoal: adjustPendingGoalAction,
    ambiguousScheduleText,
    applyScheduleAdjustments: applyScheduleAdjustmentsAction,
    beginGoalAdjustment,
    beginGoalTimeCreditEdit,
    beginScheduleAdjustment,
    buildGoalProposal: buildGoalProposalAction,
    buildScheduleChangeCard: buildScheduleChangeCardAction,
    cancelPendingGoal: cancelPendingGoalAction,
    cancelScheduleChangeCard: cancelScheduleChangeCardAction,
    cancelScheduleReview: cancelScheduleReviewAction,
    clearGoalTimeCreditEdit,
    clearPendingPostponeText,
    clearPendingScheduleDateText,
    clearScheduleReviews,
    confirmGoalTimeCreditCard: confirmGoalTimeCreditCardAction,
    confirmPendingGoal: confirmPendingGoalAction,
    confirmPendingSchedulePlan: confirmPendingSchedulePlanAction,
    confirmScheduleChangeCard: confirmScheduleChangeCardAction,
    consumePendingAdjustment: consumePendingAdjustmentAction,
    discardPendingSchedulePlan: discardPendingSchedulePlanAction,
    dismissScheduleReview,
    editingGoalTimeCredit,
    goalAdjustmentMode,
    handleGoalHabitQuickAction: handleGoalHabitQuickActionAction,
    handleHabitListQuery: handleHabitListQueryAction,
    handleHabitRuleChange: handleHabitRuleChangeAction,
    handleNarrativeCompletionSideEffect: handleNarrativeCompletionSideEffectAction,
    handlePendingPostponeFollowUp: handlePendingPostponeFollowUpAction,
    handlePendingScheduleDateFollowUp: handlePendingScheduleDateFollowUpAction,
    handlePostponeRequest: handlePostponeRequestAction,
    handleUnifiedCompletionAck: handleUnifiedCompletionAckAction,
    openAmbiguousScheduleReview,
    pendingGoalProposal,
    pendingPostponeText,
    pendingScheduleDateText,
    pendingSchedulePlan,
    processScheduleIntent: processScheduleIntentAction,
    requestAmbiguousScheduleConfirmation: requestAmbiguousScheduleConfirmationAction,
    saveHabitReview: saveHabitReviewAction,
    scheduleAdjustmentMode,
    schedulePlanSaving,
    skipGoalTimeCreditCard: skipGoalTimeCreditCardAction,
    startSmartSchedule: startSmartScheduleAction,
    takeRejectedAmbiguousScheduleText,
    updateGoalTimeCreditCard: updateGoalTimeCreditCardAction,
    visibleScheduleReviews,
  };
}
