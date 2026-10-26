import { useEffect, useState } from 'react';
import { Alert, Pressable, StyleSheet, View } from 'react-native';

import { AppText as Text } from '../components/AppText';
import { getVoiceCallDeliveryLabel, hasReliableVoiceCallText, type VoiceCallRecord } from './voiceCallRecord';
import { getVoiceCallMemoryOrganizationStatus } from './voiceCallMemoryReviewStatus';
import { subscribeMemoryProcessingUpdates } from '../memory/memoryProcessingSignals';

const directionLabels = {
  incoming: '云云来电',
  outgoing: '小仓鼠拨出',
  test: '测试通话',
} as const;

const endReasonLabels = {
  'app-left': 'App 离开',
  'assistant-ended': '云云结束',
  'duration-limit': '达到通话时长上限',
  'line-disconnected': '电话线断开',
  'user-hangup': '小仓鼠挂断',
} as const;

const summaryStatusLabels = {
  disabled: '只保存基础记录',
  failed: '通话小记整理失败',
  pending: '通话小记整理中',
  ready: '通话小记已整理',
  skipped: '本次没有足够的文字材料',
} as const;

function formatDuration(durationMs: number) {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(totalSeconds % 60).padStart(2, '0')}`;
}

function formatDate(timestamp: number) {
  return new Date(timestamp).toLocaleString('zh-CN', {
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
    minute: '2-digit',
    month: '2-digit',
  });
}

export function VoiceCallRecordCard({
  onDelete,
  onOrganize,
  organizing,
  record,
}: {
  onDelete?: () => void;
  onOrganize?: () => void;
  organizing: boolean;
  record: VoiceCallRecord;
}) {
  const [expanded, setExpanded] = useState(false);
  const [progress, setProgress] = useState<Awaited<ReturnType<typeof getVoiceCallMemoryOrganizationStatus>> | null>(null);
  useEffect(() => {
    let disposed = false;
    let revision = 0;
    const refresh = () => {
      const request = ++revision;
      void getVoiceCallMemoryOrganizationStatus(record).then(value => {
        if (!disposed && request === revision) setProgress(value);
      }).catch(() => { if (!disposed && request === revision) setProgress(null); });
    };
    refresh();
    const unsubscribe = subscribeMemoryProcessingUpdates(refresh);
    return () => { disposed = true; unsubscribe(); };
  }, [record]);
  const canOrganize = record.memoryCandidates.length > 0 || hasReliableVoiceCallText(record);
  const confirmDelete = () => {
    Alert.alert(
      '删除这张通话记录？',
      '删除后，这张卡片会从聊天记录中消失。',
      [
        { style: 'cancel', text: '取消' },
        { onPress: onDelete, style: 'destructive', text: '删除' },
      ],
    );
  };
  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.eyebrow}>语音通话</Text>
          <Text style={styles.title}>{directionLabels[record.direction]}</Text>
          <Text style={styles.meta}>{formatDate(record.startedAt)}  ·  {formatDuration(record.durationMs)}</Text>
        </View>
        <View style={styles.headerActions}>
          {onDelete ? <Pressable
            accessibilityLabel="删除这张通话记录"
            hitSlop={6}
            onPress={confirmDelete}
            style={({ pressed }) => [styles.deleteButton, pressed && styles.deleteButtonPressed]}
          >
            <Text style={styles.deleteText}>删除</Text>
          </Pressable> : null}
          <Pressable
            accessibilityLabel={expanded ? '收起通话记录' : '展开通话记录'}
            onPress={() => setExpanded((current) => !current)}
            style={({ pressed }) => [styles.toggle, pressed && styles.togglePressed]}
          >
            <Text style={styles.toggleText}>{expanded ? '收起' : '展开'}</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.statusRow}>
        <View style={[styles.statusDot, record.summaryStatus === 'ready' && styles.statusDotReady]} />
        <Text style={styles.statusText}>{summaryStatusLabels[record.summaryStatus]}</Text>
      </View>
      <Text style={styles.statusText}>{organizing ? '整理中' : progress?.text ?? '整理状态读取未完成'}</Text>
      {onOrganize ? <Pressable
        accessibilityLabel="整理这通电话为记忆"
        accessibilityState={{ disabled: !canOrganize || organizing || progress?.status === 'complete' || progress?.status === 'running' }}
        disabled={!canOrganize || organizing || progress?.status === 'complete' || progress?.status === 'running'}
        onPress={onOrganize}
        style={({ pressed }) => [
          styles.memoryButton,
          (!canOrganize || organizing) && styles.memoryButtonDisabled,
          pressed && canOrganize && !organizing && styles.memoryButtonPressed,
        ]}
      >
        <Text style={styles.memoryButtonText}>
          {organizing ? '整理中…' : canOrganize ? progress?.action ?? '整理为记忆' : '没有可整理文字'}
        </Text>
      </Pressable> : null}

      {expanded ? (
        <View style={styles.expanded}>
          {record.memoryOrganization?.segments.some(segment => segment.summaryValid && segment.summary) ? (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>通话小记</Text>
              {record.memoryOrganization.segments.filter(segment => segment.summaryValid && segment.summary).map(segment => (
                <View key={segment.batchId}>
                  <Text style={styles.meta}>原话范围：{segment.bindings[0]?.turnId} — {segment.bindings[segment.bindings.length-1]?.turnId}</Text>
                  {segment.sourceStale ? <Text style={styles.meta}>依据已改变，保留旧小记供查看</Text> : null}
                  <Text style={styles.summary}>{segment.summary}</Text>
                </View>
              ))}
            </View>
          ) : record.summary ? (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>通话小记</Text>
              <Text style={styles.summary}>{record.summary}</Text>
            </View>
          ) : null}

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>电话里说过的话</Text>
            {record.turns.length ? record.turns.map((turn) => (
              <View key={`${turn.role}-${turn.turnId}`} style={styles.turn}>
                <View style={styles.turnHeading}>
                  <Text style={styles.turnRole}>{turn.role === 'you' ? '小仓鼠' : '云云'}</Text>
                  {turn.role === 'I' ? <Text style={styles.delivery}>{getVoiceCallDeliveryLabel(turn)}</Text> : null}
                </View>
                <Text style={styles.turnText}>{turn.text}</Text>
                {turn.role === 'you' && turn.emotion?.hint !== '暂无明显倾向' ? (
                  <Text style={styles.emotionHint}>{turn.emotion?.hint}</Text>
                ) : null}
              </View>
            )) : <Text style={styles.emptyText}>这通电话没有留下可靠的文字轮次。</Text>}
          </View>

          <View style={styles.footerFacts}>
            <Text style={styles.factText}>没听清：{record.unheardCount} 次</Text>
            <Text style={styles.factText}>结束原因：{endReasonLabels[record.endReason]}</Text>
            {progress?.pending ? (
              <Text style={styles.factText}>待确认记忆：{progress.pending} 条</Text>
            ) : null}
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    alignSelf: 'center',
    backgroundColor: '#f7faf8',
    borderColor: '#b9cdc3',
    borderRadius: 8,
    borderWidth: 1,
    marginVertical: 8,
    maxWidth: 620,
    padding: 16,
    width: '92%',
  },
  delivery: {
    color: '#6d7a75',
    fontSize: 12,
  },
  deleteButton: {
    alignItems: 'center',
    borderRadius: 6,
    justifyContent: 'center',
    minHeight: 38,
    minWidth: 46,
    paddingHorizontal: 8,
  },
  deleteButtonPressed: {
    backgroundColor: '#f7e9e7',
  },
  deleteText: {
    color: '#a4544c',
    fontSize: 14,
    fontWeight: '600',
  },
  emotionHint: {
    color: '#66736e',
    fontSize: 12,
    marginTop: 6,
  },
  emptyText: {
    color: '#77817d',
    fontSize: 14,
    lineHeight: 21,
  },
  expanded: {
    borderTopColor: '#d9e3de',
    borderTopWidth: 1,
    marginTop: 14,
    paddingTop: 2,
  },
  eyebrow: {
    color: '#527564',
    fontSize: 12,
    fontWeight: '600',
  },
  factText: {
    color: '#5d6863',
    fontSize: 13,
    lineHeight: 20,
  },
  footerFacts: {
    borderTopColor: '#d9e3de',
    borderTopWidth: 1,
    gap: 4,
    paddingTop: 12,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
  },
  headerText: {
    flex: 1,
  },
  headerActions: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 4,
  },
  meta: {
    color: '#6f7975',
    fontSize: 13,
    marginTop: 4,
  },
  memoryButton: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    borderColor: '#82aa96',
    borderRadius: 6,
    borderWidth: 1,
    justifyContent: 'center',
    marginTop: 12,
    minHeight: 38,
    paddingHorizontal: 14,
  },
  memoryButtonDisabled: {
    borderColor: '#c9d2ce',
    opacity: 0.62,
  },
  memoryButtonPressed: {
    backgroundColor: '#e3eee8',
  },
  memoryButtonText: {
    color: '#456b59',
    fontSize: 14,
    fontWeight: '600',
  },
  section: {
    paddingVertical: 12,
  },
  sectionTitle: {
    color: '#33443d',
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 8,
  },
  statusDot: {
    backgroundColor: '#aab5b0',
    borderRadius: 4,
    height: 8,
    width: 8,
  },
  statusDotReady: {
    backgroundColor: '#5b9a79',
  },
  statusRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    marginTop: 12,
  },
  statusText: {
    color: '#66716d',
    flex: 1,
    fontSize: 13,
  },
  summary: {
    color: '#2e3b36',
    fontSize: 15,
    lineHeight: 23,
  },
  title: {
    color: '#26362f',
    fontSize: 18,
    fontWeight: '700',
    marginTop: 2,
  },
  toggle: {
    alignItems: 'center',
    borderColor: '#9eb9ac',
    borderRadius: 6,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 38,
    minWidth: 58,
    paddingHorizontal: 12,
  },
  togglePressed: {
    backgroundColor: '#e3eee8',
  },
  toggleText: {
    color: '#456b59',
    fontSize: 14,
    fontWeight: '600',
  },
  turn: {
    borderLeftColor: '#a9c7b8',
    borderLeftWidth: 2,
    marginBottom: 12,
    paddingLeft: 10,
  },
  turnHeading: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  turnRole: {
    color: '#456355',
    fontSize: 13,
    fontWeight: '700',
  },
  turnText: {
    color: '#34413c',
    fontSize: 15,
    lineHeight: 23,
  },
});
