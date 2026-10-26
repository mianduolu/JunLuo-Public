import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { AppState, FlatList, Pressable, StyleSheet, View, type ViewToken } from 'react-native';
import { AppText as Text } from '../components/AppText';
import { styles as chatStyles } from '../screens/ChatScreen.styles';
import { colors } from '../theme/colors';
import type { TheaterBinding } from './theaterGenerationStore';
import type { TheaterTextVersion } from './theaterStoryTypes';
import { theaterDay, type TheaterReadingSession } from './theaterReadingSession';

export type TheaterReadingJump = { positionId: string; request: number; storyId: string; branchId: string; consumed?: boolean };
export type TheaterReadingProps = { reading?: TheaterReadingSession; readingActive?: boolean; jump?: TheaterReadingJump;
  onJumpHandled?: (request: number) => void; displayedVersionId?: (message: TheaterTextVersion) => string };
type Props = TheaterReadingProps & { binding: TheaterBinding; reading: TheaterReadingSession;
  messages: TheaterTextVersion[]; names: { I: string; you: string }; loaded: boolean;
  renderMessage?: (message: TheaterTextVersion, index: number) => ReactNode };

// Remount per binding: a request started elsewhere can never move this list.
export function TheaterReadingList(props: Props) {
  const { reading, binding, messages, names, renderMessage } = props;
  const local = useSyncExternalStore(reading.subscribe, reading.getSnapshot);
  const list = useRef<FlatList<TheaterTextVersion>>(null);
  const initialized = useRef(false), following = useRef(true), offset = useRef(0);
  const first = useRef<string | null>(null), visible = useRef<TheaterTextVersion[]>([]);
  const viewport = useRef(0), contentHeight = useRef(0), targetIndex = useRef<number | null>(null);
  const [width, setWidth] = useState(0);
  const measuredWidth = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastJump = useRef<number | undefined>(undefined);
  const viewability = useRef({ viewAreaCoveragePercentThreshold: 1, minimumViewTime: 200 }).current;
  const [atBottom, setAtBottom] = useState(true), [foreground, setForeground] = useState(AppState.currentState === 'active');
  const [divider, setDivider] = useState<string | null>(null);
  const current = useRef(props); current.current = props;
  const active = props.readingActive !== false && foreground;
  const activity = useRef(active); activity.current = active;
  const mark = reading.mark(binding);
  const goIndex = (index: number) => {
    if (index < 0) return;
    targetIndex.current = index;
    list.current?.scrollToIndex({ index, animated: false, viewPosition: 0 });
  };
  const savePosition = () => {
    if (initialized.current && targetIndex.current === null) reading.bookmark(binding, offset.current, first.current, measuredWidth.current);
  };
  const onVisible = useRef(({ viewableItems }: { viewableItems: ViewToken<TheaterTextVersion>[] }) => {
    const p = current.current;
    const rows = viewableItems.filter(v => v.isViewable);
    visible.current = rows.map(v => v.item);
    first.current = rows[0]?.item.positionId ?? first.current;
    if (targetIndex.current !== null && rows.some(v => v.index === targetIndex.current)) targetIndex.current = null;
    if (initialized.current && targetIndex.current === null && activity.current)
      p.reading.seen(p.binding, visible.current.map(v => p.displayedVersionId?.(v) ?? v.id));
  }).current;
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => setForeground(state === 'active'));
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    if (!local.ready || !props.loaded || !width) return;
    const explicit = props.jump && !props.jump.consumed && props.jump.storyId === binding.storyId && props.jump.branchId === binding.branchId
      && props.jump.request !== lastJump.current;
    if (!initialized.current || explicit) {
      const unreadIndex = messages.findIndex(v => mark.unread.includes(v.id));
      const requested = explicit ? messages.findIndex(v => v.positionId === props.jump!.positionId) : unreadIndex;
      initialized.current = true;
      if (explicit) { lastJump.current = props.jump!.request; props.onJumpHandled?.(props.jump!.request); }
      setDivider(unreadIndex >= 0 ? messages[unreadIndex].id : null);
      if (requested >= 0) {
        following.current = false; setAtBottom(false); goIndex(requested);
      } else if (mark.positionId || mark.offset) {
        following.current = false; setAtBottom(false);
        const index = messages.findIndex(v => v.positionId === mark.positionId);
        if (index >= 0 && mark.width !== width) goIndex(index);
        else list.current?.scrollToOffset({ offset: mark.offset, animated: false });
      } else { following.current = true; list.current?.scrollToEnd({ animated: false }); }
    }
  }, [reading, local.ready, props.loaded, props.jump, messages, width]);
  useEffect(() => {
    if (!divider && mark.unread.length) setDivider(messages.find(v => mark.unread.includes(v.id))?.id ?? null);
  }, [mark.unread, messages, divider]);
  useEffect(() => {
    // A modal or a background App never acknowledges the obscured list.
    if (active && initialized.current && targetIndex.current === null)
      reading.seen(binding, visible.current.map(v => props.displayedVersionId?.(v) ?? v.id));
  }, [active, mark.unread.join('|'), props.displayedVersionId]);
  useEffect(() => () => {
    savePosition();
    if (retryTimer.current) clearTimeout(retryTimer.current);
  }, []);
  return <View style={styles.root}>
    <FlatList ref={list} data={messages} keyExtractor={v => v.id} keyboardShouldPersistTaps="handled"
      contentContainerStyle={styles.messages} scrollEventThrottle={100}
      viewabilityConfig={viewability} onViewableItemsChanged={onVisible}
      onScrollBeginDrag={() => { targetIndex.current = null; }}
      onScroll={event => {
        const e = event.nativeEvent; offset.current = e.contentOffset.y;
        const bottom = e.contentSize.height - e.layoutMeasurement.height - e.contentOffset.y <= 32;
        if (targetIndex.current === null) { following.current = bottom; setAtBottom(bottom); }
        savePosition();
      }}
      onLayout={e => {
        const nextWidth = e.nativeEvent.layout.width, oldWidth = measuredWidth.current;
        measuredWidth.current = nextWidth; setWidth(nextWidth);
        const previous = viewport.current; viewport.current = e.nativeEvent.layout.height;
        if (oldWidth && oldWidth !== nextWidth && initialized.current && !following.current) {
          goIndex(messages.findIndex(v => v.positionId === first.current));
        }
        if (previous && initialized.current && following.current && active) list.current?.scrollToEnd({ animated: false });
      }}
      onContentSizeChange={(_, height) => {
        const changed = height !== contentHeight.current; contentHeight.current = height;
        if (changed && initialized.current && following.current && active) list.current?.scrollToEnd({ animated: false });
        else if (changed && initialized.current && !active) {
          const bottom = height - viewport.current - offset.current <= 32;
          following.current = bottom; setAtBottom(bottom);
        }
      }}
      onScrollToIndexFailed={({ index, averageItemLength }) => {
        list.current?.scrollToOffset({ offset: Math.max(0, index * averageItemLength), animated: false });
        if (retryTimer.current) clearTimeout(retryTimer.current);
        retryTimer.current = setTimeout(() => { if (targetIndex.current === index) goIndex(index); }, 100);
      }}
      renderItem={({ item, index }) => {
        if (item.kind !== 'dialogue') return null;
        const previous = messages[index - 1], day = theaterDay(item.createdAt);
        return <View>
          {(!previous || theaterDay(previous.createdAt) !== day) && <Text style={styles.divider}>{day}</Text>}
          {item.id === divider && <Text style={styles.divider}>以下是新台词</Text>}
          <View style={[styles.row, item.subject === 'you' && styles.right]}>
            {previous?.subject !== item.subject && <Text style={chatStyles.messageName}>{names[item.subject]}</Text>}
            {renderMessage ? renderMessage(item, index) : <View style={item.subject === 'you' ? chatStyles.youBubble : chatStyles.iBubble}>
              <Text selectable style={styles.body}>{item.content}</Text></View>}
          </View>
        </View>;
      }} />
    {!atBottom && <Pressable accessibilityRole="button" style={styles.jump} onPress={() => {
      targetIndex.current = null; following.current = true; list.current?.scrollToEnd({ animated: true });
    }}><Text style={styles.body}>{mark.unread.length ? '有新台词 ↓' : '回到最新 ↓'}</Text></Pressable>}
  </View>;
}
const styles = StyleSheet.create({ root: { flex: 1 }, messages: { paddingVertical: 12, gap: 10 },
  row: { alignItems: 'flex-start', gap: 4 }, right: { alignItems: 'flex-end' },
  body: { color: colors.ink, fontSize: 15, lineHeight: 23 },
  divider: { color: colors.muted, textAlign: 'center', fontSize: 12, marginVertical: 12 },
  jump: { alignSelf: 'center', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 18, backgroundColor: colors.card },
});
