import { useEffect, useRef, type ReactElement } from 'react';
import { ActivityIndicator, FlatList, Pressable, View } from 'react-native';
import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import { AppText as Text } from '../components/AppText';
import { styles } from '../screens/ChatScreen.styles';
import type { useChatHistorySearchController } from './useChatHistorySearchController';

type Props = { controller: ReturnType<typeof useChatHistorySearchController>;
  renderMessage: (message: SubjectiveMessage, index: number) => ReactElement | null };
export function ChatHistoryWindow({ controller: c, renderMessage }: Props) {
  const list = useRef<FlatList<SubjectiveMessage>>(null);
  const pendingFocus = useRef(true);
  const focusAttempts = useRef(0);
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollOffset = useRef(0);
  const restoreOffset = useRef(false);
  const window = c.window;
  const anchorIndex = window?.messages.findIndex(message => message.id === window.anchorId) ?? -1;
  const focus = () => {
    if (!pendingFocus.current || !window?.messages.length) return;
    pendingFocus.current = false;
    list.current?.scrollToIndex({ index: Math.max(0, anchorIndex), animated: false, viewPosition: 0.5 });
  };
  useEffect(() => {
    pendingFocus.current = true;
    restoreOffset.current = false;
    focusAttempts.current = 0;
    retry.current = setTimeout(focus, 50);
    return () => { if (retry.current) clearTimeout(retry.current); };
  }, [c.focusVersion]);
  useEffect(() => { if (!window) restoreOffset.current = true; }, [window]);
  return <View style={{ flex: 1 }}>
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', padding: 10, backgroundColor: '#F1F7FC' }}>
      <Pressable onPress={c.openSearch} style={{ padding: 8 }}><Text style={styles.clearText}>返回搜索</Text></Pressable>
      <Pressable onPress={c.returnToLatest} style={{ padding: 8 }}><Text style={styles.clearText}>回到最新</Text></Pressable>
    </View>
    {!!c.notice && <Text accessibilityRole="alert" style={styles.hiddenHistoryNotice}>{c.notice}</Text>}
    <FlatList ref={list} data={window?.messages ?? []} keyExtractor={message => message.id}
      contentContainerStyle={styles.messages} initialNumToRender={20} maxToRenderPerBatch={10} windowSize={5}
      onContentSizeChange={() => {
        if (!window?.messages.length) return;
        if (restoreOffset.current && !pendingFocus.current) {
          restoreOffset.current = false;
          list.current?.scrollToOffset({ offset: scrollOffset.current, animated: false });
        } else focus();
      }}
      onScroll={event => { if (window && !restoreOffset.current) scrollOffset.current = event.nativeEvent.contentOffset.y; }}
      scrollEventThrottle={100}
      onScrollBeginDrag={() => { pendingFocus.current = false; restoreOffset.current = false; }}
      onScrollToIndexFailed={({ index, averageItemLength }) => {
        if (focusAttempts.current++ >= 4) return;
        list.current?.scrollToOffset({ offset: Math.max(0, (index - 2) * averageItemLength), animated: false });
        pendingFocus.current = true;
        if (retry.current) clearTimeout(retry.current);
        retry.current = setTimeout(focus, 80);
      }}
      renderItem={({ item, index }) => <View style={item.id === c.highlightId ? { backgroundColor: '#FFF0BD', borderRadius: 15 } : undefined}>
        {renderMessage(item, (window?.startIndex ?? 0) + index)}</View>}
      ListEmptyComponent={c.busy ? <ActivityIndicator color="#76A8D2" /> : null}
      ListHeaderComponent={window && window.startIndex > 0 ? <Pressable disabled={c.busy} onPress={c.older} style={{ padding: 16 }}>
        <Text style={styles.hiddenHistoryNotice}>查看更早消息</Text></Pressable> : null}
      ListFooterComponent={window && window.endIndex < window.totalCount ? <Pressable disabled={c.busy} onPress={c.newer} style={{ padding: 16 }}>
        <Text style={styles.hiddenHistoryNotice}>查看较新消息</Text></Pressable> : null} />
  </View>;
}
