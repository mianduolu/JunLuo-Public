import { useEffect, useRef, useState, type ReactElement } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, View } from 'react-native';
import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import { AppText as Text } from '../components/AppText';
import { ChatTextInput, ChatTextAction } from '../chat/ChatTextControls';
import type { ChatComposerProps } from '../chat/ChatComposer';

type Props = {
  messages: SubjectiveMessage[]; loading: boolean; failure: boolean;
  renderMessage: (message: SubjectiveMessage, index: number) => ReactElement | null;
  revision: string;
  composer: ChatComposerProps; empty: ReactElement | null;
  typing: ReactElement | null; error: string | null;
};

export function PhoneLockChatPresentation(props: Props) {
  const { composer } = props;
  const [text, setText] = useState(composer.draftText);
  const list = useRef<FlatList<SubjectiveMessage>>(null);
  const nearBottom = useRef(true);
  useEffect(() => { setText(composer.draftText); }, [composer.draftResetVersion, composer.draftText]);
  const stops = composer.sendActsAsStop && !text.trim();
  const data = [...props.messages].reverse();
  return <View style={styles.surface}>
    <FlatList
      ref={list} inverted data={data} style={styles.messages}
      contentContainerStyle={styles.messageContent}
      keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}
      keyExtractor={message => message.id} extraData={props.revision}
      renderItem={({ item, index }) => props.renderMessage(item, data.length - 1 - index)}
      ListEmptyComponent={props.loading ? <ActivityIndicator color="#76A8D2" /> : props.empty}
      ListHeaderComponent={props.typing}
      onScroll={event => { nearBottom.current = event.nativeEvent.contentOffset.y < 96; }}
      onContentSizeChange={() => { if (nearBottom.current) list.current?.scrollToOffset({ offset: 0, animated: false }); }}
      initialNumToRender={18} maxToRenderPerBatch={10} windowSize={7}
      maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
    />
    {props.failure || props.error ? <Text style={styles.notice}>{props.error || '聊天记录暂时未读到'}</Text> : null}
    {composer.replyingToMessage ? <View style={styles.reply}>
      <Text numberOfLines={1} style={styles.quote}>{composer.replyingToMessage.content}</Text>
      <Pressable accessibilityLabel="取消回复这条消息" onPress={composer.onCancelReply}><Text style={styles.close}>×</Text></Pressable>
    </View> : null}
    <View style={styles.composer}>
      <ChatTextInput value={text} ref={composer.inputRef} editable={composer.configLoaded}
        testID="junluo-phone-lock-chat-input" style={styles.input}
        placeholder={composer.configured ? '输入消息...' : '请先完成白云与连接'}
        onFocus={composer.onInputFocus}
        onChangeText={value => { setText(value); composer.onChangeDraft(value); }} />
      <ChatTextAction stops={stops}
        accessibilityLabel={stops ? '停止生成' : '发送消息'}
        disabled={!stops && (composer.sendBlocked || !composer.configLoaded || !text.trim())}
        onPress={stops ? composer.onStop : composer.onSend} />
    </View>
  </View>;
}

const styles = StyleSheet.create({
  surface: { flex: 1 }, messages: { flex: 1 },
  messageContent: { paddingTop: 16, paddingBottom: 12 },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingTop: 8, paddingBottom: 4 },
  input: { flex: 1, minHeight: 50, maxHeight: 96, borderRadius: 16, paddingHorizontal: 13,
    paddingVertical: 10, fontSize: 14.5, lineHeight: 22.5, color: '#384052',
    borderWidth: 1, borderColor: 'rgba(157,201,240,0.62)', backgroundColor: 'rgba(248,253,255,0.94)' },
  notice: { fontSize: 12, color: '#8193A9', paddingVertical: 4 },
  reply: { flexDirection: 'row', alignItems: 'center', borderRadius: 12, padding: 8, backgroundColor: '#EEF6FF' },
  quote: { flex: 1, fontSize: 12, color: '#384052' }, close: { fontSize: 20, color: '#8193A9', paddingHorizontal: 8 },
});
