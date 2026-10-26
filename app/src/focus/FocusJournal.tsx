import { useRef } from 'react';
import {
  FlatList,
  ScrollView,
  Pressable,
  StyleSheet,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';

import { AppText as Text } from '../components/AppText';
import { colors } from '../theme/colors';
import type { FocusLogEntry } from './focusStore';
import { isFocusSleepReplyReceipt, selectFocusSleepReplySources } from './focusSleepReplyPolicy';
import { isFocusOrganizationLog } from './focusSummaryRecord';
import { isFocusGenerationFailureResolved } from './focusChatDelivery';

type JournalLog = Omit<FocusLogEntry, 'sessionId'>;
type ScrollEvent = NativeSyntheticEvent<NativeScrollEvent>;
type EntryProps = {
  log: JournalLog;
  now?: number;
  showDate?: boolean;
  onRetry?: (log: JournalLog) => void;
};

export const focusJournalPalette = {
  paper: 'rgba(253,253,252,0.8)',
  youName: '#B07148',
  youDot: '#E3A57A',
  IName: '#527C9D',
  IDot: '#80A7C5',
};

export function normalizeFocusJournalText(content: string) {
  return content
    .trim()
    .replace(/^I\s*[:：]\s*/i, '')
    .replace(/(^|[\s，。！？、；：])I(?=[:：\s，。！？、；]|[\u4e00-\u9fff])/g, '$1我')
    .trim();
}

function journalStamp(createdAt: number, showDate: boolean, now: number) {
  const date = new Date(createdAt);
  const today = new Date(now);
  const sameDay = date.getFullYear() === today.getFullYear()
    && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return showDate || !sameDay
    ? `${String(date.getMonth() + 1).padStart(2, '0')}月${String(date.getDate()).padStart(2, '0')}日 ${time}`
    : time;
}

export function FocusJournalEntry({ log, now = Date.now(), showDate = false, onRetry }: EntryProps) {
  const failed = log.trigger === 'focus-opening-failed'
    || log.trigger === 'focus-sleep-opening-failed'
    || log.trigger === 'focus-generation-failed' || log.trigger === 'focus-chat-failed'
    || log.trigger === 'focus-chat-save-failed' || log.trigger === 'focus-sleep-reply-failed';
  const stamp = journalStamp(log.createdAt, showDate, now);
  const content = normalizeFocusJournalText(log.content);
  if (log.role === 'system') {
    return (
      <View style={styles.statusEntry}>
        <View style={styles.meta}>
          <Text style={styles.time}>{stamp} ·</Text>
          <Text style={styles.statusLabel}>{log.trigger === 'focus-chat-save-failed' ? '保存状态' : failed ? '生成状态' : '专注状态'}</Text>
        </View>
        <Text style={styles.statusText}>{content}</Text>
        {failed && onRetry ? (
          <Pressable onPress={() => onRetry(log)} style={styles.retryButton}>
            <Text style={styles.retryText}>重试</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }
  const fromYou = log.role === 'you';
  return (
    <View style={styles.entry}>
      <View style={[styles.dot, { backgroundColor: fromYou ? focusJournalPalette.youDot : focusJournalPalette.IDot }]} />
      <View style={styles.meta}>
        <Text style={styles.time}>{stamp}</Text>
        <Text style={[styles.author, { color: fromYou ? focusJournalPalette.youName : focusJournalPalette.IName }]}>
          {fromYou ? '小仓鼠' : '白云小姐'}
        </Text>
      </View>
      <Text style={styles.body}>{content}</Text>
    </View>
  );
}

export function FocusJournalList({ logs, now, onRetry, nested = false }: {
  logs: JournalLog[];
  now: number;
  onRetry: (log: JournalLog) => void;
  nested?: boolean;
}) {
  const listRef = useRef<FlatList<JournalLog>>(null);
  const followEndRef = useRef(true);
  const userScrollingRef = useRef(false);
  const scrollRef = useRef<ScrollView>(null);
  const nearEnd = ({ nativeEvent }: ScrollEvent) => (
    nativeEvent.contentSize.height - nativeEvent.layoutMeasurement.height - nativeEvent.contentOffset.y <= 40
  );
  const followEnd = () => {
    if (followEndRef.current && !userScrollingRef.current) {
      (nested ? scrollRef : listRef).current?.scrollToEnd({ animated: false });
    }
  };
  const finishUserScroll = (event: ScrollEvent) => {
    followEndRef.current = nearEnd(event);
    userScrollingRef.current = false;
  };
  const visibleLogs = logs.filter(log => !isFocusSleepReplyReceipt(log) && !isFocusOrganizationLog(log)
    && !isFocusGenerationFailureResolved(log, logs));
  const renderEntry = (log: JournalLog) => <FocusJournalEntry key={log.id} log={log} now={now} onRetry={
    log.trigger === 'focus-sleep-opening-failed' && logs.some(answer => answer.id === `${log.id}:sleep-opening-retry`)
      || log.trigger === 'focus-sleep-reply-failed' && !selectFocusSleepReplySources(logs).pending.length
      ? undefined : onRetry
  } />;
  const scrollProps = {
    contentContainerStyle: styles.listContent,
    keyboardShouldPersistTaps: 'handled' as const,
    onContentSizeChange: followEnd,
    onLayout: followEnd,
    onMomentumScrollBegin: () => { userScrollingRef.current = true; },
    onMomentumScrollEnd: finishUserScroll,
    onScroll: (event: ScrollEvent) => {
      if (userScrollingRef.current) followEndRef.current = nearEnd(event);
    },
    onScrollBeginDrag: () => { userScrollingRef.current = true; },
    onScrollEndDrag: (event: ScrollEvent) => {
      finishUserScroll(event);
      // Keep following suspended between release and the native momentum event.
      if (event.nativeEvent.velocity?.y) userScrollingRef.current = true;
    },
    scrollEventThrottle: 16,
    style: styles.list,
  };
  // A bounded nested ScrollView avoids placing a virtualized list inside the page ScrollView.
  return nested ? <ScrollView {...scrollProps} nestedScrollEnabled ref={scrollRef}>
    {visibleLogs.map(renderEntry)}
  </ScrollView> : (
    <FlatList
      {...scrollProps}
      data={visibleLogs}
      extraData={now}
      keyExtractor={(log) => log.id}
      ref={listRef}
      renderItem={({ item }) => renderEntry(item)}
    />
  );
}

const styles = StyleSheet.create({
  list: { flex: 1, minHeight: 0 },
  listContent: { paddingTop: 4, paddingBottom: 12 },
  entry: {
    borderLeftColor: 'rgba(56,64,82,0.11)',
    borderLeftWidth: StyleSheet.hairlineWidth,
    marginLeft: 4,
    paddingLeft: 18,
    paddingBottom: 22,
  },
  dot: {
    position: 'absolute',
    left: -7,
    top: 4,
    width: 13,
    height: 13,
    borderRadius: 7,
    borderWidth: 3,
    borderColor: '#FDFDFC',
  },
  meta: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', gap: 10, marginBottom: 7 },
  time: { color: '#79818B', fontSize: 12, lineHeight: 20, fontWeight: '400' },
  author: { fontSize: 13, lineHeight: 20, fontWeight: '500' },
  body: { color: colors.ink, fontSize: 16, lineHeight: 27, fontWeight: '400' },
  statusEntry: {
    borderTopColor: 'rgba(56,64,82,0.12)',
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 12,
    paddingBottom: 18,
  },
  statusLabel: { color: '#8C7766', fontSize: 12, lineHeight: 20 },
  statusText: { color: colors.muted, fontSize: 13, lineHeight: 22, fontWeight: '400' },
  retryButton: {
    alignSelf: 'flex-start',
    borderColor: 'rgba(56,64,82,0.15)',
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 5,
    marginTop: 7,
  },
  retryText: { color: colors.muted, fontSize: 12, fontWeight: '400' },
});
