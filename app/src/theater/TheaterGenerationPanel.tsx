import { useEffect, useState, useSyncExternalStore, type ComponentProps } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { AppText as Text } from '../components/AppText';
import { colors } from '../theme/colors';
import { TheaterConversationPanel } from './TheaterConversationPanel';
import type { TheaterDraftSession } from './theaterDraftSession';
import { theaterBindingKey, type TheaterGenerationNotice, type TheaterGenerationSession } from './theaterGenerationSession';
import type { TheaterBinding } from './theaterGenerationStore';
import type { TheaterReadingProps } from './TheaterReadingList';

const notices: Record<TheaterGenerationNotice, string> = {
  'you-save': '台词还没保存，输入内容还在。',
  'reply-failed': '台词已保存，这次没能收到回复。',
  'opening-failed': '这次没能收到开场回复。',
  stopped: '已停止生成，已保存的台词会保留。',
  'reply-save': '回复已收到，但还没保存成功。先不要关闭 App，可以重试保存。',
  'not-configured': '还没设置聊天模型，可以先把台词写下来。',
  'not-configured-saved': '台词已保存，等设置好模型后再继续。',
  network: '台词已保存，暂时连不上模型。',
  capacity: '这次要带的内容太多，超过了当前设置的容量。台词没有删减。',
  'provider-capacity': '模型没能装下这次的内容。台词没有删减。',
  changed: '这次生成依据的剧情已改变，已停止生成。',
  'anchors-changed': '这次生成使用的剧情锚点已改变，已停止生成。',
  'anchor-read': '没能读取剧情锚点，请重试。',
  'stale-reply': '这条回复对应的是修改前的剧情，不能接到现在的走向。可以复制留存。',
  restoring: '正在恢复备份，这次生成已停止。',
  'read-failed': '暂时没能读到小剧场',
  'regeneration-failed': '这次没能生成新版本。',
  'regeneration-stopped': '已停止重演。',
  'regeneration-save': '新版本已收到，但还没保存成功，可以重试保存，若需要重启时请先复制留存。',
};
type Props = TheaterReadingProps & {
  session: TheaterGenerationSession;
  binding: TheaterBinding;
  drafts?: TheaterDraftSession;
  onOpenStory: (binding: TheaterBinding) => void;
  onOpenSettings: () => void;
  renderMessage?: ComponentProps<typeof TheaterConversationPanel>['renderMessage'];
};

// Unmounted Chapter 6 host. Switching views only changes the subscription target;
// it never cancels, recreates or navigates on behalf of an in-flight request.
export function TheaterGenerationPanel({ session, binding, drafts, onOpenStory, onOpenSettings, renderMessage, reading, readingActive, jump, onJumpHandled, displayedVersionId }: Props) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const key = theaterBindingKey(binding);
  const [youOpening, setYouOpening] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<{ key: string; text: string; status: string } | null>(null);
  useEffect(() => { void session.refresh(binding); }, [session, key, state.readRevision]);
  const snapshot = state.snapshots[key];
  const notice = state.notices[key];
  const activeHere = !!state.active && theaterBindingKey(state.active.binding) === key;
  const busyElsewhere = !!state.active && !activeHere;
  const pending = !!state.pending[key];
  const stale = state.staleReplies[key];
  const pendingText = state.pendingTexts?.[key];
  const regenerationTarget = state.regenerationTargets?.[key];
  const names = snapshot?.story.settings.names ?? { I: '白云小姐', you: '小仓鼠' };
  const messages = snapshot?.versions.filter(version => version.kind === 'dialogue') ?? [];
  const empty = !!snapshot && messages.length === 0;
  const unanswered = messages.at(-1)?.subject === 'you';
  const button = (label: string, onPress: () => void, disabled = false) => (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress}
      disabled={disabled} style={styles.action}><Text style={styles.actionText}>{label}</Text></Pressable>
  );
  let action = null;
  if (notice === 'you-save') action = button('重试保存', () => { void session.retryYou(binding); }, !!state.active);
  else if (pending) action = button('重试保存', () => { void session.retryReplySave(binding); }, !!state.active);
  else if ((notice === 'regeneration-failed' || notice === 'regeneration-stopped') && regenerationTarget) {
    action = button('重试', () => { void session.regenerate(binding, regenerationTarget); }, !!state.active);
  }
  else if (notice === 'opening-failed') action = button('重试开场', () => { void session.continueReply(binding, true); }, !!state.active);
  else if (notice === 'capacity' || notice === 'provider-capacity') action = button('查看设定', onOpenSettings);
  else if (notice === 'read-failed' || notice === 'anchor-read') action = button('重试', () => { void session.refresh(binding); });
  else if (!state.active && unanswered) action = button(
    notice === 'reply-failed' || notice === 'network' ? '重试回复' : '继续回复',
    () => { void session.continueReply(binding); },
  );
  const copy = async (text = stale) => {
    if (!text) return;
    try { await Clipboard.setStringAsync(text); setCopyState({ key, text, status: '已复制' }); }
    catch { setCopyState({ key, text, status: '没能复制，请重试。' }); }
  };
  return (
    <View style={styles.root}>
      <View style={styles.status}>
        {notice ? <Text style={styles.notice}>{notices[notice]}</Text> : null}
        {pending ? <Text style={styles.notice}>先保存刚才收到的回复，再继续发送。输入内容会保留。</Text> : null}
        {action}
        {pendingText ? <>
          <ScrollView style={styles.stale}><Text selectable style={styles.notice}>{pendingText}</Text></ScrollView>
          {button('复制正文', () => { void copy(pendingText); })}
          {copyState?.key === key && copyState.text === pendingText ? <Text style={styles.notice}>{copyState.status}</Text> : null}
        </> : null}
        {notice === 'stale-reply' && stale ? <>
          <ScrollView style={styles.stale}><Text selectable style={styles.notice}>{stale}</Text></ScrollView>
          {button('复制回复', () => { void copy(); })}
          {copyState?.key === key && copyState.text === stale ? <Text style={styles.notice}>{copyState.status}</Text> : null}
        </> : null}
        {busyElsewhere ? <>
          <Text style={styles.notice}>有一场小剧场正在生成，完成或停止后才能开始下一次。</Text>
          {button('查看正在生成的剧场', () => { if (state.active) onOpenStory(state.active.binding); })}
        </> : null}
        {empty && !state.active && !pending ? <View style={styles.opening}>
          {youOpening !== key ? button(`${names.you}先开口`, () => setYouOpening(key)) : null}
          {button(`让${names.I}先开场`, () => { void session.continueReply(binding, true); })}
        </View> : null}
      </View>
      <TheaterConversationPanel {...binding} drafts={drafts} messages={messages} names={names}
        reading={reading} readingActive={readingActive} jump={jump} onJumpHandled={onJumpHandled} loaded={!!snapshot}
        displayedVersionId={displayedVersionId}
        renderMessage={renderMessage}
        generating={activeHere} sendBlocked={!snapshot || busyElsewhere || pending || notice === 'restoring'}
        onSend={ticket => { void session.send(ticket); }} onStop={() => session.stop()} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  status: { paddingHorizontal: 16 },
  stale: { maxHeight: 160 },
  notice: { color: colors.muted, fontSize: 12, lineHeight: 18, paddingVertical: 4 },
  action: { paddingVertical: 8, alignSelf: 'flex-start' },
  actionText: { color: colors.ink, fontSize: 13 },
  opening: { flexDirection: 'row', flexWrap: 'wrap', gap: 20 },
});
