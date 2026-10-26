import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Switch, View } from 'react-native';
import { AppText as Text, AppTextInput as TextInput } from '../components/AppText';
import { DateTimePickerSheet } from '../components/DateTimePickerSheet';
import { clockFromTimestamp, combineDateTime, dateKeyFromTimestamp, type DateTimeSelection } from '../schedule/dateTimeSelection';
import { chatScheduleReminderAt } from '../schedule/chatSchedulePlanPolicy';
import type { DayPlanChange, DayPlanEntry } from '../schedule/dayPlan';
import { styles } from '../screens/ChatScreen.styles';
import { formatChatDateTime } from './chatScheduleText';

type Props = {
  entries: DayPlanEntry[];
  editable: boolean;
  onEditEntry?: (entryId: string, change: DayPlanChange) => void;
  onRemoveEntry?: (entryId: string) => void;
  onSetEndQuestions?: (enabled: boolean) => void;
};

function ReminderLead({ entry, editable, onChange }: {
  entry: DayPlanEntry;
  editable: boolean;
  onChange: (minutes: number) => void;
}) {
  const [text, setText] = useState(String(entry.reminderMinutesBefore));
  useEffect(() => setText(String(entry.reminderMinutesBefore)), [entry.reminderMinutesBefore]);
  return (
    <View style={rowStyles.inline}>
      <Text style={styles.unscheduledText}>提前</Text>
      <TextInput
        accessibilityLabel={`${entry.title}提前提醒分钟数`}
        editable={editable}
        keyboardType="number-pad"
        onBlur={() => setText(String(entry.reminderMinutesBefore))}
        onChangeText={(value) => {
          if (!/^\d*$/.test(value)) return;
          setText(value);
          if (value && Number.isSafeInteger(Number(value))) onChange(Number(value));
        }}
        selectTextOnFocus
        style={rowStyles.minuteInput}
        value={text}
      />
      <Text style={styles.unscheduledText}>分钟提醒</Text>
    </View>
  );
}

export function ChatDayPlanRows({ entries, editable, onEditEntry, onRemoveEntry, onSetEndQuestions }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [editor, setEditor] = useState<{ entry: DayPlanEntry; field: 'date' | 'start' | 'end' } | null>(null);
  const editorEntry = editor && entries.find((entry) => entry.id === editor.entry.id);
  const editorValid = !!editor && editorEntry === editor.entry && editable && !editorEntry.saved && !editorEntry.scheduleSaved;
  const startAt = editor?.entry.startAt;
  const selection: DateTimeSelection | null = startAt === undefined ? null : {
    date: dateKeyFromTimestamp(editor?.field === 'end' ? editor.entry.endAt ?? startAt : startAt),
    time: clockFromTimestamp(startAt),
    endTime: editor?.entry.endAt === undefined ? undefined : clockFromTimestamp(editor.entry.endAt),
    recurrence: 'none', reminderChoice: 'none', reminderClock: '09:00', reminderIntensity: 'gentle',
  };
  return (
    <>
      {editable && onSetEndQuestions ? <View style={rowStyles.toggle}>
        <Text style={[styles.unscheduledText, rowStyles.toggleLabel]}>本计划结束询问</Text>
        <Switch value={entries.some(entry => entry.endAt !== undefined && entry.companionEnabled)}
          onValueChange={onSetEndQuestions} />
      </View> : null}
      {entries.map((entry) => {
        const canEdit = editable && !entry.saved && !entry.scheduleSaved && !!onEditEntry;
        const organizedHabit = entry.action === 'inbox' && !!entry.steps?.length && !!entry.repeat;
        const timed = entry.action === 'schedule' || organizedHabit;
        return (
          <View key={entry.id} style={rowStyles.entry}>
            {entry.parentTodoId ? <Text style={styles.scheduleMeta}>步骤 {entry.stepOrder ?? ''}</Text> : null}
            <TextInput accessibilityLabel="事情" style={styles.groupScheduleTitle} value={entry.title} editable={canEdit}
              onChangeText={title => onEditEntry?.(entry.id, { title })} />
            {entry.notes ? <Text style={styles.scheduleMeta}>{entry.notes}</Text> : null}
            {entry.saved ? <Text style={styles.adjustmentHint}>{entry.action === 'cancel' ? '已取消' : '已保存'}</Text> : null}
            {entry.habitSaved && !entry.saved ? <Text style={styles.scheduleMeta}>习惯规则已保存，安排仍待补齐</Text> : null}
            {entry.action === 'cancel' && !entry.saved ? <Text style={styles.adjustmentHint}>待取消 · 确认后取消这项日程</Text> : null}
            {entry.action === 'inbox' ? <Text style={styles.unscheduledText}>{organizedHabit ? '习惯时间 · 本次按下面的小步骤进行' : '待办池 · 未定时间'}</Text> : null}
            {entry.action === 'cancel' && entry.startAt !== undefined ? <Text style={styles.unscheduledText}>{formatChatDateTime(entry.startAt)}</Text> : null}
            {timed ? (
              <>
                <Pressable disabled={!canEdit} onPress={() => setEditor({ entry, field: 'date' })} style={rowStyles.timeButton} accessibilityRole="button">
                  <Text style={styles.unscheduledText}>日期：{entry.startAt === undefined ? '未设置' : dateKeyFromTimestamp(entry.startAt)}</Text>
                </Pressable>
                <Pressable disabled={!canEdit} onPress={() => setEditor({ entry, field: 'start' })} style={rowStyles.timeButton} accessibilityRole="button">
                  <Text style={styles.unscheduledText}>开始：{entry.startAt === undefined ? '未设置' : clockFromTimestamp(entry.startAt)}{entry.startSuggested ? '（建议）' : ''}</Text>
                </Pressable>
                {expanded.has(entry.id) ? <View style={rowStyles.inline}>
                  <Pressable disabled={!canEdit} onPress={() => setEditor({ entry, field: 'end' })} style={rowStyles.timeButton} accessibilityRole="button">
                    <Text style={styles.unscheduledText}>结束：{entry.endAt === undefined ? '未设置' : formatChatDateTime(entry.endAt)}{entry.endAt !== undefined && entry.endSuggested ? '（建议）' : ''}</Text>
                  </Pressable>
                  {canEdit && entry.endAt !== undefined ? <Pressable hitSlop={8} onPress={() => onEditEntry?.(entry.id, { endAt: undefined, companionEnabled: false })}><Text style={styles.candidateDismissText}>清除结束</Text></Pressable> : null}
                </View> : null}
                <View style={rowStyles.inline}>
                  <Text style={styles.unscheduledText}>时长：</Text>
                  <TextInput accessibilityLabel={`${entry.title}时长分钟数`} editable={canEdit} keyboardType="number-pad"
                    style={rowStyles.minuteInput} value={String(entry.durationMinutes ?? (entry.endAt === undefined ? '' : (entry.endAt - entry.startAt!) / 60000))}
                    onChangeText={value => { if (/^\d+$/u.test(value) && Number(value) > 0) onEditEntry?.(entry.id, { durationMinutes: Number(value) }); }} />
                  <Text style={styles.unscheduledText}>分钟{entry.endSuggested ? '（建议）' : ''}{entry.endMode === 'fixed' ? ' · 固定结束' : ''}</Text>
                </View>
                <Pressable accessibilityRole="button" onPress={() => setExpanded(current => { const next = new Set(current); if (next.has(entry.id)) next.delete(entry.id); else next.add(entry.id); return next; })}>
                  <Text style={styles.candidateDismissText}>{expanded.has(entry.id) ? '收起更多设置' : '更多设置'}</Text>
                </Pressable>
                {expanded.has(entry.id) ? <>
                <View style={rowStyles.toggle}>
                  <Text style={[styles.unscheduledText, rowStyles.toggleLabel]}>开始提醒</Text>
                  <Switch disabled={!canEdit} value={entry.startReminderEnabled !== false} onValueChange={startReminderEnabled => onEditEntry?.(entry.id, { startReminderEnabled })} />
                </View>
                <ReminderLead entry={entry} editable={canEdit && entry.startReminderEnabled !== false} onChange={(reminderMinutesBefore) => onEditEntry?.(entry.id, { reminderMinutesBefore })} />
                {entry.startAt !== undefined && entry.startReminderEnabled !== false ? <Text style={styles.scheduleMeta}>提醒时间：{formatChatDateTime(chatScheduleReminderAt(entry.startAt, entry.reminderMinutesBefore, Date.now()))}</Text> : null}
                <View style={rowStyles.toggle}>
                  <Text style={[styles.unscheduledText, rowStyles.toggleLabel]}>结束时来问问我</Text>
                  <Switch
                    accessibilityLabel={`${entry.title}结束时来问问我`}
                    disabled={!canEdit || entry.endAt === undefined}
                    value={entry.endAt !== undefined && entry.companionEnabled}
                    onValueChange={(companionEnabled) => onEditEntry?.(entry.id, { companionEnabled })}
                    trackColor={{ false: '#E7E1EF', true: '#B2D9FF' }}
                    thumbColor={entry.endAt !== undefined && entry.companionEnabled ? '#5C9DD8' : '#FFFFFF'}
                  />
                </View>
                {entry.repeat ? <Text style={styles.scheduleMeta}>重复：{entry.repeat.frequency === 'daily' ? '每天' : entry.repeat.frequency === 'weekly' ? `星期 ${entry.repeat.weekDays?.join('、')}` : `完成后隔 ${entry.repeat.intervalDays} 天`}{entry.habitId ? entry.scope === 'once' ? ' · 只改本次' : ' · 从本次起' : ''}</Text> : null}
                {canEdit ? <View style={rowStyles.inline}>
                  {(['daily', 'weekly', 'interval'] as const).map(frequency => <Pressable key={frequency} onPress={() => onEditEntry?.(entry.id, { repeat: {
                    frequency, ...(frequency === 'weekly' ? { weekDays: entry.repeat?.weekDays ?? [1] } : {}),
                    ...(frequency === 'interval' ? { intervalDays: entry.repeat?.intervalDays ?? 1 } : {}),
                  } })}><Text style={styles.candidateDismissText}>{frequency === 'daily' ? '每天' : frequency === 'weekly' ? '固定星期几' : '每隔几天'}</Text></Pressable>)}
                </View> : null}
                {canEdit && entry.repeat?.frequency === 'weekly' ? <View style={rowStyles.inline}>
                  {[1, 2, 3, 4, 5, 6, 7].map(day => <Pressable key={day} onPress={() => { const days = new Set(entry.repeat!.weekDays); if (days.has(day)) days.delete(day); else days.add(day);
                    if (days.size) onEditEntry?.(entry.id, { repeat: { frequency: 'weekly', weekDays: [...days].sort() } }); }}>
                    <Text style={styles.candidateDismissText}>{entry.repeat?.weekDays?.includes(day) ? '✓' : ''}{day === 7 ? '日' : day}</Text>
                  </Pressable>)}
                </View> : null}
                {canEdit && entry.repeat?.frequency === 'interval' ? <TextInput accessibilityLabel="间隔天数" keyboardType="number-pad" style={rowStyles.minuteInput}
                  value={String(entry.repeat.intervalDays)} onChangeText={value => { if (/^\d+$/u.test(value) && Number(value) > 0) onEditEntry?.(entry.id, { repeat: { frequency: 'interval', intervalDays: Number(value) } }); }} /> : null}
                {canEdit && entry.habitId ? <View style={rowStyles.inline}>
                  <Pressable onPress={() => onEditEntry?.(entry.id, { scope: 'once' })}><Text style={styles.candidateDismissText}>只改本次</Text></Pressable>
                  <Pressable onPress={() => onEditEntry?.(entry.id, { scope: 'future' })}><Text style={styles.candidateDismissText}>从本次起</Text></Pressable>
                </View> : null}
                </> : null}
              </>
            ) : null}
            {entry.error ? <Text style={rowStyles.error}>未成功：{entry.error}</Text> : null}
            {editable && !entry.saved && !entry.scheduleSaved && entry.action !== 'cancel' && onRemoveEntry ? (
              <Pressable hitSlop={8} onPress={() => onRemoveEntry(entry.id)} style={rowStyles.remove}>
                <Text style={styles.candidateDismissText}>{entry.occurrenceId ? '取消这项日程' : '移除这项'}</Text>
              </Pressable>
            ) : null}
          </View>
        );
      })}
      {editorValid && selection ? (
        <DateTimePickerSheet
          visible
          dateOnly={editor.field === 'date'}
          timeOnly={editor.field !== 'date'}
          timeOnlyTarget={editor.field === 'end' ? 'end' : 'start'}
          title={editor.field === 'date' ? '调整日期' : editor.field === 'end' ? '调整结束时间' : '调整开始时间'}
          value={selection}
          onClose={() => setEditor(null)}
          onConfirm={(value) => {
            if (value && editorValid) {
              if (editor.field === 'date' && value.time) {
                const nextStart = combineDateTime(value.date, value.time);
                onEditEntry?.(editor.entry.id, { startAt: nextStart });
              } else if (editor.field === 'start' && value.time) {
                onEditEntry?.(editor.entry.id, { startAt: combineDateTime(value.date, value.time) });
              } else if (editor.field === 'end') {
                onEditEntry?.(editor.entry.id, value.endTime
                  ? { endAt: combineDateTime(value.date, value.endTime) }
                  : { endAt: undefined, companionEnabled: false });
              }
            }
            setEditor(null);
          }}
        />
      ) : null}
    </>
  );
}

const rowStyles = StyleSheet.create({
  entry: { paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#E7E1EF', gap: 5 },
  inline: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  timeButton: { paddingVertical: 7 },
  minuteInput: { minWidth: 55, maxWidth: 95, paddingHorizontal: 8, paddingVertical: 5, borderWidth: 1, borderColor: '#D5C9DF', borderRadius: 8, color: '#514858', backgroundColor: '#FFFFFF', textAlign: 'center' },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  toggleLabel: { flex: 1 },
  remove: { alignSelf: 'flex-start', paddingVertical: 7 },
  error: { color: '#AB4848', fontSize: 13 },
});
