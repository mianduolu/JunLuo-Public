import { useEffect, useMemo, useRef, useState } from 'react';
import { Image, Modal, Pressable, ScrollView, StyleSheet, Vibration, View } from 'react-native';
import { Calendar, type DateData } from 'react-native-calendars';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppText as Text, AppTextInput as TextInput } from './AppText';
import { homeImages } from '../assets/homeImages';
import { colors } from '../theme/colors';
import { dateKey, formatLunarDate, formatRecurrenceLabel, buildRecurrenceRule } from '../schedule/calendarRules';
import {
  addMinutesToClock,
  combineDateTime,
  minutesBetweenClocks,
  normalizeClock,
  reminderChoiceLabels,
  reminderMinutesFromSelection,
  selectionFromReminderMinutes,
  type DateTimeSelection,
  type ReminderChoice,
} from '../schedule/dateTimeSelection';
import type { ScheduleRecurrence, ScheduleReminderIntensity } from '../schedule/scheduleStore';

type SheetMode = 'date' | 'range';
type DetailMode = 'main' | 'startTime' | 'endTime' | 'estimate' | 'reminder' | 'reminderClock' | 'recurrence';

type Props = {
  dateOnly?: boolean;
  timeOnly?: boolean;
  timeOnlyDates?: ReadonlyArray<{ date: string; label: string }>;
  timeOnlyTarget?: 'start' | 'end';
  onClose: () => void;
  onConfirm: (selection: DateTimeSelection | null) => void;
  title?: string;
  value: DateTimeSelection;
  visible: boolean;
};

const recurrenceOptions: ScheduleRecurrence[] = ['none', 'daily', 'weekdays', 'legalWorkday', 'weekly', 'monthly', 'yearly', 'lunarYearly'];
const reminderOptions: ReminderChoice[] = ['none', 'sameDay', 'oneDay', 'twoDays', 'threeDays', 'oneWeek'];
const durationHours = ['00', '01', '02', '03', '04'];
const durationMinutes = ['00', '05', '10', '15', '20', '25', '30', '45'];
const reminderHours = Array.from({ length: 25 }, (_, index) => String(index).padStart(2, '0'));
const reminderLeadMinutes = ['00', '05', '10', '15', '20', '25', '30', '45'];
const WHEEL_ITEM_STEP = 52;
const intensityLabels: Record<ScheduleReminderIntensity, string> = {
  gentle: '温柔提醒',
  strong: '强力督促',
  blast: '轰炸叫醒',
};

function addDays(date: Date, amount: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return next;
}

function formatShortDate(key?: string) {
  if (!key) return '请选择';
  const date = new Date(`${key}T00:00:00`);
  return `${String(date.getMonth() + 1).padStart(2, '0')}月${String(date.getDate()).padStart(2, '0')}日 周${['日', '一', '二', '三', '四', '五', '六'][date.getDay()]}`;
}

function rangeDays(start?: string, end?: string) {
  if (!start || !end) return 0;
  const startAt = new Date(`${start}T00:00:00`).getTime();
  const endAt = new Date(`${end}T00:00:00`).getTime();
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt < startAt) return 0;
  return Math.round((endAt - startAt) / (24 * 60 * 60 * 1000)) + 1;
}

export function DateTimePickerSheet({ dateOnly = false, timeOnly = false, timeOnlyDates, timeOnlyTarget = 'start', onClose, onConfirm, title = '日期和时间', value, visible }: Props) {
  const insets = useSafeAreaInsets();
  const [selection, setSelection] = useState<DateTimeSelection>(value);
  const [mode, setMode] = useState<SheetMode>(value.endDate ? 'range' : 'date');
  const [detailMode, setDetailMode] = useState<DetailMode>('main');
  const [clearFeedback, setClearFeedback] = useState('');
  const estimatedEndMinutes = useRef<number | undefined>(undefined);
  const currentMonth = selection.date;
  const hours = useMemo(() => Array.from({ length: 24 }, (_, index) => String(index).padStart(2, '0')), []);
  const minutes = useMemo(() => Array.from({ length: 12 }, (_, index) => String(index * 5).padStart(2, '0')), []);
  const rule = useMemo(() => buildRecurrenceRule(selection.recurrence, new Date(`${selection.date}T${selection.time ?? '09:00'}:00`).getTime()), [selection.date, selection.recurrence, selection.time]);
  const days = rangeDays(selection.date, selection.endDate);
  const canConfirm = (mode === 'date' || days > 0)
    && (!timeOnly || !timeOnlyDates || timeOnlyDates.some(item => item.date === selection.date));
  const isWheelDetail = detailMode === 'startTime' || detailMode === 'endTime' || detailMode === 'reminderClock';
  const selectedReminderMinutes = Math.max(0, Math.round(reminderMinutesFromSelection(selection) || selection.defaultReminderMinutes || 0));
  const reminderLabel = (() => {
    if (selection.reminderChoice !== 'none' && selection.reminderChoice !== 'sameDay') {
      return `${reminderChoiceLabels[selection.reminderChoice]} ${selection.reminderClock}`;
    }
    if (selection.time && selectedReminderMinutes > 0) return `提前${selectedReminderMinutes}分钟`;
    return '无';
  })();

  useEffect(() => {
    if (!visible) return;
    setSelection(value);
    setMode(value.endDate ? 'range' : 'date');
    setDetailMode(timeOnly ? (timeOnlyTarget === 'end' ? 'endTime' : 'startTime') : 'main');
    setClearFeedback('');
    estimatedEndMinutes.current = value.endTimeDate !== undefined && !value.endTime ? value.estimateMinutes : undefined;
  }, [timeOnly, timeOnlyTarget, visible]);

  useEffect(() => {
    if (!clearFeedback) return undefined;
    const timer = setTimeout(() => setClearFeedback(''), 900);
    return () => clearTimeout(timer);
  }, [clearFeedback]);

  const pulseClearFeedback = (message: string) => {
    Vibration.vibrate(12);
    setClearFeedback(message);
  };

  const setTime = (time?: string) => {
    const estimatedMinutes = estimatedEndMinutes.current;
    setSelection((current) => {
      const normalized = time ? normalizeClock(time) : undefined;
      const currentReminderMinutes = Math.max(0, Math.round(reminderMinutesFromSelection(current) || current.defaultReminderMinutes || 0));
      const reminder = normalized && currentReminderMinutes > 0
        ? selectionFromReminderMinutes(current.date, normalized, currentReminderMinutes)
        : { reminderChoice: current.reminderChoice, reminderClock: current.reminderClock };
      const next: DateTimeSelection = { ...current, ...reminder, defaultReminderMinutes: currentReminderMinutes || undefined, time: normalized };
      if (normalized && current.endTimeDate !== undefined && estimatedMinutes && estimatedMinutes > 0) {
        const endAt = combineDateTime(current.date, normalized) + estimatedMinutes * 60000;
        next.endTime = addMinutesToClock(current.date, normalized, estimatedMinutes);
        next.endTimeDate = dateKey(endAt);
        next.estimateMinutes = estimatedMinutes;
      } else if (normalized && current.estimateMinutes && !current.endTime) {
        next.endTime = addMinutesToClock(current.date, normalized, current.estimateMinutes);
        if (current.endTimeDate !== undefined) {
          next.endTimeDate = dateKey(combineDateTime(current.date, normalized) + current.estimateMinutes * 60000);
        }
      } else if (normalized && current.endTime && current.endTimeDate !== undefined) {
        const minutes = Math.round((combineDateTime(current.endTimeDate, current.endTime) - combineDateTime(current.date, normalized)) / 60000);
        next.estimateMinutes = minutes > 0 ? minutes : undefined;
      }
      return next;
    });
  };

  const setEndTime = (endTime?: string) => {
    estimatedEndMinutes.current = undefined;
    setSelection((current) => {
      const normalized = endTime ? normalizeClock(endTime) : undefined;
      if (current.endTimeDate !== undefined) {
        const minutes = normalized && current.time
          ? Math.round((combineDateTime(current.endTimeDate, normalized) - combineDateTime(current.date, current.time)) / 60000) : undefined;
        return { ...current, endTime: normalized, estimateMinutes: minutes && minutes > 0 ? minutes : undefined };
      }
      const estimateMinutes = minutesBetweenClocks(current.date, current.time, normalized);
      return { ...current, endTime: normalized, estimateMinutes: estimateMinutes ?? current.estimateMinutes };
    });
  };

  const applyEstimateMinutes = (minutesValue: number | undefined) => {
    if (selection.endTimeDate !== undefined) estimatedEndMinutes.current = minutesValue;
    setSelection((current) => {
      const next = { ...current, estimateMinutes: minutesValue,
        endTime: current.time && minutesValue && minutesValue > 0 ? addMinutesToClock(current.date, current.time, minutesValue) : current.endTime };
      if (current.endTimeDate !== undefined && current.time && minutesValue && minutesValue > 0) {
        next.endTimeDate = dateKey(combineDateTime(current.date, current.time) + minutesValue * 60000);
      }
      return next;
    });
  };

  const applyReminderLeadMinutes = (minutesValue: number | undefined) => {
    const cleanMinutes = Math.max(0, Math.round(minutesValue ?? 0));
    setSelection((current) => ({
      ...current,
      ...selectionFromReminderMinutes(current.date, current.time, cleanMinutes),
      defaultReminderMinutes: cleanMinutes > 0 ? cleanMinutes : undefined,
    }));
  };

  const applyReminderChoice = (choice: ReminderChoice) => {
    setSelection((current) => {
      if (choice === 'none') {
        return { ...current, defaultReminderMinutes: undefined, reminderChoice: 'none' };
      }
      return {
        ...current,
        defaultReminderMinutes: undefined,
        reminderChoice: choice,
      };
    });
  };

  const clearCurrentSelection = () => {
    if (detailMode === 'startTime') {
      setSelection((current) => ({ ...current, time: undefined, reminderChoice: 'none' }));
      pulseClearFeedback('已清除开始时刻');
      return;
    }
    if (detailMode === 'endTime') {
      estimatedEndMinutes.current = undefined;
      setSelection((current) => ({ ...current, endTime: undefined, estimateMinutes: undefined,
        ...(current.endTimeDate !== undefined ? { endTimeDate: current.date } : {}) }));
      pulseClearFeedback('已清除结束时刻');
      return;
    }
    if (detailMode === 'estimate') {
      estimatedEndMinutes.current = undefined;
      setSelection((current) => ({ ...current, estimateMinutes: undefined }));
      pulseClearFeedback('已清除估时');
      return;
    }
    if (detailMode === 'reminder' || detailMode === 'reminderClock') {
      setSelection((current) => ({ ...current, defaultReminderMinutes: undefined, reminderChoice: 'none' }));
      pulseClearFeedback('已清除提醒');
      return;
    }
    onConfirm(null);
  };

  const clearLabel = dateOnly
    ? '清除日期'
    : timeOnly && timeOnlyTarget === 'end'
      ? '清除结束'
    : detailMode === 'startTime'
      ? '清除开始'
      : detailMode === 'endTime'
        ? '清除结束'
        : detailMode === 'estimate'
          ? '清除估时'
          : detailMode === 'reminder' || detailMode === 'reminderClock'
            ? '清除提醒'
            : '清除时间';

  const renderDurationWheel = () => {
    const totalMinutes = Math.min(4 * 60 + 45, Math.max(0, selection.estimateMinutes ?? 60));
    const selectedHour = String(Math.floor(totalMinutes / 60)).padStart(2, '0');
    const selectedMinuteValue = totalMinutes % 60;
    const selectedMinute = durationMinutes.includes(String(selectedMinuteValue).padStart(2, '0'))
      ? String(selectedMinuteValue).padStart(2, '0')
      : durationMinutes.reduce((closest, item) => {
        const currentDistance = Math.abs(Number(item) - selectedMinuteValue);
        const closestDistance = Math.abs(Number(closest) - selectedMinuteValue);
        return currentDistance < closestDistance ? item : closest;
      }, durationMinutes[0]);
    const update = (hour: string, minute: string) => {
      const nextMinutes = Number(hour) * 60 + Number(minute);
      applyEstimateMinutes(nextMinutes > 0 ? nextMinutes : undefined);
    };
    return (
      <View style={styles.clockPicker}>
        <WheelColumn values={durationHours} value={selectedHour} onPick={(nextHour) => update(nextHour, selectedMinute)} />
        <Text style={styles.clockColon}>:</Text>
        <WheelColumn values={durationMinutes} value={selectedMinute} onPick={(nextMinute) => update(selectedHour, nextMinute)} />
      </View>
    );
  };

  const renderReminderLeadWheel = () => {
    const totalMinutes = Math.min(24 * 60, Math.max(0, selectedReminderMinutes || 5));
    const selectedHour = String(Math.floor(totalMinutes / 60)).padStart(2, '0');
    const selectedMinuteValue = totalMinutes % 60;
    const selectedMinute = reminderLeadMinutes.includes(String(selectedMinuteValue).padStart(2, '0'))
      ? String(selectedMinuteValue).padStart(2, '0')
      : reminderLeadMinutes.reduce((closest, item) => {
        const currentDistance = Math.abs(Number(item) - selectedMinuteValue);
        const closestDistance = Math.abs(Number(closest) - selectedMinuteValue);
        return currentDistance < closestDistance ? item : closest;
      }, reminderLeadMinutes[0]);
    const update = (hour: string, minute: string) => {
      applyReminderLeadMinutes(Number(hour) * 60 + Number(minute));
    };
    return (
      <View style={styles.clockPicker}>
        <WheelColumn values={reminderHours} value={selectedHour} onPick={(nextHour) => update(nextHour, selectedMinute)} />
        <Text style={styles.clockColon}>:</Text>
        <WheelColumn values={reminderLeadMinutes} value={selectedMinute} onPick={(nextMinute) => update(selectedHour, nextMinute)} />
      </View>
    );
  };

  const pickDay = (day: DateData) => {
    setSelection((current) => {
      if (mode === 'range' && day.dateString >= current.date) return { ...current, endDate: day.dateString };
      const next = { ...current, date: day.dateString, ...(mode === 'range' ? { endDate: undefined } : {}) };
      if (current.endTimeDate !== undefined) {
        const days = Math.round((new Date(`${day.dateString}T12:00:00`).getTime() - new Date(`${current.date}T12:00:00`).getTime()) / 86400000);
        next.endTimeDate = dateKey(addDays(new Date(`${current.endTimeDate}T12:00:00`), days));
        if (estimatedEndMinutes.current && current.time) {
          const endAt = combineDateTime(day.dateString, current.time) + estimatedEndMinutes.current * 60000;
          next.endTimeDate = dateKey(endAt);
          next.endTime = addMinutesToClock(day.dateString, current.time, estimatedEndMinutes.current);
        } else if (current.estimateMinutes !== undefined && current.time && current.endTime) {
          const minutes = Math.round((combineDateTime(next.endTimeDate, current.endTime) - combineDateTime(day.dateString, current.time)) / 60000);
          next.estimateMinutes = minutes > 0 ? minutes : undefined;
        }
      }
      return next;
    });
  };

  const markedDates = useMemo(() => {
    const marks: Record<string, { selected?: boolean; selectedColor?: string; startingDay?: boolean; endingDay?: boolean; color?: string; textColor?: string }> = {};
    if (mode === 'range' && selection.endDate) {
      for (let cursor = new Date(`${selection.date}T00:00:00`); dateKey(cursor) <= selection.endDate; cursor = addDays(cursor, 1)) {
        const key = dateKey(cursor);
        marks[key] = { color: '#EDEBFF', textColor: '#343149', startingDay: key === selection.date, endingDay: key === selection.endDate };
      }
    }
    marks[selection.date] = { ...(marks[selection.date] ?? {}), selected: true, selectedColor: '#7069C8' };
    if (selection.endDate) marks[selection.endDate] = { ...(marks[selection.endDate] ?? {}), selected: true, selectedColor: '#7069C8' };
    return marks;
  }, [mode, selection.date, selection.endDate]);

  const renderClockWheel = (kind: 'start' | 'end' | 'reminder') => {
    const clock = kind === 'start'
      ? (selection.time ?? '09:00')
      : kind === 'reminder'
        ? selection.reminderClock
        : (selection.endTime ?? addMinutesToClock(selection.date, selection.time ?? '09:00', selection.estimateMinutes ?? 60) ?? '10:00');
    const [hour, minute] = clock.split(':');
    const update = (nextHour: string, nextMinute: string) => {
      const next = `${nextHour}:${nextMinute}`;
      if (kind === 'start') setTime(next);
      else if (kind === 'reminder') setSelection((current) => ({ ...current, reminderClock: next }));
      else setEndTime(next);
    };
    return (
      <View style={styles.clockPicker}>
        <WheelColumn values={hours} value={hour} onPick={(nextHour) => update(nextHour, minute)} />
        <Text style={styles.clockColon}>:</Text>
        <WheelColumn values={minutes} value={minute} onPick={(nextMinute) => update(hour, nextMinute)} />
      </View>
    );
  };

  const renderMain = () => (
    <>
      <Calendar
        current={currentMonth}
        dayComponent={({ date }) => {
          if (!date) return null;
          const key = date.dateString;
          const selected = key === selection.date || key === selection.endDate;
          const today = key === dateKey(new Date());
          return (
            <Pressable onPress={() => pickDay(date)} style={[styles.dayCell, selected && styles.dayCellSelected, today && !selected && styles.dayCellToday]}>
              <Text style={[styles.dayNumber, selected && styles.dayNumberSelected]}>{date.day}</Text>
              <Text numberOfLines={1} style={[styles.lunarText, selected && styles.dayNumberSelected]}>{formatLunarDate(new Date(`${key}T00:00:00`))}</Text>
            </Pressable>
          );
        }}
        markedDates={markedDates}
        markingType={mode === 'range' ? 'period' : undefined}
        onDayPress={pickDay}
        theme={{ calendarBackground: '#FFFFFF', monthTextColor: '#11131D', textMonthFontSize: 26, textMonthFontWeight: '500', arrowColor: '#11131D' }}
      />
      {mode === 'range' ? (
        <View style={styles.rangeSummary}>
          <View>
            <Text style={styles.summaryLabel}>开始日期</Text>
            <Text style={styles.summaryValue}>{formatShortDate(selection.date)}</Text>
          </View>
          <View>
            <Text style={styles.summaryLabel}>结束日期</Text>
            <Text style={styles.summaryValue}>{selection.endDate ? formatShortDate(selection.endDate) : '请选择结束日期'}</Text>
          </View>
        </View>
      ) : null}
      {!dateOnly ? (
        <>
          <PickerRow icon="◷" label="时刻" value={selection.time ?? '无'} onPress={() => setDetailMode('startTime')} />
          <PickerRow icon="◉" label="结束时刻" value={selection.endTime ? `${selection.endTimeDate && selection.endTimeDate !== selection.date ? `${selection.endTimeDate} ` : ''}${selection.endTime}` : '无'} onPress={() => setDetailMode('endTime')} />
          <PickerRow icon="♢" label="估时" value={selection.estimateMinutes ? `${selection.estimateMinutes}分钟` : '无'} onPress={() => setDetailMode('estimate')} />
          <PickerRow icon="♧" label="提醒" value={reminderLabel} onPress={() => setDetailMode('reminder')} />
          <PickerRow icon="↻" label="重复" value={formatRecurrenceLabel(rule)} onPress={() => setDetailMode('recurrence')} />
        </>
      ) : null}
    </>
  );

  return (
    <Modal animationType="slide" transparent visible={visible} onRequestClose={onClose}>
      <View style={styles.overlay}>
        <Pressable style={styles.backdrop} onPress={onClose} />
        <View style={[styles.sheet, detailMode !== 'main' && styles.compactSheet, { paddingBottom: Math.max(insets.bottom + 14, 24) }]}>
          <Image resizeMode="contain" source={homeImages.mePortraitDefault} style={styles.peekPortrait} />
          <View style={styles.topRow}>
            <Pressable onPress={clearCurrentSelection} style={[styles.clearButton, clearFeedback ? styles.clearButtonFeedback : null]}>
              <Text style={[styles.clearText, clearFeedback ? styles.clearTextFeedback : null]}>{clearFeedback || clearLabel}</Text>
            </Pressable>
            <Text style={styles.sheetTitle}>{timeOnly ? title : detailMode === 'main' ? title : detailMode === 'startTime' ? '开始时刻' : detailMode === 'endTime' ? '结束时刻' : detailMode === 'estimate' ? '估时' : detailMode === 'reminder' ? '提醒' : detailMode === 'reminderClock' ? '提醒时刻' : '重复'}</Text>
            <Pressable onPress={onClose}><Text style={styles.closeText}>×</Text></Pressable>
          </View>
          {detailMode === 'main' && !dateOnly ? (
            <View style={styles.segment}>
              <Pressable onPress={() => setMode('date')} style={[styles.segmentItem, mode === 'date' && styles.segmentActive]}><Text style={[styles.segmentText, mode === 'date' && styles.segmentTextActive]}>日期</Text></Pressable>
              <Pressable onPress={() => setMode('range')} style={[styles.segmentItem, mode === 'range' && styles.segmentActive]}><Text style={[styles.segmentText, mode === 'range' && styles.segmentTextActive]}>时间段</Text></Pressable>
            </View>
          ) : null}
          <ScrollView contentContainerStyle={styles.content} scrollEnabled={!isWheelDetail} showsVerticalScrollIndicator={false}>
            {timeOnly && timeOnlyDates && <View style={styles.routineDateChoices}>
              {timeOnlyDates.map(item => <Pressable key={item.date} accessibilityRole="radio"
                accessibilityState={{ checked: selection.date === item.date }}
                onPress={() => setSelection(current => ({ ...current, date: item.date }))}
                style={[styles.routineDateChoice, selection.date === item.date && styles.routineDateChoiceSelected]}>
                <Text style={styles.routineDateLabel}>{item.label}</Text>
                <Text style={styles.routineDateValue}>{item.date}</Text>
              </Pressable>)}
            </View>}
            {detailMode === 'main' ? renderMain() : null}
            {detailMode === 'startTime' ? renderClockWheel('start') : null}
            {detailMode === 'reminderClock' ? renderClockWheel('reminder') : null}
            {detailMode === 'endTime' ? renderClockWheel('end') : null}
            {detailMode === 'estimate' ? (
              <>
                {renderDurationWheel()}
                <View style={styles.estimateBox}>
                  <Text style={styles.summaryLabel}>估时（分钟）</Text>
                  <TextInput
                    keyboardType="numeric"
                    onChangeText={(value) => {
                      const next = Number(value);
                      applyEstimateMinutes(Number.isFinite(next) && next > 0 ? Math.round(next) : undefined);
                    }}
                    placeholder="例如 60"
                    style={styles.estimateInput}
                    value={selection.estimateMinutes ? String(selection.estimateMinutes) : ''}
                  />
                </View>
              </>
            ) : null}
            {detailMode === 'reminder' ? (
              <>
                {renderReminderLeadWheel()}
                <View style={styles.estimateBox}>
                  <Text style={styles.summaryLabel}>提前提醒（分钟）</Text>
                  <TextInput
                    keyboardType="numeric"
                    onChangeText={(value) => {
                      const next = Number(value);
                      applyReminderLeadMinutes(Number.isFinite(next) && next > 0 ? next : undefined);
                    }}
                    placeholder="例如 5"
                    style={styles.estimateInput}
                    value={selectedReminderMinutes ? String(selectedReminderMinutes) : ''}
                  />
                  <Text style={styles.reminderHint}>
                    {selection.time ? `会在 ${selection.time} 前 ${selectedReminderMinutes || 0} 分钟提醒。` : '先选择开始时刻，提醒会按开始前多久计算。'}
                  </Text>
                </View>
                <View style={styles.optionGroup}>
                  <Text style={styles.optionGroupTitle}>按日期提前</Text>
                  {reminderOptions.map((option) => {
                    const selected = selection.reminderChoice === option && !(option === 'none' && selectedReminderMinutes > 0);
                    return (
                      <OptionRow
                        key={option}
                        selected={selected}
                        label={option === 'none' ? '无' : `${reminderChoiceLabels[option]}${option === 'sameDay' ? '' : ` · ${selection.reminderClock}`}`}
                        onPress={() => applyReminderChoice(option)}
                      />
                    );
                  })}
                  <PickerRow icon="◷" label="提醒时刻变更" value={selection.reminderClock} onPress={() => setDetailMode('reminderClock')} />
                </View>
                <View style={styles.intensityRow}>
                  {(['gentle', 'strong', 'blast'] as ScheduleReminderIntensity[]).map((intensity) => (
                    <Pressable key={intensity} onPress={() => setSelection((current) => ({ ...current, reminderIntensity: intensity }))} style={[styles.intensityChip, selection.reminderIntensity === intensity && styles.intensityChipActive]}>
                      <Text style={[styles.intensityText, selection.reminderIntensity === intensity && styles.intensityTextActive]}>{intensityLabels[intensity]}</Text>
                    </Pressable>
                  ))}
                </View>
              </>
            ) : null}
            {detailMode === 'recurrence' ? (
              <View style={styles.optionList}>
                {recurrenceOptions.map((option) => (
                  <OptionRow key={option} selected={selection.recurrence === option} label={formatRecurrenceLabel(buildRecurrenceRule(option, new Date(`${selection.date}T${selection.time ?? '09:00'}:00`).getTime()))} onPress={() => setSelection((current) => ({ ...current, recurrence: option }))} />
                ))}
              </View>
            ) : null}
          </ScrollView>
          <View style={styles.footer}>
            <Pressable onPress={() => detailMode === 'main' || timeOnly ? onClose() : setDetailMode('main')} style={styles.cancelButton}><Text style={styles.cancelText}>取消</Text></Pressable>
            <Pressable disabled={!canConfirm} onPress={() => detailMode === 'main' || timeOnly ? onConfirm(selection) : setDetailMode('main')} style={[styles.confirmButton, !canConfirm && styles.confirmDisabled]}>
              <Text style={styles.confirmText}>{detailMode === 'main' && mode === 'range' ? `确定${days}天` : '确定'}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function WheelColumn({ onPick, value, values }: { onPick: (value: string) => void; value: string; values: string[] }) {
  const scrollRef = useRef<ScrollView | null>(null);

  useEffect(() => {
    const index = values.indexOf(value);
    if (index < 0) return;
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ y: index * WHEEL_ITEM_STEP, animated: false });
    });
  }, [value, values]);

  return (
    <ScrollView ref={scrollRef} contentContainerStyle={styles.wheelColumn} nestedScrollEnabled showsVerticalScrollIndicator={false} style={styles.wheelScroll}>
      {values.map((item) => (
        <Pressable key={item} onPress={() => onPick(item)} style={[styles.wheelItem, item === value && styles.wheelItemActive]}>
          <Text style={[styles.wheelText, item === value && styles.wheelTextActive]}>{item}</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

function PickerRow({ icon, label, onPress, value }: { icon: string; label: string; onPress: () => void; value: string }) {
  return (
    <Pressable onPress={onPress} style={styles.pickerRow}>
      <Text style={styles.rowIcon}>{icon}</Text>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
      <Text style={styles.rowArrow}>›</Text>
    </Pressable>
  );
}

function OptionRow({ label, onPress, selected }: { label: string; onPress: () => void; selected: boolean }) {
  return (
    <Pressable onPress={onPress} style={styles.optionRow}>
      <Text style={[styles.radio, selected && styles.radioSelected]}>{selected ? '✓' : ''}</Text>
      <Text style={styles.optionLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  routineDateChoices: { flexDirection: 'row', gap: 10, marginBottom: 12 },
  routineDateChoice: { flex: 1, alignItems: 'center', paddingVertical: 10, borderRadius: 12, backgroundColor: '#F5FAFF', borderWidth: 1, borderColor: '#DEEAF5' },
  routineDateChoiceSelected: { backgroundColor: '#FFEDE0', borderColor: '#F7C4A3' },
  routineDateLabel: { color: '#4D607A', fontSize: 16 },
  routineDateValue: { color: '#6484AA', fontSize: 12, marginTop: 3 },
  overlay: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.56)' },
  sheet: { backgroundColor: '#FFFFFF', borderTopLeftRadius: 28, borderTopRightRadius: 28, maxHeight: '88%', paddingHorizontal: 22, paddingTop: 20 },
  compactSheet: { maxHeight: '62%', minHeight: 430 },
  peekPortrait: { height: 104, position: 'absolute', right: 42, top: -76, width: 128 },
  topRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', minHeight: 48 },
  clearButton: { borderRadius: 14, minWidth: 82, paddingHorizontal: 8, paddingVertical: 6 },
  clearButtonFeedback: { backgroundColor: '#F0EEFF' },
  clearText: { color: '#B96F73', fontSize: 18, fontWeight: '500' },
  clearTextFeedback: { color: '#7069C8', fontSize: 15 },
  closeText: { color: '#B96F73', fontSize: 32, fontWeight: '500', lineHeight: 34 },
  sheetTitle: { color: '#11131D', fontSize: 22, fontWeight: '600' },
  segment: { alignSelf: 'center', backgroundColor: '#F0EEFF', borderRadius: 20, flexDirection: 'row', marginVertical: 12, padding: 4 },
  segmentItem: { borderRadius: 16, minWidth: 118, paddingHorizontal: 20, paddingVertical: 9 },
  segmentActive: { backgroundColor: '#FFFFFF' },
  segmentText: { color: '#8B8995', fontSize: 18, fontWeight: '500', textAlign: 'center' },
  segmentTextActive: { color: '#7069C8' },
  content: { gap: 8, paddingBottom: 12 },
  dayCell: { alignItems: 'center', borderRadius: 24, height: 52, justifyContent: 'center', width: 52 },
  dayCellSelected: { backgroundColor: '#7069C8' },
  dayCellToday: { borderColor: '#7069C8', borderWidth: 1.5 },
  dayNumber: { color: '#11131D', fontSize: 18, fontWeight: '600', lineHeight: 22 },
  dayNumberSelected: { color: '#FFFFFF' },
  lunarText: { color: '#8F8D98', fontSize: 10, fontWeight: '400', maxWidth: 46 },
  rangeSummary: { backgroundColor: '#F8F7FC', borderRadius: 18, flexDirection: 'row', justifyContent: 'space-between', marginVertical: 10, padding: 16 },
  summaryLabel: { color: '#8F8D98', fontSize: 13, fontWeight: '400', marginBottom: 6 },
  summaryValue: { color: '#11131D', fontSize: 17, fontWeight: '500' },
  pickerRow: { alignItems: 'center', borderBottomColor: '#EFEFF4', borderBottomWidth: 1, flexDirection: 'row', minHeight: 62 },
  rowIcon: { color: '#C4C2DD', fontSize: 24, fontWeight: '500', width: 40 },
  rowLabel: { color: '#11131D', flex: 1, fontSize: 19, fontWeight: '500' },
  rowValue: { color: '#8F8D98', fontSize: 17, fontWeight: '400' },
  rowArrow: { color: '#C7C7CE', fontSize: 28, marginLeft: 8 },
  clockPicker: { alignItems: 'center', flexDirection: 'row', gap: 18, height: 260, justifyContent: 'center', marginTop: 8, overflow: 'hidden' },
  clockColon: { color: '#11131D', fontSize: 32, fontWeight: '500' },
  wheelScroll: { height: 246, width: 118 },
  wheelColumn: { gap: 8, paddingVertical: 90 },
  wheelItem: { alignItems: 'center', borderRadius: 16, height: 44, justifyContent: 'center', width: 110 },
  wheelItemActive: { backgroundColor: '#F0EEFF' },
  wheelText: { color: '#AAA8B4', fontSize: 22, fontWeight: '400' },
  wheelTextActive: { color: '#11131D', fontSize: 28, fontWeight: '500' },
  estimateBox: { backgroundColor: '#F8F7FC', borderRadius: 18, gap: 10, padding: 14 },
  estimateInput: { backgroundColor: '#FFFFFF', borderColor: '#E3E0F4', borderRadius: 14, borderWidth: 1, color: colors.ink, fontSize: 18, paddingHorizontal: 12, paddingVertical: 10 },
  reminderHint: { color: '#8F8D98', fontSize: 13, fontWeight: '400', lineHeight: 19 },
  optionGroup: { backgroundColor: '#FFFFFF', borderRadius: 18, overflow: 'hidden' },
  optionGroupTitle: { color: '#8F8D98', fontSize: 13, fontWeight: '400', paddingHorizontal: 4, paddingTop: 8 },
  optionList: { gap: 0 },
  optionRow: { alignItems: 'center', borderBottomColor: '#EFEFF4', borderBottomWidth: 1, flexDirection: 'row', minHeight: 66 },
  radio: { borderColor: '#B9B8BF', borderRadius: 13, borderWidth: 1.5, color: '#FFFFFF', height: 26, lineHeight: 23, marginRight: 14, textAlign: 'center', width: 26 },
  radioSelected: { backgroundColor: '#7069C8', borderColor: '#7069C8' },
  optionLabel: { color: '#11131D', fontSize: 19, fontWeight: '500' },
  intensityRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingTop: 14 },
  intensityChip: { backgroundColor: '#F5F4FA', borderRadius: 16, paddingHorizontal: 13, paddingVertical: 9 },
  intensityChipActive: { backgroundColor: '#7069C8' },
  intensityText: { color: '#65616F', fontSize: 13, fontWeight: '500' },
  intensityTextActive: { color: '#FFFFFF' },
  footer: { flexDirection: 'row', gap: 16, paddingTop: 12 },
  cancelButton: { alignItems: 'center', backgroundColor: '#F0F0F0', borderRadius: 24, flex: 1, paddingVertical: 15 },
  confirmButton: { alignItems: 'center', backgroundColor: '#7069C8', borderRadius: 24, flex: 1, paddingVertical: 15 },
  confirmDisabled: { backgroundColor: '#A8A8A8' },
  cancelText: { color: '#6D6A72', fontSize: 17, fontWeight: '500' },
  confirmText: { color: '#FFFFFF', fontSize: 17, fontWeight: '500' },
});
