import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import type { BaiyunContinuityEvent } from '../ai/behavior/continuityEvent';
import {
  listBaiyunContinuityEventsForContext,
  listOpenBaiyunContinuityEvents,
  setBaiyunContinuityEventsForContextTarget,
} from '../ai/behavior/continuityLedger';
import { presentBaiyunContinuityEvent } from '../ai/behavior/continuityLedgerPresentation';
import { AppText as Text } from '../components/AppText';
import type { MemoryContinuityContextLink } from './memoryDataBoundary';

type Props = {
  target: MemoryContinuityContextLink;
  compact?: boolean;
  onChanged?: () => void | Promise<void>;
};

function mergeEvents(
  first: readonly BaiyunContinuityEvent[],
  second: readonly BaiyunContinuityEvent[],
) {
  const byId = new Map<string, BaiyunContinuityEvent>();
  for (const event of [...first, ...second]) byId.set(event.id, event);
  return [...byId.values()];
}

export function MemoryContinuityLinkPanel({ target, compact = false, onChanged }: Props) {
  const [linkedEvents, setLinkedEvents] = useState<BaiyunContinuityEvent[]>([]);
  const [availableEvents, setAvailableEvents] = useState<BaiyunContinuityEvent[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [managerOpen, setManagerOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    const linked = await listBaiyunContinuityEventsForContext(target);
    setLinkedEvents(linked);
    return linked;
  }, [target.relation, target.targetId, target.targetKind]);

  useEffect(() => {
    void reload().catch(() => setLinkedEvents([]));
  }, [reload]);

  const activeEvents = useMemo(
    () => linkedEvents.filter((event) => event.status === 'open' || event.status === 'waiting'),
    [linkedEvents],
  );
  const historicalEvents = useMemo(
    () => linkedEvents.filter((event) => event.status === 'completed' || event.status === 'cancelled'),
    [linkedEvents],
  );

  const openManager = useCallback(async () => {
    setLoading(true);
    setManagerOpen(true);
    try {
      const [openEvents, linked] = await Promise.all([
        listOpenBaiyunContinuityEvents(),
        listBaiyunContinuityEventsForContext(target),
      ]);
      setAvailableEvents(mergeEvents(openEvents, linked));
      setLinkedEvents(linked);
      setSelectedIds(linked.map((event) => event.id));
    } catch {
      Alert.alert('关联列表暂时没打开', '这次没有修改任何关联，请稍后再试。');
      setManagerOpen(false);
    } finally {
      setLoading(false);
    }
  }, [target.relation, target.targetId, target.targetKind]);

  const save = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    try {
      const outcome = await setBaiyunContinuityEventsForContextTarget({ target, eventIds: selectedIds });
      if (outcome.status === 'target_missing') {
        Alert.alert('关联目标已经不存在', '列表已刷新，本次没有保存。');
        return;
      }
      if (outcome.status === 'event_missing' || outcome.status === 'terminal_event') {
        Alert.alert('牵挂状态已经变化', '列表已刷新，请按最新状态再选择一次。');
        await openManager();
        return;
      }
      if (outcome.status === 'data_epoch_changed') {
        Alert.alert('数据正在切换', '备份或恢复结束后再保存，本次没有改动。');
        return;
      }
      await reload();
      await onChanged?.();
      setManagerOpen(false);
    } catch {
      Alert.alert('关联保存失败', '这次没有产生半份关联，请刷新后再试。');
    } finally {
      setSaving(false);
    }
  }, [onChanged, openManager, reload, saving, selectedIds, target]);

  const toggle = (event: BaiyunContinuityEvent) => {
    const isSelected = selectedIds.includes(event.id);
    const isTerminal = event.status === 'completed' || event.status === 'cancelled';
    if (isTerminal && !isSelected) return;
    setSelectedIds((current) => (
      current.includes(event.id)
        ? current.filter((id) => id !== event.id)
        : [...current, event.id]
    ));
  };

  const manager = (
    <Modal animationType="fade" onRequestClose={() => setManagerOpen(false)} transparent visible={managerOpen}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalPanel}>
          <Text style={styles.modalTitle}>管理相关牵挂</Text>
          <Text style={styles.hint}>可以勾选开启中的事件；历史关联只能保留或解除。</Text>
          <ScrollView contentContainerStyle={styles.eventList} style={styles.eventScroll}>
            {loading ? <Text style={styles.empty}>正在读取账本…</Text> : null}
            {!loading && !availableEvents.length ? <Text style={styles.empty}>现在没有可以关联的牵挂。</Text> : null}
            {availableEvents.map((event) => {
              const selected = selectedIds.includes(event.id);
              const presentation = presentBaiyunContinuityEvent(event);
              const terminal = event.status === 'completed' || event.status === 'cancelled';
              return (
                <Pressable
                  key={event.id}
                  onPress={() => toggle(event)}
                  style={[styles.eventChoice, selected && styles.eventChoiceSelected]}
                >
                  <Text style={styles.check}>{selected ? '✓' : '○'}</Text>
                  <View style={styles.eventCopy}>
                    <Text style={styles.eventTitle}>{presentation.kindLabel} · {event.id.slice(-6)}</Text>
                    <Text style={styles.eventMeta}>
                      {terminal
                        ? event.status === 'completed' ? '历史关联 · 已完成' : '历史关联 · 已取消'
                        : `${presentation.statusLabel} · ${presentation.stageLabel}`}
                    </Text>
                    <Text style={styles.eventMeta}>
                      登记 {new Date(event.occurredAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      {presentation.nextActionLabel ? ` · 继续 ${presentation.nextActionLabel}` : ''}
                    </Text>
                  </View>
                </Pressable>
              );
            })}
          </ScrollView>
          <View style={styles.modalActions}>
            <Pressable disabled={saving} onPress={() => setManagerOpen(false)} style={styles.secondaryButton}>
              <Text style={styles.secondaryText}>取消</Text>
            </Pressable>
            <Pressable disabled={loading || saving} onPress={() => void save()} style={styles.primaryButton}>
              <Text style={styles.primaryText}>{saving ? '保存中…' : '保存关联'}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );

  if (compact) {
    return (
      <>
        <Pressable onPress={() => void openManager()} style={styles.compactButton}>
          <Text style={styles.compactText}>
            关联牵挂{linkedEvents.length ? ` · ${linkedEvents.length}` : ''}
          </Text>
        </Pressable>
        {manager}
      </>
    );
  }

  return (
    <>
      <View style={styles.panel}>
        <View style={styles.header}>
          <View style={styles.eventCopy}>
            <Text style={styles.panelTitle}>相关牵挂</Text>
            <Text style={styles.hint}>关联只提供背景，不会让记忆代替完成回执。</Text>
          </View>
          <Pressable onPress={() => void openManager()} style={styles.compactButton}>
            <Text style={styles.compactText}>管理关联</Text>
          </Pressable>
        </View>
        {activeEvents.map((event) => {
          const presentation = presentBaiyunContinuityEvent(event);
          return (
            <View key={event.id} style={styles.linkedRow}>
              <Text style={styles.eventTitle}>{presentation.kindLabel}</Text>
              <Text style={styles.eventMeta}>{presentation.statusLabel} · {presentation.stageLabel} · {event.id.slice(-6)}</Text>
            </View>
          );
        })}
        {!activeEvents.length ? <Text style={styles.empty}>目前没有开启中的关联。</Text> : null}
        {historicalEvents.length ? (
          <>
            <Pressable onPress={() => setHistoryOpen((value) => !value)}>
              <Text style={styles.historyToggle}>{historyOpen ? '收起历史关联' : `历史关联 · ${historicalEvents.length}`}</Text>
            </Pressable>
            {historyOpen ? historicalEvents.map((event) => {
              const presentation = presentBaiyunContinuityEvent(event);
              return (
                <View key={event.id} style={styles.linkedRow}>
                  <Text style={styles.eventTitle}>{presentation.kindLabel}</Text>
                  <Text style={styles.eventMeta}>{event.status === 'completed' ? '已完成' : '已取消'} · {event.id.slice(-6)}</Text>
                </View>
              );
            }) : null}
          </>
        ) : null}
      </View>
      {manager}
    </>
  );
}

const styles = StyleSheet.create({
  panel: { borderRadius: 16, backgroundColor: '#F7FBFF', borderColor: '#D8EAF8', borderWidth: 1, padding: 12, marginTop: 10, gap: 8 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  panelTitle: { color: '#385163', fontSize: 13, fontWeight: '700' },
  hint: { color: '#7993A3', fontSize: 11, lineHeight: 16 },
  linkedRow: { borderRadius: 12, backgroundColor: '#FFFFFF', borderColor: '#E2EDF4', borderWidth: 1, padding: 9, gap: 3 },
  eventTitle: { color: '#385163', fontSize: 12, fontWeight: '700' },
  eventMeta: { color: '#728B9B', fontSize: 10.5, lineHeight: 15 },
  empty: { color: '#91A7B3', fontSize: 11, lineHeight: 17 },
  historyToggle: { color: '#5683A9', fontSize: 11, fontWeight: '700' },
  compactButton: { alignSelf: 'flex-start', borderRadius: 10, backgroundColor: '#EFF7FC', borderColor: '#D8EAF8', borderWidth: 1, paddingHorizontal: 9, paddingVertical: 6 },
  compactText: { color: '#5683A9', fontSize: 11, fontWeight: '700' },
  modalBackdrop: { flex: 1, justifyContent: 'center', padding: 22, backgroundColor: 'rgba(28, 42, 54, 0.34)' },
  modalPanel: { width: '100%', maxWidth: 520, alignSelf: 'center', borderRadius: 22, backgroundColor: '#F7FBFF', borderColor: '#D8EAF8', borderWidth: 1, padding: 15, gap: 10 },
  modalTitle: { color: '#385163', fontSize: 17, fontWeight: '800' },
  eventScroll: { maxHeight: 430 },
  eventList: { gap: 8, paddingVertical: 3 },
  eventChoice: { flexDirection: 'row', alignItems: 'flex-start', gap: 9, borderRadius: 13, borderColor: '#DDEAF2', borderWidth: 1, backgroundColor: '#FFFFFF', padding: 10 },
  eventChoiceSelected: { borderColor: '#8DBCD1', backgroundColor: '#EFF9FD' },
  check: { color: '#5F8BA2', fontSize: 18, lineHeight: 22, fontWeight: '700' },
  eventCopy: { flex: 1, gap: 3 },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
  secondaryButton: { borderRadius: 12, borderColor: '#D8EAF8', borderWidth: 1, backgroundColor: '#FFFFFF', paddingHorizontal: 13, paddingVertical: 9 },
  secondaryText: { color: '#5683A9', fontSize: 12, fontWeight: '700' },
  primaryButton: { borderRadius: 12, backgroundColor: '#5683A9', paddingHorizontal: 13, paddingVertical: 9 },
  primaryText: { color: '#FFFFFF', fontSize: 12, fontWeight: '700' },
});
