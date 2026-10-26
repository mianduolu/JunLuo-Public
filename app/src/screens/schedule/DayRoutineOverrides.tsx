import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Switch, TextInput, View } from 'react-native';
import { AppText as Text } from '../../components/AppText';
import { DateTimePickerSheet } from '../../components/DateTimePickerSheet';
import type { DateTimeSelection } from '../../schedule/dateTimeSelection';
import { dateKey } from '../../schedule/scheduleStore';
import { readUserRoutine, saveUserRoutinePatch } from '../../schedule/userRoutineStore';
import { USER_ROUTINE_KINDS, USER_ROUTINE_TITLES, isRoutineDate, userRoutineTimeDates,
  type UserRoutineKind, type UserRoutinePatch, type UserRoutineRead } from '../../schedule/userRoutinePolicy';
import { loadUserRoutineOverlaps } from '../../schedule/userRoutineContext';
import { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch } from '../../backup/backupRestoreCoordinator';

export function DayRoutineOverrides() {
  const [day, setDay] = useState(() => dateKey(new Date()));
  const [routine, setRoutine] = useState<UserRoutineRead | null>(null);
  const [patch, setPatch] = useState<UserRoutinePatch>({ date: day });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [overlaps, setOverlaps] = useState<string[]>([]);
  const [target, setTarget] = useState<UserRoutineKind | null>(null);
  const [reload, setReload] = useState(0);
  const serial = useRef(0);
  const epoch = useRef(captureBackupRestoreDataEpoch());
  useEffect(() => {
    const sequence = ++serial.current;
    setLoading(true); setRoutine(null); setNotice(''); setOverlaps([]); setPatch({ date: day });
    epoch.current = captureBackupRestoreDataEpoch();
    if (!isRoutineDate(day)) { setLoading(false); return; }
    readUserRoutine(day).then(value => { if (sequence === serial.current) setRoutine(value); })
      .catch(() => { if (sequence === serial.current) setNotice('作息暂时无法读取。'); })
      .finally(() => { if (sequence === serial.current) setLoading(false); });
    return () => { if (serial.current === sequence) serial.current += 1; };
  }, [day, reload]);
  const editable = !loading && !saving && !!routine && routine.status !== 'unavailable';
  const change = (kind: UserRoutineKind, values: NonNullable<UserRoutinePatch[UserRoutineKind]>) => {
    setPatch(current => ({ ...current, [kind]: { ...current[kind], ...values } })); setNotice('');
  };
  const save = async () => {
    if (!editable || !routine || epoch.current === null) return;
    setSaving(true); setNotice('');
    const sequence = serial.current;
    try {
      const result = await saveUserRoutinePatch(patch, { operationId: `routine-page:${Date.now()}:${sequence}`,
        expectedVersion: routine.version, dataEpoch: epoch.current,
        isCurrent: () => sequence === serial.current && canCommitBackupRestoreDataEpoch(epoch.current) });
      if (sequence !== serial.current) return;
      if (result.status === 'saved') {
        setRoutine(result.routine); setPatch({ date: day }); setNotice('作息已保存。');
        const start = new Date(`${day}T00:00:00`).getTime();
        const end = new Date(`${day}T00:00:00`); end.setDate(end.getDate() + 2);
        try {
          const titles = [...new Set((await loadUserRoutineOverlaps(start, end.getTime())).map(item => item.title))];
          if (sequence === serial.current) setOverlaps(titles);
        } catch { if (sequence === serial.current) setNotice('作息已保存；重叠情况暂时无法读取。'); }
      } else setNotice(result.status === 'unknown' ? '作息保存结果暂时无法确认。' : '这次还没保存好，作息暂时还是原来的安排。');
    } catch { if (sequence === serial.current) setNotice('作息保存结果暂时无法确认。'); }
    finally { if (sequence === serial.current) setSaving(false); }
  };
  const applyTime = (value: DateTimeSelection | null) => {
    if (target && value?.time && userRoutineTimeDates(day).includes(value.date)) change(target, { time: `${value.date} ${value.time}`,
      ...(!routine?.items[target] ? { enabled: true } : {}) });
    setTarget(null);
  };
  const selected = target ? patch[target]?.time ?? routine?.items[target]?.time : undefined;
  const picker: DateTimeSelection = { date: selected?.includes(' ') ? selected.slice(0, 10) : day,
    time: selected?.slice(-5) || '12:00', recurrence: 'none', reminderChoice: 'none',
    reminderClock: selected?.slice(-5) || '12:00', reminderIntensity: 'gentle' };
  return <View>
    <View style={styles.dateRow}><Text style={styles.label}>归属日期</Text><TextInput
      accessibilityLabel="作息归属日期" editable={!saving} value={day} onChangeText={setDay} placeholder="YYYY-MM-DD"
      maxLength={10} style={styles.dateInput} /></View>
    {loading ? <Text style={styles.note}>正在读取作息…</Text> : !routine || routine.status === 'unavailable' ? <View>
      <Text style={styles.note}>{!isRoutineDate(day) ? '请输入有效日期。' : '作息暂时无法读取。'}</Text>
      <Pressable onPress={() => setReload(value => value + 1)} style={styles.button}><Text style={styles.accent}>重新读取</Text></Pressable>
    </View> : <>
      <Text style={styles.note}>{routine.enabled ? '未单独修改的项目沿用平常安排。' : '平常作息总开关已关闭；日期例外按各项开关生效。'}</Text>
      <Text style={styles.section}>这是计划，不是完成记录</Text>
      <View style={styles.card}>{USER_ROUTINE_KINDS.map(kind => {
        const original = routine.items[kind]; const item = { ...original, ...patch[kind] };
        return <View key={kind} style={styles.item}>
          <View style={styles.row}><View style={styles.grow}><Text style={styles.label}>{USER_ROUTINE_TITLES[kind]}</Text>
            <Text style={styles.note}>{patch[kind] || original?.source === 'day' ? '当天改过' : '平常安排'}</Text></View>
            <Switch accessibilityLabel={`启用${USER_ROUTINE_TITLES[kind]}`} disabled={!editable}
              value={item.enabled ?? false} trackColor={{ true: '#F7C4A3', false: '#DEE8F1' }}
              thumbColor={item.enabled ? '#F5AC7F' : '#F2F4F7'}
              onValueChange={enabled => change(kind, { enabled })} />
          </View>
          <Pressable disabled={!editable} accessibilityLabel={`设置${USER_ROUTINE_TITLES[kind]}时间`}
            onPress={() => setTarget(kind)} style={styles.timeButton}><Text style={styles.time}>{item.time || '未设置时间'}</Text><Text style={styles.accent}>›</Text></Pressable>
          {kind !== 'wake' && kind !== 'sleep' && <View style={styles.row}>
            <Text style={styles.note}>持续分钟（可不填）</Text><TextInput accessibilityLabel={`${USER_ROUTINE_TITLES[kind]}持续分钟`}
              editable={editable} keyboardType="number-pad" placeholder="未设置" style={styles.minuteInput}
              value={item.minutes === undefined ? '' : String(item.minutes)} onChangeText={text => {
                if (/^\d+$/.test(text)) change(kind, { minutes: Number(text) });
                else if (!text) setPatch(current => { const next = { ...current[kind] }; delete next.minutes;
                  return { ...current, [kind]: next }; });
              }} />
          </View>}
        </View>;
      })}</View>
      <Text style={styles.note}>跨夜时间填写实际日期，只修改这一归属日的安排。</Text>
      {!!notice && <Text accessibilityLiveRegion="polite" style={styles.notice}>{notice}</Text>}
      {overlaps.map(title => <Text key={title} style={styles.notice}>与「{title}」重叠；两份安排都已保留。</Text>)}
      <Pressable disabled={!editable || Object.keys(patch).length === 1} onPress={() => void save()}
        style={[styles.save, (!editable || Object.keys(patch).length === 1) && { opacity: 0.45 }]}>
        <Text style={styles.saveText}>{saving ? '保存中…' : '保存当天修改'}</Text></Pressable>
    </>}
    <DateTimePickerSheet title={target ? USER_ROUTINE_TITLES[target] : '选择时间'} visible={!!target}
      timeOnly timeOnlyDates={userRoutineTimeDates(day).map((date, index) => ({ date, label: index === 0 ? '当天' : '次日' }))}
      value={picker} onClose={() => setTarget(null)} onConfirm={applyTime} />
  </View>;
}
const styles = StyleSheet.create({
  dateRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginVertical: 18 },
  dateInput: { padding: 12, color: '#4D607A', backgroundColor: '#FFFFFF', borderRadius: 10, fontSize: 16, minWidth: 150 },
  grow: { flex: 1 }, row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  label: { color: '#4D607A', fontSize: 17, fontWeight: '500' }, note: { color: '#75849A', fontSize: 13, lineHeight: 20, marginTop: 4 },
  section: { color: '#6484AA', fontSize: 13, marginTop: 22, marginBottom: 10 },
  card: { borderRadius: 16, overflow: 'hidden', backgroundColor: '#FFFFFF', borderColor: '#DEEAF5', borderWidth: 1 },
  item: { padding: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#E3EDF6' },
  timeButton: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 12 },
  time: { color: '#6484AA', fontSize: 17 }, accent: { color: '#6484AA', fontSize: 16 }, button: { paddingVertical: 14 },
  minuteInput: { minWidth: 78, height: 44, paddingHorizontal: 10, paddingVertical: 0, textAlign: 'center', textAlignVertical: 'center', fontSize: 14, color: '#4D607A', backgroundColor: '#FFF0E4', borderRadius: 8 },
  notice: { color: '#5D7494', fontSize: 14, lineHeight: 21, marginTop: 14 },
  save: { backgroundColor: '#FFD2B2', paddingVertical: 16, borderRadius: 14, alignItems: 'center', marginTop: 24 },
  saveText: { color: '#3B5975', fontSize: 17, fontWeight: '500' },
});
