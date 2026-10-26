import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Pressable, StyleSheet, View, type NativeSyntheticEvent, type TextInputSubmitEditingEventData } from 'react-native';

import { AppText as Text } from '../components/AppText';
import { ChatTextAction, ChatTextInput, ChatTypingContent } from '../chat/ChatTextControls';
import { styles as chatStyles } from '../screens/ChatScreen.styles';
import { colors } from '../theme/colors';
import { TheaterDraftSession, type TheaterDraftTicket } from './theaterDraftSession';

// Survives display unmounts; only forBranch/load starts a local read, never an AI request.
const localDrafts = new TheaterDraftSession(AsyncStorage);

export type TheaterComposerProps = {
  storyId: string;
  branchId: string;
  generating: boolean;
  sendBlocked: boolean;
  onSend: (ticket: TheaterDraftTicket) => void;
  onStop: () => void;
  drafts?: TheaterDraftSession;
};

export function TheaterComposer({ storyId, branchId, generating, sendBlocked, onSend, onStop, drafts = localDrafts }: TheaterComposerProps) {
  const branch = useMemo(() => drafts.forBranch(storyId, branchId), [drafts, storyId, branchId]);
  const draft = useSyncExternalStore(branch.subscribe, branch.getSnapshot);
  const focused = useRef(false);
  useEffect(() => () => { focused.current = false; }, []);
  useEffect(() => { void branch.load(); }, [branch]);
  const ready = !draft.loading && !draft.readError;
  const binding = JSON.stringify([storyId, branchId]);
  const canSend = ready && !generating && !sendBlocked && !!draft.text.trim();
  const send = () => {
    const ticket = branch.capture();
    if (!generating && !sendBlocked && ticket?.text.trim()) onSend(ticket);
  };
  const submitShortcut = (event: NativeSyntheticEvent<TextInputSubmitEditingEventData>) => {
    const native = event.nativeEvent as TextInputSubmitEditingEventData & {
      theaterShortcut?: boolean; theaterBinding?: string;
    };
    // Ignore IME submits, unfocused/detached inputs and delayed events for an old branch/text.
    if (!focused.current || native.theaterShortcut !== true || native.theaterBinding !== binding) return;
    if (native.text !== branch.getSnapshot().text) return;
    send();
  };

  return (
    <View>
      {generating ? (
        <View style={styles.typing} testID="theater-typing">
          <ChatTypingContent>正在输入中……</ChatTypingContent>
        </View>
      ) : null}
      {draft.loading ? <Text style={styles.notice}>正在读取草稿…</Text> : null}
      {draft.readError || draft.saveError ? (
        <View style={styles.noticeRow}>
          {draft.readError || draft.text ? (
            <Text style={[styles.notice, styles.noticeText]}>
              {draft.readError ? '没能读到这条走向的草稿' : '输入内容还在，暂时没能保存到本机。'}
            </Text>
          ) : null}
          <Pressable onPress={() => { void branch.retry(); }} accessibilityRole="button" hitSlop={8}>
            <Text style={styles.retry}>重试</Text>
          </Pressable>
        </View>
      ) : null}
      <View style={chatStyles.composerRow}>
        <View style={chatStyles.inputBar}>
          <ChatTextInput
            key={binding}
            editable={ready}
            nativeID={`${canSend ? 'junluo-theater-submit:' : 'junluo-theater-no-submit:'}${binding}`}
            onFocus={() => { focused.current = true; }}
            onBlur={() => { focused.current = false; }}
            onChangeText={(text) => branch.change(text)}
            onSubmitEditing={submitShortcut}
            placeholder="输入台词…"
            submitBehavior="newline"
            testID="junluo-theater-draft-input"
            value={draft.text}
          />
        </View>
        <ChatTextAction
          accessibilityLabel={generating ? '停止生成' : '发送台词'}
          stops={generating}
          disabled={!generating && (!ready || sendBlocked || !draft.text.trim())}
          onPress={generating ? onStop : send}
        />
      </View>
    </View>
  );
}

// The Chapter 6 sender must call this only after the captured you text is committed.
// Keeping acknowledgment separate means request failure cannot clear unsaved text.
export function acknowledgeTheaterDraftSaved(ticket: TheaterDraftTicket, drafts = localDrafts) {
  drafts.forBranch(ticket.storyId, ticket.branchId).acknowledgeSaved(ticket);
}

const styles = StyleSheet.create({
  typing: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 8 },
  notice: { color: colors.muted, fontSize: 12, lineHeight: 18, paddingVertical: 6 },
  noticeRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  noticeText: { flex: 1 },
  retry: { color: colors.ink, fontSize: 13 },
});
