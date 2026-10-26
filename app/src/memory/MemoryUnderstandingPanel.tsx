import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { AppText as Text, AppTextInput as TextInput } from '../components/AppText';
import { colors } from '../theme/colors';
import type { MemoryCandidateReview } from './memoryCandidateReview';
import { beginMemoryCandidateEdit, memoryCandidateEditSession, memoryCandidateEditableFields, memoryCandidateEditableHash } from './memoryCandidateReview';
import { acknowledgeMemoryCandidateTarget, loadPendingMemoryCandidates, updatePendingMemoryCandidates } from './memoryIngestionService';
import { getMemoryCandidateReviewStatus } from './memoryCandidatePersistence';
import { weeklyTargetHash } from './memoryWeeklyBasis';
import { subscribeMemoryProcessingWorkAvailable, subscribeMemoryProcessingUpdates } from './memoryProcessingSignals';
import { getMemoryDatabase, MEMORY_DOMAINS, type MemoryEntry } from './memoryStore';
import { isUnderstandingCandidateCurrent, readUnderstandingMessage } from './memoryUnderstanding';
import { currentStateVersion } from './memoryCurrentStateStore';
import { discardUnderstandingCandidate, getUnderstandingReviewStatus, loadUnderstandingEvidence, recheckUnderstanding, saveUnderstandingCandidate, subscribeUnderstandingChanges } from './memoryUnderstandingReview';
import { acknowledgeEpisodeSummaryCandidate } from './memoryEpisodeReview';
import { isEpisodeSummaryReviewCurrent } from './memoryEpisodeSummaryReview';

export function MemoryEpisodeSummaryEditor({ candidate, onUpdate, disabled = false }: {
  candidate: MemoryCandidateReview; onUpdate: (patch: Partial<MemoryCandidateReview>) => void; disabled?: boolean;
}) {
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState('');
  const busy = useRef(false);
  const latest = useRef(candidate);
  const live = useRef(false);
  latest.current = candidate;
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  if (!candidate.episodeSummaryEnabled || !candidate.continuationReview || candidate.source !== 'episode-memory') return null;
  const content = candidate.episodeSummary ?? '';
  const validLength = !!content.trim() && content.trim().length <= 120;
  const reviewed = isEpisodeSummaryReviewCurrent(candidate);
  return <View style={styles.section}>
    <Text style={styles.label}>经过小记</Text>
    <TextInput accessibilityLabel="经过小记" editable={!disabled && !checking} multiline value={content}
      onChangeText={episodeSummary => { onUpdate({ episodeSummary }); setNotice(''); }} style={styles.input} textAlignVertical="top" />
    <Text style={styles.hint}>{content.trim().length}/120 · {reviewed ? '这版小记已核对' : '未核对小记；可以只保存正文'}</Text>
    <Pressable disabled={disabled || checking || !validLength} onPress={() => {
      if (disabled || busy.current || !validLength) return;
      busy.current = true; setChecking(true);
      const draft = latest.current;
      void acknowledgeEpisodeSummaryCandidate(draft).then(updated => {
        if (live.current && latest.current.reviewId === draft.reviewId) {
          // Only the host marker returns; an edit made while checking stays intact.
          onUpdate({ episodeSummaryReview: updated.episodeSummaryReview }); setNotice('');
        }
      }).catch(() => { if (live.current) setNotice('核对未完成，输入已保留。'); })
        .finally(() => { busy.current = false; if (live.current) setChecking(false); });
    }}><Text style={disabled || checking || !validLength ? styles.hint : styles.link}>{checking ? '核对中…' : '小记已核对'}</Text></Pressable>
    {notice ? <Text style={styles.hint}>{notice}</Text> : null}
  </View>;
}

function UnderstandingEvidence({ memory }: { memory: Pick<MemoryEntry, 'understandingBasis'> }) {
  const [items, setItems] = useState<Awaited<ReturnType<typeof loadUnderstandingEvidence>> | null>(null);
  const [notice, setNotice] = useState('');
  const revision = useRef(0);
  useEffect(() => { revision.current += 1; setItems(null); return () => { revision.current += 1; }; }, [memory.understandingBasis]);
  const read = async () => {
    if (items) { setItems(null); return; }
    const current = ++revision.current;
    try {
      const result = await loadUnderstandingEvidence(memory);
      if (current === revision.current) { setItems(result); setNotice(''); }
    } catch { if (current === revision.current) setNotice('依据暂未读到，可以重试。'); }
  };
  return <View>
    <Pressable onPress={() => void read()}><Text style={styles.link}>{items ? '收起依据' : `查看依据（${memory.understandingBasis?.evidence.length ?? 0}）`}</Text></Pressable>
    {notice ? <Text style={styles.hint}>{notice}</Text> : null}
    {items ? <ScrollView nestedScrollEnabled style={styles.evidence}>{items.map(item => <View key={item.key} style={styles.section}>
      <Text style={styles.hint}>{item.label} · {item.current ? '与整理时一致' : '已改变或缺失'}</Text>
      <Text selectable style={styles.body}>{item.text}</Text>
      <Text selectable style={styles.hint}>{item.key}</Text>
    </View>)}</ScrollView> : null}
  </View>;
}

export function MemoryCandidateDraftComparison({ candidate, onUpdate, disabled = false }: {
  candidate: MemoryCandidateReview; onUpdate: (patch: Partial<MemoryCandidateReview>) => void; disabled?: boolean;
}) {
  const [persisted, setPersisted] = useState<MemoryCandidateReview | null>(null);
  const [notice, setNotice] = useState('');
  const [checking, setChecking] = useState(false);
  const latest = useRef(candidate); latest.current = candidate;
  const busy = useRef(false);
  const live = useRef(false);
  useEffect(() => {
    live.current = true; let sequence = 0;
    const read = async () => {
      const revision = ++sequence;
      const session = candidate[memoryCandidateEditSession];
      if (!session || !candidate.ingestionRefs?.length) return;
      try {
        const database = await getMemoryDatabase('ingestion');
        const row = await database.getFirstAsync<{ candidate_json: string }>(
          `SELECT candidate_json FROM memory_ingestion_items WHERE status IN ('pending','waiting')
           AND json_extract(candidate_json,'$.reviewId') = ? ORDER BY updated_at DESC LIMIT 1`, candidate.reviewId);
        if (!live.current || revision !== sequence) return;
        const stored = row ? JSON.parse(row.candidate_json) as MemoryCandidateReview : null;
        if (stored && memoryCandidateEditableHash(stored) !== session.hash
          && memoryCandidateEditableHash(latest.current) === session.hash && !disabled && !busy.current) {
          const fresh = beginMemoryCandidateEdit(stored);
          onUpdate({ ...memoryCandidateEditableFields(fresh), [memoryCandidateEditSession]: fresh[memoryCandidateEditSession] });
          setPersisted(null); setNotice(''); return;
        }
        setPersisted(stored && memoryCandidateEditableHash(stored) !== session.hash ? stored : null);
        if (stored) setNotice('');
        if (!stored) setNotice('这份草稿已在别处处理，当前输入保留；不能再次保存。');
      } catch { if (live.current && revision === sequence) setNotice('草稿对照读取失败，当前输入保留。'); }
    };
    void read();
    const unsubscribe = subscribeMemoryProcessingUpdates(() => void read());
    return () => { live.current = false; sequence++; unsubscribe(); };
  }, [candidate]);
  if (!persisted) return notice ? <Text style={styles.hint}>{notice}</Text> : null;
  return <View style={styles.section}>
    <Text style={styles.hint}>这份草稿已在别处修改。最新持久稿在这里，鼠的输入仍在下方。</Text>
    <ScrollView nestedScrollEnabled style={styles.evidence}><Text selectable style={styles.label}>{persisted.title}</Text>
      <Text selectable style={styles.body}>{persisted.content}</Text>
      <Text selectable style={styles.hint}>标签：{persisted.tags.join('、') || '无'}{`\n`}回想线索：{persisted.recallCues?.join('、') || '无'}{`\n`}记住的理由：{persisted.rememberedReason || '无'}</Text>
    </ScrollView>
    <Pressable disabled={disabled || checking} onPress={() => {
      if (disabled || busy.current) return;
      const draft = beginMemoryCandidateEdit(latest.current, memoryCandidateEditableHash(persisted));
      busy.current = true; setChecking(true);
      void updatePendingMemoryCandidates([draft]).then(() => {
        if (!live.current) return;
        onUpdate({ [memoryCandidateEditSession]: draft[memoryCandidateEditSession] });
        setPersisted(null); setNotice('已对照并暂存鼠的编辑稿。');
      }).catch(() => { if (live.current) setNotice('暂存未完成，输入保留；请重新查看最新草稿。'); })
        .finally(() => { busy.current = false; if (live.current) setChecking(false); });
    }}><Text style={styles.link}>{checking ? '暂存中…' : '已对照，继续用我的编辑稿'}</Text></Pressable>
    {notice ? <Text style={styles.hint}>{notice}</Text> : null}
  </View>;
}

export function MemoryCandidateComparison({ candidate, onUpdate, onRecheck, onStatusChange, disabled = false }: {
  candidate: MemoryCandidateReview; onUpdate: (patch: Partial<MemoryCandidateReview>) => void; disabled?: boolean;
  onRecheck?: () => Promise<void>;
  onStatusChange?: (status: MemoryCandidateReview['reviewStatus']) => void;
}) {
  const [comparison, setComparison] = useState<Awaited<ReturnType<typeof getMemoryCandidateReviewStatus>> | null>(null);
  const [notice, setNotice] = useState('');
  const busy = useRef(false);
  const live = useRef(false);
  useEffect(() => {
    live.current = true; let cancelled = false; let revision = 0;
    const read = async () => {
      const version = ++revision;
      try {
        const result = await getMemoryCandidateReviewStatus(await getMemoryDatabase(), candidate);
        if (!cancelled && version === revision) { setComparison(result); onStatusChange?.(result.status); }
      } catch { if (!cancelled) { setNotice('对照暂未读到，输入已保留。'); onStatusChange?.(undefined); } }
    };
    void read();
    const unsubscribe = subscribeMemoryProcessingWorkAvailable(() => void read());
    const active = AppState.addEventListener('change', state => { if (state === 'active') void read(); });
    return () => { cancelled = true; live.current = false; unsubscribe(); active.remove(); };
  }, [candidate]);
  const draftComparison = <MemoryCandidateDraftComparison candidate={candidate} onUpdate={onUpdate} disabled={disabled} />;
  const readingComparison = candidate.readingSourcePreview ? <View style={styles.section}>
    <Text style={styles.label}>{candidate.shiyingBindings?.length ? '本次重新核对的纸条原文' : '本次重新核对的阅读原文'}</Text>
    <ScrollView nestedScrollEnabled style={styles.evidence}><Text selectable style={styles.body}>{candidate.readingSourcePreview}</Text></ScrollView>
  </View> : null;
  if (!comparison || comparison.status === 'current') return <>{draftComparison}{readingComparison}{notice ? <Text style={styles.hint}>{notice}</Text> : null}</>;
  const target = comparison.target;
  const targetCurrentState = 'targetCurrentState' in comparison ? comparison.targetCurrentState : undefined;
  const displayedTarget = targetCurrentState ?? target;
  const newWeeklyTarget = candidate.source === 'weekly-context' && !candidate.weeklyRefresh;
  return <View style={styles.section}>
    {draftComparison}
    {readingComparison}
    <Text style={styles.hint}>{comparison.status === 'target_changed' ? '原卡有新修改，请对照最新原卡和下方编辑稿。'
      : comparison.status === 'basis_changed' ? '依据已改变，草稿保留；需要重新核对材料。'
        : comparison.status === 'archived' ? candidate.currentStateReview ? '原近况已收起，草稿保留，不能覆盖。' : '原卡已归档，草稿保留，不能覆盖。' : '原卡已删除，草稿保留，不能覆盖。'}</Text>
    {comparison.status === 'target_changed' && displayedTarget ? <>
      <Text style={styles.label}>最新原卡 · {displayedTarget.title}</Text>
      <ScrollView nestedScrollEnabled style={styles.evidence}><Text selectable style={styles.body}>{displayedTarget.content}</Text>
        {target ? <>
        <Text style={styles.hint}>{target.domain} · 重要度 {target.importance}{target.pinned ? ' · 已钉住' : ''}</Text>
        <Text style={styles.hint}>标签：{target.tags.join('、') || '无'}{`\n`}回想线索：{target.recallCues.join('、') || '无'}{`\n`}记住的理由：{target.rememberedReason || '无'}</Text>
        </> : <Text style={styles.hint}>得知时间：{targetCurrentState?.knownAt === undefined ? '未记录' : new Date(targetCurrentState.knownAt).toLocaleString('zh-CN')}</Text>}
      </ScrollView>
      {!newWeeklyTarget ? <Pressable disabled={disabled} onPress={() => {
        if (disabled || busy.current) return;
        busy.current = true;
        void acknowledgeMemoryCandidateTarget(candidate, targetCurrentState ? currentStateVersion(targetCurrentState) : weeklyTargetHash(target!)).then(updated => {
          if (live.current) { onUpdate(updated); setComparison(null); setNotice('已采用这版原卡作对照；请检查编辑稿后保存。'); }
        }).catch(() => { if (live.current) setNotice('原卡或草稿再次改变，请重新查看对照；输入已保留。'); })
          .finally(() => { busy.current = false; });
      }}><Text style={styles.link}>已对照，以这版原卡继续</Text></Pressable> : null}
    </> : null}
    {(comparison.status === 'basis_changed' || (newWeeklyTarget && comparison.status === 'target_changed')) && (candidate.source === 'weekly-context' || candidate.weeklyRefresh || candidate.continuationReview || candidate.letterBindings?.length || candidate.observationBindings?.length) && !candidate.currentStateReview && onRecheck ? <Pressable disabled={disabled}
      onPress={() => void onRecheck()}><Text style={styles.link}>{disabled ? '整理中…' : '重新整理这份草稿'}</Text></Pressable> : null}
    {notice ? <Text style={styles.hint}>{notice}</Text> : null}
  </View>;
}

export function CurrentStateCandidateEvidence({ candidate }: {
  candidate: Pick<MemoryCandidateReview, 'sourceRefs' | 'currentStateReview'>;
}) {
  const [items, setItems] = useState<Array<{ key: string; label: string; content: string }> | null>(null);
  const [notice, setNotice] = useState('');
  const revision = useRef(0);
  useEffect(() => { revision.current += 1; setItems(null); setNotice(''); return () => { revision.current += 1; }; }, [candidate.sourceRefs, candidate.currentStateReview]);
  const read = async () => {
    const version = ++revision.current;
    if (items) { setItems(null); return; }
    try {
      const result = await Promise.all((candidate.sourceRefs ?? []).map(async ref => {
        if (ref.sessionId.startsWith('observation-source:')) {
          const { readUnderstandingObservation } = await import('./memoryUnderstanding');
          const source = await readUnderstandingObservation(ref.messageId);
          const expected = candidate.currentStateReview?.evidence.find(item => 'observationId' in item && item.observationId === ref.messageId);
          return { key: ref.sessionId, label: !source ? (ref.excerpt ? '仅剩观察摘录' : '观察记录未找到')
            : `观察记录已找到 · ${new Date(source.record.capturedAt).toLocaleString('zh-CN')}${expected && source.hash !== expected.hash ? ' · 待核对' : ''}`,
            content: source ? JSON.stringify(source.record.result) : ref.excerpt ?? '' };
        }
        const source = await readUnderstandingMessage(ref.sessionId, ref.messageId);
        const expected = candidate.currentStateReview?.evidence.find(item => !('observationId' in item) && item.sessionId === ref.sessionId && item.messageId === ref.messageId);
        const status = !source ? '原话已缺失；保留摘录' : !expected ? '待核对' : source.hash === expected.hash ? '与整理时一致' : '原话已改变';
        const time = source?.message.createdAt ?? ref.messageCreatedAt;
        const role = source?.message.role ?? ref.role;
        return { key: `${ref.sessionId}/${ref.messageId}`, label: `${ref.sessionId.startsWith('letter:') ? '信件原文 · ' : ''}${role === 'I' ? '白云小姐' : '小仓鼠'} · ${time === undefined ? '时间未记录' : new Date(time).toLocaleString('zh-CN')} · ${status}`,
          content: source?.message.content ?? ref.excerpt ?? '无可用摘录' };
      }));
      if (version === revision.current) { setItems(result); setNotice(''); }
    } catch { if (version === revision.current) setNotice('出处暂未读到，草稿仍保留，可以重试。'); }
  };
  return <View>
    <Pressable onPress={() => void read()}><Text style={styles.link}>{items ? '收起出处' : `查看出处（${candidate.sourceRefs?.length ?? 0}）`}</Text></Pressable>
    {notice ? <Text style={styles.hint}>{notice}</Text> : null}
    {items?.map(item => <View key={item.key} style={styles.section}><Text style={styles.hint}>{item.label}</Text>
      <Text selectable style={styles.body}>{item.content}</Text><Text selectable style={styles.hint}>{item.key}</Text></View>)}
  </View>;
}

export function MemoryCurrentStateCard({ candidate, onUpdate, onSave, onDiscard, onRecheck, busy, notice, chatSize }: {
  candidate: MemoryCandidateReview; onUpdate: (patch: Partial<MemoryCandidateReview>) => void;
  onSave: () => void; onDiscard: () => void; onRecheck: () => Promise<void>;
  busy: boolean; notice?: string; chatSize: { height: number; width: number };
}) {
  const [checked, setChecked] = useState<{ candidate: MemoryCandidateReview; status: MemoryCandidateReview['reviewStatus'] }>();
  const review = candidate.currentStateReview!;
  const valid = checked?.candidate === candidate && checked.status === 'current';
  return <View style={[styles.card, chatSize]}>
    <Text style={styles.heading}>待确认近况 · {review.action === 'create' ? '新建' : review.action === 'update' ? '更新' : '收起'}</Text>
    <ScrollView nestedScrollEnabled keyboardShouldPersistTaps="handled" style={styles.chatBody} contentContainerStyle={styles.chatFields}>
      <MemoryCandidateComparison candidate={candidate} disabled={busy} onUpdate={onUpdate}
        onStatusChange={status => setChecked({ candidate, status })} />
      {review.targetCurrentStateId ? <><Text style={styles.label}>原稿 · {review.previousTitle}</Text>
        <Text selectable style={styles.body}>{review.previousContent}</Text></> : null}
      <Text style={styles.label}>新稿</Text>
      <TextInput accessibilityLabel="近况标题" editable={!busy} value={candidate.title} onChangeText={title => onUpdate({ title })} style={styles.input} />
      <TextInput accessibilityLabel="近况正文" editable={!busy} multiline value={candidate.content} onChangeText={content => onUpdate({ content })} style={[styles.input, styles.content]} textAlignVertical="top" />
      <Text style={styles.hint}>得知时间：{review.knownAt === undefined ? '未记录' : new Date(review.knownAt).toLocaleString('zh-CN')}</Text>
      <CurrentStateCandidateEvidence candidate={candidate} />
      {notice ? <Text accessibilityLiveRegion="polite" style={styles.hint}>{notice}</Text> : null}
    </ScrollView>
    <View style={[styles.row, styles.chatActions]}>
      <Pressable disabled={busy} onPress={onDiscard}><Text style={styles.link}>舍弃</Text></Pressable>
      <Pressable disabled={busy} onPress={() => void onRecheck()}><Text style={styles.link}>重新核对</Text></Pressable>
      <Pressable disabled={busy || !valid || !candidate.title.trim() || !candidate.content.trim()} onPress={onSave}>
        <Text style={styles.link}>{busy ? '处理中…' : '保存'}</Text></Pressable>
    </View>
  </View>;
}

export function MemoryUnderstandingCard({ candidate, onUpdate, onSave, onDiscard, chatSize }: {
  candidate: MemoryCandidateReview;
  chatSize?: { height: number; width: number };
  onUpdate: (patch: Partial<MemoryCandidateReview>) => void;
  onSave: () => void | Promise<void>;
  onDiscard: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [valid, setValid] = useState(false);
  const [checking, setChecking] = useState(true);
  const inFlight = useRef(false);
  const live = useRef(true);
  const latest = useRef(candidate);
  latest.current = candidate;
  useEffect(() => {
    let cancelled = false;
    let revision = 0;
    live.current = true;
    const check = async () => {
      const current = ++revision;
      try {
        const okay = await isUnderstandingCandidateCurrent(await getMemoryDatabase(), latest.current);
        if (!cancelled && current === revision) { setValid(okay); setChecking(false); }
      } catch { if (!cancelled && current === revision) { setValid(false); setChecking(false); } }
    };
    void check();
    const unsubscribe = subscribeMemoryProcessingWorkAvailable(() => void check());
    const active = AppState.addEventListener('change', state => { if (state === 'active') void check(); });
    return () => { cancelled = true; live.current = false; unsubscribe(); active.remove(); };
  }, [candidate.reviewId, candidate.understandingBasis, candidate.understandingReview, candidate.understandingStale]);
  const run = async (action: 'save' | 'discard' | 'recheck') => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setNotice('');
    try {
      if (action !== 'discard') await updatePendingMemoryCandidates([latest.current]);
      if (action === 'save') await onSave();
      else if (action === 'discard') await onDiscard();
      else {
        const updated = await recheckUnderstanding(latest.current);
        if (updated?.reviewId === latest.current.reviewId && live.current) onUpdate(updated);
      }
    } catch (error) {
      if (live.current) {
        setNotice(error instanceof Error && !error.message.startsWith('MEMORY_') ? error.message : '操作未完成，输入已保留；可以重新核对后再试。');
        try {
          const current = await isUnderstandingCandidateCurrent(await getMemoryDatabase(), latest.current);
          if (live.current) setValid(current);
        } catch { if (live.current) setValid(false); }
      }
    } finally { inFlight.current = false; if (live.current) setBusy(false); }
  };
  const fields = <>
    <Text style={styles.hint}>{candidate.understandingSubject === 'I' ? '白云小姐对自己的认识' : '白云小姐对小仓鼠的认识'}</Text>
    <UnderstandingEvidence memory={candidate} />
    <MemoryCandidateComparison candidate={candidate} onUpdate={onUpdate} disabled={busy} />
    {candidate.understandingReview?.targetMemoryId ? <>
      <Text style={styles.label}>原稿 · {candidate.understandingReview.previousTitle}</Text>
      <ScrollView nestedScrollEnabled style={styles.evidence}><Text selectable style={styles.body}>{candidate.understandingReview.previousContent}</Text></ScrollView>
      <Text style={styles.label}>新稿</Text>
    </> : null}
    <TextInput accessibilityLabel="认识标题" editable={!busy} value={candidate.title} onChangeText={title => onUpdate({ title })} style={styles.input} />
    <TextInput accessibilityLabel="认识正文" editable={!busy} multiline value={candidate.content} onChangeText={content => onUpdate({ content })} style={[styles.input, styles.content]} textAlignVertical="top" />
    <Text style={styles.label}>标签</Text>
    <TextInput accessibilityLabel="认识标签" editable={!busy} value={candidate.tags.join('、')} onChangeText={value => onUpdate({ tags: value.split(/[，,、\s]+/).filter(Boolean) })} style={styles.input} />
    <Text style={styles.label}>回想线索</Text>
    <TextInput accessibilityLabel="认识回想线索" editable={!busy} value={candidate.recallCues.join('、')} onChangeText={value => onUpdate({ recallCues: value.split(/[，,、\s]+/).filter(Boolean) })} style={styles.input} />
    <Text style={styles.label}>记住的理由</Text>
    <TextInput accessibilityLabel="认识记住的理由" editable={!busy} multiline value={candidate.rememberedReason ?? ''} onChangeText={rememberedReason => onUpdate({ rememberedReason })} style={styles.input} />
    <ScrollView horizontal>{MEMORY_DOMAINS.map(domain => <Pressable key={domain} disabled={busy} onPress={() => onUpdate({ domain })} style={styles.choice}><Text style={candidate.domain === domain ? styles.link : styles.hint}>{domain}</Text></Pressable>)}</ScrollView>
    <View style={styles.row}>
      <Text style={styles.hint}>重要度 {candidate.importance}</Text>
      <Pressable disabled={busy} onPress={() => onUpdate({ importance: Math.max(1, candidate.importance - 1) })}><Text style={styles.link}>−</Text></Pressable>
      <Pressable disabled={busy} onPress={() => onUpdate({ importance: Math.min(10, candidate.importance + 1) })}><Text style={styles.link}>＋</Text></Pressable>
      <Pressable disabled={busy} onPress={() => onUpdate({ pinned: !candidate.pinned })}><Text style={styles.link}>{candidate.pinned ? '已钉住' : '钉住'}</Text></Pressable>
    </View>
    <Text style={styles.hint}>{checking ? '正在核对依据…' : valid ? '确认后保存' : '依据或原稿已改变，需重新核对'}</Text>
    {notice ? <Text accessibilityLiveRegion="polite" style={styles.hint}>{notice}</Text> : null}
  </>;
  return <View style={[styles.card, chatSize]}>
    <Text style={styles.heading}>{candidate.understandingReview?.targetMemoryId ? '待确认认识更新' : '待确认新认识'}</Text>
    {chatSize ? <ScrollView nestedScrollEnabled keyboardShouldPersistTaps="handled" style={styles.chatBody} contentContainerStyle={styles.chatFields}>
      {fields}
    </ScrollView> : fields}
    <View style={[styles.row, chatSize && styles.chatActions]}>
      <Pressable disabled={busy} onPress={() => void run('discard')}><Text style={styles.link}>舍弃</Text></Pressable>
      <Pressable disabled={busy} onPress={() => void run('recheck')}><Text style={styles.link}>{busy ? '处理中…' : '重新核对'}</Text></Pressable>
      <Pressable disabled={busy || checking || !valid || !candidate.title.trim() || !candidate.content.trim()} onPress={() => void run('save')}><Text style={busy || !valid ? styles.hint : styles.link}>保存</Text></Pressable>
    </View>
  </View>;
}

export function MemoryUnderstandingPanel({ memory, onSaved }: { memory: MemoryEntry; onSaved: () => Promise<void> }) {
  const [candidates, setCandidates] = useState<MemoryCandidateReview[]>([]);
  const [status, setStatus] = useState('正在核对依据…');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const alive = useRef(false);
  const candidatesRef = useRef(candidates);
  candidatesRef.current = candidates;
  const dirtyDrafts = useRef(new Map<string, MemoryCandidateReview>());
  const version = useRef(0);
  const action = useRef(false);
  const reload = useCallback(async () => {
    const current = ++version.current;
    try {
      const [state, pending] = await Promise.all([getUnderstandingReviewStatus(memory), loadPendingMemoryCandidates({ understandingMemoryId: memory.id })]);
      if (!alive.current || version.current !== current) return;
      const restored = pending.map(candidate => {
        const dirty = dirtyDrafts.current.get(candidate.reviewId);
        return dirty ? { ...dirty, understandingStale: candidate.understandingStale, reviewStatus: candidate.reviewStatus } : candidate;
      });
      for (const dirty of dirtyDrafts.current.values()) {
        if (!restored.some(candidate => candidate.reviewId === dirty.reviewId)) restored.push({ ...dirty, reviewStatus: 'missing' });
      }
      setStatus(state === 'current' ? '依据已核对' : '依据待核对，暂不参与回想'); candidatesRef.current = restored; setCandidates(restored);
    } catch { if (alive.current && version.current === current) setNotice('状态暂未读到，请稍后刷新。'); }
  }, [memory]);
  useEffect(() => {
    alive.current = true; void reload();
    const unsubscribe = subscribeUnderstandingChanges(() => void reload());
    const unsubscribeDrafts = subscribeMemoryProcessingUpdates(() => void reload());
    return () => { alive.current = false; version.current += 1; unsubscribe(); unsubscribeDrafts(); };
  }, [reload]);
  const edit = (candidate: MemoryCandidateReview, patch: Partial<MemoryCandidateReview>) => {
    version.current += 1;
    const latest = candidatesRef.current.find(c => c.reviewId === candidate.reviewId);
    if (!latest || !alive.current) return;
    const next = { ...latest, ...patch };
    dirtyDrafts.current.set(next.reviewId, next);
    candidatesRef.current = candidatesRef.current.map(c => c.reviewId === next.reviewId ? next : c);
    setCandidates(candidatesRef.current);
    void updatePendingMemoryCandidates([next]).then(() => {
      if (dirtyDrafts.current.get(next.reviewId) === next) dirtyDrafts.current.delete(next.reviewId);
    }).catch(() => { if (alive.current) setNotice('修改暂未写入本地，请重试后再离开。'); });
  };
  const recheck = async () => {
    if (action.current) return;
    action.current = true; setBusy(true); setNotice('');
    try { await recheckUnderstanding(memory.id); }
    catch (error) { if (alive.current) setNotice(error instanceof Error ? error.message : '核对未完成，原稿已保留。'); }
    finally { action.current = false; if (alive.current) setBusy(false); }
  };
  return <View style={styles.panel}>
    <Text style={styles.heading}>{memory.understandingSubject === 'I' ? '白云小姐对自己的认识' : '白云小姐对小仓鼠的认识'}</Text>
    <Text style={styles.hint}>{status}</Text><UnderstandingEvidence memory={memory} />
    <View style={styles.row}><Pressable onPress={() => void reload()}><Text style={styles.link}>刷新状态</Text></Pressable>
      {memory.type !== 'archived' && !candidates.length ? <Pressable disabled={busy} onPress={() => void recheck()}><Text style={styles.link}>{busy ? '核对中…' : '重新核对'}</Text></Pressable> : null}</View>
    {notice ? <Text style={styles.hint}>{notice}</Text> : null}
    {candidates.map(candidate => <MemoryUnderstandingCard key={candidate.reviewId} candidate={candidate} onUpdate={patch => edit(candidate, patch)}
      onSave={async () => {
        await saveUnderstandingCandidate(candidate);
        if (!alive.current) return;
        try { await onSaved(); } catch { if (alive.current) setNotice('已保存，详情暂未刷新；请重新打开。'); }
      }}
      onDiscard={async () => { await discardUnderstandingCandidate(candidate); }} />)}
  </View>;
}

const styles = StyleSheet.create({
  panel: { gap: 8, padding: 12 }, card: { width: 292, padding: 12, gap: 8, borderRadius: 16, backgroundColor: colors.card },
  heading: { color: colors.ink, fontSize: 15, fontWeight: '700' }, label: { color: colors.ink, fontSize: 12 },
  hint: { color: colors.muted, fontSize: 12, lineHeight: 18 }, link: { color: '#567DA0', fontSize: 13, fontWeight: '600' },
  body: { color: colors.ink, fontSize: 13, lineHeight: 20 }, input: { color: colors.ink, backgroundColor: '#F4F8FC', borderRadius: 8, padding: 9, fontSize: 13 },
  content: { minHeight: 95, maxHeight: 220 }, evidence: { maxHeight: 180 }, section: { marginVertical: 7 },
  row: { flexDirection: 'row', gap: 18, alignItems: 'center', paddingVertical: 5 }, choice: { padding: 5 },
  chatBody: { flex: 1, minHeight: 0 }, chatFields: { gap: 8 },
  chatActions: { flexShrink: 0, minHeight: 44, justifyContent: 'space-between', gap: 8 },
});
