import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, View } from 'react-native';
import type { EdgeInsets } from 'react-native-safe-area-context';
import { AppText as Text, AppTextInput as TextInput } from '../../components/AppText';
import { memoryCandidateEditSession, memoryCandidateEditableHash, type MemoryCandidateReview } from '../../memory/memoryCandidateReview';
import { MemoryCandidateDraftComparison } from '../../memory/MemoryUnderstandingPanel';
import { acknowledgeMemoryCandidateTarget, loadPendingMemoryCandidates, updatePendingMemoryCandidates, resolveMemoryIngestionItems } from '../../memory/memoryIngestionService';
import { getMemoryDatabase } from '../../memory/memoryStore';
import { weeklyTargetHash } from '../../memory/memoryWeeklyBasis';
import { loadReadingMemoryCandidateComparison, prepareReadingMemoryCandidate, recheckReadingMemoryCandidate,
  saveReadingMemoryCandidate, type ReadingMemoryComparison } from '../readingMemoryReview';
import type { ReadingResultItem } from '../readingResults';
import { readingStyles as styles } from './readingStyles';

async function verifyDraftPersisted(candidate: MemoryCandidateReview) {
  const refs = candidate.ingestionRefs ?? [];
  const pending = await loadPendingMemoryCandidates({ batchIds: [...new Set(refs.map(ref => ref.batchId))], includeWaiting: true });
  const stored = pending.find(item => item.reviewId === candidate.reviewId);
  if (!stored) {
    const database = await getMemoryDatabase('ingestion');
    const rows = await Promise.all(refs.map(ref => database.getFirstAsync<{ status: string }>(
      'SELECT status FROM memory_ingestion_items WHERE batch_id = ? AND item_key = ?', ref.batchId, ref.itemKey)));
    throw new Error(refs.length && rows.every(row => !row || row.status === 'saved' || row.status === 'discarded')
      ? 'READING_MEMORY_DRAFT_HANDLED' : 'MEMORY_CANDIDATE_CHANGED');
  }
  if (memoryCandidateEditableHash(stored) !== memoryCandidateEditableHash(candidate)) throw new Error('MEMORY_CANDIDATE_CHANGED');
}

export function ReadingMemoryConfirmation({ bookId, item, insets, onClose, onSaved }: {
  bookId: string; item: ReadingResultItem; insets: EdgeInsets; onClose: () => void; onSaved: () => Promise<void>;
}) {
  const [candidate, setCandidate] = useState<MemoryCandidateReview | null>(null);
  const [notice, setNotice] = useState('正在读取阅读原记录…');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [handled, setHandled] = useState(false);
  const [comparison, setComparison] = useState<ReadingMemoryComparison | null>(null);
  const current = useRef<MemoryCandidateReview | null>(null);
  const actionBusy = useRef(false);
  const live = useRef(false);
  const editRevision = useRef(0);
  const handledRef = useRef(false);
  const retainHandledInput = (error: unknown) => {
    if (!(error instanceof Error) || error.message !== 'READING_MEMORY_DRAFT_HANDLED') return false;
    handledRef.current = true; setHandled(true);
    setNotice('这份草稿已在别处处理，当前输入保留；只能舍弃本地未存输入并关闭。');
    return true;
  };
  const statusNotice = (status: MemoryCandidateReview['reviewStatus']) => status === 'basis_changed'
    ? '阅读原记录已改变或缺失，编辑稿保留；请重新核对。'
    : status === 'target_changed' ? '原卡已改变，请对照最新原卡和编辑稿。'
      : status === 'missing' ? '原卡已删除，编辑稿保留，不能覆盖。'
        : status === 'archived' ? '原卡已归档，编辑稿保留，不能覆盖。' : '';
  const read = async () => {
    if (actionBusy.current) return;
    actionBusy.current = true; setBusy(true);
    try {
      const prepared = await prepareReadingMemoryCandidate(bookId, item);
      if (!live.current) return;
      if (prepared.candidate) {
        handledRef.current = false; setHandled(false);
        current.current = prepared.candidate; setCandidate(prepared.candidate);
        setComparison(prepared.comparison); setNotice(statusNotice(prepared.comparison.status));
      } else {
        setSaved(true); setNotice('这段阅读已在长期记忆中保存。');
      }
    } catch (error) {
      if (live.current) setNotice(error instanceof Error && /READING_MEMORY_MULTIPLE_TARGETS|多张长期记忆|多份草稿/.test(error.message)
        ? '这段阅读对应多张记忆或多份草稿，请先核对后再打开。' : '阅读原记录暂未读到，可以重试。');
    }
    finally { actionBusy.current = false; if (live.current) setBusy(false); }
  };
  useEffect(() => { live.current = true; void read(); return () => { live.current = false; }; }, [bookId, item.id]);

  const edit = (patch: Partial<MemoryCandidateReview>) => {
    if (actionBusy.current || !current.current || saved || handledRef.current) return;
    const latest = { ...current.current, ...patch };
    const revision = ++editRevision.current;
    current.current = latest; setCandidate(latest);
    void updatePendingMemoryCandidates([latest]).then(async () => {
      await verifyDraftPersisted(latest);
      if (live.current && revision === editRevision.current && comparison?.status === 'current') setNotice('');
    }).catch(error => {
      if (live.current && current.current === latest && revision === editRevision.current && !retainHandledInput(error)) setNotice('草稿暂存失败，输入仍保留；保存时会重新写入。');
    });
  };
  const recheck = async () => {
    const latest = current.current;
    if (actionBusy.current || !latest || saved || handledRef.current) return;
    actionBusy.current = true; setBusy(true);
    try {
      const result = await recheckReadingMemoryCandidate(latest);
      if (!live.current) return;
      current.current = result.candidate; setCandidate(result.candidate); setComparison(result.comparison);
      setNotice(statusNotice(result.comparison.status) || '已读取最新阅读原记录；编辑稿保留，请对照后保存。');
    } catch { if (live.current) setNotice('重新核对未完成，编辑稿保留。'); }
    finally { actionBusy.current = false; if (live.current) setBusy(false); }
  };
  const acknowledge = async () => {
    const latest = current.current, target = comparison?.target;
    if (actionBusy.current || !latest || saved || handledRef.current || !target) return;
    actionBusy.current = true; setBusy(true);
    try {
      const updated = await acknowledgeMemoryCandidateTarget(latest, weeklyTargetHash(target));
      const checked = await loadReadingMemoryCandidateComparison(updated);
      if (!live.current) return;
      current.current = updated; setCandidate(updated); setComparison(checked);
      setNotice(statusNotice(checked.status) || '已采用这版原卡作对照；请检查编辑稿后保存。');
    } catch { if (live.current) setNotice('原卡或草稿再次改变，编辑稿保留；请重新核对。'); }
    finally { actionBusy.current = false; if (live.current) setBusy(false); }
  };
  const close = async () => {
    if (actionBusy.current) return;
    actionBusy.current = true; setBusy(true);
    try {
      if (handledRef.current) throw new Error('READING_MEMORY_DRAFT_HANDLED');
      if (current.current && !saved) {
        const latest = current.current;
        await updatePendingMemoryCandidates([latest]);
        await verifyDraftPersisted(latest);
      }
      if (live.current) onClose();
    } catch (error) { if (live.current && !retainHandledInput(error)) setNotice('草稿暂存失败，输入仍保留；暂未关闭。'); }
    finally { actionBusy.current = false; if (live.current) setBusy(false); }
  };
  const save = async () => {
    const latest = current.current;
    if (actionBusy.current || !latest || saved || handledRef.current) return;
    if (!latest.title.trim() || !latest.content.trim()) { setNotice('标题和正文不能为空。'); return; }
    actionBusy.current = true; setBusy(true); setNotice('正在保存…');
    try {
      const checked = await loadReadingMemoryCandidateComparison(latest);
      if (live.current) setComparison(checked);
      if (checked.status !== 'current') { if (live.current) setNotice(statusNotice(checked.status)); return; }
      const result = await saveReadingMemoryCandidate(latest);
      // A failed reading-page refresh cannot reverse the committed memory.
      void Promise.resolve().then(onSaved).catch(() => undefined);
      if (!live.current) return;
      current.current = null; setCandidate(null); setComparison(null); setSaved(true);
      if (result.actionRecorded) void Promise.resolve().then(onClose).catch(() => {
        if (live.current) setNotice('记忆已保存；页面暂未关闭。');
      });
      else setNotice('记忆已保存；阅读页标记暂未更新，重新打开可核对。');
    } catch (error) {
      if (live.current) setNotice(`保存未完成，编辑稿保留。${error instanceof Error ? error.message : '请稍后重试。'}`);
      void loadReadingMemoryCandidateComparison(latest).then(checked => {
        if (live.current && current.current === latest) setComparison(checked);
      }).catch(() => undefined);
    } finally { actionBusy.current = false; if (live.current) setBusy(false); }
  };
  const discard = async () => {
    const latest = current.current;
    if (actionBusy.current || !latest || saved || handledRef.current) return;
    actionBusy.current = true; setBusy(true);
    try {
      if (!latest.ingestionRefs?.length) throw new Error('READING_MEMORY_DRAFT_MISSING');
      await resolveMemoryIngestionItems(latest.ingestionRefs, 'discarded', { expectedCandidate: {
        reviewId: latest.reviewId, editableHash: latest[memoryCandidateEditSession]?.hash ?? memoryCandidateEditableHash(latest),
      } });
      if (live.current) onClose();
    } catch { if (live.current) setNotice('舍弃未完成，草稿仍保留。'); }
    finally { actionBusy.current = false; if (live.current) setBusy(false); }
  };

  const fields = candidate ? [
    { label: '标题', value: candidate.title, change: (value: string) => edit({ title: value }) },
    { label: '正文', value: candidate.content, change: (value: string) => edit({ content: value }) },
    { label: '标签', value: candidate.tags.join('、'), change: (value: string) => edit({ tags: value.split(/[，,、\s]+/).filter(Boolean) }) },
    { label: '回想线索', value: candidate.recallCues.join('、'), change: (value: string) => edit({ recallCues: value.split(/[，,、\s]+/).filter(Boolean) }) },
    { label: '记住的理由', value: candidate.rememberedReason ?? '', change: (value: string) => edit({ rememberedReason: value }) },
  ] : [];
  return <Modal transparent visible animationType="fade" onRequestClose={() => void close()}>
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={[styles.readingModalLayer, { paddingTop: Math.max(insets.top, 24), paddingBottom: Math.max(insets.bottom, 24) }]}>
      <Pressable disabled={busy} onPress={() => void close()} style={styles.readingModalScrim} />
      <View style={[styles.readingModalPanel, { height: '84%', maxHeight: '84%' }]}>
        <ScrollView style={styles.readingModalScroll} contentContainerStyle={styles.readingModalContent} keyboardShouldPersistTaps="handled">
          <Text style={styles.sheetTitle}>阅读记忆草稿</Text>
          {candidate ? <MemoryCandidateDraftComparison candidate={candidate} onUpdate={edit} disabled={busy || saved || handled} /> : null}
          <Text style={styles.sheetHint}>修改后保存。原记录仍保留在阅读本中。</Text>
          {notice ? <Text accessibilityRole="alert" style={styles.sheetHint}>{notice}</Text> : null}
          {candidate?.readingReview ? <View>
            <Text style={styles.resultMeta}>原稿 · {candidate.readingReview.previousDraft.title}</Text>
            <Text selectable style={styles.sheetHint}>{candidate.readingReview.previousDraft.content}</Text>
            <Text selectable style={styles.sheetHint}>标签：{candidate.readingReview.previousDraft.tags.join('、') || '无'}{`\n`}
              回想线索：{candidate.readingReview.previousDraft.recallCues.join('、') || '无'}{`\n`}
              记住的理由：{candidate.readingReview.previousDraft.rememberedReason || '无'}</Text>
          </View> : null}
          {comparison?.status === 'target_changed' && comparison.target ? <View>
            <Text style={styles.resultMeta}>最新原卡 · {comparison.target.title}</Text>
            <Text selectable style={styles.sheetHint}>{comparison.target.content}</Text>
            <Text selectable style={styles.sheetHint}>标签：{comparison.target.tags.join('、') || '无'}{`\n`}
              回想线索：{comparison.target.recallCues.join('、') || '无'}{`\n`}
              记住的理由：{comparison.target.rememberedReason || '无'}</Text>
            <Pressable disabled={busy} onPress={() => void acknowledge()} style={styles.sheetButton}>
              <Text style={styles.sheetButtonText}>已对照，以这版原卡继续</Text>
            </Pressable>
          </View> : null}
          {comparison?.preview ? <View>
            <Text style={styles.resultMeta}>本次核对的阅读原文</Text>
            <Text selectable style={styles.sheetHint}>{comparison.preview.content}</Text>
          </View> : null}
          {candidate && !saved ? <Pressable disabled={busy || handled} onPress={() => void recheck()} style={styles.sheetButton}>
            <Text style={styles.sheetButtonText}>重新核对</Text>
          </Pressable> : null}
          {fields.map(field => <View key={field.label}>
            <Text style={styles.resultMeta}>{field.label}</Text>
            <TextInput accessibilityLabel={`阅读记忆${field.label}`} value={field.value} multiline scrollEnabled={false}
              maxLength={field.label === '记住的理由' && !candidate?.readingReview ? 80 : undefined}
              editable={!busy && !saved && !handled} onChangeText={field.change}
              style={field.label === '正文' ? styles.sheetInput : styles.sheetSingleInput} />
          </View>)}
          {!candidate && !saved && !busy ? <Pressable onPress={() => void read()} style={styles.sheetButton}><Text style={styles.sheetButtonText}>重试读取</Text></Pressable> : null}
        </ScrollView>
        <View style={styles.sheetActions}>
          <Pressable disabled={busy} onPress={() => void close()} style={styles.sheetButton}><Text style={styles.sheetButtonText}>{saved ? '关闭' : '关闭，保留草稿'}</Text></Pressable>
          {!saved ? <Pressable disabled={busy || handled || !candidate || comparison?.status !== 'current'} onPress={() => void save()} style={styles.sheetButtonPrimary}>
            <Text style={styles.sheetButtonPrimaryText}>{busy ? '请稍候…' : '放进长期记忆'}</Text>
          </Pressable> : null}
        </View>
        {candidate && !saved ? <Pressable disabled={busy || handled} onPress={() => void discard()}><Text style={styles.sheetButtonText}>舍弃草稿</Text></Pressable> : null}
        {handled ? <Pressable disabled={busy} onPress={onClose}><Text style={styles.sheetButtonText}>仅舍弃本地未存输入并关闭</Text></Pressable> : null}
      </View>
    </KeyboardAvoidingView>
  </Modal>;
}
