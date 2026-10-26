import { useCallback, useEffect, useMemo, useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAiConfigPreferences } from '../ai/AiConfigPreferences';
import { refreshAssistantLifeState } from '../ai/assistantLife';
import { getAssistantPortrait, type AssistantCloudForm, type AssistantMoodId } from '../ai/assistantState';
import {
  ensureAssistantLifeDay,
  getLocalDateKey,
  listAssistantLifeDays,
  loadAssistantLifeDay,
  type AssistantLifeDay,
  type AssistantLifeSegment,
  type AssistantTimelineEntry,
} from '../ai/assistantLifeTimeline';
import type { BackgroundSettings } from '../backgrounds/BackgroundPreferences';
import { AppText as Text } from '../components/AppText';
import { BackgroundSurface } from '../components/BackgroundSurface';
import { loadPhoneActivityLogsForDate, type PhoneActivityLog } from '../phoneActivity/phoneActivityStore';
import { isVisiblePhoneActivityLog } from '../phoneActivity/phoneActivityVisibility';
import { colors } from '../theme/colors';
import type { Navigate } from '../types/navigation';
import type { SkyTheme } from '../utils/sky';

type Props = {
  backgroundSettings: BackgroundSettings;
  navigate: Navigate;
  skyTheme: SkyTheme;
};

type HourSection = {
  endAt: number;
  hour: number;
  isCurrent: boolean;
  label: string;
  startAt: number;
};

const MAX_ITEMS_PER_COLUMN = 3;

function startOfTodayMs(now = new Date()) {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function formatClock(time: number) {
  return new Date(time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function parseLocalDateKey(dateKey: string) {
  const [year, month, day] = dateKey.split('-').map((value) => Number(value));
  return new Date(year, month - 1, day);
}

function formatDateLabel(dateKey: string) {
  return parseLocalDateKey(dateKey).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });
}

function buildHourSections(dateKey: string, now = Date.now()): HourSection[] {
  const selectedDate = parseLocalDateKey(dateKey);
  const isToday = dateKey === getLocalDateKey(new Date(now));
  const start = startOfTodayMs(selectedDate);
  const latestHour = isToday ? new Date(now).getHours() : 23;

  return Array.from({ length: latestHour + 1 }, (_, index) => {
    const hour = latestHour - index;
    const startAt = start + hour * 60 * 60 * 1000;
    const endAt = isToday ? Math.min(now, startAt + 60 * 60 * 1000) : startAt + 60 * 60 * 1000;
    return {
      endAt,
      hour,
      isCurrent: isToday && hour === latestHour,
      label: `${String(hour).padStart(2, '0')}:00`,
      startAt,
    };
  });
}

function entryTime(entry: AssistantTimelineEntry | PhoneActivityLog) {
  if ('at' in entry) return entry.at;
  return entry.started_at ?? entry.created_at;
}

function inHour(time: number, section: HourSection) {
  return time >= section.startAt && time < section.startAt + 60 * 60 * 1000;
}


function sourceLabel(entry: AssistantTimelineEntry) {
  if (entry.source === 'chat-afterglow') return '聊天余韵';
  if (entry.source === 'deviation') return '小偏移';
  return '日常';
}

function compactEntries(entries: AssistantTimelineEntry[]) {
  return entries.filter((entry, index) => {
    const previous = entries[index - 1];
    if (!previous) return true;
    return !(
      previous.segmentId &&
      entry.segmentId &&
      previous.segmentId === entry.segmentId &&
      previous.source === entry.source &&
      previous.deviationType === entry.deviationType &&
      previous.title === entry.title &&
      previous.activity === entry.activity &&
      previous.moodId === entry.moodId &&
      (previous.cloudForm ?? 'white') === (entry.cloudForm ?? 'white') &&
      previous.lifeMode === entry.lifeMode
    );
  });
}

function MoodDot({ moodId, cloudForm }: { moodId: AssistantMoodId; cloudForm?: AssistantCloudForm }) {
  return <Image source={getAssistantPortrait(moodId, cloudForm)} resizeMode="contain" style={styles.moodDot} />;
}

function phoneTitle(log: PhoneActivityLog) {
  return log.title?.trim() || log.source?.trim() || '手机活动';
}

function phoneSummary(log: PhoneActivityLog) {
  return log.summary?.trim() || log.source?.trim() || '这条日志没有可展示的摘要。';
}

function hourRange(section: HourSection) {
  return section.isCurrent ? `${section.label} - 现在` : `${section.label} - ${String(section.hour + 1).padStart(2, '0')}:00`;
}

function AssistantCard({
  entries,
  segments,
}: {
  entries: AssistantTimelineEntry[];
  segments: AssistantLifeSegment[];
}) {
  const visibleEntries = entries.slice(0, MAX_ITEMS_PER_COLUMN);
  const extraCount = entries.length - visibleEntries.length;

  if (!visibleEntries.length) return null;

  return (
    <View style={styles.assistantEntries}>
      {visibleEntries.map((entry) => {
        const entryPlace = segments.find((item) => item.id === entry.segmentId)?.place;
        return (
          <View key={entry.id} style={styles.noteItem}>
            <View style={styles.noteHeaderRow}>
              <View style={styles.notePortraitColumn}>
                <Text style={styles.noteTime}>{formatClock(entry.at)}</Text>
                <MoodDot moodId={entry.moodId} cloudForm={entry.cloudForm} />
              </View>
              <View style={styles.noteCopy}>
                <Text style={styles.noteTitle}>{entry.title}</Text>
                <View style={styles.noteMetaRow}>
                  {entryPlace ? <Text style={styles.notePlace}>在{entryPlace}</Text> : null}
                  <Text style={styles.noteSource}>{sourceLabel(entry)}</Text>
                </View>
              </View>
            </View>
            <Text style={[styles.noteBody, styles.assistantNoteBody]}>{entry.activity}</Text>
          </View>
        );
      })}
      {extraCount > 0 ? <Text style={styles.moreText}>还有 {extraCount} 条脚印</Text> : null}
    </View>
  );
}

function PhoneCard({
  logs,
}: {
  logs: PhoneActivityLog[];
}) {
  const visibleLogs = logs.slice(0, MAX_ITEMS_PER_COLUMN);
  const extraCount = logs.length - visibleLogs.length;

  if (!visibleLogs.length) return null;

  return (
    <View style={[styles.sideCard, styles.phoneCard]}>
      <Text style={styles.columnTitle}>我的手机</Text>
      {visibleLogs.map((log) => (
        <View key={log.id} style={styles.phoneItem}>
          <Text style={styles.noteTime}>{formatClock(entryTime(log))}</Text>
          <Text style={styles.noteTitle}>{phoneTitle(log)}</Text>
          <Text style={styles.noteBody}>{phoneSummary(log)}</Text>
        </View>
      ))}
      {extraCount > 0 ? <Text style={styles.moreText}>还有 {extraCount} 条活动</Text> : null}
    </View>
  );
}

export function TodayTimelineScreen({ backgroundSettings, navigate, skyTheme }: Props) {
  const { chatConnection, chatKey, lifeCreativeConnection, lifeCreativeKey, profile } = useAiConfigPreferences();
  const lifeCreativeConnectionForUse = lifeCreativeConnection ?? chatConnection;
  const lifeCreativeKeyForUse = lifeCreativeConnection ? lifeCreativeKey : chatKey;
  const insets = useSafeAreaInsets();
  const [now, setNow] = useState(Date.now());
  const [dateKeys, setDateKeys] = useState<string[]>([getLocalDateKey()]);
  const [selectedDateKey, setSelectedDateKey] = useState(getLocalDateKey());
  const [day, setDay] = useState<AssistantLifeDay | null>(null);
  const [phoneLogs, setPhoneLogs] = useState<PhoneActivityLog[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const sections = useMemo(() => buildHourSections(selectedDateKey, now), [now, selectedDateKey]);
  const assistantTimelineEntries = useMemo(() => compactEntries(day?.timelineEntries ?? []), [day]);

  const loadLocalTimeline = useCallback(async (targetDateKey: string, targetNow = Date.now()) => {
    const today = getLocalDateKey(new Date(targetNow));
    if (targetDateKey === today) await ensureAssistantLifeDay(targetNow);
    const [keys, nextDay, nextPhoneLogs] = await Promise.all([
      listAssistantLifeDays(14),
      loadAssistantLifeDay(targetDateKey),
      loadPhoneActivityLogsForDate(targetDateKey),
    ]);
    setDateKeys(keys.includes(today) ? keys : [today, ...keys].slice(0, 14));
    setDay(nextDay);
    setPhoneLogs(nextPhoneLogs.filter((log) => log.sensitive_level !== 'blocked' && isVisiblePhoneActivityLog(log)));
  }, []);

  const reload = useCallback(async () => {
    setIsRefreshing(true);
    const nextNow = Date.now();
    setNow(nextNow);
    try {
      await loadLocalTimeline(selectedDateKey, nextNow);
      if (selectedDateKey === getLocalDateKey(new Date(nextNow))) {
        await refreshAssistantLifeState({ apiKey: lifeCreativeKeyForUse, connection: lifeCreativeConnectionForUse, now: nextNow, profile });
        const refreshedNow = Date.now();
        setNow(refreshedNow);
        await loadLocalTimeline(selectedDateKey, refreshedNow);
      }
    } finally {
      setIsRefreshing(false);
    }
  }, [lifeCreativeConnectionForUse, lifeCreativeKeyForUse, loadLocalTimeline, profile, selectedDateKey]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <BackgroundSurface settings={backgroundSettings} skyTheme={skyTheme}>
      <View style={styles.root}>
        <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
          <Pressable onPress={() => navigate('home')} style={styles.backButton}>
            <Text style={styles.backText}>‹</Text>
          </Pressable>
          <View style={styles.headerCopy}>
            <Text style={styles.title}>今日时间轴</Text>
            <Text style={styles.subtitle}>
              {formatDateLabel(selectedDateKey)} · {selectedDateKey === getLocalDateKey() ? '从现在向下回看' : '从夜晚向下回看'}
            </Text>
          </View>
          <Pressable onPress={() => void reload()} style={styles.refreshButton}>
            <Text style={styles.refreshText}>{isRefreshing ? '刷新中' : '刷新'}</Text>
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.dayTabs}>
            {dateKeys.map((dateKey) => {
              const selected = dateKey === selectedDateKey;
              return (
                <Pressable
                  key={dateKey}
                  onPress={() => setSelectedDateKey(dateKey)}
                  style={[styles.dayTab, selected && styles.dayTabActive]}
                >
                  <Text style={[styles.dayTabText, selected && styles.dayTabTextActive]}>
                    {dateKey === getLocalDateKey() ? '今天' : dateKey.slice(5)}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>

          {sections.map((section) => {
            const assistantEntries = assistantTimelineEntries
              .filter((entry) => inHour(entry.at, section))
              .sort((left, right) => right.at - left.at);
            const logs = phoneLogs
              .filter((log) => inHour(entryTime(log), section))
              .sort((left, right) => entryTime(right) - entryTime(left));

            return (
              <View key={section.hour} style={styles.hourRow}>
                <View style={styles.leftSide}>
                  <AssistantCard entries={assistantEntries} segments={day?.segments ?? []} />
                </View>
                <View style={styles.timelineRail}>
                  <View style={[styles.vineLine, section.isCurrent && styles.vineLineCurrent]} />
                  <View style={[styles.vineDot, section.isCurrent && styles.vineDotCurrent]} />
                  <Text style={[styles.hourLabel, section.isCurrent && styles.hourLabelCurrent]}>{hourRange(section)}</Text>
                  {section.isCurrent ? <Text style={styles.currentPill}>正在长出来</Text> : null}
                </View>
                <View style={styles.rightSide}>
                  <PhoneCard logs={logs} />
                </View>
              </View>
            );
          })}
        </ScrollView>
      </View>
    </BackgroundSurface>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  header: {
    alignItems: 'center',
    backgroundColor: 'rgba(255,248,238,0.74)',
    flexDirection: 'row',
    paddingBottom: 12,
    paddingHorizontal: 18,
  },
  backButton: {
    alignItems: 'center',
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  backText: {
    color: colors.ink,
    fontSize: 38,
    lineHeight: 40,
  },
  headerCopy: {
    flex: 1,
  },
  title: {
    color: colors.ink,
    fontSize: 24,
    fontWeight: '700',
    lineHeight: 30,
  },
  subtitle: {
    color: colors.muted,
    fontSize: 13,
    fontWeight: '500',
    lineHeight: 18,
  },
  refreshButton: {
    backgroundColor: '#FFFFFF',
    borderColor: '#FFE0CA',
    borderRadius: 16,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  refreshText: {
    color: colors.ink,
    fontSize: 13,
    fontWeight: '600',
  },
  content: {
    paddingBottom: 34,
    paddingHorizontal: 8,
  },
  dayTabs: {
    gap: 8,
    paddingBottom: 10,
    paddingTop: 10,
  },
  dayTab: {
    backgroundColor: 'rgba(255,255,255,0.58)',
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  dayTabActive: {
    backgroundColor: colors.ink,
  },
  dayTabText: {
    color: colors.ink,
    fontSize: 13,
    fontWeight: '500',
  },
  dayTabTextActive: {
    color: '#FFFFFF',
  },
  hourRow: {
    alignItems: 'stretch',
    flexDirection: 'row',
    gap: 4,
    minHeight: 176,
    position: 'relative',
  },
  leftSide: {
    flex: 1,
    paddingBottom: 14,
    paddingTop: 16,
  },
  rightSide: {
    flex: 1,
    paddingBottom: 14,
    paddingTop: 16,
  },
  timelineRail: {
    alignItems: 'center',
    minHeight: 176,
    position: 'relative',
    width: 54,
  },
  vineLine: {
    backgroundColor: '#A9D8B8',
    bottom: 0,
    position: 'absolute',
    top: 0,
    width: 3,
  },
  vineLineCurrent: {
    backgroundColor: '#68BF81',
  },
  vineDot: {
    backgroundColor: '#FFFFFF',
    borderColor: '#87C99D',
    borderRadius: 9,
    borderWidth: 3,
    height: 18,
    marginTop: 22,
    width: 18,
  },
  vineDotCurrent: {
    backgroundColor: '#DDF5E4',
    borderColor: '#43A967',
  },
  hourLabel: {
    backgroundColor: 'rgba(255,255,255,0.86)',
    borderColor: '#D5EBCF',
    borderRadius: 11,
    borderWidth: 1,
    color: colors.ink,
    fontSize: 10,
    fontWeight: '700',
    lineHeight: 14,
    marginTop: 8,
    overflow: 'hidden',
    paddingHorizontal: 5,
    paddingVertical: 3,
    textAlign: 'center',
  },
  hourLabelCurrent: {
    borderColor: '#65C77F',
    color: '#2F8450',
  },
  currentPill: {
    backgroundColor: '#DDF5E4',
    borderRadius: 12,
    color: '#2F8450',
    fontSize: 9,
    fontWeight: '700',
    marginTop: 5,
    overflow: 'hidden',
    paddingHorizontal: 5,
    paddingVertical: 3,
    textAlign: 'center',
  },
  sideCard: {
    borderRadius: 18,
    borderWidth: 1,
    minHeight: 124,
    padding: 10,
  },
  assistantEntries: {
    gap: 6,
  },
  phoneCard: {
    backgroundColor: 'rgba(246,251,255,0.88)',
    borderColor: '#DCEFFF',
  },
  columnTitle: {
    color: colors.ink,
    fontSize: 13,
    fontWeight: '700',
    lineHeight: 18,
    marginBottom: 7,
  },

  noteItem: {
    backgroundColor: '#FFFFFF',
    borderRadius: 13,
    padding: 8,
  },
  noteHeaderRow: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 7,
  },
  notePortraitColumn: {
    alignItems: 'center',
    width: 34,
  },
  moodDot: {
    height: 30,
    marginTop: 3,
    width: 30,
  },
  noteCopy: {
    flex: 1,
    minWidth: 0,
  },
  noteMetaRow: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    marginTop: 2,
  },
  notePlace: {
    color: colors.primary,
    flexShrink: 1,
    fontSize: 10,
    fontWeight: '600',
    lineHeight: 14,
  },
  noteSource: {
    backgroundColor: '#FFF2BC',
    borderRadius: 8,
    color: colors.ink,
    fontSize: 10,
    fontWeight: '600',
    lineHeight: 13,
    overflow: 'hidden',
    paddingHorizontal: 5,
    paddingVertical: 2,
  },
  phoneItem: {
    backgroundColor: '#F6FBFF',
    borderRadius: 13,
    marginTop: 6,
    padding: 8,
  },
  noteTime: {
    color: colors.primary,
    fontSize: 11,
    fontWeight: '700',
    lineHeight: 15,
  },
  noteTitle: {
    color: colors.ink,
    fontSize: 12,
    fontWeight: '700',
    lineHeight: 17,
    marginTop: 1,
  },
  noteBody: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: '500',
    lineHeight: 16,
    marginTop: 6,
  },
  assistantNoteBody: {
    paddingHorizontal: 4,
  },

  moreText: {
    color: '#48779A',
    fontSize: 11,
    fontWeight: '700',
    lineHeight: 16,
    marginTop: 6,
  },
});
