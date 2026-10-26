import {
  createMemory,
  createMemoryComment,
  hasMemoryCommentSource,
  loadMemoryBySource,
  type MemoryDomain,
} from '../memory/memoryStore';
import { loadGoal } from './goalStore';
import type { ScheduleOccurrence } from './scheduleStore';
import { loadInhibitLogsForTodo, type InhibitOutcome, type TodoItem } from './todoStore';

type MemoryThreadInput = {
  source: string;
  title: string;
  content: string;
  comment: string;
  commentSource: string;
  domain: MemoryDomain;
  importance: number;
  valence: number;
  eventAt?: number;
  tags: string[];
  recallCues: string[];
};

async function createOrCommentMemoryThread(input: MemoryThreadInput) {
  const existing = await loadMemoryBySource(input.source);
  if (existing) {
    if (!(await hasMemoryCommentSource(existing.id, input.commentSource))) {
      await createMemoryComment(existing.id, input.comment, 'chat', {
        author: '白云小姐',
        kind: 'comment',
        source: input.commentSource,
        valence: input.valence,
      });
    }
    return existing.id;
  }
  return createMemory({
    title: input.title,
    content: input.content,
    domain: input.domain,
    tags: input.tags,
    recallCues: input.recallCues,
    importance: input.importance,
    valence: input.valence,
    arousal: 0.45,
    pinned: false,
    anchor: false,
    type: 'dynamic',
    resolved: false,
    digested: false,
    protected: false,
    eventAt: input.eventAt,
    source: input.source,
    sourceType: 'automatic',
    sourceStartAt: input.eventAt,
    sourceEndAt: input.eventAt,
  });
}

export async function createMemoryFromScheduleCompletion({ todo }: { todo: TodoItem }) {
  if (todo.type !== 'normal' || todo.source === 'daily-challenge') return null;
  const eventAt = todo.completedAt ?? Date.now();
  if (todo.goalId) {
    const goal = await loadGoal(todo.goalId);
    const goalTitle = goal?.title ?? todo.title;
    return createOrCommentMemoryThread({
      source: `schedule:goal:${todo.goalId}`,
      title: `目标「${goalTitle}」的进展`,
      content: `鼠正在一步步推进目标「${goalTitle}」。`,
      comment: `${todo.title}完成了。`,
      commentSource: `schedule:completion:${todo.id}`,
      domain: '经历',
      importance: Math.max(6, todo.priority === 'high' ? 8 : 6),
      valence: 0.75,
      eventAt,
      tags: ['日程完成', '目标进展'],
      recallCues: [goalTitle, todo.title, '完成目标'],
    });
  }
  if (todo.priority !== 'high') return null;
  return createOrCommentMemoryThread({
    source: `schedule:todo:${todo.id}`,
    title: `完成了「${todo.title}」`,
    content: `鼠完成了重要的事情「${todo.title}」。`,
    comment: `${todo.title}完成了。`,
    commentSource: `schedule:completion:${todo.id}`,
    domain: '经历',
    importance: 8,
    valence: 0.78,
    eventAt,
    tags: ['日程完成', '重要事项'],
    recallCues: [todo.title, '完成', '重要任务'],
  });
}

export async function createMemoryFromOccurrenceCompletion(occurrence: ScheduleOccurrence, completedAt = Date.now()) {
  if (occurrence.habitId || occurrence.todoId) return null;
  if (occurrence.goalId) {
    const goal = await loadGoal(occurrence.goalId);
    const goalTitle = goal?.title ?? occurrence.title;
    return createOrCommentMemoryThread({
      source: `schedule:goal:${occurrence.goalId}`,
      title: `目标「${goalTitle}」的进展`,
      content: `鼠正在一步步推进目标「${goalTitle}」。`,
      comment: `${occurrence.title}完成了。`,
      commentSource: `schedule:occurrence:${occurrence.id}`,
      domain: '经历',
      importance: 7,
      valence: 0.75,
      eventAt: completedAt,
      tags: ['日程完成', '目标进展'],
      recallCues: [goalTitle, occurrence.title],
    });
  }
  if (occurrence.source !== 'ai' || !/象限：(?:q1|重要且紧急|马上做)/i.test(occurrence.notes)) return null;
  return createOrCommentMemoryThread({
    source: `schedule:occurrence:${occurrence.id}`,
    title: `完成了「${occurrence.title}」`,
    content: `鼠完成了重要的安排「${occurrence.title}」。`,
    comment: `${occurrence.title}完成了。`,
    commentSource: `schedule:occurrence:${occurrence.id}`,
    domain: '经历',
    importance: 8,
    valence: 0.78,
    eventAt: completedAt,
    tags: ['日程完成', '重要事项'],
    recallCues: [occurrence.title, '完成'],
  });
}

function endingStreak(logs: Array<{ outcome: InhibitOutcome }>, outcome: InhibitOutcome) {
  let count = 0;
  for (let index = logs.length - 1; index >= 0; index -= 1) {
    if (logs[index].outcome !== outcome) break;
    count += 1;
  }
  return count;
}

export async function recordInhibitOutcomeMemory(todo: TodoItem, day: string, outcome: InhibitOutcome) {
  if (todo.type !== 'inhibit' || outcome === 'unrecorded') return null;
  const logs = await loadInhibitLogsForTodo(todo.id);
  const streak = endingStreak(logs, outcome);
  const existing = await loadMemoryBySource(`schedule:inhibit:${todo.id}`);
  const shouldCreate = outcome === 'kept' || (outcome === 'slipped' && streak >= 3);
  const milestones = outcome === 'kept' ? [3, 7, 30] : [3, 7, 14];
  if (!shouldCreate || (existing && !milestones.includes(streak))) return existing?.id ?? null;
  const kept = outcome === 'kept';
  return createOrCommentMemoryThread({
    source: `schedule:inhibit:${todo.id}`,
    title: `照顾自己：${todo.title}`,
    content: kept
      ? `鼠开始留意「${todo.title}」，并认真照顾这件事。`
      : `鼠最近在「${todo.title}」这件事上有些不容易，值得被温柔地看见。`,
    comment: kept ? `${day}，鼠今天守住了${streak > 1 ? `，已经连续 ${streak} 天` : ''}。` : `${day}，这件事连续 ${streak} 天有些难。`,
    commentSource: `schedule:inhibit:${todo.id}:${day}:${outcome}`,
    domain: '经历',
    importance: streak >= 7 ? 8 : 6,
    valence: kept ? 0.76 : 0.25,
    eventAt: new Date(`${day}T21:00:00`).getTime(),
    tags: ['日程关照', '抑制提醒'],
    recallCues: [todo.title, kept ? '守住了' : '最近有些难'],
  });
}

export async function recordRepeatedPostponeMemory(todo: TodoItem) {
  if (todo.type !== 'normal' || ![3, 7, 14].includes(todo.postponeCount)) return null;
  return createOrCommentMemoryThread({
    source: `schedule:postpone:${todo.id}`,
    title: `最近总在推迟「${todo.title}」`,
    content: `「${todo.title}」连续被推迟了几次，也许它需要换一种做法或重新确认是否重要。`,
    comment: `已经第 ${todo.postponeCount} 次推迟这件事。`,
    commentSource: `schedule:postpone:${todo.id}:${todo.postponeCount}`,
    domain: '日常',
    importance: todo.postponeCount >= 7 ? 7 : 5,
    valence: 0.3,
    eventAt: Date.now(),
    tags: ['日程模式', '重复推迟'],
    recallCues: [todo.title, '推迟', '不太想做'],
  });
}
