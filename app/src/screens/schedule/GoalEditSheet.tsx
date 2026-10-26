import { memo } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppText as Text, AppTextInput as TextInput } from '../../components/AppText';
import { LIFE_AREAS, type GoalPriority, type LifeAreaType } from '../../schedule/goalStore';
import { priorityLabels } from '../../schedule/taskMeta';
import { colors } from '../../theme/colors';

export type GoalEditDraft = {
  title: string;
  description: string;
  lifeArea: LifeAreaType;
  priority: GoalPriority;
  targetDate: string;
};

type Props = {
  draft: GoalEditDraft | null;
  keyboardLift: number;
  onChange: (draft: GoalEditDraft | null) => void;
  onClose: () => void;
  onOpenTargetDate: () => void;
  onSave: () => void;
};

export const GoalEditSheet = memo(function GoalEditSheet({
  draft,
  keyboardLift,
  onChange,
  onClose,
  onOpenTargetDate,
  onSave,
}: Props) {
  const insets = useSafeAreaInsets();
  if (!draft) return null;
  return (
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
            <Text style={styles.modalTitle}>新建目标</Text>
            <Pressable onPress={onClose} style={styles.modalClose}>
              <Text style={styles.modalCloseText}>×</Text>
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.taskSheetContent} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
            <TextInput onChangeText={(title) => onChange({ ...draft, title })} placeholder="在这里填写……" style={styles.taskTitleInput} value={draft.title} />
            <TextInput
              multiline
              onChangeText={(description) => onChange({ ...draft, description })}
              placeholder="为什么想做这个目标？可以写得很短。"
              style={styles.taskNotesInput}
              value={draft.description}
            />
            <View style={styles.editSection}>
              <Text style={styles.editLabel}>领域</Text>
              <View style={styles.chipGrid}>
                {LIFE_AREAS.map((area) => (
                  <Pressable
                    key={area.type}
                    onPress={() => onChange({ ...draft, lifeArea: area.type })}
                    style={[styles.editChip, { borderColor: area.color }, draft.lifeArea === area.type && { backgroundColor: `${area.color}22` }]}
                  >
                    <Text style={styles.editChipText}>{area.icon} {area.label}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
            <View style={styles.editSection}>
              <Text style={styles.editLabel}>优先级</Text>
              <View style={styles.row}>
                {(['high', 'normal', 'low'] as GoalPriority[]).map((priority) => (
                  <Pressable key={priority} onPress={() => onChange({ ...draft, priority })} style={[styles.chip, draft.priority === priority && styles.chipSelected]}>
                    <Text style={draft.priority === priority ? styles.chipSelectedText : styles.chipText}>{priorityLabels[priority]}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
            <View style={styles.editSection}>
              <Text style={styles.editLabel}>目标日期</Text>
              <View style={styles.goalDateRow}>
                <Pressable onPress={onOpenTargetDate} style={styles.goalDateButton}>
                  <Text style={[styles.goalDateText, !draft.targetDate && styles.goalDatePlaceholder]}>
                    {draft.targetDate || '选择日期（可不填）'}
                  </Text>
                </Pressable>
                {draft.targetDate ? (
                  <Pressable onPress={() => onChange({ ...draft, targetDate: '' })} style={styles.goalDateClear}>
                    <Text style={styles.goalDateClearText}>清除</Text>
                  </Pressable>
                ) : null}
              </View>
            </View>
            <Pressable onPress={onSave} style={styles.primaryButton}><Text style={styles.primaryText}>保存目标</Text></Pressable>
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
  goalSheet: { maxHeight: '82%' },
  modalHeader: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 },
  modalTitle: { color: colors.ink, fontSize: 20, fontWeight: '600' },
  modalClose: { alignItems: 'center', backgroundColor: '#F7E8E3', borderRadius: 18, height: 36, justifyContent: 'center', width: 36 },
  modalCloseText: { color: '#B96F64', fontSize: 25, lineHeight: 28 },
  taskSheetContent: { gap: 14, paddingBottom: 34 },
  taskTitleInput: { borderBottomColor: colors.border, borderBottomWidth: 1, color: colors.ink, fontSize: 20, fontWeight: '500', minHeight: 46 },
  taskNotesInput: { backgroundColor: '#FFF7F1', borderRadius: 14, color: colors.ink, minHeight: 74, padding: 12, textAlignVertical: 'top' },
  editSection: { gap: 8 },
  editLabel: { color: colors.muted, fontSize: 13, fontWeight: '400' },
  chipGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  editChip: { backgroundColor: '#FFFFFF', borderRadius: 14, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 8 },
  editChipText: { color: colors.ink, fontSize: 12, fontWeight: '400' },
  row: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  chip: { borderColor: colors.border, borderRadius: 15, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 7 },
  chipSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { color: colors.muted },
  chipSelectedText: { color: '#FFFFFF' },
  goalDateRow: { alignItems: 'center', flexDirection: 'row', gap: 10 },
  goalDateButton: { backgroundColor: '#FFFFFF', borderColor: colors.border, borderRadius: 14, borderWidth: 1, flex: 1, justifyContent: 'center', minHeight: 44, paddingHorizontal: 12 },
  goalDateText: { color: colors.ink, fontSize: 14, fontWeight: '500', lineHeight: 20 },
  goalDatePlaceholder: { color: colors.muted, fontWeight: '400' },
  goalDateClear: { alignItems: 'center', backgroundColor: '#FFF0EC', borderRadius: 13, justifyContent: 'center', minHeight: 40, paddingHorizontal: 12 },
  goalDateClearText: { color: '#B96F64', fontSize: 13, fontWeight: '500' },
  primaryButton: { alignItems: 'center', backgroundColor: colors.primary, borderRadius: 12, paddingVertical: 11 },
  primaryText: { color: '#FFFFFF', fontWeight: '500' },
});
