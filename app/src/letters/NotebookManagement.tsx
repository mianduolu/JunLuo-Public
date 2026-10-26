import { useEffect, useRef, useState } from 'react';
import { Alert, Pressable, StyleSheet, Switch, View } from 'react-native';
import { AppText as Text } from '../components/AppText';
import { canCommitBackupRestoreDataEpoch, captureBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import { deleteKeywordCounterTask, loadKeywordCounterSnapshot, saveKeywordCounterSettings, updateKeywordCounterTaskStatus, type KeywordCounterSnapshot, type KeywordCounterTask } from '../chat/keywordCounterStore';
import { loadNotebookSnapshot, saveNotebookSettings, type NotebookSnapshot } from '../chat/notebookStore';
import { colors } from '../theme/colors';

type Props = {
  counters: KeywordCounterSnapshot | null;
  notebook: NotebookSnapshot | null;
  onChanged: (counters: KeywordCounterSnapshot, notebook: NotebookSnapshot) => void;
};

function formatTime(timestamp?: number) {
  return timestamp ? new Date(timestamp).toLocaleString('zh-CN', { hour12: false }) : '还没有';
}

export function NotebookManagement({ counters, notebook, onChanged }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);
  const pending = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const disabled = busy || !counters || !notebook;
  const tasks = (counters?.tasks ?? []).slice().reverse();
  const pageCount = Math.max(1, Math.ceil(tasks.length / 6));
  const currentPage = Math.min(page, pageCount - 1);

  const update = async (work: () => Promise<unknown>, epoch = captureBackupRestoreDataEpoch()) => {
    if (pending.current || !mounted.current || !counters || !notebook || !canCommitBackupRestoreDataEpoch(epoch)) return;
    pending.current = true;
    setBusy(true);
    let saved = false;
    try {
      const result = await runBackupRestoreDataEpochCommit(epoch, async () => {
        const accepted = await work();
        if (accepted === false) return null;
        saved = true;
        return Promise.all([loadKeywordCounterSnapshot(), loadNotebookSnapshot()]);
      });
      if (!mounted.current || !result.committed || !canCommitBackupRestoreDataEpoch(epoch)) return;
      if (!result.value) {
        Alert.alert('计数数量已满', '最多同时进行三项计数，请先停用或删除一项。');
        return;
      }
      onChanged(...result.value);
    } catch {
      if (mounted.current && canCommitBackupRestoreDataEpoch(epoch)) {
        Alert.alert(saved ? '已保存，刷新失败' : '未能保存', saved ? '请重新打开小本本查看最新状态。' : '本次修改没有保存，请稍后重试。');
      }
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const confirmDelete = (task: KeywordCounterTask) => {
    if (disabled || pending.current) return;
    const epoch = captureBackupRestoreDataEpoch();
    if (epoch === null) return;
    Alert.alert('删除这条小本本记录？', `关键词：${task.keywords.join('、')}`, [
      { text: '取消', style: 'cancel' },
      { text: '删除', style: 'destructive', onPress: () => void update(() => deleteKeywordCounterTask(task.id), epoch) },
    ]);
  };

  return (
    <View style={styles.panel}>
      <Text style={styles.eyebrow}>小本本管理</Text>
      <View style={styles.switchRow}>
        <Text style={styles.title}>白云偷偷记一笔</Text>
        <Switch accessibilityLabel="白云偷偷记一笔" disabled={disabled} value={notebook?.settings.enabled ?? false}
          onValueChange={enabled => void update(() => saveNotebookSettings({ enabled }))}
          trackColor={{ false: '#DFE5EA', true: '#F2C990' }} thumbColor="#FFFFFF" />
      </View>
      <Text style={styles.description}>允许白云小姐把轻巧、有纪念感的小瞬间写进本机小本本；不进入长期记忆，不云同步，30 分钟内最多新写一页。</Text>
      <View style={[styles.switchRow, styles.divider]}>
        <Text style={styles.title}>AI 自选关键词计数</Text>
        <Switch accessibilityLabel="AI 自选关键词计数" disabled={disabled} value={counters?.settings.enabled ?? false}
          onValueChange={enabled => void update(() => saveKeywordCounterSettings({ enabled }))}
          trackColor={{ false: '#DFE5EA', true: '#A9D3FA' }} thumbColor="#FFFFFF" />
      </View>
      <Text style={styles.description}>允许白云小姐悄悄选择关键词和时间段，本机只统计小仓鼠发出的聊天消息；结果会作为内部发现告诉她。</Text>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => setExpanded(value => !value)} style={styles.disclosure}>
        <Text style={styles.title}>关键词记录 · {tasks.length}</Text>
        <Text style={styles.buttonText}>{expanded ? '收起' : '管理'} {expanded ? '−' : '+'}</Text>
      </Pressable>
      {busy ? <Text accessibilityLiveRegion="polite" style={styles.description}>正在保存…</Text> : null}
      {expanded ? <>
        {tasks.slice(currentPage * 6, currentPage * 6 + 6).map(task => (
          <View key={task.id} style={styles.task}>
            <View style={styles.taskHeader}>
              <Text style={styles.title}>{task.title}</Text>
              <Text style={styles.status}>{task.status === 'completed' ? '已告诉白云' : task.status === 'disabled' ? '已停用' : '正在记'}</Text>
            </View>
            <Text style={styles.description}>{task.keywords.map(keyword => `“${keyword}”`).join('、')}</Text>
            <Text style={styles.description}>{task.type === 'nth_occurrence' ? `目标第 ${task.targetCount ?? 0} 次 · 已数到 ${task.count} 次` : `${task.endAt ? `到 ${formatTime(task.endAt)}` : '持续统计'} · 已出现 ${task.count} 次`}</Text>
            <Text style={styles.description}>最近命中：{formatTime(task.lastMatchedAt)}</Text>
            <View style={styles.actions}>
              {task.status !== 'completed' ? <Pressable accessibilityRole="button" disabled={disabled} style={[styles.button, disabled && styles.disabled]}
                onPress={() => void update(() => updateKeywordCounterTaskStatus(task.id, task.status === 'disabled' ? 'active' : 'disabled'))}>
                <Text style={styles.buttonText}>{task.status === 'disabled' ? '恢复' : '停用'}</Text>
              </Pressable> : null}
              <Pressable accessibilityRole="button" disabled={disabled} onPress={() => confirmDelete(task)} style={[styles.button, styles.deleteButton, disabled && styles.disabled]}>
                <Text style={styles.deleteText}>删除</Text>
              </Pressable>
            </View>
          </View>
        ))}
        {!tasks.length ? <Text style={styles.description}>还没有小本本记录。等我真的好奇某个词时，我会自己悄悄记下。</Text> : null}
        {pageCount > 1 ? <View style={styles.pagination}>
          <Pressable accessibilityRole="button" disabled={currentPage === 0} onPress={() => setPage(currentPage - 1)} style={[styles.button, currentPage === 0 && styles.disabled]}><Text style={styles.buttonText}>上一页</Text></Pressable>
          <Text style={styles.description}>{currentPage + 1} / {pageCount}</Text>
          <Pressable accessibilityRole="button" disabled={currentPage === pageCount - 1} onPress={() => setPage(currentPage + 1)} style={[styles.button, currentPage === pageCount - 1 && styles.disabled]}><Text style={styles.buttonText}>下一页</Text></Pressable>
        </View> : null}
      </> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { backgroundColor: '#FFFDF8', borderColor: '#F0DDBC', borderRadius: 18, borderWidth: 1, gap: 10, padding: 14 },
  eyebrow: { color: '#B17B42', fontSize: 12, fontWeight: '700' },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12, justifyContent: 'space-between' },
  title: { flexShrink: 1, color: colors.ink, fontSize: 15, fontWeight: '700', lineHeight: 22 },
  description: { color: '#806B55', fontSize: 13, lineHeight: 20 },
  divider: { borderTopColor: '#F1E2CA', borderTopWidth: 1, marginTop: 4, paddingTop: 14 },
  disclosure: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, borderTopColor: '#F1E2CA', borderTopWidth: 1, marginTop: 4, paddingTop: 10 },
  task: { backgroundColor: '#FFFFFF', borderColor: '#F1E2CA', borderRadius: 14, borderWidth: 1, gap: 8, padding: 12 },
  taskHeader: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 },
  status: { color: '#9A6530', fontSize: 12, lineHeight: 20 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 12, marginTop: 4 },
  button: { minHeight: 44, minWidth: 64, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14, borderRadius: 12, backgroundColor: '#FFF5E5' },
  buttonText: { color: '#9A6530', fontSize: 13, fontWeight: '700' },
  deleteButton: { backgroundColor: '#FFF1ED' },
  deleteText: { color: '#B46555', fontSize: 13, fontWeight: '700' },
  disabled: { opacity: 0.4 },
  pagination: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
});
