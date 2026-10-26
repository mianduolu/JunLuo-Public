import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { PanResponder, Pressable, ScrollView, View } from 'react-native';
import { AppText as Text } from '../../components/AppText';
import type { DailyChallengeForDate } from '../../schedule/dailyChallengeStore';
import { categoryConfig, dayDisplayModeConfig, getQuadrantConfig, quadrantConfig } from '../../schedule/taskMeta';
import { addDays, dateFromKey, sortTasksByTime } from '../../schedule/scheduleViewUtils';
import { dateKey } from '../../schedule/scheduleStore';
import type { TodoCategory, TodoQuadrant } from '../../schedule/todoStore';
import type { DayDisplayMode, ScheduleViewTask } from '../../schedule/scheduleViewTypes';
import { ScheduleTaskSection } from './ScheduleTaskSection';
import { ScheduleTimelineList } from './ScheduleTimelineList';
import { ScheduleViewTaskCard } from './ScheduleViewTaskCard';
import { styles } from './ScheduleScreen.styles';

const weekDayLabels = ['一', '二', '三', '四', '五', '六', '日'];

function DayScheduleViewComponent({
  displayMode,
  displayRangeLabel,
  draggingTaskId,
  floatingChallenges,
  habitCard,
  inhibitCard,
  loading,
  hoverQuadrant,
  onDragEnd,
  onDragMove,
  onDragStart,
  onOpenTask,
  onToggleTask,
  onSelectDate,
  registerQuadrantRef,
  selectedDate,
  tasks,
}: {
  displayMode: DayDisplayMode;
  displayRangeLabel: string;
  draggingTaskId?: string;
  floatingChallenges: DailyChallengeForDate[];
  habitCard?: ReactNode;
  inhibitCard?: ReactNode;
  loading?: boolean;
  hoverQuadrant?: TodoQuadrant | null;
  onDragEnd?: (x: number, y: number) => void;
  onDragMove?: (x: number, y: number) => void;
  onDragStart?: (task: ScheduleViewTask, x: number, y: number) => void;
  onOpenTask: (task: ScheduleViewTask) => void;
  onToggleTask: (task: ScheduleViewTask) => void;
  onSelectDate: (date: string) => void;
  registerQuadrantRef?: (quadrant: TodoQuadrant, node: View | null) => void;
  selectedDate: string;
  tasks: ScheduleViewTask[];
}) {
  const days = useMemo(() => {
    const base = dateFromKey(selectedDate);
    return Array.from({ length: 31 }, (_, index) => {
      const day = addDays(base, index - 15);
      return { date: day, key: dateKey(day) };
    });
  }, [selectedDate]);
  const grouped = useMemo(() => {
    const next: Record<TodoQuadrant, ScheduleViewTask[]> = { q1: [], q2: [], q3: [], q4: [] };
    tasks.forEach((task) => next[task.quadrant].push(task));
    return next;
  }, [tasks]);
  const byCategory = useMemo(() => {
    const next = new Map<TodoCategory, ScheduleViewTask[]>();
    categoryConfig.forEach((category) => next.set(category.id, []));
    tasks.forEach((task) => next.get(task.category)?.push(task));
    return next;
  }, [tasks]);
  const timedTasks = useMemo(() => tasks.filter((task) => task.startAt).sort(sortTasksByTime), [tasks]);
  const unfinishedTasks = useMemo(() => tasks.filter((task) => !task.completed).sort(sortTasksByTime), [tasks]);
  const completedTasks = useMemo(() => tasks.filter((task) => task.completed).sort(sortTasksByTime), [tasks]);
  const [completedExpanded, setCompletedExpanded] = useState(false);
  const dayStripRef = useRef<ScrollView | null>(null);
  const [dayStripWidth, setDayStripWidth] = useState(0);
  const loadingNotice = loading ? (
    <View style={styles.scheduleLoadingNotice}>
      <Text style={styles.scheduleLoadingText}>正在把这天的日程铺开…</Text>
    </View>
  ) : null;

  useEffect(() => {
    if (displayMode !== 'dayView' || !dayStripWidth) return;
    const pillWidth = 54;
    const pillGap = 8;
    const selectedIndex = 15;
    const selectedCenter = selectedIndex * (pillWidth + pillGap) + pillWidth / 2;
    const nextOffset = Math.max(0, selectedCenter - dayStripWidth / 2);
    requestAnimationFrame(() => {
      dayStripRef.current?.scrollTo({ x: nextOffset, animated: false });
    });
  }, [dayStripWidth, displayMode, selectedDate]);

  if (displayMode === 'dayView') {
    return (
      <View style={styles.scheduleViewRoot}>
        <ScrollView
          horizontal
          onLayout={(event) => setDayStripWidth(event.nativeEvent.layout.width)}
          ref={dayStripRef}
          showsHorizontalScrollIndicator={false}
          style={styles.dayStrip}
          contentContainerStyle={styles.dayStripContent}
        >
          {days.map((item) => {
            const active = item.key === selectedDate;
            const weekday = weekDayLabels[(item.date.getDay() + 6) % 7];
            return (
              <Pressable key={item.key} onPress={() => onSelectDate(item.key)} style={[styles.dayPill, active ? styles.dayPillActive : null]}>
                <Text style={[styles.dayPillWeek, active ? styles.dayPillTextActive : null]}>{weekday}</Text>
                <Text style={[styles.dayPillDate, active ? styles.dayPillTextActive : null]}>{item.date.getDate()}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.dayTaskContent}>
          {loadingNotice}
          {inhibitCard}
          <View style={styles.boardSummaryRow}>
            <Text style={styles.boardSummaryText}>当天 · {tasks.length} 件</Text>
            <Text style={styles.boardSummaryHint}>{selectedDate}</Text>
          </View>
          {tasks.length ? tasks.map((task) => (
            <ScheduleViewTaskCard
              key={task.id}
              onPress={() => onOpenTask(task)}
              onToggleComplete={() => onToggleTask(task)}
              task={task}
            />
          )) : <Text style={styles.empty}>这天还留着柔软的空白。</Text>}
        </ScrollView>
      </View>
    );
  }

  if (displayMode === 'quadrant') {
    return (
      <View style={styles.scheduleViewRoot}>
        <View style={styles.boardSummaryRow}>
          <Text style={styles.boardSummaryText}>{displayRangeLabel} · {tasks.length} 件</Text>
          <Text style={styles.boardSummaryHint}>新建默认进「重要不紧急」</Text>
        </View>
        {loadingNotice}
        <DayQuadrantBoard
          draggingTaskId={draggingTaskId}
          grouped={grouped}
          hoverQuadrant={hoverQuadrant}
          onDragEnd={onDragEnd}
          onDragMove={onDragMove}
          onDragStart={onDragStart}
          onOpenTask={onOpenTask}
          onToggleTask={onToggleTask}
          registerQuadrantRef={registerQuadrantRef}
        />
      </View>
    );
  }

  if (displayMode === 'scheduleList') {
    return (
      <ScrollView showsVerticalScrollIndicator={false} style={styles.scheduleViewRoot} contentContainerStyle={styles.dayTaskContent}>
        {loadingNotice}
        {inhibitCard}
        {habitCard}
        <View style={styles.boardSummaryRow}>
          <Text style={styles.boardSummaryText}>当天 · {timedTasks.length} 件</Text>
          <Text style={styles.boardSummaryHint}>按时间排列</Text>
        </View>
        <ScheduleTimelineList
          emptyText="这天还没有定好时间的日程。"
          floatingChallenges={floatingChallenges}
          onOpenTask={onOpenTask}
          onToggleTask={onToggleTask}
          scrollEnabled={false}
          timedTasks={timedTasks}
        />
      </ScrollView>
    );
  }

  return (
    <View style={styles.scheduleViewRoot}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.dayTaskContent}>
        {loadingNotice}
        <View style={styles.boardSummaryRow}>
          <Text style={styles.boardSummaryText}>{displayRangeLabel} · {tasks.length} 件</Text>
          <Text style={styles.boardSummaryHint}>{dayDisplayModeConfig.find((mode) => mode.id === displayMode)?.label}</Text>
        </View>
        {tasks.length || displayMode === 'category' ? null : <Text style={styles.empty}>这天还留着柔软的空白。</Text>}
        {displayMode === 'category' ? (
          categoryConfig.map((category) => {
            const items = byCategory.get(category.id) ?? [];
            return (
              <ScheduleTaskSection
                key={category.id}
                countLabel={category.icon}
                emptyText="空空的"
                onOpenTask={onOpenTask}
                onToggleTask={onToggleTask}
                scrollable
                stripeColor={category.color}
                tasks={items}
                title={`${category.icon} ${category.label}`}
              />
            );
          })
        ) : null}
        {displayMode === 'todoList' ? (
          <>
            <ScheduleTaskSection countLabel="未完成" onOpenTask={onOpenTask} onToggleTask={onToggleTask} tasks={unfinishedTasks} title="未完成" />
            <ScheduleTaskSection
              collapsed={!completedExpanded}
              countLabel="已完成"
              emptyText="完成栏还空着。"
              onOpenTask={onOpenTask}
              onToggleTask={onToggleTask}
              onToggleCollapsed={() => setCompletedExpanded((value) => !value)}
              tasks={completedTasks}
              title="已完成"
            />
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

function DayQuadrantBoard({
  draggingTaskId,
  grouped,
  hoverQuadrant,
  onDragEnd,
  onDragMove,
  onDragStart,
  onOpenTask,
  onToggleTask,
  registerQuadrantRef,
}: {
  draggingTaskId?: string;
  grouped: Record<TodoQuadrant, ScheduleViewTask[]>;
  hoverQuadrant?: TodoQuadrant | null;
  onDragEnd?: (x: number, y: number) => void;
  onDragMove?: (x: number, y: number) => void;
  onDragStart?: (task: ScheduleViewTask, x: number, y: number) => void;
  onOpenTask: (task: ScheduleViewTask) => void;
  onToggleTask: (task: ScheduleViewTask) => void;
  registerQuadrantRef?: (quadrant: TodoQuadrant, node: View | null) => void;
}) {
  const rows: TodoQuadrant[][] = [['q1', 'q2'], ['q3', 'q4']];
  const dragResponder = PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponderCapture: () => !!draggingTaskId,
    onPanResponderMove: (event) => onDragMove?.(event.nativeEvent.pageX, event.nativeEvent.pageY),
    onPanResponderRelease: (event) => onDragEnd?.(event.nativeEvent.pageX, event.nativeEvent.pageY),
    onPanResponderTerminate: (event) => onDragEnd?.(event.nativeEvent.pageX, event.nativeEvent.pageY),
  });

  return (
    <View {...dragResponder.panHandlers} style={styles.dayQuadrantBoard}>
      {rows.map((row) => (
        <View key={row.join('-')} style={styles.dayQuadrantBoardRow}>
          {row.map((quadrantId) => {
            const quadrant = getQuadrantConfig(quadrantId);
            const items = grouped[quadrantId];

            return (
              <View
                key={quadrantId}
                ref={(node) => registerQuadrantRef?.(quadrantId, node)}
                style={[styles.dayQuadrantBoardCell, { borderColor: quadrant.border }, hoverQuadrant === quadrantId ? styles.dayQuadrantDropTarget : null]}
              >
                <View style={[styles.dayQuadrantBoardHeader, { backgroundColor: quadrant.color }]}>
                  <View style={styles.viewQuadrantTitleBlock}>
                    <Text style={[styles.dayQuadrantBoardTitle, { color: quadrant.textColor }]}>{quadrant.title}</Text>
                    <Text style={styles.dayQuadrantBoardHint}>{quadrant.hint}</Text>
                  </View>
                  <Text style={[styles.dayQuadrantBoardCount, { color: quadrant.textColor }]}>{items.length}</Text>
                </View>
                <ScrollView
                  nestedScrollEnabled
                  scrollEnabled={!draggingTaskId}
                  showsVerticalScrollIndicator={items.length > 4}
                  style={styles.dayQuadrantBoardScroll}
                  contentContainerStyle={[
                    styles.dayQuadrantBoardContent,
                    items.length ? null : styles.dayQuadrantBoardEmptyContent,
                  ]}
                >
                  {items.length ? items.map((task) => (
                    <ScheduleViewTaskCard
                      compact
                      dragging={draggingTaskId === task.id}
                      key={task.id}
                      onDragStart={!task.completed && task.kind !== 'template' ? onDragStart : undefined}
                      onPress={() => onOpenTask(task)}
                      onToggleComplete={() => onToggleTask(task)}
                      task={task}
                    />
                  )) : <Text style={styles.dayQuadrantBoardEmpty}>空空的</Text>}
                </ScrollView>
              </View>
            );
          })}
        </View>
      ))}
    </View>
  );
}

export const DayScheduleView = memo(DayScheduleViewComponent);
