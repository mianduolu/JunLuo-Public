import type { PropsWithChildren } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppText as Text, AppTextInput as TextInput } from '../components/AppText';
import type { InstalledPhoneApp } from '../backend/phoneActivityNative';
import { isJunLuoPhoneApp } from '../proactive/phoneActivityRules';
import type { PhoneRestrictionTimeWindow, PhoneRestrictionWeekday } from '../proactive/phoneRestrictionSchedule';
import { useState } from 'react';
import { PhoneSchedulePicker } from './PhoneSchedulePicker';

export type PhoneIconName = 'menu' | 'back' | 'usage' | 'lock' | 'calendar' | 'heart';
export function PhoneIcon({ name, color = '#7096B7' }: { name: PhoneIconName; color?: string }) {
  const paths = { menu: 'M4 6h16M4 12h16M4 18h16', back: 'm14 5-7 7 7 7',
    usage: 'M5 19V9m7 10V4m7 15v-7M3 21h18', calendar: 'M8 3v4m8-4v4M4 10h16M8 14h2m4 0h2M8 17h2',
    lock: 'M8 10V7a4 4 0 0 1 8 0v3M12 15v2', heart: 'M20 5c-2-2-5-1-8 2-3-3-6-4-8-2-4 4 0 8 8 14 8-6 12-10 8-14Z' };
  return <Svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    {name === 'calendar' ? <Rect x={4} y={5} width={16} height={16} rx={3} /> : null}
    {name === 'lock' ? <Rect x={5} y={10} width={14} height={11} rx={3} /> : null}
    <Path d={paths[name]} />
  </Svg>;
}
export function PhoneCard({ children }: PropsWithChildren) { return <View style={phoneUi.card}>{children}</View>; }
export function PhoneRow({ label, sub, children, leading, compact, onPress }: PropsWithChildren<{ label: string; sub?: string; leading?: React.ReactNode; compact?: boolean; onPress?: () => void }>) {
  const content = <>{leading}<View style={phoneUi.copy}><Text style={phoneUi.rowLabel}>{label}</Text>{sub ? <Text style={phoneUi.sub}>{sub}</Text> : null}</View>{children}{onPress ? <Text style={phoneUi.arrow}>›</Text> : null}</>;
  const style = [phoneUi.row, compact && { minHeight: 48 }];
  return onPress ? <Pressable accessibilityRole="button" onPress={onPress} style={style}>{content}</Pressable> : <View style={style}>{content}</View>;
}
export function PhoneSection({ title, color, children }: PropsWithChildren<{ title: string; color?: string }>) {
  return <View style={phoneUi.section}><Text style={[phoneUi.sectionText, color ? { color } : null]}>{title}</Text>{children}</View>;
}
export function PhoneNumber({ label, value, onChange, unit = '分钟' }: { label: string; value: string; onChange: (value: string) => void; unit?: string }) {
  return <PhoneRow compact label={label}><TextInput accessibilityLabel={label} keyboardType="decimal-pad" selectTextOnFocus style={phoneUi.number} value={value} onChangeText={onChange} /><Text style={phoneUi.unit}>{unit}</Text></PhoneRow>;
}
export function PhoneSwitch({ label, value, onChange, sub }: { label: string; value: boolean; onChange: (value: boolean) => void; sub?: string }) {
  return <PhoneRow label={label} sub={sub}><Switch accessibilityLabel={label} value={value} onValueChange={onChange} trackColor={{ false: '#D6DFE6', true: '#9FC7E9' }} thumbColor="#FFFFFF" /></PhoneRow>;
}
export function PhoneSegments<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (value: T) => void }) {
  return <View style={phoneUi.segments}>{options.map(option => <Pressable key={option.value} accessibilityRole="button" accessibilityState={{ selected: value === option.value }} style={[phoneUi.segment, value === option.value && phoneUi.segmentSelected]} onPress={() => onChange(option.value)}><Text style={phoneUi.segmentText}>{option.label}</Text></Pressable>)}</View>;
}
export function PhoneWeekdays({ value, onChange, color, inline = false }: { value: PhoneRestrictionWeekday[]; onChange: (value: PhoneRestrictionWeekday[]) => void; color?: string; inline?: boolean }) {
  const days: PhoneRestrictionWeekday[] = [1, 2, 3, 4, 5, 6, 7];
  const picker = <View style={phoneUi.weekdays}>{days.map((day, index) => <Pressable key={day} accessibilityLabel={`星期${['一', '二', '三', '四', '五', '六', '日'][index]}`} accessibilityRole="button" accessibilityState={{ selected: value.includes(day) }} onPress={() => onChange(value.includes(day) ? value.filter(item => item !== day) : [...value, day].sort())} style={[phoneUi.day, value.includes(day) && phoneUi.daySelected]}><Text style={phoneUi.dayText}>{['一', '二', '三', '四', '五', '六', '日'][index]}</Text></Pressable>)}</View>;
  return inline ? picker : <><PhoneSection title="重复星期" color={color}><Pressable onPress={() => onChange(days)} accessibilityRole="button"><Text style={[phoneUi.selectAll, color ? { color } : null]}>全选</Text></Pressable></PhoneSection><PhoneCard>{picker}</PhoneCard></>;
}
export function PhoneClockPair({ value, onChange }: { value: PhoneRestrictionTimeWindow; onChange: (value: PhoneRestrictionTimeWindow) => void }) {
  const [target, setTarget] = useState<'start' | 'end' | null>(null);
  return <><View style={phoneUi.clocks}><View style={phoneUi.clock}><Text style={phoneUi.sub}>开始</Text><Pressable accessibilityRole="button" accessibilityLabel="开始时间" style={phoneUi.clockButton} onPress={() => setTarget('start')}><Text style={phoneUi.clockInput}>{value.startTime || 'HH:mm'}</Text></Pressable></View><View style={phoneUi.dash} /><View style={phoneUi.clock}><Text style={phoneUi.sub}>{value.startTime && value.endTime && value.endTime < value.startTime ? '次日结束' : '结束'}</Text><Pressable accessibilityRole="button" accessibilityLabel="结束时间" style={phoneUi.clockButton} onPress={() => setTarget('end')}><Text style={phoneUi.clockInput}>{value.endTime || 'HH:mm'}</Text></Pressable></View></View>{target ? <PhoneSchedulePicker mode="time" visible title={target === 'start' ? '开始时间' : '结束时间'} value={target === 'start' ? value.startTime : value.endTime} onClose={() => setTarget(null)} onConfirm={time => onChange({ ...value, [target === 'start' ? 'startTime' : 'endTime']: time })} /> : null}</>;
}
export function PhoneSave({ busy, onSave }: { busy: boolean; onSave: () => void }) {
  const insets = useSafeAreaInsets();
  return <View style={[phoneUi.saveFooter, { bottom: Math.max(12, insets.bottom + 8) }]}><Pressable disabled={busy} accessibilityRole="button" onPress={onSave} style={[phoneUi.save, busy && { opacity: .6 }]}><Text style={phoneUi.saveText}>{busy ? '保存中…' : '保存'}</Text></Pressable></View>;
}
export function PhoneAppPicker({ visible, apps, selected, title, loading, error, onReload, onClose, onSelect }: {
  visible: boolean; apps: InstalledPhoneApp[]; selected: string[]; title: string; loading: boolean; error: string;
  onReload: () => void; onClose: () => void; onSelect: (packages: string[]) => void;
}) {
  const [query, setQuery] = useState('');
  const insets = useSafeAreaInsets();
  const visibleApps = apps.filter(app => !isJunLuoPhoneApp(app.source, app.title) && `${app.title} ${app.source}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}><View style={phoneUi.modal}><Pressable style={StyleSheet.absoluteFill} onPress={onClose} /><View style={[phoneUi.picker, { paddingBottom: Math.max(18, insets.bottom + 12) }]}><View style={phoneUi.pickerHead}><Text style={phoneUi.pickerTitle}>{title}</Text><Pressable onPress={onClose} accessibilityRole="button"><Text style={phoneUi.rowLabel}>完成</Text></Pressable></View><TextInput style={phoneUi.search} accessibilityLabel="搜索应用" placeholder="搜索应用" value={query} onChangeText={setQuery} />{loading ? <Text style={phoneUi.sub}>读取应用中…</Text> : null}{error ? <Pressable onPress={onReload}><Text style={phoneUi.error}>{error} · 重试</Text></Pressable> : null}<ScrollView keyboardShouldPersistTaps="handled">{visibleApps.map(app => <PhoneSwitch key={app.source} label={app.title} value={selected.includes(app.source)} onChange={enabled => onSelect(enabled ? [...selected, app.source] : selected.filter(name => name !== app.source))} />)}{!loading && !error && !visibleApps.length ? <Text style={phoneUi.sub}>没有匹配的应用</Text> : null}</ScrollView></View></View></Modal>;
}
export const phoneUi = StyleSheet.create({
  card: { backgroundColor: 'rgba(255,255,255,0.94)', borderRadius: 22, overflow: 'hidden', marginBottom: 11 },
  row: { marginHorizontal: 18, minHeight: 57, paddingVertical: 11, flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#E6EDF2' },
  copy: { flex: 1 }, rowLabel: { fontSize: 17, color: '#384052', lineHeight: 25 }, sub: { color: '#697184', fontSize: 13, lineHeight: 20 },
  arrow: { color: '#8B9AAA', fontSize: 26 }, section: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginHorizontal: 5, marginTop: 12, marginBottom: 8 }, sectionText: { fontSize: 16, color: '#384052' },
  number: { width: 55, fontSize: 19, color: '#384052', textAlign: 'right', padding: 4 }, unit: { color: '#697184', fontSize: 14 },
  segments: { flexDirection: 'row', gap: 4, padding: 4, backgroundColor: '#EDF3F8', borderRadius: 13, margin: 12 }, segment: { flex: 1, minHeight: 36, justifyContent: 'center', alignItems: 'center', padding: 7, borderRadius: 10 }, segmentSelected: { backgroundColor: '#FFFFFF' }, segmentText: { fontSize: 15, color: '#3B6685' },
  weekdays: { paddingHorizontal: 14, paddingTop: 7, paddingBottom: 14, flexDirection: 'row', justifyContent: 'space-between', gap: 5 }, day: { height: 34, flex: 1, maxWidth: 37, borderRadius: 11, backgroundColor: '#EFF4F8', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'transparent' }, daySelected: { backgroundColor: '#DCECFF', borderColor: '#BDD6EE' }, dayText: { fontSize: 15, color: '#3B6685' }, selectAll: { fontSize: 14, color: '#384052', textDecorationLine: 'underline', padding: 4 },
  clocks: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 12 }, clock: { width: '43%', alignItems: 'center' }, clockButton: { width: '100%', minHeight: 39, justifyContent: 'center' }, clockInput: { textAlign: 'center', color: '#384052', fontSize: 27, lineHeight: 39, minHeight: 39, width: '100%' }, dash: { width: 23, height: 1, backgroundColor: '#BDCDDA' },
  saveFooter: { position: 'absolute', left: 20, right: 20 }, save: { height: 49, alignItems: 'center', justifyContent: 'center', borderRadius: 18, backgroundColor: '#D9EDFF', borderWidth: 1, borderColor: '#A5CCEF' }, saveText: { fontSize: 20, color: '#384052' },
  link: { color: '#697184', fontSize: 14, lineHeight: 22, paddingVertical: 9 }, error: { color: '#865F62', fontSize: 15, lineHeight: 23, paddingVertical: 8 },
  modal: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(56,64,82,0.32)' }, picker: { maxHeight: '85%', minHeight: 300, backgroundColor: '#FAFDFF', padding: 20, borderTopLeftRadius: 25, borderTopRightRadius: 25 }, pickerHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 15 }, pickerTitle: { color: '#384052', fontSize: 22 }, search: { borderRadius: 13, backgroundColor: '#EDF3F8', color: '#384052', fontSize: 17, padding: 12, marginBottom: 12 },
});
