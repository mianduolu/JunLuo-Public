import { useEffect, useState, useSyncExternalStore } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import { AppText as Text, AppTextInput as TextInput } from '../components/AppText';
import { colors } from '../theme/colors';
import { theaterBindingKey, type TheaterGenerationSession } from './theaterGenerationSession';
import type { TheaterBinding } from './theaterGenerationStore';
import { summaryText, type TheaterSummarySession } from './theaterSummarySession';
import { theaterCheckpointCoverage } from './theaterSummaryStore';
import { anchorText, type TheaterAnchorSession } from './theaterAnchorSession';
import { TheaterAnchorEntry } from './TheaterAnchorPanel';
const noAnchorSubscription = () => () => {};
const noAnchorVisible = () => false;

function Button({ label, action, disabled = false, danger = false }: {
  label: string; action: () => void; disabled?: boolean; danger?: boolean;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }}
    disabled={disabled} onPress={action} style={[styles.button, danger && styles.deleteButton, disabled && styles.disabled]}>
    <Text style={[styles.label, danger && styles.danger]}>{label}</Text>
  </Pressable>;
}

// Feature-owned state survives fullscreen/child view changes; this component owns only copy feedback.
export function TheaterSummaryPanel({ session, generation, binding, onOpenStory, anchors }: {
  session: TheaterSummarySession; generation: TheaterGenerationSession; binding: TheaterBinding;
  onOpenStory: (binding: TheaterBinding) => void;
  anchors?: TheaterAnchorSession;
}) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const gen = useSyncExternalStore(generation.subscribe, generation.getSnapshot);
  const anchorVisible = useSyncExternalStore(anchors?.subscribe ?? noAnchorSubscription,
    anchors ? () => anchors.getSnapshot().visible : noAnchorVisible);
  const [copy, setCopy] = useState<{ content: string; status: string } | null>(null);
  const insets = useSafeAreaInsets(), id = theaterBindingKey(binding);
  useEffect(() => { void session.refresh(binding); }, [session, id, gen.snapshots[id], gen.readRevision]);
  const status = session.status(binding), entryDraft = state.drafts[id];
  const currentBinding = state.binding ?? binding, currentId = theaterBindingKey(currentBinding);
  const snapshot = state.snapshots[currentId], draft = state.drafts[currentId];
  const currentStatus = session.status(currentBinding), notice = state.notices[currentId];
  const activeHere = gen.active?.kind === 'summary' && theaterBindingKey(gen.active.binding) === currentId;
  const confirmation = state.confirmation;
  const preview = snapshot?.checkpoints.find(node => node.id === state.previewId);
  const current = currentStatus?.checkpoint;
  const title = confirmation ? confirmation.kind === 'regenerate' ? '重新整理小抄？' : confirmation.kind === 'discard' ? '放弃这份小抄草稿？'
    : confirmation.active ? '删除当前小抄？' : '删除这份历史小抄？'
    : state.page === 'editor' ? '小抄草稿' : state.page === 'positions' ? '整理到哪一句？'
      : state.page === 'source' ? '对应台词' : state.page === 'history' ? '小抄历史'
        : state.page === 'preview' ? '小抄预览' : '剧情小抄';
  const action = (label: string, callback: () => void, disabled = state.busy, danger = false) => (
    <Button label={label} action={callback} disabled={disabled} danger={danger} />
  );
  const copied = (content: string) => {
    void Clipboard.setStringAsync(content).then(() => setCopy({ content, status: '已复制' }),
      () => setCopy({ content, status: '没能复制，请重试。' }));
  };
  const coverageLabel = (positionId: string | null, fallback = 0) => {
    const end = snapshot?.adoptions.findIndex(v => v.positionId === positionId) ?? -1;
    return `整理到第 ${end < 0 ? fallback : snapshot!.versions.slice(0, end + 1).filter(v => v.kind === 'dialogue').length} 条台词`;
  };
  const summaryActions = <View style={styles.row}>
    {action('整理小抄', () => { void session.requestGenerate(currentBinding); })}
    {current ? action('编辑小抄', () => { void session.edit(current.id); })
      : action('手动写小抄', () => { void session.edit(); })}
    {action('小抄历史', () => session.show('history'))}
  </View>;
  return <>
    <View style={styles.entry}>
      <Button label="剧情小抄" action={() => { void session.open(binding); }} />
      {status?.invalid ? <Text style={styles.muted}>需要重新整理</Text>
        : status?.reminder ? <Text style={styles.muted}>{`有 ${status.uncovered} 条台词还没整理。`}</Text> : null}
      {entryDraft?.generated ? <>
        <Text style={styles.muted}>小抄草稿已整理好，尚未保存。</Text>
        <Button label="查看草稿" action={() => { void session.open(binding).then(() => session.viewDraft()); }} />
      </> : null}
    </View>
    <Modal visible={state.visible && !anchorVisible} transparent animationType="none" onRequestClose={() => session.close()}>
      <KeyboardAvoidingView enabled behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={[styles.scrim,
        { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 12, paddingLeft: insets.left + 16, paddingRight: insets.right + 16 }]}>
        <View accessibilityViewIsModal style={[styles.panel, state.page === 'editor' && !confirmation && styles.editorPanel]}>
          <Text accessibilityRole="header" style={styles.heading}>{title}</Text>
          {!!snapshot && <Text style={styles.muted}>{snapshot.branch.name}</Text>}
          <ScrollView style={styles.scroll} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
            {confirmation ? <Text style={styles.body}>{confirmation.kind === 'regenerate'
              ? confirmation.hasDraft ? `未保存的小抄草稿和这 ${confirmation.count} 条候选锚点会丢弃，已保存的小抄和锚点不会改变。`
                : `这 ${confirmation.count} 条未确认的候选锚点会丢弃，已保存的小抄和锚点不会改变。`
              : confirmation.kind === 'discard'
              ? '还没保存的内容会丢弃，已保存的小抄不会改变。'
              : confirmation.active ? '删除后，这条走向暂时不使用小抄。剧情台词和其他小抄历史会保留。'
                : '只删除这份历史小抄，当前使用的小抄和剧情台词不会改变。'}</Text> : <>
              {!!notice && <View><Text accessibilityRole="alert" style={styles.muted}>{notice}</Text>
                {(notice === summaryText.read || notice === anchorText.read || notice === summaryText.deleteUnknown) && action(
                  notice === summaryText.read || notice === anchorText.read ? '重试' : '重新查看', () => { void session.refresh(currentBinding); })}
                {(notice === summaryText.failed || notice === summaryText.plotChanged || notice === summaryText.sourceChanged)
                  && action('重新整理', () => { void session.requestGenerate(currentBinding); })}
              </View>}
              {activeHere ? <View style={styles.row}><Text style={styles.muted}>正在整理小抄…</Text>
                {action('停止整理', () => session.stop(), false)}</View> : null}
              {gen.active && !activeHere && action('查看正在生成的剧场', () => onOpenStory(gen.active!.binding), false)}
              {state.page === 'current' && snapshot ? <>
                {current ? <>
                  <Text style={styles.label}>{currentStatus?.invalid ? '需要重新整理' : '当前使用'}</Text>
                  {currentStatus?.invalid && <Text style={styles.muted}>这份小抄记过的台词改了，暂时不用于续写。</Text>}
                  <Text selectable style={styles.body}>{current.content}</Text>
                  <Text style={styles.muted}>{coverageLabel(current.coveredPositionId, current.basis.length)}</Text>
                </> : <Text style={styles.muted}>这条走向还没有小抄。</Text>}
                {!!draft && action('查看草稿', () => session.viewDraft())}
                {summaryActions}
                {anchors && <TheaterAnchorEntry session={anchors} binding={currentBinding} />}
              </> : null}
              {state.page === 'history' && snapshot ? <>
                {!snapshot.checkpoints.length && <Text style={styles.muted}>还没有保存过的小抄。</Text>}
                {[...snapshot.checkpoints].sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id)).map(node => (
                  <Pressable key={node.id} accessibilityRole="button" onPress={() => session.preview(node.id)} style={styles.history}>
                    <Text style={styles.muted}>{new Date(node.createdAt).toLocaleString()}</Text>
                    <Text style={styles.muted}>{`整理到第 ${node.basis.length} 条台词`}</Text>
                    {node.id === snapshot.branch.staleCheckpointId || theaterCheckpointCoverage(snapshot, node) === null ? <Text style={styles.muted}>需要重新整理</Text>
                      : node.id === snapshot.branch.activeCheckpointId ? <Text style={styles.label}>当前使用</Text> : null}
                    <Text numberOfLines={2} style={styles.body}>{node.content}</Text>
                  </Pressable>
                ))}
              </> : null}
              {state.page === 'preview' && preview ? <>
                <Text selectable style={styles.body}>{preview.content}</Text>
                <Text style={styles.muted}>{`整理到第 ${preview.basis.length} 条台词`}</Text>
                {snapshot && (preview.id === snapshot.branch.staleCheckpointId || theaterCheckpointCoverage(snapshot, preview) === null)
                  && <Text style={styles.muted}>需要重新整理</Text>}
                {action('用作底稿', () => { void session.edit(preview.id); })}
              </> : null}
              {state.page === 'editor' && draft ? <>
                <Text style={styles.muted}>尚未保存</Text>
                {draft.review && !draft.unavailable && <View><Text style={styles.muted}>这份小抄对应的台词已经变了，请按现在的剧情检查内容。</Text>
                  {action(draft.error === summaryText.changed ? '重新查看' : '查看台词', () => { void session.review(); })}</View>}
                {draft.missingSource && !draft.unavailable && <Text style={styles.muted}>原小抄已删除，这份草稿尚未保存。</Text>}
                <TextInput accessibilityLabel="小抄草稿" value={draft.content} multiline textAlignVertical="top"
                  editable={!state.busy && !draft.unavailable} onChangeText={value => session.change(value)} style={styles.input} />
                {(draft.error || !draft.content.trim() || (snapshot && !snapshot.versions.some(v => v.kind === 'dialogue'))) &&
                  <Text accessibilityRole="alert" style={styles.muted}>{draft.error ||
                    (snapshot && !snapshot.versions.some(v => v.kind === 'dialogue') ? summaryText.empty : summaryText.blank)}</Text>}
                {!draft.unavailable && <View style={styles.row}>
                  {!!draft.coveredPositionId && <Text style={styles.muted}>{coverageLabel(draft.coveredPositionId, draft.basis.length)}</Text>}
                  {action('更改', () => { void session.choosePosition(); })}
                </View>}
                {action('复制正文', () => copied(draft.content), !draft.content)}
                {copy?.content === draft.content && <Text style={styles.muted}>{copy.status}</Text>}
              </> : null}
              {(state.page === 'positions' || state.page === 'source') && snapshot ? snapshot.versions.map((version, index) => {
                if (version.kind !== 'dialogue') return null;
                const number = snapshot.versions.slice(0, index + 1).filter(v => v.kind === 'dialogue').length;
                const content = <><Text style={styles.label}>{`第 ${number} 条 · ${snapshot.story.settings.names[version.subject]}`}</Text>
                  <Text selectable style={styles.body}>{version.content}</Text></>;
                return state.page === 'source' ? <View key={version.positionId} style={styles.history}>{content}</View>
                  : <Pressable key={version.positionId} accessibilityRole="radio" accessibilityState={{ checked: state.choice === version.positionId }}
                    onPress={() => session.selectPosition(version.positionId)} style={[styles.history, state.choice === version.positionId && styles.selected]}>{content}</Pressable>;
              }) : null}
            </>}
          </ScrollView>
          <View style={styles.row}>
            {confirmation ? <>
              {action(confirmation.kind === 'regenerate' ? '继续查看' : confirmation.kind === 'discard' ? '继续编辑' : '取消', () => session.cancelConfirmation())}
              {action(confirmation.kind === 'regenerate' ? '重新整理' : confirmation.kind === 'discard' ? '放弃草稿' : '删除', () => { void session.confirm(); }, state.busy, true)}
            </> : state.page === 'editor' && draft ? <>
              {action(draft.unavailable ? '关闭' : '取消', () => session.close())}
              {!draft.unavailable && action(draft.error === summaryText.saving ? '重试保存' : draft.review ? '按当前剧情保存'
                : draft.missingSource ? '保存为新小抄' : '保存小抄', () => { void session.save(); },
                state.busy || !draft.content.trim() || (draft.review && !draft.reviewed))}
            </> : state.page === 'positions' ? <>
              {action('取消', () => session.close())}
              {action('确定', () => session.confirmPosition(), state.busy || !state.choice)}
            </> : action('关闭', () => session.close())}
          </View>
          {!confirmation && ((state.page === 'preview' && preview) || (state.page === 'current' && current)) ? <View style={styles.deleteRow}>
            {action('删除小抄', () => { void session.requestDelete((state.page === 'preview' ? preview : current)!.id); }, state.busy, true)}
          </View> : null}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  </>;
}

const styles = StyleSheet.create({
  entry: { paddingHorizontal: 16, gap: 4 }, row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  scrim: { flex: 1, justifyContent: 'center', backgroundColor: 'rgba(30,40,55,0.3)' },
  panel: { maxHeight: '100%', backgroundColor: colors.cream, borderRadius: 20, padding: 18, gap: 12 },
  editorPanel: { flex: 1 }, scroll: { flexShrink: 1 }, content: { gap: 12 },
  heading: { color: colors.ink, fontSize: 20, fontWeight: '700' }, label: { color: colors.ink, fontSize: 15 },
  body: { color: colors.ink, fontSize: 15, lineHeight: 23 }, muted: { color: colors.muted, fontSize: 13, lineHeight: 21 },
  button: { minHeight: 44, paddingHorizontal: 12, justifyContent: 'center' }, disabled: { opacity: 0.45 },
  deleteRow: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.muted, paddingTop: 8 },
  deleteButton: { alignItems: 'center' }, danger: { color: '#b04c56' },
  history: { padding: 12, gap: 8, backgroundColor: colors.card, borderRadius: 12 },
  selected: { borderWidth: 1, borderColor: colors.ink },
  input: { minHeight: 220, padding: 12, borderRadius: 12, backgroundColor: colors.card, color: colors.ink, fontSize: 15, lineHeight: 23 },
});
