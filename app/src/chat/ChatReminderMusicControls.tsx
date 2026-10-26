import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { AppText as Text, AppTextInput as TextInput } from '../components/AppText';
import { subscribeAlarmRecordsChanged } from '../schedule/alarmStore';
import { getChatReminderOccurrence } from '../schedule/chatReminderStore';
import { handleChatReminderMusicAction } from '../schedule/chatReminderDelivery';

export function ChatReminderMusicControls({ occurrenceId, attemptId }: { occurrenceId: string; attemptId: string }) {
  const [music, setMusic] = useState(false), [failed, setFailed] = useState(false);
  const [minutes, setMinutes] = useState('10'), [busy, setBusy] = useState(false), [status, setStatus] = useState('');
  const [controlAttempt, setControlAttempt] = useState(attemptId);
  useEffect(() => {
    let mounted = true;
    const refresh = async () => {
      const record = await getChatReminderOccurrence(occurrenceId);
      if (!mounted) return;
      setMusic(record?.chatReminder.mode === 'music');
      setFailed(record?.chatReminder.musicEvidence?.state === 'failed');
      if (record) setControlAttempt(record.chatReminder.attemptId);
    };
    void refresh().catch(() => { if (mounted) setStatus('提醒读取失败'); });
    const stop = subscribeAlarmRecordsChanged(() => { void refresh().catch(() => undefined); });
    return () => { mounted = false; stop(); };
  }, [occurrenceId]);
  const act = async (action: 'stop' | 'snooze') => {
    const value = Number(minutes);
    if (busy || action === 'snooze' && (!Number.isSafeInteger(value) || value < 1 || !/^\d+$/.test(minutes))) return;
    setBusy(true);
    try {
      const result = await handleChatReminderMusicAction({ occurrenceId, attemptId: controlAttempt,
        operationId: `reminder-control:${occurrenceId}:${controlAttempt}:${Date.now()}`, action, ...(action === 'snooze' ? { minutes: value } : {}) });
      setStatus(result.state === 'stopped' ? '已停止' : result.state === 'snoozed' ? `${value}分钟后再响`
        : result.state === 'stale' || result.state === 'superseded' ? '这次播放已结束或已被替换' : '音乐操作未完成');
    } catch { setStatus('音乐操作未完成'); }
    finally { setBusy(false); }
  };
  if (!music) return status ? <Text style={styles.status}>{status}</Text> : null;
  return <View style={styles.box}>
    {failed ? <Text style={styles.status}>音乐未能播放</Text> : null}
    <View style={styles.line}>
      <Pressable disabled={busy} style={styles.button} onPress={() => { void act('stop'); }}><Text>停止</Text></Pressable>
      {[5, 10, 15].map(value => <Pressable key={value} disabled={busy} style={styles.button} onPress={() => setMinutes(String(value))}><Text>{value}分</Text></Pressable>)}
    </View>
    <View style={styles.line}>
      <TextInput style={styles.input} value={minutes} onChangeText={setMinutes} keyboardType="number-pad" accessibilityLabel="稍后再响分钟数" editable={!busy} />
      <Text>分钟后</Text><Pressable disabled={busy} style={styles.button} onPress={() => { void act('snooze'); }}><Text>再响</Text></Pressable>
    </View>
    {status ? <Text style={styles.status}>{status}</Text> : null}
  </View>;
}
const styles = StyleSheet.create({ box: { padding: 10, borderRadius: 12, backgroundColor: '#F7F1FA', marginVertical: 6 },
  line: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginVertical: 4 },
  button: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 8, backgroundColor: '#ECE2F2' },
  input: { minWidth: 54, padding: 8, borderWidth: 1, borderColor: '#D8CAE2', borderRadius: 8 }, status: { color: '#746480', fontSize: 12 } });
