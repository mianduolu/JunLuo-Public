import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  BackHandler,
  DeviceEventEmitter,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { runBackupProtectedTask } from '../backup/backupService';
import {
  canCommitBackupRestoreDataEpoch,
  captureBackupRestoreDataEpoch,
  runBackupRestoreDataEpochCommit,
} from '../backup/backupRestoreCoordinator';
import { DateTimePickerSheet } from '../components/DateTimePickerSheet';
import { DayTemplateScreen } from './schedule/DayTemplateScreen';
import { useAiConfigPreferences } from '../ai/AiConfigPreferences';
import { AppText as Text, AppTextInput as TextInput } from '../components/AppText';
import { colors } from '../theme/colors';
import type { Navigate } from '../types/navigation';
import { buildRecurrenceRule, formatRecurrenceLabel } from '../schedule/calendarRules';
import {
  clockFromTimestamp,
  combineDateTime as combineSelectionDateTime,
  dateKeyFromTimestamp,
  reminderMinutesFromSelection,
  selectionFromReminderMinutes,
  type DateTimeSelection,
} from '../schedule/dateTimeSelection';
import { takePendingScheduleRequest } from '../schedule/scheduleHandoff';
import { SCHEDULE_DATA_CHANGED_EVENT, type ScheduleDataChangedPayload } from '../schedule/scheduleEvents';
import {
  cancelNotifications,
  hasNotificationPermission,
  requestNotificationPermission,
  syncScheduleNotifications,
} from '../schedule/scheduleNotifications';
import {
  generateSchedulePlan,
  generateWeekReview,
} from '../schedule/schedulePlanner';
import {
  generateWeekReviewFromLocalData,
  hasWeekReviewSourceData,
  loadWeekReview,
  makeWeekReview,
  saveWeekReview,
  shouldOfferWeekReview,
  weekKeysFromStart,
  weekStartKeyFromDate,
  type WeekReview,
} from '../schedule/weekReviewStore';
import {
  createGoal,
  loadGoal,
  loadGoals,
  updateGoal,
  type Goal,
  type GoalDraft,
} from '../schedule/goalStore';
import {
  archiveHabit,
  createHabit,
  loadHabitSummaryForDate,
  loadHabits,
  loadOwnActiveHabits,
  getOwnHabitPeriodProgress,
  setHabitLogProgress,
  updateHabit,
  type Habit,
  type HabitDraft,
  type HabitForDate,
  type HabitSummaryForDate,
} from '../schedule/habitStore';
import {
  archiveDailyChallenge,
  createDailyChallenge,
  generateDailyChallenges,
  loadDailyChallengesForDate,
  updateDailyChallenge,
  type DailyChallengeForDate,
} from '../schedule/dailyChallengeStore';
import {
  completeHabitScheduleOccurrence,
  deleteHabitWithScheduleInstances,
  completeNextHabitInstance,
  skipHabitScheduleOccurrence,
  syncAllHabitScheduleInstances,
  syncHabitScheduleInstances,
} from '../schedule/habitScheduleStore';
import {
  reopenScheduleOccurrence,
  cancelScheduleOccurrence,
  createScheduleItem,
  dateKey,
  deleteScheduleItem,
  hasScheduleConflict,
  loadDatesWithSchedules,
  loadScheduleItemsBetween,
  loadPendingScheduleOccurrencesBetween,
  loadScheduleItemsForDate,
  moveScheduleOccurrenceToQuadrant,
  updateScheduleItem,
  type ScheduleDraft,
  type ScheduleReminderIntensity,
  type ScheduleOccurrence,
  type ScheduleRecurrence,
} from '../schedule/scheduleStore';
import { completeScheduleOccurrenceOnce } from '../schedule/scheduleCompletionOnce';
import { completeTodoItemOnce } from '../schedule/todoCompletionOnce';
import {
  acknowledgeInhibitTodo,
  cancelTodoItem,
  endInhibitTodo,
  inferTodoType,
  reopenTodoItem,
  createTodoItem,
  loadActiveInhibitTodosForDate,
  loadCompletedTodoItemsForDates,
  loadInhibitLogsForDate,
  loadTodoItemsByGoalId,
  loadTodoItemById,
  loadTodoItemsForDates,
  loadTodoItemsForDate,
  loadTodayTodoItems,
  moveTodoToQuadrant,
  postponeTodoToTomorrow,
  setInhibitOutcome,
  todoDraftFromTitle,
  updateTodoItem,
  type TodoDraft,
  type TodoItem,
  type TodoCategory,
  type TodoQuadrant,
  type TodoInhibitLog,
  type TodoType,
  type InhibitOutcome,
} from '../schedule/todoStore';
import { ChoiceSheet, type ChoiceSheetState } from './schedule/ChoiceSheet';
import { freezeLegacyExecutionSessions } from '../schedule/taskExecutionStore';
import { adjustGoalTimeContribution, generateGoalTodosForDate } from '../schedule/goalProgressStore';
import { loadDayTemplateInstances, toggleDayTemplateInstance, type DayTemplateInstance } from '../schedule/dayTemplateInstanceStore';
import { DraftEditor, type EditableDraft } from './schedule/DraftEditor';
import { TaskEditSheet, type TaskEditDraft } from './schedule/TaskEditSheet';
import { GoalEditSheet, type GoalEditDraft } from './schedule/GoalEditSheet';
import { HabitEditSheet, type HabitEditDraft } from './schedule/HabitEditSheet';
import { DailyChallengeEditSheet, type DailyChallengeEditDraft } from './schedule/DailyChallengeEditSheet';
import { GoalDetailSheet } from './schedule/GoalDetailSheet';
import { TodayHabitCard } from './schedule/TodayHabitCard';
import { InhibitGuardrailCard } from './schedule/InhibitGuardrailCard';
import { WeekReviewScreen } from './schedule/WeekReviewScreen';
import { HabitManagerScreen, type OwnHabitProgress } from './schedule/HabitManagerScreen';
import { loadReadingLibraryStrict } from '../reading/readingStore';
import { loadScheduleDetailOccurrence, loadScheduleReadingDetails, scheduleReadingProgress, scheduleReadingReadFailure, type ScheduleReadingDetails } from '../schedule/scheduleReadingDetails';
import { GoalManagerScreen } from './schedule/GoalManagerScreen';
import { styles } from './schedule/ScheduleScreen.styles';
import { DayScheduleView } from './schedule/DayScheduleView';
import { WeekScheduleView } from './schedule/WeekScheduleView';
import { MonthScheduleView } from './schedule/MonthScheduleView';
import { ScheduleViewTaskCard } from './schedule/ScheduleViewTaskCard';
import { QuickTodoTypeSelector } from './schedule/QuickTodoTypeSelector';
import {
  categoryConfig,
  dayDisplayModeConfig,
  displayRangeLabels,
  getCategoryConfig,
  getQuadrantConfig,
  quadrantConfig,
  viewModeConfig,
  viewModeLabels,
} from '../schedule/taskMeta';
import {
  addDays,
  buildViewTasks,
  dateFromKey,
  dateKeysForDisplayRange,
  formatTime,
  monthKeysForDate,
  scheduleCalendarMarks,
  scheduleExecutionDetails,
  type ScheduleReadingSnapshot,
  weekKeysForDate,
} from '../schedule/scheduleViewUtils';
import type { DayDisplayMode, DisplayRange, ScheduleViewTask, ViewMode } from '../schedule/scheduleViewTypes';

const DAY_MS = 24 * 60 * 60 * 1000;
const recurrenceLabels: Record<ScheduleRecurrence, string> = {
  none: '不重复',
  daily: '每天',
  weekdays: '工作日',
  legalWorkday: '法定工作日',
  weekly: '每周',
  monthly: '每月',
  yearly: '每年',
  lunarYearly: '农历每年',
};
const reminderIntensityLabels: Record<ScheduleReminderIntensity, string> = {
  gentle: '温柔提醒',
  strong: '强力督促',
  blast: '轰炸叫醒',
};
const quickTimes = ['08:00', '09:00', '12:00', '14:00', '18:00', '21:00', '23:00'];
const reminderPresets = ['0', '5', '10', '15', '30', '60'];
const weekDayLabels = ['一', '二', '三', '四', '五', '六', '日'];

function useAndroidKeyboardLift(active: boolean) {
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  useEffect(() => {
    if (Platform.OS !== 'android' || !active) {
      setKeyboardHeight(0);
      return undefined;
    }
    const showSub = Keyboard.addListener('keyboardDidShow', (event) => {
      setKeyboardHeight(event.endCoordinates.height);
    });
    const hideSub = Keyboard.addListener('keyboardDidHide', () => {
      setKeyboardHeight(0);
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, [active]);
  return Platform.OS === 'android' ? keyboardHeight : 0;
}

function keyboardLiftStyle(keyboardLift: number) {
  return keyboardLift > 0 ? { transform: [{ translateY: -keyboardLift }] } : null;
}

function useStableCallback<T extends (...args: never[]) => unknown>(callback: T): T {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  return useCallback(((...args: Parameters<T>) => callbackRef.current(...args)) as T, []);
}

type EditorMode =
  | { kind: 'none' }
  | { kind: 'create' }
  | { kind: 'edit'; itemId: string; occurrenceId: string };

type QuadrantRect = { x: number; y: number; width: number; height: number };
type DaySurfaceSnapshot = {
  dateKey: string;
  occurrences: ScheduleOccurrence[];
  templateInstances: DayTemplateInstance[];
  todos: TodoItem[];
};
let lastDaySurfaceSnapshot: DaySurfaceSnapshot | null = null;
type QuickAddTool = 'date' | 'category' | 'quadrant' | 'subtasks' | 'notes' | null;
type DateTimePickerTarget = { kind: 'quick' } | { kind: 'draft' } | { kind: 'goal' } | { kind: 'proposal'; index: number };

function combineDateTime(date: string, time: string) {
  return new Date(`${date}T${time}:00`).getTime();
}

function normalizeTimeInput(value: string) {
  const match = value.match(/^(\d{1,2}):?(\d{0,2})$/);
  if (!match) return value;
  const hour = Math.min(23, Math.max(0, Number(match[1])));
  const minute = Math.min(59, Math.max(0, Number(match[2] || '0')));
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function shiftTime(value: string, minutes: number) {
  const [hour = '0', minute = '0'] = value.split(':');
  const date = new Date(2026, 0, 1, Number(hour), Number(minute));
  date.setMinutes(date.getMinutes() + minutes);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function shiftReminder(value: string, amount: number) {
  const current = Number(value);
  const next = Math.max(0, (Number.isFinite(current) ? current : 0) + amount);
  return String(next);
}

function tomorrowKey() {
  return dateKey(addDays(new Date(), 1));
}

function weekDayFromKey(day: string) {
  const date = new Date(`${day}T12:00:00`);
  return date.getDay() || 7;
}

function buildTaskNotes(notes: string, subtasks: string[]) {
  const cleanNotes = notes.trim();
  const cleanSubtasks = subtasks.map((item) => item.trim()).filter(Boolean);
  return [
    cleanNotes,
    cleanSubtasks.length ? `子任务：\n${cleanSubtasks.map((item) => `- ${item}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n').slice(0, 180);
}

function blankDraft(selectedDate: string): EditableDraft {
  const nextHour = new Date(Date.now() + 60 * 60 * 1000);
  return {
    companionEnabled: false,
    title: '',
    notes: '',
    date: selectedDate,
    time: `${String(nextHour.getHours()).padStart(2, '0')}:00`,
    endTime: '',
    estimateMinutes: undefined,
    letterTicketEnabled: false,
    rangeEndDate: undefined,
    reminderMinutes: '5',
    reminderIntensity: 'gentle',
    recurrence: 'none',
    reminderText: '',
    source: 'manual',
  };
}

function editableFromDraft(draft: ScheduleDraft): EditableDraft {
  const estimateMinutes = draft.endAt ? Math.round((draft.endAt - draft.startAt) / 60000) : undefined;
  return {
    companionEnabled: draft.companionEnabled === true,
    startReminderEnabled: draft.startReminderEnabled,
    title: draft.title,
    notes: draft.notes,
    date: dateKey(draft.startAt),
    time: formatTime(draft.startAt),
    endTime: draft.endAt ? formatTime(draft.endAt) : '',
    endTimeDate: draft.endAt ? dateKey(draft.endAt) : undefined,
    estimateMinutes,
    letterTicketEnabled: draft.letterTicketEnabled === true,
    rangeEndDate: draft.rangeEndAt ? dateKey(draft.rangeEndAt) : undefined,
    reminderMinutes: String(draft.reminderMinutesBefore),
    recurrence: draft.recurrence,
    reminderIntensity: draft.reminderIntensity,
    reminderText: draft.reminderText,
    source: draft.source,
  };
}

function toScheduleDraft(draft: EditableDraft): ScheduleDraft | null {
  const startAt = combineDateTime(draft.date, draft.time);
  const endAt = draft.endTime ? combineDateTime(draft.endTimeDate ?? draft.date, draft.endTime) : undefined;
  const reminderMinutesBefore = Number(draft.reminderMinutes);
  if (
    !draft.title.trim() ||
    !Number.isFinite(startAt) ||
    startAt <= Date.now() ||
    (endAt !== undefined && (!Number.isFinite(endAt) || endAt <= startAt)) ||
    !Number.isFinite(reminderMinutesBefore) ||
    reminderMinutesBefore < 0
  ) {
    return null;
  }
  return {
    title: draft.title.trim(),
    companionEnabled: draft.companionEnabled,
    startReminderEnabled: draft.startReminderEnabled,
    notes: draft.notes.trim(),
    startAt,
    endAt,
    reminderMinutesBefore,
    recurrence: draft.recurrence,
    recurrenceRule: buildRecurrenceRule(draft.recurrence, startAt),
    rangeEndAt: draft.rangeEndDate ? combineDateTime(draft.rangeEndDate, draft.time) : undefined,
    reminderText:
      draft.reminderText.trim() ||
      (reminderMinutesBefore > 0
        ? `小仓鼠，${draft.title.trim()}还有 ${reminderMinutesBefore} 分钟，我们先慢慢准备一下吧。`
        : `小仓鼠，${draft.title.trim()}的时间到啦，我们慢慢开始吧。`),
    reminderIntensity: draft.reminderIntensity,
    source: draft.source,
    letterTicketEnabled: draft.letterTicketEnabled,
  };
}

function selectionFromDraft(draft: EditableDraft): DateTimeSelection {
  const reminder = selectionFromReminderMinutes(draft.date, draft.time, Number(draft.reminderMinutes));
  return {
    date: draft.date,
    endDate: draft.rangeEndDate,
    endTime: draft.endTime || undefined,
    endTimeDate: draft.endTimeDate ?? draft.date,
    estimateMinutes: draft.estimateMinutes,
    defaultReminderMinutes: Number(draft.reminderMinutes) > 0 ? Number(draft.reminderMinutes) : undefined,
    recurrence: draft.recurrence,
    reminderChoice: reminder.reminderChoice,
    reminderClock: reminder.reminderClock,
    reminderIntensity: draft.reminderIntensity,
    time: draft.time,
  };
}

function draftWithSelection(draft: EditableDraft, selection: DateTimeSelection): EditableDraft {
  return {
    ...draft,
    date: selection.date,
    endTime: selection.endTime ?? '',
    endTimeDate: selection.endTime ? selection.endTimeDate ?? selection.date : undefined,
    estimateMinutes: selection.estimateMinutes,
    rangeEndDate: selection.endDate,
    recurrence: selection.recurrence,
    reminderIntensity: selection.reminderIntensity,
    reminderMinutes: String(reminderMinutesFromSelection(selection)),
    time: selection.time ?? draft.time,
  };
}

export function ScheduleScreen({ active = true, navigate }: { active?: boolean; navigate: Navigate }) {
  const insets = useSafeAreaInsets();
  const keyboardLift = useAndroidKeyboardLift(active);
  const { chatConnection, chatKey, profile } = useAiConfigPreferences();
  const initialDate = useRef(dateKey(new Date())).current;
  const initialSurfaceSnapshot = lastDaySurfaceSnapshot?.dateKey === initialDate ? lastDaySurfaceSnapshot : null;
  const [selectedDate, setSelectedDate] = useState(initialDate);
  const [viewMode, setViewMode] = useState<ViewMode>('day');
  const [dayDisplayMode, setDayDisplayMode] = useState<DayDisplayMode>('quadrant');
  const [occurrences, setOccurrences] = useState<ScheduleOccurrence[]>(initialSurfaceSnapshot?.occurrences ?? []);
  const [weekOccurrences, setWeekOccurrences] = useState<ScheduleOccurrence[]>([]);
  const [monthOccurrenceKeys, setMonthOccurrenceKeys] = useState<string[]>([]);
  const [marked, setMarked] = useState<Record<string, object>>({});
  const [editorMode, setEditorMode] = useState<EditorMode>({ kind: 'none' });
  const [draft, setDraft] = useState<EditableDraft | null>(null);
  const [permissionGranted, setPermissionGranted] = useState<boolean | null>(null);
  const [planningText, setPlanningText] = useState('');
  const [planning, setPlanning] = useState(false);
  const [proposals, setProposals] = useState<EditableDraft[]>([]);
  const [todoProposals, setTodoProposals] = useState<TodoDraft[]>([]);
  const [visibleTodos, setVisibleTodos] = useState<TodoItem[]>(initialSurfaceSnapshot?.todos ?? []);
  const [surfaceLoading, setSurfaceLoading] = useState(!initialSurfaceSnapshot);
  const [surfaceError, setSurfaceError] = useState('');
  const [dayDetailsFailed, setDayDetailsFailed] = useState(false);
  const [auxiliaryStatus, setAuxiliaryStatus] = useState<'loading' | 'failed' | ''>('');
  const [rangeTodos, setRangeTodos] = useState<TodoItem[]>([]);
  const [rangeOccurrences, setRangeOccurrences] = useState<ScheduleOccurrence[]>([]);
  const [weekTodos, setWeekTodos] = useState<TodoItem[]>([]);
  const [monthTodos, setMonthTodos] = useState<TodoItem[]>([]);
  const [newTodoText, setNewTodoText] = useState('');
  const [newTodoEstimate, setNewTodoEstimate] = useState('');
  const [newTodoQuadrant, setNewTodoQuadrant] = useState<TodoQuadrant>('q2');
  const [newTodoCategory, setNewTodoCategory] = useState<TodoCategory>('other');
  const [newTodoDate, setNewTodoDate] = useState('');
  const [newTodoTime, setNewTodoTime] = useState('');
  const [newTodoEndTime, setNewTodoEndTime] = useState('');
  const [newTodoReminderMinutes, setNewTodoReminderMinutes] = useState('5');
  const [newTodoReminderIntensity, setNewTodoReminderIntensity] = useState<ScheduleReminderIntensity>('gentle');
  const [newTodoRecurrence, setNewTodoRecurrence] = useState<ScheduleRecurrence>('none');
  const [newTodoRangeEndDate, setNewTodoRangeEndDate] = useState('');
  const [newTodoNotes, setNewTodoNotes] = useState('');
  const [newTodoSubtaskDraft, setNewTodoSubtaskDraft] = useState('');
  const [newTodoSubtasks, setNewTodoSubtasks] = useState<string[]>([]);
  const [newTodoType, setNewTodoType] = useState<TodoType | null>(null);
  const newTodoTypeRef = useRef<TodoType | null>(null);
  const [quickAddTool, setQuickAddTool] = useState<QuickAddTool>(null);
  const [displayRange, setDisplayRange] = useState<DisplayRange>('today');
  const [rangeDropdownVisible, setRangeDropdownVisible] = useState(false);
  const [showPendingTodos, setShowPendingTodos] = useState(true);
  const [showCompletedTodos, setShowCompletedTodos] = useState(true);
  const [drawerVisible, setDrawerVisible] = useState(false);
  const [goalManagerVisible, setGoalManagerVisible] = useState(false);
  const [quickAddVisible, setQuickAddVisible] = useState(false);
  const [editingTodo, setEditingTodo] = useState<TodoItem | null>(null);
  const [taskDraft, setTaskDraft] = useState<TaskEditDraft | null>(null);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [goalDraft, setGoalDraft] = useState<GoalEditDraft | null>(null);
  const [selectedGoal, setSelectedGoal] = useState<Goal | null>(null);
  const [selectedGoalTasks, setSelectedGoalTasks] = useState<TodoItem[]>([]);
  const selectedGoalIdRef = useRef<string | null>(null);
  const [habitManagerVisible, setHabitManagerVisible] = useState(false);
  const [weekReviewVisible, setWeekReviewVisible] = useState(false);
  const [dayTemplateVisible, setDayTemplateVisible] = useState(false);
  const [weekReview, setWeekReview] = useState<WeekReview | null>(null);
  const [weekReviewLoading, setWeekReviewLoading] = useState(false);
  const [weekReviewError, setWeekReviewError] = useState('');
  const [habitSummary, setHabitSummary] = useState<HabitSummaryForDate>({ dateKey: selectedDate, habits: [], completed: [], pending: [], done: 0, total: 0 });
  const [allHabits, setAllHabits] = useState<Habit[]>([]);
  const [ownHabitProgress, setOwnHabitProgress] = useState<OwnHabitProgress[]>([]);
  const [habitDraft, setHabitDraft] = useState<HabitEditDraft | null>(null);
  const [dailyChallenges, setDailyChallenges] = useState<DailyChallengeForDate[]>([]);
  const [templateInstances, setTemplateInstances] = useState<DayTemplateInstance[]>(initialSurfaceSnapshot?.templateInstances ?? []);
  const [inhibitTodos, setInhibitTodos] = useState<TodoItem[]>([]);
  const [inhibitLogs, setInhibitLogs] = useState<TodoInhibitLog[]>([]);
  const [managedDailyChallenges, setManagedDailyChallenges] = useState<DailyChallengeForDate[]>([]);
  const [challengeDraft, setChallengeDraft] = useState<DailyChallengeEditDraft | null>(null);
  const [executionTick, setExecutionTick] = useState(Date.now());
  const [readingSnapshot, setReadingSnapshot] = useState<ScheduleReadingSnapshot>({ status: 'loading' });
  const [readingDetail, setReadingDetail] = useState<{ occurrence: ScheduleOccurrence; loading: boolean; failed?: boolean; clockFailed?: boolean; data?: ScheduleReadingDetails } | null>(null);
  const readingDetailRequest = useRef(0);
  const readingDetailClockRequest = useRef(0);
  const closeReadingDetail = useStableCallback(() => { readingDetailRequest.current++; setReadingDetail(null); });
  useEffect(() => () => { readingDetailRequest.current++; }, []);
  const refreshReadingDetailClock = useStableCallback(async () => {
    if (!readingDetail) return;
    const request = readingDetailRequest.current;
    const clockRequest = ++readingDetailClockRequest.current;
    const epoch = captureBackupRestoreDataEpoch();
    try {
      const occurrence = await loadScheduleDetailOccurrence(readingDetail.occurrence);
      if (request !== readingDetailRequest.current || clockRequest !== readingDetailClockRequest.current) return;
      const valid = epoch !== null && canCommitBackupRestoreDataEpoch(epoch);
      setReadingDetail(current => current ? { ...current, ...(valid ? { occurrence } : {}), clockFailed: !valid } : current);
    } catch {
      if (request === readingDetailRequest.current && clockRequest === readingDetailClockRequest.current)
        setReadingDetail(current => current ? { ...current, clockFailed: true } : current);
    }
  });
  useEffect(() => {
    if (active && readingDetail) void refreshReadingDetailClock();
  }, [active, executionTick, readingDetail?.occurrence.id, refreshReadingDetailClock]);
  const [draggingTask, setDraggingTask] = useState<ScheduleViewTask | null>(null);
  const [dragPoint, setDragPoint] = useState({ x: 0, y: 0 });
  const [hoverQuadrant, setHoverQuadrant] = useState<TodoQuadrant | null>(null);
  const [choiceSheet, setChoiceSheet] = useState<ChoiceSheetState | null>(null);
  const [dateTimePickerTarget, setDateTimePickerTarget] = useState<DateTimePickerTarget | null>(null);
  const quadrantRefs = useRef<Record<TodoQuadrant, View | null>>({ q1: null, q2: null, q3: null, q4: null });
  const quadrantRects = useRef<Record<TodoQuadrant, QuadrantRect | null>>({ q1: null, q2: null, q3: null, q4: null });
  const activeRef = useRef(active);
  const refreshRevisionRef = useRef(0);
  const surfaceDateRef = useRef(initialDate);
  const habitSyncStartedRef = useRef(false);
  activeRef.current = active;
  const configured = !!chatConnection?.baseUrl.trim() && !!chatConnection?.model.trim() && !!chatKey.trim();

  const refresh = useStableCallback(async (day = selectedDate) => {
    if (!activeRef.current) return;
    const revision = ++refreshRevisionRef.current;
    const canCommit = () => activeRef.current && refreshRevisionRef.current === revision;
    setSurfaceLoading(true);
    setSurfaceError('');
    setDayDetailsFailed(false);
    setAuxiliaryStatus('loading');
    setReadingSnapshot({ status: 'loading' });
    void loadReadingLibraryStrict().then(books => {
      if (canCommit()) setReadingSnapshot({ status: 'loaded', books });
    }).catch(() => {
      if (canCommit()) setReadingSnapshot({ status: 'failed' });
    });
    if (surfaceDateRef.current !== day) {
      setOccurrences([]);
      setTemplateInstances([]);
      setVisibleTodos([]);
      surfaceDateRef.current = day;
    }
    const date = new Date(`${day}T12:00:00`);
    const dailyPromise = (async () => {
      try {
        const daily = await loadScheduleItemsForDate(date, showCompletedTodos);
        if (!canCommit()) return null;
        setOccurrences(daily);
        return daily;
      } catch (error) {
        console.warn('[schedule-screen] day-read failed', error instanceof Error ? error.message : 'unknown-error');
        if (canCommit()) setSurfaceError('日程读取失败，请重新进入此页重试。');
        return null;
      }
    })();
    const readDayTodos = async () => {
      try {
        const [pendingItems, completedItems] = await Promise.all([
          showPendingTodos ? loadTodoItemsForDate(day) : Promise.resolve([]),
          showCompletedTodos ? loadCompletedTodoItemsForDates([day], 80) : Promise.resolve([]),
        ]);
        const items = [...pendingItems, ...completedItems];
        if (!canCommit()) return null;
        setVisibleTodos(items);
        return items;
      } catch {
        if (canCommit()) setDayDetailsFailed(true);
        return null;
      }
    };
    const dayTodosPromise = readDayTodos();
    const templateInstancesPromise = (async () => {
      try {
        const items = await loadDayTemplateInstances(day);
        if (!canCommit()) return null;
        setTemplateInstances(items);
        return items;
      } catch {
        if (canCommit()) setDayDetailsFailed(true);
        return null;
      }
    })();
    const daySurfacePromise = Promise.all([dailyPromise, dayTodosPromise, templateInstancesPromise]).then(([daily, todos, templates]) => {
      if (!canCommit()) return;
      setSurfaceLoading(false);
      if (daily && todos && templates) lastDaySurfaceSnapshot = {
        dateKey: day, occurrences: daily, templateInstances: templates, todos,
      };
    });
    const refreshAuxiliary = async () => {
      await generateDailyChallenges(day);
      await generateGoalTodosForDate(day);
      // The first day read must not wait for generation; include any newly generated todos afterward.
      await dayTodosPromise;
      if (!canCommit()) return;
      await readDayTodos();
      const rangeKeys = dateKeysForDisplayRange(displayRange, day);
      const weekKeys = weekKeysForDate(day);
      const monthKeys = monthKeysForDate(day);
      const rangeTodosPromise = showPendingTodos || showCompletedTodos
        ? loadTodoItemsForDates(rangeKeys, showCompletedTodos).then((items) => items.filter((item) => showPendingTodos || item.status === 'completed'))
        : Promise.resolve([]);
      const rangeOccurrencesPromise = Promise.all(
        rangeKeys.map((key) => loadScheduleItemsForDate(dateFromKey(key), showCompletedTodos)),
      ).then((groups) => groups.flat());
      const weekTodosPromise = showPendingTodos || showCompletedTodos
        ? loadTodoItemsForDates(weekKeys, showCompletedTodos).then((items) => items.filter((item) => showPendingTodos || item.status === 'completed'))
        : Promise.resolve([]);
      const monthTodosPromise = showPendingTodos || showCompletedTodos
        ? loadTodoItemsForDates(monthKeys, showCompletedTodos).then((items) => items.filter((item) => showPendingTodos || item.status === 'completed'))
        : Promise.resolve([]);
      const weekOccurrencesPromise = Promise.all(
        weekKeys.map((key) => loadScheduleItemsForDate(dateFromKey(key), showCompletedTodos)),
      ).then((groups) => groups.flat());
      const goalsPromise = loadGoals();
      const habitsPromise = loadHabits(true);
      const ownHabitsPromise = loadOwnActiveHabits().then(habits => Promise.all(habits.map(async habit => ({
        habit, progress: await getOwnHabitPeriodProgress(habit, day),
      }))));
      const habitSummaryPromise = loadHabitSummaryForDate(day);
      const dailyChallengesPromise = loadDailyChallengesForDate(day, false);
      const inhibitTodosPromise = loadActiveInhibitTodosForDate(day);
      const inhibitLogsPromise = loadInhibitLogsForDate(day);
      const managedDailyChallengesPromise = day === dateKey(new Date())
        ? dailyChallengesPromise
        : loadDailyChallengesForDate(dateKey(new Date()));
      const monthStart = dateFromKey(monthKeys[0]);
      const monthEnd = addDays(dateFromKey(monthKeys[monthKeys.length - 1]), 1);
      const [
        markedDates,
        monthScheduleDates,
        allowed,
        rangedItems,
        rangedOccurrences,
        weeklyItems,
        monthlyItems,
        weeklyOccurrences,
        activeGoals,
        activeHabits,
        selectedHabitSummary,
        selectedDailyChallenges,
        selectedInhibitTodos,
        selectedInhibitLogs,
        currentDailyChallenges,
        ownHabits,
        monthlyOccurrences,
      ] = await Promise.all([
        loadDatesWithSchedules(Date.now() - 31 * DAY_MS, Date.now() + 90 * DAY_MS),
        loadDatesWithSchedules(monthStart.getTime(), monthEnd.getTime()),
        hasNotificationPermission(),
        rangeTodosPromise,
        rangeOccurrencesPromise,
        weekTodosPromise,
        monthTodosPromise,
        weekOccurrencesPromise,
        goalsPromise,
        habitsPromise,
        habitSummaryPromise,
        dailyChallengesPromise,
        inhibitTodosPromise,
        inhibitLogsPromise,
        managedDailyChallengesPromise,
        ownHabitsPromise,
        loadPendingScheduleOccurrencesBetween(new Date(monthStart).setHours(0, 0, 0, 0), new Date(monthEnd).setHours(0, 0, 0, 0)),
      ]);
      if (!canCommit()) return;
      setRangeOccurrences(rangedOccurrences);
      setWeekOccurrences(weeklyOccurrences);
      setMonthOccurrenceKeys(monthScheduleDates);
      setPermissionGranted(allowed);
      setRangeTodos(rangedItems);
      setWeekTodos(weeklyItems);
      setMonthTodos(monthlyItems);
      setGoals(activeGoals);
      setAllHabits(activeHabits);
      setOwnHabitProgress(ownHabits);
      setHabitSummary(selectedHabitSummary);
      setDailyChallenges(selectedDailyChallenges);
      setInhibitTodos(selectedInhibitTodos);
      setInhibitLogs(selectedInhibitLogs);
      setManagedDailyChallenges(currentDailyChallenges);
      setAuxiliaryStatus('');
      setMarked(
        { ...Object.fromEntries(markedDates.map((key) => [key, { dots: [{ key: 'you', color: '#C97838' }] }])),
          ...scheduleCalendarMarks(monthlyOccurrences) },
      );
    };
    void refreshAuxiliary().catch((error) => {
      console.warn('[schedule-screen] auxiliary-read failed', error instanceof Error ? error.message : 'unknown-error');
      if (canCommit()) setAuxiliaryStatus('failed');
    });
    await daySurfacePromise;
  });

  useEffect(() => {
    if (!active) return;
    void refresh();
    return () => { refreshRevisionRef.current += 1; };
  }, [active, selectedDate, displayRange, showPendingTodos, showCompletedTodos]);

  useEffect(() => {
    if (!active) return undefined;
    const subscription = DeviceEventEmitter.addListener(SCHEDULE_DATA_CHANGED_EVENT, (payload?: ScheduleDataChangedPayload) => {
      const nextDate = payload?.dateKey;
      if (nextDate && nextDate !== selectedDate) {
        setSelectedDate(nextDate);
        void refresh(nextDate);
        return;
      }
      void refresh();
    });
    return () => subscription.remove();
  }, [active, refresh, selectedDate]);

  useEffect(() => {
    if (!active || habitSyncStartedRef.current) return;
    habitSyncStartedRef.current = true;
    void runBackupProtectedTask(() => syncAllHabitScheduleInstances())
      .then((result) => {
        if (result.ran) void refresh();
      })
      .catch(() => undefined);
  }, [active, refresh]);

  useEffect(() => {
    if (active && weekReviewVisible) void createWeekReview(false);
  }, [active, weekReviewVisible, selectedDate, configured]);

  useEffect(() => {
    void runBackupProtectedTask(() => freezeLegacyExecutionSessions()).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!active) return undefined;
    setExecutionTick(Date.now());
    const timer = setInterval(() => setExecutionTick(Date.now()), 60 * 1000);
    return () => clearInterval(timer);
  }, [active]);

  useEffect(() => {
    if (!active) return;
    void runBackupProtectedTask(() => takePendingScheduleRequest())
      .then((result) => {
        if (result.ran && result.value) setPlanningText(result.value);
      })
      .catch(() => undefined);
  }, [active]);

  const calendarMarks = useMemo(
    () => ({
      ...marked,
      [selectedDate]: { ...(marked[selectedDate] ?? {}), selected: true, selectedColor: colors.primary },
    }),
    [marked, selectedDate],
  );
  const todosByQuadrant = useMemo(() => {
    const grouped: Record<TodoQuadrant, TodoItem[]> = { q1: [], q2: [], q3: [], q4: [] };
    visibleTodos.forEach((todo) => grouped[todo.quadrant].push(todo));
    return grouped;
  }, [visibleTodos]);
  const dayTasks = useMemo(() => buildViewTasks(rangeTodos, rangeOccurrences, [], readingSnapshot, executionTick), [rangeOccurrences, rangeTodos, readingSnapshot, executionTick]);
  const dayScheduleTasks = useMemo(() => buildViewTasks([], occurrences, templateInstances, readingSnapshot, executionTick), [occurrences, templateInstances, readingSnapshot, executionTick]);
  const dayViewTasks = useMemo(() => buildViewTasks(visibleTodos, occurrences, templateInstances, readingSnapshot, executionTick), [occurrences, templateInstances, visibleTodos, readingSnapshot, executionTick]);
  const weekTasks = useMemo(() => buildViewTasks(weekTodos, weekOccurrences, [], readingSnapshot, executionTick), [weekOccurrences, weekTodos, readingSnapshot, executionTick]);

  const saveDraft = useStableCallback(async (value: EditableDraft, id?: string) => {
    const normalized = toScheduleDraft(value);
    if (!normalized) {
      Alert.alert('还不能保存', '请确认标题、未来日期时间、结束时间和提前提醒分钟数都填写正确。');
      return false;
    }
    if (await hasScheduleConflict(normalized, id)) {
      Alert.alert('这个时间已有安排', '白云小姐发现它会和已有日程撞在一起，请先调整时间再保存。');
      return false;
    }
    if (id) {
      const result = await updateScheduleItem(id, normalized);
      await cancelNotifications(result.notificationIds);
    } else {
      await createScheduleItem(normalized);
    }
    if (!(await hasNotificationPermission())) await requestNotificationPermission();
    await syncScheduleNotifications();
    setSelectedDate(value.date);
    await refresh(value.date);
    return true;
  });

  const closeEditor = useStableCallback(() => {
    setDraft(null);
    setEditorMode({ kind: 'none' });
  });

  const startCreate = useStableCallback(() => {
    setProposals([]);
    setTodoProposals([]);
    setDraft(blankDraft(selectedDate));
    setEditorMode({ kind: 'create' });
  });

  const runPlan = useStableCallback(async () => {
    if (!planningText.trim()) return;
    if (!configured || !chatConnection) {
      Alert.alert('还没有连接白云小姐', '鼠仍然可以手动添加日程；配置好模型连接后，她就能帮鼠编排啦。');
      return;
    }
    setPlanning(true);
    try {
      const existingItems = await loadScheduleItemsBetween(Date.now(), Date.now() + 90 * DAY_MS);
      const result = await generateSchedulePlan({
        apiKey: chatKey.trim(),
        connection: chatConnection,
        existingItems,
        request: planningText,
      });
      if (!result.schedules.length && !result.todos.length) {
        Alert.alert('这次没有排成功', '白云小姐没有得到有效的未来安排，鼠可以换种说法再试一次。');
      }
      setProposals(result.schedules.map(editableFromDraft));
      setTodoProposals(result.todos);
    } catch (error) {
      Alert.alert('排程暂时失败', error instanceof Error ? error.message : '请稍后再试。');
    } finally {
      setPlanning(false);
    }
  });

  const acceptProposals = useStableCallback(async () => {
    for (const proposal of proposals) {
      if (!(await saveDraft(proposal))) return;
    }
    for (const proposal of todoProposals) {
      await createTodoItem(proposal);
    }
    setProposals([]);
    setTodoProposals([]);
    setPlanningText('');
    closeEditor();
    await refresh();
  });

  const beginEdit = useStableCallback((occurrence: ScheduleOccurrence) => {
    setProposals([]);
    setTodoProposals([]);
    setEditorMode({ kind: 'edit', itemId: occurrence.itemId, occurrenceId: occurrence.id });
    setDraft({
      ...blankDraft(dateKey(occurrence.scheduledStartAt)),
      title: occurrence.title,
      notes: occurrence.notes,
      time: formatTime(occurrence.scheduledStartAt),
      endTime: occurrence.endAt ? formatTime(occurrence.endAt) : '',
      endTimeDate: occurrence.endAt ? dateKey(occurrence.endAt) : undefined,
      estimateMinutes: occurrence.endAt ? Math.round((occurrence.endAt - occurrence.scheduledStartAt) / 60000) : undefined,
      rangeEndDate: occurrence.rangeEndAt === undefined ? undefined : dateKey(occurrence.rangeEndAt),
      startReminderEnabled: occurrence.startReminderEnabled,
      reminderMinutes: String(occurrence.reminderMinutesBefore),
      recurrence: occurrence.recurrence,
      reminderIntensity: occurrence.reminderIntensity,
      reminderText: occurrence.reminderText,
      source: occurrence.source,
      companionEnabled: occurrence.companionEnabled,
      letterTicketEnabled: occurrence.letterTicketEnabled === true,
    });
  });

  const confirmDelete = useStableCallback((occurrence: ScheduleOccurrence) => {
    Alert.alert('删除这条安排吗？', '可以只删这一次，也可以删除整条重复日程。', [
      { text: '取消', style: 'cancel' },
      {
        text: '只删这次',
        onPress: () => void cancelScheduleOccurrence(occurrence.id).then(async (ids) => {
          await cancelNotifications(ids);
          await refresh();
          if (editorMode.kind === 'edit' && editorMode.occurrenceId === occurrence.id) closeEditor();
        }),
      },
      {
        text: '删除整条日程',
        style: 'destructive',
        onPress: () => void deleteScheduleItem(occurrence.itemId).then(async (ids) => {
          await cancelNotifications(ids);
          await refresh();
          if (editorMode.kind === 'edit' && editorMode.itemId === occurrence.itemId) closeEditor();
        }),
      },
    ]);
  });

  const removeCurrentDraft = useStableCallback(() => {
    if (editorMode.kind !== 'edit') {
      closeEditor();
      return;
    }
    const currentOccurrence = [...occurrences, ...rangeOccurrences, ...weekOccurrences]
      .find((occurrence) => occurrence.id === editorMode.occurrenceId);
    if (currentOccurrence) {
      confirmDelete(currentOccurrence);
      return;
    }
    Alert.alert('删除这条安排吗？', '这条安排暂时不在当前列表里，确认后会删除整条日程。', [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: () => void deleteScheduleItem(editorMode.itemId).then(async (ids) => {
          await cancelNotifications(ids);
          await refresh();
          closeEditor();
        }),
      },
    ]);
  });

  const saveCurrentDraft = useStableCallback(async () => {
    if (!draft) return;
    const itemId = editorMode.kind === 'edit' ? editorMode.itemId : undefined;
    const saved = await saveDraft(draft, itemId);
    if (saved) closeEditor();
  });

  const resetQuickAdd = useStableCallback(() => {
    setNewTodoText('');
    setNewTodoEstimate('');
    setNewTodoQuadrant('q2');
    setNewTodoCategory('other');
    setNewTodoDate('');
    setNewTodoTime('');
    setNewTodoEndTime('');
    setNewTodoReminderMinutes('5');
    setNewTodoReminderIntensity('gentle');
    setNewTodoRecurrence('none');
    setNewTodoRangeEndDate('');
    setNewTodoNotes('');
    setNewTodoSubtaskDraft('');
    setNewTodoSubtasks([]);
    setNewTodoType(null);
    newTodoTypeRef.current = null;
    setQuickAddTool(null);
  });

  const addTodo = useStableCallback(async () => {
    const plannedDate = newTodoDate || (displayRange === 'tomorrow' ? tomorrowKey() : dateKey(new Date()));
    const draft = todoDraftFromTitle(newTodoText, plannedDate);
    if (!draft) return;
    const estimatedMinutes = Number(newTodoEstimate);
    const todoType = newTodoTypeRef.current ?? newTodoType ?? inferTodoType(newTodoText);
    const notes = buildTaskNotes(newTodoNotes, newTodoSubtasks);
    let refreshDate: string | undefined;

    if (todoType === 'normal' && newTodoDate && newTodoTime) {
      const startAt = combineDateTime(newTodoDate, normalizeTimeInput(newTodoTime));
      const endAt = newTodoEndTime ? combineDateTime(newTodoDate, normalizeTimeInput(newTodoEndTime)) : undefined;
      const reminderMinutesBefore = Number(newTodoReminderMinutes);
      if (!Number.isFinite(startAt) || startAt <= Date.now()) {
        Alert.alert('时间还不对', '日期和时间要填成未来的安排。');
        return;
      }
      if (endAt !== undefined && (!Number.isFinite(endAt) || endAt <= startAt)) {
        Alert.alert('结束时间还不对', '结束时刻要晚于开始时刻。');
        return;
      }
      await createScheduleItem({
        title: draft.title,
        notes: [
          notes,
          `分类：${getCategoryConfig(newTodoCategory).label}`,
          `象限：${getQuadrantConfig(newTodoQuadrant).title}`,
          Number.isFinite(estimatedMinutes) && estimatedMinutes > 0 ? `预估：${Math.round(estimatedMinutes)} 分钟` : '',
        ].filter(Boolean).join('\n'),
        startAt,
        endAt: endAt ?? (Number.isFinite(estimatedMinutes) && estimatedMinutes > 0
          ? startAt + Math.round(estimatedMinutes) * 60 * 1000
          : undefined),
        reminderMinutesBefore: Number.isFinite(reminderMinutesBefore) ? Math.max(0, reminderMinutesBefore) : 0,
        recurrence: newTodoRecurrence,
        recurrenceRule: buildRecurrenceRule(newTodoRecurrence, startAt),
        rangeEndAt: newTodoRangeEndDate ? combineDateTime(newTodoRangeEndDate, normalizeTimeInput(newTodoTime)) : undefined,
        reminderText: Number.isFinite(reminderMinutesBefore) && reminderMinutesBefore > 0
          ? `小仓鼠，${draft.title}还有 ${reminderMinutesBefore} 分钟，我们先慢慢准备一下吧。`
          : `小仓鼠，${draft.title}的时间到啦，我们慢慢开始吧。`,
        reminderIntensity: newTodoReminderIntensity,
        source: 'manual',
      });
      if (!(await hasNotificationPermission())) await requestNotificationPermission();
      await syncScheduleNotifications();
      setSelectedDate(newTodoDate);
      refreshDate = newTodoDate;
    } else {
      await createTodoItem(
        {
          ...draft,
          type: todoType,
          notes,
          quadrant: newTodoQuadrant,
          category: newTodoCategory,
          estimatedMinutes: todoType === 'normal' && Number.isFinite(estimatedMinutes) && estimatedMinutes > 0 ? estimatedMinutes : undefined,
        },
        plannedDate === dateKey(new Date()) ? 'today' : undefined,
      );
    }
    resetQuickAdd();
    setQuickAddVisible(false);
    await refresh(refreshDate);
  });

  const completeTodo = useStableCallback(async (todoId: string) => {
    await completeTodoItemOnce(todoId);
    await refresh();
  });

  const postponeTodo = useStableCallback(async (todoId: string) => {
    await postponeTodoToTomorrow(todoId);
    await refresh();
  });

  const deleteTodo = useStableCallback(async (todoId: string) => {
    await cancelTodoItem(todoId);
    if (editingTodo?.id === todoId) closeTodoEditor();
    await refresh();
  });

  const acknowledgeInhibit = useStableCallback(async (todoId: string) => {
    await acknowledgeInhibitTodo(todoId, selectedDate);
    await refresh();
  });

  const chooseInhibitOutcome = useStableCallback(async (todoId: string, outcome: InhibitOutcome) => {
    await setInhibitOutcome(todoId, selectedDate, outcome);
    await refresh();
  });

  const openGoalCreator = useStableCallback(() => {
    setDrawerVisible(false);
    setGoalDraft({
      title: '',
      description: '',
      lifeArea: 'growth',
      priority: 'normal',
      targetDate: '',
    });
  });

  const openGoalManager = useStableCallback(() => {
    setDrawerVisible(false);
    setGoalManagerVisible(true);
  });

  const openHabitManager = useStableCallback(() => {
    setDrawerVisible(false);
    setHabitManagerVisible(true);
  });

  const openWeekReview = useStableCallback(() => {
    setDrawerVisible(false);
    setWeekReviewVisible(true);
  });

  const createWeekReview = useStableCallback(async (manual = false) => {
    const weekStart = weekStartKeyFromDate(dateFromKey(selectedDate));
    const dataEpoch = captureBackupRestoreDataEpoch();
    if (dataEpoch === null) return;
    const snapshot = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
      return { cached: await loadWeekReview(weekStart) };
    });
    if (!snapshot.committed || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
    const { cached } = snapshot.value;
    if (cached && !manual) {
      setWeekReview(cached);
      setWeekReviewError('');
      return;
    }
    if (!manual && !shouldOfferWeekReview(weekStart)) {
      setWeekReview(cached);
      setWeekReviewError('');
      return;
    }
    if (!configured || !chatConnection) {
      if (manual) Alert.alert('还没有连接白云小姐', '配置好模型连接后，她就能帮鼠生成周回顾啦。');
      return;
    }
    setWeekReviewLoading(true);
    setWeekReviewError('');
    try {
      const localSnapshot = await runBackupRestoreDataEpochCommit(
        dataEpoch,
        () => generateWeekReviewFromLocalData(weekStart),
      );
      if (!localSnapshot.committed || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      const localData = localSnapshot.value;
      if (!hasWeekReviewSourceData(localData)) {
        setWeekReview(null);
        setWeekReviewError('这一周还没有足够的数据，白云就不硬写回顾啦。');
        return;
      }
      const plan = await generateWeekReview({ apiKey: chatKey.trim(), connection: chatConnection, data: localData, profile });
      if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      const review = makeWeekReview({
        weekStart: localData.weekStart,
        weekEnd: localData.weekEnd,
        summary: plan.summary,
        wins: plan.wins,
        gaps: plan.gaps,
        goalProgress: plan.goalProgress,
        habitInsights: plan.habitInsights,
        nextWeekSuggestions: plan.nextWeekSuggestions,
        baiyunMessage: plan.baiyunMessage,
        metricsSnapshot: localData.metrics,
        comparison: localData.comparison,
      });
      const saved = await runBackupRestoreDataEpochCommit(dataEpoch, () => saveWeekReview(review));
      if (!saved.committed || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      setWeekReview(review);
    } catch (error) {
      if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      setWeekReviewError(error instanceof Error ? error.message : '白云小姐这次没能生成周回顾。');
    } finally {
      setWeekReviewLoading(false);
    }
  });

  const openHabitCreator = useStableCallback(() => {
    const weekday = weekDayFromKey(selectedDate);
    setDrawerVisible(false);
    setHabitDraft({
      title: '',
      goalId: '',
      category: 'other',
      frequency: 'daily',
      weekDays: [weekday],
      targetCount: 1,
      reminderTimes: [''],
      reminderTime: '',
      scheduleInstances: { enabled: false, reminderMinutesBefore: 10 },
    });
  });

  const openHabitEditor = useStableCallback((habit: Habit) => {
    if (habit.owner === 'I') return;
    setHabitDraft({
      id: habit.id,
      title: habit.title,
      goalId: habit.goalId ?? '',
      category: habit.category,
      frequency: habit.frequency,
      weekDays: habit.weekDays.length ? habit.weekDays : [weekDayFromKey(selectedDate)],
      targetCount: habit.targetCount,
      reminderTimes: habit.reminderTimes.length ? habit.reminderTimes : [habit.reminderTime ?? ''],
      reminderTime: habit.reminderTime ?? habit.reminderTimes[0] ?? '',
      scheduleInstances: habit.scheduleInstances,
    });
  });

  const saveHabitDraft = useStableCallback(async () => {
    if (!habitDraft?.title.trim()) {
      Alert.alert('还不能保存', '习惯名字还空着呢。');
      return;
    }
    const payload: HabitDraft = {
      title: habitDraft.title,
      goalId: habitDraft.goalId || undefined,
      category: habitDraft.category,
      frequency: habitDraft.frequency,
      weekDays: habitDraft.frequency === 'daily'
        ? []
        : habitDraft.weekDays.length ? habitDraft.weekDays : [weekDayFromKey(selectedDate)],
      targetCount: habitDraft.targetCount,
      reminderTimes: habitDraft.reminderTimes,
      reminderTime: habitDraft.reminderTimes.find(Boolean) ?? habitDraft.reminderTime,
      scheduleInstances: habitDraft.scheduleInstances,
    };
    let habitId: string;
    if (habitDraft.id) {
      await updateHabit(habitDraft.id, payload);
      habitId = habitDraft.id;
    } else {
      habitId = (await createHabit(payload)).id;
    }
    await syncHabitScheduleInstances(habitId);
    setHabitDraft(null);
    await refresh();
  });

  const archiveHabitDraft = useStableCallback(async (habitId: string) => {
    await archiveHabit(habitId);
    await syncHabitScheduleInstances(habitId);
    setHabitDraft(null);
    await refresh();
  });

  const habitDeletionRef = useRef(false);
  const deleteCurrentHabit = useStableCallback(() => {
    if (!habitDraft?.id || habitDeletionRef.current) return;
    const habitId = habitDraft.id;
    Alert.alert('删除这个习惯？', `“${habitDraft.title}”的习惯、打卡记录及自动生成的日历安排将被删除，其他待办与目标保留。此操作无法撤销。`, [
      { text: '取消', style: 'cancel' },
      { text: '删除', style: 'destructive', onPress: () => {
        if (habitDeletionRef.current) return;
        habitDeletionRef.current = true;
        void (async () => {
          try {
            await deleteHabitWithScheduleInstances(habitId);
            setAllHabits(current => current.filter(habit => habit.id !== habitId));
            setHabitDraft(current => current?.id === habitId ? null : current);
            await refresh().catch(() => Alert.alert('习惯已删除', '列表暂时未能刷新，请重新进入日程页面。'));
          } catch {
            Alert.alert('删除未完成', '部分清理可能已完成。剩余记录会保留，可以从“已归档”中再次删除。');
            await refresh().catch(() => undefined);
          } finally {
            habitDeletionRef.current = false;
          }
        })();
      } },
    ]);
  });

  const toggleHabitForToday = useStableCallback(async (habit: HabitForDate) => {
    if (habit.completedToday) return;
    await completeNextHabitInstance(habit.id, selectedDate);
    await refresh();
  });

  const undoHabitForToday = useStableCallback(async (habit: HabitForDate) => {
    const currentCount = habit.log?.completedCount ?? 0;
    if (!currentCount) return;
    await setHabitLogProgress(habit.id, selectedDate, currentCount - 1, habit.log?.note ?? '');
    await refresh();
  });

  const openChallengeCreator = useStableCallback(() => {
    setChallengeDraft({
      title: '',
      category: 'other',
      quadrant: 'q2',
      estimatedMinutes: 30,
      estimatedMinutesText: '30',
    });
  });

  const openChallengeEditor = useStableCallback((entry: DailyChallengeForDate) => {
    setChallengeDraft({
      id: entry.challenge.id,
      title: entry.challenge.title,
      category: entry.challenge.category,
      quadrant: entry.challenge.quadrant,
      estimatedMinutes: entry.challenge.estimatedMinutes,
      estimatedMinutesText: String(entry.challenge.estimatedMinutes),
    });
  });

  const saveChallengeDraft = useStableCallback(async () => {
    if (!challengeDraft?.title.trim()) {
      Alert.alert('还不能保存', '挑战标题还空着呢。');
      return;
    }
    const estimatedMinutes = Number(challengeDraft.estimatedMinutesText);
    if (!Number.isFinite(estimatedMinutes) || estimatedMinutes <= 0) {
      Alert.alert('还不能保存', '每日挑战需要填写一个有效估时。');
      return;
    }
    const payload = {
      title: challengeDraft.title,
      category: challengeDraft.category,
      quadrant: challengeDraft.quadrant,
      estimatedMinutes,
    };
    if (challengeDraft.id) await updateDailyChallenge(challengeDraft.id, payload);
    else await createDailyChallenge(payload);
    setChallengeDraft(null);
    await refresh();
  });

  const archiveChallengeDraft = useStableCallback(async (challengeId: string) => {
    await archiveDailyChallenge(challengeId);
    setChallengeDraft(null);
    await refresh();
  });

  const saveGoalDraft = useStableCallback(async () => {
    if (!goalDraft?.title.trim()) {
      Alert.alert('还不能保存', '目标标题还空着呢。');
      return;
    }
    await createGoal(goalDraft);
    setGoalDraft(null);
    await refresh();
  });

  const openGoalDetail = useStableCallback((goal: Goal) => {
    setDrawerVisible(false);
    selectedGoalIdRef.current = goal.id;
    setSelectedGoal(goal);
    setSelectedGoalTasks([]);
    void loadTodoItemsByGoalId(goal.id).then((tasks) => {
      if (selectedGoalIdRef.current !== goal.id) return;
      setSelectedGoalTasks(tasks);
    });
  });

  const beginTodoEdit = useStableCallback((todo: TodoItem) => {
    setEditingTodo(todo);
    setTaskDraft({
      title: todo.title,
      notes: todo.notes,
      plannedForDate: todo.plannedForDate ?? '',
      priority: todo.priority,
      quadrant: todo.quadrant,
      category: todo.category,
      estimatedMinutes: todo.estimatedMinutes ? String(todo.estimatedMinutes) : '',
      goalId: todo.goalId ?? '',
      type: todo.type,
    });
  });

  const closeTodoEditor = useStableCallback(() => {
    setEditingTodo(null);
    setTaskDraft(null);
  });

  const saveTodoEdit = useStableCallback(async () => {
    if (!editingTodo || !taskDraft) return;
    if (!taskDraft.title.trim()) {
      Alert.alert('还不能保存', '任务标题还空着呢。');
      return;
    }
    const estimated = Number(taskDraft.estimatedMinutes);
    await updateTodoItem(editingTodo.id, {
      title: taskDraft.title,
      notes: taskDraft.notes,
      plannedForDate: taskDraft.plannedForDate || undefined,
      priority: taskDraft.priority,
      quadrant: taskDraft.quadrant,
      category: taskDraft.category,
      estimatedMinutes: Number.isFinite(estimated) && estimated > 0 ? estimated : undefined,
      goalId: taskDraft.goalId,
      type: taskDraft.type,
    });
    closeTodoEditor();
    await refresh();
  });

  const completeEditingTodo = useStableCallback(async () => {
    if (!editingTodo) return;
    await completeTodo(editingTodo.id);
    closeTodoEditor();
  });

  const postponeEditingTodo = useStableCallback(async () => {
    if (!editingTodo) return;
    await postponeTodo(editingTodo.id);
    closeTodoEditor();
  });

  const deleteEditingTodo = useStableCallback(async () => {
    if (!editingTodo) return;
    Alert.alert('删除这个待办吗？', editingTodo.title, [
      { text: '取消', style: 'cancel' },
      { text: '删除', style: 'destructive', onPress: () => void deleteTodo(editingTodo.id) },
    ]);
  });

  const endEditingInhibit = useStableCallback(async () => {
    if (!editingTodo || editingTodo.type !== 'inhibit') return;
    await endInhibitTodo(editingTodo.id);
    closeTodoEditor();
    await refresh();
  });

  const scheduleEditingTodo = useStableCallback(() => {
    if (!editingTodo) return;
    scheduleTodo(editingTodo);
    closeTodoEditor();
  });

  const measureQuadrants = useStableCallback(() => {
    quadrantConfig.forEach((quadrant) => {
      quadrantRefs.current[quadrant.id]?.measureInWindow((x, y, width, height) => {
        quadrantRects.current[quadrant.id] = { x, y, width, height };
      });
    });
  });

  const findQuadrantAtPoint = useStableCallback((x: number, y: number) => {
    for (const quadrant of quadrantConfig) {
      const rect = quadrantRects.current[quadrant.id];
      if (rect && x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height) {
        return quadrant.id;
      }
    }
    return null;
  });

  const startTodoDrag = useStableCallback((task: ScheduleViewTask, x: number, y: number) => {
    measureQuadrants();
    setEditingTodo(null);
    setTaskDraft(null);
    setDraggingTask(task);
    setDragPoint({ x, y });
    setHoverQuadrant(task.quadrant);
  });

  const moveTodoDrag = useStableCallback((x: number, y: number) => {
    if (!draggingTask) return;
    setDragPoint({ x, y });
    setHoverQuadrant(findQuadrantAtPoint(x, y));
  });

  const moveTaskOptimistically = useStableCallback((task: ScheduleViewTask, target: TodoQuadrant) => {
    if (task.kind === 'todo' && task.todo) {
      const updateTodo = (todo: TodoItem) => todo.id === task.todo?.id ? { ...todo, quadrant: target } : todo;
      setVisibleTodos((current) => current.map(updateTodo));
      setRangeTodos((current) => current.map(updateTodo));
      setWeekTodos((current) => current.map(updateTodo));
      setMonthTodos((current) => current.map(updateTodo));
      if (lastDaySurfaceSnapshot?.dateKey === task.dateKey) {
        lastDaySurfaceSnapshot = {
          ...lastDaySurfaceSnapshot,
          todos: lastDaySurfaceSnapshot.todos.map(updateTodo),
        };
      }
      return;
    }
    if (task.kind !== 'schedule' || !task.occurrence) return;
    const quadrantLine = `象限：${getQuadrantConfig(target).title}`;
    const updateOccurrence = (occurrence: ScheduleOccurrence) => {
      if (occurrence.id !== task.occurrence?.id) return occurrence;
      const notes = /^象限：.*$/m.test(occurrence.notes)
        ? occurrence.notes.replace(/^象限：.*$/m, quadrantLine)
        : [occurrence.notes.trim(), quadrantLine].filter(Boolean).join('\n');
      return { ...occurrence, notes };
    };
    setOccurrences((current) => current.map(updateOccurrence));
    setRangeOccurrences((current) => current.map(updateOccurrence));
    setWeekOccurrences((current) => current.map(updateOccurrence));
    if (lastDaySurfaceSnapshot?.dateKey === task.dateKey) {
      lastDaySurfaceSnapshot = {
        ...lastDaySurfaceSnapshot,
        occurrences: lastDaySurfaceSnapshot.occurrences.map(updateOccurrence),
      };
    }
  });

  const endTodoDrag = useStableCallback(async (x: number, y: number) => {
    const task = draggingTask;
    const target = findQuadrantAtPoint(x, y);
    setDraggingTask(null);
    setHoverQuadrant(null);
    if (task && target && target !== task.quadrant) {
      moveTaskOptimistically(task, target);
      if (task.kind === 'todo' && task.todo) {
        await moveTodoToQuadrant(task.todo.id, target);
      } else if (task.kind === 'schedule' && task.occurrence) {
        await moveScheduleOccurrenceToQuadrant(task.occurrence.id, getQuadrantConfig(target).title);
      }
      await refresh();
    }
  });

  const registerQuadrantRef = useStableCallback((quadrant: TodoQuadrant, node: View | null) => {
    quadrantRefs.current[quadrant] = node;
  });

  const changeTodoQuadrant = useStableCallback((todo: TodoItem) => {
    setChoiceSheet({
      title: '选择象限',
      prompt: todo.title,
      options: quadrantConfig.map((quadrant) => ({
        caption: quadrant.hint,
        color: quadrant.textColor,
        label: quadrant.title,
        onSelect: () => void moveTodoToQuadrant(todo.id, quadrant.id).then(() => refresh()),
        selected: todo.quadrant === quadrant.id,
      })),
    });
  });

  const changeTodoCategory = useStableCallback((todo: TodoItem) => {
    setChoiceSheet({
      title: '选择分类',
      prompt: todo.title,
      options: categoryConfig.map((category) => ({
        color: category.color,
        icon: category.icon,
        label: category.label,
        onSelect: () => void updateTodoItem(todo.id, { category: category.id }).then(() => refresh()),
        selected: todo.category === category.id,
      })),
    });
  });

  const chooseNewTodoQuadrant = useStableCallback(() => {
    setChoiceSheet({
      title: '默认象限',
      prompt: '新加的事先放到哪里？',
      options: quadrantConfig.map((quadrant) => ({
        caption: quadrant.hint,
        color: quadrant.textColor,
        label: quadrant.title,
        onSelect: () => setNewTodoQuadrant(quadrant.id),
        selected: newTodoQuadrant === quadrant.id,
      })),
    });
  });

  const chooseNewTodoCategory = useStableCallback(() => {
    setChoiceSheet({
      title: '默认分类',
      prompt: '新加的事属于哪类？',
      options: categoryConfig.map((category) => ({
        color: category.color,
        icon: category.icon,
        label: category.label,
        onSelect: () => setNewTodoCategory(category.id),
        selected: newTodoCategory === category.id,
      })),
    });
  });

  const chooseDisplayRange = useStableCallback(() => {
    setRangeDropdownVisible(true);
  });

  const applyDisplayRange = useStableCallback((range: DisplayRange) => {
    setDisplayRange(range);
    setSelectedDate(range === 'tomorrow' ? tomorrowKey() : dateKey(new Date()));
    setRangeDropdownVisible(false);
  });

  const quickDateTimeSelection = useStableCallback((): DateTimeSelection => {
    const date = newTodoDate || (displayRange === 'tomorrow' ? tomorrowKey() : dateKey(new Date()));
    const reminder = selectionFromReminderMinutes(date, newTodoTime || undefined, Number(newTodoReminderMinutes));
    return {
      date,
      endDate: newTodoRangeEndDate || undefined,
      endTime: newTodoEndTime || undefined,
      estimateMinutes: Number(newTodoEstimate) > 0 ? Number(newTodoEstimate) : undefined,
      defaultReminderMinutes: Number(newTodoReminderMinutes) > 0 ? Number(newTodoReminderMinutes) : undefined,
      recurrence: newTodoRecurrence,
      reminderChoice: reminder.reminderChoice,
      reminderClock: reminder.reminderClock,
      reminderIntensity: newTodoReminderIntensity,
      time: newTodoTime || undefined,
    };
  });

  const applyQuickDateTimeSelection = useStableCallback((selection: DateTimeSelection | null) => {
    if (!selection) {
      setNewTodoDate('');
      setNewTodoTime('');
      setNewTodoEndTime('');
      setNewTodoEstimate('');
      setNewTodoReminderMinutes('0');
      setNewTodoRecurrence('none');
      setNewTodoRangeEndDate('');
      setDateTimePickerTarget(null);
      return;
    }
    setNewTodoDate(selection.date);
    setNewTodoTime(selection.time ?? '');
    setNewTodoEndTime(selection.endTime ?? '');
    setNewTodoEstimate(selection.estimateMinutes ? String(selection.estimateMinutes) : newTodoEstimate);
    setNewTodoReminderMinutes(String(reminderMinutesFromSelection(selection)));
    setNewTodoReminderIntensity(selection.reminderIntensity);
    setNewTodoRecurrence(selection.recurrence);
    setNewTodoRangeEndDate(selection.endDate ?? '');
    setDateTimePickerTarget(null);
  });

  const applyDraftDateTimeSelection = useStableCallback((selection: DateTimeSelection | null) => {
    if (dateTimePickerTarget?.kind === 'goal') {
      setGoalDraft((current) => current ? { ...current, targetDate: selection?.date ?? '' } : current);
      setDateTimePickerTarget(null);
      return;
    }
    if (dateTimePickerTarget?.kind === 'proposal') {
      setProposals((current) => current.map((item, index) => {
        if (index !== dateTimePickerTarget.index) return item;
        if (!selection) return { ...item, endTime: '', endTimeDate: undefined, estimateMinutes: undefined, rangeEndDate: undefined, recurrence: 'none', reminderMinutes: '0' };
        return draftWithSelection(item, selection);
      }));
      setDateTimePickerTarget(null);
      return;
    }
    if (!draft) return;
    if (!selection) {
      setDraft({ ...draft, endTime: '', endTimeDate: undefined, estimateMinutes: undefined, rangeEndDate: undefined, recurrence: 'none', reminderMinutes: '0' });
      setDateTimePickerTarget(null);
      return;
    }
    setDraft(draftWithSelection(draft, selection));
    setDateTimePickerTarget(null);
  });

  const activeDateTimeValue = useStableCallback(() => {
    if (dateTimePickerTarget?.kind === 'goal') {
      return {
        date: goalDraft?.targetDate || dateKey(new Date()),
        recurrence: 'none',
        reminderChoice: 'none',
        reminderClock: '09:00',
        reminderIntensity: 'gentle',
      } satisfies DateTimeSelection;
    }
    if (dateTimePickerTarget?.kind === 'draft' && draft) return selectionFromDraft(draft);
    if (dateTimePickerTarget?.kind === 'proposal') {
      const proposal = proposals[dateTimePickerTarget.index];
      if (proposal) return selectionFromDraft(proposal);
    }
    return quickDateTimeSelection();
  });

  const scheduleTodo = useStableCallback((todo: TodoItem) => {
    setDraft({
      ...blankDraft(selectedDate),
      title: todo.title,
      notes: todo.notes,
      source: todo.source === 'ai' ? 'ai' : 'manual',
    });
    setEditorMode({ kind: 'create' });
  });

  const openViewTask = useStableCallback((task: ScheduleViewTask) => {
    if (task.kind === 'template') return;
    if (task.kind === 'todo' && task.todo) {
      beginTodoEdit(task.todo);
      return;
    }
    if (!task.occurrence) return;
    if (task.occurrence.owner === 'I' || task.occurrence.owner === 'I 和 you') {
      const occurrence = task.occurrence;
      const request = ++readingDetailRequest.current;
      const epoch = captureBackupRestoreDataEpoch();
      setReadingDetail({ occurrence, loading: true });
      void loadScheduleReadingDetails(occurrence).then(data => {
        if (request !== readingDetailRequest.current) return;
        if (epoch === null || !canCommitBackupRestoreDataEpoch(epoch)) setReadingDetail({ occurrence, loading: false, failed: true });
        else setReadingDetail(current => current ? { ...current, loading: false, data } : current);
      }).catch(() => {
        if (request === readingDetailRequest.current) setReadingDetail({ occurrence, loading: false, failed: true });
      });
      return;
    }
    if (task.occurrence.source === 'habit') {
      const occurrence = task.occurrence;
      Alert.alert(occurrence.title, '这条日程由习惯生成。时刻和标题请回习惯页修改。', [
        { text: '取消', style: 'cancel' },
        {
          text: '跳过这次',
          onPress: () => void skipHabitScheduleOccurrence(occurrence.id).then(() => refresh()),
        },
        ...(occurrence.habitId ? [{
          text: '编辑习惯',
          onPress: () => void loadHabits().then((habits) => {
            const habit = habits.find((item) => item.id === occurrence.habitId);
            if (habit) openHabitEditor(habit);
          }),
        }] : []),
        {
          text: '完成',
          onPress: () => void completeHabitScheduleOccurrence(occurrence.id).then(() => refresh()),
        },
      ]);
      return;
    }
    beginEdit(task.occurrence);
  });

  const toggleViewTask = useStableCallback(async (task: ScheduleViewTask) => {
    if (task.kind === 'todo' && task.todo) {
      if (task.completed) await reopenTodoItem(task.todo.id);
      else await completeTodoItemOnce(task.todo.id);
      await refresh();
      return;
    }
    if (task.kind === 'template' && task.templateInstance) {
      await toggleDayTemplateInstance(task.templateInstance.id);
      await refresh();
      return;
    }
    if (!task.occurrence || task.occurrence.owner === 'I') return;
    if (task.completed) {
      await reopenScheduleOccurrence(task.occurrence.id);
    } else if (task.occurrence.source === 'habit') {
      await completeHabitScheduleOccurrence(task.occurrence.id);
    } else {
      let completion;
      try {
        completion = await completeScheduleOccurrenceOnce(task.occurrence.id);
      } catch (error) {
        Alert.alert('完成状态尚未确认', (error as { status?: unknown } | null)?.status === 502
          ? '电脑上的君落服务暂时连不上。请确认服务已启动，再重新查看日程。'
          : '请重新查看日程状态后再试。');
        await refresh();
        return;
      }
      await cancelNotifications(completion.notificationIds);
    }
    await syncScheduleNotifications();
    await refresh();
  });

  const shiftSelectedWeek = useStableCallback((amount: number) => {
    setSelectedDate(dateKey(addDays(dateFromKey(selectedDate), amount * 7)));
  });

  const shiftSelectedMonth = useStableCallback((amount: number) => {
    const current = dateFromKey(selectedDate);
    const next = new Date(current.getFullYear(), current.getMonth() + amount, 1, 12);
    setSelectedDate(dateKey(next));
  });

  const openAddMenu = useStableCallback(() => {
    setChoiceSheet(null);
    setQuickAddVisible(true);
  });
  const openDrawer = useStableCallback(() => setDrawerVisible(true));
  const closeDrawer = useStableCallback(() => setDrawerVisible(false));
  const openDayTemplate = useStableCallback(() => { setDrawerVisible(false); setDayTemplateVisible(true); });
  const closeDayTemplate = useStableCallback(() => setDayTemplateVisible(false));
  const toggleTodayHabit = useStableCallback((habit: HabitForDate) => void toggleHabitForToday(habit));
  const undoTodayHabit = useStableCallback((habit: HabitForDate) => void undoHabitForToday(habit));
  const selectWeekDay = useStableCallback((key: string) => { setSelectedDate(key); setViewMode('day'); });
  const showNextWeek = useStableCallback(() => shiftSelectedWeek(1));
  const showPreviousWeek = useStableCallback(() => shiftSelectedWeek(-1));
  const openMonthDay = useStableCallback((key: string) => { setSelectedDate(key); setViewMode('day'); });
  const openDayDisplayMode = useStableCallback((modeId: DayDisplayMode) => {
    setViewMode('day');
    setDayDisplayMode(modeId);
    if (modeId === 'scheduleList') {
      setSelectedDate(dateKey(new Date()));
      setDisplayRange('today');
    }
    setDrawerVisible(false);
  });
  const closeGoalManager = useStableCallback(() => setGoalManagerVisible(false));
  const closeHabitManager = useStableCallback(() => setHabitManagerVisible(false));
  const closeWeekReview = useStableCallback(() => setWeekReviewVisible(false));

  useEffect(() => {
    if (!active) return undefined;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (goalManagerVisible) {
        closeGoalManager();
        return true;
      }
      if (habitManagerVisible) {
        closeHabitManager();
        return true;
      }
      if (weekReviewVisible) {
        closeWeekReview();
        return true;
      }
      if (dayTemplateVisible) {
        closeDayTemplate();
        return true;
      }
      if (drawerVisible) {
        closeDrawer();
        return true;
      }
      navigate('home');
      return true;
    });
    return () => subscription.remove();
  }, [active, closeDayTemplate, closeDrawer, closeGoalManager, closeHabitManager, closeWeekReview, dayTemplateVisible, drawerVisible, goalManagerVisible, habitManagerVisible, navigate, weekReviewVisible]);
  const refreshWeekReview = useStableCallback(() => void createWeekReview(true));
  const closeQuickAdd = useStableCallback(() => setQuickAddVisible(false));
  const closeChoiceSheet = useStableCallback(() => setChoiceSheet(null));
  const completeCurrentTodo = useStableCallback(() => void completeEditingTodo());
  const saveCurrentTodo = useStableCallback(() => void saveTodoEdit());
  const postponeCurrentTodo = useStableCallback(() => void postponeEditingTodo());
  const closeGoalEditor = useStableCallback(() => setGoalDraft(null));
  const openGoalTargetDate = useStableCallback(() => setDateTimePickerTarget({ kind: 'goal' }));
  const saveCurrentGoal = useStableCallback(() => void saveGoalDraft());
  const archiveCurrentHabit = useStableCallback(() => habitDraft?.id ? void archiveHabitDraft(habitDraft.id) : undefined);
  const closeHabitEditor = useStableCallback(() => setHabitDraft(null));
  const saveCurrentHabit = useStableCallback(() => void saveHabitDraft());
  const archiveCurrentChallenge = useStableCallback(() => challengeDraft?.id ? void archiveChallengeDraft(challengeDraft.id) : undefined);
  const closeChallengeEditor = useStableCallback(() => setChallengeDraft(null));
  const saveCurrentChallenge = useStableCallback(() => void saveChallengeDraft());
  const closeGoalDetail = useStableCallback(() => { selectedGoalIdRef.current = null; setSelectedGoal(null); setSelectedGoalTasks([]); });
  const addGoalMinutes = useStableCallback(async (minutes: number) => {
    const goalId = selectedGoalIdRef.current;
    if (!goalId) return;
    await adjustGoalTimeContribution({ goalId, minutes, note: '目标详情手动补录' });
    setSelectedGoal(await loadGoal(goalId));
    await refresh();
  });
  const completeSelectedGoal = useStableCallback(async (goalId: string) => {
    await updateGoal(goalId, { status: 'completed', progress: 100 });
    setSelectedGoal(await loadGoal(goalId));
    await refresh();
  });
  const closeDateTimePicker = useStableCallback(() => setDateTimePickerTarget(null));
  const confirmDateTimePicker = useStableCallback((selection: DateTimeSelection | null) => dateTimePickerTarget?.kind === 'quick' ? applyQuickDateTimeSelection(selection) : applyDraftDateTimeSelection(selection));
  const openDraftDateTime = useStableCallback(() => setDateTimePickerTarget({ kind: 'draft' }));

  const boardTitle = viewMode === 'day'
    ? dayDisplayMode === 'dayView'
      ? '日视图'
      : dayDisplayMode === 'quadrant'
      ? '四象限模式'
      : dayDisplayMode === 'category'
        ? '分类模式'
        : dayDisplayModeConfig.find((mode) => mode.id === dayDisplayMode)?.label ?? '日程'
    : viewModeConfig.find((mode) => mode.id === viewMode)?.label ?? '日程';
  const topPadding = Math.max(insets.top + 16, 32);
  const todayKeyValue = dateKey(new Date());
  const effectiveNewTodoType = newTodoType ?? inferTodoType(newTodoText);
  const showTodayCompanionCards =
    viewMode === 'day' &&
    dayDisplayMode === 'scheduleList' &&
    selectedDate === todayKeyValue;
  const habitCard = useMemo(() => showTodayCompanionCards ? <TodayHabitCard goals={goals} habitSummary={habitSummary} onCreate={openHabitCreator} onManage={openHabitManager} onToggle={toggleTodayHabit} onUndo={undoTodayHabit} /> : undefined, [goals, habitSummary, openHabitCreator, openHabitManager, showTodayCompanionCards, toggleTodayHabit, undoTodayHabit]);
  const inhibitEntries = useMemo(() => {
    const logs = new Map(inhibitLogs.map((log) => [log.todoId, log]));
    return inhibitTodos.map((todo) => ({ todo, log: logs.get(todo.id) }));
  }, [inhibitLogs, inhibitTodos]);
  const canReviewInhibits = selectedDate < todayKeyValue
    || (selectedDate === todayKeyValue && new Date(executionTick).getHours() >= 21);
  const inhibitCard = useMemo(() => inhibitEntries.length ? (
    <InhibitGuardrailCard
      canReview={canReviewInhibits}
      entries={inhibitEntries}
      onAcknowledge={acknowledgeInhibit}
      onOpen={beginTodoEdit}
      onOutcome={chooseInhibitOutcome}
    />
  ) : undefined, [acknowledgeInhibit, beginTodoEdit, canReviewInhibits, chooseInhibitOutcome, inhibitEntries]);

  if (dayTemplateVisible) return <DayTemplateScreen onClose={closeDayTemplate} />;

  return (
    <View style={styles.screen}>
      <View style={[styles.boardHeader, { paddingTop: topPadding }]}>
        <Pressable onPress={openDrawer} style={styles.boardIconButton}>
          <Text style={styles.boardIconText}>▦</Text>
        </Pressable>
        <Text style={styles.boardTitle}>{boardTitle}</Text>
        <View style={styles.boardHeaderActions}>
          <Pressable onPress={chooseDisplayRange} style={styles.rangeButton}>
            <Text style={styles.rangeButtonText}>{displayRangeLabels[displayRange]} {rangeDropdownVisible ? '⌃' : '⌄'}</Text>
          </Pressable>
          <Pressable onPress={openAddMenu} style={styles.addCircle}>
            <Text style={styles.addCircleText}>＋</Text>
          </Pressable>
        </View>
      </View>
      <View style={[styles.boardContent, { paddingBottom: Math.max(insets.bottom + 10, 18) }]}>
        {surfaceError ? <Text style={styles.permission}>{surfaceError}</Text> : null}
        {dayDetailsFailed ? <Text style={styles.permission}>当日作息或待办读取失败，当前列表可能不完整。请重新进入此页重试。</Text> : null}
        {auxiliaryStatus ? (
          <Text style={styles.permission}>
            {auxiliaryStatus === 'loading' ? '日程辅助资料正在刷新，部分内容可能尚未更新。' : '日程辅助资料读取失败，部分内容尚未更新。请重新进入此页重试。'}
          </Text>
        ) : null}
        {permissionGranted === false ? (
          <Text style={styles.permission}>还没有开启通知权限，日程会保存，但到点前需要鼠打开君落才能看到提醒。</Text>
        ) : null}
        {viewMode === 'day' && !surfaceError ? (
          <DayScheduleView
            displayMode={dayDisplayMode}
            displayRangeLabel={displayRangeLabels[displayRange]}
            draggingTaskId={draggingTask?.id}
            floatingChallenges={dailyChallenges}
            habitCard={habitCard}
            inhibitCard={inhibitCard}
            loading={surfaceLoading}
            hoverQuadrant={hoverQuadrant}
            onDragEnd={endTodoDrag}
            onDragMove={moveTodoDrag}
            onDragStart={startTodoDrag}
            onOpenTask={openViewTask}
            onToggleTask={toggleViewTask}
            onSelectDate={setSelectedDate}
            selectedDate={selectedDate}
            registerQuadrantRef={registerQuadrantRef}
            tasks={dayDisplayMode === 'scheduleList' ? dayScheduleTasks : dayDisplayMode === 'dayView' ? dayViewTasks : dayTasks}
          />
        ) : null}
        {viewMode === 'week' ? (
          <WeekScheduleView
            onNextWeek={showNextWeek}
            onOpenTask={openViewTask}
            onPrevWeek={showPreviousWeek}
            onSelectDate={selectWeekDay}
            selectedDate={selectedDate}
            tasks={weekTasks}
          />
        ) : null}
        {viewMode === 'month' ? (
          <MonthScheduleView
            markedDates={calendarMarks}
            monthOccurrenceKeys={monthOccurrenceKeys}
            onChangeMonth={shiftSelectedMonth}
            onOpenDay={openMonthDay}
            selectedDate={selectedDate}
            todos={monthTodos}
          />
        ) : null}
      </View>
      {draggingTask ? (
        <View pointerEvents="none" style={[styles.dragGhost, { left: dragPoint.x - 92, top: dragPoint.y - 42 }]}>
          <ScheduleViewTaskCard compact onPress={() => undefined} task={draggingTask} />
        </View>
      ) : null}
      <Modal animationType="slide" transparent visible={!!readingDetail} onRequestClose={closeReadingDetail}>
        <View style={styles.quickAddOverlay}>
          <Pressable accessibilityLabel="关闭日程详情" style={styles.modalBackdrop} onPress={closeReadingDetail} />
          <View style={[styles.quickAddSheet, { maxHeight: '86%', paddingBottom: Math.max(insets.bottom + 14, 22), backgroundColor: '#F7FBFE' }]}>
            <View style={styles.quickAddHeader}>
              <Text style={[styles.modalTitle, { flex: 1, fontWeight: '500', paddingRight: 16 }]}>日程详情</Text>
              <Pressable accessibilityLabel="关闭日程详情" onPress={closeReadingDetail} style={[styles.modalClose, { backgroundColor: '#FFF0E2' }]}>
                <Text style={[styles.modalCloseText, { color: '#BE8964' }]}>×</Text>
              </Pressable>
            </View>
            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ gap: 16, paddingBottom: 8 }}>
              {readingDetail ? <>
                <Text selectable style={{ color: colors.ink, fontSize: 20, lineHeight: 29, fontWeight: '500' }}>{readingDetail.occurrence.title}</Text>
                <Text selectable style={{ color: '#617485', fontSize: 14, lineHeight: 23 }}>{scheduleExecutionDetails(
                  readingDetail.data?.current ? { ...readingDetail.occurrence, readingId: readingDetail.data.current.id } : readingDetail.occurrence,
                  readingDetail.data?.current ? { status: 'loaded', books: [readingDetail.data.current] } : readingSnapshot)}</Text>
                {readingDetail.loading ? <Text style={{ color: colors.muted, lineHeight: 22 }}>正在读取阅读记录…</Text> : null}
                {(readingDetail.failed || readingDetail.clockFailed ? [scheduleReadingReadFailure] : readingDetail.data?.notices ?? []).map((notice, index) => (
                  <View key={`${notice.title}:${index}`} style={{ backgroundColor: '#FFF1E5', borderRadius: 16, padding: 16, gap: 7 }}>
                    <Text style={{ color: '#926E53', fontSize: 15, fontWeight: '500', lineHeight: 22 }}>{notice.title}</Text>
                    <Text selectable style={{ color: '#826E60', fontSize: 13, lineHeight: 21 }}>{notice.body}</Text>
                    {notice.code ? <Text selectable style={{ color: '#8C827C', fontSize: 11, lineHeight: 18 }}>{notice.code}</Text> : null}
                  </View>
                ))}
                {readingDetail.data && (readingDetail.occurrence.readingId || readingDetail.occurrence.execution?.readingChoice) ? <>
                  {[[readingDetail.data.currentLabel ?? '当前阅读', readingDetail.data.current], ...(readingDetail.data.showNext === false ? [] : [["下一项", readingDetail.data.next]])].map(([label, value]) => {
                    const book = typeof value === 'string' ? undefined : value;
                    return <View key={String(label)} style={{ backgroundColor: '#EAF4FC', borderRadius: 16, padding: 16, gap: 6 }}>
                      <Text style={{ color: '#7896AE', fontSize: 12 }}>{String(label)}</Text>
                      <Text selectable style={{ color: '#486D89', fontSize: 16, lineHeight: 24 }}>{book?.title ?? (label !== '下一项' && readingDetail.data?.actualUnavailable ? '本场实际阅读暂时无法对应' : label !== '下一项' && readingDetail.data?.exhausted ? '所选内容已读完' : label === '本场阅读' ? '暂无实际阅读记录' : '未安排')}</Text>
                      {book ? <Text style={{ color: '#738B9D', fontSize: 13, lineHeight: 21 }}>{scheduleReadingProgress(book)}</Text> : null}
                    </View>;
                  })}
                  {readingDetail.data.choiceCurrent && readingDetail.data.current?.id !== readingDetail.data.choiceCurrent.id ? (
                    <Text style={{ color: '#738B9D', fontSize: 13, lineHeight: 21 }}>后续共享选择：{readingDetail.data.choiceCurrent.title}</Text>
                  ) : null}
                  <Text style={{ color: '#617485', fontSize: 14, fontWeight: '500' }}>本场已保存的笔记</Text>
                  {readingDetail.data.results.length ? readingDetail.data.results.map(note => (
                    <View key={note.key} style={{ backgroundColor: '#FFFFFF', borderRadius: 16, padding: 16, gap: 8 }}>
                      <Text selectable style={{ color: '#527993', fontSize: 14, lineHeight: 22 }}>{note.title} · {note.chapter}</Text>
                      <Text style={{ color: '#8F9AA2', fontSize: 11 }}>保存于 {new Date(note.savedAt).toLocaleString('zh-CN', { hour12: false })}</Text>
                      {note.summary ? <Text selectable style={{ color: colors.ink, fontSize: 14, lineHeight: 23 }}>{note.summary}</Text> : null}
                      {note.annotations.map((text, index) => <Text selectable key={index} style={{ color: '#71818C', fontSize: 13, lineHeight: 22 }}>{text}</Text>)}
                    </View>
                  )) : <Text style={{ color: '#8F9AA2', fontSize: 13, lineHeight: 21 }}>暂无可对应到本场的笔记记录。</Text>}
                  <Pressable onPress={() => { closeReadingDetail(); navigate('co-reading'); }} style={{ alignItems: 'center', borderRadius: 16, backgroundColor: '#DFEDF8', padding: 13 }}>
                    <Text style={{ color: '#527993', fontSize: 14 }}>打开阅读库</Text>
                  </Pressable>
                </> : null}
                {readingDetail.occurrence.owner === 'I 和 you' ? <Pressable onPress={() => { const occurrence = readingDetail.occurrence; closeReadingDetail(); beginEdit(occurrence); }} style={{ alignItems: 'center', padding: 12 }}>
                  <Text style={{ color: '#AD876A', fontSize: 14 }}>编辑约定</Text>
                </Pressable> : null}
              </> : null}
            </ScrollView>
          </View>
        </View>
      </Modal>
      <Modal animationType="fade" transparent visible={rangeDropdownVisible} onRequestClose={() => setRangeDropdownVisible(false)}>
        <View style={[styles.rangeDropdownLayer, { paddingTop: topPadding + 54 }]}>
          <Pressable style={styles.rangeDropdownScrim} onPress={() => setRangeDropdownVisible(false)} />
          <View style={styles.rangeDropdownMenu}>
            {(['all', 'today', 'tomorrow', 'threeDays', 'week', 'month'] as DisplayRange[]).map((range) => {
              const selected = displayRange === range;
              return (
                <Pressable
                  key={range}
                  onPress={() => applyDisplayRange(range)}
                  style={[styles.rangeDropdownOption, selected && styles.rangeDropdownOptionActive]}
                >
                  <Text style={[styles.rangeDropdownOptionText, selected && styles.rangeDropdownOptionTextActive]}>
                    {displayRangeLabels[range]}
                  </Text>
                </Pressable>
              );
            })}
            <View style={styles.rangeDropdownDivider} />
            <Pressable
              onPress={() => setShowPendingTodos((value) => !value)}
              style={[styles.rangeToggleRow, showPendingTodos && styles.rangeToggleRowActive]}
            >
              <View style={[styles.rangeCheckbox, showPendingTodos && styles.rangeCheckboxActive]}>
                <Text style={styles.rangeCheckboxText}>{showPendingTodos ? '✓' : ''}</Text>
              </View>
              <Text style={styles.rangeToggleText}>显示待办</Text>
            </Pressable>
            <Pressable
              onPress={() => setShowCompletedTodos((value) => !value)}
              style={[styles.rangeToggleRow, showCompletedTodos && styles.rangeToggleRowActive]}
            >
              <View style={[styles.rangeCheckbox, showCompletedTodos && styles.rangeCheckboxActive]}>
                <Text style={styles.rangeCheckboxText}>{showCompletedTodos ? '✓' : ''}</Text>
              </View>
              <Text style={styles.rangeToggleText}>显示已完成</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
      <Modal animationType="fade" transparent visible={drawerVisible} onRequestClose={() => setDrawerVisible(false)}>
        <View style={styles.drawerOverlay}>
          <Pressable style={styles.drawerBackdrop} onPress={closeDrawer} />
          <View style={[styles.drawerPanel, { paddingTop: topPadding }]}>
            <ScrollView
              alwaysBounceVertical
              bounces
              contentInsetAdjustmentBehavior="never"
              keyboardShouldPersistTaps="handled"
              nestedScrollEnabled
              overScrollMode="always"
              removeClippedSubviews={false}
              scrollEnabled
              scrollIndicatorInsets={{ bottom: Math.max(insets.bottom + 96, 132), top: topPadding }}
              showsVerticalScrollIndicator
              style={styles.drawerScroll}
              contentContainerStyle={[
                styles.drawerContent,
                { paddingBottom: Math.max(insets.bottom + 160, 196) },
              ]}
            >
              <Text style={styles.drawerTitle}>功能</Text>
              <View style={styles.drawerQuickNav}>
                <Pressable
                  accessibilityLabel="返回首页"
                  onPress={() => {
                    setDrawerVisible(false);
                    navigate('home');
                  }}
                  style={styles.drawerQuickNavButton}
                >
                  <Text style={styles.drawerQuickNavIcon}>⌂</Text>
                  <Text style={styles.drawerQuickNavText}>首页</Text>
                </Pressable>
                <Pressable
                  accessibilityLabel="前往聊天"
                  onPress={() => {
                    setDrawerVisible(false);
                    navigate('chat');
                  }}
                  style={styles.drawerQuickNavButton}
                >
                  <Text style={styles.drawerQuickNavIcon}>◌</Text>
                  <Text style={styles.drawerQuickNavText}>聊天</Text>
                </Pressable>
              </View>
              <View style={styles.drawerToggleGrid}>
                <Pressable
                  onPress={() => setShowPendingTodos((value) => !value)}
                  style={[styles.drawerCompactToggle, showPendingTodos ? styles.drawerModeItemActive : null]}
                >
                  <Text style={styles.drawerCompactToggleText}>显示待办</Text>
                  <View style={[styles.rangeCheckbox, showPendingTodos && styles.rangeCheckboxActive]}>
                    <Text style={styles.rangeCheckboxText}>{showPendingTodos ? '✓' : ''}</Text>
                  </View>
                </Pressable>
                <Pressable
                  onPress={() => setShowCompletedTodos((value) => !value)}
                  style={[styles.drawerCompactToggle, showCompletedTodos ? styles.drawerModeItemActive : null]}
                >
                  <Text style={styles.drawerCompactToggleText}>显示已完成</Text>
                  <View style={[styles.rangeCheckbox, showCompletedTodos && styles.rangeCheckboxActive]}>
                    <Text style={styles.rangeCheckboxText}>{showCompletedTodos ? '✓' : ''}</Text>
                  </View>
                </Pressable>
              </View>
              <Text style={styles.drawerSectionTitle}>展示模式</Text>
              {dayDisplayModeConfig.map((mode) => {
                const active = viewMode === 'day' && dayDisplayMode === mode.id;
                return (
                  <Pressable
                    key={mode.id}
                    onPress={() => openDayDisplayMode(mode.id)}
                    style={[styles.drawerModeItem, active ? styles.drawerModeItemActive : null]}
                  >
                    <Text style={[styles.drawerModeIcon, active ? styles.drawerModeTextActive : null]}>{mode.icon}</Text>
                    <Text style={[styles.drawerItemText, active ? styles.drawerModeTextActive : null]}>{mode.label}</Text>
                    <Text style={styles.drawerArrow}>›</Text>
                  </Pressable>
                );
              })}
              <View style={styles.drawerDivider} />
              <Text style={styles.drawerSectionTitle}>视图</Text>
              {viewModeConfig.map((mode) => {
                const active = viewMode === mode.id;
                return (
                  <Pressable
                    key={mode.id}
                    onPress={() => {
                      setViewMode(mode.id);
                      if (mode.id === 'day') setDayDisplayMode('dayView');
                      setDrawerVisible(false);
                    }}
                    style={[styles.drawerModeItem, active ? styles.drawerModeItemActive : null]}
                  >
                    <Text style={[styles.drawerModeIcon, active ? styles.drawerModeTextActive : null]}>{mode.icon}</Text>
                    <Text style={[styles.drawerItemText, active ? styles.drawerModeTextActive : null]}>{mode.label}</Text>
                    <Text style={styles.drawerArrow}>›</Text>
                  </Pressable>
                );
              })}
              <Pressable onPress={openDayTemplate} style={styles.drawerModeItem}>
                <Text style={styles.drawerModeIcon}>◷</Text>
                <Text style={styles.drawerItemText}>作息</Text>
                <Text style={styles.drawerItemMeta}>排程模板</Text>
                <Text style={styles.drawerArrow}>›</Text>
              </Pressable>
              <View style={styles.drawerDivider} />
              <Text style={styles.drawerSectionTitle}>目标与领域</Text>
              <Pressable onPress={openGoalManager} style={styles.drawerModeItem}>
                <Text style={styles.drawerModeIcon}>◎</Text>
                <Text style={styles.drawerItemText}>目标</Text>
                <Text style={styles.drawerItemMeta}>{goals.length} 个</Text>
                <Text style={styles.drawerArrow}>›</Text>
              </Pressable>
              <Pressable onPress={openHabitManager} style={styles.drawerModeItem}>
                <Text style={styles.drawerModeIcon}>◌</Text>
                <Text style={styles.drawerItemText}>习惯</Text>
                <Text style={styles.drawerItemMeta}>{allHabits.filter(habit => habit.status === 'active').length} 个</Text>
                <Text style={styles.drawerArrow}>›</Text>
              </Pressable>
              <Pressable onPress={openWeekReview} style={styles.drawerModeItem}>
                <Text style={styles.drawerModeIcon}>↻</Text>
                <Text style={styles.drawerItemText}>周回顾</Text>
                <Text style={styles.drawerItemMeta}>本周</Text>
                <Text style={styles.drawerArrow}>›</Text>
              </Pressable>
            </ScrollView>
          </View>
        </View>
      </Modal>
      {goalManagerVisible ? (
        <GoalManagerScreen
          goals={goals}
          onClose={closeGoalManager}
          onCreate={openGoalCreator}
          onOpenGoal={openGoalDetail}
        />
      ) : null}
      {habitManagerVisible ? (
        <HabitManagerScreen
          challenges={managedDailyChallenges}
          goals={goals}
          habits={allHabits}
          ownHabits={ownHabitProgress}
          onClose={closeHabitManager}
          onCreate={openHabitCreator}
          onCreateChallenge={openChallengeCreator}
          onOpenChallenge={openChallengeEditor}
          onOpenHabit={openHabitEditor}
        />
      ) : null}
      {weekReviewVisible ? (
        <WeekReviewScreen
          error={weekReviewError}
          loading={weekReviewLoading}
          onClose={closeWeekReview}
          onRefresh={refreshWeekReview}
          review={weekReview}
          weekEnd={weekKeysFromStart(weekStartKeyFromDate(dateFromKey(selectedDate)))[6]}
          weekStart={weekStartKeyFromDate(dateFromKey(selectedDate))}
        />
      ) : null}
      <Modal animationType="slide" transparent visible={quickAddVisible} onRequestClose={closeQuickAdd}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.quickAddOverlay}>
          <Pressable style={styles.modalBackdrop} onPress={closeQuickAdd} />
          <View style={[styles.quickAddSheet, { paddingBottom: Math.max(insets.bottom + 14, 22) }, keyboardLiftStyle(keyboardLift)]}>
            <View style={styles.quickAddHeader}>
              <Text style={styles.modalTitle}>添加安排</Text>
              <Pressable onPress={closeQuickAdd} style={styles.modalClose}>
                <Text style={styles.modalCloseText}>×</Text>
              </Pressable>
            </View>
            <TextInput
              autoFocus
              multiline
              onChangeText={setNewTodoText}
              placeholder="例如：晚上8点看场电影"
              style={styles.quickAddInput}
              value={newTodoText}
            />
            <QuickTodoTypeSelector
              onCommit={setNewTodoType}
              onImmediate={(value) => { newTodoTypeRef.current = value; }}
              value={effectiveNewTodoType}
            />
            {quickAddTool ? (
              <View style={styles.quickToolPanel}>
                {quickAddTool === 'date' ? (
                  <Pressable onPress={() => setDateTimePickerTarget({ kind: 'quick' })} style={styles.dateSummaryCard}>
                    <Text style={styles.dateSummaryTitle}>{newTodoDate || '选择日期和时间'}</Text>
                    <Text style={styles.dateSummaryMeta}>
                      {[
                        newTodoTime ? `开始 ${newTodoTime}` : '不定时',
                        newTodoEndTime ? `结束 ${newTodoEndTime}` : '',
                        newTodoRangeEndDate ? `至 ${newTodoRangeEndDate}` : '',
                        recurrenceLabels[newTodoRecurrence],
                      ].filter(Boolean).join(' · ')}
                    </Text>
                  </Pressable>
                ) : null}
                {quickAddTool === 'category' ? (
                  <View style={styles.quickChipGrid}>
                    {categoryConfig.map((category) => (
                      <Pressable
                        key={category.id}
                        onPress={() => setNewTodoCategory(category.id)}
                        style={[
                          styles.quickChoiceChip,
                          { borderColor: category.color },
                          newTodoCategory === category.id && { backgroundColor: `${category.color}22` },
                        ]}
                      >
                        <Text style={styles.metaChipText}>{category.icon} {category.label}</Text>
                      </Pressable>
                    ))}
                  </View>
                ) : null}
                {quickAddTool === 'quadrant' ? (
                  <View style={styles.quickChipGrid}>
                    {quadrantConfig.map((quadrant) => (
                      <Pressable
                        key={quadrant.id}
                        onPress={() => setNewTodoQuadrant(quadrant.id)}
                        style={[
                          styles.quickChoiceChip,
                          { borderColor: quadrant.border },
                          newTodoQuadrant === quadrant.id && { backgroundColor: quadrant.color },
                        ]}
                      >
                        <Text style={styles.metaChipText}>{quadrant.title}</Text>
                      </Pressable>
                    ))}
                  </View>
                ) : null}
                {quickAddTool === 'subtasks' ? (
                  <>
                    {newTodoSubtasks.map((subtask, index) => (
                      <View key={`${subtask}-${index}`} style={styles.subtaskRow}>
                        <Text style={styles.subtaskBullet}>•</Text>
                        <Text style={styles.subtaskText}>{subtask}</Text>
                        <Pressable onPress={() => setNewTodoSubtasks((current) => current.filter((_, itemIndex) => itemIndex !== index))}>
                          <Text style={styles.subtaskRemove}>×</Text>
                        </Pressable>
                      </View>
                    ))}
                    <View style={styles.quickToolRow}>
                      <TextInput
                        onChangeText={setNewTodoSubtaskDraft}
                        placeholder="添加一个子任务"
                        style={[styles.input, styles.flex]}
                        value={newTodoSubtaskDraft}
                      />
                      <Pressable
                        onPress={() => {
                          const value = newTodoSubtaskDraft.trim();
                          if (!value) return;
                          setNewTodoSubtasks((current) => [...current, value]);
                          setNewTodoSubtaskDraft('');
                        }}
                        style={styles.smallPrimaryButton}
                      >
                        <Text style={styles.primaryText}>添加</Text>
                      </Pressable>
                    </View>
                  </>
                ) : null}
                {quickAddTool === 'notes' ? (
                  <TextInput
                    multiline
                    onChangeText={setNewTodoNotes}
                    placeholder="备注、地点、准备材料..."
                    style={styles.quickNotesInput}
                    textAlignVertical="top"
                    value={newTodoNotes}
                  />
                ) : null}
              </View>
            ) : null}
            <View style={styles.quickToolbar}>
              {([
                ['date', newTodoDate ? (newTodoTime ? `${newTodoDate.slice(5)} ${newTodoTime}` : newTodoDate.slice(5)) : '时间', '◷'],
                ['category', getCategoryConfig(newTodoCategory).label, '◆'],
                ['quadrant', getQuadrantConfig(newTodoQuadrant).title, '▦'],
                ['subtasks', newTodoSubtasks.length ? `${newTodoSubtasks.length}项` : '子任务', '┇'],
                ['notes', newTodoNotes.trim() ? '有备注' : '备注', '···'],
              ] as Array<[Exclude<QuickAddTool, null>, string, string]>).map(([tool, label, icon]) => (
                <Pressable
                  key={tool}
                  onPress={() => {
                    if (tool === 'date') {
                      setQuickAddTool('date');
                      setDateTimePickerTarget({ kind: 'quick' });
                      return;
                    }
                    setQuickAddTool((current) => current === tool ? null : tool);
                  }}
                  style={[styles.quickToolButton, quickAddTool === tool && styles.quickToolButtonActive]}
                >
                  <Text style={[styles.quickToolIcon, quickAddTool === tool && styles.quickToolIconActive]}>{icon}</Text>
                  <Text numberOfLines={1} style={styles.quickToolLabel}>{label}</Text>
                </Pressable>
              ))}
              <Pressable onPress={() => void addTodo()} style={styles.quickAddConfirm}>
                <Text style={styles.primaryText}>确定</Text>
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
      <ChoiceSheet sheet={choiceSheet} onClose={closeChoiceSheet} />
      <TaskEditSheet
        draft={taskDraft}
        goals={goals}
        keyboardLift={keyboardLift}
        onChange={setTaskDraft}
        onClose={closeTodoEditor}
        onComplete={completeCurrentTodo}
        onDelete={deleteEditingTodo}
        onEndInhibit={endEditingInhibit}
        onSave={saveCurrentTodo}
        onSchedule={scheduleEditingTodo}
        onTomorrow={postponeCurrentTodo}
        todo={editingTodo}
      />
      <GoalEditSheet
        draft={goalDraft}
        keyboardLift={keyboardLift}
        onChange={setGoalDraft}
        onClose={closeGoalEditor}
        onOpenTargetDate={openGoalTargetDate}
        onSave={saveCurrentGoal}
      />
      <HabitEditSheet
        draft={habitDraft}
        goals={goals}
        keyboardLift={keyboardLift}
        onArchive={allHabits.some(habit => habit.id === habitDraft?.id && habit.status === 'active') ? archiveCurrentHabit : undefined}
        onDelete={habitDraft?.id ? deleteCurrentHabit : undefined}
        onChange={setHabitDraft}
        onClose={closeHabitEditor}
        onSave={saveCurrentHabit}
      />
      <DailyChallengeEditSheet
        draft={challengeDraft}
        keyboardLift={keyboardLift}
        onArchive={challengeDraft?.id ? archiveCurrentChallenge : undefined}
        onChange={setChallengeDraft}
        onClose={closeChallengeEditor}
        onSave={saveCurrentChallenge}
      />
      <GoalDetailSheet
        goal={selectedGoal}
        onClose={closeGoalDetail}
        onCompleteGoal={completeSelectedGoal}
        onManualMinutes={addGoalMinutes}
        tasks={selectedGoalTasks}
      />
      <DateTimePickerSheet
        dateOnly={dateTimePickerTarget?.kind === 'goal'}
        onClose={closeDateTimePicker}
        onConfirm={confirmDateTimePicker}
        title={dateTimePickerTarget?.kind === 'goal' ? '目标日期' : dateTimePickerTarget?.kind === 'quick' ? '日期和时间' : '编辑时间'}
        value={activeDateTimeValue()}
        visible={!!dateTimePickerTarget}
      />
      <Modal animationType="slide" transparent visible={!!draft} onRequestClose={closeEditor}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.modalOverlay}
        >
          <Pressable style={styles.modalBackdrop} onPress={closeEditor} />
          <View style={[styles.modalSheet, { paddingBottom: Math.max(insets.bottom + 14, 22) }, keyboardLiftStyle(keyboardLift)]}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>{editorMode.kind === 'edit' ? '查看详情' : '新建日程'}</Text>
              <Pressable onPress={closeEditor} style={styles.modalClose}>
                <Text style={styles.modalCloseText}>×</Text>
              </Pressable>
            </View>
            <ScrollView
              contentContainerStyle={styles.modalContent}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              {draft ? <DraftEditor draft={draft} onChange={setDraft} onOpenDateTime={openDraftDateTime} onRemove={removeCurrentDraft} /> : null}
              <Pressable onPress={() => void saveCurrentDraft()} style={styles.primaryButton}>
                <Text style={styles.primaryText}>确认保存</Text>
              </Pressable>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}
