import { useEffect, useMemo, useRef, useState } from 'react';
import { Keyboard, Modal, Pressable, ScrollView, StyleSheet, View, useWindowDimensions, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppText as Text } from '../components/AppText';

const ROW_HEIGHT = 48;
const pad = (value: number) => String(value).padStart(2, '0');
const range = (start: number, end: number) => Array.from({ length: end - start + 1 }, (_, index) => pad(start + index));
const hours = range(0, 23), minutes = range(0, 59), months = range(1, 12);
type Selection = { year: number; month: number; day: number; hour: number; minute: number };
const daysInMonth = (year: number, month: number) => new Date(year, month, 0).getDate();

function initialSelection(value: string, mode: 'time' | 'date'): Selection {
  const now = new Date();
  const result = { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate(), hour: now.getHours(), minute: now.getMinutes() };
  if (mode === 'time' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    [result.hour, result.minute] = value.split(':').map(Number);
  } else if (mode === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split('-').map(Number);
    if (month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month)) Object.assign(result, { year, month, day });
  }
  return result;
}

function Wheel({ label, values, value, onChange }: { label: string; values: string[]; value: string; onChange: (value: string) => void }) {
  const ref = useRef<ScrollView>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef(onChange); latest.current = onChange;
  const clearTimer = () => { if (timer.current !== undefined) { clearTimeout(timer.current); timer.current = undefined; } };
  useEffect(() => {
    ref.current?.scrollTo({ y: Math.max(0, values.indexOf(value)) * ROW_HEIGHT, animated: false });
    return clearTimer;
  }, [values, value]);
  const pick = (y: number) => {
    clearTimer();
    const index = Math.max(0, Math.min(values.length - 1, Math.round(y / ROW_HEIGHT)));
    latest.current(values[index]);
  };
  const dragged = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const y = event.nativeEvent.contentOffset.y;
    clearTimer();
    timer.current = setTimeout(() => pick(y), 150);
  };
  return <View style={styles.column}><Text style={styles.unit}>{label}</Text><View style={styles.wheel}>
    <View pointerEvents="none" style={styles.selection} />
    <ScrollView ref={ref} accessibilityLabel={`选择${label}`} nestedScrollEnabled showsVerticalScrollIndicator={false}
      snapToInterval={ROW_HEIGHT} decelerationRate="fast" disableIntervalMomentum
      contentContainerStyle={styles.wheelContent} onScrollEndDrag={dragged} onMomentumScrollBegin={clearTimer}
      onMomentumScrollEnd={event => pick(event.nativeEvent.contentOffset.y)}>
      {values.map(item => <Pressable key={item} accessibilityRole="button" accessibilityState={{ selected: item === value }}
        onPress={() => { clearTimer(); onChange(item); }} style={styles.item}><Text style={[styles.number, item === value && styles.selectedNumber]}>{item}</Text></Pressable>)}
    </ScrollView>
  </View></View>;
}

export function PhoneSchedulePicker({ mode, title, value, visible, onClose, onConfirm }: {
  mode: 'time' | 'date'; title: string; value: string; visible: boolean; onClose: () => void; onConfirm: (value: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const [layout, setLayout] = useState({ width: 0, height: 0 });
  const minimumWidth = window.width - insets.left - insets.right;
  const minimumHeight = window.height - insets.top - insets.bottom;
  // Android's dialog can display its children before the first full-window layout.
  const ready = layout.width >= minimumWidth - 1 && layout.height >= minimumHeight - 1;
  const initial = useMemo(() => initialSelection(value, mode), [value, mode, visible]);
  const [selection, setSelection] = useState(initial);
  useEffect(() => { if (visible) setSelection(initial); else setLayout({ width: 0, height: 0 }); }, [initial, visible]);
  const years = useMemo(() => range(Math.min(new Date().getFullYear() - 1, initial.year), Math.max(new Date().getFullYear() + 10, initial.year)), [initial.year]);
  const days = useMemo(() => range(1, daysInMonth(selection.year, selection.month)), [selection.year, selection.month]);
  const update = (field: keyof Selection, next: string) => setSelection(current => {
    const result = { ...current, [field]: Number(next) };
    result.day = Math.min(result.day, daysInMonth(result.year, result.month));
    return result;
  });
  const confirm = (next: string) => { onConfirm(next); onClose(); };
  if (!visible) return null;
  return <Modal transparent animationType="slide" visible onRequestClose={onClose} onShow={() => Keyboard.dismiss()}><View
    style={[styles.overlay, { minWidth: minimumWidth, minHeight: minimumHeight, opacity: ready ? 1 : 0 }]} pointerEvents={ready ? 'auto' : 'none'}
    onLayout={event => setLayout({ width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height })}>
    <Pressable accessibilityLabel="取消选择" style={StyleSheet.absoluteFill} onPress={onClose} />
    <View style={[styles.sheet, { paddingBottom: Math.max(20, insets.bottom + 12) }]}>
      <View style={styles.header}><Pressable accessibilityRole="button" onPress={onClose}><Text style={styles.action}>取消</Text></Pressable><Text style={styles.title}>{title}</Text><Pressable accessibilityRole="button" onPress={() => confirm('')}><Text style={styles.action}>清除</Text></Pressable></View>
      <View style={styles.wheels}>{mode === 'time' ? <>
        <Wheel label="小时" values={hours} value={pad(selection.hour)} onChange={next => update('hour', next)} />
        <Wheel label="分钟" values={minutes} value={pad(selection.minute)} onChange={next => update('minute', next)} />
      </> : <>
        <Wheel label="年份" values={years} value={String(selection.year)} onChange={next => update('year', next)} />
        <Wheel label="月份" values={months} value={pad(selection.month)} onChange={next => update('month', next)} />
        <Wheel label="日期" values={days} value={pad(selection.day)} onChange={next => update('day', next)} />
      </>}</View>
      <Pressable accessibilityRole="button" style={styles.confirm} onPress={() => confirm(mode === 'time' ? `${pad(selection.hour)}:${pad(selection.minute)}` : `${String(selection.year).padStart(4, '0')}-${pad(selection.month)}-${pad(selection.day)}`)}><Text style={styles.confirmText}>确定</Text></Pressable>
    </View>
  </View></Modal>;
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(56,64,82,0.32)' },
  sheet: { backgroundColor: '#FAFDFF', paddingHorizontal: 20, paddingTop: 18, borderTopLeftRadius: 25, borderTopRightRadius: 25 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 40 },
  title: { fontSize: 21, color: '#384052' }, action: { fontSize: 16, color: '#697184', paddingVertical: 9 },
  wheels: { flexDirection: 'row', gap: 10, marginVertical: 18 }, column: { flex: 1 }, unit: { color: '#697184', fontSize: 14, textAlign: 'center', marginBottom: 8 },
  wheel: { height: ROW_HEIGHT * 5, overflow: 'hidden' }, wheelContent: { paddingVertical: ROW_HEIGHT * 2 },
  selection: { position: 'absolute', top: ROW_HEIGHT * 2, left: 0, right: 0, height: ROW_HEIGHT, backgroundColor: '#DCECFF', borderRadius: 12 },
  item: { height: ROW_HEIGHT, justifyContent: 'center', alignItems: 'center' }, number: { fontSize: 24, lineHeight: 34, color: '#8B9AAA' }, selectedNumber: { color: '#384052', fontWeight: '600' },
  confirm: { height: 49, alignItems: 'center', justifyContent: 'center', borderRadius: 18, backgroundColor: '#D9EDFF', borderWidth: 1, borderColor: '#A5CCEF' }, confirmText: { fontSize: 20, color: '#384052' },
});
