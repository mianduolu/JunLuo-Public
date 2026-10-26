import { memo, useRef } from 'react';
import { PanResponder, Pressable, ScrollView, View } from 'react-native';
import { AppText as Text } from '../../components/AppText';
import { getCategoryConfig, getQuadrantConfig, priorityLabels } from '../../schedule/taskMeta';
import type { TodoItem, TodoQuadrant } from '../../schedule/todoStore';
import { styles } from './ScheduleScreen.styles';

function QuadrantBoardComponent({
  draggingTodoId,
  hoverQuadrant,
  onDragEnd,
  onDragMove,
  onDragStart,
  onOpenTodo,
  setQuadrantRef,
  todosByQuadrant,
}: {
  draggingTodoId?: string;
  hoverQuadrant: TodoQuadrant | null;
  onDragEnd: (x: number, y: number) => void;
  onDragMove: (x: number, y: number) => void;
  onDragStart: (todo: TodoItem, x: number, y: number) => void;
  onOpenTodo: (todo: TodoItem) => void;
  setQuadrantRef: (quadrant: TodoQuadrant, ref: View | null) => void;
  todosByQuadrant: Record<TodoQuadrant, TodoItem[]>;
}) {
  return (
    <View style={styles.bigMatrixWrap}>
      {[
        ['q1', 'q2'] as TodoQuadrant[],
        ['q3', 'q4'] as TodoQuadrant[],
      ].map((row) => (
        <View key={row.join('-')} style={styles.matrixRow}>
          {row.map((quadrantId) => {
            const quadrant = getQuadrantConfig(quadrantId);
            const todos = todosByQuadrant[quadrant.id];
            const active = hoverQuadrant === quadrant.id;
            return (
              <View
                key={quadrant.id}
                ref={(ref) => setQuadrantRef(quadrant.id, ref)}
                style={[
                  styles.matrixCell,
                  { borderColor: active ? '#817AE4' : quadrant.border },
                  active && styles.matrixCellHover,
                ]}
              >
                <View style={[styles.matrixCellHeader, { backgroundColor: quadrant.color }]}>
                  <View style={styles.matrixTitleBlock}>
                    <Text style={[styles.matrixTitle, { color: quadrant.textColor }]}>{quadrant.title}</Text>
                    <Text style={[styles.matrixHint, { color: quadrant.textColor }]}>{quadrant.hint}</Text>
                  </View>
                  <Text style={[styles.matrixCount, { color: quadrant.textColor }]}>{todos.length}</Text>
                </View>
                <ScrollView
                  contentContainerStyle={[styles.matrixTaskList, !todos.length && styles.matrixEmptyList]}
                  nestedScrollEnabled
                  showsVerticalScrollIndicator={false}
                >
                  {!todos.length ? <Text style={styles.matrixEmpty}>空空的</Text> : null}
                  {todos.map((todo) => (
                    <TaskCard
                      key={todo.id}
                      dragging={draggingTodoId === todo.id}
                      onDragEnd={onDragEnd}
                      onDragMove={onDragMove}
                      onDragStart={onDragStart}
                      onOpen={() => onOpenTodo(todo)}
                      todo={todo}
                    />
                  ))}
                </ScrollView>
              </View>
            );
          })}
        </View>
      ))}
    </View>
  );
}

export function TaskCard({
  dragging,
  ghost,
  onDragEnd,
  onDragMove,
  onDragStart,
  onOpen,
  todo,
}: {
  dragging: boolean;
  ghost?: boolean;
  onDragEnd?: (x: number, y: number) => void;
  onDragMove?: (x: number, y: number) => void;
  onDragStart?: (todo: TodoItem, x: number, y: number) => void;
  onOpen?: () => void;
  todo: TodoItem;
}) {
  const dragTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const didStartDrag = useRef(false);
  const startPoint = useRef({ x: 0, y: 0 });
  const clearDragTimer = () => {
    if (dragTimer.current) clearTimeout(dragTimer.current);
    dragTimer.current = null;
  };
  const panResponder = PanResponder.create({
    onStartShouldSetPanResponder: () => !ghost,
    onMoveShouldSetPanResponder: () => !ghost,
    onPanResponderGrant: (event) => {
      const { pageX, pageY } = event.nativeEvent;
      didStartDrag.current = false;
      startPoint.current = { x: pageX, y: pageY };
      clearDragTimer();
      dragTimer.current = setTimeout(() => {
        didStartDrag.current = true;
        onDragStart?.(todo, pageX, pageY);
      }, 260);
    },
    onPanResponderMove: (event, gesture) => {
      const { pageX, pageY } = event.nativeEvent;
      if (!didStartDrag.current && Math.abs(gesture.dx) + Math.abs(gesture.dy) > 10) clearDragTimer();
      if (didStartDrag.current) onDragMove?.(pageX, pageY);
    },
    onPanResponderRelease: (event, gesture) => {
      clearDragTimer();
      if (didStartDrag.current) {
        const { pageX, pageY } = event.nativeEvent;
        onDragEnd?.(pageX, pageY);
      } else if (Math.abs(gesture.dx) + Math.abs(gesture.dy) < 10) {
        onOpen?.();
      }
      didStartDrag.current = false;
    },
    onPanResponderTerminate: (event) => {
      clearDragTimer();
      if (didStartDrag.current) {
        const { pageX, pageY } = event.nativeEvent;
        onDragEnd?.(pageX, pageY);
      }
      didStartDrag.current = false;
    },
  });
  const category = getCategoryConfig(todo.category);
  const metaParts = [
    priorityLabels[todo.priority],
    todo.estimatedMinutes ? `${todo.estimatedMinutes}m` : undefined,
    todo.plannedForDate?.slice(5),
  ].filter(Boolean);
  return (
    <View
      {...(!ghost ? panResponder.panHandlers : {})}
      style={[styles.matrixTask, dragging && styles.matrixTaskDragging, ghost && styles.matrixTaskGhost]}
    >
      <View style={styles.matrixTaskTitleRow}>
        <View style={[styles.matrixTaskDot, { backgroundColor: category.color }]} />
        <Text numberOfLines={2} style={styles.matrixTaskTitle}>{todo.title}</Text>
      </View>
      <Text numberOfLines={1} style={styles.matrixTaskMeta}>
        {category.icon} {category.label}{metaParts.length ? ` · ${metaParts.join(' · ')}` : ''}
      </Text>
    </View>
  );
}

export const QuadrantBoard = memo(QuadrantBoardComponent);
