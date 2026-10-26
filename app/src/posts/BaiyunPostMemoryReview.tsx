import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppText as Text, AppTextInput as TextInput } from '../components/AppText';
import { canCommitBackupRestoreDataEpoch, captureBackupRestoreDataEpoch, subscribeBackupRestoreRuntimeState } from '../backup/backupRestoreCoordinator';
import { acknowledgeMemoryCandidateTarget, updatePendingMemoryCandidates } from '../memory/memoryIngestionService';
import type { MemoryCandidateReview } from '../memory/memoryCandidateReview';
import { getMemoryCandidateReviewStatus } from '../memory/memoryCandidatePersistence';
import { currentStateVersion } from '../memory/memoryCurrentStateStore';
import { getMemoryDatabase, MEMORY_DOMAINS } from '../memory/memoryStore';
import { weeklyTargetHash } from '../memory/memoryWeeklyBasis';
import { subscribeMemoryProcessingUpdates } from '../memory/memoryProcessingSignals';
import { discardPostReviewCandidate, loadPostMemoryOrganizationStatus, loadPostReviewCandidates,
  loadPostReviewSourceText, organizePostMemory, savePostReviewCandidate } from './baiyunPostMemoryRuntime';
import type { PostMemoryRuntimeState } from './baiyunPostMemoryState';
import { subscribeBaiyunPosts } from './baiyunPostStore';
import { postColors, postStyles as s } from './baiyunPostStyles';

function statusLabel(status: PostMemoryRuntimeState['status']) {
  const labels: Partial<Record<NonNullable<PostMemoryRuntimeState['status']>, string>> = {
    waiting_review: '先处理眼前草稿，再整理后续内容。', before_evening: '晚上21点后，有待处理内容才自动整理。',
    empty: '没有待整理的新内容。', configuration: '请先配置记忆整理模型。', disabled: '自动调用已关闭，可手动整理。',
    budget: '等待调用额度或间隔。', running: '正在整理动态记忆…', failed: '整理未完成，原文与进度保留。',
    ready: '草稿已准备，可以查看。', long_sentence: '动态单句过长，暂未整理。', needs_recheck: '原文有变化，草稿待核对。' };
  return labels[status ?? 'empty'] ?? '';
}
function draftKind(candidate: MemoryCandidateReview) {
  if (candidate.postCorrection) return candidate.currentStateReview ? '近况更正' : candidate.understandingSubject ? '认识更正' : '记忆更正';
  return candidate.currentStateReview ? candidate.currentStateReview.action === 'close' ? '近况收起' : candidate.currentStateReview.action === 'update' ? '近况更新' : '近况'
    : candidate.understandingSubject ? candidate.understandingSubject === 'you' ? '白云小姐对小仓鼠的认识' : '白云小姐对自己的认识'
      : candidate.continuationReview ? '经过更新' : candidate.atomicKind === 'stage_conclusion' ? '经过' : '记忆';
}

export function BaiyunPostMemoryReview({ onOpenPost, onOpenChange, active = true }: {
  onOpenPost?: (postId: string) => void; onOpenChange?: (open: boolean) => void; active?: boolean;
}) {
  const [candidates, setCandidates] = useState<MemoryCandidateReview[]>([]);
  const [status, setStatus] = useState<PostMemoryRuntimeState | undefined>();
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState<{ candidate: MemoryCandidateReview; epoch: number | null } | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const live = useRef(false), action = useRef(false), flight = useRef(false), again = useRef(false);
  const edits = useRef(new Map<string, MemoryCandidateReview>());
  const editsEpoch = useRef(captureBackupRestoreDataEpoch()), handledIds = useRef(new Set<string>());
  const read = async () => {
    if (flight.current) { again.current = true; return; }
    flight.current = true;
    try {
      do {
        again.current = false;
        const epoch = captureBackupRestoreDataEpoch();
        const [pending, state] = await Promise.all([loadPostReviewCandidates(), loadPostMemoryOrganizationStatus()]);
        if (live.current && canCommitBackupRestoreDataEpoch(epoch)) {
          if (editsEpoch.current !== epoch) { edits.current.clear(); handledIds.current.clear(); editsEpoch.current = epoch; }
          setCandidates(pending.filter(candidate => !handledIds.current.has(candidate.reviewId)));
          setStatus(state); setRefreshVersion(value => value + 1);
        }
      } while (live.current && again.current);
    } catch { if (live.current) setNotice('动态记忆草稿读取失败，请刷新重试。'); }
    finally { flight.current = false; }
  };
  useEffect(() => {
    live.current = true;
    const updates = subscribeMemoryProcessingUpdates(() => { void read(); });
    const posts = subscribeBaiyunPosts(() => { void read(); });
    const restore = subscribeBackupRestoreRuntimeState(() => { void read(); });
    void read();
    return () => { live.current = false; updates(); posts(); restore(); };
  }, []);
  useEffect(() => { onOpenChange?.(Boolean(selected)); return () => onOpenChange?.(false); }, [Boolean(selected), onOpenChange]);
  const organize = async () => {
    if (action.current) return;
    action.current = true; setBusy(true); setNotice('');
    try { const result = await organizePostMemory({ manual: true }); if (live.current) setStatus(result); }
    catch { if (live.current) setNotice('整理未完成，已有草稿和原文保留；可以重试。'); }
    finally { action.current = false; if (live.current) { setBusy(false); void read(); } }
  };
  const handled = (reviewId: string) => {
    handledIds.current.add(reviewId);
    edits.current.delete(reviewId);
    if (live.current) { setSelected(null); setCandidates(previous => previous.filter(candidate => candidate.reviewId !== reviewId)); void read(); }
  };
  return <View style={[s.section, { backgroundColor: postColors.surface, borderRadius: 16 }]}>
    <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => setExpanded(value => !value)} style={s.row}>
      <Text style={[s.link, s.grow]}>待确认记忆 · {candidates.length}</Text><Text style={s.link}>{expanded ? '收起' : '展开'}</Text>
    </Pressable>
    {expanded ? <>
      <Text style={s.muted}>{statusLabel(status?.status)}</Text>
      {notice ? <Text accessibilityRole="alert" style={s.error}>{notice}</Text> : null}
      <View style={s.row}>
        <Pressable disabled={busy || !active || Boolean(selected)} onPress={() => void organize()} style={s.button}><Text style={s.link}>{busy ? '整理中…' : '整理动态记忆'}</Text></Pressable>
        <Pressable disabled={busy} onPress={() => { setNotice(''); void read(); }} style={s.button}><Text style={s.link}>刷新草稿</Text></Pressable>
      </View>
      {candidates.map(candidate => <Pressable key={candidate.reviewId} disabled={busy || !active} style={[s.card, s.cloudCard]}
        onPress={() => setSelected({ candidate: edits.current.get(candidate.reviewId) ?? candidate, epoch: captureBackupRestoreDataEpoch() })}>
        <Text style={s.muted}>{draftKind(candidate)}{candidate.reviewStatus && candidate.reviewStatus !== 'current' ? ' · 待核对' : ''}</Text>
        <Text style={s.heading}>{edits.current.get(candidate.reviewId)?.title ?? candidate.title}</Text>
        <Text style={s.link}>查看草稿</Text>
      </Pressable>)}
      {!candidates.length ? <Text style={s.muted}>没有待确认的动态记忆。</Text> : null}
    </> : null}
    {selected ? <PostMemoryDraft candidate={selected.candidate} epoch={selected.epoch} refreshVersion={refreshVersion}
      onClose={() => setSelected(null)} onHandled={() => handled(selected.candidate.reviewId)} onOpenPost={onOpenPost}
      onDraftChange={candidate => { edits.current.set(candidate.reviewId, candidate); }} /> : null}
  </View>;
}

type ReviewStatus = Awaited<ReturnType<typeof getMemoryCandidateReviewStatus>>;
function PostMemoryDraft({ candidate, epoch, refreshVersion, onClose, onHandled, onDraftChange, onOpenPost }: {
  candidate: MemoryCandidateReview; epoch: number | null; refreshVersion: number; onClose: () => void;
  onHandled: () => void; onDraftChange: (draft: MemoryCandidateReview) => void; onOpenPost?: (postId: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const [draft, setDraft] = useState(candidate), current = useRef(candidate);
  const [checked, setChecked] = useState<ReviewStatus>({ status: candidate.reviewStatus ?? 'current' });
  const [notice, setNotice] = useState(''), [sources, setSources] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const locked = useRef(false), live = useRef(true), revision = useRef(0), checkVersion = useRef(0);
  const validEpoch = canCommitBackupRestoreDataEpoch(epoch);
  const check = async () => {
    const version = ++checkVersion.current;
    try {
      if (!canCommitBackupRestoreDataEpoch(epoch)) return;
      const status = await getMemoryCandidateReviewStatus(await getMemoryDatabase(), current.current);
      if (live.current && version === checkVersion.current && canCommitBackupRestoreDataEpoch(epoch)) setChecked(status);
    } catch { if (live.current && version === checkVersion.current) setNotice('原稿与依据暂未核对成功，可以刷新重试。'); }
  };
  useEffect(() => { live.current = true; return () => { live.current = false; checkVersion.current++; }; }, []);
  useEffect(() => { void check(); }, [refreshVersion]);
  const edit = (patch: Partial<MemoryCandidateReview>) => {
    if (locked.current || !canCommitBackupRestoreDataEpoch(epoch)) return;
    const next = { ...current.current, ...patch }, version = ++revision.current;
    current.current = next; setDraft(next); onDraftChange(next);
    void updatePendingMemoryCandidates([next]).then(() => { if (live.current && version === revision.current) setNotice(''); })
      .catch(() => { if (live.current && version === revision.current) setNotice('草稿暂存失败，输入仍保留；保存时会重新写入。'); });
  };
  const act = async (kind: 'save' | 'compare' | 'discard' | 'close' | 'recheck'): Promise<boolean> => {
    if (locked.current) return false;
    const latest = current.current;
    if (kind !== 'close' && !canCommitBackupRestoreDataEpoch(epoch)) { setNotice('数据已恢复，旧草稿不能保存；输入保留，请重新打开核对。'); return false; }
    if ((kind === 'save' || kind === 'compare') && (!latest.title.trim() || !latest.content.trim())) { setNotice('标题和正文不能为空。'); return false; }
    locked.current = true; revision.current++; setBusy(true); setNotice('');
    try {
      if (kind === 'close') {
        if (canCommitBackupRestoreDataEpoch(epoch)) await updatePendingMemoryCandidates([latest]);
        if (live.current) onClose(); return true;
      }
      if (kind === 'discard') { await discardPostReviewCandidate(latest, epoch); if (live.current) onHandled(); return true; }
      // Await this exact visible draft, rather than merely draining an older write queue.
      await updatePendingMemoryCandidates([latest]);
      if (!canCommitBackupRestoreDataEpoch(epoch)) throw new Error('MEMORY_DATA_CHANGED');
      if (kind === 'recheck') {
        const result = await organizePostMemory({ manual: true, recheck: latest });
        const pending = await loadPostReviewCandidates();
        if (pending.some(value => value.reviewId === latest.reviewId)) {
          if (live.current) setNotice(`重新核对尚未完成，输入仍保留。${statusLabel(result.status)}`); return false;
        }
        if (live.current) onHandled(); return true;
      }
      let saving = latest;
      if (kind === 'compare') {
        const targetHash = checked.targetCurrentState ? currentStateVersion(checked.targetCurrentState)
          : checked.target ? weeklyTargetHash(checked.target) : undefined;
        if (checked.status !== 'target_changed' || !targetHash) throw new Error('MEMORY_CANDIDATE_CHANGED');
        saving = await acknowledgeMemoryCandidateTarget(latest, targetHash);
        current.current = saving; if (live.current) { setDraft(saving); setChecked({ status: 'current' }); onDraftChange(saving); }
      } else if (checked.status !== 'current') throw new Error('MEMORY_CANDIDATE_CHANGED');
      await savePostReviewCandidate(saving, epoch);
      if (live.current) onHandled(); return true;
    } catch {
      if (live.current) { setNotice(kind === 'close' ? '草稿暂存失败，输入仍保留；暂未关闭。'
        : kind === 'discard' ? '舍弃未完成，草稿仍保留。' : kind === 'recheck' ? '重新核对失败，原输入仍保留。'
          : '保存未完成，编辑稿保留；请核对原稿和依据。'); void check(); }
      return false;
    } finally { locked.current = false; if (live.current) setBusy(false); }
  };
  const showSources = async () => {
    if (locked.current) return;
    if (sources !== null) { setSources(null); return; }
    locked.current = true; setBusy(true);
    try { const text = await loadPostReviewSourceText(current.current); if (live.current && canCommitBackupRestoreDataEpoch(epoch)) setSources(text); }
    catch { if (live.current) setNotice('出处暂未读到，可以重试。'); }
    finally { locked.current = false; if (live.current) setBusy(false); }
  };
  const previous = draft.currentStateReview ?? draft.understandingReview ?? draft.continuationReview;
  const target = checked.targetCurrentState ?? checked.target;
  const fields = [
    { label: '标题', value: draft.title, patch: (title: string) => ({ title }) },
    { label: '正文', value: draft.content, patch: (content: string) => ({ content }) },
    ...(!draft.currentStateReview ? [
      { label: '标签', value: draft.tags.join('、'), patch: (value: string) => ({ tags: value.split(/[，,、\s]+/).filter(Boolean) }) },
      { label: '回想线索', value: draft.recallCues.join('、'), patch: (value: string) => ({ recallCues: value.split(/[，,、\s]+/).filter(Boolean) }) },
      { label: '记住的理由', value: draft.rememberedReason ?? '', patch: (rememberedReason: string) => ({ rememberedReason }) },
    ] : []),
  ];
  return <Modal transparent visible animationType="fade" onRequestClose={() => void act('close')}>
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={[s.overlay, { paddingTop: Math.max(insets.top, 20), paddingBottom: Math.max(insets.bottom, 20) }]}>
      <View style={[s.dialog, { height: '88%', maxHeight: '88%', padding: 0, overflow: 'hidden' }]}>
        <ScrollView accessibilityLabel="动态记忆可滚动正文" style={{ flex: 1 }} contentContainerStyle={s.section} keyboardShouldPersistTaps="handled">
          <Text style={s.heading}>{draftKind(draft)}</Text>
          {draft.currentStateReview ? <Text style={s.muted}>得知时间：{draft.currentStateReview.knownAt === undefined ? '未确认' : new Date(draft.currentStateReview.knownAt).toLocaleString('zh-CN', { hour12: false })}</Text> : null}
          {!validEpoch ? <Text accessibilityRole="alert" style={s.error}>数据已恢复，旧草稿不能保存；输入仍保留。</Text> : null}
          {checked.status !== 'current' ? <Text style={s.error}>{checked.status === 'target_changed' ? '原卡有新修改，请对照后再保存。'
            : checked.status === 'basis_changed' ? '依据有变化，需重新核对；编辑稿保留。'
              : checked.status === 'missing' ? '原卡已删除，不能覆盖或另存。' : '原卡已归档或收起，不能直接覆盖。'}</Text> : null}
          {previous?.previousContent ? <View style={s.card}><Text style={s.muted}>原稿 · {previous.previousTitle}</Text><Text selectable style={s.text}>{previous.previousContent}</Text></View> : null}
          {checked.status === 'target_changed' && target ? <View style={[s.card, s.youCard]}><Text style={s.muted}>最新原卡 · {target.title}</Text><Text selectable style={s.text}>{target.content}</Text></View> : null}
          {previous?.previousContent ? <Text style={s.muted}>新稿</Text> : null}
          {fields.map(field => <View key={field.label}><Text style={s.muted}>{field.label}</Text>
            <TextInput accessibilityLabel={`动态记忆${field.label}`} value={field.value} editable={!busy && validEpoch} multiline scrollEnabled={false}
              onChangeText={value => edit(field.patch(value))} style={[s.input, field.label !== '正文' && s.field]} />
          </View>)}
          {!draft.currentStateReview ? <>
            <Text style={s.muted}>领域</Text><View style={s.wrap}>{MEMORY_DOMAINS.map(domain => <Pressable key={domain}
              disabled={busy || !validEpoch} onPress={() => edit({ domain })} style={[s.button, draft.domain === domain && s.selected]} accessibilityState={{ selected: draft.domain === domain }}><Text style={s.link}>{domain}</Text></Pressable>)}</View>
            <View style={s.row}><Text style={[s.muted, s.grow]}>重要度 {draft.importance}</Text>
              <Pressable accessibilityLabel="降低动态记忆重要度" disabled={busy || !validEpoch} onPress={() => edit({ importance: Math.max(1, draft.importance - 1) })} style={s.button}><Text style={s.link}>−</Text></Pressable>
              <Pressable accessibilityLabel="提高动态记忆重要度" disabled={busy || !validEpoch} onPress={() => edit({ importance: Math.min(10, draft.importance + 1) })} style={s.button}><Text style={s.link}>＋</Text></Pressable>
              <Pressable disabled={busy || !validEpoch} onPress={() => edit({ pinned: !draft.pinned })} style={[s.button, draft.pinned && s.selected]}><Text style={s.link}>{draft.pinned ? '已钉住' : '钉住'}</Text></Pressable>
            </View>
          </> : null}
          <Pressable disabled={busy || !validEpoch} onPress={() => void showSources()} style={s.button}><Text style={s.link}>{sources !== null ? '收起出处' : '查看出处'}</Text></Pressable>
          {sources !== null ? <Text selectable style={s.text}>{sources}</Text> : null}
          {onOpenPost ? [...new Set((draft.postBindings ?? []).map(binding => binding.postId))].map((postId, index) => <Pressable key={postId} disabled={busy || !validEpoch}
            onPress={() => { void act('close').then(closed => { if (closed) onOpenPost(postId); }); }} style={s.button}><Text style={s.link}>打开原动态{index ? ` ${index + 1}` : ''}</Text></Pressable>) : null}
          {checked.status === 'basis_changed' ? <Pressable disabled={busy || !validEpoch} onPress={() => void act('recheck')} style={s.button}><Text style={s.link}>重新核对</Text></Pressable> : null}
        </ScrollView>
        <View accessibilityLabel="动态记忆固定操作栏" style={[s.section, s.draftFooter, { flexShrink: 0, paddingTop: 10, gap: 8 }]}>
          {notice ? <Text accessibilityRole="alert" style={s.error}>{notice}</Text> : null}
          <View style={s.wrap}>
            <Pressable disabled={busy} onPress={() => void act('close')} style={s.button}><Text style={s.link}>关闭，保留草稿</Text></Pressable>
            <Pressable disabled={busy || !validEpoch} onPress={() => void act('discard')} style={s.button}><Text style={s.muted}>舍弃</Text></Pressable>
            <Pressable disabled={busy || !validEpoch || !['current', 'target_changed'].includes(checked.status)}
              onPress={() => void act(checked.status === 'target_changed' ? 'compare' : 'save')} style={[s.button, s.primary, busy && s.disabled]}>
              <Text style={s.primaryText}>{busy ? '请稍候…' : checked.status === 'target_changed' ? '对照后继续保存' : '保存'}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </KeyboardAvoidingView>
  </Modal>;
}
