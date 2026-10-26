import { memo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppText as Text } from '../../components/AppText';
import type { DailyChallengeForDate } from '../../schedule/dailyChallengeStore';
import type { Goal } from '../../schedule/goalStore';
import type { Habit, getOwnHabitPeriodProgress } from '../../schedule/habitStore';
import { categoryConfig, habitFrequencyLabels } from '../../schedule/taskMeta';
import { colors } from '../../theme/colors';
import { managerStyles as s } from './managerStyles';

export type OwnHabitProgress = { habit: Habit; progress: Awaited<ReturnType<typeof getOwnHabitPeriodProgress>> };

type Props = {
  challenges: DailyChallengeForDate[];
  goals: Goal[];
  habits: Habit[];
  ownHabits?: OwnHabitProgress[];
  onClose: () => void;
  onCreate: () => void;
  onCreateChallenge: () => void;
  onOpenChallenge: (challenge: DailyChallengeForDate) => void;
  onOpenHabit: (habit: Habit) => void;
};

export const HabitManagerScreen = memo(function HabitManagerScreen({
  challenges,
  goals,
  habits,
  ownHabits = [],
  onClose,
  onCreate,
  onCreateChallenge,
  onOpenChallenge,
  onOpenHabit,
}: Props) {
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<'habit' | 'challenge'>('habit');
  const [showArchived, setShowArchived] = useState(false);
  const activeHabits = habits.filter(habit => habit.status !== 'archived');
  const archivedHabits = habits.filter(habit => habit.status === 'archived');
  const goalsById = new Map(goals.map((goal) => [goal.id, goal]));
  const count = tab === 'habit' ? activeHabits.length + ownHabits.length : challenges.length;
  return (
    <View style={[s.page, { paddingBottom: Math.max(insets.bottom + 18, 34), paddingTop: Math.max(insets.top + 18, 34) }]}>
      <View style={s.header}>
        <Pressable onPress={onClose} style={s.backButton}><Text style={s.backText}>‹</Text></Pressable>
        <View style={s.titleBlock}>
          <Text style={s.title}>习惯与挑战</Text>
          <Text style={s.subtitle}>{count ? `记下了 ${count} 个小方向` : '先从很小的一步开始'}</Text>
        </View>
        <View style={s.headerSpacer} />
      </View>
      <View style={styles.tabs}>
        <Pressable onPress={() => setTab('habit')} style={[styles.tab, tab === 'habit' && styles.tabSelected]}>
          <Text style={[styles.tabText, tab === 'habit' && styles.tabTextSelected]}>习惯</Text>
        </Pressable>
        <Pressable onPress={() => setTab('challenge')} style={[styles.tab, tab === 'challenge' && styles.tabSelected]}>
          <Text style={[styles.tabText, tab === 'challenge' && styles.tabTextSelected]}>每日挑战</Text>
        </Pressable>
      </View>
      <Pressable onPress={tab === 'habit' ? onCreate : onCreateChallenge} style={s.createCard}>
        <Text style={s.createIcon}>＋</Text>
        <View style={s.createCopy}>
          <Text style={s.createTitle}>{tab === 'habit' ? '新建习惯' : '新建每日挑战'}</Text>
          <Text style={s.createHint}>{tab === 'habit' ? '每天重复一点点就好' : '每天留一件找时间做的小事'}</Text>
        </View>
        <Text style={s.arrow}>›</Text>
      </Pressable>
      <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        {tab === 'habit' ? (
          <>
            <View style={s.areaSection}>
              <View style={s.areaHeader}>
                <Text style={[s.areaTitle, styles.ownHeading]}>白云的习惯</Text>
                <Text style={s.areaCount}>实际活动计次</Text>
              </View>
              {!ownHabits.length ? <Text style={s.empty}>暂无已保存的习惯</Text> : null}
              {ownHabits.map(({ habit, progress }) => (
                <View key={habit.id} style={[s.item, styles.ownItem]}>
                  <View style={[s.dot, styles.ownDot]} />
                  <View style={s.itemCopy}>
                    <Text style={s.itemTitle}>{habit.title}</Text>
                    <Text style={s.itemMeta}>
                      {habit.frequencyPeriod === 'week' ? '每周' : habit.frequencyPeriod === 'weekdays'
                        ? `周${habit.weekDays.map(day => ['一', '二', '三', '四', '五', '六', '日'][day - 1]).join('、')}各` : '每天'} {habit.targetCount} 次
                      {habit.minutes ? ` · 每次约 ${habit.minutes} 分钟` : ''}
                    </Text>
                    <Text style={[s.itemMeta, styles.ownHeading]}>
                      已完成 {progress.completedCount} / {progress.targetCount} 次{!progress.applies ? ' · 当日无目标' : ''}
                    </Text>
                    <Text style={s.itemMeta}>{progress.periodStart === progress.periodEnd ? progress.periodStart : `${progress.periodStart} — ${progress.periodEnd}`}</Text>
                  </View>
                </View>
              ))}
            </View>
            <Text style={[s.areaTitle, { color: '#C97838' }]}>小仓鼠的习惯</Text>
            {!activeHabits.length ? <Text style={s.empty}>还没有习惯。可以先从一件不会太费力的小事开始。</Text> : null}
            {categoryConfig.map((category) => {
              const items = activeHabits.filter((habit) => habit.category === category.id);
              if (!items.length) return null;
              return (
                <View key={category.id} style={s.areaSection}>
                  <View style={s.areaHeader}>
                    <Text style={s.areaTitle}>{category.icon} {category.label}</Text>
                    <Text style={s.areaCount}>{items.length}</Text>
                  </View>
                  {items.map((habit) => {
                    const goal = habit.goalId ? goalsById.get(habit.goalId) : undefined;
                    return (
                      <Pressable key={habit.id} onPress={() => onOpenHabit(habit)} style={s.item}>
                        <View style={[s.dot, { backgroundColor: category.color }]} />
                        <View style={s.itemCopy}>
                          <Text numberOfLines={2} style={s.itemTitle}>{habit.title}</Text>
                          <Text numberOfLines={1} style={s.itemMeta}>
                            {habitFrequencyLabels[habit.frequency]} · 每天 {habit.targetCount} 次
                            {habit.reminderTimes.length ? ` · ${habit.reminderTimes.join(' / ')}` : ''}
                            {` · 连续 ${habit.streak} 天`}
                            {habit.scheduleInstances.enabled ? ' · 已联动日历' : ''}
                            {goal ? ` · ${goal.title}` : ''}
                          </Text>
                        </View>
                        <Text style={s.arrow}>›</Text>
                      </Pressable>
                    );
                  })}
                </View>
              );
            })}
            {archivedHabits.length ? (
              <View style={s.areaSection}>
                <Pressable accessibilityRole="button" accessibilityState={{ expanded: showArchived }}
                  onPress={() => setShowArchived(value => !value)} style={styles.archiveToggle}>
                  <Text style={styles.tabText}>已归档 · {archivedHabits.length}</Text>
                  <Text style={styles.tabText}>{showArchived ? '收起' : '展开'}</Text>
                </Pressable>
                {showArchived ? archivedHabits.map(habit => (
                  <Pressable key={habit.id} onPress={() => onOpenHabit(habit)} style={s.item}>
                    <View style={s.itemCopy}>
                      <Text numberOfLines={2} style={s.itemTitle}>{habit.title}</Text>
                      <Text style={s.itemMeta}>已归档</Text>
                    </View>
                    <Text style={s.arrow}>›</Text>
                  </Pressable>
                )) : null}
              </View>
            ) : null}
          </>
        ) : (
          <>
            {!challenges.length ? <Text style={s.empty}>还没有每日挑战。它会每天出现一次，但不会催鼠打卡。</Text> : null}
            {challenges.map((entry) => {
              const category = categoryConfig.find((item) => item.id === entry.challenge.category) ?? categoryConfig[categoryConfig.length - 1];
              return (
                <Pressable key={entry.challenge.id} onPress={() => onOpenChallenge(entry)} style={s.item}>
                  <View style={[s.dot, { backgroundColor: category.color }]} />
                  <View style={s.itemCopy}>
                    <Text numberOfLines={2} style={s.itemTitle}>{entry.challenge.title}</Text>
                    <Text numberOfLines={1} style={s.itemMeta}>
                      {entry.challenge.estimatedMinutes} 分钟 · {entry.challenge.quadrant.toUpperCase()} · 连续 {entry.streak} 天
                    </Text>
                  </View>
                  <Text style={s.arrow}>›</Text>
                </Pressable>
              );
            })}
          </>
        )}
      </ScrollView>
    </View>
  );
});

const styles = StyleSheet.create({
  archiveToggle: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 4 },
  ownHeading: { color: '#417FB8' },
  ownItem: { backgroundColor: '#EDF5FC', borderColor: '#D7E8F7', borderWidth: 1 },
  ownDot: { backgroundColor: '#417FB8' },
  tabs: { backgroundColor: '#EDEBFA', borderRadius: 16, flexDirection: 'row', marginBottom: 12, padding: 4 },
  tab: { alignItems: 'center', borderRadius: 12, flex: 1, paddingVertical: 9 },
  tabSelected: { backgroundColor: '#FFFFFF' },
  tabText: { color: colors.muted, fontSize: 14, fontWeight: '400' },
  tabTextSelected: { color: colors.primary, fontWeight: '500' },
});
