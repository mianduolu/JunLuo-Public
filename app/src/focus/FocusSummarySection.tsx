import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import type { AiConnection } from '../ai/types';
import { canCommitBackupRestoreDataEpoch, captureBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { AppText as Text, AppTextInput as TextInput } from '../components/AppText';
import type { MemoryCandidateReview } from '../memory/memoryCandidateReview';
import { updatePendingMemoryCandidates } from '../memory/memoryIngestionService';
import { loadMemorySourceMessage } from '../memory/memorySourceReader';
import { loadMemory } from '../memory/memoryStore';
import { focusJournalPalette } from './FocusJournal';
import { focusLogPurpose, formatFocusRecordedAt } from './focusOrganizationProtocol';
import { discardFocusReviewCandidate, loadFocusReviewCandidates, organizeFocusSession,
  recoverFocusOrganization, saveFocusReviewCandidate } from './focusOrganizationRuntime';
import { loadFocusOrganization } from './focusStore';
import type { FocusOrganizationRecord } from './focusSummaryRecord';

export function FocusSummarySection({ sessionId, apiKey, connection, active = true, autoOrganize = true }: {
  sessionId: string; apiKey: string; connection?: AiConnection | null; active?: boolean; autoOrganize?: boolean;
}) {
  const [record, setRecord] = useState<FocusOrganizationRecord | null>(null);
  const [candidates, setCandidates] = useState<MemoryCandidateReview[]>([]);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [reviewEpoch, setReviewEpoch] = useState<number | null>(null);
  const [busyReviewIds, setBusyReviewIds] = useState<string[]>([]);
  const live = useRef(false);
  const reading = useRef(false);
  const localEdits = useRef<{ epoch: number | null; drafts: Map<string, MemoryCandidateReview> }>({ epoch: null, drafts: new Map() });
  const keepVisibleEdits = (pending: MemoryCandidateReview[], epoch: number | null) => {
    if (localEdits.current.epoch !== epoch) localEdits.current = { epoch, drafts: new Map() };
    return pending.map(candidate => {
      const edited = localEdits.current.drafts.get(candidate.reviewId);
      return edited ? { ...candidate, title: edited.title, content: edited.content } : candidate;
    });
  };
  const read = async (retry = false) => {
    if (reading.current) return;
    reading.current = true; setBusy(true); setNotice('正在整理本次记录…');
    const epoch = captureBackupRestoreDataEpoch();
    try {
      let result = await recoverFocusOrganization(sessionId, epoch);
      if ((!result && autoOrganize || retry) && connection && apiKey.trim()) {
        result = await organizeFocusSession({ sessionId, apiKey, connection, dataEpoch: epoch, retryIncomplete: retry });
      }
      const pending = await loadFocusReviewCandidates(sessionId);
      if (!live.current || !canCommitBackupRestoreDataEpoch(epoch)) return;
      setRecord(result); setCandidates(keepVisibleEdits(pending, epoch)); setReviewEpoch(epoch);
      setNotice(!result ? (autoOrganize ? '请先在设置中配置记忆整理模型。' : '这次记录还没有小结。')
        : !result.summary ? '小结未整理成功，记忆草稿仍保留。'
          : result.candidates === undefined ? '记忆草稿未整理成功，小结已保存。' : '');
    } catch {
      const saved = await loadFocusOrganization(sessionId).catch(() => null);
      const pending = await loadFocusReviewCandidates(sessionId).catch(() => null);
      if (!live.current || !canCommitBackupRestoreDataEpoch(epoch)) return;
      setRecord(saved); if (pending) { setCandidates(keepVisibleEdits(pending, epoch)); setReviewEpoch(epoch); }
      setNotice(saved ? '整理未全部完成；已保存的小结和草稿保留，可以重试。' : '整理未完成，原日志仍保留，可以重试。');
    } finally { reading.current = false; if (live.current) setBusy(false); }
  };
  useEffect(() => {
    live.current = true;
    if (active) void read();
    return () => { live.current = false; };
  }, [sessionId, active]);

  const handled = (id: string) => setCandidates(current => current.filter(candidate => candidate.reviewId !== id));
  const retryAvailable = !record || !record.summary || record.candidates === undefined || !record.registered;
  return <View style={styles.section}>
    <View style={styles.heading}><View style={styles.mark} /><Text style={styles.title}>小结</Text></View>
    {record?.summary ? <Text selectable style={styles.summary}>{record.summary}</Text> : null}
    {notice ? <Text accessibilityRole="alert" style={styles.note}>{notice}</Text> : null}
    {!busy && retryAvailable ? <Pressable accessibilityRole="button" onPress={() => void read(true)} style={styles.retry}>
      <Text style={styles.link}>重试整理</Text>
    </Pressable> : null}
    {record?.candidates !== undefined || candidates.length ? <View style={styles.review}>
      <Pressable accessibilityRole="button" disabled={busyReviewIds.length > 0} accessibilityState={{ expanded: !collapsed }} onPress={() => setCollapsed(value => !value)} style={styles.reviewHeading}>
        <Text style={styles.reviewTitle}>待确认记忆 · {candidates.length}</Text>
        <Text style={styles.link}>{collapsed ? '展开' : '收起'}</Text>
      </Pressable>
      {!collapsed ? candidates.map(candidate => <FocusMemoryDraft key={`${candidate.reviewId}:${reviewEpoch}`} candidate={candidate}
        dataEpoch={reviewEpoch}
        onBusyChange={value => { if (live.current) setBusyReviewIds(current => value
          ? [...new Set([...current, candidate.reviewId])] : current.filter(id => id !== candidate.reviewId)); }}
        onDraftChange={next => {
          localEdits.current = { epoch: reviewEpoch, drafts: new Map(localEdits.current.drafts).set(next.reviewId, next) };
          setCandidates(current => current.map(item => item.reviewId === next.reviewId ? next : item));
        }}
        onHandled={() => { if (live.current && canCommitBackupRestoreDataEpoch(reviewEpoch)) {
          localEdits.current.drafts.delete(candidate.reviewId); handled(candidate.reviewId);
        } }} />) : null}
      {!collapsed && !candidates.length ? <Text style={styles.note}>没有待确认的记忆。</Text> : null}
    </View> : null}
  </View>;
}

function FocusMemoryDraft({ candidate, onHandled, onDraftChange, dataEpoch, onBusyChange }: {
  candidate: MemoryCandidateReview; dataEpoch: number | null;
  onHandled: () => void; onDraftChange: (candidate: MemoryCandidateReview) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [draft, setDraft] = useState(candidate);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [sources, setSources] = useState<Array<{ label: string; text: string }> | null>(null);
  const current = useRef(candidate);
  const locked = useRef(false);
  const revision = useRef(0);
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);
  const edit = (patch: Partial<MemoryCandidateReview>) => {
    if (locked.current) return;
    if (!canCommitBackupRestoreDataEpoch(dataEpoch)) { setNotice('数据已恢复，请重新进入本次记录。'); return; }
    const next = { ...current.current, ...patch };
    const editedAt = ++revision.current;
    current.current = next; setDraft(next); onDraftChange(next);
    void updatePendingMemoryCandidates([next]).then(() => {
      if (live.current && revision.current === editedAt) setNotice('');
    }).catch(() => {
      if (live.current && revision.current === editedAt) setNotice('草稿暂存失败，输入仍保留；保存时会重新写入。');
    });
  };
  const act = async (save: boolean) => {
    if (locked.current) return;
    const latest = current.current;
    if (save && (!latest.title.trim() || !latest.content.trim())) { setNotice('标题和正文不能为空。'); return; }
    locked.current = true; setBusy(true); onBusyChange(true);
    try {
      if (save) await saveFocusReviewCandidate(latest, dataEpoch); else await discardFocusReviewCandidate(latest, dataEpoch);
      onHandled();
    } catch {
      if (live.current) setNotice(save ? '保存未完成，草稿保留；请核对原记录和依据是否改变。' : '舍弃未完成，草稿仍保留。');
    } finally { locked.current = false; onBusyChange(false); if (live.current) setBusy(false); }
  };
  const showSources = async () => {
    if (sources) { setSources(null); return; }
    try {
      if (!canCommitBackupRestoreDataEpoch(dataEpoch)) throw new Error('MEMORY_DATA_CHANGED');
      const refs = current.current.sourceRefs ?? [];
      const original = await Promise.all(refs.map(async ref => {
        const message = await loadMemorySourceMessage(ref.sessionId, ref.messageId);
        return { label: message ? `${message.role === 'you' ? '小仓鼠' : '白云小姐'} · ${formatFocusRecordedAt(message.createdAt)}${message.focusContext ? ` · ${focusLogPurpose(message.focusContext.trigger)}` : ''}` : '原记录已缺失',
          text: message?.content ?? '此条依据暂时无法读取。' };
      }));
      const reviewedTarget = current.current.currentStateReview ?? current.current.understandingReview ?? current.current.continuationReview;
      if (reviewedTarget?.previousContent) original.push({
        label: `${current.current.currentStateReview ? '原近况' : '原记忆'} · ${reviewedTarget.previousTitle ?? ''}`,
        text: reviewedTarget.previousContent,
      });
      const evidence = current.current.understandingBasis?.evidence ?? current.current.continuationReview?.evidence ?? [];
      for (const id of new Set(evidence.flatMap(item => item.kind === 'memory' ? [item.memoryId] : []))) {
        const memory = await loadMemory(id);
        original.push({ label: memory?.title ?? '记忆依据已缺失', text: memory?.content ?? '此条依据暂时无法读取。' });
      }
      if (live.current && canCommitBackupRestoreDataEpoch(dataEpoch)) setSources(original.length ? original : [{ label: '出处', text: '没有可读取的原话编号。' }]);
    } catch { if (live.current) setNotice('出处暂未读到，可以重试。'); }
  };
  return <View style={styles.card}>
    <Text style={styles.kind}>{draft.currentStateReview ? '近况' : draft.understandingSubject ? '认识' : draft.atomicKind === 'stage_conclusion' ? '经过' : '记忆'}</Text>
    {draft.reviewStatus && draft.reviewStatus !== 'current' ? <Text style={styles.note}>原稿或依据有变化，草稿仍保留；请先核对出处。</Text> : null}
    <TextInput accessibilityLabel="专注记忆标题" editable={!busy} value={draft.title} onChangeText={title => edit({ title })}
      style={styles.titleInput} underlineColorAndroid="transparent" />
    <TextInput accessibilityLabel="专注记忆正文" editable={!busy} value={draft.content} onChangeText={content => edit({ content })}
      multiline scrollEnabled={false} style={styles.bodyInput} underlineColorAndroid="transparent" />
    {sources ? <View style={styles.sources}>{sources.map((source, index) => <View key={index} style={styles.source}>
      <Text style={styles.sourceLabel}>{source.label}</Text><Text selectable style={styles.sourceText}>{source.text}</Text>
    </View>)}</View> : null}
    {notice ? <Text accessibilityRole="alert" style={styles.note}>{notice}</Text> : null}
    <View style={styles.actions}>
      <Pressable accessibilityRole="button" disabled={busy} onPress={() => void showSources()} style={styles.action}><Text style={styles.link}>{sources ? '收起出处' : '查看出处'}</Text></Pressable>
      <View style={styles.actionSpacer} />
      <Pressable accessibilityRole="button" disabled={busy} onPress={() => void act(false)} style={styles.action}><Text style={styles.muted}>舍弃</Text></Pressable>
      <Pressable accessibilityRole="button" disabled={busy} onPress={() => void act(true)} style={[styles.save, busy && styles.disabled]}><Text style={styles.saveText}>{busy ? '请稍候…' : '保存'}</Text></Pressable>
    </View>
  </View>;
}

const styles = StyleSheet.create({
  section: { backgroundColor: focusJournalPalette.paper, borderRadius: 20, padding: 18, marginBottom: 16 },
  heading: { flexDirection: 'row', alignItems: 'center', gap: 9, marginBottom: 12 },
  mark: { width: 4, height: 15, borderRadius: 2, backgroundColor: focusJournalPalette.IDot },
  title: { color: '#475D70', fontSize: 17, fontWeight: '500' },
  summary: { color: '#45505A', fontSize: 15, lineHeight: 25 },
  note: { color: '#7F8890', fontSize: 12, lineHeight: 19, marginTop: 8 },
  retry: { alignSelf: 'flex-start', paddingVertical: 10 },
  link: { color: focusJournalPalette.IName, fontSize: 12, fontWeight: '500' },
  review: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#D9E2E8', marginTop: 17, paddingTop: 14 },
  reviewHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 4 },
  reviewTitle: { color: '#617484', fontSize: 14, fontWeight: '500' },
  card: { borderLeftWidth: 2, borderLeftColor: '#BED5E3', paddingLeft: 13, marginTop: 18 },
  kind: { color: '#8A9BA7', fontSize: 11, marginBottom: 6 },
  titleInput: { color: '#475D70', fontSize: 15, fontWeight: '500', padding: 0, paddingVertical: 5 },
  bodyInput: { color: '#4F5962', fontSize: 14, lineHeight: 23, textAlignVertical: 'top', padding: 0, paddingVertical: 5 },
  sources: { marginTop: 8, padding: 12, backgroundColor: 'rgba(225,235,242,0.35)', borderRadius: 10 },
  source: { marginBottom: 9 },
  sourceLabel: { color: '#72899A', fontSize: 11, lineHeight: 18 },
  sourceText: { color: '#67727B', fontSize: 12, lineHeight: 20, marginTop: 3 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10 },
  action: { paddingVertical: 10 },
  actionSpacer: { flex: 1 },
  muted: { color: '#8B969E', fontSize: 12 },
  save: { backgroundColor: '#C4DFF0', borderRadius: 12, paddingHorizontal: 19, paddingVertical: 9 },
  saveText: { color: '#476C87', fontSize: 13, fontWeight: '500' },
  disabled: { opacity: 0.55 },
});
