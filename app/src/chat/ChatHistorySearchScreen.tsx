import { useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Modal, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppText as Text, AppTextInput as TextInput } from '../components/AppText';
import { DateTimePickerSheet } from '../components/DateTimePickerSheet';
import { dateKeyFromTimestamp, type DateTimeSelection } from '../schedule/dateTimeSelection';
import { colors } from '../theme/colors';
import type { ChatSearchHit } from './chatHistorySearch';
import type { useChatHistorySearchController } from './useChatHistorySearchController';

type Props = { controller: ReturnType<typeof useChatHistorySearchController> };
export function ChatHistorySearchScreen({ controller: c }: Props) {
  const insets = useSafeAreaInsets();
  const list = useRef<FlatList<ChatSearchHit>>(null);
  const [dateOpen, setDateOpen] = useState(false);
  const value: DateTimeSelection = { date: c.query.startDate ?? dateKeyFromTimestamp(Date.now()),
    endDate: c.query.endDate, recurrence: 'none', reminderChoice: 'none', reminderClock: '09:00', reminderIntensity: 'gentle' };
  const canSearch = !!(c.query.text.trim() || c.query.startDate || c.query.endDate);
  return <Modal animationType="slide" visible={c.searchOpen} onRequestClose={c.closeSearch}>
    <View style={[s.page, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <View style={s.header}>
        <Pressable accessibilityLabel="返回聊天" onPress={c.closeSearch} style={s.button}><Text style={s.link}>‹ 返回</Text></Pressable>
        <Text style={s.title}>搜索聊天记录</Text><View style={{ width: 72 }} />
      </View>
      <View style={s.form}>
        <View style={s.inputRow}>
          <TextInput accessibilityLabel="聊天关键词" placeholder="查找聊过的话" returnKeyType="search" style={s.input}
            value={c.query.text} onChangeText={text => c.changeQuery({ ...c.query, text })}
            onSubmitEditing={() => { if (canSearch) void c.search(); }} />
          <Pressable disabled={!canSearch || c.busy} onPress={() => void c.search()} style={[s.search, !canSearch && s.disabled]}>
            <Text style={s.searchText}>查找</Text>
          </Pressable>
        </View>
        <View style={s.dateRow}>
          <Pressable onPress={() => setDateOpen(true)} style={s.date}>
            <Text style={s.link}>{c.query.startDate
              ? `${c.query.startDate}${c.query.endDate && c.query.endDate !== c.query.startDate ? ` 至 ${c.query.endDate}` : ''}`
              : '选择日期 · 单日或范围'}</Text>
          </Pressable>
          {c.query.startDate && <Pressable onPress={() => c.changeQuery({ text: c.query.text })} style={s.button}><Text style={s.muted}>清除日期</Text></Pressable>}
        </View>
        <Text style={s.hint}>只查本机已保存的记录 · 日期包含首尾两天</Text>
      </View>
      {!!c.notice && <Text accessibilityRole="alert" style={s.notice}>{c.notice}</Text>}
      <FlatList ref={list} data={c.hits} keyExtractor={item => item.id} keyboardShouldPersistTaps="handled"
        contentContainerStyle={s.results} onLayout={() => list.current?.scrollToOffset({ offset: c.offset.current, animated: false })}
        onScroll={event => { c.offset.current = event.nativeEvent.contentOffset.y; }} scrollEventThrottle={100}
        renderItem={({ item }) => <Pressable onPress={() => void c.locate(item.id)} style={s.result}>
          <View style={s.resultHeader}><Text style={s.author}>{item.role === 'I' ? '白云小姐' : '小仓鼠'}</Text>
            <Text style={s.time}>{new Date(item.createdAt).toLocaleString('zh-CN', { hour12: false })}</Text></View>
          <Text numberOfLines={4} style={s.excerpt}>{item.matchStart < 0 ? item.excerpt : <>
            {item.excerpt.slice(0, item.matchStart)}<Text style={s.mark}>{item.excerpt.slice(item.matchStart, item.matchStart + item.matchLength)}</Text>
            {item.excerpt.slice(item.matchStart + item.matchLength)}</>}</Text>
        </Pressable>}
        ListEmptyComponent={!c.busy ? <Text style={s.empty}>{c.searched && canSearch ? '没有找到符合条件的聊天记录' : '输入关键词或选择日期，找找聊过的话。'}</Text> : null}
        ListFooterComponent={<View style={s.footer}>{c.busy ? <ActivityIndicator color={colors.primary} /> : c.next ?
          <Pressable onPress={() => void c.search(true)} style={s.button}><Text style={s.link}>查看更多</Text></Pressable> : null}</View>} />
      <DateTimePickerSheet dateOnly title="查找日期" value={value} visible={dateOpen} onClose={() => setDateOpen(false)}
        onConfirm={selection => { setDateOpen(false); c.changeQuery({ text: c.query.text,
          ...(selection ? { startDate: selection.date, endDate: selection.endDate } : {}) }); }} />
    </View>
  </Modal>;
}

const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#F5F9FD' }, header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 58, paddingHorizontal: 10 },
  title: { color: '#385D7E', fontSize: 18, fontWeight: '700' }, button: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 12 },
  link: { color: '#557C9F', fontSize: 14 }, form: { paddingHorizontal: 20, paddingBottom: 14 }, inputRow: { flexDirection: 'row', gap: 8 },
  input: { flex: 1, minHeight: 46, backgroundColor: '#FFF', borderRadius: 14, paddingHorizontal: 14, color: '#365775', borderWidth: 1, borderColor: '#DEEBF5' },
  search: { paddingHorizontal: 20, justifyContent: 'center', borderRadius: 14, backgroundColor: '#D8EBFA' }, searchText: { color: '#416E94', fontWeight: '700' },
  disabled: { opacity: 0.5 }, dateRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', marginTop: 9 }, date: { minHeight: 40, justifyContent: 'center', flexShrink: 1 },
  hint: { color: '#8B9BAB', fontSize: 11, marginTop: 3 }, muted: { color: '#8B9BAB', fontSize: 12 }, results: { paddingHorizontal: 20, paddingBottom: 24 },
  result: { padding: 15, marginBottom: 10, borderRadius: 16, backgroundColor: '#FFF', borderWidth: 1, borderColor: '#E3EDF5' },
  resultHeader: { flexDirection: 'row', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6, marginBottom: 8 }, author: { color: '#537492', fontWeight: '600', fontSize: 13 },
  time: { color: '#8B9BAB', fontSize: 11 }, excerpt: { color: '#38516A', fontSize: 14, lineHeight: 23 }, mark: { backgroundColor: '#FFF0BD', color: '#735721' },
  notice: { paddingHorizontal: 20, paddingBottom: 12, color: '#8D653D', fontSize: 13 }, empty: { textAlign: 'center', marginTop: 56, color: '#8B9BAB', lineHeight: 24 },
  footer: { alignItems: 'center', minHeight: 48 },
});
