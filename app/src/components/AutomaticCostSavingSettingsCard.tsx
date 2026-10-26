import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Switch, View } from 'react-native';

import { AppText as Text, AppTextInput as TextInput } from './AppText';
import { normalizeCostSavingSettings, type CostSavingSettings } from '../runtime/automaticRemoteAiPolicyCore';

const clockText = (minute: number) => `${Math.floor(minute / 60).toString().padStart(2, '0')}:${(minute % 60).toString().padStart(2, '0')}`;
const draftFrom = (value?: CostSavingSettings) => {
  const settings = normalizeCostSavingSettings(value);
  return { ...settings, windows: settings.windows.map(window => ({ enabled: window.enabled,
    start: clockText(window.startMinute), end: clockText(window.endMinute) })) };
};
const parseClock = (value: string) => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  return match && Number(match[1]) < 24 && Number(match[2]) < 60 ? Number(match[1]) * 60 + Number(match[2]) : null;
};

export function AutomaticCostSavingSettingsCard({ value, saving, onSave }: {
  value?: CostSavingSettings;
  saving: boolean;
  onSave: (settings: CostSavingSettings) => Promise<void>;
}) {
  const [draft, setDraft] = useState(() => draftFrom(value));
  const [notice, setNotice] = useState('');
  useEffect(() => { setDraft(draftFrom(value)); }, [value]);
  const save = async () => {
    const windows = draft.windows.map(window => ({ enabled: window.enabled,
      startMinute: parseClock(window.start), endMinute: parseClock(window.end) }));
    if (windows.some(window => window.startMinute === null || window.endMinute === null)) {
      setNotice('请按 09:00 这样的格式填写时间，范围为 00:00–23:59。'); return;
    }
    if (windows.some(window => window.startMinute === window.endMinute)) {
      setNotice('同一时段的开始和结束不能相同。'); return;
    }
    setNotice('');
    try {
      await onSave({ ...draft, windows: windows as CostSavingSettings['windows'] });
      setNotice('省钱时段已保存，仅在本机生效。');
    } catch { setNotice('省钱时段没有保存，请稍后再试。'); }
  };
  return <View style={styles.card}>
    <View style={styles.heading}>
      <View style={styles.copy}>
        <Text style={styles.title}>省钱时段</Text>
        <Text style={styles.text}>固定北京时间 · 仅 DeepSeek 官方 HTTPS 接口</Text>
      </View>
      <Switch accessibilityLabel="启用省钱时段" disabled={saving} value={draft.enabled}
        onValueChange={enabled => { setDraft({ ...draft, enabled }); setNotice(''); }}
        thumbColor={draft.enabled ? '#FFFFFF' : '#F8F5F2'} trackColor={{ false: '#DFE5EA', true: '#A9D3FA' }} />
    </View>
    <Text style={styles.label}>适用星期</Text>
    <View style={styles.days}>
      {([1, 2, 3, 4, 5, 6, 0] as const).map(day => {
        const selected = draft.weekdays.includes(day);
        return <Pressable key={day} accessibilityRole="checkbox" accessibilityState={{ checked: selected }}
          accessibilityLabel={`星期${'日一二三四五六'[day]}`} disabled={saving}
          onPress={() => { setDraft({ ...draft, weekdays: selected ? draft.weekdays.filter(item => item !== day) : [...draft.weekdays, day].sort() }); setNotice(''); }}
          style={[styles.day, selected && styles.daySelected]}>
          <Text style={[styles.dayText, selected && styles.dayTextSelected]}>{'日一二三四五六'[day]}</Text>
        </Pressable>;
      })}
    </View>
    {draft.windows.map((window, index) => <View key={index} style={styles.window}>
      <View style={styles.heading}>
        <Text style={styles.windowTitle}>时段 {index + 1}</Text>
        <Switch accessibilityLabel={`启用时段 ${index + 1}`} disabled={saving} value={window.enabled}
          onValueChange={enabled => { setDraft({ ...draft, windows: draft.windows.map((item, i) => i === index ? { ...item, enabled } : item) }); setNotice(''); }}
          thumbColor={window.enabled ? '#FFFFFF' : '#F8F5F2'} trackColor={{ false: '#DFE5EA', true: '#A9D3FA' }} />
      </View>
      <View style={styles.clockRow}>
        {(['start', 'end'] as const).map((key, position) => <View key={key} style={styles.clockGroup}>
          {position === 1 ? <Text style={styles.separator}>—</Text> : null}
          <TextInput accessibilityLabel={`时段 ${index + 1}${key === 'start' ? '开始' : '结束'}时间`}
            editable={!saving} maxLength={5} autoCorrect={false} autoCapitalize="none" selectTextOnFocus
            placeholder={key === 'start' ? '09:00' : '12:00'} placeholderTextColor="#91A4B6"
            value={window[key]} onChangeText={text => { setDraft({ ...draft, windows: draft.windows.map((item, i) => i === index ? { ...item, [key]: text } : item) }); setNotice(''); }}
            style={styles.clockInput} />
        </View>)}
      </View>
      {parseClock(window.start) !== null && parseClock(window.end) !== null && parseClock(window.end)! < parseClock(window.start)!
        ? <Text style={styles.smallText}>结束于次日，按开始当天的星期生效。</Text> : null}
    </View>)}
    <Text style={styles.text}>受限时段内，普通主动联系、自动网络逛街和梦等待；十维、感受、首页状态合计每滚动 60 分钟最多 4 次模型请求。手动聊天、日程阅读和专用睡前／起床回合照旧。</Text>
    <Text style={styles.smallText}>这是调用规则，不是整个 App 的花费上限，也不保证三卷每小时都更新。时段可自行调整，不会自动追踪价格；节假日可手动关闭。进入页面不会启用设置。</Text>
    {notice ? <Text accessibilityRole="alert" style={styles.notice}>{notice}</Text> : null}
    <Pressable accessibilityRole="button" disabled={saving} onPress={() => void save()}
      style={[styles.save, saving && styles.disabled]}>
      <Text style={styles.saveText}>{saving ? '保存中…' : '保存省钱时段'}</Text>
    </Pressable>
  </View>;
}

const styles = StyleSheet.create({
  card: { padding: 13, borderRadius: 16, backgroundColor: '#EDF6FF', marginBottom: 17 },
  heading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  copy: { flex: 1 },
  title: { color: '#557CA1', fontSize: 13, fontWeight: '700', marginBottom: 4 },
  text: { color: '#67839D', fontSize: 12, lineHeight: 18 },
  label: { color: '#557CA1', fontSize: 12, marginTop: 16, marginBottom: 8 },
  days: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 12 },
  day: { width: 34, minHeight: 40, borderRadius: 13, borderWidth: 1, borderColor: '#DDEFFF', backgroundColor: '#F9FCFF', alignItems: 'center', justifyContent: 'center' },
  daySelected: { backgroundColor: '#BDE2FF', borderColor: '#BDE2FF' },
  dayText: { color: '#67839D', fontSize: 13 },
  dayTextSelected: { color: '#426A90', fontWeight: '700' },
  window: { padding: 10, borderRadius: 13, backgroundColor: '#F9FCFF', marginBottom: 10 },
  windowTitle: { color: '#557CA1', fontSize: 12, fontWeight: '700' },
  clockRow: { flexDirection: 'row', marginTop: 5 },
  clockGroup: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  clockInput: { flex: 1, minHeight: 44, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 11, borderWidth: 1, borderColor: '#DDEFFF', backgroundColor: '#FFFFFF', color: '#426A90', fontSize: 17, textAlign: 'center' },
  separator: { color: '#91A4B6', marginHorizontal: 10 },
  smallText: { color: '#7890A5', fontSize: 11, lineHeight: 17, marginTop: 8 },
  notice: { color: '#557CA1', fontSize: 12, lineHeight: 18, marginTop: 10 },
  save: { alignItems: 'center', justifyContent: 'center', minHeight: 44, borderRadius: 14, backgroundColor: '#BDE2FF', marginTop: 12 },
  saveText: { color: '#426A90', fontSize: 13, fontWeight: '700' },
  disabled: { opacity: 0.5 },
});
