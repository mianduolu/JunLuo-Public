import { memo } from 'react';
import { Pressable, StyleSheet, Switch, View } from 'react-native';

import { AppText as Text, AppTextInput as TextInput } from '../../components/AppText';
import { buildRecurrenceRule, formatRecurrenceLabel } from '../../schedule/calendarRules';
import type { ScheduleRecurrence, ScheduleReminderIntensity, ScheduleSource } from '../../schedule/scheduleStore';
import { colors } from '../../theme/colors';

export type EditableDraft = {
  companionEnabled: boolean;
  startReminderEnabled?: boolean;
  date: string;
  endTime: string;
  endTimeDate?: string;
  estimateMinutes?: number;
  letterTicketEnabled: boolean;
  notes: string;
  rangeEndDate?: string;
  recurrence: ScheduleRecurrence;
  reminderMinutes: string;
  reminderIntensity: ScheduleReminderIntensity;
  reminderText: string;
  source: ScheduleSource;
  time: string;
  title: string;
};

type Props = {
  draft: EditableDraft;
  onChange: (draft: EditableDraft) => void;
  onOpenDateTime: () => void;
  onRemove: () => void;
};

function draftStartAt(draft: EditableDraft) {
  return new Date(`${draft.date}T${draft.time}:00`).getTime();
}

export const DraftEditor = memo(function DraftEditor({ draft, onChange, onOpenDateTime, onRemove }: Props) {
  return (
    <View style={styles.editor}>
      <TextInput onChangeText={(title) => onChange({ ...draft, title })} placeholder="要做什么" style={styles.input} value={draft.title} />
      <Pressable onPress={onOpenDateTime} style={styles.dateSummaryCard}>
        <Text style={styles.dateSummaryTitle}>{draft.date} {draft.time}</Text>
        <Text style={styles.dateSummaryMeta}>
          {[
            draft.endTime ? `结束 ${draft.endTimeDate && draft.endTimeDate !== draft.date ? `${draft.endTimeDate} ` : ''}${draft.endTime}` : '',
            draft.rangeEndDate ? `至 ${draft.rangeEndDate}` : '',
            draft.startReminderEnabled === false ? '无提醒'
              : draft.reminderMinutes === '0' ? '准时提醒' : `提前 ${draft.reminderMinutes} 分钟`,
            formatRecurrenceLabel(buildRecurrenceRule(draft.recurrence, draftStartAt(draft))),
          ].filter(Boolean).join(' · ')}
        </Text>
      </Pressable>
      <TextInput onChangeText={(notes) => onChange({ ...draft, notes })} placeholder="补充说明（可不写）" style={styles.input} value={draft.notes} />
      <View style={styles.toggleRow}>
        <View style={styles.toggleCopy}>
          <Text style={styles.toggleLabel}>结束时来问问我</Text>
          <Text style={styles.toggleHint}>没回应时再追问一次</Text>
        </View>
        <Switch
          onValueChange={(companionEnabled) => onChange({ ...draft, companionEnabled })}
          trackColor={{ false: '#E7E1EF', true: '#F2A8BE' }}
          thumbColor={draft.companionEnabled ? '#C95F82' : '#FFFFFF'}
          value={draft.companionEnabled}
        />
      </View>
      <View style={styles.toggleRow}>
        <Text style={styles.toggleLabel}>允许白云为这个日子留信</Text>
        <Switch
          onValueChange={(letterTicketEnabled) => onChange({ ...draft, letterTicketEnabled })}
          trackColor={{ false: '#E7E1EF', true: '#F2A8BE' }}
          thumbColor={draft.letterTicketEnabled ? '#C95F82' : '#FFFFFF'}
          value={draft.letterTicketEnabled}
        />
      </View>
      <Pressable onPress={onRemove} style={styles.dangerButton}>
        <Text style={styles.danger}>移除这一条</Text>
      </Pressable>
    </View>
  );
});

const styles = StyleSheet.create({
  editor: { backgroundColor: colors.card, borderRadius: 15, gap: 9, marginTop: 8, padding: 12 },
  input: { borderColor: colors.border, borderRadius: 10, borderWidth: 1, color: colors.ink, height: 42, paddingHorizontal: 10 },
  dateSummaryCard: { backgroundColor: '#FFFFFF', borderColor: '#E4E1F5', borderRadius: 16, borderWidth: 1, gap: 6, padding: 14 },
  dateSummaryTitle: { color: colors.ink, fontSize: 17, fontWeight: '500' },
  dateSummaryMeta: { color: colors.muted, fontSize: 12, fontWeight: '400', lineHeight: 18 },
  toggleRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 2, paddingVertical: 4 },
  toggleCopy: { flex: 1, paddingRight: 12 },
  toggleHint: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  toggleLabel: { color: colors.ink, flex: 1, fontSize: 14, paddingRight: 12 },
  dangerButton: { alignSelf: 'flex-start', borderRadius: 12, paddingHorizontal: 10, paddingVertical: 10 },
  danger: { color: '#C8796E', fontWeight: '600' },
});
