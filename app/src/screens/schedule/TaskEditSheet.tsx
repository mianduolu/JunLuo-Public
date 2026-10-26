import { memo } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { AppText as Text, AppTextInput as TextInput } from '../../components/AppText';
import { getLifeAreaConfig, type Goal } from '../../schedule/goalStore';
import { categoryConfig, priorityLabels, quadrantConfig } from '../../schedule/taskMeta';
import type { TodoCategory, TodoItem, TodoQuadrant } from '../../schedule/todoStore';
import { colors } from '../../theme/colors';

export type TaskEditDraft = {
  title: string;
  notes: string;
  plannedForDate: string;
  priority: TodoItem['priority'];
  quadrant: TodoQuadrant;
  category: TodoCategory;
  estimatedMinutes: string;
  goalId: string;
  type: TodoItem['type'];
};

type Props = {
  draft: TaskEditDraft | null;
  goals: Goal[];
  keyboardLift: number;
  onChange: (draft: TaskEditDraft | null) => void;
  onClose: () => void;
  onComplete: () => void;
  onDelete: () => void;
  onEndInhibit: () => void;
  onSave: () => void;
  onSchedule: () => void;
  onTomorrow: () => void;
  todo: TodoItem | null;
};

export const TaskEditSheet = memo(function TaskEditSheet({
  draft,
  goals,
  keyboardLift,
  onChange,
  onClose,
  onComplete,
  onDelete,
  onEndInhibit,
  onSave,
  onSchedule,
  onTomorrow,
  todo,
}: Props) {
  if (!todo || !draft) return null;
  const isChallenge = todo.source === 'daily-challenge';
  const isInhibit = draft.type === 'inhibit';

  return (
    <Modal animationType="slide" transparent visible onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.modalOverlay}>
        <Pressable style={styles.modalBackdrop} onPress={onClose} />
        <View style={[styles.taskSheet, keyboardLift > 0 ? { transform: [{ translateY: -keyboardLift }] } : null]}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>{isChallenge ? '每日挑战' : '编辑待办'}</Text>
            <Pressable onPress={onClose} style={styles.modalClose}>
              <Text style={styles.modalCloseText}>×</Text>
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.taskSheetContent} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
            {isChallenge ? (
              <View style={styles.challengeHeading}>
                <Text style={styles.taskTitleInput}>{todo.title}</Text>
                <Text style={styles.challengeHint}>这是每日挑战实例。标题、分类、象限和估时请在“习惯与挑战”里统一修改。</Text>
              </View>
            ) : (
              <>
                <TextInput onChangeText={(title) => onChange({ ...draft, title })} placeholder="待办标题" style={styles.taskTitleInput} value={draft.title} />
                <TextInput
                  multiline
                  onChangeText={(notes) => onChange({ ...draft, notes })}
                  placeholder="补充说明（可不写）"
                  style={styles.taskNotesInput}
                  value={draft.notes}
                />
              </>
            )}
            {!isChallenge ? <><View style={styles.editSection}>
              <Text style={styles.editLabel}>类型</Text>
              <View style={styles.row}>
                <Pressable onPress={() => onChange({ ...draft, type: 'normal' })} style={[styles.chip, draft.type === 'normal' && styles.chipSelected]}>
                  <Text style={draft.type === 'normal' ? styles.chipSelectedText : styles.chipText}>普通任务</Text>
                </Pressable>
                <Pressable onPress={() => onChange({ ...draft, type: 'inhibit' })} style={[styles.chip, draft.type === 'inhibit' && styles.chipSelected]}>
                  <Text style={draft.type === 'inhibit' ? styles.chipSelectedText : styles.chipText}>提醒自己别做</Text>
                </Pressable>
              </View>
            </View>
            {!isInhibit ? <><View style={styles.editSection}>
              <Text style={styles.editLabel}>象限</Text>
              <View style={styles.chipGrid}>
                {quadrantConfig.map((quadrant) => (
                  <Pressable
                    key={quadrant.id}
                    onPress={() => onChange({ ...draft, quadrant: quadrant.id })}
                    style={[styles.editChip, { borderColor: quadrant.border }, draft.quadrant === quadrant.id && { backgroundColor: quadrant.color }]}
                  >
                    <Text style={styles.editChipText}>{quadrant.title}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
            <View style={styles.editSection}>
              <Text style={styles.editLabel}>分类</Text>
              <View style={styles.chipGrid}>
                {categoryConfig.map((category) => (
                  <Pressable
                    key={category.id}
                    onPress={() => onChange({ ...draft, category: category.id })}
                    style={[styles.editChip, { borderColor: category.color }, draft.category === category.id && styles.editChipSelected]}
                  >
                    <Text style={styles.editChipText}>{category.icon} {category.label}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
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
              <Text style={styles.editLabel}>优先级</Text>
              <View style={styles.row}>
                {(['high', 'normal', 'low'] as TodoItem['priority'][]).map((priority) => (
                  <Pressable key={priority} onPress={() => onChange({ ...draft, priority })} style={[styles.chip, draft.priority === priority && styles.chipSelected]}>
                    <Text style={draft.priority === priority ? styles.chipSelectedText : styles.chipText}>{priorityLabels[priority]}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
            <View style={styles.row}>
              <TextInput onChangeText={(plannedForDate) => onChange({ ...draft, plannedForDate })} placeholder="日期 2026-06-19" style={[styles.input, styles.flex]} value={draft.plannedForDate} />
              <TextInput keyboardType="numeric" onChangeText={(estimatedMinutes) => onChange({ ...draft, estimatedMinutes })} placeholder="估时" style={[styles.input, styles.short]} value={draft.estimatedMinutes} />
            </View>
            <View style={styles.taskActionGrid}>
              <Pressable onPress={onComplete} style={styles.taskActionButton}><Text style={styles.primaryText}>完成</Text></Pressable>
              <Pressable onPress={onTomorrow} style={styles.taskSecondaryButton}><Text style={styles.secondaryButtonText}>明天</Text></Pressable>
              <Pressable onPress={onSchedule} style={styles.taskSecondaryButton}><Text style={styles.secondaryButtonText}>定时间</Text></Pressable>
              <Pressable onPress={onDelete} style={styles.taskDangerButton}><Text style={styles.taskDangerText}>删除</Text></Pressable>
            </View>
            <Pressable onPress={onSave} style={styles.primaryButton}><Text style={styles.primaryText}>保存修改</Text></Pressable>
            </> : (
              <>
                <Text style={styles.inhibitHint}>它会每天待在日视图顶部，不进入四象限，也不要求打勾完成。</Text>
                <Pressable onPress={onSave} style={styles.primaryButton}><Text style={styles.primaryText}>保存修改</Text></Pressable>
                {todo.inhibitEndedAt ? <Text style={styles.challengeDone}>这条提醒已经结束。</Text> : (
                  <Pressable onPress={onEndInhibit} style={styles.taskDangerButton}><Text style={styles.taskDangerText}>结束持续提醒</Text></Pressable>
                )}
              </>
            )}
            </> : (
              todo.status !== 'completed'
                ? <Pressable onPress={onComplete} style={styles.primaryButton}><Text style={styles.primaryText}>完成挑战</Text></Pressable>
                : <Text style={styles.challengeDone}>今天这条已经完成啦。</Text>
            )}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
});

const styles = StyleSheet.create({
  modalOverlay: { flex: 1, justifyContent: 'flex-end' },
  modalBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(35, 39, 55, 0.28)' },
  taskSheet: { backgroundColor: '#FFFDF9', borderTopLeftRadius: 24, borderTopRightRadius: 24, maxHeight: '88%', paddingHorizontal: 18, paddingTop: 16 },
  modalHeader: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 },
  modalTitle: { color: colors.ink, fontSize: 20, fontWeight: '600' },
  modalClose: { alignItems: 'center', backgroundColor: '#F7E8E3', borderRadius: 18, height: 36, justifyContent: 'center', width: 36 },
  modalCloseText: { color: '#B96F64', fontSize: 25, lineHeight: 28 },
  taskSheetContent: { gap: 14, paddingBottom: 34 },
  taskTitleInput: { borderBottomColor: colors.border, borderBottomWidth: 1, color: colors.ink, fontSize: 20, fontWeight: '500', minHeight: 46 },
  taskNotesInput: { backgroundColor: '#FFF7F1', borderRadius: 14, color: colors.ink, minHeight: 74, padding: 12, textAlignVertical: 'top' },
  challengeHeading: { gap: 5 },
  challengeHint: { color: colors.muted, fontSize: 12, fontWeight: '400', lineHeight: 18 },
  challengeDone: { color: '#5D9B65', fontSize: 13, fontWeight: '500', textAlign: 'center' },
  inhibitHint: { color: colors.muted, fontSize: 12, fontWeight: '400', lineHeight: 18 },
  taskExecutionPanel: { backgroundColor: '#F7F5FF', borderColor: '#E6E1FF', borderRadius: 16, borderWidth: 1, gap: 10, padding: 12 },
  taskExecutionHeader: { alignItems: 'flex-start', flexDirection: 'row', gap: 10, justifyContent: 'space-between' },
  taskExecutionTitle: { color: colors.ink, fontSize: 15, fontWeight: '500', lineHeight: 20 },
  taskExecutionMeta: { color: colors.muted, fontSize: 12, fontWeight: '400', lineHeight: 18, marginTop: 2 },
  taskExecutionBadge: { backgroundColor: '#817AE4', borderRadius: 12, color: '#FFFFFF', fontSize: 11, fontWeight: '500', overflow: 'hidden', paddingHorizontal: 9, paddingVertical: 4 },
  taskExecutionBadgePaused: { backgroundColor: '#A9A4BA' },
  taskExecutionProgressTrack: { backgroundColor: '#E5E0F8', borderRadius: 5, height: 10, overflow: 'hidden' },
  taskExecutionProgressFill: { backgroundColor: '#817AE4', borderRadius: 5, height: 10, minWidth: 0 },
  taskExecutionActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  taskExecutionPrimary: { alignItems: 'center', backgroundColor: colors.primary, borderRadius: 13, flexGrow: 1, paddingHorizontal: 14, paddingVertical: 10 },
  taskExecutionSecondary: { alignItems: 'center', backgroundColor: '#FFFFFF', borderColor: '#D9D3F7', borderRadius: 13, borderWidth: 1, flexGrow: 1, paddingHorizontal: 14, paddingVertical: 10 },
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
  input: { borderColor: colors.border, borderRadius: 10, borderWidth: 1, color: colors.ink, height: 42, paddingHorizontal: 10 },
  flex: { flex: 1 },
  short: { width: 82 },
  taskActionGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  taskActionButton: { alignItems: 'center', backgroundColor: colors.primary, borderRadius: 13, flexGrow: 1, paddingHorizontal: 14, paddingVertical: 11 },
  taskSecondaryButton: { alignItems: 'center', backgroundColor: '#EEF7FF', borderColor: '#CFE5F5', borderRadius: 13, borderWidth: 1, flexGrow: 1, paddingHorizontal: 14, paddingVertical: 11 },
  taskDangerButton: { alignItems: 'center', backgroundColor: '#FFF0EC', borderColor: '#F4B4A5', borderRadius: 13, borderWidth: 1, flexGrow: 1, paddingHorizontal: 14, paddingVertical: 11 },
  taskDangerText: { color: '#C8796E', fontWeight: '500' },
  primaryButton: { alignItems: 'center', backgroundColor: colors.primary, borderRadius: 12, paddingVertical: 11 },
  primaryText: { color: '#FFFFFF', fontWeight: '500' },
  secondaryButtonText: { color: '#557CA1', fontWeight: '500' },
});
