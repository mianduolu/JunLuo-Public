import { useEffect, useState } from 'react';
import { AppState, DeviceEventEmitter, Image, StyleSheet, View } from 'react-native';

import { homeImages } from '../assets/homeImages';
import { canCommitBackupRestoreDataEpoch, captureBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { dateKeyFromTimestamp } from '../schedule/dateTimeSelection';
import { selectHomeNowSchedule, type HomeNowSchedule } from '../schedule/homeNowSchedule';
import { SCHEDULE_DATA_CHANGED_EVENT } from '../schedule/scheduleEvents';
import { loadScheduleItemsForDate, type ScheduleOccurrence } from '../schedule/scheduleStore';
import { colors } from '../theme/colors';
import { AppText as Text } from './AppText';
import { ScalePressable } from './ScalePressable';

type Snapshot = { dateKey: string; items: ScheduleOccurrence[]; failed?: boolean };

export function HomeNowScheduleCard({ active, size, onPress }: { active: boolean; size: number; onPress: () => void }) {
  const [now, setNow] = useState(Date.now());
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);

  useEffect(() => {
    if (!active) return;
    let current = true;
    let foreground = AppState.currentState !== 'background' && AppState.currentState !== 'inactive';
    let revision = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      if (!current || !foreground) return;
      const requestRevision = ++revision;
      const dataEpoch = captureBackupRestoreDataEpoch();
      const at = Date.now();
      const dateKey = dateKeyFromTimestamp(at);
      setNow(at);
      const canApply = () => current && foreground && revision === requestRevision
        && canCommitBackupRestoreDataEpoch(dataEpoch) && dateKeyFromTimestamp(Date.now()) === dateKey;
      // Read existing occurrences only: this small display must not generate a schedule horizon.
      void loadScheduleItemsForDate(new Date(at), true, true).then(items => {
        if (canApply()) setSnapshot({ dateKey, items });
      }).catch(error => {
        if (!canApply()) return;
        setSnapshot({ dateKey, items: [], failed: true });
        console.warn('[home-now-schedule] read failed', error);
      });
      if (timer) clearTimeout(timer);
      timer = setTimeout(refresh, 60_000 - at % 60_000);
    };
    refresh();
    const appState = AppState.addEventListener('change', state => {
      foreground = state === 'active';
      revision += 1;
      if (timer) clearTimeout(timer);
      if (foreground) refresh();
    });
    const schedules = DeviceEventEmitter.addListener(SCHEDULE_DATA_CHANGED_EVENT, refresh);
    return () => {
      current = false;
      revision += 1;
      if (timer) clearTimeout(timer);
      appState.remove();
      schedules.remove();
    };
  }, [active]);

  const summary = (owner: 'I' | 'you'): HomeNowSchedule => {
    if (!snapshot || snapshot.dateKey !== dateKeyFromTimestamp(now)) return { title: '读取中' };
    if (snapshot.failed) return { title: '读取失败' };
    return selectHomeNowSchedule(snapshot.items, owner, now);
  };
  const cloud = summary('I');
  const hamster = summary('you');
  return (
    <ScalePressable onPress={onPress} accessibilityRole="button"
      accessibilityLabel={`现在该做。白云小姐：${cloud.caption ?? ''} ${cloud.title}。小仓鼠：${hamster.caption ?? ''} ${hamster.title}。打开今日时间轴`}
      style={[styles.card, { width: size, height: size }]}>
      <Image source={homeImages.timeline} resizeMode="contain" style={styles.image} />
      <Text maxFontSizeMultiplier={1.3} style={styles.heading}>现在该做</Text>
      {[cloud, hamster].map((item, index) => (
        <View key={index} style={[styles.entry, { top: index === 0 ? '34%' : '66%' }]}>
          {item.caption ? <Text numberOfLines={1} maxFontSizeMultiplier={1.3} style={styles.caption}>{item.caption}</Text> : null}
          <Text numberOfLines={2} maxFontSizeMultiplier={1.3} style={styles.title}>{item.title}</Text>
        </View>
      ))}
    </ScalePressable>
  );
}

const styles = StyleSheet.create({
  card: { alignItems: 'center' },
  image: { ...StyleSheet.absoluteFillObject, width: '100%', height: '100%', opacity: 0.92 },
  heading: { position: 'absolute', top: '14%', color: colors.ink, fontSize: 16, lineHeight: 21, fontWeight: '700' },
  entry: { position: 'absolute', left: '45%', right: '5%', minHeight: 36, justifyContent: 'center', gap: 1 },
  caption: { color: colors.muted, fontSize: 9, lineHeight: 11 },
  title: { color: colors.ink, fontSize: 11, lineHeight: 12, fontWeight: '500' },
});
