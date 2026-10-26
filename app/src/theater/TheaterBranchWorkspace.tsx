import { useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { AppText as Text } from '../components/AppText';
import { colors } from '../theme/colors';
import { styles as chatStyles } from '../screens/ChatScreen.styles';
import { TheaterGenerationPanel } from './TheaterGenerationPanel';
import { TheaterCoCreationSelectionPanel } from './TheaterCoCreationSelectionPanel';
import { TheaterSetupPanel } from './TheaterSetupPanel';
import type { TheaterSetupSession } from './theaterSetupSession';
import { TheaterBranchSheet, TheaterMessageSheet, TheaterBranchEditor, TheaterBranchConfirmation } from './TheaterBranchPanels';
import { theaterBindingKey, type TheaterGenerationSession } from './theaterGenerationSession';
import type { TheaterBranchSession } from './theaterBranchSession';
import type { TheaterDraftSession } from './theaterDraftSession';
import type { TheaterBinding } from './theaterGenerationStore';
import type { TheaterSummarySession } from './theaterSummarySession';
import { TheaterSummaryPanel } from './TheaterSummaryPanel';
import type { TheaterAnchorSession } from './theaterAnchorSession';
import { TheaterAnchorPanel, TheaterAnchorEntry } from './TheaterAnchorPanel';
import { theaterDateTime, type TheaterReadingSession } from './theaterReadingSession';
import type { TheaterReadingJump } from './TheaterReadingList';
import { TheaterFocusReader, type TheaterFocusText } from './TheaterFullScreen';
import { TheaterSearchPanel } from './TheaterSearchPanel';
import type { TheaterSearchSession } from './theaterSearchSession';
import type { TheaterSearchResult } from './theaterSearch';
import { TheaterHistoryPanel } from './TheaterHistoryPanel';
import type { TheaterHistorySession } from './theaterHistorySession';
import { TheaterBackstagePanel } from './TheaterBackstagePanel';
import { backstageText, type TheaterBackstageSession } from './theaterBackstageSession';

const hidden = { visible: false };
const noSubscribe = () => () => {};
const hiddenSnapshot = () => hidden;

function Action({ text, action, disabled = false }: { text: string; action: () => void; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={text} disabled={disabled}
    onPress={action} style={styles.action}><Text style={styles.small}>{text}</Text></Pressable>;
}

export function TheaterBranchOverlays({ session, generation, anchors, onRead }: { session: TheaterBranchSession; generation: TheaterGenerationSession; anchors?: TheaterAnchorSession;
  onRead?: (text: TheaterFocusText) => void }) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const generationState = useSyncExternalStore(generation.subscribe, generation.getSnapshot);
  const [copyState, setCopyState] = useState<{ id: string; text: string } | null>(null);
  const menu = state.menu, editor = state.editor, confirmation = state.confirmation;
  return <>
    {state.notice ? <View style={styles.notice}><Text style={styles.small}>{state.notice}</Text>
      {state.retryLabel && <Action text={state.retryLabel} disabled={state.busy} action={() => { void session.retry(); }} />}
    </View> : null}
    <TheaterBranchSheet visible={state.branchSheet} busy={state.busy} currentBranchId={state.binding?.branchId ?? ''}
      branches={(state.detail?.branches ?? []).map((row, index) => ({ id: row.branch.id, name: row.branch.name, ordinal: index + 1,
        forkLabel: row.branch.forkBoundary == null ? undefined : `分岔位置：第 ${row.branch.forkBoundary} 句之后`,
        continuedAtLabel: new Date(Math.max(row.branch.createdAt, ...row.adoptions.map(a =>
          state.detail?.versions.find(v => v.id === a.versionId)?.createdAt ?? 0))).toLocaleString(),
      }))} onRequestClose={() => session.closePanels()} onSwitch={id => session.switchBranch(id)}
      onRename={id => session.beginRename(id)} onDeleteCurrent={() => session.requestDeleteBranch()} />
    <TheaterMessageSheet visible={!!menu} subject={menu?.version.subject ?? 'you'} busy={state.busy}
      sentAt={menu ? theaterDateTime(menu.version.createdAt) : undefined}
      onRead={menu && onRead ? () => {
        onRead({ content: menu.version.content, speaker: state.detail!.story.settings.names[menu.version.subject ?? 'I'],
          preview: menu.expected[menu.index]?.versionId !== menu.version.id }); session.closePanels();
      } : undefined}
      notice={copyState && menu?.version.id === copyState.id ? copyState.text : undefined}
      destructiveLabel={session.destructiveLabel()} onRequestClose={() => session.closePanels()}
      onEdit={() => session.beginEdit()} onDestructive={() => session.requestDeleteMessage()}
      onAnchor={anchors && menu && menu.expected[menu.index]?.versionId === menu.version.id ? () => {
        session.closePanels(); void anchors.edit(menu.binding, { positionId: menu.version.positionId });
      } : undefined}
      onCopy={() => {
        if (!menu) return;
        void Clipboard.setStringAsync(menu.version.content).then(() => setCopyState({ id: menu.version.id, text: '已复制' }),
          () => setCopyState({ id: menu.version.id, text: '没能复制，请重试。' }));
      }} onRegenerate={menu?.version.subject === 'I' && !generationState.active ? () => {
        if (!menu) return;
        session.closePanels(); void generation.regenerate(menu.binding, menu.version.positionId);
      } : undefined} />
    <TheaterBranchEditor visible={!!editor && !confirmation} kind={editor?.kind ?? 'message'} value={editor?.value ?? ''}
      busy={state.busy} error={editor?.error}
      saveDisabled={editor?.unavailable}
      hint={editor?.fork ? '这句后面已经有剧情了。保存后会从修改后的这句开始一条新走向，原来的故事会保留。' : undefined}
      saveLabel={state.retryLabel === '重新查看' ? '重新查看' : editor?.error ? '重试保存' : editor?.kind === 'name' ? '保存名称' : editor?.fork ? '保存并新开走向' : '保存修改'}
      onChangeText={value => session.changeEdit(value)} onRequestClose={() => session.requestCloseEditor()}
      onSave={() => { if (editor?.error) void session.retry(); else void session.saveEditor(); }} />
    <TheaterBranchConfirmation visible={!!confirmation} busy={state.busy} title={confirmation?.title ?? ''}
      body={confirmation?.body ?? ''} confirmLabel={confirmation?.confirmLabel ?? '删除'}
      cancelLabel={confirmation?.confirmLabel === '放弃修改' ? '继续编辑' : '取消'}
      choices={confirmation?.choices} selectedChoiceId={confirmation?.selected}
      error={state.notice ?? undefined} onSelectChoice={id => session.chooseReplacement(id)}
      retryLabel={confirmation?.command && (state.retryLabel === '重试' || state.retryLabel === '重试保存') ? state.retryLabel : undefined}
      onReview={state.retryLabel === '重新查看' ? () => { void session.retry(); } : undefined}
      onRequestClose={() => session.closePanels()} onConfirm={() => { void session.confirm(); }} />
  </>;
}

// Candidate-only integration. Its owner supplies the existing sky/header/tabs,
// keyboard avoidance and a single runtime shared with the history view.
export function TheaterBranchWorkspace({ storyId, session, generation, drafts, summaries, anchors, reading, search, coCreation, backstage, onOpenStory, onOpenSettings }: {
  storyId: string; session: TheaterBranchSession; generation: TheaterGenerationSession; drafts: TheaterDraftSession;
  summaries?: TheaterSummarySession;
  anchors?: TheaterAnchorSession;
  reading?: TheaterReadingSession; search?: TheaterSearchSession;
  coCreation?: import('./theaterCoCreationSelectionSession').TheaterCoCreationSelectionSession;
  backstage?: TheaterBackstageSession;
  onOpenStory: (binding: TheaterBinding) => void; onOpenSettings: () => void;
}) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const generated = useSyncExternalStore(generation.subscribe, generation.getSnapshot);
  const searchState = useSyncExternalStore(search?.subscribe ?? noSubscribe, search?.getSnapshot ?? hiddenSnapshot);
  const summaryState = useSyncExternalStore(summaries?.subscribe ?? noSubscribe, summaries?.getSnapshot ?? hiddenSnapshot);
  const anchorState = useSyncExternalStore(anchors?.subscribe ?? noSubscribe, anchors?.getSnapshot ?? hiddenSnapshot);
  const [focus, setFocus] = useState<TheaterFocusText | null>(null);
  const [jump, setJump] = useState<TheaterReadingJump | undefined>(undefined);
  const key = state.binding ? theaterBindingKey(state.binding) : '';
  const snapshot = generated.snapshots[key];
  const completed = generated.completedAlternatives[key];
  useEffect(() => { void session.open(storyId); }, [session, storyId, snapshot, generated.readRevision]);
  useEffect(() => {
    if (completed && state.detail?.versions.some(v => v.id === completed.id)) {
      session.previewGenerated(completed);
    }
  }, [session, completed, state.detail]);
  const rowIndex = state.detail?.branches.findIndex(row => row.branch.id === state.binding?.branchId) ?? -1;
  const row = state.detail?.branches[rowIndex];
  const ready = state.binding && state.detail?.story.id === storyId;
  const navigate = async (result: TheaterSearchResult, action?: 'switch' | 'continue') => {
    if (session.getSnapshot().busy || result.storyId !== storyId) return;
    if (action) {
      await session.open(result.storyId);
      session.switchBranch(result.branchId);
    }
    const selected = session.getSnapshot().binding;
    if (selected?.storyId !== result.storyId || selected.branchId !== result.branchId) return;
    if (action === 'continue' && result.kind === 'alternative') {
      await session.fromVersion(result.version);
    } else if (result.kind === 'dialogue') {
      session.revealAdopted(result.positionId);
      setJump(previous => ({ ...selected, positionId: result.positionId, request: (previous?.request ?? 0) + 1 }));
    } else if (result.kind === 'anchor' && anchors) {
      await anchors.open(selected, result.anchorId);
    } else if (result.kind === 'checkpoint' && result.active && summaries) {
      await summaries.open(selected);
    }
    search?.close();
  };
  return <View style={styles.root}>
    {coCreation && <TheaterCoCreationSelectionPanel session={coCreation} storyId={storyId} refreshKey={snapshot} />}
    {row ? <Action text={`剧情走向 · ${row.branch.name} · ${rowIndex + 1}/${state.detail!.branches.length}`}
      action={() => session.showBranches()} disabled={state.busy} /> : null}
    {ready && search && <Action text="搜索剧情" action={() => search.open(state.binding!)} disabled={state.busy} />}
    {ready && backstage && <Action text={backstageText.entry} disabled={state.busy}
      action={() => { void backstage.open(state.binding!); }} />}
    {backstage && <TheaterBackstagePanel session={backstage} />}
    {ready && summaries ? <TheaterSummaryPanel session={summaries} generation={generation} binding={state.binding!} onOpenStory={onOpenStory} anchors={anchors} /> : null}
    {ready && anchors ? <TheaterAnchorEntry session={anchors} binding={state.binding!} pendingOnly /> : null}
    {ready ? <TheaterGenerationPanel session={generation} binding={state.binding!} drafts={drafts}
      displayedVersionId={message => session.displayed(message).id}
      reading={reading} jump={jump} readingActive={!focus && !searchState.visible && !summaryState.visible && !anchorState.visible
        && !state.menu && !state.editor && !state.confirmation && !state.branchSheet}
      onJumpHandled={request => setJump(previous => previous?.request === request ? { ...previous, consumed: true } : previous)}
      onOpenSettings={onOpenSettings} onOpenStory={onOpenStory}
      renderMessage={(adopted, index) => {
        const displayed = session.displayed(adopted), versions = session.versions(adopted.positionId);
        const versionIndex = versions.findIndex(v => v.id === displayed.id), preview = displayed.id !== adopted.id;
        return <View style={styles.message}>
          <Pressable style={adopted.subject === 'you' ? chatStyles.youBubble : chatStyles.iBubble}
            onLongPress={() => session.showMessage(displayed, index)}>
            <Text selectable style={styles.body}>{displayed.content}</Text>
          </Pressable>
          <View style={styles.controls}>
            <Action text="•••" action={() => session.showMessage(displayed, index)} />
            {adopted.subject === 'I' && versions.length > 1 ? <>
              <Action text="‹" disabled={versionIndex <= 0 || state.busy} action={() => session.selectVersion(versions[versionIndex - 1])} />
              <Text style={styles.small}>{versionIndex + 1}/{versions.length}</Text>
              <Action text="›" disabled={versionIndex >= versions.length - 1 || state.busy} action={() => session.selectVersion(versions[versionIndex + 1])} />
              <Text style={styles.small}>{preview ? '仅预览' : '当前采用'}</Text>
            </> : null}
          </View>
          {preview ? <>
            <Text style={styles.small}>正在预览另一版，后面的剧情仍属于原来采用的版本。</Text>
            <Action text="从这一版继续" disabled={state.busy} action={() => { void session.fromVersion(displayed); }} />
          </> : null}
        </View>;
      }} /> : null}
    <TheaterBranchOverlays session={session} generation={generation} anchors={anchors} onRead={setFocus} />
    {anchors && <TheaterAnchorPanel session={anchors} />}
    {search && <TheaterSearchPanel session={search} onNavigate={navigate} onRead={result => {
      if (result.kind === 'dialogue' || result.kind === 'alternative') setFocus({ content: result.content, speaker: result.speaker, preview: true });
    }} />}
    {focus && <TheaterFocusReader text={focus} onClose={() => setFocus(null)} />}
  </View>;
}

// Mount only inside a history card, never in a conversation's branch menu.
export function TheaterHistoryDeleteAction({ storyId, session }: { storyId: string; session: TheaterBranchSession }) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  return <Action text="删除整个小剧场" disabled={state.busy || state.loading} action={() => {
    void session.open(storyId).then(() => {
      if (session.getSnapshot().detail?.story.id === storyId) session.requestDeleteStory();
    });
  }} />;
}

export function TheaterBranchHistory({ setup, session, generation, history, onLeave, embedded = false }: {
  setup: TheaterSetupSession; session: TheaterBranchSession; generation: TheaterGenerationSession; onLeave: () => void;
  history?: TheaterHistorySession;
  embedded?: boolean;
}) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const setupState = useSyncExternalStore(setup.subscribe, setup.getSnapshot);
  useEffect(() => { if (!state.busy) void setup.refresh(); }, [setup, state.busy]);
  useEffect(() => { if (history && !state.busy && !setupState.editor && !setupState.saving) void history.refresh(); },
    [history, state.busy, setupState.editor, setupState.saving]);
  return <View style={styles.root}>
    <TheaterSetupPanel session={setup} onLeave={onLeave} embedded={embedded}
      historyContent={history ? <TheaterHistoryPanel session={history} onNew={() => setup.newStory()}
        onSelectStory={story => setup.selectStory(story)} onEditStory={story => setup.editStory(story)}
        onRenameStory={story => setup.beginRename(story)}
        renderHistoryActions={id => <TheaterHistoryDeleteAction storyId={id} session={session} />} /> : undefined}
      renderHistoryActions={id => <TheaterHistoryDeleteAction storyId={id} session={session} />} />
    <TheaterBranchOverlays session={session} generation={generation} />
  </View>;
}

const styles = StyleSheet.create({
  root: { flex: 1 }, notice: { paddingHorizontal: 16 },
  message: { maxWidth: '92%' },
  body: { color: colors.ink, fontSize: 15, lineHeight: 23 },
  small: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  action: { minHeight: 36, paddingHorizontal: 8, justifyContent: 'center' },
  controls: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' },
});
