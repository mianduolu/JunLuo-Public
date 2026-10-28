import { useEffect, useState } from 'react';
import { Alert, Image, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { homeImages } from '../assets/homeImages';
import type { ResolvedHeartCorpusRound } from '../chat/heartCorpus';
import { exportHeartCorpusArchive } from '../chat/heartCorpusExport';
import {
  loadResolvedHeartCorpusRounds,
  removeHeartCorpusRound,
} from '../chat/heartCorpusStore';
import { AppText as Text } from '../components/AppText';
import { colors } from '../theme/colors';
import type { Navigate } from '../types/navigation';

function formatSavedAt(timestamp: number) {
  return new Date(timestamp).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function RoundMessages({ messages }: { messages: ResolvedHeartCorpusRound['youMessages'] }) {
  return (
    <View style={styles.messageStack}>
      {messages.map((message) => (
        <Text key={message.id} style={styles.messageText}>{message.content}</Text>
      ))}
    </View>
  );
}

export function FavoritesScreen({ navigate }: { navigate: Navigate }) {
  const [rounds, setRounds] = useState<ResolvedHeartCorpusRound[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const insets = useSafeAreaInsets();

  const refresh = async () => {
    try {
      setRounds(await loadResolvedHeartCorpusRounds());
      setError(null);
    } catch {
      setError('爱心语料读取失败，请稍后再试。');
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const removeRound = (round: ResolvedHeartCorpusRound) => {
    Alert.alert('把这轮拿出篮子吗？', '它只会离开爱心语料，原来的对话还好好留在原处。', [
      { text: '取消', style: 'cancel' },
      {
        text: '拿出篮子',
        style: 'destructive',
        onPress: () => void removeHeartCorpusRound(round.replyRoundId)
          .then(() => setRounds((current) => current.filter(
            (item) => item.replyRoundId !== round.replyRoundId,
          )))
          .catch(() => setError('爱心状态保存失败，请稍后再试。')),
      },
    ]);
  };

  const exportCorpus = async () => {
    if (!rounds.length || exporting) return;
    setExporting(true);
    setError(null);
    try {
      const currentRounds = await loadResolvedHeartCorpusRounds();
      setRounds(currentRounds);
      if (!currentRounds.length) return;
      await exportHeartCorpusArchive(currentRounds);
    } catch {
      setError('爱心语料打包失败，请稍后再试。');
    } finally {
      setExporting(false);
    }
  };

  return (
    <View style={styles.page}>
      <View style={[styles.header, { height: 90 + insets.top, paddingTop: insets.top }]}>
        <Pressable accessibilityLabel="返回聊天" onPress={() => navigate('chat')} style={styles.backButton}>
          <Text style={styles.backText}>‹</Text>
        </Pressable>
        <View style={styles.heading}>
          <Text style={styles.title}>爱心语料</Text>
          <Text style={styles.subtitle}>赋予未来的你</Text>
        </View>
        <View style={styles.headerSpacer} />
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <ScrollView contentContainerStyle={styles.list} showsVerticalScrollIndicator={false}>
        {rounds.length === 0 ? (
          <View style={styles.empty}>
            <Image resizeMode="contain" source={homeImages.youPortraitNeutral} style={styles.emptyPortrait} />
            <Text style={styles.emptyTitle}>爱心篮子还是空空的</Text>
            <Text style={styles.emptyText}>在聊天里点亮一轮回复旁的 ♡，喜欢的这一轮就会落进来。</Text>
          </View>
        ) : rounds.map((round) => (
          <View key={round.replyRoundId} style={styles.card}>
            <Text style={styles.date}>
              {round.entry.firstHeartedAt === null
                ? '以前收下'
                : `收下于 ${formatSavedAt(round.entry.firstHeartedAt)}`}
            </Text>
            {round.youMessages.length ? <>
              <Text style={styles.speaker}>我说</Text>
              <RoundMessages messages={round.youMessages} />
            </> : null}
            <Text style={styles.speaker}>你说</Text>
            <RoundMessages messages={round.iMessages} />
            <Pressable onPress={() => removeRound(round)} style={styles.removeButton}>
              <Text style={styles.removeText}>拿出篮子</Text>
            </Pressable>
          </View>
        ))}
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 16) }]}>
        <Text style={styles.count}>篮子里有 {rounds.length} 轮喜欢</Text>
        <Pressable
          disabled={!rounds.length || exporting}
          onPress={() => void exportCorpus()}
          style={[styles.exportButton, (!rounds.length || exporting) && styles.exportButtonDisabled]}
        >
          <Text style={styles.exportText}>{exporting ? '正在打包' : '把爱心语料打包带走'}</Text>
        </Pressable>
        <Text style={styles.footerHint}>会把方便我慢慢看的 Markdown，和留给未来的你学习的 JSONL，一起装进压缩包。</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#F7FBFF' },
  header: {
    paddingHorizontal: 20,
    alignItems: 'center',
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#E5EFF7',
    backgroundColor: '#F6FAFF',
  },
  backButton: {
    width: 52,
    height: 52,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFFFFF',
  },
  backText: { color: colors.ink, fontSize: 42, lineHeight: 44 },
  heading: { flex: 1, alignItems: 'center', gap: 4 },
  headerSpacer: { width: 52 },
  title: { color: colors.ink, fontSize: 24 },
  subtitle: { color: '#7F95A7', fontSize: 13 },
  error: {
    marginHorizontal: 20,
    marginTop: 12,
    borderRadius: 16,
    backgroundColor: '#FFF1F0',
    paddingVertical: 9,
    paddingHorizontal: 14,
    color: '#A55E5C',
    fontSize: 13,
  },
  list: { paddingHorizontal: 20, paddingTop: 20, paddingBottom: 24, gap: 16 },
  empty: { marginTop: 72, alignItems: 'center', paddingHorizontal: 34 },
  emptyPortrait: { width: 86, height: 86, marginBottom: 16 },
  emptyTitle: { color: colors.ink, fontSize: 18, marginBottom: 9 },
  emptyText: { color: '#8397A7', fontSize: 14, lineHeight: 22, textAlign: 'center' },
  card: {
    borderRadius: 24,
    padding: 17,
    backgroundColor: '#EAF5FF',
    borderWidth: 1,
    borderColor: '#D7EAF8',
  },
  date: { color: '#7E95A7', fontSize: 12, marginBottom: 13 },
  speaker: { color: '#4F738C', fontSize: 14, marginBottom: 7, marginTop: 3 },
  messageStack: { gap: 8, marginBottom: 12 },
  messageText: {
    color: colors.ink,
    fontSize: 15,
    lineHeight: 25,
    paddingVertical: 11,
    paddingHorizontal: 13,
    borderRadius: 16,
    backgroundColor: '#FFFFFF',
  },
  removeButton: {
    alignSelf: 'flex-end',
    minHeight: 40,
    justifyContent: 'center',
    paddingHorizontal: 16,
    borderRadius: 18,
    backgroundColor: '#FFFFFF',
  },
  removeText: { color: '#7C8795', fontSize: 14 },
  footer: {
    paddingTop: 14,
    paddingHorizontal: 20,
    borderTopWidth: 1,
    borderTopColor: '#E5EFF7',
    backgroundColor: '#F6FAFF',
  },
  count: { color: colors.ink, fontSize: 15, marginBottom: 10 },
  exportButton: {
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 22,
    backgroundColor: '#B9DFFF',
  },
  exportButtonDisabled: { opacity: 0.45 },
  exportText: { color: '#426C8A', fontSize: 15 },
  footerHint: { color: '#8397A7', fontSize: 12, lineHeight: 18, marginTop: 8 },
});
