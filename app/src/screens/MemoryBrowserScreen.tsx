import { useEffect, useRef, useState } from 'react';
import { BackHandler, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppText as Text, AppTextInput as TextInput } from '../components/AppText';
import { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { actOnMemoryBrowserCandidate, readMemoryBrowserItem, readMemoryBrowserPage, subscribeMemoryBrowserChanges } from '../memory/memoryBrowser';
import type { MemoryBrowserAction, MemoryBrowserDetail, MemoryBrowserPage, MemoryBrowserRequest, MemoryBrowserSection } from '../memory/memoryBrowserTypes';
import { memoryCandidateEditableFields, type MemoryCandidateReview } from '../memory/memoryCandidateReview';
import { getAnchorKindLabel } from '../memory/memoryAnchorContext';
import { isEpisodeSummaryReviewCurrent } from '../memory/memoryEpisodeSummaryReview';
import { formatMemoryEventTimeLabel } from '../memory/memoryAtomicity';
import { formatMemoryEventTimeInput } from '../memory/memoryCalendarTime';
import { MEMORY_ANCHOR_KINDS, MEMORY_DOMAINS, type MemoryDraft } from '../memory/memoryStore';
import { colors } from '../theme/colors';
import type { Navigate } from '../types/navigation';

const PAGE_SIZE = 12;
const titles = { current_states: '近况', understandings: '认识', pending: '待确认' };
const time = (value?: number) => value === undefined ? '未记录' : new Date(value).toLocaleString('zh-CN');
const statusLabel = (status: string, waiting?: boolean) => waiting ? '等待同目标处理'
  : ({ current: '已核对', active: '当前', resolved: '已收起', expired: '旧规则下已过期', archived: '已归档',
    target_changed: '原卡已改变 · 待对照', basis_changed: '依据已改变 · 待核对', stale: '依据已改变 · 待核对', unverified: '依据未核对', read_failed: '来源读取失败', missing: '原卡已缺失', pending: '待确认' }[status] ?? status);
const editFields = (detail: MemoryBrowserDetail): Partial<MemoryCandidateReview> => detail.candidate
  ? memoryCandidateEditableFields(detail.candidate)
  : detail.legacyCurrentState ? { title: detail.legacyCurrentState.title, content: detail.legacyCurrentState.content } : {};
const splitTags = (value: string) => value.split(/[、,，\n]/).map(item => item.trim()).filter(Boolean);

type DisplayDraft = Partial<Pick<MemoryDraft, 'title' | 'content' | 'tags' | 'recallCues' | 'rememberedReason' | 'importance' | 'domain' | 'pinned' | 'anchor' | 'anchorKind' | 'eventTime'>>;
function DraftText({ title, draft }: { title: string; draft: DisplayDraft }) {
  return <View style={styles.source}>
    <Text style={styles.label}>{title}</Text>
    <Text selectable style={styles.body}>{draft.title}</Text>
    <Text selectable style={styles.body}>{draft.content}</Text>
    {draft.tags ? <Text selectable style={styles.meta}>标签：{draft.tags.join('、') || '无'}{`\n`}回想线索：{draft.recallCues?.join('、') || '无'}{`\n`}记住的理由：{draft.rememberedReason || '无'}</Text> : null}
    {draft.importance !== undefined ? <Text style={styles.meta}>{draft.domain} · 重要度 {draft.importance}{draft.pinned ? ' · 已钉住' : ''}{draft.anchor ? ` · ${getAnchorKindLabel(draft.anchorKind)}锚点` : ''}</Text> : null}
    {draft.importance !== undefined ? <Text selectable style={styles.meta}>事件时间：{formatMemoryEventTimeLabel(draft.eventTime)}</Text> : null}
  </View>;
}

export function MemoryBrowserScreen({ navigate, section }: { navigate: Navigate; section: MemoryBrowserSection }) {
  const insets = useSafeAreaInsets();
  const [pending, setPending] = useState(section === 'pending');
  const [history, setHistory] = useState(false);
  const [subject, setSubject] = useState<'I' | 'you'>('you');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState<MemoryBrowserPage>({ items: [], total: 0, hasMore: false });
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<MemoryBrowserDetail | null>(null);
  const [draft, setDraft] = useState<Partial<MemoryCandidateReview>>({});
  const [tagsText, setTagsText] = useState('');
  const [cuesText, setCuesText] = useState('');
  const [conflict, setConflict] = useState<MemoryBrowserDetail | null>(null);
  const [candidateHandled, setCandidateHandled] = useState(false);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const live = useRef(false);
  const listVersion = useRef(0);
  const itemVersion = useRef(0);
  const selectedRef = useRef<string | null>(null);
  const detailRef = useRef<MemoryBrowserDetail | null>(null);
  const draftRef = useRef<Partial<MemoryCandidateReview>>({});
  const dirty = useRef(false);
  const editRevision = useRef(0);
  const baseline = useRef<string | undefined>(undefined);
  const conflictRef = useRef<MemoryBrowserDetail | null>(null);
  const actionBusy = useRef(false);
  const listBusy = useRef(false);
  const editorEpoch = useRef<number | null>(null);
  const recoveryEpoch = useRef<number | null>(null);
  const recoveryUsed = useRef(false);
  const candidateHandledRef = useRef(false);
  const request: MemoryBrowserRequest = { section: pending ? 'pending' : section, search, history: section === 'understandings' && history,
    subject: section === 'understandings' ? subject : undefined,
    candidateType: section === 'current_states' ? 'current_state' : section === 'understandings' ? 'understanding' : 'all', limit: PAGE_SIZE };
  const requestRef = useRef(request); requestRef.current = request;
  const pageRef = useRef(page); pageRef.current = page;
  const activeEditor = (id: string | null) => live.current && selectedRef.current === id && canCommitBackupRestoreDataEpoch(editorEpoch.current);

  const applyDetail = (value: MemoryBrowserDetail, keepInput = false) => {
    itemVersion.current++;
    if (value.id !== selectedRef.current) { selectedRef.current = value.id; setSelected(value.id); }
    detailRef.current = value; baseline.current = value.editableHash; setDetail(value);
    conflictRef.current = null; setConflict(null);
    recoveryEpoch.current = null;
    candidateHandledRef.current = false; setCandidateHandled(false);
    if (!keepInput) {
      const fields = editFields(value); draftRef.current = fields; setDraft(fields); dirty.current = false;
      setTagsText(fields.tags?.join('、') ?? ''); setCuesText(fields.recallCues?.join('、') ?? '');
    }
  };
  const readPage = async (more = false) => {
    if (more && listBusy.current) return;
    const version = ++listVersion.current, epoch = captureBackupRestoreDataEpoch();
    listBusy.current = true; setLoading(true);
    const current = requestRef.current, previous = pageRef.current;
    try {
      const next = await readMemoryBrowserPage({ ...current, cursor: more ? previous.nextCursor : undefined });
      if (!live.current || version !== listVersion.current || !canCommitBackupRestoreDataEpoch(epoch)) return;
      setPage(more ? { ...next, items: [...previous.items, ...next.items.filter(item => !previous.items.some(old => old.id === item.id))] } : next);
      setListError('');
    } catch (error) {
      if (live.current && version === listVersion.current) setListError(`列表读取失败，已显示记录保留。${error instanceof Error ? error.message : ''}`);
    } finally {
      if (live.current && version === listVersion.current) { listBusy.current = false; setLoading(false); }
    }
  };
  const markHandledDraft = (error: unknown) => {
    if (!(error instanceof Error) || !['MEMORY_CANDIDATE_CHANGED', 'MEMORY_CANDIDATE_MISSING'].includes(error.message)
      || (!detailRef.current?.candidate && !detailRef.current?.legacyCurrentState)) return false;
    candidateHandledRef.current = true; setCandidateHandled(true);
    conflictRef.current = null; setConflict(null);
    setNotice('这份草稿已在别处处理。当前输入保留，不能继续保存；可以舍弃本地未存输入并关闭。');
    return true;
  };
  const refreshItem = async (id: string, version = ++itemVersion.current) => {
    try {
      const next = await readMemoryBrowserItem(id);
      if (!activeEditor(id) || version !== itemVersion.current) return;
      if (dirty.current || actionBusy.current) {
        if (!dirty.current && !next.candidate && !next.legacyCurrentState) { applyDetail(next); return; }
        if (next.editableHash !== baseline.current) {
          conflictRef.current = next; setConflict(next); setNotice('草稿已在别处改变。当前输入保留，请对照最新草稿后暂存。');
        } else { detailRef.current = next; setDetail(next); }
      } else { applyDetail(next); setNotice(''); }
    } catch (error) {
      if (activeEditor(id) && version === itemVersion.current && !markHandledDraft(error)) setNotice(`正文与依据读取失败，输入保留。${error instanceof Error ? error.message : ''}`);
    }
  };
  useEffect(() => {
    live.current = true;
    const unsubscribe = subscribeMemoryBrowserChanges(() => {
      void readPage();
      if (selectedRef.current) void refreshItem(selectedRef.current);
    });
    return () => { live.current = false; listVersion.current++; itemVersion.current++; unsubscribe(); };
  }, []);
  useEffect(() => { void readPage(); }, [section, pending, history, subject, search]);

  const open = (id: string) => {
    if (actionBusy.current) return;
    selectedRef.current = id; editorEpoch.current = captureBackupRestoreDataEpoch(); setSelected(id);
    recoveryEpoch.current = null; recoveryUsed.current = false;
    candidateHandledRef.current = false; setCandidateHandled(false);
    detailRef.current = null; baseline.current = undefined; draftRef.current = {}; dirty.current = false;
    conflictRef.current = null; setDetail(null); setDraft({}); setConflict(null); setNotice('');
    setTagsText(''); setCuesText('');
    void refreshItem(id);
  };
  const change = (patch: Partial<MemoryCandidateReview>) => {
    if (actionBusy.current || !detailRef.current) return;
    draftRef.current = { ...draftRef.current, ...patch }; editRevision.current++; dirty.current = true;
    setDraft(draftRef.current); setNotice('编辑尚未暂存。');
  };
  const changeTags = (key: 'tags' | 'recallCues', value: string) => {
    if (actionBusy.current) return;
    if (key === 'tags') setTagsText(value); else setCuesText(value);
    change({ [key]: splitTags(value) });
  };
  const flushDraft = async () => {
    const id = selectedRef.current;
    if (!id || !activeEditor(id)) throw new Error('数据已恢复或页面已关闭，请重新读取；输入保留。');
    if (candidateHandledRef.current) throw new Error('这份草稿已在别处处理，当前输入不能再次暂存。');
    if (conflictRef.current) throw new Error('请先对照最新草稿。');
    while (dirty.current) {
      const revision = editRevision.current;
      const result = await actOnMemoryBrowserCandidate({ id, action: 'edit', expectedEditableHash: baseline.current, patch: draftRef.current });
      if (!activeEditor(id)) throw new Error('数据已恢复，请重新读取；输入保留。');
      if (result.state !== 'applied' || !result.detail?.editableHash) throw new Error('草稿暂存未完成，输入保留。');
      applyDetail(result.detail, revision !== editRevision.current);
    }
  };
  const finish = () => {
    itemVersion.current++; selectedRef.current = null; detailRef.current = null; dirty.current = false;
    conflictRef.current = null; setSelected(null); setDetail(null); setConflict(null); setNotice('');
    recoveryEpoch.current = null; recoveryUsed.current = false;
    candidateHandledRef.current = false; setCandidateHandled(false);
  };
  const readRestoredDraft = async () => {
    const id = selectedRef.current;
    if (!id || actionBusy.current) return;
    const epoch = captureBackupRestoreDataEpoch(), version = ++itemVersion.current;
    actionBusy.current = true; recoveryUsed.current = true; recoveryEpoch.current = null;
    conflictRef.current = null; setConflict(null); setBusy(true);
    try {
      const latest = await readMemoryBrowserItem(id);
      if (!live.current || selectedRef.current !== id || version !== itemVersion.current) return;
      if (!canCommitBackupRestoreDataEpoch(epoch) || latest.id !== id) throw new Error('数据或草稿再次改变，请重新读取；原输入保留。');
      recoveryEpoch.current = epoch; conflictRef.current = latest; setConflict(latest);
      setNotice('已读取当前持久稿与依据。原输入保留；对照后暂存当前编辑稿，才能继续保存。');
    } catch (error) {
      if (live.current && selectedRef.current === id && version === itemVersion.current && !markHandledDraft(error)) setNotice(`重新读取未完成，原输入保留。${error instanceof Error ? error.message : ''}`);
    } finally { actionBusy.current = false; if (live.current) setBusy(false); }
  };
  const abandonLocalInput = () => {
    if (actionBusy.current) return;
    finish();
  };
  const run = async (action: MemoryBrowserAction['action'] | 'leave' | 'review_edit', leaveScreen = false) => {
    if (actionBusy.current) return;
    const id = selectedRef.current;
    if (!id) { if (leaveScreen) navigate(section === 'pending' ? 'memory' : 'chat'); return; }
    actionBusy.current = true; setBusy(true);
    try {
      if (candidateHandledRef.current) throw new Error('这份草稿已在别处处理，当前输入保留；可以舍弃本地未存输入并关闭。');
      if (action === 'review_edit') {
        const latest = conflictRef.current;
        if (!latest?.editableHash || (!latest.candidate && !latest.legacyCurrentState)) throw new Error('最新草稿无法编辑，当前输入保留。');
        if (recoveryEpoch.current !== null) {
          if (!canCommitBackupRestoreDataEpoch(recoveryEpoch.current)) throw new Error('数据再次恢复，请重新读取；原输入保留。');
          editorEpoch.current = recoveryEpoch.current; recoveryEpoch.current = null;
        }
        baseline.current = latest.editableHash; detailRef.current = latest; setDetail(latest); conflictRef.current = null; setConflict(null);
        dirty.current = true; editRevision.current++;
      }
      if (action !== 'discard') await flushDraft();
      if (!activeEditor(id)) throw new Error('数据已恢复，请重新读取；输入保留。');
      if (action === 'leave') { finish(); if (leaveScreen) navigate(section === 'pending' ? 'memory' : 'chat'); return; }
      if (action === 'edit' || action === 'review_edit') { setNotice('编辑稿已暂存。'); return; }
      const current = detailRef.current;
      if (action === 'save' && (!current?.candidate || current.waiting || current.status !== 'current' || conflictRef.current)) throw new Error('原卡或依据需要核对，草稿保留。');
      const result = await actOnMemoryBrowserCandidate({ id, action, expectedEditableHash: baseline.current,
        targetHash: action === 'compare' ? current?.comparison?.hash : undefined });
      if (!activeEditor(id)) return;
      if (result.state === 'saved' || result.state === 'discarded') { finish(); void readPage(); }
      else {
        if (result.detail) applyDetail(result.detail);
        setNotice(result.state === 'pending' ? '操作未完成，草稿保留，请查看状态。' : action === 'close' ? '近况已收起。' : '核对已更新，请检查完整草稿后保存。');
        if (action === 'close') void readPage();
      }
    } catch (error) {
      if (live.current && selectedRef.current === id) {
        setNotice(`操作未完成，输入保留。${error instanceof Error ? error.message : ''}`);
        if (activeEditor(id)) await refreshItem(id);
      }
    } finally { actionBusy.current = false; if (live.current) setBusy(false); }
  };
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => { void run('leave', true); return true; });
    return () => subscription.remove();
  }, []);
  const candidate = detail?.candidate;
  const epochInvalid = selected !== null && !canCommitBackupRestoreDataEpoch(editorEpoch.current);
  const saveDisabled = busy || epochInvalid || candidateHandled || !!conflict || !!detail?.waiting || detail?.status !== 'current';
  const editable = !!candidate;
  const reviewable = editable || !!detail?.legacyCurrentState;
  const generalFields = !!candidate && !candidate.currentStateReview && !candidate.readingBinding;
  const summaryEnabled = !!candidate?.episodeSummaryEnabled && !!candidate.continuationReview && candidate.source === 'episode-memory';
  const oldDraft = candidate?.readingReview?.previousDraft;
  const newComparison = detail?.comparison;
  const field = (label: string, key: 'title' | 'content' | 'rememberedReason' | 'episodeSummary' | 'manualEventTimeText', multiline = false) => <View style={styles.field}>
    <Text style={styles.label}>{label}</Text>
    <TextInput accessibilityLabel={label} value={draft[key] ?? (key === 'manualEventTimeText' ? formatMemoryEventTimeInput(draft.eventTime) : '')} editable={!busy} multiline={multiline} scrollEnabled={!multiline}
      onChangeText={value => change({ [key]: value })} style={[styles.input, multiline && styles.multiline]} textAlignVertical="top" />
  </View>;
  return <View style={styles.page}>
    <View style={styles.header}>
      <Pressable disabled={busy} onPress={() => void run('leave', true)} style={styles.back}><Text style={styles.link}>‹ 返回</Text></Pressable>
      <Text style={styles.title}>{titles[section]}</Text>
      <Pressable disabled={loading} onPress={() => void readPage()} style={styles.back}><Text style={styles.link}>刷新</Text></Pressable>
    </View>
    {section !== 'pending' ? <View style={styles.row}>
      <Pressable onPress={() => setPending(false)} style={[styles.chip, !pending && styles.chipActive]}><Text style={styles.link}>{section === 'current_states' ? '已保存近况' : '已保存认识'}</Text></Pressable>
      <Pressable onPress={() => setPending(true)} style={[styles.chip, pending && styles.chipActive]}><Text style={styles.link}>待确认</Text></Pressable>
    </View> : null}
    {section === 'understandings' ? <View style={styles.row}>
      {(['you', 'I'] as const).map(value => <Pressable key={value} onPress={() => setSubject(value)} style={[styles.chip, subject === value && styles.chipActive]}>
        <Text style={styles.link}>{value === 'you' ? '对小仓鼠的认识' : '对自己的认识'}</Text>
      </Pressable>)}
    </View> : null}
    {!pending && section === 'understandings' ? <View style={styles.row}>
      <Pressable onPress={() => setHistory(false)} style={[styles.chip, !history && styles.chipActive]}><Text style={styles.link}>已保存</Text></Pressable>
      <Pressable onPress={() => setHistory(true)} style={[styles.chip, history && styles.chipActive]}><Text style={styles.link}>已归档</Text></Pressable>
    </View> : null}
    <TextInput accessibilityLabel="搜索当前列表" placeholder="搜索标题或正文" value={search} onChangeText={setSearch} style={styles.input} />
    <Text style={styles.meta}>{pending ? '已持久化的待确认稿' : titles[section]} · {page.total} 条</Text>
    {listError ? <Pressable onPress={() => void readPage()}><Text accessibilityRole="alert" style={styles.warning}>{listError} 点击重试。</Text></Pressable> : null}
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.list}>
      {page.items.map(item => <Pressable key={item.id} onPress={() => open(item.id)} style={styles.card}>
        <Text style={styles.label}>{item.title}</Text><Text numberOfLines={2} style={styles.body}>{item.preview}</Text>
        <Text style={styles.meta}>{statusLabel(item.status, item.waiting)} · {item.source ?? ''}</Text>
        <Text style={styles.meta}>{item.kind === 'current_state' ? '得知时间' : '记录时间'}：{time(item.kind === 'current_state' ? item.knownAt : item.createdAt)}</Text>
        <Text style={styles.link}>查看完整正文与依据 ›</Text>
      </Pressable>)}
      {!page.items.length && !loading && !listError ? <Text style={styles.meta}>当前筛选没有记录。</Text> : null}
      {loading ? <Text style={styles.meta}>读取中…</Text> : null}
      {page.hasMore ? <Pressable disabled={loading} onPress={() => void readPage(true)} style={styles.chip}><Text style={styles.link}>加载更多</Text></Pressable> : null}
    </ScrollView>
    <Modal transparent animationType="fade" visible={selected !== null} onRequestClose={() => void run('leave')}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={[styles.overlay, { paddingTop: Math.max(insets.top, 20), paddingBottom: Math.max(insets.bottom, 20) }]}>
        <View style={styles.panel}>
          <Text style={styles.title}>{reviewable ? '待确认稿' : '正文与依据'}</Text>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.details}>
            {notice ? <Text accessibilityRole="alert" style={styles.warning}>{notice}</Text> : null}
            {epochInvalid ? <>
              <Text style={styles.warning}>数据已恢复，原输入保留。请重新读取当前草稿与依据，再对照后暂存。</Text>
              <Pressable disabled={busy} onPress={() => void readRestoredDraft()} style={styles.chip}><Text style={styles.link}>重新读取草稿与依据</Text></Pressable>
            </> : null}
            {!detail ? <><Text style={styles.meta}>正在读取正文与依据…</Text><Pressable disabled={busy} onPress={() => selected && void refreshItem(selected)}><Text style={styles.link}>重新读取</Text></Pressable></> : <>
              <Text selectable style={styles.meta}>{candidateHandled ? '这份草稿已在别处处理' : statusLabel(detail.status, detail.waiting)} · 编号 {detail.id}</Text>
              {detail.currentState ? <Text style={styles.meta}>得知时间：{time(detail.currentState.knownAt)}{`\n`}保存时间：{time(detail.currentState.createdAt)}{detail.currentState.status !== 'active' ? `\n收起记录时间：${time(detail.currentState.resolvedAt)}` : ''}</Text> : null}
              {detail.memory ? <Text style={styles.meta}>保存时间：{time(detail.memory.createdAt)} · 记录更新时间：{time(detail.memory.updatedAt)}</Text> : null}
              {oldDraft ? <DraftText title="准备更新时的原卡" draft={oldDraft} /> : null}
              {newComparison ? <>
                <DraftText title="最新原卡，请与编辑稿对照" draft={newComparison.draft ?? newComparison} />
                {detail.status === 'target_changed' ? <Pressable disabled={busy || !!conflict} onPress={() => void run('compare')} style={styles.chip}><Text style={styles.link}>已对照，以这版原卡继续</Text></Pressable> : null}
              </> : null}
              {conflict ? <>
                <Text style={styles.meta}>当前持久稿状态：{statusLabel(conflict.status, conflict.waiting)}</Text>
                <DraftText title="另一入口的最新草稿，请与当前输入对照" draft={conflict.candidate ?? conflict.legacyCurrentState ?? conflict.memory ?? conflict.currentState ?? {}} />
                {conflict.sources.map((source, index) => <View key={index} style={styles.source}><Text style={styles.meta}>当前持久稿依据 · {source.label}</Text><Text selectable style={styles.body}>{source.content}</Text></View>)}
                <Pressable disabled={busy || !conflict.editableHash || (!conflict.candidate && !conflict.legacyCurrentState)} onPress={() => void run('review_edit')} style={styles.chip}><Text style={styles.link}>已对照，暂存当前编辑稿</Text></Pressable>
              </> : null}
              {editable ? <>
                {field('标题', 'title')}{field('完整正文', 'content', true)}
                {candidate && !candidate.currentStateReview ? <>
                  <Text style={styles.label}>标签</Text><TextInput accessibilityLabel="标签" value={tagsText} editable={!busy} onChangeText={value => changeTags('tags', value)} style={styles.input} />
                  <Text style={styles.label}>回想线索</Text><TextInput accessibilityLabel="回想线索" value={cuesText} editable={!busy} onChangeText={value => changeTags('recallCues', value)} style={styles.input} />
                  {field('记住的理由', 'rememberedReason', true)}
                </> : null}
                {generalFields ? <>
                  <Text style={styles.label}>领域</Text><View style={styles.row}>{MEMORY_DOMAINS.map(domain => <Pressable key={domain} disabled={busy} onPress={() => change({ domain })} style={[styles.chip, draft.domain === domain && styles.chipActive]}><Text style={styles.meta}>{domain}</Text></Pressable>)}</View>
                  <Text style={styles.label}>重要度</Text><View style={styles.row}>{Array.from({ length: 10 }, (_, i) => i + 1).map(importance => <Pressable key={importance} disabled={busy} onPress={() => change({ importance })} style={[styles.chip, draft.importance === importance && styles.chipActive]}><Text style={styles.meta}>{importance}</Text></Pressable>)}</View>
                  <View style={styles.row}><Pressable disabled={busy} onPress={() => change({ pinned: !draft.pinned })} style={styles.chip}><Text style={styles.link}>{draft.pinned ? '✓ 钉住' : '钉住'}</Text></Pressable>
                    <Pressable disabled={busy} onPress={() => change({ anchor: !draft.anchor })} style={styles.chip}><Text style={styles.link}>{draft.anchor ? '✓ 长期锚点' : '长期锚点'}</Text></Pressable></View>
                  {draft.anchor ? <View style={styles.row}>{MEMORY_ANCHOR_KINDS.map(anchorKind => <Pressable key={anchorKind} disabled={busy} onPress={() => change({ anchorKind })} style={[styles.chip, draft.anchorKind === anchorKind && styles.chipActive]}><Text style={styles.meta}>{getAnchorKindLabel(anchorKind)}</Text></Pressable>)}</View> : null}
                  {!candidate?.understandingSubject && candidate?.source !== 'weekly-context' && candidate?.origin !== 'weekly' ? field('事件时间（可留空）', 'manualEventTimeText') : null}
                </> : detail.currentState ? <DraftText title={detail.currentState.title} draft={detail.currentState} /> : detail.memory ? <DraftText title="已保存卡" draft={detail.memory} /> : null}
                {summaryEnabled ? <>{field('经过小记', 'episodeSummary', true)}<Text style={styles.meta}>{!dirty.current && candidate && isEpisodeSummaryReviewCurrent(candidate) ? '这版小记已核对' : '未核对小记；可以只保存正文'}</Text><Pressable disabled={busy || !!conflict} onPress={() => void run('summary_check')} style={styles.chip}><Text style={styles.link}>核对这版小记</Text></Pressable></> : null}
                {detail.status === 'basis_changed' ? <Pressable disabled={busy || !!conflict} onPress={() => void run('recheck')} style={styles.chip}><Text style={styles.link}>重新核对</Text></Pressable> : null}
              </> : detail.legacyCurrentState ? <>
                <DraftText title="旧近况稿 · 重新核对后才能保存" draft={detail.legacyCurrentState} />
                <Pressable disabled={busy} onPress={() => void run('recheck')} style={styles.chip}><Text style={styles.link}>重新核对</Text></Pressable>
              </> : detail.currentState ? <DraftText title={detail.currentState.title} draft={detail.currentState} /> : detail.memory ? <DraftText title="已保存卡" draft={detail.memory} /> : null}
              {detail.readingSource ? <View style={styles.source}><Text style={styles.label}>{detail.candidate?.shiyingBindings?.length ? '本次重新核对的纸条原文' : '本次重新核对的阅读原文'}</Text><Text selectable style={styles.body}>{detail.readingSource.content}</Text><Text selectable style={styles.meta}>版本 {detail.readingSource.version}</Text></View> : null}
              <Text style={styles.label}>依据与出处</Text>
              {detail.sources.length ? detail.sources.map((source, index) => <View key={index} style={styles.source}><Text style={styles.meta}>{source.label}</Text><Text selectable style={styles.body}>{source.content}</Text></View>) : <Text style={styles.meta}>未记录可核对的出处。</Text>}
            </>}
          </ScrollView>
          <View style={styles.footer}>
            <Pressable disabled={busy} onPress={() => void run('leave')} style={styles.chip}><Text style={styles.link}>关闭</Text></Pressable>
            {reviewable ? <>
              <Pressable disabled={busy || epochInvalid || candidateHandled} onPress={() => void run('discard')} style={styles.chip}><Text style={styles.link}>舍弃稿</Text></Pressable>
              {editable ? <>
              <Pressable disabled={busy || epochInvalid || candidateHandled || !!conflict} onPress={() => void run('edit')} style={styles.chip}><Text style={styles.link}>暂存</Text></Pressable>
              <Pressable disabled={saveDisabled} onPress={() => void run('save')} style={[styles.button, saveDisabled && styles.disabled]}><Text style={styles.buttonText}>{busy ? '处理中…' : '确认保存'}</Text></Pressable>
              </> : null}
            </> : detail?.currentState?.status === 'active' ? <Pressable disabled={busy} onPress={() => void run('close')} style={styles.button}><Text style={styles.buttonText}>收起这条近况</Text></Pressable> : null}
            {epochInvalid || recoveryUsed.current || candidateHandled ? <Pressable disabled={busy} onPress={abandonLocalInput} style={styles.chip}><Text style={styles.link}>舍弃本地未存输入并关闭</Text></Pressable> : null}
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  </View>;
}

const styles = StyleSheet.create({
  page: { flex: 1, paddingHorizontal: 18, paddingTop: 12, gap: 10 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  back: { minHeight: 44, justifyContent: 'center' }, title: { color: colors.ink, fontSize: 20, fontWeight: '700' },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 }, chip: { borderRadius: 12, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#DDECF8', paddingHorizontal: 12, paddingVertical: 10, minHeight: 40, justifyContent: 'center' },
  chipActive: { backgroundColor: '#E8F4FF', borderColor: '#B2D9FF' },
  link: { color: '#547FA0', fontSize: 13, fontWeight: '600' }, label: { color: colors.ink, fontSize: 14, fontWeight: '600' },
  body: { color: colors.ink, fontSize: 14, lineHeight: 22 }, meta: { color: '#6B8BAA', fontSize: 11, lineHeight: 18 },
  warning: { color: '#B16458', backgroundColor: '#FFF1EA', borderRadius: 10, padding: 10, fontSize: 12, lineHeight: 19 },
  input: { borderWidth: 1, borderColor: '#DDECF8', borderRadius: 12, backgroundColor: '#FFFFFF', color: colors.ink, padding: 12, fontSize: 14, minHeight: 44 },
  multiline: { minHeight: 90 }, field: { gap: 8 }, list: { gap: 12, paddingBottom: 28 },
  card: { gap: 7, padding: 14, borderWidth: 1, borderColor: '#DDECF8', borderRadius: 16, backgroundColor: '#FFFFFF' },
  overlay: { flex: 1, paddingHorizontal: 14, backgroundColor: 'rgba(47,56,82,0.28)', justifyContent: 'center' },
  panel: { width: '100%', alignSelf: 'center', maxWidth: 560, maxHeight: '100%', height: '92%', borderRadius: 22, backgroundColor: '#F7FBFF', borderWidth: 1, borderColor: '#D8EAF8', padding: 15, gap: 12 },
  details: { gap: 12, paddingBottom: 20 }, source: { gap: 8, padding: 12, borderRadius: 12, backgroundColor: '#EAF5FC' },
  footer: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8 },
  button: { borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, minHeight: 44, justifyContent: 'center', backgroundColor: '#FFA18A' },
  buttonText: { color: '#FFFFFF', fontSize: 13, fontWeight: '700' }, disabled: { opacity: 0.45 },
});
