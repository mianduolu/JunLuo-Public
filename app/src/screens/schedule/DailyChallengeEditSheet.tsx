import { memo } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppText as Text, AppTextInput as TextInput } from '../../components/AppText';
import type { DailyChallengeDraft } from '../../schedule/dailyChallengeStore';
import { categoryConfig, quadrantConfig } from '../../schedule/taskMeta';
import { colors } from '../../theme/colors';

export type DailyChallengeEditDraft = DailyChallengeDraft & { id?: string; estimatedMinutesText: string };

type Props = {
  draft: DailyChallengeEditDraft | null;
  keyboardLift: number;
  onArchive?: () => void;
  onChange: (draft: DailyChallengeEditDraft | null) => void;
  onClose: () => void;
  onSave: () => void;
};

export const DailyChallengeEditSheet = memo(function DailyChallengeEditSheet({
  draft,
  keyboardLift,
  onArchive,
  onChange,
  onClose,
  onSave,
}: Props) {
  const insets = useSafeAreaInsets();
  if (!draft) return null;
  return (
    <Modal animationType="slide" transparent visible onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.overlay}>
        <Pressable style={styles.backdrop} onPress={onClose} />
        <View style={[
          styles.sheet,
          { paddingBottom: Math.max(insets.bottom + 18, 34) },
          keyboardLift > 0 ? { transform: [{ translateY: -keyboardLift }] } : null,
        ]}>
          <View style={styles.header}>
            <Text style={styles.title}>{draft.id ? '编辑每日挑战' : '新建每日挑战'}</Text>
            <Pressable onPress={onClose} style={styles.close}><Text style={styles.closeText}>×</Text></Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
            <TextInput
              onChangeText={(title) => onChange({ ...draft, title })}
              placeholder="例如：画一张小速写"
              style={styles.titleInput}
              value={draft.title}
            />
            <View style={styles.section}>
              <Text style={styles.label}>分类</Text>
              <View style={styles.grid}>
                {categoryConfig.map((category) => (
                  <Pressable
                    key={category.id}
                    onPress={() => onChange({ ...draft, category: category.id })}
                    style={[styles.chip, { borderColor: category.color }, draft.category === category.id && { backgroundColor: `${category.color}22` }]}
                  >
                    <Text style={styles.chipText}>{category.icon} {category.label}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
            <View style={styles.section}>
              <Text style={styles.label}>象限</Text>
              <View style={styles.grid}>
                {quadrantConfig.map((quadrant) => (
                  <Pressable
                    key={quadrant.id}
                    onPress={() => onChange({ ...draft, quadrant: quadrant.id })}
                    style={[styles.chip, { borderColor: quadrant.border }, draft.quadrant === quadrant.id && { backgroundColor: quadrant.color }]}
                  >
                    <Text style={[styles.chipText, { color: quadrant.textColor }]}>{quadrant.title}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
            <View style={styles.section}>
              <Text style={styles.label}>每天预留多少分钟</Text>
              <TextInput
                keyboardType="number-pad"
                onChangeText={(estimatedMinutesText) => onChange({
                  ...draft,
                  estimatedMinutesText,
                  estimatedMinutes: Number(estimatedMinutesText),
                })}
                placeholder="必填，例如 30"
                style={styles.input}
                value={draft.estimatedMinutesText}
              />
              <Text style={styles.hint}>它会占用排程容量，但不会被锁进某个具体时段。</Text>
            </View>
            {onArchive ? <Pressable onPress={onArchive} style={styles.archive}><Text style={styles.archiveText}>归档挑战</Text></Pressable> : null}
            <Pressable onPress={onSave} style={styles.save}><Text style={styles.saveText}>保存挑战</Text></Pressable>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
});

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(35, 39, 55, 0.28)' },
  sheet: { backgroundColor: '#FFFDF9', borderTopLeftRadius: 24, borderTopRightRadius: 24, maxHeight: '86%', paddingHorizontal: 18, paddingTop: 16 },
  header: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 },
  title: { color: colors.ink, fontSize: 20, fontWeight: '600' },
  close: { alignItems: 'center', backgroundColor: '#F7E8E3', borderRadius: 18, height: 36, justifyContent: 'center', width: 36 },
  closeText: { color: '#B96F64', fontSize: 25, lineHeight: 28 },
  content: { gap: 15, paddingBottom: 34 },
  titleInput: { borderBottomColor: colors.border, borderBottomWidth: 1, color: colors.ink, fontSize: 20, fontWeight: '500', minHeight: 46 },
  section: { gap: 8 },
  label: { color: colors.muted, fontSize: 13, fontWeight: '400' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { backgroundColor: '#FFFFFF', borderRadius: 14, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 8 },
  chipText: { color: colors.ink, fontSize: 12, fontWeight: '400' },
  input: { backgroundColor: '#FFFFFF', borderColor: colors.border, borderRadius: 14, borderWidth: 1, color: colors.ink, minHeight: 44, paddingHorizontal: 12 },
  hint: { color: colors.muted, fontSize: 12, fontWeight: '400' },
  archive: { alignItems: 'center', backgroundColor: '#FFF0EC', borderColor: '#F4B4A5', borderRadius: 13, borderWidth: 1, paddingVertical: 11 },
  archiveText: { color: '#C8796E', fontWeight: '500' },
  save: { alignItems: 'center', backgroundColor: colors.primary, borderRadius: 12, paddingVertical: 11 },
  saveText: { color: '#FFFFFF', fontWeight: '500' },
});
