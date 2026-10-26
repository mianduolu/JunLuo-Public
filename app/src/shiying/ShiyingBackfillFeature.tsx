import { useEffect, useRef, useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppText as Text } from '../components/AppText';
import { getShiyingLifeDate } from './shiyingWindow';
import { shiyingBackfillController, type ShiyingBackfillProgress } from './shiyingBackfillCoordinator';
import type { ShiyingBackfillPreviewV1 } from './shiyingBackfillPlan';
import type { getShiyingVisualPalette } from './ShiyingFeature';
import { getPermissionsAsync } from 'expo-notifications';
import { registerShiyingBackupParticipant } from './shiyingBackupRuntime';

type Palette = ReturnType<typeof getShiyingVisualPalette>;
export function shiyingBackfillCalendar(year: number, month: number) {
  const leading = (new Date(year, month, 1).getDay() + 6) % 7;
  const count = new Date(year, month + 1, 0).getDate();
  return [...Array(leading).fill(null), ...Array.from({ length: count }, (_, index) => (
    `${year}-${String(month + 1).padStart(2, '0')}-${String(index + 1).padStart(2, '0')}`
  ))] as Array<string | null>;
}
export function ShiyingBackfillFeature({ visual, active }: { visual: Palette; active: boolean }) {
  const insets = useSafeAreaInsets();
  const mounted = useRef(true), busyRef = useRef(false), generation = useRef(0);
  const actionGeneration = useRef(0);
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [selected, setSelected] = useState<string[]>([]), [preview, setPreview] = useState<ShiyingBackfillPreviewV1 | null>(null);
  const [progress, setProgress] = useState<ShiyingBackfillProgress | null>(null);
  const [notificationVisible, setNotificationVisible] = useState<boolean | null>(null);
  const today = getShiyingLifeDate(Date.now());
  const refresh = async () => {
    const version = generation.current;
    const current = await shiyingBackfillController.state();
    if (mounted.current && version === generation.current) setProgress(current);
  };
  useEffect(() => {
    mounted.current = true;
    const stop = shiyingBackfillController.subscribe(() => { void refresh().catch(() => undefined); });
    const releaseBackup = registerShiyingBackupParticipant({ invalidate: () => {
      generation.current++; actionGeneration.current++; busyRef.current = false;
      if (mounted.current) { setOpen(false); setPreview(null); setSelected([]); setProgress(null); setBusy(false); setMessage(''); }
    } });
    void refresh().catch(() => { if (mounted.current) setMessage('补捡进度暂时无法读取。'); });
    void getPermissionsAsync().then(permission => { if (mounted.current) setNotificationVisible(permission.granted); }).catch(() => undefined);
    return () => { mounted.current = false; stop(); releaseBackup(); generation.current++; shiyingBackfillController.invalidatePreview(); };
  }, []);
  const close = () => { generation.current++; shiyingBackfillController.invalidatePreview(); setOpen(false); setPreview(null); };
  useEffect(() => { if (!active) close(); }, [active]);
  async function perform(work: () => Promise<unknown>) {
    if (busyRef.current) return; busyRef.current = true; setBusy(true); setMessage('');
    const version = generation.current;
    const action = ++actionGeneration.current;
    try { await work(); if (version === generation.current) await refresh(); }
    catch (error) {
      if (mounted.current && version === generation.current) setMessage(error instanceof Error && /^shiying_[a-z0-9_]+$/u.test(error.message.split(':')[0])
        ? `暂时无法处理：${error.message.split(':')[0]}` : '暂时无法处理，进度仍然保留。');
    } finally { if (action === actionGeneration.current) { busyRef.current = false; if (mounted.current) setBusy(false); } }
  }
  function resume() {
    const token = progress?.retryConfirmation;
    const version = generation.current;
    if (!token) { void perform(() => shiyingBackfillController.continue()); return; }
    const remaining = progress!.task!.days.flatMap(day => day.chunks).filter(chunk => chunk.status !== 'completed').length;
    Alert.alert('继续补捡', `上次没能捡完，继续捡可能会再次产生调用费用。\n还剩 ${remaining} 段，本次新增授权最多 ${remaining} 次调用。`, [
      { text: '先放一放', style: 'cancel' },
      { text: '继续捡', onPress: () => { if (mounted.current && version === generation.current) void perform(() => shiyingBackfillController.continue(token)); } },
    ]);
  }
  const button = (label: string, action: () => void, disabled = false) => (
    <Pressable accessibilityRole="button" disabled={busy || disabled} onPress={action}
      style={[styles.button, { backgroundColor: visual.secondaryButtonSurface, opacity: busy || disabled ? 0.45 : 1 }]}>
      <Text style={{ color: visual.primaryText }}>{label}</Text>
    </Pressable>
  );
  const task = progress?.task;
  const description = task ? `已完成 ${task.days.filter(day => day.completed).length}／${task.days.length} 个日期 · 已用 ${task.usedCalls}／${task.authorizedCalls} 次调用` : '';
  const reason = { no_chat: '无聊天', no_material: '没有可用材料', covered: '已经整理过', ready: '', blocked: '容量阻塞' };
  return <View style={styles.root}>
    {task ? <>
      <Text style={{ color: visual.primaryText }}>{description}</Text>
      <Text style={{ color: visual.secondaryText }}>{progress?.executing ? '正在补捡；离开页面不会暂停。' : progress?.savePending
        ? '结果已收到，等待本地保存。' : task.status === 'completed' ? '补捡已经完成。' : '补捡已停下，成功进度已保留。'}</Text>
      {notificationVisible === false ? <Text style={{ color: visual.secondaryText }}>系统未允许通知，通知栏进度不可见。</Text> : null}
      {progress?.code ? <Text style={{ color: visual.secondaryText }}>{`技术状态：${progress.code}`}</Text> : null}
      <View style={styles.actions}>
        {!progress?.executing && task.status === 'running'
          ? button('暂停补捡', () => { void perform(() => shiyingBackfillController.pause()); }) : null}
        {progress?.executing ? button('暂停补捡', () => { void perform(() => shiyingBackfillController.pause()); })
          : progress?.savePending ? button('再存一次', () => { void perform(() => shiyingBackfillController.retryLocalSave()); })
            : button(task.status === 'completed' ? '完成收口' : '继续补捡', resume)}
        {!progress?.executing ? button('放弃这次补捡', () => { const version = generation.current; Alert.alert('放弃这次补捡？',
          '未完成的临时材料会被清除，聊天和已有荧迹不会删除。以后再次整理时，已经调用过的部分可能会重新调用模型。', [
            { text: '取消', style: 'cancel' }, { text: '放弃', style: 'destructive', onPress: () => { if (mounted.current && version === generation.current) void perform(() => shiyingBackfillController.abandon(task.id)); } },
          ]); }) : null}
      </View>
    </> : button('补捡以前', () => { setSelected([]); setPreview(null); setOpen(true); })}
    {message ? <Text style={{ color: visual.secondaryText }}>{message}</Text> : null}
    <Modal visible={open} animationType="fade" transparent onRequestClose={close}>
      <View style={[styles.backdrop, { backgroundColor: visual.modalBackdrop, paddingTop: insets.top + 16, paddingBottom: insets.bottom + 16 }]}>
        <View style={[styles.sheet, { backgroundColor: visual.sheetSurface }]}>
          <View style={styles.month}>
            <Text style={[styles.title, { color: visual.primaryText }]}>补捡以前</Text>{button('返回', close)}
          </View>
          <ScrollView style={{ flexShrink: 1 }} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
            {preview ? <>
              <Text style={[styles.title, { color: visual.primaryText }]}>{`最多 ${preview.totalCalls} 次提取调用`}</Text>
              <Text style={{ color: visual.secondaryText }}>一次确认后按日处理，已经完成的日期及时保存。</Text>
              {preview.days.map(day => <Text key={day.lifeDate} style={{ color: visual.primaryText }}>
                {`${day.lifeDate} · ${day.messageCount} 条材料 · ${day.chunks.length} 段${reason[day.reason] ? ` · ${reason[day.reason]}` : ''}`}
              </Text>)}
              <View style={styles.actions}>
                {button('重新选日期', () => { shiyingBackfillController.invalidatePreview(); setPreview(null); })}
                {button('确认开始补捡', () => {
                  const value = preview;
                  const version = generation.current;
                  void perform(async () => { await shiyingBackfillController.start(value); if (mounted.current && version === generation.current) close(); });
                }, preview.blocked || preview.totalCalls === 0)}
              </View>
              {preview.blocked ? <Text style={{ color: visual.secondaryText }}>有完整消息超出连接容量，请调整后重新预估。本次没有调用模型。</Text> : null}
              {preview.totalCalls === 0 ? <Text style={{ color: visual.secondaryText }}>所选日期无需调用模型。</Text> : null}
            </> : <>
              <Text style={{ color: visual.secondaryText }}>最多选择 31 个已经结束的生活日期；凌晨 05:00 换一天。</Text>
              <View style={styles.month}>
                {button('‹', () => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1)))}
                <Text style={{ color: visual.primaryText }}>{`${month.getFullYear()}年${month.getMonth() + 1}月`}</Text>
                {button('›', () => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1)),
                  new Date(month.getFullYear(), month.getMonth() + 1, 1).getTime() > Date.now())}
              </View>
              <View style={styles.grid}>{['一', '二', '三', '四', '五', '六', '日'].map(day => (
                <Text key={day} style={[styles.cellLabel, { color: visual.secondaryText }]}>{day}</Text>
              ))}</View>
              <View style={styles.grid}>{shiyingBackfillCalendar(month.getFullYear(), month.getMonth()).map((date, index) => (
                <Pressable key={date ?? `blank-${index}`} disabled={!date || date >= today || busy}
                  accessibilityLabel={date ?? undefined} accessibilityState={{ selected: !!date && selected.includes(date) }}
                  onPress={() => {
                    if (!date) return;
                    if (selected.includes(date)) setSelected(selected.filter(day => day !== date));
                    else if (selected.length < 31) setSelected([...selected, date].sort());
                    else setMessage('每次最多选择 31 个生活日期。');
                  }} style={[styles.cell, { backgroundColor: date && selected.includes(date) ? visual.actionSurface : 'transparent',
                    opacity: date && date < today ? 1 : 0.3 }]}>
                  <Text style={{ color: visual.primaryText }}>{date ? String(Number(date.slice(8))) : ''}</Text>
                </Pressable>
              ))}</View>
              <Text style={{ color: visual.secondaryText }}>{`已选 ${selected.length}／31 个日期`}</Text>
              {selected.length ? <Text style={{ color: visual.secondaryText }}>{selected.join('、')}</Text> : null}
              {button(busy ? '正在预估…' : '查看调用预估', () => {
                const current = generation.current;
                void perform(async () => { const value = await shiyingBackfillController.preview(selected);
                  if (mounted.current && generation.current === current) setPreview(value); });
              }, selected.length === 0)}
            </>}
            {message ? <Text style={{ color: visual.secondaryText }}>{message}</Text> : null}
          </ScrollView>
        </View>
      </View>
    </Modal>
  </View>;
}
const styles = StyleSheet.create({
  root: { gap: 8, marginTop: 12 }, actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  button: { borderRadius: 14, paddingVertical: 10, paddingHorizontal: 14, alignSelf: 'flex-start' },
  backdrop: { flex: 1, justifyContent: 'center', paddingHorizontal: 16 },
  sheet: { borderRadius: 24, padding: 16, maxHeight: '100%' }, content: { gap: 14, paddingBottom: 16 },
  title: { fontSize: 20, fontWeight: '500' }, month: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  grid: { flexDirection: 'row', flexWrap: 'wrap' }, cell: { width: '14.2857%', height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 12 },
  cellLabel: { width: '14.2857%', textAlign: 'center' },
});
