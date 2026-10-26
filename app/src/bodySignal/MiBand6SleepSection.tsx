import React, { useEffect, useState } from 'react';
import { AppState, Pressable, StyleSheet, Text, View } from 'react-native';
import { activityWeek } from './bodySignalActivitySummary';
import { loadPersistedBodySignalDeviceProfiles } from './device/bodySignalDeviceRepository';
import type { BodySignalDeviceProfile } from './device/bodySignalDeviceTypes';
import { presentMiBand6SleepDay } from './miBand6SleepPolicy';
import { miBand6SleepPercentages } from './miBand6SleepStages';
import { loadMiBand6SleepHistory } from './miBand6SleepStore';
import { getMiBand6SleepSyncState, miBand6SleepSyncError, subscribeMiBand6SleepSync, syncMiBand6SleepHistory } from './miBand6SleepSync';

type History = Awaited<ReturnType<typeof loadMiBand6SleepHistory>>;
function stageDuration(minutes: number) {
  const hours = Math.floor(minutes / 60), remainder = minutes % 60;
  return `${hours ? `${hours}小时` : ''}${remainder || !hours ? `${remainder}分` : ''}`;
}
export function MiBand6SleepSection({ onOpenTrend }: { onOpenTrend?: (deviceProfileId: string) => void } = {}) {
  const [profiles, setProfiles] = useState<BodySignalDeviceProfile[]>([]);
  const [selected, setSelected] = useState<string>();
  const [view, setView] = useState<{ profileId?: string; history?: History; now: number; error?: string }>({ now: Date.now() });
  const [sync, setSync] = useState(getMiBand6SleepSyncState);
  useEffect(() => {
    let alive = true, version = 0;
    const refresh = async () => {
      const mine = ++version;
      try {
        const available = (await loadPersistedBodySignalDeviceProfiles()).filter(profile => profile.family === 'mi_band_6');
        const profile = available.find(item => item.id === selected) ?? available.find(item => item.isPrimary) ?? available[0];
        const now = Date.now();
        const history = profile ? await loadMiBand6SleepHistory(profile.id, now) : undefined;
        if (alive && mine === version) { setProfiles(available); setView({ profileId: profile?.id, history, now }); }
      } catch {
        if (alive && mine === version) setView({ now: Date.now(), error: '睡眠记录暂时读取失败，请稍后重新进入。' });
      }
    };
    const unsubscribe = subscribeMiBand6SleepSync(() => {
      const next = getMiBand6SleepSyncState();
      if (alive) setSync(next);
      if (!next.busy) void refresh();
    });
    const foreground = AppState.addEventListener('change', next => { if (next === 'active') void refresh(); });
    // Local refresh only: midnight expiry never initiates a BLE read.
    const timer = setInterval(() => { if (AppState.currentState === 'active') void refresh(); }, 60_000);
    void refresh();
    return () => { alive = false; version++; unsubscribe(); foreground.remove(); clearInterval(timer); };
  }, [selected]);
  if (!profiles.length && !view.error) return null;
  const records = new Map(view.history?.records.map(item => [item.dateKey, item]) ?? []);
  const statuses = new Map(view.history?.lastBatch?.days.map(item => [item.dateKey, item]) ?? []);
  const dates = activityWeek(view.now).reverse();
  const selectedProfile = profiles.find(profile => profile.id === view.profileId);
  return <View style={styles.section}>
    <Text style={styles.title}>近七天 · 主要睡眠</Text>
    <Text style={styles.note}>{selectedProfile?.displayName ?? 'Mi Band 6'} · 按醒来日期记录时长</Text>
    {view.profileId && onOpenTrend ? <Pressable accessibilityRole="button" style={styles.device}
      onPress={() => onOpenTrend(view.profileId!)}><Text style={styles.note}>查看七天趋势 ›</Text></Pressable> : null}
    {profiles.length > 1 ? <View style={styles.devices}>{profiles.map(profile => <Pressable key={profile.id}
      accessibilityRole="button" accessibilityState={{ selected: profile.id === view.profileId }}
      onPress={() => {
        if (profile.id === view.profileId) return;
        setView({ now: Date.now() }); setSelected(profile.id);
      }} style={styles.device}>
      <Text style={styles.note}>{profile.id === view.profileId ? '✓ ' : ''}{profile.displayName}</Text>
    </Pressable>)}</View> : null}
    {view.history ? dates.map(dateKey => {
      const record = records.get(dateKey);
      const row = presentMiBand6SleepDay(dateKey, record, statuses.get(dateKey));
      const stages = record?.stages;
      const percentages = stages ? miBand6SleepPercentages(stages.deepMinutes, stages.lightMinutes) : undefined;
      return <View key={dateKey} style={styles.row}>
        <Text style={styles.date}>{dateKey.slice(5).replace('-', '/')}</Text>
        <View style={styles.value}><Text style={styles.duration}>{row.text}</Text>
          {stages && percentages ? <View style={styles.stages}>
            <View style={styles.stageBar} accessible={false} importantForAccessibility="no-hide-descendants">
              <View style={[styles.deep, { width: `${stages.deepMinutes / (stages.deepMinutes + stages.lightMinutes) * 100}%` }]} />
              <View style={[styles.light, { width: `${stages.lightMinutes / (stages.deepMinutes + stages.lightMinutes) * 100}%` }]} />
            </View>
            <View style={styles.legend}><View style={[styles.swatch, styles.deep]} />
              <Text style={styles.note}>深睡 {stageDuration(stages.deepMinutes)} · {percentages.deep}%</Text></View>
            <View style={styles.legend}><View style={[styles.swatch, styles.light]} />
              <Text style={styles.note}>浅睡 {stageDuration(stages.lightMinutes)} · {percentages.light}%</Text></View>
          </View> : null}
          {row.note ? <Text style={styles.note}>{row.note}</Text> : null}</View>
      </View>;
    }) : null}
    {view.history?.records.some(record => record.stages) ? <Text style={styles.note}>深浅睡为设备算法估计，仅供参考。</Text> : null}
    <Text style={styles.note}>当天等待记录完整后再保存；暂未包含午睡和补觉合计。没有记录不表示没有睡。</Text>
    <Pressable accessibilityRole="button" disabled={sync.busy} style={[styles.button, sync.busy && styles.disabled]}
      onPress={() => { void syncMiBand6SleepHistory('manual').catch(() => undefined); }}>
      <Text style={styles.buttonText}>{sync.busy ? '正在同步睡眠记录…' : '同步当前手环睡眠记录'}</Text>
    </Pressable>
    {view.history?.lastBatch ? <Text style={styles.note}>最近同步：{new Date(view.history.lastBatch.observedAt).toLocaleString('zh-CN', { hour12: false })}</Text> : null}
    {view.error ? <Text style={styles.note}>{view.error}</Text> : null}
    {sync.error ? <Text style={styles.note}>{miBand6SleepSyncError(sync.error)}</Text> : null}
  </View>;
}
const styles = StyleSheet.create({
  section: { marginTop: 16, padding: 16, borderRadius: 14, backgroundColor: '#F7F8F3', gap: 10 },
  title: { fontSize: 17, fontWeight: '700', color: '#455348' },
  note: { fontSize: 13, lineHeight: 21, color: '#667466', flexShrink: 1 },
  row: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 9, gap: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#DCE3D8' },
  date: { fontSize: 15, color: '#667466', minWidth: 48, flexShrink: 0 },
  value: { flex: 1, alignItems: 'flex-end', gap: 4 },
  duration: { fontSize: 16, lineHeight: 24, color: '#455348', flexShrink: 1, textAlign: 'right' },
  stages: { width: '100%', gap: 6, marginTop: 4 },
  stageBar: { width: '100%', height: 8, flexDirection: 'row', borderRadius: 4, overflow: 'hidden' },
  deep: { backgroundColor: '#526E59' }, light: { backgroundColor: '#B5C9A9' },
  legend: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  swatch: { width: 10, height: 10, borderRadius: 2, flexShrink: 0 },
  devices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  device: { padding: 8, borderRadius: 8, backgroundColor: '#E8EEE3' },
  button: { backgroundColor: '#607D65', borderRadius: 8, padding: 13, alignItems: 'center' },
  buttonText: { fontSize: 15, color: '#FFF', flexShrink: 1 }, disabled: { opacity: 0.45 },
});
