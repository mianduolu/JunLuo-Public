import {
  memo,
  useCallback,
  useEffect,
  type MutableRefObject,
  type ReactElement,
  type RefObject,
} from 'react';
import {
  FlatList,
  Platform,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type StyleProp,
  View,
  type ViewStyle,
} from 'react-native';
import Animated from 'react-native-reanimated';

import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import { styles } from '../screens/ChatScreen.styles';
import { ChatProfilerBoundary } from './ChatProfilerBoundary';
import {
  chatHistoryResidencyDiagnosticsEnabled,
  hasHistoryDiagnosticLoadedPage,
  registerHistoryDiagnosticMountedRow,
  scheduleHistoryResidencySnapshot,
} from './chatHistoryResidencyDiagnostics';

export type ChatMessageRendererRef = MutableRefObject<
  (message: SubjectiveMessage, messageIndex: number) => ReactElement | null
>;

type ChatMessageListProps = {
  contentEmpty: boolean;
  data: SubjectiveMessage[];
  emptyComponent: ReactElement | null;
  footerComponent: ReactElement | null;
  headerComponent: ReactElement | null;
  hiddenHistoryCount: number;
  liftStyle: StyleProp<ViewStyle>;
  listRef: RefObject<FlatList<SubjectiveMessage> | null>;
  messageRenderRevision: string;
  nearBottomRef: MutableRefObject<boolean>;
  onContentEdgeChange: () => void;
  onRevealOlder: () => void;
  onUserScrollBegin: () => void;
  renderMessageBubbleRef: ChatMessageRendererRef;
  visibleMessageStartIndex: number;
};

type ChatMessageRowProps = {
  message: SubjectiveMessage;
  messageIndex: number;
  messageRenderRevision: string;
  renderMessageBubbleRef: ChatMessageRendererRef;
};

const ChatMessageRow = memo(function ChatMessageRow({
  message,
  messageIndex,
  renderMessageBubbleRef,
}: ChatMessageRowProps) {
  return renderMessageBubbleRef.current(message, messageIndex);
});

const DiagnosticChatMessageRow = memo(function DiagnosticChatMessageRow(props: ChatMessageRowProps) {
  useEffect(() => registerHistoryDiagnosticMountedRow(props.message), [props.message]);
  return <ChatMessageRow {...props} />;
});

const ChatMessageRowRenderer = chatHistoryResidencyDiagnosticsEnabled
  ? DiagnosticChatMessageRow
  : ChatMessageRow;

function ChatMessageListPresentationComponent({
  contentEmpty,
  data,
  emptyComponent,
  footerComponent,
  headerComponent,
  hiddenHistoryCount,
  liftStyle,
  listRef,
  messageRenderRevision: _messageRenderRevision,
  nearBottomRef,
  onContentEdgeChange,
  onRevealOlder,
  onUserScrollBegin,
  renderMessageBubbleRef,
  visibleMessageStartIndex,
}: ChatMessageListProps) {
  const renderItem = useCallback(
    ({ item, index }: { item: SubjectiveMessage; index: number }) =>
      <ChatMessageRowRenderer
        message={item}
        messageIndex={visibleMessageStartIndex + data.length - 1 - index}
        messageRenderRevision={_messageRenderRevision}
        renderMessageBubbleRef={renderMessageBubbleRef}
      />,
    [data.length, renderMessageBubbleRef, visibleMessageStartIndex, _messageRenderRevision],
  );

  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const distanceFromBottom = contentOffset.y;
    const distanceFromTop = contentSize.height - layoutMeasurement.height - contentOffset.y;
    nearBottomRef.current = distanceFromBottom < 96;
    if (nearBottomRef.current && hasHistoryDiagnosticLoadedPage()) {
      scheduleHistoryResidencySnapshot('latestSettled', data.length);
    }
    if (distanceFromTop <= layoutMeasurement.height * 0.25 && hiddenHistoryCount > 0) {
      onRevealOlder();
    }
  }, [hiddenHistoryCount, nearBottomRef, onRevealOlder]);

  return (
    <ChatProfilerBoundary id="ChatMessageList">
      <View style={styles.messageLiftLayer}>
        <Animated.View
          renderToHardwareTextureAndroid={Platform.OS === 'android'}
          style={[styles.messageLiftContent, liftStyle]}
        >
          <FlatList
            contentContainerStyle={[styles.messages, contentEmpty ? styles.emptyMessages : null]}
            data={data}
            initialNumToRender={18}
            inverted
            keyboardShouldPersistTaps="handled"
            keyExtractor={(message) => message.id}
            ListEmptyComponent={emptyComponent}
            ListFooterComponent={footerComponent}
            ListHeaderComponent={headerComponent}
            maxToRenderPerBatch={10}
            onContentSizeChange={onContentEdgeChange}
            onLayout={onContentEdgeChange}
            onScroll={handleScroll}
            onScrollBeginDrag={onUserScrollBegin}
            removeClippedSubviews={Platform.OS === 'android'}
            renderItem={renderItem}
            scrollEventThrottle={80}
            ref={listRef}
            showsVerticalScrollIndicator={false}
            style={styles.messageList}
            updateCellsBatchingPeriod={40}
            windowSize={7}
          />
        </Animated.View>
      </View>
    </ChatProfilerBoundary>
  );
}

function DiagnosticChatMessageListComponent(props: ChatMessageListProps) {
  useEffect(() => {
    if (!hasHistoryDiagnosticLoadedPage()) {
      if (props.data.length === 30 && props.hiddenHistoryCount > 0) {
        scheduleHistoryResidencySnapshot('initialSettled', props.data.length);
      }
      return;
    }
    if (props.data.length > 30) {
      scheduleHistoryResidencySnapshot('pageLoaded', props.data.length);
    }
  }, [props.data.length, props.hiddenHistoryCount]);
  return (
    <ChatMessageListPresentationComponent
      {...props}
    />
  );
}

function ChatMessageListComponent(props: ChatMessageListProps) {
  return chatHistoryResidencyDiagnosticsEnabled
    ? <DiagnosticChatMessageListComponent {...props} />
    : <ChatMessageListPresentationComponent {...props} />;
}

export const ChatMessageList = memo(ChatMessageListComponent);

