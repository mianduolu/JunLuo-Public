import React, { useEffect, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { AppText as Text, AppTextInput as TextInput } from '../components/AppText';
import { colors } from '../theme/colors';
import { theaterHistoryCard, theaterHistoryRows, theaterHistoryTime, type TheaterHistorySession } from './theaterHistorySession';
import type { TheaterStory } from './theaterStoryTypes';

function Button({ text, onPress, selected = false, disabled = false }: {
  text: string; onPress: () => void; selected?: boolean; disabled?: boolean;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={text} accessibilityState={{ selected, disabled }}
    disabled={disabled} onPress={onPress} style={[styles.button, selected && styles.selected, disabled && styles.disabled]}>
    <Text style={styles.buttonText}>{text}</Text>
  </Pressable>;
}

// List body only. The setup page remains responsible for safe areas, scrolling,
// editing, rename/delete confirmations and unsaved-buffer navigation.
export function TheaterHistoryPanel({ session, onNew, onSelectStory, onEditStory, onRenameStory, renderHistoryActions }: {
  session: TheaterHistorySession; onNew: () => void;
  onSelectStory: (story: TheaterStory) => void; onEditStory: (story: TheaterStory) => void;
  onRenameStory: (story: TheaterStory) => void; renderHistoryActions?: (storyId: string) => React.ReactNode;
}) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  useEffect(() => { void session.refresh(); }, [session]);
  const rows = theaterHistoryRows(state);
  const ready = !state.loading && !state.loadError;
  const empty = ready && !rows.length;
  return <View style={styles.content}>
    <View style={styles.buttons}>
      {([['all', '全部'], ['drafts', '草稿'], ['unread', '有新回复']] as const).map(([filter, text]) =>
        <Button key={filter} text={text} selected={state.filter === filter} onPress={() => session.setFilter(filter)} />)}
    </View>
    <TextInput accessibilityLabel="搜索标题或世界设定" placeholder="搜索标题或世界设定" value={state.query}
      onChangeText={(query) => session.setQuery(query)} style={styles.input} />
    {state.loading && <Text style={styles.muted}>正在读取…</Text>}
    {state.loadError && <View style={styles.content}>
      <Text accessibilityLiveRegion="polite" style={styles.muted}>暂时无法读取小剧场历史。</Text>
      <Button text="重试" onPress={() => { void session.refresh(); }} />
    </View>}
    {state.pinError && <View style={styles.content}>
      <Text accessibilityLiveRegion="polite" style={styles.muted}>没能保存置顶设置，请重试。</Text>
      <Button text="重试" disabled={!!state.pinning} onPress={() => { void session.retryPin(); }} />
    </View>}
    {empty && <Text style={styles.muted}>{state.query.trim() ? '没有符合条件的小剧场。'
      : state.filter === 'drafts' ? '还没有设定草稿。' : state.filter === 'unread' ? '暂时没有未读回复。'
        : '还没有小剧场。先写下设定，再开始一段故事。'}</Text>}
    {empty && !!state.query.trim() && <Button text="清空搜索" onPress={() => session.setQuery('')} />}
    <Button text="新建小剧场" disabled={!ready} onPress={onNew} />
    {!state.loadError && rows.map((entry) => {
      const { story } = entry;
      const card = theaterHistoryCard(entry, state.local);
      return <View key={story.id} style={styles.card}>
        <Pressable accessibilityRole="button" onPress={() => onSelectStory(story)}>
          <View style={styles.titleRow}>
            <Text style={styles.cardTitle}>{story.title}</Text>
            {card.unread && <View accessibilityLabel="有新回复" style={styles.unread} />}
          </View>
          <Text style={styles.muted}>{card.detail}</Text>
          <Text style={styles.muted}>最近活动：{theaterHistoryTime(story.updatedAt)}</Text>
          {card.generating && <Text style={styles.muted}>正在生成…</Text>}
        </Pressable>
        <View style={styles.buttons}>
          <Button text={story.isDraft ? '继续填写' : '设定'} onPress={() => onEditStory(story)} />
          <Button text="更改小剧场名称" onPress={() => onRenameStory(story)} />
          <Button text={story.isPinned ? '取消置顶' : '置顶'} disabled={!!state.pinning || state.loading}
            onPress={() => { void session.setPinned(story.id, !story.isPinned); }} />
        </View>
        {renderHistoryActions?.(story.id)}
      </View>;
    })}
  </View>;
}

const styles = StyleSheet.create({
  content: { gap: 12 }, buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  input: { minHeight: 46, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12,
    fontSize: 15, color: colors.ink, backgroundColor: colors.cardStrong, borderWidth: 1, borderColor: colors.border },
  button: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 14, paddingVertical: 10,
    borderRadius: 14, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border },
  buttonText: { color: colors.ink, fontSize: 14 }, selected: { backgroundColor: colors.secondary }, disabled: { opacity: 0.5 },
  card: { padding: 16, gap: 12, backgroundColor: colors.card, borderRadius: 18 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cardTitle: { fontSize: 16, fontWeight: '600', color: colors.ink, flexShrink: 1, marginBottom: 6 },
  muted: { fontSize: 13, lineHeight: 21, color: colors.muted },
  unread: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.ink },
});
