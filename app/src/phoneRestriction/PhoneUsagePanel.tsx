import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { AppText as Text } from '../components/AppText';
import type { PhoneUsageAppSummary } from '../phoneActivity/phoneActivityStore';
import { formatPhoneUsageDuration, formatPhoneUsageUpdatedAt } from './phoneUsageFormatting';
import type { PhoneUsagePanelState } from './usePhoneUsagePanel';

export function PhoneUsagePanel({ panel, onOpenManager }: {
  panel: PhoneUsagePanelState;
  onOpenManager?: () => void;
}) {
  const [period, setPeriod] = useState<'today' | 'week'>('today');
  const { summary, loading, error, comment, commentLoading, commentError, refresh } = panel;
  const apps = summary ? period === 'today' ? summary.todayTopApps : summary.weekTopApps : [];
  const totalDuration = summary ? period === 'today' ? summary.days[0]?.totalDurationMs ?? 0
    : summary.days.reduce((total, day) => total + day.totalDurationMs, 0) : null;
  const visibleDays = summary?.days.filter(day => day.totalDurationMs > 0).slice(0, 7) ?? [];
  const renderRows = (items: PhoneUsageAppSummary[]) => {
    const maximum = Math.max(1, items[0]?.durationMs ?? 0);
    return items.map(item => (
      <View key={item.source || item.title} style={styles.appRow}>
        <View style={styles.appCopy}>
          <Text numberOfLines={1} style={styles.appName}>{item.title}</Text>
          <Text style={styles.duration}>{formatPhoneUsageDuration(item.durationMs)}</Text>
        </View>
        <View style={styles.barTrack}><View style={[styles.barFill, {
          width: `${Math.min(100, Math.round(item.durationMs / maximum * 100))}%`,
        }]} /></View>
      </View>
    ));
  };

  return (
    <View style={styles.stack}>
      <View style={styles.toolbar}>
        <View style={styles.segment}>
          {(['today', 'week'] as const).map(value => (
            <Pressable key={value} accessibilityRole="button" accessibilityState={{ selected: period === value }}
              onPress={() => setPeriod(value)} style={[styles.segmentItem, period === value && styles.segmentSelected]}>
              <Text style={[styles.segmentText, period === value && styles.segmentSelectedText]}>{value === 'today' ? '今天' : '近一周'}</Text>
            </Pressable>
          ))}
        </View>
        <Pressable accessibilityRole="button" disabled={loading} onPress={() => void refresh()} style={styles.refresh}>
          <Text style={styles.action}>{loading ? '统计中…' : '刷新'}</Text>
        </Pressable>
      </View>

      <View style={styles.card}>
        <Text style={styles.meta}>{period === 'today' ? '今日使用' : '最近7天'}</Text>
        <Text style={styles.total}>{totalDuration === null ? '—' : formatPhoneUsageDuration(totalDuration)}</Text>
        {summary?.updatedAt ? <Text style={styles.meta}>{loading ? '更新中 · 上次' : '更新于'} {formatPhoneUsageUpdatedAt(summary.updatedAt)}</Text> : null}
        {summary && panel.ownUsageNote ? <Text style={styles.meta}>{panel.ownUsageNote}</Text> : null}
        {loading ? <View style={styles.loading}><ActivityIndicator size="small" color="#5D8EBA" /><Text style={styles.meta}>正在统计手机使用记录…</Text></View> : null}
        {error ? <View style={styles.readState}>
          <Text style={styles.status}>{error}{summary ? ' 下方保留上次读取的统计。' : ''}</Text>
          <Pressable accessibilityRole="button" disabled={loading} onPress={() => void refresh()} style={styles.retry}>
            <Text style={styles.action}>重新统计</Text>
          </Pressable>
        </View> : null}
        {apps.length ? <View style={styles.ranking}>
          {renderRows(apps)}
          <Text style={styles.meta}>{panel.ownUsageNote?.startsWith('含系统可读取的君落用量') ? period === 'today' ? '今天0点到现在' : '最近7天' : period === 'today' ? `今天0点到现在 · ${summary?.days[0]?.segments ?? 0}段`
            : `最近7天 · ${summary?.segmentCount ?? 0}段`}</Text>
        </View> : summary && !loading && !error ? <View style={styles.readState}>
          <Text style={styles.status}>还没有足够的手机使用记录，可以先启动小管家再切几个App试试。</Text>
          {onOpenManager ? <Pressable accessibilityRole="button" onPress={onOpenManager} style={styles.retry}>
            <Text style={styles.action}>前往小管家</Text>
          </Pressable> : null}
        </View> : null}
      </View>

      {period === 'week' && visibleDays.length ? <View style={styles.card}>
        <Text style={styles.sectionTitle}>分日记录</Text>
        {visibleDays.map(day => <View key={day.dateKey} style={styles.dayRow}>
          <Text style={styles.dayDate}>{day.dateKey.slice(5).replace('-', '/')}</Text>
          <View style={styles.dayCopy}>
            <Text style={styles.dayDuration}>{formatPhoneUsageDuration(day.totalDurationMs)}</Text>
            <Text numberOfLines={2} style={styles.meta}>{day.topApps.map(app => app.title).join(' / ') || '暂无App'}</Text>
          </View>
        </View>)}
      </View> : null}

      {comment || commentLoading || commentError ? <View style={styles.card}>
        <Text style={styles.sectionTitle}>今日点评</Text>
        {comment ? <Text style={styles.comment}>{comment}</Text> : null}
        {commentLoading ? <Text style={styles.meta}>正在读取点评…</Text> : null}
        {commentError ? <View style={styles.readState}>
          <Text style={styles.status}>{commentError}</Text>
          <Pressable accessibilityRole="button" disabled={loading || commentLoading} onPress={() => void refresh()} style={styles.retry}>
            <Text style={styles.action}>重试点评</Text>
          </Pressable>
        </View> : null}
      </View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 15 },
  toolbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  segment: { flexDirection: 'row', backgroundColor: 'rgba(255,255,255,0.8)', borderRadius: 16, padding: 4, flex: 1 },
  segmentItem: { flex: 1, minHeight: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 12 },
  segmentSelected: { backgroundColor: '#EAF4FC' },
  segmentText: { color: '#7A8795', fontSize: 17 },
  segmentSelectedText: { color: '#3E668E' },
  refresh: { padding: 12, minHeight: 44, justifyContent: 'center' },
  action: { fontSize: 17, color: '#557EAC' },
  card: { backgroundColor: 'rgba(255,255,255,0.94)', borderRadius: 23, padding: 20 },
  meta: { color: '#798899', fontSize: 17, lineHeight: 25 },
  total: { color: '#384052', fontSize: 32, lineHeight: 45, marginTop: 8, marginBottom: 4 },
  sectionTitle: { color: '#384052', fontSize: 20, lineHeight: 28, marginBottom: 10 },
  loading: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 14 },
  readState: { marginTop: 12, gap: 4 },
  status: { color: '#798899', fontSize: 17, lineHeight: 26 },
  retry: { alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center', paddingVertical: 8 },
  ranking: { marginTop: 21, gap: 17 },
  appRow: { gap: 8 },
  appCopy: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  appName: { flex: 1, color: '#384052', fontSize: 18, lineHeight: 25 },
  barTrack: { height: 5, backgroundColor: '#ECF3F9', borderRadius: 3, overflow: 'hidden' },
  barFill: { height: '100%', backgroundColor: '#91BBDF', borderRadius: 3 },
  duration: { maxWidth: 118, color: '#6C7C8F', fontSize: 17, lineHeight: 24, textAlign: 'right' },
  dayRow: { flexDirection: 'row', alignItems: 'center', gap: 16, paddingVertical: 13, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#E8EFF4' },
  dayDate: { color: '#6C7C8F', fontSize: 17, width: 52 },
  dayCopy: { flex: 1, alignItems: 'flex-end' },
  dayDuration: { color: '#384052', fontSize: 17, lineHeight: 26 },
  comment: { color: '#384052', fontSize: 18, lineHeight: 29 },
});
