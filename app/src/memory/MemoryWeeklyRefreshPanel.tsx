import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { AppText as Text, AppTextInput as TextInput } from '../components/AppText';
import { colors } from '../theme/colors';
import type { MemoryCandidateReview } from './memoryCandidateReview';
import { loadPendingMemoryCandidates, updatePendingMemoryCandidates } from './memoryIngestionService';
import { saveWeeklyCandidate } from './memoryWeeklyCandidateActions';
import type { MemoryEntry } from './memoryStore';
import { MemoryCandidateComparison } from './MemoryUnderstandingPanel';
import {
  discardWeeklyRefreshCandidate,
  getWeeklyReviewStatus,
  loadWeeklyRefreshProgress,
  requestWeeklyRefresh,
  requestWeeklyPeriod,
  loadWeeklyPeriodProgress,
  recheckWeeklyRefreshCandidate,
  subscribeWeeklyRefreshChanges,
} from './memoryWeeklyRefresh';

type Props = { memory?: MemoryEntry; weekKey?: string; onSaved: () => Promise<void> };
type ReviewStatus = Awaited<ReturnType<typeof getWeeklyReviewStatus>>;

const STATUS_LABELS: Record<ReviewStatus, string> = {
  current: '材料已对齐',
  stale: '原周材料有更新',
  unverified: '旧周脉络，尚未核对材料',
};

export function MemoryWeeklyRefreshPanel({ memory, weekKey, onSaved }: Props) {
  const [status, setStatus] = useState<ReviewStatus | null>(null);
  const [candidates, setCandidates] = useState<MemoryCandidateReview[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const mounted = useRef(false);
  const memoryRef = useRef(memory);
  memoryRef.current = memory;
  const weekRef = useRef(weekKey);
  weekRef.current = weekKey;
  const loadRevision = useRef(0);
  const candidatesRef = useRef(candidates);
  const dirtyDrafts = useRef(new Map<string, MemoryCandidateReview>());
  const busyRef = useRef(false);

  const reload = useCallback(async () => {
    const currentMemory = memoryRef.current;
    const revision = ++loadRevision.current;
    setLoading(true);
    try {
      const [nextStatus, pending, nextProgress] = await Promise.all([
        currentMemory ? getWeeklyReviewStatus(currentMemory) : Promise.resolve(null),
        loadPendingMemoryCandidates({ weekly: true }),
        currentMemory ? loadWeeklyRefreshProgress(currentMemory.id) : weekRef.current ? loadWeeklyPeriodProgress(weekRef.current) : Promise.resolve(null),
      ]);
      if (!mounted.current || revision !== loadRevision.current) return;
      setStatus(nextStatus);
      setProgress(nextProgress);
      const visible = pending.slice(0, 1).filter(candidate => !currentMemory || candidate.weeklyRefresh?.memoryId === currentMemory.id);
      const restored = visible.map(candidate => {
        const dirty = dirtyDrafts.current.get(candidate.reviewId);
        return dirty ? { ...dirty, reviewStatus: candidate.reviewStatus } : candidate;
      });
      candidatesRef.current = restored;
      setCandidates(restored);
    } catch {
      if (mounted.current && revision === loadRevision.current) {
        setNotice('周脉络状态暂未读取成功，请稍后重试。');
      }
    } finally {
      if (mounted.current && revision === loadRevision.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const unsubscribe = subscribeWeeklyRefreshChanges(() => { void reload(); });
    return () => {
      mounted.current = false;
      loadRevision.current += 1;
      unsubscribe();
    };
  }, [reload]);

  useEffect(() => { void reload(); }, [memory, weekKey, reload]);

  const editCandidate = (candidate: MemoryCandidateReview, updates: Partial<MemoryCandidateReview>) => {
    if (busyRef.current || !mounted.current) return;
    const current = candidatesRef.current.find(item => item.reviewId === candidate.reviewId);
    if (!current) return;
    const next = { ...current, ...updates };
    dirtyDrafts.current.set(next.reviewId, next);
    // A pending read must not replace text typed after it began.
    loadRevision.current += 1;
    setLoading(false);
    candidatesRef.current = candidatesRef.current.map(item => item.reviewId === next.reviewId ? next : item);
    setCandidates(candidatesRef.current);
    void updatePendingMemoryCandidates([next]).then(() => {
      if (dirtyDrafts.current.get(next.reviewId) === next) dirtyDrafts.current.delete(next.reviewId);
    }).catch(() => {
      if (mounted.current) setNotice('候选修改暂未写入本地，请重试保存后再离开。');
    });
  };

  const runAction = async (action: 'request' | 'save' | 'discard' | 'recheck', candidate?: MemoryCandidateReview) => {
    if (busyRef.current) return;
    const latest = candidate && candidatesRef.current.find(item => item.reviewId === candidate.reviewId);
    if (action !== 'request' && !latest) return;
    if (action === 'save' && (memoryRef.current?.type === 'archived'
      || (!!latest!.reviewStatus && latest!.reviewStatus !== 'current') || !latest!.title.trim() || !latest!.content.trim())) return;
    busyRef.current = true;
    setBusy(true);
    setNotice(null);
    let savedSuccessfully = false;
    try {
      if (action === 'request') {
        if (memory) await requestWeeklyRefresh(memory.id);
        else if (weekRef.current) await requestWeeklyPeriod(weekRef.current);
      } else if (latest) {
        if (action === 'save') {
          await updatePendingMemoryCandidates([latest]);
          await saveWeeklyCandidate(latest);
          savedSuccessfully = true;
        } else if (action === 'recheck') {
          await recheckWeeklyRefreshCandidate(latest);
        } else {
          await discardWeeklyRefreshCandidate(latest);
        }
        dirtyDrafts.current.delete(latest.reviewId);
        if (action === 'save' || action === 'discard') {
          candidatesRef.current = candidatesRef.current.filter(item => item.reviewId !== latest.reviewId);
          if (mounted.current) setCandidates(candidatesRef.current);
        }
      }
      if (!mounted.current) return;
      if (action === 'save') await onSaved();
      if (!mounted.current) return;
      setNotice(action === 'request'
        ? '已提交重新整理，候选就绪后会显示在这里。'
        : action === 'recheck' ? '已提交重新核对，请查看当前候选与状态。'
        : action === 'save' ? '周回顾已保存。' : '已舍弃候选，已保存的周回顾保留。');
      await reload();
    } catch (error) {
      if (mounted.current) {
        setNotice(savedSuccessfully
          ? '周脉络已更新，详情暂未刷新，请重新打开。'
          : action === 'request' || action === 'recheck'
            ? error instanceof Error ? error.message : '重新整理暂未完成，请刷新状态后重试。'
            : '操作未完成；原文或材料可能已变化，请刷新后重试。');
      }
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const active = memory?.type !== 'archived';
  return (
    <View style={styles.panel}>
      <View style={styles.header}>
        <Text style={styles.heading}>周脉络整理</Text>
        <Pressable disabled={busy || loading} onPress={() => void reload()}>
          <Text style={styles.link}>刷新状态</Text>
        </Pressable>
      </View>
      <Text style={styles.hint}>{loading ? '正在核对材料…' : status ? STATUS_LABELS[status] : '周日 21:00 后准备最近一期；历史周可以手动整理。'}</Text>
      <Text style={styles.hint}>按原周范围重新整理；确认候选后更新这条周脉络。</Text>
      {progress && !candidates.length ? <Text style={styles.hint}>{progress}</Text> : null}
      {active && (!memory || status !== 'current') ? (
        <Pressable
          disabled={busy || loading || (!!memory && !status) || candidates.length > 0 || (!memory && !weekKey)}
          onPress={() => void runAction('request')}
          style={[styles.button, (busy || loading || (!!memory && !status) || candidates.length > 0 || (!memory && !weekKey)) && styles.disabled]}
        >
          <Text style={styles.buttonText}>{memory ? '重新整理' : '整理所选周'}</Text>
        </Pressable>
      ) : null}
      {!active ? <Text style={styles.hint}>这条周脉络已归档。</Text> : null}
      {notice ? <Text accessibilityLiveRegion="polite" style={styles.notice}>{notice}</Text> : null}
      {candidates.map(candidate => (
        <View key={candidate.reviewId} style={styles.candidate}>
          <Text style={styles.heading}>{candidate.weeklyRefresh ? '待确认更新' : '待确认周回顾'}</Text>
          <ScrollView nestedScrollEnabled keyboardShouldPersistTaps="handled" style={styles.editorBody}>
          <MemoryCandidateComparison candidate={candidate} onUpdate={patch => editCandidate(candidate, patch)}
            onStatusChange={reviewStatus => {
              if (!mounted.current || !reviewStatus) return;
              const current = candidatesRef.current.find(item => item.reviewId === candidate.reviewId);
              if (!current || current.reviewStatus === reviewStatus) return;
              candidatesRef.current = candidatesRef.current.map(item => item.reviewId === candidate.reviewId ? { ...item, reviewStatus } : item);
              setCandidates(candidatesRef.current);
            }}
            onRecheck={() => runAction('recheck', candidate)} disabled={busy} />
          {candidate.weeklyContextBasis ? (
            <Text style={styles.hint}>
              原周范围：{new Date(candidate.weeklyContextBasis.startAt).toLocaleDateString('zh-CN')}
              {' 至 '}{new Date(candidate.weeklyContextBasis.endAt - 1).toLocaleDateString('zh-CN')}（固定）
            </Text>
          ) : null}
          {candidate.weeklyRefresh ? <><Text style={styles.label}>原周脉络 · {candidate.weeklyRefresh.previousTitle}</Text>
          <ScrollView nestedScrollEnabled style={styles.previousBody}>
            <Text selectable style={styles.body}>{candidate.weeklyRefresh?.previousContent}</Text>
          </ScrollView></> : null}
          <Text style={styles.label}>新候选</Text>
          <TextInput
            accessibilityLabel="周脉络候选标题"
            editable={!busy}
            onChangeText={title => editCandidate(candidate, { title })}
            placeholder="记忆标题"
            placeholderTextColor={colors.muted}
            style={styles.input}
            value={candidate.title}
          />
          <TextInput
            accessibilityLabel="周脉络候选正文"
            editable={!busy}
            multiline
            onChangeText={content => editCandidate(candidate, { content })}
            style={[styles.input, styles.bodyInput]}
            textAlignVertical="top"
            value={candidate.content}
          />
          <TextInput
            accessibilityLabel="周脉络候选标签"
            editable={!busy}
            onChangeText={value => editCandidate(candidate, { tags: value.split(/[，,、\s]+/).filter(Boolean) })}
            placeholder="标签，用顿号隔开"
            placeholderTextColor={colors.muted}
            style={styles.input}
            value={candidate.tags.join('、')}
          />
          <TextInput
            accessibilityLabel="周脉络候选想起词"
            editable={!busy}
            onChangeText={value => editCandidate(candidate, { recallCues: value.split(/[，,、\s]+/).filter(Boolean) })}
            placeholder="想起词，用顿号隔开"
            placeholderTextColor={colors.muted}
            style={styles.input}
            value={candidate.recallCues.join('、')}
          />
          <TextInput
            accessibilityLabel="周脉络候选留下理由"
            editable={!busy}
            multiline
            onChangeText={rememberedReason => editCandidate(candidate, { rememberedReason })}
            placeholder="为什么留下"
            placeholderTextColor={colors.muted}
            style={styles.input}
            value={candidate.rememberedReason ?? ''}
          />
          </ScrollView>
          <View style={styles.actions}>
            <Pressable disabled={busy} onPress={() => void runAction('discard', candidate)} style={[styles.button, styles.secondary, busy && styles.disabled]}>
              <Text style={styles.buttonText}>舍弃候选</Text>
            </Pressable>
            <Pressable
              disabled={busy || !active || (!!candidate.reviewStatus && candidate.reviewStatus !== 'current') || !candidate.title.trim() || !candidate.content.trim()}
              onPress={() => void runAction('save', candidate)}
              style={[styles.button, (busy || !active || !candidate.title.trim() || !candidate.content.trim()) && styles.disabled]}
            >
              <Text style={styles.buttonText}>{candidate.weeklyRefresh ? '确认更新' : '确认保存'}</Text>
            </Pressable>
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { marginTop: 12, borderRadius: 14, padding: 12, gap: 8, backgroundColor: '#F2F9FF', borderWidth: 1, borderColor: '#DDECF8' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  heading: { color: colors.ink, fontSize: 14, fontWeight: '700' },
  label: { color: colors.ink, fontSize: 12, fontWeight: '600' },
  hint: { color: colors.muted, fontSize: 11, lineHeight: 17 },
  link: { color: '#5683A9', fontSize: 11, paddingVertical: 6 },
  notice: { color: '#986353', fontSize: 11, lineHeight: 17 },
  candidate: { gap: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: '#DDECF8' },
  editorBody: { maxHeight: 360 },
  previousBody: { maxHeight: 160, backgroundColor: '#FFFFFF', borderRadius: 10, padding: 8 },
  body: { color: colors.ink, fontSize: 12, lineHeight: 19 },
  input: { backgroundColor: '#FFFFFF', color: colors.ink, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 9, fontSize: 12, lineHeight: 19 },
  bodyInput: { minHeight: 140, maxHeight: 260 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 8 },
  button: { alignSelf: 'flex-start', borderRadius: 11, backgroundColor: '#FFE3DB', paddingHorizontal: 12, paddingVertical: 10 },
  secondary: { backgroundColor: '#E6F3FF' },
  buttonText: { color: colors.ink, fontSize: 12, fontWeight: '600' },
  disabled: { opacity: 0.45 },
});
