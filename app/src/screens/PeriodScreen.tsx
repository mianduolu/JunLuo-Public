import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { Calendar, type DateData } from 'react-native-calendars';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAiConfigPreferences } from '../ai/AiConfigPreferences';
import { runBackupProtectedTask } from '../backup/backupService';
import type { BackgroundSettings } from '../backgrounds/BackgroundPreferences';
import { BodyDataFeature, type BodyDataDestination } from '../bodySignal/BodyDataFeature';
import { useWithYouFeaturePreference, type WithYouFeature } from '../period/withYouFeaturePreference';
import { AppText as Text, AppTextInput as TextInput } from '../components/AppText';
import { BackgroundSurface } from '../components/BackgroundSurface';
import { ShiyingFeature } from '../shiying/ShiyingFeature';
import type { ShiyingOpenRequest } from '../shiying/shiyingNotificationPolicy';
import { TheaterFeature } from '../theater/TheaterFeature';
import type { TheaterFeatureController } from '../theater/useTheaterFeature';
import { RelationshipDatesFeature } from '../letters/RelationshipDatesFeature';
import { PhoneRestrictionFeature } from '../phoneRestriction/PhoneRestrictionFeature';
import { createPeriodCycleMemory } from '../period/periodCycleMemory';
import { PeriodObservationList } from '../period/PeriodObservationList';
import {
  defaultPeriodReminderSettings,
  loadPeriodReminderSettings,
  savePeriodReminderSettings,
  type PeriodReminderSettings,
} from '../period/periodReminderSettings';
import {
  endCurrentPeriod,
  getPeriodDateKey,
  getPeriodDurationDays,
  loadDailyLog,
  loadDailyLogsBetween,
  loadPeriodObservations,
  loadPeriodSummary,
  saveDailyLog,
  startCurrentPeriod,
  updatePeriodEndDate,
  type PeriodDailyLog,
  type PeriodObservation,
  type PeriodBodyState,
  type PeriodEntry,
  type PeriodFlow,
  type PeriodPrediction,
  type PeriodSummary,
} from '../period/periodStore';
import { colors } from '../theme/colors';
import { getOverlayTextStyle, type HomeBackgroundReadability } from '../theme/homeReadability';
import type { Navigate } from '../types/navigation';
import type { SkyTheme } from '../utils/sky';

type Props = {
  theater: TheaterFeatureController;
  backgroundReadability: HomeBackgroundReadability;
  backgroundSettings: BackgroundSettings;
  navigate: Navigate;
  skyTheme: SkyTheme;
  initialBodyData?: BodyDataDestination;
  shiyingOpenRequest?: ShiyingOpenRequest | null;
  onShiyingOpenRequestConsumed?: (requestId: string) => void;
};

type PeriodTab = 'today' | 'calendar' | 'insights';

const flowOptions: Array<{ label: string; value: PeriodFlow }> = [
  { label: '无', value: 'none' },
  { label: '点滴', value: 'spotting' },
  { label: '少', value: 'light' },
  { label: '中', value: 'medium' },
  { label: '多', value: 'heavy' },
];

const symptomOptions = ['腹痛', '腰酸', '头痛', '乏力', '恶心', '乳房胀痛', '情绪波动', '失眠'];
const calendarMarkerColors = {
  normal: '#FFD6E7',
  period: '#FF9B91',
  predictionFill: '#DCD3FF',
  uncertain: '#BFE4FF',
};
const painOptions = [
  { emoji: '😊', label: '无感', value: 0 },
  { emoji: '🙂', label: '一点', value: 1 },
  { emoji: '😐', label: '能忍', value: 2 },
  { emoji: '😟', label: '明显', value: 3 },
  { emoji: '😣', label: '很疼', value: 4 },
  { emoji: '😭', label: '剧痛', value: 5 },
];

function formatDate(value: number) {
  return new Date(value).toLocaleDateString('zh-CN', {
    month: 'long',
    day: 'numeric',
  });
}

function formatFullDate(value: number) {
  return new Date(value).toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function dateKeyToLocalTime(key: string) {
  const match = key.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return new Date().setHours(0, 0, 0, 0);
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
}

function addDays(time: number, days: number) {
  const date = new Date(time);
  date.setDate(date.getDate() + days);
  return date.getTime();
}

function eachDateKeyBetween(startAt: number, endAt: number) {
  const keys: string[] = [];
  const start = new Date(startAt);
  start.setHours(0, 0, 0, 0);
  const end = new Date(endAt);
  end.setHours(0, 0, 0, 0);
  for (let cursor = start.getTime(); cursor <= end.getTime(); cursor = addDays(cursor, 1)) {
    keys.push(getPeriodDateKey(cursor));
  }
  return keys;
}

function adjacentDateKey(key: string, offset: number) {
  return getPeriodDateKey(addDays(dateKeyToLocalTime(key), offset));
}

function predictionTitle(prediction: PeriodPrediction | null) {
  if (!prediction) return '记录两次后，我就能帮你估下次日期';
  if (prediction.daysUntilDue > 0) return '可能快到经期窗口了';
  if (prediction.daysUntilDue === 0) return '可能正在经期窗口附近';
  return '最近还在窗口附近';
}

function predictionDetail(prediction: PeriodPrediction | null) {
  if (!prediction) return '先记录两次完整经期，估算会更稳一点。';
  return `参考上次记录：${formatFullDate(prediction.estimatedStartAt)} 左右，不当成确定日期。平均周期 ${prediction.averageCycleLength} 天`;
}

function historyRange(period: PeriodEntry) {
  const start = formatDate(period.startAt);
  const end = period.endAt ? formatDate(period.endAt) : '进行中';
  return `${start} - ${end}`;
}

function todaySummary(flow: PeriodFlow, painLevel: number, symptoms: string[], bodyState: PeriodBodyState) {
  const flowLabel = flowOptions.find((option) => option.value === flow)?.label ?? '无';
  const symptomText = symptoms.length ? symptoms.slice(0, 3).join('、') : '没有特别标记';
  const extra = symptoms.length > 3 ? `等 ${symptoms.length} 项` : '';
  const stateText = bodyState === 'uncertain' ? '感觉不舒服 · ' : '';
  return `${stateText}流量 ${flowLabel} · 疼痛 ${painLevel}/5 · ${symptomText}${extra}`;
}

function flowLabel(flow: PeriodFlow) {
  return flowOptions.find((option) => option.value === flow)?.label ?? '无';
}

function dailyLogSummary(log: PeriodDailyLog) {
  const symptomText = log.symptoms.length ? log.symptoms.join('、') : '无症状标记';
  const stateText = log.bodyState === 'period' ? '经期' : log.bodyState === 'uncertain' ? '不确定' : '普通';
  return `${stateText} · 流量 ${flowLabel(log.flow)} · 疼痛 ${log.painLevel}/5 · ${symptomText}`;
}

function hasDailyLogContent(log: PeriodDailyLog) {
  return log.bodyState !== 'normal'
    || log.flow !== 'none'
    || log.painLevel > 0
    || log.symptoms.length > 0
    || log.note.trim().length > 0;
}

function selectedPeriodForDate(dateKey: string, periods: PeriodEntry[]) {
  const time = dateKeyToLocalTime(dateKey);
  return periods.find((period) => {
    const endAt = period.endAt ?? Date.now();
    return time >= dateKeyToLocalTime(getPeriodDateKey(period.startAt)) && time <= dateKeyToLocalTime(getPeriodDateKey(endAt));
  }) ?? null;
}

function predictionContainsDate(dateKey: string, prediction: PeriodPrediction | null) {
  if (!prediction) return false;
  const time = dateKeyToLocalTime(dateKey);
  return time >= dateKeyToLocalTime(getPeriodDateKey(prediction.estimatedStartAt))
    && time <= dateKeyToLocalTime(getPeriodDateKey(prediction.estimatedEndAt));
}

function average(values: number[]) {
  if (!values.length) return null;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function standardDeviation(values: number[]) {
  if (values.length < 2) return null;
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length;
  return Math.round(Math.sqrt(variance));
}

function buildPeriodInsights(periods: PeriodEntry[], logs: PeriodDailyLog[]) {
  const completed = periods
    .filter((period) => period.endAt !== null)
    .sort((left, right) => left.startAt - right.startAt);
  const durations = completed.map((period) => getPeriodDurationDays(period));
  const cycleLengths: number[] = [];
  for (let index = 0; index < completed.length - 1; index += 1) {
    const days = Math.round((dateKeyToLocalTime(getPeriodDateKey(completed[index + 1].startAt)) - dateKeyToLocalTime(getPeriodDateKey(completed[index].startAt))) / (24 * 60 * 60 * 1000));
    if (days >= 10 && days <= 130) cycleLengths.push(days);
  }

  const symptomCounts = new Map<string, number>();
  logs.forEach((log) => {
    log.symptoms.forEach((symptom) => symptomCounts.set(symptom, (symptomCounts.get(symptom) ?? 0) + 1));
  });
  const commonSymptoms = Array.from(symptomCounts.entries())
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 4);

  const painByDay = new Map<number, { count: number; total: number }>();
  logs.forEach((log) => {
    const period = log.periodId
      ? periods.find((entry) => entry.id === log.periodId)
      : selectedPeriodForDate(log.dateKey, periods);
    if (!period || log.painLevel <= 0) return;
    const day = Math.max(1, Math.round((dateKeyToLocalTime(log.dateKey) - dateKeyToLocalTime(getPeriodDateKey(period.startAt))) / (24 * 60 * 60 * 1000)) + 1);
    const current = painByDay.get(day) ?? { count: 0, total: 0 };
    painByDay.set(day, { count: current.count + 1, total: current.total + log.painLevel });
  });
  const peakPain = Array.from(painByDay.entries())
    .map(([day, value]) => ({ averagePain: value.total / value.count, day }))
    .sort((left, right) => right.averagePain - left.averagePain || left.day - right.day)[0] ?? null;

  return {
    averageCycleLength: average(cycleLengths),
    averageDuration: average(durations),
    commonSymptoms,
    cycleDeviation: standardDeviation(cycleLengths),
    longestDuration: durations.length ? Math.max(...durations) : null,
    peakPain,
    shortestDuration: durations.length ? Math.min(...durations) : null,
    totalCompleted: completed.length,
    totalLoggedDays: logs.length,
  };
}

export function PeriodScreen({ backgroundReadability, backgroundSettings, navigate, skyTheme, initialBodyData, theater,
  shiyingOpenRequest, onShiyingOpenRequestConsumed }: Props) {
  const insets = useSafeAreaInsets();
  const { chatConnection, chatKey, lifeCreativeConnection, lifeCreativeKey, profile } = useAiConfigPreferences();
  const lifeCreativeConnectionForUse = lifeCreativeConnection ?? chatConnection;
  const lifeCreativeKeyForUse = lifeCreativeConnection ? lifeCreativeKey : chatKey;
  const headerTextStyle = useMemo(
    () => getOverlayTextStyle(backgroundReadability.headerText),
    [backgroundReadability.headerText],
  );
  const [bodyState, setBodyState] = useState<PeriodBodyState>('normal');
  const [summary, setSummary] = useState<PeriodSummary | null>(null);
  const [flow, setFlow] = useState<PeriodFlow>('none');
  const [painLevel, setPainLevel] = useState(0);
  const [symptoms, setSymptoms] = useState<string[]>([]);
  const [customSymptom, setCustomSymptom] = useState('');
  const [recordExpanded, setRecordExpanded] = useState(true);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [recentRecordsExpanded, setRecentRecordsExpanded] = useState(false);
  const [note, setNote] = useState('');
  const todayKey = getPeriodDateKey();
  const [editingObservation, setEditingObservation] = useState<PeriodObservation | null>(null);
  const [recordTime, setRecordTime] = useState('');
  const [recordObservations, setRecordObservations] = useState<PeriodObservation[]>([]);
  const [selectedObservations, setSelectedObservations] = useState<PeriodObservation[]>([]);
  const [observationRevision, setObservationRevision] = useState(0);
  const [saving, setSaving] = useState(false);
  const saveInProgress = useRef(false);
  const scrollRef = useRef<ScrollView>(null);
  const [recordDateKey, setRecordDateKey] = useState(todayKey);
  const [activeTab, setActiveTab] = useState<PeriodTab>('today');
  const { activeFeature, setActiveFeature } = useWithYouFeaturePreference(initialBodyData ? 'body' : undefined);
  // Keep visited panels mounted for this With You session: drafts and native scroll offsets survive.
  const visitedFeatures = useRef(new Set<WithYouFeature>());
  visitedFeatures.current.add(activeFeature);
  const featureStyle = (feature: WithYouFeature) => ({ flex: 1, display: activeFeature === feature ? 'flex' as const : 'none' as const });
  const [featureDrawerVisible, setFeatureDrawerVisible] = useState(false);
  useEffect(() => {
    if (!shiyingOpenRequest) return;
    setActiveFeature('shiying');
    setFeatureDrawerVisible(false);
  }, [shiyingOpenRequest?.requestId]);
  const [selectedDateKey, setSelectedDateKey] = useState(todayKey);
  const [selectedDayLog, setSelectedDayLog] = useState<PeriodDailyLog | null>(null);
  const [calendarLogs, setCalendarLogs] = useState<PeriodDailyLog[]>([]);
  const [reminderSettings, setReminderSettings] = useState<PeriodReminderSettings>(defaultPeriodReminderSettings);

  const currentPeriod = summary?.currentPeriod ?? null;
  const prediction = summary?.prediction ?? null;
  const history = summary?.history ?? [];
  const allPeriods = useMemo(() => {
    const entries = currentPeriod ? [currentPeriod, ...history.filter((period) => period.id !== currentPeriod.id)] : history;
    return entries;
  }, [currentPeriod, history]);
  const recordPeriod = selectedPeriodForDate(recordDateKey, allPeriods);
  const isTodayRecord = recordDateKey === todayKey;

  const loadCalendarLogsForSummary = async (next: PeriodSummary) => {
    const anchors = [
      addDays(Date.now(), -180),
      addDays(Date.now(), 90),
      dateKeyToLocalTime(recordDateKey),
      dateKeyToLocalTime(selectedDateKey),
      ...next.history.flatMap((period) => [period.startAt, period.endAt ?? Date.now()]),
      next.prediction?.estimatedStartAt,
      next.prediction?.estimatedEndAt,
      Date.now(),
    ].filter((value): value is number => typeof value === 'number');
    const startAt = Math.min(...anchors);
    const endAt = Math.max(...anchors);
    return loadDailyLogsBetween(getPeriodDateKey(startAt), getPeriodDateKey(endAt));
  };

  const refresh = async (targetDateKey = recordDateKey, detailDateKey = selectedDateKey) => {
    const next = await loadPeriodSummary();
    const logs = await loadCalendarLogsForSummary(next);
    const nextPeriods = next.currentPeriod
      ? [next.currentPeriod, ...next.history.filter((period) => period.id !== next.currentPeriod!.id)]
      : next.history;
    const targetLog = targetDateKey === todayKey
      ? next.todayLog
      : logs.find((log) => log.dateKey === targetDateKey) ?? await loadDailyLog(targetDateKey);
    const targetPeriod = selectedPeriodForDate(targetDateKey, nextPeriods);
    setSummary(next);
    setBodyState(targetLog?.bodyState ?? (targetPeriod ? 'period' : 'normal'));
    setFlow(targetLog?.flow ?? 'none');
    setPainLevel(targetLog?.painLevel ?? 0);
    setSymptoms(targetLog?.symptoms ?? []);
    setNote('');
    setEditingObservation(null);
    setRecordTime('');
    setObservationRevision((value) => value + 1);
    setCustomSymptom('');
    setRecordExpanded(!targetLog || targetDateKey !== todayKey);
    setCalendarLogs(logs);
    setSelectedDayLog(logs.find((log) => log.dateKey === detailDateKey) ?? (detailDateKey === todayKey ? next.todayLog : null));
  };

  useEffect(() => {
    void refresh();
    void loadPeriodReminderSettings().then(setReminderSettings);
  }, []);

  useEffect(() => {
    let active = true;
    setRecordObservations([]);
    void loadPeriodObservations(recordDateKey).then((entries) => {
      if (active) setRecordObservations(entries);
    });
    return () => { active = false; };
  }, [recordDateKey, observationRevision]);

  useEffect(() => {
    let active = true;
    setSelectedObservations([]);
    void loadPeriodObservations(selectedDateKey).then((entries) => {
      if (active) setSelectedObservations(entries);
    });
    return () => { active = false; };
  }, [selectedDateKey, observationRevision]);

  const saveRecord = async () => {
    if (saveInProgress.current) return;
    saveInProgress.current = true;
    setSaving(true);
    try {
      const activeRecordPeriod = selectedPeriodForDate(recordDateKey, allPeriods);
      const nextBodyState = editingObservation ? bodyState : activeRecordPeriod ? 'period' : bodyState;
      const write = await runBackupProtectedTask(() => saveDailyLog({
        bodyState: nextBodyState,
        dateKey: recordDateKey,
        flow,
        note,
        painLevel,
        periodId: editingObservation ? editingObservation.periodId : activeRecordPeriod?.id ?? null,
        symptoms,
      }, {
        observationId: editingObservation?.id,
        timeText: recordTime.trim() || (editingObservation || !isTodayRecord ? null : undefined),
      }));
      if (!write.ran) throw new Error('正在恢复数据，请重新打开身体手账后再保存。');
      await refresh(recordDateKey);
      Alert.alert('记好啦', isTodayRecord ? '今天这条身体记录已经收好。' : `${recordDateKey} 这条身体记录已经补好。`);
    } catch (error) {
      Alert.alert('记录未保存', error instanceof Error ? error.message : '请稍后重试。');
    } finally {
      saveInProgress.current = false;
      setSaving(false);
    }
  };

  const markUncertain = async () => {
    const savedLog = await saveDailyLog({
      bodyState: 'uncertain',
      dateKey: recordDateKey,
      flow,
      note,
      painLevel,
      periodId: null,
      symptoms,
    }, { timeText: recordTime.trim() || undefined }).catch((error) => {
      Alert.alert('记录未保存', error instanceof Error ? error.message : '请稍后重试。');
      return null;
    });
    if (!savedLog) return;
    setBodyState(savedLog.bodyState);
    await refresh(recordDateKey);
    Alert.alert(
      '记好啦',
      isTodayRecord
        ? '今天先记成“感觉不舒服”，不会把它算进正式经期。'
        : `${recordDateKey} 先记成“感觉不舒服”。这天不会算进正式经期。`,
    );
  };

  const cancelUncertain = async () => {
    const savedLog = await saveDailyLog({
      bodyState: 'normal',
      dateKey: recordDateKey,
      flow,
      note,
      painLevel,
      periodId: null,
      symptoms,
    }, { timeText: recordTime.trim() || undefined }).catch((error) => {
      Alert.alert('记录未保存', error instanceof Error ? error.message : '请稍后重试。');
      return null;
    });
    if (!savedLog) return;
    setBodyState(savedLog.bodyState);
    await refresh(recordDateKey);
    Alert.alert('收好啦', isTodayRecord ? '今天已取消“感觉不舒服”状态。' : `${recordDateKey} 已经取消“感觉不舒服”状态。`);
  };

  const confirmStartPeriod = () => {
    Alert.alert(isTodayRecord ? '今天是第一天吗？' : `从 ${recordDateKey} 开始吗？`, '确认后会从这一天开始记录本次经期，并把这天的身体记录一起收好。', [
      { text: '先等等', style: 'cancel' },
      { text: '是，开始记录', onPress: () => void startPeriod() },
    ]);
  };

  const startPeriod = async () => {
    if (recordTime.trim() && !/^([01]\d|2[0-3]):[0-5]\d$/.test(recordTime.trim())) {
      Alert.alert('记录未保存', '时间请填写为 HH:mm，例如 14:30。');
      return;
    }
    const entry = await startCurrentPeriod(recordDateKey);
    const savedLog = await saveDailyLog({
      bodyState: 'period',
      dateKey: recordDateKey,
      flow: flow === 'none' ? 'medium' : flow,
      note,
      painLevel,
      periodId: entry.id,
      symptoms,
    }, { timeText: recordTime.trim() || undefined });
    await refresh(recordDateKey);
  };

  const confirmEndPeriod = () => {
    const duration = currentPeriod ? getPeriodDurationDays(currentPeriod) : 1;
    Alert.alert('结束本次记录？', `这次已经记到第 ${duration} 天。确认结束后，今天会作为结束日。`, [
      { text: '继续记录', style: 'cancel' },
      { text: '结束本次', style: 'destructive', onPress: () => void endPeriod() },
    ]);
  };

  const endPeriod = async () => {
    const ended = await endCurrentPeriod(todayKey);
    if (ended) {
      void createPeriodCycleMemory({
        apiKey: lifeCreativeKeyForUse,
        connection: lifeCreativeConnectionForUse,
        period: ended,
        profile,
      }).catch(() => undefined);
    }
    await refresh();
    if (ended) {
      Alert.alert('收好啦', `这次持续了 ${getPeriodDurationDays(ended)} 天。今天先把身体放在前面一点。`);
    }
  };

  const confirmCorrectPeriodEnd = (period: PeriodEntry, dateKey: string) => {
    Alert.alert(
      '结束在这一天？',
      `确认把 ${formatFullDate(period.startAt)} 至 ${formatFullDate(dateKeyToLocalTime(dateKey))} 记为本次经期吗？这一天之后误多出的经期标记会撤下，已经写过的身体内容仍会保留。`,
      [
        { text: '先不改', style: 'cancel' },
        { text: '确认修改', onPress: () => void correctPeriodEnd(period, dateKey) },
      ],
    );
  };

  const correctPeriodEnd = async (period: PeriodEntry, dateKey: string) => {
    const ended = await updatePeriodEndDate(period.id, dateKey);
    if (!ended) return;
    void createPeriodCycleMemory({
      apiKey: lifeCreativeKeyForUse,
      connection: lifeCreativeConnectionForUse,
      period: ended,
      profile,
      replaceExisting: true,
    }).catch(() => undefined);
    await refresh(recordDateKey, dateKey);
    Alert.alert('已经改好', `本次经期现在记录为 ${getPeriodDurationDays(ended)} 天，后面误多出的日期已经撤下。`);
  };

  const toggleSymptom = (value: string) => {
    setSymptoms((current) =>
      current.includes(value) ? current.filter((item) => item !== value) : [...current, value],
    );
  };

  const addCustomSymptom = () => {
    const value = customSymptom.trim();
    if (!value) return;
    setSymptoms((current) => (current.includes(value) ? current : [...current, value]));
    setCustomSymptom('');
  };

  const updateReminderSettings = async (patch: Partial<PeriodReminderSettings>) => {
    const next = { ...reminderSettings, ...patch };
    setReminderSettings(next);
    await savePeriodReminderSettings(next);
  };

  const visibleHistory = historyExpanded ? history : history.slice(0, 3);
  const recentDailyLogs = useMemo(() => {
    const byDate = new Map<string, PeriodDailyLog>();
    calendarLogs.forEach((log) => byDate.set(log.dateKey, log));
    if (summary?.todayLog) byDate.set(summary.todayLog.dateKey, summary.todayLog);
    return Array.from(byDate.values())
      .filter(hasDailyLogContent)
      .sort((left, right) => right.dateKey.localeCompare(left.dateKey))
      .slice(0, 8);
  }, [calendarLogs, summary?.todayLog]);
  const customSelectedSymptoms = symptoms.filter((symptom) => !symptomOptions.includes(symptom));
  const selectedPeriod = selectedPeriodForDate(selectedDateKey, allPeriods);
  const selectedPredicted = predictionContainsDate(selectedDateKey, prediction);
  const insights = useMemo(() => buildPeriodInsights(history, calendarLogs), [calendarLogs, history]);

  const calendarMarks = useMemo(() => {
    const marks: Record<string, {
      color?: string;
      endingDay?: boolean;
      startingDay?: boolean;
      textColor?: string;
    }> = {};
    const dateKinds = new Map<string, 'normal' | 'period' | 'prediction' | 'uncertain'>();
    const priority = { prediction: 0, normal: 1, uncertain: 2, period: 3 };
    const setKind = (key: string, kind: 'normal' | 'period' | 'prediction' | 'uncertain') => {
      const current = dateKinds.get(key);
      if (!current || priority[kind] >= priority[current]) dateKinds.set(key, kind);
    };

    if (prediction) {
      eachDateKeyBetween(prediction.estimatedStartAt, prediction.estimatedEndAt).forEach((key) => {
        setKind(key, 'prediction');
      });
    }

    allPeriods.forEach((period) => {
      eachDateKeyBetween(period.startAt, period.endAt ?? Date.now()).forEach((key) => {
        setKind(key, 'period');
      });
    });

    const visibleLogs = new Map<string, PeriodDailyLog>();
    calendarLogs.forEach((log) => visibleLogs.set(log.dateKey, log));
    if (summary?.todayLog) visibleLogs.set(summary.todayLog.dateKey, summary.todayLog);
    if (selectedDayLog) visibleLogs.set(selectedDayLog.dateKey, selectedDayLog);

    visibleLogs.forEach((log) => {
      if (log.bodyState === 'period') setKind(log.dateKey, 'period');
      else if (log.bodyState === 'uncertain') setKind(log.dateKey, 'uncertain');
      else setKind(log.dateKey, 'normal');
    });

    dateKinds.forEach((kind, key) => {
      const previousKind = dateKinds.get(adjacentDateKey(key, -1));
      const nextKind = dateKinds.get(adjacentDateKey(key, 1));
      const color =
        kind === 'period'
          ? calendarMarkerColors.period
          : kind === 'uncertain'
            ? calendarMarkerColors.uncertain
            : kind === 'normal'
              ? calendarMarkerColors.normal
              : calendarMarkerColors.predictionFill;
      marks[key] = {
        color,
        endingDay: nextKind !== kind,
        startingDay: previousKind !== kind,
        textColor: kind === 'period' ? '#FFFFFF' : colors.ink,
      };
    });

    return marks;
  }, [allPeriods, calendarLogs, prediction, selectedDateKey, selectedDayLog, summary?.todayLog]);

  const selectCalendarDate = async (dateKey: string) => {
    setSelectedDateKey(dateKey);
    const cached = calendarLogs.find((log) => log.dateKey === dateKey);
    setSelectedDayLog(cached ?? await loadDailyLog(dateKey));
  };

  const editRecordDate = async (dateKey: string) => {
    setRecordDateKey(dateKey);
    setSelectedDateKey(dateKey);
    setActiveTab('today');
    await refresh(dateKey, dateKey);
    setRecordExpanded(true);
    scrollRef.current?.scrollTo({ y: 0, animated: true });
  };

  const editObservation = async (entry: PeriodObservation) => {
    await editRecordDate(entry.dateKey);
    setEditingObservation(entry);
    setRecordTime(entry.timeText ?? '');
    setBodyState(entry.bodyState);
    setFlow(entry.flow);
    setPainLevel(entry.painLevel);
    setSymptoms(entry.symptoms);
    setNote(entry.note);
  };

  return (
    <BackgroundSurface settings={backgroundSettings} skyTheme={skyTheme}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.root}
      >
        <View style={styles.workbench}>
          <View style={styles.featureContent}>
            {visitedFeatures.current.has('body') ? <View style={featureStyle('body')}>
              <BodyDataFeature navigate={navigate} initialDestination={initialBodyData} onOpenFeatureDrawer={() => setFeatureDrawerVisible(true)} />
            </View> : null}
            {visitedFeatures.current.has('diary') ? <View style={featureStyle('diary')}>
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={[
            styles.content,
            { paddingBottom: Math.max(28, insets.bottom + 20), paddingTop: Math.max(18, insets.top + 8) },
          ]}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.header}>
            <Pressable onPress={() => setFeatureDrawerVisible(true)} style={styles.backButton}>
              <Text style={styles.menuText}>☰</Text>
            </Pressable>
            <View style={styles.headerCopy}>
              <Text style={[styles.title, headerTextStyle]}>身体日记</Text>
            </View>
          </View>

          <View style={styles.statusPanel}>
            <View style={styles.statusTextBlock}>
              <Text style={styles.statusLabel}>{currentPeriod ? '本次经期' : '下一次预测'}</Text>
              <Text style={styles.statusTitle}>
                {currentPeriod ? `第 ${getPeriodDurationDays(currentPeriod)} 天` : predictionTitle(prediction)}
              </Text>
              <Text style={styles.statusDetail}>
                {currentPeriod
                  ? `${formatFullDate(currentPeriod.startAt)} 开始记录`
                  : predictionDetail(prediction)}
              </Text>
            </View>
            <View style={styles.statusButtons}>
              <Pressable
                onPress={currentPeriod ? confirmEndPeriod : confirmStartPeriod}
                style={[styles.primaryButton, currentPeriod && styles.secondaryButton]}
              >
                <Text style={[styles.primaryButtonText, currentPeriod && styles.secondaryButtonText]}>
                  {currentPeriod ? '结束本次' : '开始记录'}
                </Text>
              </Pressable>
              {allPeriods.length ? (
                <Pressable onPress={() => setActiveTab('calendar')} style={styles.periodEditShortcut}>
                  <Text style={styles.periodEditShortcutText}>修改日期</Text>
                </Pressable>
              ) : null}
            </View>
          </View>

          <View style={styles.tabBar}>
            {(['today', 'calendar', 'insights'] as const).map((tab) => {
              const selected = activeTab === tab;
              return (
                <Pressable
                  key={tab}
                  onPress={() => setActiveTab(tab)}
                  style={[styles.tabButton, selected && styles.tabButtonSelected]}
                >
                  <Text style={[styles.tabText, selected && styles.tabTextSelected]}>
                    {tab === 'today' ? '今日' : tab === 'calendar' ? '日历' : '洞察'}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {activeTab === 'today' ? (
            <>

              <View style={styles.panel}>
            <Pressable onPress={() => setRecordExpanded((value) => !value)} style={styles.sectionHeader}>
              <View style={styles.sectionTitleBlock}>
                <Text style={styles.sectionTitle}>{editingObservation ? '修改这次记录' : isTodayRecord ? '今日记录' : '补记记录'}</Text>
                {(isTodayRecord ? summary?.todayLog : true) ? <Text style={styles.recordSummary}>{todaySummary(flow, painLevel, symptoms, bodyState)}</Text> : null}
              </View>
              <Text style={styles.sectionMeta}>{recordExpanded ? '收起' : '展开'} · {recordDateKey}</Text>
            </Pressable>

            {recordExpanded ? (
              <>
                <Text style={styles.fieldLabel}>记录时间</Text>
                <TextInput
                  accessibilityLabel="记录时间，小时和分钟"
                  onChangeText={setRecordTime}
                  placeholder={editingObservation || !isTodayRecord ? '时间未标注（可填 14:30）' : '现在（可填 14:30）'}
                  placeholderTextColor="rgba(56,64,82,0.42)"
                  maxLength={5}
                  autoCorrect={false}
                  style={styles.observationTimeInput}
                  value={recordTime}
                />
                <Text style={styles.fieldLabel}>流量</Text>
                <View style={styles.segmentRow}>
                  {flowOptions.map((option) => (
                    <Pressable
                      key={option.value}
                      onPress={() => setFlow(option.value)}
                      style={[styles.segment, flow === option.value && styles.segmentSelected]}
                    >
                      <Text style={[styles.segmentText, flow === option.value && styles.segmentTextSelected]}>
                        {option.label}
                      </Text>
                    </Pressable>
                  ))}
                </View>

                <Text style={styles.fieldLabel}>疼痛</Text>
                <View style={styles.painScale}>
                  {painOptions.map((option) => {
                    const selected = painLevel === option.value;
                    return (
                      <Pressable
                        key={option.value}
                        onPress={() => setPainLevel(option.value)}
                        style={[styles.painChip, selected && styles.painChipSelected]}
                      >
                        <Text style={styles.painEmoji}>{option.emoji}</Text>
                        <Text style={[styles.painLabel, selected && styles.painLabelSelected]}>{option.label}</Text>
                      </Pressable>
                    );
                  })}
                </View>

                <Text style={styles.fieldLabel}>症状</Text>
                <View style={styles.chipWrap}>
                  {symptomOptions.map((symptom) => {
                    const selected = symptoms.includes(symptom);
                    return (
                      <Pressable
                        key={symptom}
                        onPress={() => toggleSymptom(symptom)}
                        style={[styles.chip, selected && styles.chipSelected]}
                      >
                        <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{symptom}</Text>
                      </Pressable>
                    );
                  })}
                  {customSelectedSymptoms.map((symptom) => (
                    <Pressable
                      key={symptom}
                      onPress={() => toggleSymptom(symptom)}
                      style={[styles.chip, styles.customChip, styles.chipSelected]}
                    >
                      <Text style={[styles.chipText, styles.chipTextSelected]}>{symptom} ×</Text>
                    </Pressable>
                  ))}
                </View>

                <View style={styles.customSymptomRow}>
                  <TextInput
                    onChangeText={setCustomSymptom}
                    onSubmitEditing={addCustomSymptom}
                    placeholder="补一个自己的症状"
                    placeholderTextColor="rgba(56,64,82,0.42)"
                    returnKeyType="done"
                    style={styles.customSymptomInput}
                    value={customSymptom}
                  />
                  <Pressable onPress={addCustomSymptom} style={styles.addSymptomButton}>
                    <Text style={styles.addSymptomText}>加入</Text>
                  </Pressable>
                </View>

                <Text style={styles.fieldLabel}>备注</Text>
                <TextInput
                  multiline
                  onChangeText={setNote}
                  placeholder="比如睡眠、情绪、有没有热敷、今天想怎么照顾自己..."
                  placeholderTextColor="rgba(56,64,82,0.42)"
                  style={styles.noteInput}
                  value={note}
                />

                {!recordPeriod && !editingObservation ? (
                  <View style={styles.uncertainActions}>
                    <Pressable
                      onPress={markUncertain}
                      style={[styles.statusActionButton, bodyState === 'uncertain' && styles.statusActionButtonSelected]}
                    >
                      <Text style={[styles.statusActionText, bodyState === 'uncertain' && styles.statusActionTextSelected]}>
                        感觉不舒服
                      </Text>
                    </Pressable>
                    {bodyState === 'uncertain' ? (
                      <Pressable onPress={cancelUncertain} style={styles.statusActionButton}>
                        <Text style={styles.statusActionText}>先取消这个状态</Text>
                      </Pressable>
                    ) : null}
                  </View>
                ) : null}

                {!isTodayRecord ? (
                  <Pressable onPress={() => void editRecordDate(todayKey)} style={styles.returnTodayButton}>
                    <Text style={styles.returnTodayText}>回到今天</Text>
                  </Pressable>
                ) : null}

                <Pressable disabled={saving} onPress={saveRecord} style={styles.saveButton}>
                  <Text style={styles.saveButtonText}>{saving ? '保存中' : editingObservation ? '保存修改' : '保存这次记录'}</Text>
                </Pressable>
              </>
            ) : null}
            {!recordExpanded || editingObservation ? (
              <Pressable disabled={saving} onPress={() => void editRecordDate(recordDateKey)} style={styles.returnTodayButton}>
                <Text style={styles.returnTodayText}>{editingObservation ? '取消修改，另记一次' : '再记一次'}</Text>
              </Pressable>
            ) : null}
            <PeriodObservationList observations={recordObservations} onEdit={(entry) => { if (!saving) void editObservation(entry); }} />
          </View>

          <View style={styles.panel}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="近日记录"
              accessibilityState={{ expanded: recentRecordsExpanded }}
              onPress={() => setRecentRecordsExpanded((value) => !value)}
              style={[styles.sectionHeader, styles.recentRecordsHeader]}
            >
              <View style={styles.sectionTitleBlock}>
                <Text style={styles.sectionTitle}>近日记录</Text>
                <Text style={styles.recordSummary}>{recentDailyLogs.length ? `${recentDailyLogs.length} 条` : '暂无记录'}</Text>
              </View>
              <Text style={styles.sectionMeta}>{recentRecordsExpanded ? '收起' : '展开'}</Text>
            </Pressable>
            {recentRecordsExpanded ? recentDailyLogs.length ? (
              recentDailyLogs.map((log) => (
                <Pressable key={log.id} onPress={() => void editRecordDate(log.dateKey)} style={styles.dailyLogItem}>
                  <View style={styles.dailyLogHeader}>
                    <Text style={styles.historyTitle}>{formatDate(dateKeyToLocalTime(log.dateKey))}</Text>
                    <Text style={styles.historyMeta}>{log.dateKey}</Text>
                  </View>
                  <Text style={styles.historyMeta}>{dailyLogSummary(log)}</Text>
                  {log.note ? <Text style={styles.dailyLogNote}>{log.note}</Text> : null}
                </Pressable>
              ))
            ) : (
              <Text style={styles.emptyText}>保存每日记录后，这里会显示最近写下的身体情况。</Text>
            ) : null}
          </View>

          <View style={styles.panel}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>历史</Text>
              <Text style={styles.sectionMeta}>{history.length ? `${history.length} 次` : '还没有完整记录'}</Text>
            </View>
            {history.length ? (
              <>
                {visibleHistory.map((period) => (
                  <View key={period.id} style={styles.historyItem}>
                    <View>
                      <Text style={styles.historyTitle}>{historyRange(period)}</Text>
                      <Text style={styles.historyMeta}>{getPeriodDurationDays(period)} 天</Text>
                    </View>
                    {!period.endAt ? <Text style={styles.activeBadge}>进行中</Text> : null}
                  </View>
                ))}
                {history.length > 3 ? (
                  <Pressable onPress={() => setHistoryExpanded((value) => !value)} style={styles.historyMoreButton}>
                    <Text style={styles.historyMoreText}>{historyExpanded ? '收起过往周期' : `展开另外 ${history.length - 3} 次`}</Text>
                  </Pressable>
                ) : null}
              </>
            ) : (
              <Text style={styles.emptyText}>下次来时点“开始记录”，这里会慢慢长出你的节奏。</Text>
            )}
          </View>

          <View style={styles.panel}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>提醒</Text>
              <Text style={styles.sectionMeta}>通知栏</Text>
            </View>
            <View style={styles.reminderRow}>
              <View style={styles.reminderCopy}>
                <Text style={styles.reminderTitle}>经期中白云主动关心</Text>
                <Text style={styles.reminderText}>身体记录会参与关心判断，不再单独安排早晚问候。</Text>
              </View>
              <Switch
                onValueChange={(value) => void updateReminderSettings({ careEnabled: value })}
                thumbColor="#FFFFFF"
                trackColor={{ false: 'rgba(56,64,82,0.18)', true: 'rgba(255,161,138,0.56)' }}
                value={reminderSettings.careEnabled}
              />
            </View>
            <View style={[styles.reminderRow, styles.reminderRowLast]}>
              <View style={styles.reminderCopy}>
                <Text style={styles.reminderTitle}>今天想一个人待着</Text>
                <Text style={styles.reminderText}>打开后，今天不追问不舒服，也不主动发经期关心。</Text>
              </View>
              <Switch
                onValueChange={(value) => void updateReminderSettings({ mutedDateKey: value ? todayKey : undefined })}
                thumbColor="#FFFFFF"
                trackColor={{ false: 'rgba(56,64,82,0.18)', true: 'rgba(143,212,209,0.7)' }}
                value={reminderSettings.mutedDateKey === todayKey}
              />
            </View>
          </View>
            </>
          ) : activeTab === 'calendar' ? (
            <View style={styles.panel}>
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionTitle}>周期日历</Text>
                <Text style={styles.sectionMeta}>实际 / 预测</Text>
              </View>
              <Calendar
                current={selectedDateKey}
                markedDates={calendarMarks}
                markingType="period"
                onDayPress={(day: DateData) => void selectCalendarDate(day.dateString)}
                theme={{
                  calendarBackground: 'transparent',
                  arrowColor: colors.primary,
                  monthTextColor: colors.ink,
                  selectedDayBackgroundColor: colors.secondary,
                  textDayFontWeight: '400',
                  textMonthFontWeight: '600',
                  textSectionTitleColor: colors.muted,
                  todayTextColor: colors.primary,
                }}
                style={styles.periodCalendar}
              />
              <View style={styles.calendarLegend}>
                <View style={styles.legendItem}>
                  <View style={[styles.legendDot, styles.legendActual]} />
                  <Text style={styles.legendText}>已记录经期</Text>
                </View>
                <View style={styles.legendItem}>
                  <View style={[styles.legendDot, styles.legendUncertain]} />
                  <Text style={styles.legendText}>感觉不舒服</Text>
                </View>
                <View style={styles.legendItem}>
                  <View style={[styles.legendDot, styles.legendOther]} />
                  <Text style={styles.legendText}>其他不舒服</Text>
                </View>
                <View style={styles.legendItem}>
                  <View style={[styles.legendDot, styles.legendPredicted]} />
                  <Text style={styles.legendText}>预测经期</Text>
                </View>
              </View>
              <View style={styles.dayDetail}>
                <Text style={styles.dayDetailTitle}>{selectedDateKey}</Text>
                {selectedPeriod ? (
                  <Text style={styles.dayDetailMeta}>本次经期第 {Math.max(1, Math.round((dateKeyToLocalTime(selectedDateKey) - dateKeyToLocalTime(getPeriodDateKey(selectedPeriod.startAt))) / (24 * 60 * 60 * 1000)) + 1)} 天</Text>
                ) : selectedDayLog?.bodyState === 'uncertain' ? (
                  <Text style={styles.dayDetailMeta}>这一天记录了感觉不舒服。</Text>
                ) : selectedDayLog ? (
                  <Text style={styles.dayDetailMeta}>这一天记录了其他不舒服。</Text>
                ) : selectedPredicted ? (
                  <Text style={styles.dayDetailMeta}>这一天在预测范围里，只作生活参考。</Text>
                ) : (
                  <Text style={styles.dayDetailMeta}>这一天没有经期标记。</Text>
                )}
                {selectedDayLog ? (
                  <View style={styles.dayLogBox}>
                    {selectedDayLog.bodyState === 'uncertain' ? (
                      <Text style={styles.dayLogText}>状态：感觉不舒服，还没有标成正式经期</Text>
                    ) : null}
                    <Text style={styles.dayLogText}>流量：{flowLabel(selectedDayLog.flow)} · 疼痛：{selectedDayLog.painLevel}/5</Text>
                    <Text style={styles.dayLogText}>症状：{selectedDayLog.symptoms.length ? selectedDayLog.symptoms.join('、') : '没有特别标记'}</Text>
                    {selectedDayLog.note ? <Text style={styles.dayLogNote}>{selectedDayLog.note}</Text> : null}
                  </View>
                ) : (
                  <Text style={styles.emptyText}>这天还没有单独记录。</Text>
                )}
                {selectedPeriod && (
                  selectedPeriod.endAt === null
                  || selectedDateKey < getPeriodDateKey(selectedPeriod.endAt)
                ) ? (
                  <Pressable onPress={() => confirmCorrectPeriodEnd(selectedPeriod, selectedDateKey)} style={styles.dayPeriodEditButton}>
                    <Text style={styles.dayPeriodEditButtonText}>结束在这一天</Text>
                  </Pressable>
                ) : null}
                <Pressable onPress={() => void editRecordDate(selectedDateKey)} style={styles.dayEditButton}>
                  <Text style={styles.dayEditButtonText}>{selectedDayLog ? '再记一次' : '补记这天'}</Text>
                </Pressable>
                <PeriodObservationList observations={selectedObservations} onEdit={(entry) => void editObservation(entry)} />
              </View>
            </View>
          ) : (
            <View style={styles.panel}>
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionTitle}>本地洞察</Text>
                <Text style={styles.sectionMeta}>{insights.totalCompleted ? `${insights.totalCompleted} 次周期` : '还在积累'}</Text>
              </View>

              <View style={styles.insightGrid}>
                <View style={styles.insightCard}>
                  <Text style={styles.insightLabel}>平均周期</Text>
                  <Text style={styles.insightValue}>{insights.averageCycleLength ? `${insights.averageCycleLength} 天` : '--'}</Text>
                </View>
                <View style={styles.insightCard}>
                  <Text style={styles.insightLabel}>平均持续</Text>
                  <Text style={styles.insightValue}>{insights.averageDuration ? `${insights.averageDuration} 天` : '--'}</Text>
                </View>
                <View style={styles.insightCard}>
                  <Text style={styles.insightLabel}>持续范围</Text>
                  <Text style={styles.insightValue}>
                    {insights.shortestDuration && insights.longestDuration ? `${insights.shortestDuration}-${insights.longestDuration} 天` : '--'}
                  </Text>
                </View>
                <View style={styles.insightCard}>
                  <Text style={styles.insightLabel}>周期波动</Text>
                  <Text style={styles.insightValue}>{insights.cycleDeviation !== null ? `±${insights.cycleDeviation} 天` : '--'}</Text>
                </View>
              </View>

              <View style={styles.insightSection}>
                <Text style={styles.insightSectionTitle}>常见症状</Text>
                {insights.commonSymptoms.length ? (
                  <View style={styles.insightChips}>
                    {insights.commonSymptoms.map(([symptom, count]) => (
                      <View key={symptom} style={styles.insightChip}>
                        <Text style={styles.insightChipText}>{symptom} · {count}</Text>
                      </View>
                    ))}
                  </View>
                ) : (
                  <Text style={styles.emptyText}>再多记几天，这里会慢慢有规律。</Text>
                )}
              </View>

              <View style={styles.insightSection}>
                <Text style={styles.insightSectionTitle}>疼痛节奏</Text>
                {insights.peakPain ? (
                  <Text style={styles.insightSentence}>
                    目前看起来，第 {insights.peakPain.day} 天最容易疼得明显一些，平均 {insights.peakPain.averagePain.toFixed(1)}/5。
                  </Text>
                ) : (
                  <Text style={styles.emptyText}>还没有足够的疼痛记录。</Text>
                )}
              </View>

              <View style={styles.insightSection}>
                <Text style={styles.insightSectionTitle}>记录长度</Text>
                <Text style={styles.insightSentence}>
                  已经收下 {insights.totalLoggedDays} 天身体记录。等样本再多一点，趋势会更像你自己的节奏。
                </Text>
              </View>
            </View>
          )}
        </ScrollView>
            </View> : null}
            {visitedFeatures.current.has('theater') ? <View style={featureStyle('theater')}>
              <TheaterFeature controller={theater} active={activeFeature === 'theater'} onOpenFeatureDrawer={() => setFeatureDrawerVisible(true)} />
            </View> : null}
            {visitedFeatures.current.has('shiying') ? <View style={featureStyle('shiying')}>
              <ShiyingFeature
                openRequest={shiyingOpenRequest}
                onOpenRequestConsumed={onShiyingOpenRequestConsumed}
                active={activeFeature === 'shiying'}
                backgroundReadability={backgroundReadability}
                onOpenFeatureDrawer={() => setFeatureDrawerVisible(true)}
              />
            </View> : null}
            {visitedFeatures.current.has('anniversary') ? <View style={featureStyle('anniversary')}>
              <RelationshipDatesFeature onOpenFeatureDrawer={() => setFeatureDrawerVisible(true)} />
            </View> : null}
            {visitedFeatures.current.has('phone') ? <View style={featureStyle('phone')}>
              <PhoneRestrictionFeature active={activeFeature === 'phone'} backgroundReadability={backgroundReadability}
                navigate={navigate} onOpenFeatureDrawer={() => setFeatureDrawerVisible(true)} />
            </View> : null}
          </View>
          <Modal
            animationType="fade"
            onRequestClose={() => setFeatureDrawerVisible(false)}
            transparent
            visible={featureDrawerVisible}
          >
            <View style={styles.featureDrawerOverlay}>
              <Pressable style={styles.featureDrawerBackdrop} onPress={() => setFeatureDrawerVisible(false)} />
              <View style={[styles.featureDrawerPanel, { paddingTop: Math.max(46, insets.top + 12) }]}>
                <ScrollView contentContainerStyle={{ paddingBottom: Math.max(24, insets.bottom + 12) }}>
                <Text style={styles.featureDrawerTitle}>功能</Text>
                <View style={styles.featureDrawerQuickNav}>
                  <Pressable
                    onPress={() => {
                      setFeatureDrawerVisible(false);
                      navigate('home');
                    }}
                    style={styles.featureDrawerQuickNavButton}
                  >
                    <Text style={styles.featureDrawerQuickNavIcon}>⌂</Text>
                    <Text style={styles.featureDrawerQuickNavText}>首页</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => {
                      setFeatureDrawerVisible(false);
                      navigate('chat');
                    }}
                    style={styles.featureDrawerQuickNavButton}
                  >
                    <Text style={styles.featureDrawerQuickNavIcon}>◌</Text>
                    <Text style={styles.featureDrawerQuickNavText}>聊天</Text>
                  </Pressable>
                </View>
                <Text style={styles.featureDrawerSection}>与你功能</Text>
                <Pressable
                  onPress={() => {
                    setActiveFeature('body');
                    setFeatureDrawerVisible(false);
                  }}
                  style={[styles.featureDrawerItem, activeFeature === 'body' && styles.featureDrawerItemActive]}
                >
                  <Text style={[styles.featureDrawerItemTitle, activeFeature === 'body' && styles.featureDrawerItemTextActive]}>
                    身体数据
                  </Text>
                  <Text style={styles.featureDrawerItemMeta}>心率、活动、睡眠和个人参考</Text>
                  <Text style={styles.featureDrawerArrow}>›</Text>
                </Pressable>
                <Pressable
                  onPress={() => { setActiveFeature('diary'); setFeatureDrawerVisible(false); }}
                  style={[styles.featureDrawerItem, activeFeature === 'diary' && styles.featureDrawerItemActive]}
                >
                  <Text style={[styles.featureDrawerItemTitle, activeFeature === 'diary' && styles.featureDrawerItemTextActive]}>身体日记</Text>
                  <Text style={styles.featureDrawerItemMeta}>经期、今日记录、日历和洞察</Text>
                  <Text style={styles.featureDrawerArrow}>›</Text>
                </Pressable>
                <Pressable
                  onPress={() => {
                    setActiveFeature('theater');
                    setFeatureDrawerVisible(false);
                  }}
                  style={[styles.featureDrawerItem, activeFeature === 'theater' && styles.featureDrawerItemActive]}
                >
                  <Text style={[styles.featureDrawerItemTitle, activeFeature === 'theater' && styles.featureDrawerItemTextActive]}>
                    小剧场
                  </Text>
                  <Text style={styles.featureDrawerItemMeta}>设定、对话和历史</Text>
                  <Text style={styles.featureDrawerArrow}>›</Text>
                </Pressable>
                <Pressable
                  onPress={() => {
                    setActiveFeature('shiying');
                    setFeatureDrawerVisible(false);
                  }}
                  style={[styles.featureDrawerItem, activeFeature === 'shiying' && styles.featureDrawerItemActive]}
                >
                  <Text style={[styles.featureDrawerItemTitle, activeFeature === 'shiying' && styles.featureDrawerItemTextActive]}>
                    拾荧
                  </Text>
                  <Text style={styles.featureDrawerItemMeta}>手动拾取和荧迹</Text>
                  <Text style={styles.featureDrawerArrow}>›</Text>
                </Pressable>
                <Pressable
                  onPress={() => {
                    setActiveFeature('anniversary');
                    setFeatureDrawerVisible(false);
                  }}
                  style={[styles.featureDrawerItem, activeFeature === 'anniversary' && styles.featureDrawerItemActive]}
                >
                  <Text style={[styles.featureDrawerItemTitle, activeFeature === 'anniversary' && styles.featureDrawerItemTextActive]}>
                    纪念日
                  </Text>
                  <Text style={styles.featureDrawerItemMeta}>记录对我们重要的日子</Text>
                  <Text style={styles.featureDrawerArrow}>›</Text>
                </Pressable>
                <Pressable onPress={() => { setActiveFeature('phone'); setFeatureDrawerVisible(false); }}
                  style={[styles.featureDrawerItem, activeFeature === 'phone' && styles.featureDrawerItemActive]}>
                  <Text style={[styles.featureDrawerItemTitle, activeFeature === 'phone' && styles.featureDrawerItemTextActive]}>交出手机</Text>
                  <Text style={styles.featureDrawerItemMeta}>手机使用与限制</Text>
                  <Text style={styles.featureDrawerArrow}>›</Text>
                </Pressable>
                </ScrollView>
              </View>
            </View>
          </Modal>
        </View>
      </KeyboardAvoidingView>
    </BackgroundSurface>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  workbench: {
    flex: 1,
  },
  featureContent: {
    flex: 1,
  },
  featureDrawerOverlay: {
    backgroundColor: 'rgba(31, 34, 44, 0.22)',
    flex: 1,
  },
  featureDrawerBackdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  featureDrawerPanel: {
    backgroundColor: '#F5F7FF',
    bottom: 0,
    elevation: 10,
    left: 0,
    maxWidth: 360,
    paddingHorizontal: 16,
    position: 'absolute',
    shadowColor: '#2F3852',
    shadowOpacity: 0.16,
    shadowRadius: 18,
    top: 0,
    width: '76%',
  },
  featureDrawerTitle: {
    color: colors.ink,
    fontSize: 25,
    fontWeight: '600',
    marginBottom: 14,
  },
  featureDrawerQuickNav: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 18,
  },
  featureDrawerQuickNavButton: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderColor: '#DEE7F6',
    borderRadius: 15,
    borderWidth: 1,
    flex: 1,
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'center',
    minHeight: 50,
    paddingHorizontal: 8,
  },
  featureDrawerQuickNavIcon: {
    color: '#6B8BAA',
    fontSize: 21,
    fontWeight: '500',
  },
  featureDrawerQuickNavText: {
    color: colors.ink,
    fontSize: 15,
    fontWeight: '500',
  },
  featureDrawerSection: {
    color: colors.ink,
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 8,
    marginTop: 8,
  },
  featureDrawerItem: {
    backgroundColor: '#FFFFFF',
    borderColor: '#DEE7F6',
    borderRadius: 16,
    borderWidth: 1,
    marginBottom: 10,
    minHeight: 68,
    padding: 12,
    paddingRight: 30,
  },
  featureDrawerItemActive: {
    backgroundColor: '#FFF4F1',
    borderColor: 'rgba(244,139,132,0.45)',
  },
  featureDrawerItemTitle: {
    color: colors.ink,
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 4,
  },
  featureDrawerItemTextActive: {
    color: colors.primary,
  },
  featureDrawerItemMeta: {
    color: colors.muted,
    fontSize: 12,
    lineHeight: 17,
  },
  featureDrawerArrow: {
    color: colors.muted,
    fontSize: 20,
    position: 'absolute',
    right: 12,
    top: 25,
  },
  content: {
    paddingHorizontal: 20,
    rowGap: 14,
  },
  header: {
    flexDirection: 'row',
    gap: 14,
  },
  backButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.72)',
    borderColor: colors.border,
    borderRadius: 8,
    borderWidth: 1,
    height: 38,
    justifyContent: 'center',
    minWidth: 58,
  },
  backButtonText: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '600',
  },
  menuText: {
    color: colors.ink,
    fontSize: 26,
    fontWeight: '600',
    lineHeight: 28,
  },
  headerCopy: {
    flex: 1,
  },
  kicker: {
    color: colors.primary,
    fontSize: 13,
    fontWeight: '600',
  },
  title: {
    color: colors.ink,
    fontSize: 24,
    fontWeight: '700',
    letterSpacing: 0,
    marginTop: 2,
  },
  statusPanel: {
    backgroundColor: 'rgba(255,247,239,0.86)',
    borderColor: colors.border,
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 14,
    padding: 16,
  },
  statusTextBlock: {
    flex: 1,
  },
  statusLabel: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '600',
  },
  statusTitle: {
    color: colors.ink,
    fontSize: 20,
    fontWeight: '700',
    letterSpacing: 0,
    marginTop: 4,
  },
  statusDetail: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 5,
  },
  primaryButton: {
    alignItems: 'center',
    alignSelf: 'center',
    backgroundColor: colors.primary,
    borderRadius: 8,
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: 14,
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
  secondaryButton: {
    backgroundColor: '#FFFFFF',
    borderColor: colors.primary,
    borderWidth: 1,
  },
  secondaryButtonText: {
    color: colors.primary,
  },
  statusButtons: {
    alignItems: 'center',
    alignSelf: 'center',
    gap: 7,
  },
  periodEditShortcut: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 30,
    paddingHorizontal: 8,
  },
  periodEditShortcutText: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '600',
  },
  tabBar: {
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.58)',
    borderColor: colors.border,
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 6,
    padding: 4,
  },
  tabButton: {
    alignItems: 'center',
    borderRadius: 7,
    flex: 1,
    justifyContent: 'center',
    minHeight: 38,
  },
  tabButtonSelected: {
    backgroundColor: 'rgba(255,255,255,0.86)',
  },
  tabText: {
    color: colors.muted,
    fontSize: 14,
    fontWeight: '500',
  },
  tabTextSelected: {
    color: colors.ink,
    fontWeight: '700',
  },
  panel: {
    backgroundColor: colors.cardStrong,
    borderColor: colors.border,
    borderRadius: 8,
    borderWidth: 1,
    padding: 16,
  },
  sectionHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 14,
    gap: 12,
  },
  sectionTitleBlock: {
    flex: 1,
  },
  recentRecordsHeader: {
    minHeight: 44,
    marginBottom: 0,
  },
  sectionTitle: {
    color: colors.ink,
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: 0,
  },
  sectionMeta: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '500',
    textAlign: 'right',
  },
  recordSummary: {
    color: colors.muted,
    fontSize: 12,
    lineHeight: 18,
    marginTop: 5,
  },
  fieldLabel: {
    color: colors.ink,
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 8,
    marginTop: 6,
  },
  segmentRow: {
    flexDirection: 'row',
    gap: 7,
    marginBottom: 10,
  },
  segment: {
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.74)',
    borderColor: 'rgba(255,161,138,0.24)',
    borderRadius: 8,
    borderWidth: 1,
    flex: 1,
    minHeight: 38,
    justifyContent: 'center',
  },
  segmentSelected: {
    backgroundColor: 'rgba(255,161,138,0.22)',
    borderColor: colors.primary,
  },
  segmentText: {
    color: colors.muted,
    fontSize: 13,
    fontWeight: '500',
  },
  segmentTextSelected: {
    color: colors.ink,
    fontWeight: '700',
  },
  painScale: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 10,
  },
  painChip: {
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.74)',
    borderColor: 'rgba(56,64,82,0.1)',
    borderRadius: 8,
    borderWidth: 1,
    flexBasis: '30%',
    flexGrow: 1,
    minHeight: 62,
    justifyContent: 'center',
    paddingHorizontal: 8,
    paddingVertical: 8,
  },
  painChipSelected: {
    backgroundColor: 'rgba(255,161,138,0.2)',
    borderColor: colors.primary,
  },
  painEmoji: {
    fontSize: 21,
    lineHeight: 25,
  },
  painLabel: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '500',
    marginTop: 3,
  },
  painLabelSelected: {
    color: colors.ink,
  },
  chipWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 10,
  },
  chip: {
    backgroundColor: 'rgba(255,255,255,0.72)',
    borderColor: 'rgba(56,64,82,0.1)',
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  chipSelected: {
    backgroundColor: 'rgba(203,244,236,0.8)',
    borderColor: '#8FD4D1',
  },
  customChip: {
    backgroundColor: 'rgba(255,161,138,0.16)',
    borderColor: 'rgba(255,161,138,0.55)',
  },
  chipText: {
    color: colors.muted,
    fontSize: 13,
    fontWeight: '500',
  },
  chipTextSelected: {
    color: colors.ink,
    fontWeight: '700',
  },
  customSymptomRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    marginBottom: 10,
  },
  customSymptomInput: {
    backgroundColor: 'rgba(255,255,255,0.78)',
    borderColor: 'rgba(56,64,82,0.12)',
    borderRadius: 8,
    borderWidth: 1,
    color: colors.ink,
    flex: 1,
    fontSize: 14,
    minHeight: 42,
    paddingHorizontal: 12,
  },
  addSymptomButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(178,217,255,0.38)',
    borderRadius: 8,
    justifyContent: 'center',
    minHeight: 42,
    paddingHorizontal: 14,
  },
  addSymptomText: {
    color: colors.ink,
    fontSize: 13,
    fontWeight: '700',
  },
  noteInput: {
    backgroundColor: 'rgba(255,255,255,0.78)',
    borderColor: 'rgba(56,64,82,0.12)',
    borderRadius: 8,
    borderWidth: 1,
    color: colors.ink,
    fontSize: 14,
    minHeight: 88,
    padding: 12,
    textAlignVertical: 'top',
  },
  observationTimeInput: {
    backgroundColor: 'rgba(255,255,255,0.78)',
    borderColor: 'rgba(56,64,82,0.12)', borderRadius: 8, borderWidth: 1,
    color: colors.ink, fontSize: 14, minHeight: 44, paddingHorizontal: 12, marginBottom: 10,
  },
  uncertainActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 12,
  },
  statusActionButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.72)',
    borderColor: 'rgba(56,64,82,0.12)',
    borderRadius: 8,
    borderWidth: 1,
    minHeight: 40,
    paddingHorizontal: 12,
    justifyContent: 'center',
  },
  statusActionButtonSelected: {
    backgroundColor: 'rgba(255,161,138,0.2)',
    borderColor: colors.primary,
  },
  statusActionText: {
    color: colors.muted,
    fontSize: 13,
    fontWeight: '600',
  },
  statusActionTextSelected: {
    color: colors.ink,
  },
  returnTodayButton: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(255,255,255,0.72)',
    borderColor: 'rgba(56,64,82,0.12)',
    borderRadius: 8,
    borderWidth: 1,
    justifyContent: 'center',
    marginTop: 12,
    minHeight: 38,
    paddingHorizontal: 12,
  },
  returnTodayText: {
    color: colors.muted,
    fontSize: 13,
    fontWeight: '600',
  },
  saveButton: {
    alignItems: 'center',
    backgroundColor: colors.ink,
    borderRadius: 8,
    justifyContent: 'center',
    marginTop: 14,
    minHeight: 44,
  },
  saveButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
  dailyLogHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'space-between',
  },
  dailyLogItem: {
    borderTopColor: 'rgba(56,64,82,0.08)',
    borderTopWidth: 1,
    gap: 4,
    paddingVertical: 12,
  },
  dailyLogNote: {
    color: colors.ink,
    fontSize: 13,
    lineHeight: 19,
  },
  historyItem: {
    alignItems: 'center',
    borderTopColor: 'rgba(56,64,82,0.08)',
    borderTopWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 58,
  },
  historyTitle: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '600',
  },
  historyMeta: {
    color: colors.muted,
    fontSize: 12,
    marginTop: 3,
  },
  activeBadge: {
    backgroundColor: 'rgba(255,161,138,0.18)',
    borderRadius: 8,
    color: colors.primary,
    fontSize: 12,
    fontWeight: '600',
    overflow: 'hidden',
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  historyMoreButton: {
    alignItems: 'center',
    borderTopColor: 'rgba(56,64,82,0.08)',
    borderTopWidth: 1,
    justifyContent: 'center',
    minHeight: 44,
  },
  historyMoreText: {
    color: colors.primary,
    fontSize: 13,
    fontWeight: '700',
  },
  reminderRow: {
    alignItems: 'center',
    borderBottomColor: 'rgba(56,64,82,0.08)',
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: 12,
    minHeight: 64,
    paddingVertical: 8,
  },
  reminderRowLast: {
    borderBottomWidth: 0,
  },
  reminderCopy: {
    flex: 1,
  },
  reminderTitle: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '600',
    lineHeight: 20,
  },
  reminderText: {
    color: colors.muted,
    fontSize: 12,
    lineHeight: 18,
    marginTop: 2,
  },
  periodCalendar: {
    backgroundColor: 'transparent',
    borderRadius: 8,
    overflow: 'hidden',
  },
  calendarLegend: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    marginTop: 12,
  },
  legendItem: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
  },
  legendDot: {
    borderRadius: 999,
    height: 10,
    width: 10,
  },
  legendActual: {
    backgroundColor: calendarMarkerColors.period,
  },
  legendUncertain: {
    backgroundColor: calendarMarkerColors.uncertain,
  },
  legendOther: {
    backgroundColor: calendarMarkerColors.normal,
  },
  legendPredicted: {
    backgroundColor: calendarMarkerColors.predictionFill,
  },
  legendText: {
    color: colors.muted,
    fontSize: 12,
  },
  dayDetail: {
    backgroundColor: 'rgba(255,247,239,0.72)',
    borderColor: 'rgba(255,161,138,0.22)',
    borderRadius: 8,
    borderWidth: 1,
    marginTop: 14,
    padding: 13,
  },
  dayDetailTitle: {
    color: colors.ink,
    fontSize: 15,
    fontWeight: '700',
  },
  dayDetailMeta: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 4,
  },
  dayLogBox: {
    gap: 5,
    marginTop: 10,
  },
  dayLogText: {
    color: colors.ink,
    fontSize: 13,
    lineHeight: 19,
  },
  dayLogNote: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 20,
    marginTop: 2,
  },
  dayEditButton: {
    alignItems: 'center',
    backgroundColor: colors.ink,
    borderRadius: 8,
    justifyContent: 'center',
    marginTop: 12,
    minHeight: 40,
    paddingHorizontal: 12,
  },
  dayPeriodEditButton: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderColor: calendarMarkerColors.period,
    borderRadius: 8,
    borderWidth: 1,
    justifyContent: 'center',
    marginTop: 12,
    minHeight: 40,
    paddingHorizontal: 12,
  },
  dayPeriodEditButtonText: {
    color: '#C95F5A',
    fontSize: 13,
    fontWeight: '700',
  },
  dayEditButtonText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
  },
  insightGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  insightCard: {
    backgroundColor: 'rgba(255,255,255,0.72)',
    borderColor: 'rgba(56,64,82,0.08)',
    borderRadius: 8,
    borderWidth: 1,
    flexBasis: '46%',
    flexGrow: 1,
    minHeight: 74,
    padding: 12,
  },
  insightLabel: {
    color: colors.muted,
    fontSize: 12,
    lineHeight: 17,
  },
  insightValue: {
    color: colors.ink,
    fontSize: 20,
    fontWeight: '700',
    marginTop: 5,
  },
  insightSection: {
    borderTopColor: 'rgba(56,64,82,0.08)',
    borderTopWidth: 1,
    marginTop: 14,
    paddingTop: 14,
  },
  insightSectionTitle: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 8,
  },
  insightChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  insightChip: {
    backgroundColor: 'rgba(203,244,236,0.62)',
    borderColor: 'rgba(143,212,209,0.55)',
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  insightChipText: {
    color: colors.ink,
    fontSize: 12,
    fontWeight: '600',
  },
  insightSentence: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 20,
  },
  emptyText: {
    color: colors.muted,
    fontSize: 14,
    lineHeight: 21,
  },
});
