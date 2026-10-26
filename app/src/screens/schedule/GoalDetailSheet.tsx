import { memo } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useEffect, useState } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppText as Text } from '../../components/AppText';
import { getLifeAreaConfig, type Goal } from '../../schedule/goalStore';
import { priorityLabels } from '../../schedule/taskMeta';
import type { TodoItem } from '../../schedule/todoStore';
import { colors } from '../../theme/colors';

type Props = {
  goal: Goal | null;
  onClose: () => void;
  onCompleteGoal: (goalId: string) => Promise<void>;
  onManualMinutes: (minutes: number) => void;
  tasks: TodoItem[];
};

export const GoalDetailSheet = memo(function GoalDetailSheet({ goal, onClose, onCompleteGoal, onManualMinutes, tasks }: Props) {
  const insets = useSafeAreaInsets();
  const [manualMinutes, setManualMinutes] = useState('');
  const [completing, setCompleting] = useState(false);
  useEffect(() => {
    setCompleting(false);
    setManualMinutes('');
  }, [goal?.id]);
  if (!goal) return null;
  const area = getLifeAreaConfig(goal.lifeArea);
  const achieved = goal.status === 'completed';
  const doneCount = tasks.filter((task) => task.status === 'completed').length;
  const calculatedProgress = goal.goalType === 'direction'
    ? goal.progress
    : Math.max(0, Math.min(100, goal.progress));
  const typeLabel = goal.goalType === 'countdown' ? '倒计时目标' : goal.goalType === 'time_based' ? '时间目标' : '方向型目标';
  return (
    <Modal animationType="slide" transparent visible onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.modalOverlay}>
        <Pressable style={styles.modalBackdrop} onPress={onClose} />
        <View style={[styles.taskSheet, styles.goalSheet, { paddingBottom: Math.max(insets.bottom + 18, 34) }]}>
          <View style={styles.modalHeader}>
            <Text numberOfLines={1} style={styles.modalTitle}>{goal.title}</Text>
            <Pressable onPress={onClose} style={styles.modalClose}><Text style={styles.modalCloseText}>×</Text></Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.taskSheetContent} showsVerticalScrollIndicator={false}>
            <View style={styles.goalDetailCard}>
              <Text style={styles.goalDetailMeta}>{area.icon} {area.label}</Text>
              <Text style={styles.goalDetailMeta}>{typeLabel}</Text>
              {achieved ? (
                <Text style={styles.goalDetailProgress}>已经实现 ✨</Text>
              ) : goal.goalType === 'direction' ? (
                <Text style={styles.goalDetailProgress}>继续在意</Text>
              ) : (
                <>
                  <Text style={styles.goalDetailProgress}>{calculatedProgress}%</Text>
                  <View style={styles.goalProgressTrack}><View style={[styles.goalProgressFill, { width: `${calculatedProgress}%`, backgroundColor: area.color }]} /></View>
                </>
              )}
              {goal.goalType === 'countdown' ? <Text style={styles.goalDetailMeta}>目标：{goal.targetCount} {goal.targetUnit ?? ''} · 每次贡献 {goal.actionAmount}</Text> : null}
              {goal.goalType === 'time_based' ? <Text style={styles.goalDetailMeta}>预计总投入：{Math.round((goal.estimatedTotalMinutes ?? 0) / 60 * 10) / 10} 小时</Text> : null}
              {goal.targetDate ? <Text style={styles.goalDetailMeta}>截止：{goal.targetDate}</Text> : null}
              {goal.description ? <Text style={styles.goalDescription}>{goal.description}</Text> : null}
            </View>
            {goal.goalType === 'time_based' ? (
              <View style={styles.manualRow}>
                <TextInput
                  keyboardType="number-pad"
                  onChangeText={setManualMinutes}
                  placeholder="补录投入分钟"
                  style={styles.manualInput}
                  value={manualMinutes}
                />
                <Pressable
                  onPress={() => {
                    const minutes = Number(manualMinutes);
                    if (!Number.isFinite(minutes) || minutes <= 0) return;
                    onManualMinutes(Math.round(minutes));
                    setManualMinutes('');
                  }}
                  style={styles.manualButton}
                >
                  <Text style={styles.secondaryButtonText}>补录</Text>
                </Pressable>
              </View>
            ) : null}
            <View style={styles.displaySection}>
              <View style={styles.displaySectionHeader}>
                <View style={[styles.displaySectionMark, { backgroundColor: area.color }]} />
                <Text style={styles.displaySectionTitle}>关联任务</Text>
                <Text style={styles.displaySectionCount}>{doneCount}/{tasks.length}</Text>
              </View>
              {tasks.length ? tasks.map((task) => (
                <View key={task.id} style={styles.goalTaskRow}>
                  <Text style={styles.goalTaskCheck}>{task.status === 'completed' ? '✓' : '•'}</Text>
                  <View style={styles.goalTaskCopy}>
                    <Text numberOfLines={1} style={styles.goalTaskTitle}>{task.title}</Text>
                    <Text numberOfLines={1} style={styles.goalTaskMeta}>{task.plannedForDate ?? task.dueDate ?? '未定日期'} · {priorityLabels[task.priority]}</Text>
                  </View>
                </View>
              )) : <Text style={styles.displayEmpty}>还没有任务关联到这个目标。</Text>}
            </View>
            <Pressable onPress={onClose} style={styles.taskSecondaryButton}><Text style={styles.secondaryButtonText}>AI 拆解稍后接入待确认方案</Text></Pressable>
          </ScrollView>
          <View style={styles.goalActionFooter}>
            <Pressable
              disabled={achieved || completing}
              onPress={async () => {
                if (achieved || completing) return;
                setCompleting(true);
                try {
                  await onCompleteGoal(goal.id);
                } finally {
                  setCompleting(false);
                }
              }}
              style={({ pressed }) => [
                styles.goalCompleteButton,
                achieved && styles.goalCompleteButtonDone,
                (pressed || completing) && !achieved && styles.goalCompleteButtonPressed,
              ]}
            >
              <Text style={[styles.goalCompleteButtonText, achieved && styles.goalCompleteButtonTextDone]}>
                {achieved ? '✨ 已实现' : completing ? '正在点亮...' : '✨ 标记实现'}
              </Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
});

const styles = StyleSheet.create({
  modalOverlay: { flex: 1, justifyContent: 'flex-end' }, modalBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(35, 39, 55, 0.28)' },
  taskSheet: { backgroundColor: '#FFFDF9', borderTopLeftRadius: 24, borderTopRightRadius: 24, maxHeight: '88%', paddingHorizontal: 18, paddingTop: 16 }, goalSheet: { maxHeight: '82%' },
  modalHeader: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 }, modalTitle: { color: colors.ink, fontSize: 20, fontWeight: '600' }, modalClose: { alignItems: 'center', backgroundColor: '#F7E8E3', borderRadius: 18, height: 36, justifyContent: 'center', width: 36 }, modalCloseText: { color: '#B96F64', fontSize: 25, lineHeight: 28 },
  taskSheetContent: { gap: 14, paddingBottom: 16 }, goalDetailCard: { backgroundColor: '#FFFFFF', borderColor: '#ECE8F3', borderRadius: 18, borderWidth: 1, gap: 8, padding: 14 }, goalDetailMeta: { color: colors.muted, fontSize: 13, lineHeight: 19 }, goalDetailProgress: { color: colors.ink, fontSize: 28, fontWeight: '600', lineHeight: 34 }, goalProgressTrack: { backgroundColor: '#F0EDF4', borderRadius: 5, height: 10, overflow: 'hidden' }, goalProgressFill: { borderRadius: 5, height: 10 }, goalDescription: { color: colors.ink, fontSize: 14, lineHeight: 21 },
  displaySection: { backgroundColor: '#FFFFFF', borderColor: '#ECE8F3', borderRadius: 16, borderWidth: 1, gap: 9, padding: 10 }, displaySectionHeader: { alignItems: 'center', flexDirection: 'row', gap: 8, minHeight: 28 }, displaySectionMark: { backgroundColor: '#817AE4', borderRadius: 3, height: 18, width: 4 }, displaySectionTitle: { color: colors.ink, flex: 1, fontSize: 16, fontWeight: '600' }, displaySectionCount: { color: '#A4A0B2', fontSize: 12, fontWeight: '400' }, displayEmpty: { color: colors.muted, fontSize: 13, fontWeight: '400', paddingHorizontal: 8, paddingVertical: 12 },
  goalTaskRow: { alignItems: 'center', borderTopColor: '#F0EDF4', borderTopWidth: 1, flexDirection: 'row', gap: 9, paddingVertical: 9 }, goalTaskCheck: { color: '#817AE4', fontSize: 16, fontWeight: '500', width: 18 }, goalTaskCopy: { flex: 1 }, goalTaskTitle: { color: colors.ink, fontSize: 14, fontWeight: '500', lineHeight: 19 }, goalTaskMeta: { color: colors.muted, fontSize: 11, lineHeight: 16 },
  taskSecondaryButton: { alignItems: 'center', backgroundColor: '#EEF7FF', borderColor: '#CFE5F5', borderRadius: 13, borderWidth: 1, flexGrow: 1, paddingHorizontal: 14, paddingVertical: 11 }, secondaryButtonText: { color: '#557CA1', fontWeight: '500' },
  manualRow: { flexDirection: 'row', gap: 8 }, manualInput: { backgroundColor: '#FFFFFF', borderColor: '#ECE8F3', borderRadius: 13, borderWidth: 1, color: colors.ink, flex: 1, paddingHorizontal: 12, paddingVertical: 10 }, manualButton: { alignItems: 'center', backgroundColor: '#EEF7FF', borderRadius: 13, justifyContent: 'center', paddingHorizontal: 18 },
  goalActionFooter: { backgroundColor: '#FFFDF9', paddingTop: 6 },
  goalCompleteButton: { alignItems: 'center', backgroundColor: '#FF9A89', borderRadius: 18, minHeight: 52, justifyContent: 'center', paddingHorizontal: 18 },
  goalCompleteButtonDone: { backgroundColor: '#F2F0F7', borderColor: '#D9D4E7', borderWidth: 1 },
  goalCompleteButtonPressed: { opacity: 0.72, transform: [{ scale: 0.99 }] },
  goalCompleteButtonText: { color: '#FFFFFF', fontSize: 17, fontWeight: '600' },
  goalCompleteButtonTextDone: { color: colors.muted },
});
