import { useRef, useState, useSyncExternalStore } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import { AppText as Text, AppTextInput as TextInput } from '../components/AppText';
import { colors } from '../theme/colors';
import type { TheaterBinding } from './theaterGenerationStore';
import { theaterBindingKey as key } from './theaterGenerationSession';
import { anchorText, type TheaterAnchorSession } from './theaterAnchorSession';
import { effectiveTheaterAnchors } from './theaterAnchorMaterials';

function Button({ label, action, disabled = false, danger = false }: {
  label: string; action: () => void; disabled?: boolean; danger?: boolean;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }}
    disabled={disabled} onPress={action} style={[styles.button, danger && styles.deleteButton, disabled && styles.disabled]}>
    <Text style={[styles.label, danger && styles.danger]}>{label}</Text>
  </Pressable>;
}

export function TheaterAnchorEntry({ session, binding, pendingOnly = false }: { session: TheaterAnchorSession; binding: TheaterBinding; pendingOnly?: boolean }) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const count = state.candidates[key(binding)]?.length ?? 0;
  return <View style={styles.content}>
    {!pendingOnly && <Button label="剧情锚点" action={() => { void session.open(binding); }} />}
    {count > 0 && <><Text style={styles.muted}>{`有 ${count} 条候选锚点待确认。`}</Text>
      <Button label="查看候选" action={() => { void session.open(binding); }} /></>}
  </View>;
}

export function TheaterAnchorPanel({ session }: { session: TheaterAnchorSession }) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [copy, setCopy] = useState<{ content: string; text: string } | null>(null);
  const list = useRef<ScrollView>(null);
  const insets = useSafeAreaInsets(), binding = state.binding, id = binding ? key(binding) : '';
  const snapshot = state.snapshots[id], draft = state.drafts[id], candidates = state.candidates[id] ?? [];
  const notice = state.notices[id], confirm = state.confirmation;
  const effective = snapshot ? effectiveTheaterAnchors({ ...snapshot, checkpoint: null }) : [];
  const latest = draft?.expected && snapshot?.anchors.find(v => v.id === draft.expected!.id);
  const action = (label: string, fn: () => void, disabled = state.busy, danger = false) =>
    <Button label={label} action={fn} disabled={disabled} danger={danger} />;
  const copied = (content: string) => {
    void Clipboard.setStringAsync(content).then(() => setCopy({ content, text: '已复制' }),
      () => setCopy({ content, text: '没能复制，请重试。' }));
  };
  const position = (positionId: string | null) => {
    const index = snapshot?.versions.findIndex(v => v.positionId === positionId) ?? -1;
    return index < 0 ? '发生位置待选择' : `发生在：第 ${snapshot!.versions.slice(0, index + 1).filter(v => v.kind === 'dialogue').length} 句`;
  };
  const title = confirm ? confirm.kind === 'unpin' ? '取消固定这条锚点？' : '放弃这次编辑？'
    : state.page === 'positions' ? '这件事发生在哪一句？' : state.page === 'source' ? '查看台词'
      : state.page === 'editor' ? draft?.expected ? '编辑剧情锚点' : '新增剧情锚点' : '剧情锚点';
  return <Modal visible={state.visible} transparent animationType="none" onRequestClose={() => session.close()}>
    <KeyboardAvoidingView enabled behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={[styles.scrim,
      { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 12, paddingLeft: insets.left + 16, paddingRight: insets.right + 16 }]}>
      <View accessibilityViewIsModal style={[styles.panel, state.page === 'editor' && !confirm && styles.editor]}>
        <Text accessibilityRole="header" style={styles.heading}>{title}</Text>
        {!!snapshot && <Text style={styles.muted}>{snapshot.branch.name}</Text>}
        <ScrollView ref={list} style={styles.scroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {confirm ? <Text style={styles.body}>{confirm.kind === 'unpin'
            ? '取消后，续写不再单独携带这条锚点，原台词和小抄不会删除。'
            : '还没保存的内容会丢弃，已保存的锚点不会改变。'}</Text> : <>
            {!!notice && <><Text accessibilityRole="alert" style={styles.muted}>{notice}</Text>
              {(notice === anchorText.read || notice === anchorText.unpinUnknown || notice === anchorText.conflict) && binding
                && action(notice === anchorText.read ? '重试' : '重新查看', () => { void session.refresh(binding); })}</>}
            {state.page === 'list' && binding && <>
              {snapshot && <>
                {!snapshot.anchors.length && <Text style={styles.muted}>还没有剧情锚点。</Text>}
                {snapshot.anchors.map(anchor => <View key={anchor.id} style={styles.card}
                  onLayout={event => { if (state.choice === anchor.id) list.current?.scrollTo({ y: event.nativeEvent.layout.y, animated: false }); }}>
                  <Text selectable style={styles.body}>{anchor.content}</Text><Text style={styles.muted}>{position(anchor.positionId)}</Text>
                  {!effective.some(v => v.id === anchor.id) && <><Text style={styles.label}>需要核对</Text>
                    <Text style={styles.muted}>{anchorText.stale}</Text></>}
                  {action('编辑', () => { void session.edit(binding, { anchorId: anchor.id }); })}
                </View>)}
                {action('新增锚点', () => { void session.edit(binding); })}
              </>}
              {!!candidates.length && <><Text style={styles.heading}>候选剧情锚点</Text><Text style={styles.muted}>确认后才会固定。</Text></>}
              {candidates.map(candidate => <View key={candidate.id} style={styles.card}>
                <Text selectable style={styles.body}>{candidate.content}</Text><Text style={styles.muted}>{position(candidate.positionId)}</Text>
                {candidate.review && <Text style={styles.label}>需要核对</Text>}
                {!!candidate.error && <Text style={styles.muted}>{candidate.error}</Text>}
                <View style={styles.row}>
                  {!candidate.unavailable && <>
                    {action('查看台词', () => { void session.edit(binding, { candidateId: candidate.id }).then(() => session.viewSource()); })}
                    {action(candidate.positionId ? '固定' : '选择台词', () => {
                      if (candidate.positionId) void session.fix(binding, candidate.id);
                      else void session.edit(binding, { candidateId: candidate.id }).then(() => session.choosePosition());
                    }, state.busy || candidate.review)}
                    {action('编辑', () => { void session.edit(binding, { candidateId: candidate.id }); })}
                  </>}
                  {action('复制正文', () => copied(candidate.content), false)}
                  {action('忽略', () => session.ignore(binding, candidate.id))}
                </View>
                {copy?.content === candidate.content && <Text style={styles.muted}>{copy.text}</Text>}
              </View>)}
            </>}
            {state.page === 'editor' && draft && <>
              <Text style={styles.label}>内容</Text>
              <TextInput accessibilityLabel="内容" value={draft.content} multiline textAlignVertical="top" style={styles.input}
                editable={!state.busy && !draft.unavailable} onChangeText={value => session.change(value)} />
              {draft.review && <Text style={styles.label}>需要核对</Text>}
              {!!draft.error && <Text accessibilityRole="alert" style={styles.muted}>{draft.error}</Text>}
              {draft.conflict && <>
                {latest && <Text selectable style={styles.body}>{latest.content}</Text>}
                {action('重新查看', () => { void session.reviewConflict(); })}
              </>}
              {!draft.conflict && draft.reviewedAnchor && <Text selectable style={styles.body}>{draft.reviewedAnchor.content}</Text>}
              {!draft.unavailable && <View style={styles.row}>
                <Text style={styles.muted}>{draft.positionId ? position(draft.positionId) : '发生在：'}</Text>
                {action(draft.positionId && snapshot?.adoptions.some(v => v.positionId === draft.positionId) ? '更改' : '选择台词', () => { void session.choosePosition(); })}
                {draft.positionId && action('查看台词', () => { void session.viewSource(); })}
              </View>}
              {action('复制正文', () => copied(draft.content), !draft.content)}
              {copy?.content === draft.content && <Text style={styles.muted}>{copy.text}</Text>}
            </>}
            {(state.page === 'positions' || state.page === 'source') && snapshot && snapshot.versions.map((v, index) => {
              if (v.kind !== 'dialogue' || (state.page === 'source' && draft?.positionId && v.positionId !== draft.positionId)) return null;
              const content = <><Text style={styles.label}>{`第 ${snapshot.versions.slice(0, index + 1).filter(v => v.kind === 'dialogue').length} 句 · ${snapshot.story.settings.names[v.subject]}`}</Text>
                <Text selectable style={styles.body}>{v.content}</Text></>;
              return state.page === 'source' ? <View key={v.id} style={styles.card}>{content}</View>
                : <Pressable key={v.id} accessibilityRole="radio" accessibilityState={{ checked: state.choice === v.positionId }}
                  onPress={() => session.selectPosition(v.positionId)} style={[styles.card, state.choice === v.positionId && styles.selected]}>{content}</Pressable>;
            })}
          </>}
        </ScrollView>
        <View style={styles.row}>
          {confirm ? <>
            {action(confirm.kind === 'discard' ? '继续编辑' : '取消', () => session.cancelConfirmation())}
            {action(confirm.kind === 'discard' ? '放弃编辑' : '取消固定', () => { void session.confirm(); }, state.busy, true)}
          </> : state.page === 'editor' && draft ? <>
            {action(draft.unavailable ? '关闭' : '取消', () => session.close())}
            {!draft.unavailable && action(draft.error === anchorText.saving ? '重试保存' : draft.missing ? '保存为新锚点'
              : draft.review ? '按当前剧情保存' : '保存', () => { void session.save(draft.review); },
              state.busy || draft.conflict || !draft.content.trim() || !snapshot?.adoptions.some(v => v.positionId === draft.positionId))}
          </> : state.page === 'positions' ? <>
            {action('取消', () => session.close())}{action('确定', () => session.confirmPosition(), state.busy || !state.choice)}
          </> : action('关闭', () => session.close())}
        </View>
        {!confirm && state.page === 'editor' && draft?.expected && !draft.unavailable && <View style={styles.deleteRow}>
          {action('取消固定', () => session.requestUnpin(draft.expected!), state.busy, true)}
        </View>}
      </View>
    </KeyboardAvoidingView>
  </Modal>;
}

const styles = StyleSheet.create({
  content: { gap: 12 }, row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  scrim: { flex: 1, justifyContent: 'center', backgroundColor: 'rgba(30,40,55,0.3)' },
  panel: { maxHeight: '100%', backgroundColor: colors.cream, borderRadius: 20, padding: 18, gap: 12 }, editor: { flex: 1 },
  scroll: { flexShrink: 1 }, heading: { color: colors.ink, fontSize: 20, fontWeight: '700' },
  label: { color: colors.ink, fontSize: 15 }, body: { color: colors.ink, fontSize: 15, lineHeight: 23 },
  muted: { color: colors.muted, fontSize: 13, lineHeight: 21 }, button: { minHeight: 44, paddingHorizontal: 12, justifyContent: 'center' },
  disabled: { opacity: 0.45 }, deleteButton: { alignItems: 'center' }, danger: { color: '#b04c56' },
  deleteRow: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.muted, paddingTop: 8 },
  card: { padding: 12, gap: 8, backgroundColor: colors.card, borderRadius: 12 }, selected: { borderWidth: 1, borderColor: colors.ink },
  input: { minHeight: 180, padding: 12, borderRadius: 12, backgroundColor: colors.card, color: colors.ink, fontSize: 15, lineHeight: 23 },
});
