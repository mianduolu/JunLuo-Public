import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { AppText as Text } from '../components/AppText';
import {
  pauseMemoryDuplicateCleanup,
  previewMemoryDuplicateCleanup,
  startOrResumeMemoryDuplicateCleanup,
  type MemoryDuplicateCleanupPreview,
} from '../memory/memoryDuplicateCleanup';
import {
  loadMemoryDuplicateCleanupJournal,
  subscribeMemoryDuplicateCleanupJournal,
  type MemoryDuplicateCleanupJournalV1,
} from '../memory/memoryDuplicateCleanupState';
import { colors } from '../theme/colors';
import type { Navigate } from '../types/navigation';

function remainingCandidates(
  journal: MemoryDuplicateCleanupJournalV1 | null,
  preview: MemoryDuplicateCleanupPreview | null,
) {
  if (!journal || ['complete', 'failed-restored'].includes(journal.phase)) {
    return preview?.candidates ?? 0;
  }
  return Math.max(0, journal.totalCandidates - journal.processedCandidates);
}

export function MemoryDuplicateCleanupScreen({ navigate }: { navigate: Navigate }) {
  const [journal, setJournal] = useState<MemoryDuplicateCleanupJournalV1 | null>(null);
  const [preview, setPreview] = useState<MemoryDuplicateCleanupPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextPreview, nextJournal] = await Promise.all([
        previewMemoryDuplicateCleanup(),
        loadMemoryDuplicateCleanupJournal(),
      ]);
      setPreview(nextPreview);
      setJournal(nextJournal);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'memory-cleanup-preview-failed');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    return subscribeMemoryDuplicateCleanupJournal(setJournal);
  }, []);

  const beginCleanup = () => {
    const count = remainingCandidates(journal, preview);
    Alert.alert(
      '开始清理重复记忆？',
      `本次预计整理 ${count} 条精确重复的自动生活状态记忆。君落会先创建本机回退副本，再分批处理。`,
      [
        { text: '先不处理', style: 'cancel' },
        {
          text: '开始清理',
          onPress: () => {
            setLoading(true);
            setError(null);
            void startOrResumeMemoryDuplicateCleanup()
              .then((nextJournal) => {
                setJournal(nextJournal);
                setPreview((current) => current ? {
                  ...current,
                  candidates: Math.max(
                    0,
                    nextJournal.totalCandidates - nextJournal.processedCandidates,
                  ),
                  lifecycleEvents: Math.max(
                    0,
                    current.lifecycleEvents - nextJournal.deletedLifecycleEvents,
                  ),
                  skipped: nextJournal.skippedCandidates,
                } : current);
              })
              .catch((caught) => {
                setError(caught instanceof Error ? caught.message : 'memory-cleanup-run-failed');
              })
              .finally(() => setLoading(false));
          },
        },
      ],
    );
  };

  const count = remainingCandidates(journal, preview);
  const blocked = journal?.phase === 'recovery-blocked';
  const running = journal?.phase === 'cleaning';
  const paused = journal?.phase === 'paused';

  return (
    <View style={styles.page}>
      <View style={styles.header}>
        <Pressable
          accessibilityLabel="返回设置"
          onPress={() => navigate('settings')}
          style={styles.backButton}
        >
          <Text style={styles.backText}>‹</Text>
        </Pressable>
        <Text style={styles.title}>清理重复记忆</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Text style={styles.intro}>这里只加载清理数字和进度书签，不会先把整本记忆正文留在页面内存里。</Text>
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <View style={styles.cardCopy}>
              <Text style={styles.cardTitle}>清理重复记忆</Text>
              <Text style={styles.detail}>
                君落会保留每种自动生活状态最早的一份，并整理其余重复记录。聊天、手写记忆和不同事件不会参与。
              </Text>
            </View>
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{loading && !preview ? '检查中' : `${count} 条`}</Text>
            </View>
          </View>

          {running ? (
            <Text style={styles.progress}>
              正在整理重复记忆 · {journal.processedCandidates}/{journal.totalCandidates}
            </Text>
          ) : paused ? (
            <Text style={styles.progress}>
              已经安全停在 {journal.processedCandidates}/{journal.totalCandidates}，可以继续。
            </Text>
          ) : journal?.phase === 'compacting' ? (
            <Text style={styles.progress}>正在压缩记忆数据库</Text>
          ) : journal?.phase === 'publishing' || journal?.phase === 'waiting-windows' ? (
            <Text style={styles.progress}>本机重复记忆已经整理完成，删除结果正在分批送往电脑。</Text>
          ) : blocked ? (
            <Text style={styles.error}>回退没有完成，记忆写入和同步仍保持暂停。</Text>
          ) : (
            <Text style={styles.summary}>
              {preview
                ? `预计同时整理 ${preview.lifecycleEvents} 条孤立创建流水；跳过 ${preview.skipped} 条受保护或有关联的记录。`
                : '先只读检查，不会自动删除。'}
            </Text>
          )}

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <View style={styles.actions}>
            <Pressable
              accessibilityLabel="重新检查"
              disabled={loading || running}
              onPress={() => void refresh()}
              style={[styles.secondaryButton, (loading || running) && styles.disabled]}
            >
              <Text style={styles.secondaryText}>重新检查</Text>
            </Pressable>
            {running ? (
              <Pressable
                accessibilityLabel="先停一下"
                onPress={() => void pauseMemoryDuplicateCleanup()}
                style={styles.pauseButton}
              >
                <Text style={styles.pauseText}>先停一下</Text>
              </Pressable>
            ) : (
              <Pressable
                accessibilityLabel={paused ? '继续清理' : '开始清理'}
                disabled={loading || blocked || (!paused && count === 0)}
                onPress={beginCleanup}
                style={[
                  styles.primaryButton,
                  (loading || blocked || (!paused && count === 0)) && styles.disabled,
                ]}
              >
                <Text style={styles.primaryText}>{paused ? '继续清理' : '开始清理'}</Text>
              </Pressable>
            )}
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
    paddingTop: 18,
    paddingHorizontal: 18,
    backgroundColor: '#F7FBFA',
  },
  header: {
    height: 58,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 18,
  },
  backButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#FFE2DA',
  },
  backText: {
    color: colors.ink,
    fontSize: 32,
    lineHeight: 34,
  },
  title: {
    color: colors.ink,
    fontSize: 27,
    fontWeight: '800',
  },
  headerSpacer: {
    width: 44,
    height: 44,
  },
  content: {
    paddingBottom: 32,
  },
  intro: {
    color: colors.muted,
    fontSize: 16,
    lineHeight: 24,
    marginBottom: 16,
  },
  card: {
    padding: 18,
    borderRadius: 22,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#DCEBE8',
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  cardCopy: {
    flex: 1,
    minWidth: 0,
  },
  cardTitle: {
    color: colors.ink,
    fontSize: 21,
    fontWeight: '800',
    marginBottom: 8,
  },
  detail: {
    color: colors.muted,
    fontSize: 16,
    lineHeight: 24,
  },
  badge: {
    marginLeft: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 16,
    backgroundColor: '#EEF8F6',
  },
  badgeText: {
    color: '#527975',
    fontSize: 14,
    fontWeight: '800',
  },
  progress: {
    color: '#527975',
    fontSize: 16,
    lineHeight: 24,
    marginTop: 18,
    fontWeight: '700',
  },
  summary: {
    color: colors.muted,
    fontSize: 15,
    lineHeight: 23,
    marginTop: 18,
  },
  error: {
    color: '#A64848',
    fontSize: 15,
    lineHeight: 22,
    marginTop: 14,
  },
  actions: {
    flexDirection: 'row',
    marginTop: 20,
  },
  secondaryButton: {
    minHeight: 48,
    paddingHorizontal: 18,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#CFE3DF',
    backgroundColor: '#FFFFFF',
    marginRight: 12,
  },
  secondaryText: {
    color: '#527975',
    fontSize: 16,
    fontWeight: '800',
  },
  primaryButton: {
    minHeight: 48,
    paddingHorizontal: 20,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primary,
  },
  primaryText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '800',
  },
  pauseButton: {
    minHeight: 48,
    paddingHorizontal: 20,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFF0ED',
  },
  pauseText: {
    color: '#A64848',
    fontSize: 16,
    fontWeight: '800',
  },
  disabled: {
    opacity: 0.45,
  },
});
