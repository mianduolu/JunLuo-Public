import { useEffect, useRef, useState } from 'react';
import { Alert, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppText as Text, AppTextInput } from '../components/AppText';
import { captureBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import type { getShiyingVisualPalette } from './ShiyingFeature';
import { createShiyingImageNoteResultHash } from './shiyingImageNoteContract';
import { getShiyingImageNoteSnapshot, replaceShiyingImageNoteBody } from './shiyingImageNoteStore';
import {
  getShiyingImagePreparationProgress, isShiyingImagePreparationRunning, notifyShiyingImageNotesChanged,
  getShiyingImageRecoveryState, retryShiyingImageLocalSave,
  prepareShiyingRecordImages, skipShiyingImagePreparation, subscribeShiyingImageNotes,
  type ShiyingImagePreparationResult, type ShiyingImageProgress,
} from './shiyingImageCoordinator';

type Visual = ReturnType<typeof getShiyingVisualPalette>;
function errorText(code?: string) {
  if (code === 'file_unavailable') return '图片文件不可用。';
  if (code === 'capacity_blocked') return '图文材料超出当前连接容量，尚未发起请求。';
  if (code?.includes('config_mismatch')) return '当前连接或提示词与未完成任务不一致，请恢复原设置继续，或暂时跳过。';
  if (code?.includes('interrupted')) return '上次请求被中断，远端是否计费未知；再次点击才会重试。';
  if (code === 'bad_output') return '本组返回格式不完整；可以对应的合法结果已保存，其余等待继续。';
  if (code?.includes('source')) return '来源需要重新核对，未保存失效结果。';
  return `整理未完成${code ? `（${code}）` : ''}。`;
}
function resultText(result: ShiyingImagePreparationResult) {
  switch (result.kind) {
    case 'save_pending': return '结果已收到，等待本地保存；可以再存一次。';
    case 'retry_confirmation_required': return '上次没能捡完，继续捡可能会再次产生调用费用。';
    case 'config_missing': return '请先设置看图连接和 Key。';
    case 'no_material': return '没有待整理的已定稿图片记录。';
    case 'complete': return `本次完成 ${result.completedRecordIds.length} 条图片记录，发起 ${result.callsThisAttempt} 次请求。`;
    case 'busy': return '聊天或其他任务正在运行，请稍后再试。';
    case 'blocked': case 'failed': return `${errorText(result.code)} 本次发起 ${result.callsThisAttempt} 次请求。`;
    default: return `本次发起 ${result.callsThisAttempt} 次请求；剩余 ${result.progress.totalUnits - result.progress.completedUnits} 段待整理。`;
  }
}
// A confirmation belongs to this visible action, not to a future visit or data epoch.
function useImageActionLifetime(active: boolean) {
  const state = useRef({ active, mounted: true, generation: 0, busy: false });
  state.current.active = active;
  useEffect(() => {
    state.current.mounted = true;
    return () => { state.current.mounted = false; state.current.generation++; };
  }, []);
  useEffect(() => { state.current.generation++; }, [active]);
  return {
    mounted: () => state.current.mounted,
    begin: () => {
      if (!state.current.active || state.current.busy || isShiyingImagePreparationRunning()) return null;
      state.current.busy = true;
      const generation = ++state.current.generation;
      const epoch = captureBackupRestoreDataEpoch();
      return () => state.current.mounted && state.current.active
        && generation === state.current.generation && epoch === captureBackupRestoreDataEpoch();
    },
    end: () => { state.current.busy = false; },
  };
}
async function runImageAction(current: () => boolean, recordId?: string,
  onProgress?: (value: ShiyingImagePreparationResult) => void) {
  const recovery = await getShiyingImageRecoveryState(recordId);
  if (!current()) return null;
  if (recovery.kind === 'save_pending') return retryShiyingImageLocalSave(recordId);
  if (recovery.kind === 'retry_confirmation_required') {
    const confirmed = await new Promise<boolean>(resolve => Alert.alert('',
      '上次没能捡完，继续捡可能会再次产生调用费用。', [
        { text: '先放一放', style: 'cancel', onPress: () => resolve(false) },
        { text: '继续捡', onPress: () => resolve(true) },
      ], { cancelable: true, onDismiss: () => resolve(false) }));
    if (!confirmed || !current()) return null;
  }
  return prepareShiyingRecordImages({ targetRecordId: recordId,
    retryConfirmation: recovery.retryConfirmation ?? undefined,
    onProgress: value => { if (current()) onProgress?.(value); } });
}
const emptyProgress: ShiyingImageProgress = { records: 0, totalUnits: 0, completedUnits: 0, blocked: [], skippedRecordIds: [] };
export function ShiyingImagePreparationTools({ active, visual }: { active: boolean; visual: Visual }) {
  const [progress, setProgress] = useState(emptyProgress);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ShiyingImagePreparationResult | null>(null);
  const [error, setError] = useState('');
  const [savePending, setSavePending] = useState(false);
  const action = useImageActionLifetime(active);
  useEffect(() => {
    if (!active) return;
    let live = true;
    const read = () => { void Promise.all([getShiyingImagePreparationProgress(), getShiyingImageRecoveryState()]).then(([value, recovery]) => {
      if (live) { setProgress(value); setSavePending(recovery.kind === 'save_pending'); }
    }).catch(() => { if (live) setError('图片整理进度读取失败。'); }); };
    read(); const unsubscribe = subscribeShiyingImageNotes(read);
    return () => { live = false; unsubscribe(); };
  }, [active]);
  const run = async () => {
    const current = action.begin();
    if (!current) return;
    setBusy(true); setError('');
    try {
      const value = await runImageAction(current, undefined, value => { setResult(value); setProgress(value.progress); });
      if (value && current()) { setResult(value); setSavePending(value.kind === 'save_pending'); setProgress(value.progress); }
    }
    catch { if (current()) setError('图片整理未完成。'); }
    finally { action.end(); if (action.mounted()) setBusy(false); }
  };
  return <View style={[styles.tools, { backgroundColor: visual.actionSurface }]}>
    <View style={styles.toolRow}>
      <Pressable disabled={busy || isShiyingImagePreparationRunning()} onPress={() => void run()} style={[styles.action, { backgroundColor: visual.buttonSurface, opacity: busy ? 0.5 : 1 }]}>
        <Text style={{ color: visual.buttonText }}>{busy ? '正在整理…' : savePending ? '再存一次' : progress.records ? '继续整理' : '手动检查'}</Text>
      </Pressable>
      <Text style={[styles.hint, { color: visual.secondaryText }]}>每轮最多 2 次请求</Text>
    </View>
    <Text style={[styles.hint, { color: visual.secondaryText }]}>定稿后自动整理配文和图片；按钮用于手动检查或重试。自动调用关闭时暂停。</Text>
    <Text style={[styles.hint, { color: visual.secondaryText }]}>分段与费用为本地估算；失败后等待重试，不自动重看。</Text>
    {progress.records ? <Text style={[styles.hint, { color: visual.secondaryText }]}>未完成 {progress.records} 条 · 已保存 {progress.completedUnits}/{progress.totalUnits} 段</Text> : null}
    {result?.estimatedRequests ? <Text style={[styles.hint, { color: visual.secondaryText }]}>本次机会预计 {result.estimatedRequests} 次请求，最多执行 2 次。</Text> : null}
    {result || error ? <Text accessibilityLiveRegion="polite" style={[styles.hint, { color: visual.secondaryText }]}>{error || resultText(result!)}</Text> : null}
    {progress.blocked.length && !result ? <Text style={[styles.hint, { color: visual.secondaryText }]}>{errorText(progress.blocked[0].code)}</Text> : null}
  </View>;
}

export function ShiyingRecordImageNotePanel({ recordId, visual, active }: { recordId: string; visual: Visual; active: boolean }) {
  const insets = useSafeAreaInsets();
  const [snapshot, setSnapshot] = useState<Awaited<ReturnType<typeof getShiyingImageNoteSnapshot>> | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState<{ body: string; expectedResultHash: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [savePending, setSavePending] = useState(false);
  const action = useImageActionLifetime(active && expanded);
  useEffect(() => {
    // Folded list rows retain 8B's lightweight previews; inspect full sources only on expansion.
    if (!active || !expanded) return;
    let live = true;
    const read = () => { void Promise.all([getShiyingImageNoteSnapshot(recordId), getShiyingImageRecoveryState(recordId)])
      .then(([value, recovery]) => { if (live) { setSnapshot(value); setSavePending(recovery.kind === 'save_pending'); } })
      .catch(() => { if (live) setError('图片记录读取失败。'); }); };
    read(); const unsubscribe = subscribeShiyingImageNotes(read);
    return () => { live = false; unsubscribe(); };
  }, [recordId, active, expanded]);
  const note = snapshot?.note;
  const job = snapshot?.job;
  const ready = note?.status === 'ready' && snapshot?.sourceCurrent;
  const run = async () => {
    const current = action.begin();
    if (!current) return;
    setBusy(true); setError('');
    try {
      const result = await runImageAction(current, recordId);
      if (result && current()) {
        setSavePending(result.kind === 'save_pending');
        if (result.kind !== 'complete' && result.kind !== 'progress') setError(resultText(result));
      }
    } catch { if (current()) setError('图片整理未完成。'); }
    finally { action.end(); if (action.mounted()) setBusy(false); }
  };
  const skip = async () => {
    setBusy(true); setError('');
    try { await skipShiyingImagePreparation(recordId); } catch { setError('暂时跳过失败。'); }
    finally { setBusy(false); }
  };
  const save = async () => {
    if (!editing || !editing.body.trim()) { setError('图片记录不能为空。'); return; }
    setBusy(true); setError('');
    try {
      const epoch = captureBackupRestoreDataEpoch();
      const value = await runBackupRestoreDataEpochCommit(epoch, () => replaceShiyingImageNoteBody({ recordId,
        expectedResultHash: editing.expectedResultHash, body: editing.body, editedAt: Math.max(Date.now(), note?.updatedAt ?? 0) }));
      if (!value.committed) throw new Error('restore_busy');
      setEditing(null); notifyShiyingImageNotesChanged();
    } catch { setError('保存失败或内容已变化，当前输入仍保留。'); }
    finally { setBusy(false); }
  };
  const pendingCount = job?.units.filter(unit => unit.status !== 'completed').length ?? 0;
  return <View style={[styles.panel, { backgroundColor: visual.actionSurface, borderColor: visual.cardBorder }]}>
    <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => { setSnapshot(null); setError(''); setExpanded(value => !value); }} style={styles.fold}>
      <Text style={{ color: visual.secondaryText }}>图片记录 {expanded ? '⌃' : '⌄'}{!expanded || !snapshot || ready ? '' : job?.status === 'skipped' ? ' · 暂时跳过' : ' · 尚未完成'}</Text>
    </Pressable>
    {expanded ? <>
      {ready ? <><Text selectable style={[styles.body, { color: visual.primaryText }]}>{note!.body}</Text>
        <Pressable onPress={() => { setError(''); setEditing({ body: note!.body!, expectedResultHash: createShiyingImageNoteResultHash(note!) }); }} style={styles.link}>
          <Text style={{ color: visual.accent }}>改一改</Text></Pressable></>
        : <Text style={[styles.hint, { color: visual.secondaryText }]}>{!snapshot ? '正在读取图片记录…' : note && !snapshot.sourceCurrent ? '来源需要核对，旧图片记录暂不用于回顾。'
          : job?.status === 'skipped' ? '图片还没有读完，成功分段仍保留。'
            : job ? `已保存 ${job.units.length - pendingCount}/${job.units.length} 段，全部完成后才显示完整图片记录。` : '尚未整理图片。'}</Text>}
      {job?.errorCode && job.status !== 'skipped' ? <Text style={[styles.hint, { color: visual.secondaryText }]}>{errorText(job.errorCode)}</Text> : null}
      {job || savePending ? <View style={styles.toolRow}>
        <Pressable disabled={busy || isShiyingImagePreparationRunning()} onPress={() => void run()} style={styles.link}><Text style={{ color: visual.accent }}>{savePending ? '再存一次' : job?.status === 'skipped' ? '补看' : '继续整理'}</Text></Pressable>
        {job?.status === 'blocked' || job?.units.some(unit => unit.status === 'in_flight') ? <Pressable disabled={busy || isShiyingImagePreparationRunning()} onPress={() => void skip()} style={styles.link}><Text style={{ color: visual.secondaryText }}>暂时跳过</Text></Pressable> : null}
      </View> : null}
    </> : null}
    {error && !editing ? <Text style={[styles.hint, { color: visual.secondaryText }]}>{error}</Text> : null}
    <Modal visible={active && !!editing} animationType="slide" onRequestClose={() => { if (!busy) setEditing(null); }} statusBarTranslucent>
      <KeyboardAvoidingView style={{ flex: 1, backgroundColor: visual.sheetSurface }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <View style={[styles.editHeader, { paddingTop: Math.max(16, insets.top + 8) }]}>
          <Pressable disabled={busy} onPress={() => setEditing(null)} style={styles.link}><Text style={{ color: visual.secondaryText }}>取消</Text></Pressable>
          <Text style={{ color: visual.primaryText }}>修改图片记录</Text>
          <Pressable disabled={busy} onPress={() => void save()} style={styles.link}><Text style={{ color: visual.accent }}>{busy ? '正在保存…' : '保存'}</Text></Pressable>
        </View>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 24, paddingBottom: Math.max(24, insets.bottom + 18) }}>
          <AppTextInput value={editing?.body ?? ''} multiline editable={!busy} textAlignVertical="top"
            onChangeText={body => setEditing(value => value ? { ...value, body } : value)}
            style={[styles.input, { color: visual.primaryText, borderColor: visual.cardBorder }]} />
          {error ? <Text style={[styles.hint, { color: visual.secondaryText }]}>{error}</Text> : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  </View>;
}
const styles = StyleSheet.create({
  tools: { padding: 14, borderRadius: 14, marginVertical: 12, gap: 8 },
  toolRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 12 },
  action: { paddingVertical: 12, paddingHorizontal: 15, minHeight: 44, borderRadius: 12, justifyContent: 'center' },
  hint: { fontSize: 12, lineHeight: 21 },
  panel: { paddingHorizontal: 14, borderWidth: 1, borderRadius: 12, marginTop: 4, marginBottom: 12 },
  fold: { minHeight: 44, justifyContent: 'center' },
  body: { fontSize: 15, lineHeight: 27, paddingTop: 8 },
  link: { minHeight: 44, justifyContent: 'center', paddingVertical: 12, paddingHorizontal: 4 },
  editHeader: { paddingHorizontal: 20, paddingBottom: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  input: { minHeight: 240, fontSize: 17, lineHeight: 30, paddingVertical: 16, borderTopWidth: 1, borderBottomWidth: 1 },
});
