import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { AppText as Text, AppTextInput as TextInput } from '../components/AppText';
import type { ChatReminderPlanCard as ReminderCard, ReminderDraft, ReminderPlanRow } from './chatReminderPlan';
import { reminderPlanClock, reminderPlanDate, reminderPlanTimestamp } from './useChatReminderPlanController';

type Props = { card: ReminderCard; busy?: boolean; onEditRow: (id: string, patch: Partial<ReminderDraft>) => void;
  onRemoveRow: (id: string) => void; onSave: () => void };
const stateLabels = { pending: '待保存', saving: '核对执行结果', saved: '已保存', conflict: '版本冲突', unknown: '结果待核对', failed: '未保存' };
const actionLabels = { create: '新增', update: '修改', cancel: '取消' };
const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
function ReminderRow({ card, row, index, busy, onEditRow, onRemoveRow, onValidity }: Omit<Props, 'onSave'> & {
  row: ReminderPlanRow; index: number; onValidity: (id: string, valid: boolean) => void;
}) {
  const draft = row.draft, shown = row.state === 'saved' ? row.result ?? draft : draft ?? row.expected;
  const editable = !busy && card.status === 'active' && !['saving', 'saved', 'unknown'].includes(row.state);
  const fieldsEditable = editable && row.action !== 'cancel';
  const [date, setDate] = useState(shown ? reminderPlanDate(shown.triggerAt) : '');
  const [clock, setClock] = useState(shown ? reminderPlanClock(shown.triggerAt) : '');
  const [songTitle, setSongTitle] = useState(draft?.songRequest?.title ?? draft?.musicSong?.name ?? '');
  const [songArtist, setSongArtist] = useState(draft?.songRequest?.artist ?? draft?.musicSong?.artist ?? '');
  const [songEdited, setSongEdited] = useState(false);
  useEffect(() => {
    if (!shown) return;
    setDate(reminderPlanDate(shown.triggerAt)); setClock(reminderPlanClock(shown.triggerAt));
    setSongTitle(draft?.songRequest?.title ?? draft?.musicSong?.name ?? '');
    setSongArtist(draft?.songRequest?.artist ?? draft?.musicSong?.artist ?? '');
    setSongEdited(false);
  }, [row.state]);
  const validTime = reminderPlanTimestamp(date, clock) !== null;
  const validSong = !draft || draft.mode !== 'music' || !songEdited && !!draft.musicSong || !!songTitle.trim() && !!songArtist.trim();
  useEffect(() => { onValidity(row.id, !fieldsEditable || !!draft?.title.trim() && validTime && validSong); },
    [draft?.title, fieldsEditable, validTime, validSong, row.id, onValidity]);
  const changeTime = (nextDate: string, nextClock: string) => {
    const triggerAt = reminderPlanTimestamp(nextDate, nextClock);
    if (triggerAt === null || !draft) return;
    const value = new Date(triggerAt);
    onEditRow(row.id, { triggerAt, ...(draft.repeat.kind !== 'once'
      ? { repeat: { ...draft.repeat, hour: value.getHours(), minute: value.getMinutes() } } : {}) });
  };
  const changeSong = (title: string, artist: string) => {
    setSongEdited(true);
    onEditRow(row.id, { songRequest: { title, artist } });
  };
  if (!shown) return null;
  const note = 'note' in shown ? shown.note : shown.chatReminder?.note;
  const mode = 'mode' in shown ? shown.mode : shown.chatReminder?.mode ?? shown.soundMode;
  return <View style={styles.row}>
    <View style={styles.inline}>
      <Text style={styles.rowTitle}>{index + 1} · {actionLabels[row.action]} · {row.scope === 'once' ? '只这一次' : '从这次起'}</Text>
      <Text style={styles.state}>{stateLabels[row.state]}</Text>
    </View>
    {row.expected ? <Text style={styles.source}>原提醒：{row.expected.title} · {reminderPlanDate(row.expected.triggerAt)} {reminderPlanClock(row.expected.triggerAt)}</Text> : null}
    <View style={styles.inline}>
      <Text style={styles.label}>事项</Text><TextInput style={[styles.input, styles.flex]} value={shown.title} editable={fieldsEditable}
        accessibilityLabel={`第${index + 1}条事项`} onChangeText={title => onEditRow(row.id, { title })} />
    </View>
    <View style={styles.inline}>
      <Text style={styles.label}>日期</Text><TextInput style={[styles.input, styles.date]} value={date} editable={fieldsEditable}
        accessibilityLabel={`第${index + 1}条日期`} placeholder="YYYY-MM-DD" onChangeText={value => { setDate(value); changeTime(value, clock); }} />
      <Text style={styles.label}>时间</Text><TextInput style={[styles.input, styles.clock]} value={clock} editable={fieldsEditable}
        accessibilityLabel={`第${index + 1}条时间`} placeholder="HH:mm" onChangeText={value => { setClock(value); changeTime(date, value); }} />
    </View>
    <View style={styles.inline}>
      <Text style={styles.label}>方式</Text>{(['notification', 'music'] as const).map(value => <Pressable key={value}
        style={[styles.choice, mode === value && styles.selected]} disabled={!fieldsEditable}
        onPress={() => onEditRow(row.id, { mode: value })}><Text style={styles.value}>{value === 'music' ? '音乐提醒' : '消息提醒'}</Text></Pressable>)}
    </View>
    {draft ? <View style={styles.inline}>
      <Text style={styles.label}>重复</Text>{(['once', 'daily', 'weekly'] as const).map(kind => <Pressable key={kind}
        style={[styles.choice, draft.repeat.kind === kind && styles.selected]} disabled={!fieldsEditable || row.action === 'update' && row.scope === 'once'}
        onPress={() => { const time = new Date(draft.triggerAt); onEditRow(row.id, { repeat: kind === 'once' ? { kind }
          : { kind, hour: time.getHours(), minute: time.getMinutes(), ...(kind === 'weekly' ? { weekdays: [time.getDay()] } : {}) } as ReminderDraft['repeat'] }); }}>
        <Text style={styles.value}>{kind === 'once' ? '单次' : kind === 'daily' ? '每天' : '每周'}</Text></Pressable>)}
    </View> : null}
    {draft?.repeat.kind === 'weekly' ? <View style={styles.inline}>
      <Text style={styles.label}>星期</Text>{weekdays.map((label, day) => { const repeat = draft.repeat;
        if (repeat.kind !== 'weekly') return null;
        const selected = repeat.weekdays.includes(day);
        return <Pressable key={day} style={[styles.choice, selected && styles.selected]}
          disabled={!fieldsEditable || row.action === 'update' && row.scope === 'once' || selected && repeat.weekdays.length === 1}
          onPress={() => onEditRow(row.id, { repeat: { ...repeat, weekdays: selected ? repeat.weekdays.filter(value => value !== day) : [...repeat.weekdays, day].sort() } })}>
          <Text style={styles.value}>{label}</Text></Pressable>;
      })}
    </View> : null}
    {mode === 'music' ? <>
      {fieldsEditable ? <View style={styles.inline}>
        <Text style={styles.label}>歌曲</Text><TextInput style={[styles.input, styles.flex]} value={songTitle} editable={fieldsEditable}
          accessibilityLabel={`第${index + 1}条歌名`} placeholder="歌名" onChangeText={value => { setSongTitle(value); changeSong(value, songArtist); }} />
        <TextInput style={[styles.input, styles.flex]} value={songArtist} editable={fieldsEditable}
          accessibilityLabel={`第${index + 1}条歌手`} placeholder="歌手 / 演奏者" onChangeText={value => { setSongArtist(value); changeSong(songTitle, value); }} />
      </View> : null}
      <Text style={styles.source}>{shown.musicSong ? `已解析：${shown.musicSong.name} · ${shown.musicSong.artist}` : '歌曲尚未解析；保存时核对'}</Text>
    </> : null}
    <View style={styles.inline}>
      <Text style={styles.label}>备注</Text><TextInput style={[styles.input, styles.flex]} value={note ?? ''} editable={fieldsEditable} multiline
        accessibilityLabel={`第${index + 1}条备注`} onChangeText={value => onEditRow(row.id, { note: value })} />
    </View>
    {fieldsEditable && !validTime ? <Text style={styles.error}>日期或时间无效，请填写 YYYY-MM-DD 与 HH:mm</Text> : null}
    {fieldsEditable && !validSong ? <Text style={styles.error}>请补全歌名与歌手 / 演奏者</Text> : null}
    {row.code && row.state !== 'saved' ? <Text style={styles.error}>状态：{row.code}</Text> : null}
    {editable ? <Pressable style={styles.remove} onPress={() => onRemoveRow(row.id)}><Text style={styles.removeText}>移除这行</Text></Pressable> : null}
  </View>;
}
export function ChatReminderPlanCard(props: Props) {
  const [invalid, setInvalid] = useState<string[]>([]);
  const onValidity = useCallback((id: string, valid: boolean) => setInvalid(previous => valid
    ? previous.filter(value => value !== id) : previous.includes(id) ? previous : [...previous, id]), []);
  const remaining = props.card.rows.some(row => row.state !== 'saved');
  const uncertain = props.card.rows.some(row => ['saving', 'unknown'].includes(row.state));
  const disabled = !!props.busy || props.card.status !== 'active' || !remaining
    || invalid.some(id => props.card.rows.some(row => row.id === id))
    || !props.card.feedback.claimed && props.card.feedback.remainingRequests <= 0;
  return <View style={styles.card}>
    <Text style={styles.title}>提醒草稿 · {props.card.rows.length} 条</Text>
    {props.card.status === 'restored' ? <Text style={styles.source}>备份恢复的草稿，仅供查看</Text> : null}
    {props.card.rows.map((row, index) => <ReminderRow key={row.id} {...props} row={row} index={index} onValidity={onValidity} />)}
    <Pressable style={[styles.save, disabled && styles.disabled]} disabled={disabled} onPress={props.onSave}>
      <Text style={styles.saveText}>{props.busy ? '保存中…' : !props.card.rows.length ? '无待保存行' : uncertain ? '核对未确定结果' : remaining ? '保存未完成行' : '已保存'}</Text>
    </Pressable>
    {!props.card.feedback.claimed && props.card.feedback.remainingRequests <= 0 ? <Text style={styles.source}>原轮次回复额度不足，不能执行保存</Text> : null}
  </View>;
}
const styles = StyleSheet.create({
  card: { marginTop: 8, padding: 14, borderRadius: 16, borderWidth: 1, borderColor: '#DDD1E9', backgroundColor: '#F7F2FB', gap: 8 },
  title: { color: '#514858', fontSize: 15, fontWeight: '600' }, row: { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#E7E1EF', gap: 7 },
  inline: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 }, rowTitle: { flex: 1, color: '#514858', fontWeight: '600' },
  state: { color: '#776580', fontSize: 12 }, source: { color: '#82768A', fontSize: 12 }, label: { color: '#73637C', fontSize: 13, minWidth: 30 }, value: { color: '#514858', fontSize: 13 },
  input: { borderWidth: 1, borderColor: '#D5C9DF', borderRadius: 8, backgroundColor: '#FFFFFF', color: '#514858', paddingHorizontal: 9, paddingVertical: 7, fontSize: 14 },
  date: { minWidth: 140 }, clock: { minWidth: 80 }, flex: { flex: 1, minWidth: 100 },
  choice: { borderWidth: 1, borderColor: '#DDD1E9', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7 }, selected: { backgroundColor: '#E9DFF2' },
  remove: { alignSelf: 'flex-start', paddingVertical: 6 }, removeText: { color: '#9B6475', fontSize: 12 }, error: { color: '#AB4848', fontSize: 12 },
  save: { alignItems: 'center', borderRadius: 10, paddingVertical: 10, backgroundColor: '#B79CCB' }, saveText: { color: '#FFFFFF', fontSize: 14 }, disabled: { opacity: 0.5 },
});
