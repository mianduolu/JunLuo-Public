import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import {
  loadBaiyunContinuityContextSummary,
  removeBaiyunContinuityContextLink,
  type BaiyunContinuityContextSummary,
} from '../ai/behavior/continuityLedger';
import { AppText as Text } from '../components/AppText';

type Props = {
  eventId: string;
};

const CURRENT_STATE_STATUS_LABELS: Record<'active' | 'resolved' | 'expired', string> = {
  active: '生效中',
  resolved: '已结束',
  expired: '已过期',
};

const CURRENT_STATE_KIND_LABELS: Record<string, string> = {
  project: '项目推进',
  sleep_body: '睡眠/身体',
  emotional_weather: '情绪天气',
  sensitive_topic: '敏感话题',
  task: '近期任务',
  relationship: '关系背景',
  other: '其他',
};

export function BaiyunContinuityContextSummaryCard({ eventId }: Props) {
  const [summary, setSummary] = useState<BaiyunContinuityContextSummary | null>(null);
  const [removingKey, setRemovingKey] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setSummary(await loadBaiyunContinuityContextSummary(eventId));
  }, [eventId]);

  useEffect(() => {
    void reload().catch(() => setSummary(null));
  }, [reload]);

  const remove = useCallback(async (
    key: string,
    target:
      | { relation: 'memory'; targetKind: 'memory'; targetId: string }
      | { relation: 'current_state'; targetKind: 'memory_current_state'; targetId: string },
  ) => {
    if (removingKey) return;
    setRemovingKey(key);
    try {
      await removeBaiyunContinuityContextLink({ eventId, target });
      await reload();
    } finally {
      setRemovingKey(null);
    }
  }, [eventId, reload, removingKey]);

  if (!summary || (!summary.memories.length && !summary.currentStates.length)) return null;

  return (
    <View style={styles.panel}>
      <Text style={styles.title}>
        查看关联 · {summary.memories.length + summary.currentStates.length} 项
      </Text>
      {summary.memories.map((memory) => {
        const key = `memory:${memory.id}`;
        return (
          <View key={key} style={styles.row}>
            <View style={styles.copy}>
              <Text numberOfLines={1} style={styles.name}>{memory.title}</Text>
              <Text style={styles.meta}>记忆 · {memory.status === 'archived' ? '已归档' : '活跃'}</Text>
            </View>
            <Pressable
              disabled={Boolean(removingKey)}
              onPress={() => void remove(key, {
                relation: 'memory',
                targetKind: 'memory',
                targetId: memory.id,
              })}
              style={styles.removeButton}
            >
              <Text style={styles.removeText}>{removingKey === key ? '处理中…' : '解除'}</Text>
            </Pressable>
          </View>
        );
      })}
      {summary.currentStates.map((state) => {
        const key = `current-state:${state.id}`;
        return (
          <View key={key} style={styles.row}>
            <View style={styles.copy}>
              <Text numberOfLines={1} style={styles.name}>{state.title}</Text>
              <Text style={styles.meta}>
                当前状态 · {CURRENT_STATE_KIND_LABELS[state.kind] ?? state.kind} · {CURRENT_STATE_STATUS_LABELS[state.status]}
              </Text>
            </View>
            <Pressable
              disabled={Boolean(removingKey)}
              onPress={() => void remove(key, {
                relation: 'current_state',
                targetKind: 'memory_current_state',
                targetId: state.id,
              })}
              style={styles.removeButton}
            >
              <Text style={styles.removeText}>{removingKey === key ? '处理中…' : '解除'}</Text>
            </Pressable>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { borderTopColor: 'rgba(139, 88, 77, 0.16)', borderTopWidth: StyleSheet.hairlineWidth, marginTop: 10, paddingTop: 8, gap: 6 },
  title: { color: '#8B584D', fontSize: 11, fontWeight: '800' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 11, backgroundColor: 'rgba(255,255,255,0.58)', paddingHorizontal: 9, paddingVertical: 7 },
  copy: { flex: 1, gap: 2 },
  name: { color: '#5D4945', fontSize: 11.5, fontWeight: '700' },
  meta: { color: '#90756F', fontSize: 10 },
  removeButton: { borderRadius: 9, borderColor: '#E7C9BF', borderWidth: 1, paddingHorizontal: 8, paddingVertical: 5 },
  removeText: { color: '#9A675C', fontSize: 10, fontWeight: '700' },
});
