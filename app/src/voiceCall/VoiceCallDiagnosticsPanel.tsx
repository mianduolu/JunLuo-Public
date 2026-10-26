import * as Clipboard from 'expo-clipboard';
import { useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppText as Text } from '../components/AppText';
import { fetchVoiceCallDiagnostics } from './voiceCallRoomClient';
import {
  formatVoiceCallDiagnosticCopy,
  listVoiceCallDiagnostics,
  updateVoiceCallDiagnostic,
  type VoiceCallDiagnosticEvent,
  type VoiceCallDiagnosticRecord,
} from './voiceCallDiagnostics';
import { getVoiceCallMemoryReviewStatus, type VoiceCallMemoryReviewStatus } from './voiceCallMemoryReviewStatus';

type Props = { onClose: () => void; visible: boolean };
type Stage = '连接' | '收音' | '识别' | '文字生成' | '语音播放' | '保存结果';
const stages: Stage[] = ['连接', '收音', '识别', '文字生成', '语音播放', '保存结果'];

function stageFor(event: string): Stage {
  if (/record|summary|memory|candidate|save/.test(event)) return '保存结果';
  if (/playback|tts|speech|budget/.test(event)) return '语音播放';
  if (/model|context|brain|cognition/.test(event)) return '文字生成';
  if (/stt|emotion|transcri/.test(event)) return '识别';
  if (/vad|mic|audio|frame/.test(event)) return '收音';
  return '连接';
}

function displayTime(at: number) {
  return new Date(at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function directionLabel(direction: VoiceCallDiagnosticRecord['direction']) {
  return direction === 'incoming' ? '云云来电' : direction === 'outgoing' ? '拨出' : '测试接通';
}

function summaryNumber(record: VoiceCallDiagnosticRecord, key: string) {
  const value = record.backend?.summary[key];
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '未记录';
}

function reviewLine(record: VoiceCallDiagnosticRecord, memory: VoiceCallMemoryReviewStatus | null) {
  if (!memory) return '未记录';
  const filtered = Math.max(memory.filtered,
    (record.candidateCount ?? 0) - memory.pending - memory.saved - memory.discarded);
  return `待确认 ${memory.pending} · 已保存 ${memory.saved} · 已丢弃 ${memory.discarded} · 已过滤 ${filtered}`;
}

function joinedEvents(record: VoiceCallDiagnosticRecord) {
  const serverIds = new Set(record.backend?.events.map((event) => event.eventId).filter(Boolean));
  return [...record.events.filter((event) => !serverIds.has(event.eventId)), ...(record.backend?.events ?? [])]
    .sort((a, b) => a.at - b.at);
}

function turnRows(events: VoiceCallDiagnosticEvent[]) {
  const turns = new Map<string, string[]>();
  for (const item of events) {
    const id = item.details.turnId ?? item.details.sourceTurnId;
    if (typeof id !== 'string') continue;
    const elapsed = item.details.elapsedMs ?? item.details.latencyMs ?? item.details.durationMs;
    if (typeof elapsed !== 'number') continue;
    const labels: Record<string, string> = {
      stt_result: '识别', emotion_result: '情绪',
      voice_call_context_ready: '上下文', voice_call_model_request_started: '模型排队',
      voice_call_model_request_completed: '模型请求', playback_started: '手机等待播放通知',
    };
    const label = labels[item.event];
    if (!label || (item.event === 'playback_started' && item.source !== 'app')) continue;
    turns.set(id, [...(turns.get(id) ?? []), `${label} ${elapsed} ms`]);
  }
  return [...turns.entries()].slice(-20);
}

function stageLine(stage: Stage, events: VoiceCallDiagnosticEvent[], record: VoiceCallDiagnosticRecord) {
  const matching = events.filter((item) => stageFor(item.event) === stage);
  if (stage === '连接') {
    if (record.connectedAt) return `已接通 · ${Math.max(0, record.connectedAt - record.createdAt)} ms`;
    return record.endedAt ? `未接通 · ${record.endReason ?? '原因未记录'}` : '连接中或结束状态未确认';
  }
  if (stage === '保存结果') return `通话小记：${record.summaryStatus ?? '未记录'} · 候选：${record.candidateCount ?? '未记录'}`;
  if (!matching.length) return '未记录';
  const latest = (name: string) => matching.findLast((item) => item.event === name);
  if (stage === '收音') {
    const vad = latest('vad_status');
    if (vad) return `VAD ${vad.details.state ?? '未记录'} · 轮次 ${vad.details.turns ?? '未记录'}`;
  }
  if (stage === '识别') {
    const stt = latest('stt_result');
    const emotion = latest('emotion_result');
    return [stt ? `STT ${stt.details.provider ?? '未记录'} · ${stt.details.latencyMs ?? '未记录'} ms${stt.details.fallback ? ' · fallback' : ''}` : 'STT 未记录',
      emotion ? `情绪 ${emotion.details.label ?? '未记录'} · ${emotion.details.score ?? '未记录'} · ${emotion.details.latencyMs ?? '未记录'} ms` : '情绪未记录'].join('；');
  }
  if (stage === '文字生成') {
    const context = latest('voice_call_context_ready');
    const model = latest('voice_call_model_request_completed');
    const response = latest('voice_call_model_response');
    if (response?.details.errorCode === 'call_reply_not_spoken') {
      return '回复格式异常，未作为通话正文 · call_reply_not_spoken';
    }
    return `上下文 ${context?.details.elapsedMs ?? '未记录'} ms · 模型 ${model?.details.latencyMs ?? '未记录'} ms`;
  }
  if (stage === '语音播放') {
    const tts = latest('tts_synthesis_started');
    const worker = latest('test_speech_worker_started');
    const firstPcm = latest('tts_first_pcm_ready');
    const playback = [...matching].reverse().find((item) => /^playback_(started|completed|interrupted|failed)$/.test(item.event));
    return `${playback?.event ?? '未记录'} · ${worker?.details.provider ?? tts?.details.provider ?? 'provider 未记录'} · ${tts?.details.textLength ?? '未记录'} 字符 / ${tts?.details.textUtf8Bytes ?? '未记录'} 字节 · 缓存 ${worker?.details.cacheHit === true ? '命中' : worker?.details.cacheHit === false ? '未命中' : '未记录'} · 首包 ${firstPcm?.details.latencyMs ?? '未记录'} ms`;
  }
  const last = matching[matching.length - 1];
  const elapsed = last.details.elapsedMs ?? last.details.latencyMs ?? last.details.durationMs;
  return `${last.event}${typeof elapsed === 'number' ? ` · ${elapsed} ms` : ''}${last.details.errorCode ? ` · ${last.details.errorCode}` : ''}`;
}

export function VoiceCallDiagnosticsPanel({ onClose, visible }: Props) {
  const insets = useSafeAreaInsets();
  const [records, setRecords] = useState<VoiceCallDiagnosticRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState('');
  const [memory, setMemory] = useState<VoiceCallMemoryReviewStatus | null>(null);
  const selected = records.find((item) => item.id === selectedId) ?? records[0];
  const events = useMemo(() => selected ? joinedEvents(selected) : [], [selected]);
  const rounds = useMemo(() => turnRows(events), [events]);

  useEffect(() => {
    if (!visible) return;
    let mounted = true;
    setLoading(true);
    setNotice('');
    void listVoiceCallDiagnostics().then((items) => {
      if (!mounted) return;
      setRecords(items);
      setSelectedId((previous) => previous && items.some((item) => item.id === previous) ? previous : items[0]?.id ?? null);
    }).catch(() => { if (mounted) setNotice('本机诊断读取失败'); })
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, [visible]);

  useEffect(() => {
    setMemory(null);
    if (!visible || !selected?.callId) return;
    let mounted = true;
    void getVoiceCallMemoryReviewStatus(selected.callId).then((value) => { if (mounted) setMemory(value); }).catch(() => undefined);
    return () => { mounted = false; };
  }, [selected?.callId, visible]);

  const refresh = async () => {
    if (!selected || refreshing) return;
    setRefreshing(true);
    setNotice('');
    try {
      if (selected.callId) {
        const backend = await fetchVoiceCallDiagnostics(selected.callId);
        await updateVoiceCallDiagnostic(selected.id, { backend, backendFetchedAt: Date.now(), backendFetchError: undefined });
      }
      setRecords(await listVoiceCallDiagnostics());
      if (selected.callId) setMemory(await getVoiceCallMemoryReviewStatus(selected.callId).catch(() => null));
      setNotice(selected.callId ? '诊断已刷新' : '本机诊断已刷新');
    } catch {
      await updateVoiceCallDiagnostic(selected.id, { backendFetchError: 'backend_unavailable' });
      setRecords(await listVoiceCallDiagnostics());
      setNotice('后端暂时不可读，已保留本机诊断');
    } finally { setRefreshing(false); }
  };

  const copy = async () => {
    if (!selected) return;
    try {
      const memoryLine = memory ? `\n记忆审核：${reviewLine(selected, memory)}` : '';
      await Clipboard.setStringAsync(formatVoiceCallDiagnosticCopy(selected) + memoryLine);
      setNotice('诊断已复制');
    } catch { setNotice('复制失败'); }
  };

  return (
    <Modal animationType="slide" onRequestClose={onClose} visible={visible}>
      <View style={[styles.page, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 12 }]}>
        <View style={styles.header}>
          <Text style={styles.title}>通话诊断</Text>
          <Pressable accessibilityLabel="关闭通话诊断" onPress={onClose} style={styles.action}><Text style={styles.actionText}>关闭</Text></Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.heading}>最近通话</Text>
          {notice ? <Text style={styles.notice}>{notice}</Text> : null}
          {loading ? <Text style={styles.muted}>正在读取...</Text> : records.length === 0 ? <Text style={styles.muted}>最近 7 天没有通话诊断。</Text> : records.map((item) => (
            <Pressable key={item.id} onPress={() => { setSelectedId(item.id); setNotice(''); }} style={[styles.listItem, selected?.id === item.id && styles.selected]}>
              <Text style={styles.itemTitle}>{directionLabel(item.direction)} · {displayTime(item.createdAt)}</Text>
              <Text style={styles.muted}>{item.connectedAt ? '已接通' : '未接通'} · {item.endedAt ? item.endReason ?? '正常结束' : '结束状态未确认'}</Text>
            </Pressable>
          ))}
          {selected ? (
            <>
              <View style={styles.detailHeader}>
                <Text style={styles.heading}>环节与耗时</Text>
                <View style={styles.actions}>
                  <Pressable disabled={refreshing} onPress={() => void refresh()} style={styles.action}><Text style={styles.actionText}>{refreshing ? '刷新中' : '刷新'}</Text></Pressable>
                  <Pressable onPress={() => void copy()} style={styles.action}><Text style={styles.actionText}>复制诊断</Text></Pressable>
                </View>
              </View>
              <Text style={styles.muted}>后端：{selected.backend ? `快照 ${displayTime(selected.backendFetchedAt ?? 0)}` : '未取得，以下为本机记录'}</Text>
              <Text style={styles.muted}>事件：本机 {selected.eventCount} 条 · 后端 {selected.backend?.eventCount ?? '未记录'} 条</Text>
              {stages.map((stage) => (
                <View key={stage} style={styles.stageRow}>
                  <Text style={styles.stageName}>{stage}</Text>
                  <Text style={styles.stageValue}>{stageLine(stage, events, selected)}</Text>
                </View>
              ))}
              <View style={styles.stageRow}><Text style={styles.stageName}>统计</Text><Text style={styles.stageValue}>VAD {summaryNumber(selected, 'vadTurns')} · 打断 {summaryNumber(selected, 'interruptions')} · 照护 {summaryNumber(selected, 'careTriggers')}</Text></View>
              <View style={styles.stageRow}><Text style={styles.stageName}>记忆审核</Text><Text style={styles.stageValue}>{reviewLine(selected, memory)}</Text></View>
              <Text style={styles.heading}>按轮耗时</Text>
              {rounds.length ? rounds.map(([id, values]) => (
                <View key={id} style={styles.stageRow}>
                  <Text style={styles.stageName}>{id}</Text>
                  <Text style={styles.stageValue}>{values.join(' · ')}</Text>
                </View>
              )) : <Text style={styles.muted}>未记录按轮耗时。</Text>}
              <Text style={styles.heading}>事件明细</Text>
              {(selected.truncated || selected.backend?.truncated) ? <Text style={styles.muted}>明细已截短，仅保留开头 50 条和最新 450 条。</Text> : null}
              {events.length ? events.map((item, index) => (
                <View key={`${item.source}-${item.eventId ?? index}-${index}`} style={styles.eventRow}>
                  <Text style={styles.eventTitle}>{displayTime(item.at)} · {item.event}</Text>
                  <Text style={styles.muted}>{item.source} · {JSON.stringify(item.details)}</Text>
                </View>
              )) : <Text style={styles.muted}>未记录事件。</Text>}
            </>
          ) : null}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  page: { backgroundColor: '#F7F8F6', flex: 1, paddingHorizontal: 18 },
  header: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', minHeight: 48 },
  title: { color: '#243A38', fontSize: 21, fontWeight: '700' },
  heading: { color: '#243A38', fontSize: 16, fontWeight: '700', marginTop: 20, marginBottom: 8 },
  content: { paddingBottom: 32 },
  listItem: { borderBottomColor: '#D5DDDA', borderBottomWidth: 1, paddingVertical: 11 },
  selected: { borderLeftColor: '#4B8E74', borderLeftWidth: 3, paddingLeft: 10 },
  itemTitle: { color: '#263C38', fontSize: 15, fontWeight: '600' },
  muted: { color: '#687A76', fontSize: 13, lineHeight: 19 },
  detailHeader: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  actions: { flexDirection: 'row', gap: 8 },
  action: { borderColor: '#A9C5B7', borderRadius: 6, borderWidth: 1, minHeight: 36, justifyContent: 'center', paddingHorizontal: 12 },
  actionText: { color: '#326A54', fontSize: 14, fontWeight: '600' },
  notice: { color: '#326A54', fontSize: 13, marginBottom: 8 },
  stageRow: { borderBottomColor: '#E0E6E2', borderBottomWidth: 1, paddingVertical: 10 },
  stageName: { color: '#263C38', fontSize: 14, fontWeight: '700' },
  stageValue: { color: '#52645F', fontSize: 13, lineHeight: 19, marginTop: 3 },
  eventRow: { borderBottomColor: '#E0E6E2', borderBottomWidth: 1, paddingVertical: 8 },
  eventTitle: { color: '#263C38', fontSize: 13, fontWeight: '600' },
});
