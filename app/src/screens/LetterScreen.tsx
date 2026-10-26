import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { paginateNotebook } from '../letters/notebookPagination';
import { NotebookSourceExcerpt } from '../letters/NotebookSourceExcerpt';
import { NotebookManagement } from '../letters/NotebookManagement';
import { WishPoolPanel } from '../wishPool/WishPoolPanel';
import { GiftCabinetPanel } from '../gifts/GiftCabinetPanel';

import { useAiConfigPreferences } from '../ai/AiConfigPreferences';
import { recordGlobalInteraction } from '../ai/globalCognition';
import {
  canCommitBackupRestoreDataEpoch,
  captureBackupRestoreDataEpoch,
  runBackupRestoreDataEpochCommit,
} from '../backup/backupRestoreCoordinator';
import { runBackupProtectedTask } from '../backup/backupService';
import {
  loadKeywordCounterSnapshot,
  type KeywordCounterSnapshot,
  type KeywordCounterTask,
} from '../chat/keywordCounterStore';
import {
  deleteNotebookEntry,
  loadNotebookSnapshot,
  markNotebookEntryRead,
  migrateKeywordCountersToNotebook,
  savePendingNotebookInteraction,
  type NotebookEntry,
  type NotebookSnapshot,
} from '../chat/notebookStore';
import { AppText as Text, AppTextInput as TextInput } from '../components/AppText';
import { persistDeliveredLetterContext, persistOpenedFutureLetterContext } from '../letters/letterContext';
import { deliverDueLetters } from '../letters/letterDelivery';
import { cancelLetterNotification, scheduleLetterDueNotification } from '../letters/letterNotifications';
import {
  clampReplyDelayHours,
  createUserLetter,
  deleteLetter,
  getMailboxLock,
  loadLetters,
  loadLetterSettings,
  openFutureLetter,
  replyToAiLetter,
  type LetterEntry,
  type MailboxLock,
} from '../letters/letterStore';
import { colors } from '../theme/colors';
import { BaiyunPostsPanel } from '../posts/BaiyunPostsPanel';
import { usePostUnreadNotice } from '../posts/usePostUnreadNotice';
import { consumeCorrespondenceTab, subscribeBaiyunPosts } from '../posts/baiyunPostStore';
import type { Navigate } from '../types/navigation';

type Props = {
  navigate: Navigate;
};

const LETTER_PREVIEW_LIMIT = 260;

type LetterFilter = 'all' | 'needs_me' | 'waiting' | 'future' | 'done';
type CorrespondenceTab = 'posts' | 'letters' | 'notebook' | 'wish-pool' | 'gifts';
const CORRESPONDENCE_TABS = [
  { key: 'posts' as const, title: '白云苍狗', description: '动态、评论和两小只的日常' },
  { key: 'letters' as const, title: '信件', description: '来信、回信和未来信' },
  { key: 'notebook' as const, title: '白云小本本', description: '查看白云小本本' },
  { key: 'wish-pool' as const, title: '许愿池', description: '许愿币与两小只的愿望簿' },
  { key: 'gifts' as const, title: '礼物柜', description: '礼物、原件和回音' },
];

async function deliverDueLettersProtected(
  options: Parameters<typeof deliverDueLetters>[0],
  dataEpoch?: number | null,
) {
  const preflight = await runBackupProtectedTask(async () => true);
  if (!preflight.ran) return null;
  if (
    dataEpoch !== undefined
    && !canCommitBackupRestoreDataEpoch(dataEpoch)
  ) return null;
  return deliverDueLetters({
    ...options,
    dataEpoch,
  });
}

function isLetterWaiting(letter: LetterEntry) {
  return letter.status === 'waiting_ai' || letter.status === 'failed' || letter.status === 'sealed';
}

function letterDirectionText(letter: LetterEntry) {
  if (letter.kind === 'future-self') return '未来信';
  if (letter.direction === 'you-to-ai') return '寄给白云';
  return '白云来信';
}

function letterPreviewText(content: string, expanded: boolean) {
  if (expanded || content.length <= LETTER_PREVIEW_LIMIT) return content;
  return `${content.slice(0, LETTER_PREVIEW_LIMIT).trim()}...`;
}

function formatDateTime(timestamp?: number) {
  if (!timestamp) return '';
  return new Date(timestamp).toLocaleString('zh-CN', {
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function formatRemaining(timestamp?: number) {
  if (!timestamp) return '';
  const remainingMs = timestamp - Date.now();
  if (remainingMs <= 0) return '已经到时间了';
  const minutes = Math.ceil(remainingMs / 60000);
  if (minutes < 60) return `${minutes} 分钟后`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest ? `${hours} 小时 ${rest} 分钟后` : `${hours} 小时后`;
  const days = Math.floor(hours / 24);
  const hourRest = hours % 24;
  return hourRest ? `${days} 天 ${hourRest} 小时后` : `${days} 天后`;
}

function statusText(letter: LetterEntry) {
  if (letter.status === 'waiting_ai') return `等白云小姐回信 · ${formatRemaining(letter.dueAt)}`;
  if (letter.status === 'waiting_user') return '白云小姐在等你的回信';
  if (letter.status === 'sealed') return `封存中 · ${formatRemaining(letter.dueAt)}`;
  if (letter.status === 'ready_to_open') return '可以拆开了';
  if (letter.status === 'failed') return '回信失败，可以重试';
  return letter.kind === 'future-self' ? '已拆开' : '已完成';
}

function counterStatusText(task: KeywordCounterTask) {
  if (task.status === 'disabled') return '已停用';
  if (task.status === 'completed') return '已完成';
  return '记录中';
}

function counterMetaText(task: KeywordCounterTask) {
  const target = task.type === 'nth_occurrence' && task.targetCount ? ` / ${task.targetCount}` : '';
  return `${task.count}${target} 次 · ${task.keywords.map((keyword) => `“${keyword}”`).join('、')}`;
}

function notebookSourceText(entry: NotebookEntry) {
  if (entry.sourceType === 'keyword_counter') return '旧页归档';
  if (entry.sourceType === 'assistant_hidden_request' || entry.sourceType === 'assistant_inner_reaction') {
    return '白云偷偷写下';
  }
  if (entry.sourceType === 'interaction') return '互动小纸条';
  return '小本本';
}

function notebookKeywordText(entry: NotebookEntry) {
  return entry.keywords.map((keyword) => `“${keyword}”`).join('、');
}

export function LetterScreen({ navigate }: Props) {
  const postUnread = usePostUnreadNotice();
  const insets = useSafeAreaInsets();
  const [activeTab, setActiveTab] = useState<CorrespondenceTab>('posts');
  const [drawerVisible, setDrawerVisible] = useState(false);
  const {
    chatConnection,
    chatKey,
    memoryOrganizerConnection,
    memoryOrganizerKey,
    profile,
  } = useAiConfigPreferences();
  const [letters, setLetters] = useState<LetterEntry[]>([]);
  const [keywordCounterSnapshot, setKeywordCounterSnapshot] = useState<KeywordCounterSnapshot | null>(null);
  const [notebookSnapshot, setNotebookSnapshot] = useState<NotebookSnapshot | null>(null);
  const [lock, setLock] = useState<MailboxLock>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [delayHours, setDelayHours] = useState(4);
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [expandedLetterIds, setExpandedLetterIds] = useState<Record<string, boolean>>({});
  const [letterFilter, setLetterFilter] = useState<LetterFilter>('all');
  const [notebookExpanded, setNotebookExpanded] = useState(false);
  const [notebookPageIndex, setNotebookPageIndex] = useState(0);
  const correspondenceScroll = useRef<ScrollView>(null);
  const refreshVersion = useRef(0);
  const configured = !!chatConnection?.baseUrl.trim() && !!chatConnection?.model.trim() && !!chatKey.trim();
  const canWrite = !lock;

  useEffect(() => {
    let mounted = true;
    const consumeTab = () => {
      void consumeCorrespondenceTab().then((tab) => {
        if (mounted && tab) setActiveTab(tab);
      }).catch(() => undefined);
    };
    const unsubscribe = subscribeBaiyunPosts(consumeTab);
    consumeTab();
    return () => { mounted = false; unsubscribe(); };
  }, []);

  const continuationAi = useMemo(
    () =>
      memoryOrganizerConnection && memoryOrganizerKey.trim()
        ? { apiKey: memoryOrganizerKey, connection: memoryOrganizerConnection }
        : undefined,
    [memoryOrganizerConnection, memoryOrganizerKey],
  );

  const refresh = async (dataEpoch = captureBackupRestoreDataEpoch()) => {
    if (dataEpoch === null) return false;
    const version = ++refreshVersion.current;
    const loaded = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
      await migrateKeywordCountersToNotebook().catch(() => undefined);
      return Promise.all([
        loadLetters(),
        getMailboxLock(),
        loadKeywordCounterSnapshot(),
        loadNotebookSnapshot(),
      ]);
    });
    if (!loaded.committed || !canCommitBackupRestoreDataEpoch(dataEpoch) || version !== refreshVersion.current) return false;
    const [nextLetters, nextLock, nextCounters, nextNotebook] = loaded.value;
    setLetters(nextLetters);
    setLock(nextLock);
    setKeywordCounterSnapshot(nextCounters);
    setNotebookSnapshot(nextNotebook);
    return true;
  };

  const notebookManagementChanged = (counters: KeywordCounterSnapshot, notebook: NotebookSnapshot) => {
    refreshVersion.current += 1;
    setKeywordCounterSnapshot(counters);
    setNotebookSnapshot(notebook);
  };

  useEffect(() => {
    if (activeTab === 'posts' || activeTab === 'gifts') return;
    let mounted = true;
    setLoading(true);
    setLoadError(false);
    const load = async () => {
      const dataEpoch = captureBackupRestoreDataEpoch();
      if (dataEpoch === null) {
        if (mounted) { setLoadError(true); setLoading(false); }
        return;
      }
      let localReadComplete = false;
      try {
        const settings = await loadLetterSettings();
        if (!mounted || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
        setDelayHours(settings.defaultReplyDelayHours);
        const refreshed = await refresh(dataEpoch);
        if (!mounted || !canCommitBackupRestoreDataEpoch(dataEpoch) || !refreshed) return;
        localReadComplete = true;
        setLoading(false);
        if (activeTab === 'letters') {
          await deliverDueLettersProtected({
            apiKey: chatKey,
            connection: chatConnection,
            memoryOrganizerConnection,
            memoryOrganizerKey,
            profile,
          }, dataEpoch).catch(() => null);
          if (mounted && canCommitBackupRestoreDataEpoch(dataEpoch)) await refresh(dataEpoch);
        }
      } catch {
        if (!localReadComplete && mounted && canCommitBackupRestoreDataEpoch(dataEpoch)) {
          setLoadError(true);
          setLoading(false);
        }
      }
    };
    void load();
    const intervalId = activeTab === 'letters' ? setInterval(() => {
      const dataEpoch = captureBackupRestoreDataEpoch();
      if (dataEpoch === null) return;
      void deliverDueLettersProtected({
        apiKey: chatKey,
        connection: chatConnection,
        memoryOrganizerConnection,
        memoryOrganizerKey,
        profile,
      }, dataEpoch).then(async () => {
        const refreshed = await refresh(dataEpoch);
        if (mounted && refreshed && canCommitBackupRestoreDataEpoch(dataEpoch)) {
          setLoadError(false);
          setLoading(false);
        }
      }).catch(() => undefined);
    }, 60 * 1000) : null;
    return () => {
      mounted = false;
      if (intervalId !== null) clearInterval(intervalId);
    };
  }, [activeTab, chatConnection, chatKey, memoryOrganizerConnection, memoryOrganizerKey, profile, loadAttempt]);

  const sendLetter = async () => {
    const text = content.trim();
    if (!text || busy || !canWrite) return;
    const dataEpoch = captureBackupRestoreDataEpoch();
    if (dataEpoch === null) return;
    setBusy(true);
    try {
      const created = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
        const letter = await createUserLetter({
          content: text,
          delayHours,
          title,
        });
        await recordGlobalInteraction('letter', letter.createdAt).catch(() => undefined);
        return letter;
      });
      if (!created.committed) return;
      const letter = created.value;
      await runBackupRestoreDataEpochCommit(dataEpoch, () => persistDeliveredLetterContext(letter, { dataEpoch }))
        .catch(() => undefined);
      await scheduleLetterDueNotification(letter, { dataEpoch }).catch(() => null);
      if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      setContent('');
      setTitle('');
      await refresh(dataEpoch).catch(() => undefined);
    } catch {
      Alert.alert('还不能寄信', '现在有一封普通信还没有完成，等这一封回完再写下一封。');
    } finally {
      setBusy(false);
    }
  };

  const retryLetter = async () => {
    if (!configured || busy) {
      Alert.alert('还不能回信', '请先在“白云与连接”里配置并测试模型连接。');
      return;
    }
    const dataEpoch = captureBackupRestoreDataEpoch();
    if (dataEpoch === null) return;
    setBusy(true);
    try {
      await deliverDueLettersProtected({
        apiKey: chatKey,
        connection: chatConnection,
        memoryOrganizerConnection,
        memoryOrganizerKey,
        now: Date.now() + 1,
        profile,
      }, dataEpoch);
      if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      await refresh(dataEpoch);
    } finally {
      setBusy(false);
    }
  };

  const replyToLetter = async (letter: LetterEntry) => {
    const text = replyDrafts[letter.id]?.trim();
    if (!text || busy) return;
    const dataEpoch = captureBackupRestoreDataEpoch();
    if (dataEpoch === null) return;
    setBusy(true);
    try {
      const replied = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
        const completed = await replyToAiLetter(letter.id, text);
        if (completed) {
          await recordGlobalInteraction('letter', completed.completedAt ?? Date.now())
            .catch(() => undefined);
        }
        return completed;
      });
      if (!replied.committed) return;
      const completed = replied.value;
      if (completed) {
        const persisted = await runBackupRestoreDataEpochCommit(dataEpoch, () => (
          persistDeliveredLetterContext(completed, { continuationAi, dataEpoch })
        )).catch(() => null);
        if (persisted && !persisted.committed) return;
      }
      if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      setReplyDrafts((current) => ({ ...current, [letter.id]: '' }));
      await refresh(dataEpoch);
    } finally {
      setBusy(false);
    }
  };

  const openFuture = async (letter: LetterEntry) => {
    if (busy) return;
    const dataEpoch = captureBackupRestoreDataEpoch();
    if (dataEpoch === null) return;
    setBusy(true);
    try {
      const openedCommit = await runBackupRestoreDataEpochCommit(dataEpoch, () => (
        openFutureLetter(letter.id)
      ));
      if (!openedCommit.committed) return;
      const opened = openedCommit.value;
      if (opened) {
        const persisted = await runBackupRestoreDataEpochCommit(dataEpoch, () => (
          persistOpenedFutureLetterContext(opened, { continuationAi, dataEpoch })
        )).catch(() => null);
        if (persisted && !persisted.committed) return;
      }
      if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      await refresh(dataEpoch);
    } finally {
      setBusy(false);
    }
  };

  const removeLetter = async (letter: LetterEntry) => {
    if (busy) return;
    const dataEpoch = captureBackupRestoreDataEpoch();
    if (dataEpoch === null) return;
    setBusy(true);
    try {
      const deleted = await runBackupRestoreDataEpochCommit(
        dataEpoch,
        () => deleteLetter(letter.id),
      );
      if (!deleted.committed || !deleted.value) return;
      await cancelLetterNotification(deleted.value);
      if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      setReplyDrafts((current) => {
        const next = { ...current };
        delete next[letter.id];
        return next;
      });
      setExpandedLetterIds((current) => {
        const next = { ...current };
        delete next[letter.id];
        return next;
      });
      await refresh(dataEpoch);
    } finally {
      setBusy(false);
    }
  };

  const confirmDeleteLetter = (letter: LetterEntry) => {
    const titleText = letter.status === 'waiting_ai' || letter.status === 'failed'
      ? '取消并删除这封信吗？'
      : '删除这封信吗？';
    Alert.alert(titleText, `“${letter.title}”会从往来页移除。已经写进聊天或记忆里的内容不会被连带清掉。`, [
      { text: '先留着', style: 'cancel' },
      {
        onPress: () => {
          void removeLetter(letter);
        },
        style: 'destructive',
        text: '删除',
      },
    ]);
  };

  const toggleLetterExpanded = (letterId: string) => {
    setExpandedLetterIds((current) => ({ ...current, [letterId]: !current[letterId] }));
  };

  const needsMeCount = letters.filter((letter) => letter.status === 'waiting_user' || letter.status === 'ready_to_open').length;
  const waitingCount = letters.filter((letter) => letter.status === 'waiting_ai' || letter.status === 'failed').length;
  const futureCount = letters.filter((letter) => letter.kind === 'future-self').length;
  const doneCount = letters.filter((letter) => letter.status === 'completed').length;
  const filterOptions: Array<{ count: number; key: LetterFilter; label: string }> = [
    { count: letters.length, key: 'all', label: '全部' },
    { count: needsMeCount, key: 'needs_me', label: '等我' },
    { count: waitingCount, key: 'waiting', label: '等白云' },
    { count: futureCount, key: 'future', label: '未来信' },
    { count: doneCount, key: 'done', label: '完成' },
  ];
  const visibleLetters = letters.filter((letter) => {
    if (letterFilter === 'needs_me') return letter.status === 'waiting_user' || letter.status === 'ready_to_open';
    if (letterFilter === 'waiting') return letter.status === 'waiting_ai' || letter.status === 'failed';
    if (letterFilter === 'future') return letter.kind === 'future-self';
    if (letterFilter === 'done') return letter.status === 'completed';
    return true;
  });

  const notebookEntries = notebookSnapshot?.entries ?? [];
  const counterTasks = keywordCounterSnapshot?.tasks ?? [];
  const recentCounterTasks = counterTasks.slice().reverse().slice(0, 3);
  const activeCounterCount = counterTasks.filter((task) => task.status === 'active').length;
  const latestNotebookEntry = notebookEntries[0];
  const notebookPage = paginateNotebook(notebookEntries, notebookPageIndex);
  const unreadNotebookCount = notebookEntries.filter((entry) => !entry.readAt).length;

  useEffect(() => {
    setNotebookPageIndex(notebookPage.pageIndex);
  }, [notebookPage.pageIndex]);

  const markNotebookPageRead = (entries: NotebookEntry[]) => {
    const unreadPageEntries = entries.filter((entry) => !entry.readAt);
    if (!unreadPageEntries.length) return;
    const dataEpoch = captureBackupRestoreDataEpoch();
    if (dataEpoch === null) return;
    void (async () => {
      const marked = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
        for (const entry of unreadPageEntries) {
          await markNotebookEntryRead(entry.id);
        }
      });
      if (!marked.committed || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      await refresh(dataEpoch);
    })().catch(() => undefined);
  };

  const toggleNotebookExpanded = () => {
    const nextExpanded = !notebookExpanded;
    setNotebookExpanded(nextExpanded);
    if (nextExpanded) markNotebookPageRead(notebookPage.entries);
  };

  const turnNotebookPage = (requestedPage: number) => {
    const nextPage = paginateNotebook(notebookEntries, requestedPage);
    setNotebookPageIndex(nextPage.pageIndex);
    markNotebookPageRead(nextPage.entries);
    correspondenceScroll.current?.scrollTo({ y: 0, animated: false });
  };

  const confirmDeleteNotebookEntry = (entry: NotebookEntry) => {
    Alert.alert('删掉这页小本本吗？', `“${entry.title}”删掉后就不会再显示了。`, [
      { text: '先留着', style: 'cancel' },
      {
        onPress: () => {
          const dataEpoch = captureBackupRestoreDataEpoch();
          if (dataEpoch === null) return;
          void (async () => {
            const deleted = await runBackupRestoreDataEpochCommit(
              dataEpoch,
              () => deleteNotebookEntry(entry.id),
            );
            if (!deleted.committed || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
            await refresh(dataEpoch);
          })().catch(() => undefined);
        },
        style: 'destructive',
        text: '删除',
      },
    ]);
  };

  const openNotebookEntryInChat = async (entry: NotebookEntry) => {
    const dataEpoch = captureBackupRestoreDataEpoch();
    if (dataEpoch === null) return;
    const handoffCommit = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
      const handoff = await savePendingNotebookInteraction(entry.id);
      if (!handoff) return null;
      await markNotebookEntryRead(entry.id).catch(() => undefined);
      return handoff;
    }).catch(() => null);
    if (!handoffCommit) {
      if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      Alert.alert('这页暂时翻不过去', '小本本刚刚没找到这一页，回到信箱刷新一下再试试。');
      return;
    }
    if (!handoffCommit.committed || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
    if (!handoffCommit.value) {
      Alert.alert('这页暂时翻不过去', '小本本刚刚没找到这一页，回到信箱刷新一下再试试。');
      return;
    }
    navigate('chat');
  };

  return (
    <View style={[styles.page, { paddingTop: Math.max(insets.top + 18, 42) }]}>
      {activeTab !== 'posts' && activeTab !== 'gifts' ? <View style={styles.header}>
        <Pressable accessibilityRole="button" accessibilityLabel="打开往来侧边栏" onPress={() => setDrawerVisible(true)} style={styles.backButton}>
          <Text style={styles.menuText}>☰</Text>
        </Pressable>
        <View style={styles.headerCopy}>
          <Text style={styles.title}>往来</Text>
          <Text style={styles.subtitle}>
            {activeTab !== 'letters' ? CORRESPONDENCE_TABS.find(tab => tab.key === activeTab)?.title : lock
              ? lock.reason === 'waiting_ai'
                ? '我正在慢慢回信'
                : '我在等你回信'
              : '信、纸条和以后收到的礼物'}
          </Text>
        </View>
      </View> : null}
      {activeTab === 'posts' ? <BaiyunPostsPanel covered={drawerVisible} onOpenDrawer={() => setDrawerVisible(true)} /> : activeTab === 'gifts' ? <GiftCabinetPanel covered={drawerVisible} onOpenDrawer={() => setDrawerVisible(true)} /> : activeTab === 'wish-pool' ? <WishPoolPanel covered={drawerVisible} onOpenChat={() => navigate('chat')} /> : loading ? (
        <View style={styles.loadingPage}><ActivityIndicator color="#6F98BB" /></View>
      ) : loadError ? (
        <View style={styles.loadingPage}>
          <Text>本地记录暂未读取完成</Text>
          <Pressable onPress={() => setLoadAttempt(attempt => attempt + 1)} style={styles.retryButton}>
            <Text style={styles.retryText}>重新读取</Text>
          </Pressable>
        </View>
      ) : (
      <ScrollView ref={correspondenceScroll} key={activeTab} contentContainerStyle={[styles.content, { paddingBottom: Math.max(32, insets.bottom + 20) }]} keyboardShouldPersistTaps="handled">
        {activeTab === 'letters' ? <>
        <View style={styles.summaryPanel}>
          <Text style={styles.summaryText}>
            {lock ? statusText(lock.letter) : letters.length ? '这些信都好好收在这里。' : '这里还在等第一封往来。'}
          </Text>
          <View style={styles.summaryStats}>
            <View style={styles.summaryStat}>
              <Text style={styles.summaryStatValue}>{needsMeCount}</Text>
              <Text style={styles.summaryStatLabel}>等我</Text>
            </View>
            <View style={styles.summaryStat}>
              <Text style={styles.summaryStatValue}>{waitingCount}</Text>
              <Text style={styles.summaryStatLabel}>等白云</Text>
            </View>
            <View style={styles.summaryStat}>
              <Text style={styles.summaryStatValue}>{futureCount}</Text>
              <Text style={styles.summaryStatLabel}>未来信</Text>
            </View>
          </View>
        </View>

        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterRow}>
          {filterOptions.map((option) => (
            <Pressable
              key={option.key}
              onPress={() => setLetterFilter(option.key)}
              style={[styles.filterChip, letterFilter === option.key && styles.filterChipActive]}
            >
              <Text style={[styles.filterText, letterFilter === option.key && styles.filterTextActive]}>
                {option.label} {option.count}
              </Text>
            </Pressable>
          ))}
        </ScrollView>

        </> : null}

        {activeTab === 'notebook' ? (
        <>
        <View style={styles.notebookPanel}>
          <View style={styles.notebookHeader}>
            <View style={styles.notebookTitleBlock}>
              <Text style={styles.notebookEyebrow}>白云小本本</Text>
              <Text style={styles.notebookTitle}>翻翻白云偷偷记下来的小纸条</Text>
            </View>
            <View style={styles.notebookActions}>
              <View style={styles.notebookBadge}>
                <Text style={styles.notebookBadgeText}>{notebookEntries.length}</Text>
              </View>
              <Pressable onPress={toggleNotebookExpanded} style={styles.notebookToggle}>
                <Text style={styles.notebookToggleText}>{notebookExpanded ? '收起' : '翻翻'}</Text>
              </Pressable>
            </View>
          </View>
          <Text style={styles.notebookSummary}>
            {activeCounterCount
              ? `有 ${activeCounterCount} 条关键词正在记录中。`
              : '现在没有正在计数的关键词。'}
            {latestNotebookEntry ? ` 最近一笔：${latestNotebookEntry.title}` : ' 白云还没写下新的小纸条。'}
            {unreadNotebookCount ? ` 还有 ${unreadNotebookCount} 页没翻过。` : ''}
          </Text>
          {notebookExpanded ? (
            <View style={styles.notebookEntryList}>
              {notebookPage.entries.length ? (
                notebookPage.entries.map((entry) => {
                  const keywordText = notebookKeywordText(entry);
                  const archived = entry.sourceType === 'keyword_counter';
                  return (
                    <Pressable
                      key={entry.id}
                      onPress={() => void openNotebookEntryInChat(entry)}
                      style={[styles.notebookEntryCard, archived && styles.notebookEntryCardArchived]}
                    >
                      <View style={styles.notebookEntryTop}>
                        <View style={styles.notebookEntryTitleBlock}>
                          <View style={styles.notebookEntryMetaRow}>
                            <Text
                              style={[
                                styles.notebookEntrySource,
                                archived && styles.notebookEntrySourceArchived,
                              ]}
                            >
                              {notebookSourceText(entry)}
                            </Text>
                            {!entry.readAt ? <Text style={styles.notebookUnreadDot}>未读</Text> : null}
                          </View>
                          <Text style={styles.notebookEntryTitle}>{entry.title}</Text>
                        </View>
                        <Text style={styles.notebookEntryDate}>{formatDateTime(entry.createdAt)}</Text>
                      </View>
                      <Text style={styles.notebookEntryContent}>{entry.content}</Text>
                      {keywordText ? <Text style={styles.notebookEntryKeywords}>{keywordText}</Text> : null}
                      <NotebookSourceExcerpt entry={entry} style={styles.notebookEntryExcerpt} />
                      <Pressable
                        onPress={(event) => {
                          event.stopPropagation();
                          confirmDeleteNotebookEntry(entry);
                        }}
                        style={styles.notebookDeleteButton}
                      >
                        <Text style={styles.notebookDeleteText}>删除这页</Text>
                      </Pressable>
                    </Pressable>
                  );
                })
              ) : (
                <Text style={styles.notebookEmpty}>白云还没在小本本上偷偷写东西。</Text>
              )}
              {notebookEntries.length ? (
                <View style={styles.notebookPagination}>
                  <Pressable accessibilityRole="button" disabled={notebookPage.pageIndex === 0}
                    accessibilityState={{ disabled: notebookPage.pageIndex === 0 }}
                    onPress={() => turnNotebookPage(notebookPage.pageIndex - 1)}
                    style={[styles.notebookToggle, notebookPage.pageIndex === 0 && styles.notebookPageDisabled]}>
                    <Text style={styles.notebookToggleText}>上一页</Text>
                  </Pressable>
                  <Text style={styles.notebookMoreText}>第 {notebookPage.pageIndex + 1} / {notebookPage.pageCount} 页 · 共 {notebookEntries.length} 条</Text>
                  <Pressable accessibilityRole="button" disabled={notebookPage.pageIndex === notebookPage.pageCount - 1}
                    accessibilityState={{ disabled: notebookPage.pageIndex === notebookPage.pageCount - 1 }}
                    onPress={() => turnNotebookPage(notebookPage.pageIndex + 1)}
                    style={[styles.notebookToggle, notebookPage.pageIndex === notebookPage.pageCount - 1 && styles.notebookPageDisabled]}>
                    <Text style={styles.notebookToggleText}>下一页</Text>
                  </Pressable>
                </View>
              ) : null}
            </View>
          ) : recentCounterTasks.length ? (
            <View style={styles.notebookCounterList}>
              {recentCounterTasks.map((task) => (
                <View key={task.id} style={styles.notebookCounterRow}>
                  <View style={styles.notebookCounterCopy}>
                    <Text style={styles.notebookCounterTitle}>{task.title}</Text>
                    <Text style={styles.notebookCounterMeta}>{counterMetaText(task)}</Text>
                  </View>
                  <Text
                    style={[
                      styles.notebookCounterStatus,
                      task.status === 'completed' && styles.notebookCounterStatusDone,
                      task.status === 'disabled' && styles.notebookCounterStatusMuted,
                    ]}
                  >
                    {counterStatusText(task)}
                  </Text>
                </View>
              ))}
            </View>
          ) : (
            <Text style={styles.notebookEmpty}>等白云真的好奇某个词时，这里会先冒出记录。</Text>
          )}
        </View>
        <NotebookManagement counters={keywordCounterSnapshot} notebook={notebookSnapshot} onChanged={notebookManagementChanged} />
        </>
        ) : null}

        {activeTab === 'letters' ? <>
        {canWrite ? (
          <View style={styles.composePanel}>
            <View style={styles.composeHeader}>
              <View>
                <Text style={styles.composeEyebrow}>新信</Text>
                <Text style={styles.composeTitle}>写给白云小姐</Text>
              </View>
              <Text style={styles.composeHint}>回信约 {delayHours} 小时后到</Text>
            </View>
            <TextInput
              onChangeText={setTitle}
              placeholder="标题，可以不写"
              placeholderTextColor="#8AA0B4"
              style={styles.titleInput}
              value={title}
            />
            <TextInput
              multiline
              onChangeText={setContent}
              placeholder="写给白云小姐..."
              placeholderTextColor="#8AA0B4"
              style={styles.bodyInput}
              textAlignVertical="top"
              value={content}
            />
            <Text style={styles.delayLabel}>回信节奏</Text>
            <View style={styles.delayRow}>
              {[3, 4, 5, 6, 7, 8].map((hour) => (
                <Pressable
                  key={hour}
                  onPress={() => setDelayHours(clampReplyDelayHours(hour))}
                  style={[styles.delayChip, delayHours === hour && styles.delayChipActive]}
                >
                  <Text style={[styles.delayText, delayHours === hour && styles.delayTextActive]}>{hour}h</Text>
                </Pressable>
              ))}
            </View>
            <Pressable
              disabled={!content.trim() || busy}
              onPress={sendLetter}
              style={[styles.primaryButton, (!content.trim() || busy) && styles.disabled]}
            >
              <Text style={styles.primaryButtonText}>{busy ? '寄送中' : '寄出'}</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.lockPanel}>
            <Text style={styles.lockTitle}>{lock?.letter.title}</Text>
            <Text style={styles.lockText}>{lock ? statusText(lock.letter) : ''}</Text>
          </View>
        )}

        <View style={styles.list}>
          <View style={styles.listHeader}>
            <Text style={styles.listTitle}>信件</Text>
            <Text style={styles.letterMeta}>{visibleLetters.length} / {letters.length}</Text>
          </View>
          {visibleLetters.map((letter) => {
            const expanded = !!expandedLetterIds[letter.id];
            const replyKey = letter.id + ':reply';
            const replyExpanded = !!expandedLetterIds[replyKey];
            const collapsible = letter.content.length > LETTER_PREVIEW_LIMIT;
            const replyCollapsible = (letter.replyContent?.length ?? 0) > LETTER_PREVIEW_LIMIT;
            return (
              <View
                key={letter.id}
                style={[
                  styles.letterCard,
                  letter.status === 'waiting_user' && styles.letterCardNeedsReply,
                  isLetterWaiting(letter) && styles.letterCardWaiting,
                ]}
              >
                <View style={styles.letterTop}>
                  <View style={styles.letterTitleBlock}>
                    <Text style={styles.letterTitle}>{letter.title}</Text>
                    <Text style={styles.letterMeta}>{letterDirectionText(letter)} · {statusText(letter)}</Text>
                  </View>
                  <View style={styles.letterTopActions}>
                    <Text style={styles.letterDate}>{formatDateTime(letter.deliveredAt ?? letter.openedAt ?? letter.createdAt)}</Text>
                    <Pressable
                      disabled={busy}
                      onPress={() => confirmDeleteLetter(letter)}
                      style={styles.letterDeleteButton}
                    >
                      <Text style={styles.letterDeleteText}>删除</Text>
                    </Pressable>
                  </View>
                </View>

                {letter.kind === 'future-self' && letter.status === 'sealed' ? (
                  <Text style={styles.sealedText}>正文被封存在信封里，{formatDateTime(letter.dueAt)} 后再拆。</Text>
                ) : (
                  <Text style={styles.letterBody}>{letterPreviewText(letter.content, expanded)}</Text>
                )}

                {collapsible && !(letter.kind === 'future-self' && letter.status === 'sealed') ? (
                  <Pressable onPress={() => toggleLetterExpanded(letter.id)} style={styles.letterGhostButton}>
                    <Text style={styles.letterGhostButtonText}>{expanded ? '收起正文' : '展开全文'}</Text>
                  </Pressable>
                ) : null}

                {letter.replyContent ? (
                  <View style={styles.replyBlock}>
                    <Text style={styles.replyLabel}>回信</Text>
                    <Text style={styles.replyText}>{letterPreviewText(letter.replyContent, replyExpanded)}</Text>
                    {replyCollapsible ? (
                      <Pressable
                        onPress={() => toggleLetterExpanded(replyKey)}
                        style={styles.replyGhostButton}
                      >
                        <Text style={styles.letterGhostButtonText}>{replyExpanded ? '收起回信' : '展开回信'}</Text>
                      </Pressable>
                    ) : null}
                  </View>
                ) : null}

                {letter.status === 'waiting_user' ? (
                  <View style={styles.replyComposer}>
                    <TextInput
                      multiline
                      onChangeText={(text) => setReplyDrafts((current) => ({ ...current, [letter.id]: text }))}
                      placeholder="给白云小姐回信..."
                      placeholderTextColor="#8AA0B4"
                      style={styles.replyInput}
                      textAlignVertical="top"
                      value={replyDrafts[letter.id] ?? ''}
                    />
                    <Pressable
                      disabled={!replyDrafts[letter.id]?.trim() || busy}
                      onPress={() => replyToLetter(letter)}
                      style={[styles.smallButton, (!replyDrafts[letter.id]?.trim() || busy) && styles.disabled]}
                    >
                      <Text style={styles.smallButtonText}>回信</Text>
                    </Pressable>
                  </View>
                ) : null}

                {letter.status === 'ready_to_open' ? (
                  <Pressable onPress={() => openFuture(letter)} style={styles.smallButton}>
                    <Text style={styles.smallButtonText}>拆信</Text>
                  </Pressable>
                ) : null}

                {letter.status === 'failed' ? (
                  <Pressable onPress={retryLetter} style={styles.retryButton}>
                    <Text style={styles.retryText}>重试回信</Text>
                  </Pressable>
                ) : null}
              </View>
            );
          })}
          {letters.length && !visibleLetters.length ? (
            <View style={styles.emptyState}>
              <Text style={styles.emptyTitle}>这个筛选里暂时没有信</Text>
              <Text style={styles.emptyText}>换一个小标签看看别的往来。</Text>
            </View>
          ) : null}
          {!letters.length ? (
            <View style={styles.emptyState}>
              <Text style={styles.emptyTitle}>还没有信</Text>
              <Text style={styles.emptyText}>第一封会慢慢等到白云小姐回来的时候。</Text>
            </View>
          ) : null}
        </View>
        </> : null}
      </ScrollView>
      )}
      <Modal animationType="fade" transparent visible={drawerVisible} onRequestClose={() => setDrawerVisible(false)}>
        <View style={styles.drawerOverlay}>
          <Pressable accessibilityLabel="关闭往来侧边栏" style={StyleSheet.absoluteFillObject} onPress={() => setDrawerVisible(false)} />
          <View style={[styles.drawerPanel, { paddingTop: Math.max(46, insets.top + 12), paddingBottom: insets.bottom + 20 }]}>
            <Text style={styles.drawerTitle}>功能</Text>
            <View style={styles.drawerQuickNav}>
              <Pressable accessibilityRole="button" onPress={() => { setDrawerVisible(false); navigate('home'); }} style={styles.drawerQuickNavButton}>
                <Text style={styles.drawerQuickNavIcon}>⌂</Text>
                <Text style={styles.drawerQuickNavText}>首页</Text>
              </Pressable>
              <Pressable accessibilityRole="button" onPress={() => { setDrawerVisible(false); navigate('chat'); }} style={styles.drawerQuickNavButton}>
                <Text style={styles.drawerQuickNavIcon}>◌</Text>
                <Text style={styles.drawerQuickNavText}>聊天</Text>
              </Pressable>
            </View>
            <Text style={styles.drawerSection}>往来功能</Text>
            {CORRESPONDENCE_TABS.map(tab => (
              <Pressable key={tab.key} accessibilityRole="tab" accessibilityState={{ selected: activeTab === tab.key }}
                onPress={() => { setActiveTab(tab.key); setDrawerVisible(false); }}
                style={[styles.drawerItem, activeTab === tab.key && styles.drawerItemActive]}>
                <Text style={[styles.drawerItemText, activeTab === tab.key && styles.drawerItemTextActive]}>{tab.title}{tab.key === 'posts' && postUnread ? ' ☁' : ''}</Text>
                <Text style={styles.drawerItemMeta}>{tab.description}</Text>
                <Text style={styles.drawerArrow}>›</Text>
              </Pressable>
            ))}
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  menuText: { color: colors.ink, fontSize: 25 },
  drawerOverlay: { backgroundColor: 'rgba(31, 34, 44, 0.22)', flex: 1 },
  drawerPanel: { backgroundColor: '#F5F7FF', bottom: 0, elevation: 10, left: 0, maxWidth: 360, paddingHorizontal: 16, position: 'absolute', shadowColor: '#2F3852', shadowOpacity: 0.16, shadowRadius: 18, top: 0, width: '76%' },
  drawerTitle: { color: colors.ink, fontSize: 25, fontWeight: '600', marginBottom: 14 },
  drawerQuickNav: { flexDirection: 'row', gap: 8, marginBottom: 18 },
  drawerQuickNavButton: { alignItems: 'center', backgroundColor: '#FFFFFF', borderColor: '#DEE7F6', borderRadius: 15, borderWidth: 1, flex: 1, flexDirection: 'row', gap: 8, justifyContent: 'center', minHeight: 50, paddingHorizontal: 8 },
  drawerQuickNavIcon: { color: '#6B8BAA', fontSize: 21, fontWeight: '500' },
  drawerQuickNavText: { color: colors.ink, fontSize: 15, fontWeight: '500' },
  drawerSection: { color: colors.ink, fontSize: 16, fontWeight: '600', marginBottom: 8, marginTop: 8 },
  drawerItem: { backgroundColor: '#FFFFFF', borderColor: '#DEE7F6', borderRadius: 16, borderWidth: 1, marginBottom: 10, minHeight: 68, padding: 12, paddingRight: 30 },
  drawerItemActive: { backgroundColor: '#FFF4F1', borderColor: 'rgba(244,139,132,0.45)' },
  drawerItemText: { color: colors.ink, fontSize: 15, fontWeight: '600', marginBottom: 4 },
  drawerItemTextActive: { color: colors.primary },
  drawerItemMeta: { color: colors.muted, fontSize: 12, lineHeight: 17 },
  drawerArrow: { color: colors.muted, fontSize: 20, position: 'absolute', right: 12, top: 25 },
  loadingPage: {
    alignItems: 'center',
    backgroundColor: '#F5FAFF',
    flex: 1,
    justifyContent: 'center',
  },
  page: {
    backgroundColor: '#F5FAFF',
    flex: 1,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  backButton: {
    alignItems: 'center',
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  headerCopy: {
    flex: 1,
  },
  title: {
    color: colors.ink,
    fontSize: 24,
    fontWeight: '700',
  },
  subtitle: {
    color: '#7188A0',
    fontSize: 13,
    marginTop: 2,
  },
  content: {
    gap: 14,
    paddingBottom: 32,
    paddingHorizontal: 16,
  },
  summaryPanel: {
    backgroundColor: '#FFFFFF',
    borderColor: '#DDEAF7',
    borderRadius: 18,
    borderWidth: 1,
    gap: 12,
    padding: 14,
  },
  summaryText: {
    color: colors.ink,
    fontSize: 15,
    lineHeight: 22,
  },
  summaryStats: {
    flexDirection: 'row',
    gap: 9,
  },
  summaryStat: {
    backgroundColor: '#F4FAFF',
    borderColor: '#E0EEF9',
    borderRadius: 13,
    borderWidth: 1,
    flex: 1,
    paddingHorizontal: 10,
    paddingVertical: 9,
  },
  summaryStatValue: {
    color: colors.ink,
    fontSize: 18,
    fontWeight: '800',
  },
  summaryStatLabel: {
    color: '#6D8BA6',
    fontSize: 11,
    fontWeight: '700',
    marginTop: 2,
  },
  filterRow: {
    gap: 8,
    paddingRight: 16,
  },
  filterChip: {
    backgroundColor: '#FFFFFF',
    borderColor: '#DDEAF7',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 13,
    paddingVertical: 8,
  },
  filterChipActive: {
    backgroundColor: '#384052',
    borderColor: '#384052',
  },
  filterText: {
    color: '#6D8BA6',
    fontSize: 12,
    fontWeight: '800',
  },
  filterTextActive: {
    color: '#FFFFFF',
  },
  notebookPanel: {
    backgroundColor: '#FFFDF8',
    borderColor: '#F0DDBC',
    borderRadius: 18,
    borderWidth: 1,
    gap: 11,
    padding: 14,
  },
  notebookHeader: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
  },
  notebookTitleBlock: {
    flex: 1,
  },
  notebookEyebrow: {
    color: '#B17B42',
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 3,
  },
  notebookTitle: {
    color: colors.ink,
    fontSize: 16,
    fontWeight: '700',
    lineHeight: 22,
  },
  notebookBadge: {
    alignItems: 'center',
    backgroundColor: '#FFE8C8',
    borderColor: '#F2C990',
    borderRadius: 14,
    borderWidth: 1,
    minWidth: 38,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  notebookBadgeText: {
    color: '#9A6530',
    fontSize: 14,
    fontWeight: '800',
  },
  notebookActions: {
    alignItems: 'flex-end',
    gap: 7,
  },
  notebookToggle: {
    alignItems: 'center',
    backgroundColor: '#FFF5E5',
    borderColor: '#F2D7AD',
    borderRadius: 12,
    borderWidth: 1,
    minWidth: 48,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  notebookToggleText: {
    color: '#9A6530',
    fontSize: 12,
    fontWeight: '800',
  },
  notebookSummary: {
    color: '#806B55',
    fontSize: 13,
    lineHeight: 20,
  },
  notebookEntryList: {
    gap: 10,
  },
  notebookEntryCard: {
    backgroundColor: '#FFFFFF',
    borderColor: '#F1E2CA',
    borderRadius: 14,
    borderWidth: 1,
    gap: 8,
    padding: 11,
  },
  notebookEntryCardArchived: {
    backgroundColor: '#FFF9EF',
    borderColor: '#EAD3AE',
  },
  notebookEntryTop: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'space-between',
  },
  notebookEntryTitleBlock: {
    flex: 1,
  },
  notebookEntryMetaRow: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 3,
  },
  notebookEntrySource: {
    color: '#B17B42',
    fontSize: 11,
    fontWeight: '800',
  },
  notebookEntrySourceArchived: {
    color: '#8B765C',
  },
  notebookUnreadDot: {
    backgroundColor: '#FFE4D8',
    borderRadius: 9,
    color: '#C56F5D',
    fontSize: 10,
    fontWeight: '800',
    overflow: 'hidden',
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  notebookEntryTitle: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '800',
    lineHeight: 20,
  },
  notebookEntryDate: {
    color: '#A4917D',
    fontSize: 10,
    lineHeight: 16,
    maxWidth: 86,
    textAlign: 'right',
  },
  notebookEntryContent: {
    color: colors.ink,
    fontSize: 13,
    lineHeight: 20,
  },
  notebookEntryKeywords: {
    color: '#9B744B',
    fontSize: 12,
    lineHeight: 18,
  },
  notebookEntryExcerpt: {
    backgroundColor: '#FFF8EC',
    borderColor: '#F0DFC4',
    borderRadius: 11,
    borderWidth: 1,
    color: '#8A755F',
    fontSize: 12,
    lineHeight: 18,
    paddingHorizontal: 9,
    paddingVertical: 7,
  },
  notebookDeleteButton: {
    alignSelf: 'flex-end',
    backgroundColor: '#F6EEE5',
    borderRadius: 10,
    paddingHorizontal: 11,
    paddingVertical: 7,
  },
  notebookDeleteText: {
    color: '#9A6530',
    fontSize: 12,
    fontWeight: '700',
  },
  notebookMoreText: {
    color: '#9A8065',
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
    flexShrink: 1,
  },
  notebookPagination: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  notebookPageDisabled: { opacity: 0.4 },
  notebookCounterList: {
    gap: 8,
  },
  notebookCounterRow: {
    alignItems: 'flex-start',
    backgroundColor: '#FFFFFF',
    borderColor: '#F2E4CF',
    borderRadius: 13,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 9,
    paddingHorizontal: 10,
    paddingVertical: 9,
  },
  notebookCounterCopy: {
    flex: 1,
  },
  notebookCounterTitle: {
    color: colors.ink,
    fontSize: 13,
    fontWeight: '700',
    lineHeight: 18,
  },
  notebookCounterMeta: {
    color: '#8A755F',
    fontSize: 12,
    lineHeight: 17,
    marginTop: 2,
  },
  notebookCounterStatus: {
    backgroundColor: '#FFF2DC',
    borderRadius: 10,
    color: '#A36A2D',
    fontSize: 10,
    fontWeight: '800',
    overflow: 'hidden',
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  notebookCounterStatusDone: {
    backgroundColor: '#EEF6E5',
    color: '#6E8A45',
  },
  notebookCounterStatusMuted: {
    backgroundColor: '#F0F2F4',
    color: '#8A949F',
  },
  notebookEmpty: {
    backgroundColor: '#FFFFFF',
    borderColor: '#F2E4CF',
    borderRadius: 13,
    borderWidth: 1,
    color: '#8A755F',
    fontSize: 12,
    lineHeight: 18,
    paddingHorizontal: 10,
    paddingVertical: 9,
  },
  composePanel: {
    backgroundColor: '#FFFFFF',
    borderColor: '#DCEBFA',
    borderRadius: 18,
    borderWidth: 1,
    gap: 10,
    padding: 13,
  },
  composeHeader: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'space-between',
  },
  composeEyebrow: {
    color: '#6D8BA6',
    fontSize: 11,
    fontWeight: '800',
    marginBottom: 3,
  },
  composeTitle: {
    color: colors.ink,
    fontSize: 17,
    fontWeight: '800',
    lineHeight: 23,
  },
  composeHint: {
    backgroundColor: '#EEF6FF',
    borderRadius: 999,
    color: '#5F86A8',
    fontSize: 11,
    fontWeight: '800',
    overflow: 'hidden',
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  titleInput: {
    backgroundColor: '#F8FCFF',
    borderColor: '#DDEAF6',
    borderRadius: 12,
    borderWidth: 1,
    color: colors.ink,
    fontSize: 14,
    height: 44,
    paddingHorizontal: 12,
  },
  bodyInput: {
    backgroundColor: '#F8FCFF',
    borderColor: '#DDEAF6',
    borderRadius: 13,
    borderWidth: 1,
    color: colors.ink,
    fontSize: 15,
    lineHeight: 22,
    minHeight: 150,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  delayLabel: {
    color: '#6D8BA6',
    fontSize: 12,
    fontWeight: '800',
  },
  delayRow: {
    flexDirection: 'row',
    gap: 7,
  },
  delayChip: {
    alignItems: 'center',
    backgroundColor: '#EEF6FF',
    borderRadius: 11,
    flex: 1,
    height: 36,
    justifyContent: 'center',
  },
  delayChipActive: {
    backgroundColor: '#9DCCF3',
  },
  delayText: {
    color: '#67839E',
    fontSize: 13,
    fontWeight: '700',
  },
  delayTextActive: {
    color: '#FFFFFF',
  },
  primaryButton: {
    alignItems: 'center',
    backgroundColor: '#FF9478',
    borderRadius: 13,
    height: 46,
    justifyContent: 'center',
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },
  disabled: {
    opacity: 0.45,
  },
  lockPanel: {
    backgroundColor: '#FFF6EF',
    borderColor: '#F2D8CA',
    borderRadius: 18,
    borderWidth: 1,
    padding: 15,
  },
  lockTitle: {
    color: colors.ink,
    fontSize: 17,
    fontWeight: '700',
  },
  lockText: {
    color: '#896F62',
    fontSize: 13,
    marginTop: 6,
  },
  list: {
    gap: 11,
  },
  listHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 2,
  },
  listTitle: {
    color: colors.ink,
    fontSize: 16,
    fontWeight: '800',
  },
  letterCard: {
    backgroundColor: '#FFFFFF',
    borderColor: '#DDEAF7',
    borderRadius: 16,
    borderWidth: 1,
    gap: 10,
    padding: 13,
  },
  letterCardNeedsReply: {
    backgroundColor: '#FFFCF5',
    borderColor: '#F1D8A9',
  },
  letterCardWaiting: {
    borderColor: '#CFE3F6',
  },
  letterTop: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'space-between',
  },
  letterTitleBlock: {
    flex: 1,
  },
  letterTitle: {
    color: colors.ink,
    fontSize: 16,
    fontWeight: '700',
  },
  letterMeta: {
    color: '#6D8BA6',
    fontSize: 12,
    marginTop: 3,
  },
  letterTopActions: {
    alignItems: 'flex-end',
    gap: 7,
    maxWidth: 104,
  },
  letterDeleteButton: {
    backgroundColor: '#FFF1ED',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  letterDeleteText: {
    color: '#C56F5D',
    fontSize: 11,
    fontWeight: '800',
  },
  letterDate: {
    color: '#93A4B5',
    fontSize: 11,
  },
  letterBody: {
    color: colors.ink,
    fontSize: 14,
    lineHeight: 22,
  },
  letterGhostButton: {
    alignSelf: 'flex-start',
    backgroundColor: '#F4FAFF',
    borderRadius: 999,
    paddingHorizontal: 11,
    paddingVertical: 7,
  },
  letterGhostButtonText: {
    color: '#5F86A8',
    fontSize: 12,
    fontWeight: '800',
  },
  sealedText: {
    color: '#7D8FA2',
    fontSize: 13,
    lineHeight: 20,
  },
  replyBlock: {
    backgroundColor: '#EFF8FF',
    borderRadius: 13,
    gap: 5,
    padding: 11,
  },
  replyGhostButton: {
    alignSelf: 'flex-start',
    backgroundColor: '#FFFFFF',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  replyLabel: {
    color: '#5A83A5',
    fontSize: 12,
    fontWeight: '700',
  },
  replyText: {
    color: colors.ink,
    fontSize: 14,
    lineHeight: 21,
  },
  replyComposer: {
    gap: 8,
  },
  replyInput: {
    backgroundColor: '#F8FCFF',
    borderColor: '#DDEAF6',
    borderRadius: 12,
    borderWidth: 1,
    color: colors.ink,
    fontSize: 14,
    lineHeight: 21,
    minHeight: 86,
    paddingHorizontal: 11,
    paddingVertical: 9,
  },
  smallButton: {
    alignItems: 'center',
    alignSelf: 'flex-end',
    backgroundColor: '#9DCCF3',
    borderRadius: 12,
    minWidth: 82,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  smallButtonText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
  },
  retryButton: {
    alignItems: 'center',
    alignSelf: 'flex-end',
    backgroundColor: '#FFE4DC',
    borderRadius: 12,
    minWidth: 92,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  retryText: {
    color: '#C56F5D',
    fontSize: 13,
    fontWeight: '700',
  },
  emptyState: {
    alignItems: 'center',
    padding: 24,
  },
  emptyTitle: {
    color: colors.ink,
    fontSize: 17,
    fontWeight: '700',
  },
  emptyText: {
    color: '#7F91A5',
    fontSize: 13,
    marginTop: 6,
  },
});
