import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppText as Text, AppTextInput as TextInput } from '../components/AppText';
import { colors } from '../theme/colors';
import { loadLetters } from './letterStore';
import {
  getLunarFieldsForDateKey,
  getNextRelationshipDateOccurrence,
  type RelationshipDateMode,
  type RelationshipDateV1,
} from './relationshipDateCalendar';
import {
  deleteRelationshipDate,
  loadRelationshipDates,
  makeDefaultRelationshipDateDraft,
  upsertRelationshipDate,
  type RelationshipDateDraft,
} from './relationshipDateStore';

type Props = {
  onOpenFeatureDrawer: () => void;
};

const MODE_OPTIONS: Array<{ label: string; value: RelationshipDateMode }> = [
  { label: '每年公历', value: 'solar_yearly' },
  { label: '每年农历', value: 'lunar_yearly' },
  { label: '仅这一次', value: 'once' },
];

function formatMinutes(minutes: number) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function parseMinutes(value: string) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 ? hour * 60 + minute : null;
}

function recordDraft(record: RelationshipDateV1): RelationshipDateDraft {
  return {
    id: record.id,
    title: record.title,
    note: record.note,
    mode: record.mode,
    originDateKey: record.originDateKey,
    openTimeMinutes: record.openTimeMinutes,
    letterEnabled: record.letterEnabled,
  };
}

function dateModeText(record: RelationshipDateV1) {
  if (record.mode === 'solar_yearly') return `每年公历 · ${record.originDateKey.slice(5)}`;
  if (record.mode === 'once') return `仅这一次 · ${record.originDateKey}`;
  const lunar = getLunarFieldsForDateKey(record.originDateKey);
  return lunar
    ? `每年农历 · ${lunar.lunarIsLeapMonth ? '闰' : ''}${lunar.lunarMonth} 月 ${lunar.lunarDay} 日`
    : '每年农历';
}

export function RelationshipDatesFeature({ onOpenFeatureDrawer }: Props) {
  const insets = useSafeAreaInsets();
  const [records, setRecords] = useState<RelationshipDateV1[]>([]);
  const [waitingDateIds, setWaitingDateIds] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState<RelationshipDateDraft | null>(null);
  const [timeText, setTimeText] = useState('09:00');
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    const now = Date.now();
    const [nextRecords, letters] = await Promise.all([loadRelationshipDates(now), loadLetters()]);
    setRecords(nextRecords);
    setWaitingDateIds(new Set(
      letters
        .filter((letter) => letter.kind === 'future-self' && letter.status === 'sealed' && (letter.dueAt ?? 0) > now)
        .map((letter) => letter.dateTicketId)
        .filter((id): id is string => !!id),
    ));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const beginEdit = (nextDraft: RelationshipDateDraft) => {
    setDraft(nextDraft);
    setTimeText(formatMinutes(nextDraft.openTimeMinutes));
  };

  const saveDraft = async () => {
    if (!draft || saving) return;
    const minutes = parseMinutes(timeText);
    if (minutes === null) {
      Alert.alert('开信时间无效', '请使用 00:00 到 23:59 的时间。');
      return;
    }
    setSaving(true);
    try {
      const saved = await upsertRelationshipDate({ ...draft, openTimeMinutes: minutes });
      if (!saved) throw new Error('data-epoch-changed');
      setDraft(null);
      await refresh();
    } catch (error) {
      Alert.alert('保存失败', error instanceof Error ? error.message : '纪念日没有保存成功。');
    } finally {
      setSaving(false);
    }
  };

  const removeDraft = () => {
    if (!draft?.id) return;
    Alert.alert(
      '删除纪念日',
      '删除只影响以后的日期票；已经封存的未来信会保留原来的开信日期。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '删除纪念日',
          style: 'destructive',
          onPress: () => {
            const id = draft.id!;
            void deleteRelationshipDate(id).then(async (removed) => {
              if (!removed) return;
              setDraft(null);
              await refresh();
            });
          },
        },
      ],
    );
  };

  const toggleLetter = async (record: RelationshipDateV1, letterEnabled: boolean) => {
    const saved = await upsertRelationshipDate({ ...recordDraft(record), letterEnabled }).catch(() => null);
    if (!saved) {
      Alert.alert('保存失败', '留信开关没有保存成功。');
      return;
    }
    await refresh();
  };

  const listRows = useMemo(() => records.map((record) => ({
    next: getNextRelationshipDateOccurrence(record),
    record,
  })), [records]);

  return (
    <ScrollView
      contentContainerStyle={[styles.content, { paddingBottom: Math.max(28, insets.bottom + 20), paddingTop: Math.max(18, insets.top + 8) }]}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.header}>
        <Pressable onPress={onOpenFeatureDrawer} style={styles.menuButton}>
          <Text style={styles.menuText}>☰</Text>
        </Pressable>
        <Text style={styles.title}>纪念日</Text>
      </View>

      {draft ? (
        <View style={styles.editor}>
          <Text style={styles.fieldLabel}>纪念日名称</Text>
          <TextInput
            maxLength={80}
            onChangeText={(title) => setDraft((current) => current ? { ...current, title } : current)}
            style={styles.input}
            value={draft.title}
          />

          <Text style={styles.fieldLabel}>日期方式</Text>
          <View style={styles.modeRow}>
            {MODE_OPTIONS.map((option) => (
              <Pressable
                key={option.value}
                onPress={() => setDraft((current) => current ? { ...current, mode: option.value } : current)}
                style={[styles.modeButton, draft.mode === option.value && styles.modeButtonActive]}
              >
                <Text style={[styles.modeText, draft.mode === option.value && styles.modeTextActive]}>{option.label}</Text>
              </Pressable>
            ))}
          </View>

          <Text style={styles.fieldLabel}>日期</Text>
          <TextInput
            maxLength={10}
            onChangeText={(originDateKey) => setDraft((current) => current ? { ...current, originDateKey } : current)}
            placeholder="YYYY-MM-DD"
            style={styles.input}
            value={draft.originDateKey}
          />

          <Text style={styles.fieldLabel}>开信时间</Text>
          <TextInput maxLength={5} onChangeText={setTimeText} placeholder="09:00" style={styles.input} value={timeText} />

          <Text style={styles.fieldLabel}>备注</Text>
          <TextInput
            maxLength={1000}
            multiline
            onChangeText={(note) => setDraft((current) => current ? { ...current, note } : current)}
            style={[styles.input, styles.noteInput]}
            value={draft.note ?? ''}
          />

          <View style={styles.switchRow}>
            <Text style={styles.switchLabel}>允许白云为这个日子留信</Text>
            <Switch
              onValueChange={(letterEnabled) => setDraft((current) => current ? { ...current, letterEnabled } : current)}
              thumbColor="#FFFFFF"
              trackColor={{ false: 'rgba(56,64,82,0.18)', true: 'rgba(255,161,138,0.62)' }}
              value={draft.letterEnabled}
            />
          </View>

          <View style={styles.actions}>
            <Pressable disabled={saving} onPress={() => void saveDraft()} style={styles.saveButton}>
              <Text style={styles.saveText}>保存</Text>
            </Pressable>
            <Pressable onPress={() => setDraft(null)} style={styles.cancelButton}>
              <Text style={styles.cancelText}>取消</Text>
            </Pressable>
          </View>
          {draft.id ? (
            <Pressable onPress={removeDraft} style={styles.deleteButton}>
              <Text style={styles.deleteText}>删除纪念日</Text>
            </Pressable>
          ) : null}
        </View>
      ) : (
        <Pressable onPress={() => beginEdit(makeDefaultRelationshipDateDraft())} style={styles.addButton}>
          <Text style={styles.addText}>+ 记下一个日子</Text>
        </Pressable>
      )}

      {listRows.length ? listRows.map(({ next, record }) => (
        <View key={record.id} style={styles.card}>
          <View style={styles.cardHeading}>
            <Pressable onPress={() => beginEdit(recordDraft(record))} style={styles.cardCopy}>
              <Text style={styles.cardTitle}>{record.title}</Text>
              <Text style={styles.cardMeta}>{dateModeText(record)} · {formatMinutes(record.openTimeMinutes)}</Text>
              {next ? <Text style={styles.cardNext}>下一次：{new Date(next.scheduledAt).toLocaleString('zh-CN')}</Text> : null}
              {record.note ? <Text numberOfLines={3} style={styles.cardNote}>{record.note}</Text> : null}
              {next && waitingDateIds.has(next.id) ? <Text style={styles.letterWaiting}>有一封信在等这一天</Text> : null}
            </Pressable>
            <Switch
              onValueChange={(value) => void toggleLetter(record, value)}
              thumbColor="#FFFFFF"
              trackColor={{ false: 'rgba(56,64,82,0.18)', true: 'rgba(255,161,138,0.62)' }}
              value={record.letterEnabled}
            />
          </View>
        </View>
      )) : (
        <View style={styles.emptyCard}>
          <Text style={styles.emptyText}>还没有记下纪念日。</Text>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 20, rowGap: 14 },
  header: { alignItems: 'center', flexDirection: 'row', gap: 14 },
  menuButton: { alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.72)', borderColor: colors.border, borderRadius: 8, borderWidth: 1, height: 38, justifyContent: 'center', minWidth: 58 },
  menuText: { color: colors.ink, fontSize: 26, fontWeight: '600', lineHeight: 28 },
  title: { color: colors.ink, fontSize: 24, fontWeight: '700' },
  addButton: { alignItems: 'center', backgroundColor: '#FFF4F1', borderColor: 'rgba(244,139,132,0.42)', borderRadius: 18, borderWidth: 1, padding: 15 },
  addText: { color: colors.primary, fontSize: 16, fontWeight: '700' },
  card: { backgroundColor: 'rgba(255,255,255,0.9)', borderColor: colors.border, borderRadius: 20, borderWidth: 1, padding: 16 },
  cardHeading: { alignItems: 'flex-start', flexDirection: 'row', gap: 12 },
  cardCopy: { flex: 1 },
  cardTitle: { color: colors.ink, fontSize: 18, fontWeight: '700' },
  cardMeta: { color: colors.muted, fontSize: 13, marginTop: 5 },
  cardNext: { color: '#5E708D', fontSize: 13, marginTop: 8 },
  cardNote: { color: colors.ink, fontSize: 14, lineHeight: 21, marginTop: 9 },
  letterWaiting: { color: colors.primary, fontSize: 13, fontWeight: '700', marginTop: 10 },
  emptyCard: { alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.76)', borderColor: colors.border, borderRadius: 20, borderWidth: 1, padding: 28 },
  emptyText: { color: colors.muted, fontSize: 15 },
  editor: { backgroundColor: 'rgba(255,255,255,0.94)', borderColor: colors.border, borderRadius: 20, borderWidth: 1, padding: 16 },
  fieldLabel: { color: colors.ink, fontSize: 14, fontWeight: '600', marginBottom: 7, marginTop: 12 },
  input: { backgroundColor: '#F8FAFF', borderColor: colors.border, borderRadius: 12, borderWidth: 1, color: colors.ink, fontSize: 15, minHeight: 46, paddingHorizontal: 12, paddingVertical: 10 },
  noteInput: { minHeight: 92, textAlignVertical: 'top' },
  modeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  modeButton: { backgroundColor: '#F7F8FC', borderColor: colors.border, borderRadius: 14, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 9 },
  modeButtonActive: { backgroundColor: '#FFF1ED', borderColor: 'rgba(244,139,132,0.5)' },
  modeText: { color: colors.muted, fontSize: 13 },
  modeTextActive: { color: colors.primary, fontWeight: '700' },
  switchRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', marginTop: 18 },
  switchLabel: { color: colors.ink, flex: 1, fontSize: 15, fontWeight: '600', paddingRight: 12 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 20 },
  saveButton: { alignItems: 'center', backgroundColor: colors.primary, borderRadius: 14, flex: 1, padding: 13 },
  saveText: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
  cancelButton: { alignItems: 'center', backgroundColor: '#F2F4F9', borderRadius: 14, flex: 1, padding: 13 },
  cancelText: { color: colors.ink, fontSize: 15, fontWeight: '600' },
  deleteButton: { alignItems: 'center', marginTop: 12, padding: 10 },
  deleteText: { color: '#B85E5E', fontSize: 14, fontWeight: '600' },
});
