import { memo, useState } from 'react';
import { Keyboard, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DateTimePickerSheet } from '../../components/DateTimePickerSheet';
import { AppText as Text, AppTextInput as TextInput } from '../../components/AppText';
import { getLifeAreaConfig, type Goal } from '../../schedule/goalStore';
import type { HabitFrequency, HabitScheduleInstances } from '../../schedule/habitStore';
import { dateKey } from '../../schedule/scheduleStore';
import { categoryConfig, habitFrequencyLabels } from '../../schedule/taskMeta';
import type { DateTimeSelection } from '../../schedule/dateTimeSelection';
import type { TodoCategory } from '../../schedule/todoStore';
import { colors } from '../../theme/colors';

const weekDayLabels = ['一', '二', '三', '四', '五', '六', '日'];

export type HabitEditDraft = {
  id?: string;
  title: string;
  goalId: string;
  category: TodoCategory;
  frequency: HabitFrequency;
  weekDays: number[];
  targetCount: number;
  reminderTimes: string[];
  reminderTime: string;
  scheduleInstances: HabitScheduleInstances;
};

type Props = {
  draft: HabitEditDraft | null;
  goals: Goal[];
  keyboardLift: number;
  onArchive?: () => void;
  onDelete?: () => void;
  onChange: (draft: HabitEditDraft | null) => void;
  onClose: () => void;
  onSave: () => void;
};

function normalizeTimeInput(value: string) {
  const match = value.match(/^(\d{1,2}):?(\d{0,2})$/);
  if (!match) return value;
  const hour = Math.min(23, Math.max(0, Number(match[1])));
  const minute = Math.min(59, Math.max(0, Number(match[2] || '0')));
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export const HabitEditSheet = memo(function HabitEditSheet({
  draft,
  goals,
  keyboardLift,
  onArchive,
  onDelete,
  onChange,
  onClose,
  onSave,
}: Props) {
  const insets = useSafeAreaInsets();
  const [timePickerIndex, setTimePickerIndex] = useState<number | null>(null);
  if (!draft) return null;

  const toggleWeekDay = (day: number) => {
    const next = draft.weekDays.includes(day)
      ? draft.weekDays.filter((item) => item !== day)
      : [...draft.weekDays, day].sort((a, b) => a - b);
    onChange({ ...draft, weekDays: next.length ? next : [day] });
  };
  const updateTargetCount = (amount: number) => {
    const nextCount = Math.max(1, Math.min(12, draft.targetCount + amount));
    const nextTimes = Array.from({ length: nextCount }, (_, index) => draft.reminderTimes[index] ?? '');
    onChange({ ...draft, targetCount: nextCount, reminderTimes: nextTimes, reminderTime: nextTimes.find(Boolean) ?? '' });
  };
  const updateReminderTime = (index: number, value: string) => {
    const nextTimes = Array.from({ length: draft.targetCount }, (_, timeIndex) => draft.reminderTimes[timeIndex] ?? '');
    nextTimes[index] = normalizeTimeInput(value);
    onChange({ ...draft, reminderTimes: nextTimes, reminderTime: nextTimes.find(Boolean) ?? '' });
  };
  const openTimePicker = (index: number) => {
    Keyboard.dismiss();
    setTimePickerIndex(index);
  };
  const pickerValue = (time: string): DateTimeSelection => ({
    date: dateKey(new Date()),
    recurrence: 'none',
    reminderChoice: 'none',
    reminderClock: '09:00',
    reminderIntensity: 'gentle',
    time: time || '09:00',
  });
  const applyTimePicker = (selection: DateTimeSelection | null) => {
    if (timePickerIndex === null) return;
    updateReminderTime(timePickerIndex, selection?.time ?? '');
    setTimePickerIndex(null);
  };

  return (
    <>
      <Modal animationType="slide" transparent visible onRequestClose={onClose}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.modalOverlay}>
          <Pressable style={styles.modalBackdrop} onPress={onClose} />
          <View
            style={[
              styles.taskSheet,
              styles.goalSheet,
              { paddingBottom: Math.max(insets.bottom + 18, 34) },
              keyboardLift > 0 ? { transform: [{ translateY: -keyboardLift }] } : null,
            ]}
          >
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>{draft.id ? '编辑习惯' : '新建习惯'}</Text>
              <Pressable onPress={onClose} style={styles.modalClose}><Text style={styles.modalCloseText}>×</Text></Pressable>
            </View>
            <ScrollView contentContainerStyle={styles.taskSheetContent} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
            <TextInput onChangeText={(title) => onChange({ ...draft, title })} placeholder="例如：读两页书" style={styles.taskTitleInput} value={draft.title} />
            <View style={styles.editSection}>
              <Text style={styles.editLabel}>分类</Text>
              <View style={styles.chipGrid}>
                {categoryConfig.map((category) => (
                  <Pressable
                    key={category.id}
                    onPress={() => onChange({ ...draft, category: category.id })}
                    style={[styles.editChip, { borderColor: category.color }, draft.category === category.id && { backgroundColor: `${category.color}22` }]}
                  >
                    <Text style={styles.editChipText}>{category.icon} {category.label}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
            <View style={styles.editSection}>
              <Text style={styles.editLabel}>频率</Text>
              <View style={styles.row}>
                {(['daily', 'weekly', 'custom'] as HabitFrequency[]).map((frequency) => (
                  <Pressable key={frequency} onPress={() => onChange({ ...draft, frequency })} style={[styles.chip, draft.frequency === frequency && styles.chipSelected]}>
                    <Text style={draft.frequency === frequency ? styles.chipSelectedText : styles.chipText}>{habitFrequencyLabels[frequency]}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
            <View style={styles.editSection}>
              <Text style={styles.editLabel}>每天需要做几次</Text>
              <View style={styles.habitCountRow}>
                <Pressable onPress={() => updateTargetCount(-1)} style={styles.habitCountButton}><Text style={styles.habitCountButtonText}>−</Text></Pressable>
                <Text style={styles.habitCountValue}>{draft.targetCount} 次</Text>
                <Pressable onPress={() => updateTargetCount(1)} style={styles.habitCountButton}><Text style={styles.habitCountButtonText}>＋</Text></Pressable>
              </View>
            </View>
            {draft.frequency !== 'daily' ? (
              <View style={styles.editSection}>
                <Text style={styles.editLabel}>哪几天出现</Text>
                <View style={styles.weekDayGrid}>
                  {weekDayLabels.map((label, index) => {
                    const day = index + 1;
                    const selected = draft.weekDays.includes(day);
                    return (
                      <Pressable key={day} onPress={() => toggleWeekDay(day)} style={[styles.weekDayChip, selected && styles.weekDayChipSelected]}>
                        <Text style={selected ? styles.chipSelectedText : styles.chipText}>{label}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            ) : null}
            <View style={styles.editSection}>
              <Text style={styles.editLabel}>关联目标</Text>
              <View style={styles.chipGrid}>
                <Pressable onPress={() => onChange({ ...draft, goalId: '' })} style={[styles.editChip, !draft.goalId && styles.editChipSelected]}>
                  <Text style={styles.editChipText}>不关联</Text>
                </Pressable>
                {goals.map((goal) => {
                  const area = getLifeAreaConfig(goal.lifeArea);
                  return (
                    <Pressable
                      key={goal.id}
                      onPress={() => onChange({ ...draft, goalId: goal.id })}
                      style={[styles.editChip, { borderColor: area.color }, draft.goalId === goal.id && { backgroundColor: `${area.color}22` }]}
                    >
                      <Text style={styles.editChipText}>{area.icon} {goal.title}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
              <View style={styles.editSection}>
                <Text style={styles.editLabel}>几点钟做</Text>
                {Array.from({ length: draft.targetCount }, (_, index) => {
                  const reminderTime = draft.reminderTimes[index] ?? '';
                  return (
                    <Pressable key={index} onPress={() => openTimePicker(index)} style={styles.habitTimeRow}>
                      <Text style={styles.habitTimeIndex}>第 {index + 1} 次</Text>
                      <Text style={[styles.habitTimeValue, !reminderTime && styles.habitTimePlaceholder]}>
                        {reminderTime || '选择时刻'}
                      </Text>
                      <Text style={styles.habitTimeArrow}>›</Text>
                    </Pressable>
                  );
                })}
              </View>
            <View style={styles.scheduleLinkSection}>
              <View style={styles.scheduleLinkCopy}>
                <Text style={styles.scheduleLinkTitle}>在日历中显示</Text>
                <Text style={styles.scheduleLinkHint}>只为上面已填写的时刻生成关联日程</Text>
              </View>
              <Switch
                onValueChange={(enabled) => onChange({
                  ...draft,
                  scheduleInstances: { ...draft.scheduleInstances, enabled },
                })}
                trackColor={{ false: '#DDDDE7', true: '#C9C4FA' }}
                thumbColor={draft.scheduleInstances.enabled ? colors.primary : '#FFFFFF'}
                value={draft.scheduleInstances.enabled}
              />
            </View>
            {draft.scheduleInstances.enabled ? (
              <View style={styles.editSection}>
                <Text style={styles.editLabel}>提前提醒</Text>
                <View style={styles.row}>
                  {[0, 5, 10, 15, 30].map((minutes) => (
                    <Pressable
                      key={minutes}
                      onPress={() => onChange({
                        ...draft,
                        scheduleInstances: { ...draft.scheduleInstances, reminderMinutesBefore: minutes },
                      })}
                      style={[styles.chip, draft.scheduleInstances.reminderMinutesBefore === minutes && styles.chipSelected]}
                    >
                      <Text style={draft.scheduleInstances.reminderMinutesBefore === minutes ? styles.chipSelectedText : styles.chipText}>
                        {minutes ? `${minutes} 分钟` : '到点'}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            ) : null}
            {onArchive ? (
              <Pressable onPress={onArchive} style={styles.taskDangerButton}><Text style={styles.taskDangerText}>归档习惯</Text></Pressable>
            ) : null}
            {onDelete ? (
              <Pressable accessibilityRole="button" onPress={onDelete} style={styles.deleteButton}>
                <Text style={styles.deleteText}>删除习惯</Text>
              </Pressable>
            ) : null}
            <Pressable onPress={onSave} style={styles.primaryButton}><Text style={styles.primaryText}>保存习惯</Text></Pressable>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>
      <DateTimePickerSheet
        onClose={() => setTimePickerIndex(null)}
        onConfirm={applyTimePicker}
        timeOnly
        title={timePickerIndex === null ? '选择时刻' : `第 ${timePickerIndex + 1} 次`}
        value={pickerValue(timePickerIndex === null ? '' : draft.reminderTimes[timePickerIndex] ?? '')}
        visible={timePickerIndex !== null}
      />
    </>
  );
});

const styles = StyleSheet.create({
  modalOverlay: { flex: 1, justifyContent: 'flex-end' },
  modalBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(35, 39, 55, 0.28)' },
  taskSheet: { backgroundColor: '#FFFDF9', borderTopLeftRadius: 24, borderTopRightRadius: 24, maxHeight: '88%', paddingHorizontal: 18, paddingTop: 16 },
  goalSheet: { maxHeight: '82%' },
  modalHeader: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 },
  modalTitle: { color: colors.ink, fontSize: 20, fontWeight: '600' },
  modalClose: { alignItems: 'center', backgroundColor: '#F7E8E3', borderRadius: 18, height: 36, justifyContent: 'center', width: 36 },
  modalCloseText: { color: '#B96F64', fontSize: 25, lineHeight: 28 },
  taskSheetContent: { gap: 14, paddingBottom: 34 },
  taskTitleInput: { borderBottomColor: colors.border, borderBottomWidth: 1, color: colors.ink, fontSize: 20, fontWeight: '500', minHeight: 46 },
  editSection: { gap: 8 },
  editLabel: { color: colors.muted, fontSize: 13, fontWeight: '400' },
  chipGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  editChip: { backgroundColor: '#FFFFFF', borderRadius: 14, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 8 },
  editChipSelected: { backgroundColor: '#F2F0FF' },
  editChipText: { color: colors.ink, fontSize: 12, fontWeight: '400' },
  row: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  chip: { borderColor: colors.border, borderRadius: 15, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 7 },
  chipSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { color: colors.muted },
  chipSelectedText: { color: '#FFFFFF' },
  habitCountRow: { alignItems: 'center', flexDirection: 'row', gap: 12 },
  habitCountButton: { alignItems: 'center', backgroundColor: '#F2F0FF', borderColor: '#DCD7FF', borderRadius: 15, borderWidth: 1, height: 38, justifyContent: 'center', width: 46 },
  habitCountButtonText: { color: '#746BDD', fontSize: 22, fontWeight: '500', lineHeight: 26 },
  habitCountValue: { color: colors.ink, fontSize: 16, fontWeight: '500', minWidth: 54, textAlign: 'center' },
  weekDayGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  weekDayChip: { alignItems: 'center', borderColor: colors.border, borderRadius: 14, borderWidth: 1, justifyContent: 'center', minHeight: 38, minWidth: 42, paddingHorizontal: 10 },
  weekDayChipSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  habitTimeRow: { alignItems: 'center', backgroundColor: '#FFFFFF', borderColor: colors.border, borderRadius: 14, borderWidth: 1, flexDirection: 'row', gap: 10, minHeight: 46, paddingHorizontal: 12 },
  habitTimeIndex: { color: colors.ink, fontSize: 14, fontWeight: '500', minWidth: 62 },
  habitTimeValue: { color: colors.ink, flex: 1, fontSize: 15, fontWeight: '400', textAlign: 'right' },
  habitTimePlaceholder: { color: '#A7A3B0' },
  habitTimeArrow: { color: '#B9B5C2', fontSize: 22, lineHeight: 24 },
  scheduleLinkSection: { alignItems: 'center', backgroundColor: '#F7F6FF', borderRadius: 14, flexDirection: 'row', justifyContent: 'space-between', padding: 12 },
  scheduleLinkCopy: { flex: 1, gap: 2, paddingRight: 12 },
  scheduleLinkTitle: { color: colors.ink, fontSize: 15, fontWeight: '500' },
  scheduleLinkHint: { color: colors.muted, fontSize: 12, fontWeight: '400' },
  taskDangerButton: { alignItems: 'center', backgroundColor: '#FFF0EC', borderColor: '#F4B4A5', borderRadius: 13, borderWidth: 1, flexGrow: 1, paddingHorizontal: 14, paddingVertical: 11 },
  taskDangerText: { color: '#C8796E', fontWeight: '500' },
  deleteButton: { alignItems: 'center', justifyContent: 'center', minHeight: 44, borderRadius: 13, borderWidth: 1, borderColor: '#E5C0BD', backgroundColor: '#FFF8F6' },
  deleteText: { color: '#A24E49', fontWeight: '400' },
  primaryButton: { alignItems: 'center', backgroundColor: colors.primary, borderRadius: 12, paddingVertical: 11 },
  primaryText: { color: '#FFFFFF', fontWeight: '500' },
});
