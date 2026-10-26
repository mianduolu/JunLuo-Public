import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { Navigate } from '../types/navigation';
import {
  loadAutomaticDataSyncSnapshot,
  subscribeAutomaticDataSyncSnapshot,
} from './automaticDataSyncPolicy';
import {
  loadAutomaticDataSyncProgress,
  subscribeAutomaticDataSyncProgress,
} from './automaticDataSyncProgress';
import {
  automaticDataSyncOrdinaryBacklog,
  type AutomaticDataSyncProgressV1,
} from './automaticDataSyncProgressCore';
import { refreshAndroidAutomaticDataSyncProgress } from './automaticDataSyncRuntime';

const PASSIVE_VISIBILITY_MS = 6_000;

function mainLabel(
  enabled: boolean,
  progress: AutomaticDataSyncProgressV1,
) {
  const { queues, lastRound } = progress;
  if (!enabled && (automaticDataSyncOrdinaryBacklog(queues) > 0 || queues.objectJobs > 0)) {
    return '自动同步已关闭 · 有待处理数据';
  }
  if (queues.conflicts > 0) return `需要整理 · ${queues.conflicts} 个不同版本`;
  if (queues.quarantined > 0) return `同步受阻 · ${queues.quarantined} 条需要检查`;
  if (queues.blockedObjectJobs > 0) {
    return `需要检查 · ${queues.blockedObjectJobs} 个文件缺少原文件`;
  }
  if (progress.phase === 'sending') return `正在送出 · 本轮 ${lastRound?.sent ?? 0} 条`;
  if (progress.phase === 'receiving') return `正在取回 · 本轮 ${lastRound?.received ?? 0} 条`;
  if (progress.phase === 'materializing') return `正在整理 · 本轮 ${lastRound?.materialized ?? 0} 条`;
  if (progress.phase === 'files') {
    return `正在传文件 · ${queues.completedObjectChunks}/${queues.totalObjectChunks} 块`;
  }
  if (progress.phase === 'waiting-relay') return '等待电脑后端 · 稍后继续';
  if (automaticDataSyncOrdinaryBacklog(queues) === 0) {
    return queues.objectJobs > 0
      ? `普通数据已同步 · 还有 ${queues.objectJobs} 个文件等待条件`
      : '普通数据已同步';
  }
  if (progress.phase === 'paused') return '稍后继续 · 当前页面正忙';
  return `本轮结束 · 还有 ${automaticDataSyncOrdinaryBacklog(queues)} 项等待继续`;
}

export function AutomaticDataSyncCapsule(input: {
  hidden?: boolean;
  navigate: Navigate;
}) {
  const insets = useSafeAreaInsets();
  const [enabled, setEnabled] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [passiveVisible, setPassiveVisible] = useState(false);
  const [successVisible, setSuccessVisible] = useState(false);
  const [progress, setProgress] = useState<AutomaticDataSyncProgressV1 | null>(null);
  const previousPhaseRef = useRef<AutomaticDataSyncProgressV1['phase'] | null>(null);

  useEffect(() => {
    void loadAutomaticDataSyncSnapshot().then((snapshot) => {
      setEnabled(snapshot.policy.enabled);
    });
    void refreshAndroidAutomaticDataSyncProgress()
      .then(loadAutomaticDataSyncProgress)
      .then(setProgress);
    const unsubscribePolicy = subscribeAutomaticDataSyncSnapshot((policy) => {
      setEnabled(policy.enabled);
    });
    const unsubscribeProgress = subscribeAutomaticDataSyncProgress(setProgress);
    return () => {
      unsubscribePolicy();
      unsubscribeProgress();
    };
  }, []);

  useEffect(() => {
    if (!progress?.lastRound || progress.lastRound.stoppedBy !== 'complete') return;
    if (automaticDataSyncOrdinaryBacklog(progress.queues) > 0) return;
    if (Date.now() - progress.updatedAt > 10_000) return;
    setSuccessVisible(true);
    const timer = setTimeout(() => setSuccessVisible(false), 5_000);
    return () => clearTimeout(timer);
  }, [progress?.updatedAt]);

  useEffect(() => {
    if (!progress) return;
    const ageMs = Math.max(0, Date.now() - progress.updatedAt);
    const remainingMs = PASSIVE_VISIBILITY_MS - ageMs;
    if (remainingMs <= 0) {
      setPassiveVisible(false);
      return;
    }
    setPassiveVisible(true);
    const timer = setTimeout(() => setPassiveVisible(false), remainingMs);
    return () => clearTimeout(timer);
  }, [progress?.updatedAt]);

  useEffect(() => {
    if (!progress) return;
    const previousPhase = previousPhaseRef.current;
    previousPhaseRef.current = progress.phase;
    if (previousPhase === 'idle' && progress.phase === 'checking') {
      setDismissed(false);
    }
  }, [progress?.phase]);

  const visible = useMemo(() => {
    if (!progress || input.hidden) return false;
    if (dismissed) return false;
    const running = progress.phase === 'checking'
      || progress.phase === 'sending'
      || progress.phase === 'receiving'
      || progress.phase === 'materializing'
      || progress.phase === 'files';
    return expanded || running || passiveVisible || successVisible;
  }, [dismissed, expanded, input.hidden, passiveVisible, progress, successVisible]);

  if (!visible || !progress) return null;
  return (
    <View style={[styles.host, { bottom: insets.bottom + 14 }]} pointerEvents="box-none">
      <View style={[styles.capsule, expanded && styles.capsuleExpanded]}>
        <View style={styles.summaryRow}>
          <View style={styles.syncMark}>
            <Text style={styles.syncMarkText}>↻</Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={expanded ? '收起同步进度' : '展开同步进度'}
            onPress={() => setExpanded((value) => !value)}
            style={({ pressed }) => [styles.summaryButton, pressed && styles.pressed]}
          >
            <Text numberOfLines={expanded ? undefined : 2} style={styles.main}>
              {mainLabel(enabled, progress)}
            </Text>
            <Text style={styles.toggleText}>{expanded ? '收起' : '详情'}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="关闭同步提示"
            hitSlop={8}
            onPress={() => {
              setExpanded(false);
              setDismissed(true);
            }}
            style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}
          >
            <Text style={styles.closeButtonText}>×</Text>
          </Pressable>
        </View>
        {expanded ? (
          <View style={styles.details}>
            <Text style={styles.detail}>
              待送出 {progress.queues.pendingOutgoing} · 待取回 {progress.queues.waitingAtRelay}
            </Text>
            <Text style={styles.detail}>
              待整理 {progress.queues.receivedAwaitingApply} · 文件 {progress.queues.objectJobs}
            </Text>
            {progress.queues.blockedObjectJobs > 0 ? (
              <Text style={styles.detail}>
                缺少原文件 {progress.queues.blockedObjectJobs}
              </Text>
            ) : null}
            {progress.lastRound ? (
              <Text style={styles.detail}>
                上轮送出 {progress.lastRound.sent} · 取回 {progress.lastRound.received} · 整理 {progress.lastRound.materialized}
              </Text>
            ) : null}
            <Pressable
              accessibilityRole="button"
              onPress={() => input.navigate('device-sync')}
              style={styles.detailButton}
            >
              <Text style={styles.detailButtonText}>查看详情</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  host: {
    alignItems: 'flex-end',
    left: 12,
    position: 'absolute',
    right: 12,
    zIndex: 30,
  },
  capsule: {
    backgroundColor: 'rgba(255, 253, 249, 0.97)',
    borderColor: 'rgba(118, 190, 204, 0.72)',
    borderRadius: 20,
    borderWidth: 1,
    maxWidth: 360,
    minHeight: 44,
    paddingHorizontal: 8,
    paddingVertical: 7,
    shadowColor: '#557B86',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.16,
    shadowRadius: 10,
  },
  capsuleExpanded: {
    width: '100%',
  },
  summaryRow: {
    alignItems: 'center',
    flexDirection: 'row',
  },
  summaryButton: {
    alignItems: 'center',
    flex: 1,
    flexDirection: 'row',
    minHeight: 44,
    paddingHorizontal: 8,
  },
  syncMark: {
    alignItems: 'center',
    backgroundColor: '#DDF4F1',
    borderRadius: 15,
    height: 30,
    justifyContent: 'center',
    marginLeft: 2,
    width: 30,
  },
  syncMarkText: {
    color: '#4C9298',
    fontSize: 20,
    lineHeight: 23,
  },
  pressed: { opacity: 0.84 },
  main: { color: '#385968', flexShrink: 1, fontSize: 14, fontWeight: '700' },
  toggleText: {
    color: '#6A9AA4',
    fontSize: 13,
    fontWeight: '700',
    marginLeft: 10,
  },
  closeButton: {
    alignItems: 'center',
    borderRadius: 18,
    height: 36,
    justifyContent: 'center',
    width: 36,
  },
  closeButtonText: {
    color: '#A87972',
    fontSize: 22,
    lineHeight: 25,
  },
  details: {
    borderTopColor: '#DDECEF',
    borderTopWidth: 1,
    gap: 5,
    marginHorizontal: 8,
    paddingBottom: 5,
    paddingTop: 10,
  },
  detail: { color: '#66828D', fontSize: 14, lineHeight: 20 },
  detailButton: {
    alignItems: 'center',
    alignSelf: 'stretch',
    backgroundColor: '#E8F7F4',
    borderColor: '#BFE4DE',
    borderRadius: 14,
    borderWidth: 1,
    justifyContent: 'center',
    marginTop: 5,
    minHeight: 44,
  },
  detailButtonText: { color: '#477E82', fontSize: 14, fontWeight: '700' },
});
